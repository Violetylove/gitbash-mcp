// Subprocess helpers shared by the MCP server and the CLI.
// Owns the result contract, the resource caps, and the cancellation path.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 60000
export const MAX_TIMEOUT_MS = 600000
export const OUTPUT_CAP_BYTES = 64 * 1024
export const SPILL_CAP_BYTES = 64 * 1024 * 1024
export const MAX_CONCURRENCY = 4

const SECRET_NAME_RE = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)($|_)/i
const SECRET_PREFIX_RE = /^(AWS|OPENAI|ANTHROPIC|GEMINI|GOOGLE|GCP|AZURE|DEEPSEEK|COHERE|MISTRAL|GROQ|PERPLEXITY|REPLICATE|HF)_/i

/**
 * Drop credential-shaped env entries before handing the environment to bash.
 * DSH already scrubs before spawning this server; other MCP clients do not,
 * and every bash process would otherwise see their credentials.
 */
export function scrubEnv(env) {
  const out = {}
  for (const key of Object.keys(env)) {
    if (SECRET_NAME_RE.test(key) || SECRET_PREFIX_RE.test(key)) continue
    out[key] = env[key]
  }
  return out
}

/** Kill a process tree (MSYS2 children survive a parent-only kill). */
export function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }) } catch (e) { void e }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch (e) { void e }
  }
}

/**
 * Collect one stream with a memory cap plus a capped spill file. Resolves to
 * { text, truncated, spillPath, spillBytes, spillTruncated }: text is at most
 * memoryCapBytes, and everything beyond it is written to spillPath up to
 * spillCapBytes (a runaway command can no longer fill the disk).
 */
export function collectStream(stream, options) {
  const opts = options || {}
  const memoryCap = opts.memoryCapBytes === undefined ? OUTPUT_CAP_BYTES : opts.memoryCapBytes
  const spillCap = opts.spillCapBytes === undefined ? SPILL_CAP_BYTES : opts.spillCapBytes
  return new Promise((resolve) => {
    let memory = Buffer.alloc(0)
    let size = 0
    let truncated = false
    let spillPath = null
    let spillStream = null
    let spillBytes = 0
    let spillTruncated = false
    let spillFailed = false
    let done = false
    const result = () => ({
      text: memory.toString('utf8'),
      truncated,
      spillPath: spillFailed ? null : spillPath,
      spillBytes,
      spillTruncated,
    })
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const openSpill = () => {
      if (spillStream) return spillStream
      const dir = join(tmpdir(), 'gitbash-mcp')
      mkdirSync(dir, { recursive: true })
      spillPath = join(dir, String(Date.now()) + '-' + randomBytes(4).toString('hex') + '.log')
      spillStream = createWriteStream(spillPath)
      spillStream.on('error', (e) => {
        spillFailed = true
        console.error('[gitbash-mcp] spill write failed: ' + e.message)
      })
      return spillStream
    }
    const writeSpill = (buf) => {
      if (!spillStream || spillTruncated) return
      const room = spillCap - spillBytes
      if (room <= 0) { spillTruncated = true; return }
      const chunk = buf.length <= room ? buf : buf.subarray(0, room)
      spillStream.write(chunk)
      spillBytes += chunk.length
      if (chunk.length < buf.length) spillTruncated = true
    }
    const onData = (d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
      if (!truncated && size + buf.length <= memoryCap) {
        memory = Buffer.concat([memory, buf])
        size += buf.length
        return
      }
      if (!truncated) {
        truncated = true
        const s = openSpill()
        void s
        if (memory.length) writeSpill(memory)
        writeSpill(buf)
      } else {
        writeSpill(buf)
      }
    }
    const onEnd = () => {
      const s = spillStream
      if (!s) {
        finish(result())
        return
      }
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(force)
        finish(result())
      }
      const force = setTimeout(settle, 5000)
      s.on('finish', settle)
      s.on('error', settle)
      s.end()
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onEnd)
  })
}

/**
 * Bounded-concurrency gate. run(task) resolves to { value, queuedMs } in FIFO
 * order; at most limit tasks run at once so the model cannot fork-storm.
 */
export function createSemaphore(limit) {
  const max = Math.max(1, limit || 1)
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < max && waiting.length > 0) {
      const item = waiting.shift()
      active++
      // 0 means "started immediately"; only a task that actually waited reports a delay
      const queuedMs = item.waited ? Date.now() - item.at : 0
      Promise.resolve().then(item.task).then(
        (value) => { active--; item.resolve({ value, queuedMs }); pump() },
        (error) => { active--; item.reject(error); pump() },
      )
    }
  }
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject, at: Date.now(), waited: active >= max })
        pump()
      })
    },
    get active() { return active },
    get pending() { return waiting.length },
  }
}

/**
 * Run one bash command through bashPath. Resolves to the result contract:
 * { exit_code, stdout, stderr, timed_out, truncated, spill_path, spill_bytes,
 *   spill_truncated, duration_ms, killed_by }
 * opts.signal (the MCP request signal) kills the whole tree on cancellation.
 */
export function spawnBash(bashPath, command, options) {
  const opts = options || {}
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const args = opts.login ? ['-lc', command] : ['-c', command]
    const env = Object.assign(
      scrubEnv(process.env),
      { GIT_PAGER: 'cat', NO_COLOR: '1' },
      opts.env || {},
    )
    const child = spawn(bashPath, args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let timedOut = false
    let killedBy = null
    let settled = false
    const effectiveTimeout = Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const signal = opts.signal
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // Kill the tree, then settle within a bounded grace period even when an
    // orphaned MSYS2 grandchild keeps the stdio pipes open (that delays the
    // 'close' event until the orphan exits on its own).
    const killNow = (kind) => {
      if (killedBy) return
      killedBy = kind
      killTree(child.pid)
      try { child.kill() } catch (e) { void e }
      setTimeout(() => {
        if (settled) return
        try { if (child.stdout) child.stdout.destroy() } catch (e) { void e }
        try { if (child.stderr) child.stderr.destroy() } catch (e) { void e }
        finish({
          exit_code: -1,
          stdout: '',
          stderr: kind === 'timeout' ? '[timeout after ' + effectiveTimeout + 'ms]' : '[cancelled]',
          timed_out: kind === 'timeout',
          truncated: false,
          spill_path: null,
          spill_bytes: 0,
          spill_truncated: false,
          duration_ms: Date.now() - startedAt,
          killed_by: kind,
        })
      }, 1500)
    }
    const timer = setTimeout(() => { timedOut = true; killNow('timeout') }, effectiveTimeout)
    const onAbort = () => killNow('cancel')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (err) => {
      finish({
        exit_code: -1,
        stdout: '',
        stderr: '[spawn error] ' + err.message,
        timed_out: timedOut,
        truncated: false,
        spill_path: null,
        spill_bytes: 0,
        spill_truncated: false,
        duration_ms: Date.now() - startedAt,
        killed_by: killedBy,
      })
    })
    const outs = child.stdout ? collectStream(child.stdout) : Promise.resolve({ text: '', truncated: false, spillPath: null, spillBytes: 0, spillTruncated: false })
    const errs = child.stderr ? collectStream(child.stderr) : Promise.resolve({ text: '', truncated: false, spillPath: null, spillBytes: 0, spillTruncated: false })
    child.on('close', (code) => {
      Promise.all([outs, errs]).then((pair) => {
        const out = pair[0]
        const err = pair[1]
        finish({
          exit_code: code === null ? -1 : code,
          stdout: out.text,
          stderr: err.text,
          timed_out: timedOut,
          truncated: out.truncated || err.truncated,
          spill_path: out.spillPath || err.spillPath,
          spill_bytes: out.spillBytes + err.spillBytes,
          spill_truncated: out.spillTruncated || err.spillTruncated,
          duration_ms: Date.now() - startedAt,
          killed_by: killedBy,
        })
      })
    })
  })
}
