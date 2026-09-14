// Subprocess helpers shared by the MCP server and the CLI.
// Owns the result contract, the resource caps, the live output channels and the
// cancellation path. Foreground `exec` and background jobs both ride on
// launch(), so a command that outlives a foreground call can be handed over to
// the job registry without losing its output or its process.
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, createWriteStream, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 60000
export const MAX_TIMEOUT_MS = 600000
// One foreground MCP call must return before a typical client-side request
// timeout (the MCP SDK defaults to 60s). Anything that needs longer is handed
// to the job registry instead of being killed - see FOREGROUND_MS in DESIGN §5.11.
export const FOREGROUND_MS = 45000
// If the concurrency gate ate the whole foreground budget there is no point in
// spawning just to kill: report it structurally instead.
export const QUEUE_FLOOR_MS = 250
export const OUTPUT_CAP_BYTES = 64 * 1024
export const SPILL_CAP_BYTES = 64 * 1024 * 1024
export const JOB_TAIL_BYTES = 64 * 1024
export const MAX_CONCURRENCY = 4
export const KILL_GRACE_MS = 1500
// MSYS2 rewrites unix-looking arguments on their way to native Windows programs
// (`docker run --entrypoint /bin/sh` became C:/.../usr/bin/sh). Off by default;
// pass MSYS_NO_PATHCONV: '' in the env argument to get the old behaviour back.
export const MSYS_NO_PATHCONV = '1'

const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000
let sweepDone = false

/** Best-effort sweep of stale spill files, at most once per process. */
function sweepSpills(dir) {
  if (sweepDone) return
  sweepDone = true
  try {
    const cutoff = Date.now() - SPILL_MAX_AGE_MS
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.log')) continue
      const full = join(dir, entry)
      try { if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true }) } catch (e) { void e }
    }
  } catch (e) { void e }
}

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

/**
 * Build the child environment: scrubbed process env + fixed shell defaults +
 * the caller's extra map. An extra value of '' *removes* the variable, which is
 * the documented way to undo a default (e.g. MSYS_NO_PATHCONV).
 */
export function buildEnv(extra) {
  const env = Object.assign(scrubEnv(process.env), {
    GIT_PAGER: 'cat',
    NO_COLOR: '1',
    MSYS_NO_PATHCONV,
  })
  if (extra) {
    for (const key of Object.keys(extra)) {
      if (extra[key] === '') delete env[key]
      else env[key] = extra[key]
    }
  }
  return env
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
 * One output stream as a live channel: the first memoryCapBytes stay in memory
 * (that is what a foreground result can return), everything else goes to a
 * capped spill file that also holds the whole stream from the first byte, so a
 * background job can be polled for its tail or read from an offset.
 */
export function createChannel(options) {
  const opts = options || {}
  const memoryCap = opts.memoryCapBytes === undefined ? OUTPUT_CAP_BYTES : opts.memoryCapBytes
  const spillCap = opts.spillCapBytes === undefined ? SPILL_CAP_BYTES : opts.spillCapBytes
  let memory = Buffer.alloc(0)
  let size = 0
  let truncated = false
  let spillPath = null
  let spillStream = null
  let spillBytes = 0
  let spillTruncated = false
  let spillFailed = false

  const openSpill = () => {
    if (spillStream) return spillStream
    const dir = join(tmpdir(), 'gitbash-mcp')
    mkdirSync(dir, { recursive: true })
    sweepSpills(dir)
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
  const write = (d) => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
    if (!truncated && size + buf.length <= memoryCap) {
      memory = Buffer.concat([memory, buf])
      size += buf.length
      return
    }
    if (!truncated) {
      truncated = true
      openSpill()
      // Keep the first memoryCap bytes in memory even when this single chunk is
      // larger than the cap (a foreground result with an empty head is useless),
      // while the spill file still receives every byte exactly once.
      const head = memory
      const room = Math.max(0, memoryCap - size)
      if (head.length) writeSpill(head)
      writeSpill(buf)
      memory = room > 0 ? Buffer.concat([head, buf.subarray(0, room)]) : head
    } else {
      writeSpill(buf)
    }
    size += buf.length
  }

  const snapshot = () => ({
    text: memory.toString('utf8'),
    truncated,
    spillPath: spillFailed ? null : spillPath,
    spillBytes,
    spillTruncated,
  })

  return {
    write,
    snapshot,
    get bytes() { return size },
    get truncated() { return truncated },
    get spillPath() { return spillFailed ? null : spillPath },
    get spillBytes() { return spillBytes },
    get spillTruncated() { return spillTruncated },
    /** Consume a readable stream until it ends; resolves when flushed. */
    attach(stream) {
      return new Promise((resolve) => {
        let ended = false
        const finish = () => {
          if (ended) return
          ended = true
          const s = spillStream
          if (!s) { resolve(snapshot()); return }
          let settled = false
          const settle = () => {
            if (settled) return
            settled = true
            clearTimeout(force)
            resolve(snapshot())
          }
          const force = setTimeout(settle, 5000)
          s.on('finish', settle)
          s.on('error', settle)
          s.end()
        }
        stream.on('data', (d) => write(d))
        stream.on('end', finish)
        stream.on('error', finish)
      })
    },
  }
}

/**
 * Collect one stream with a memory cap plus a capped spill file. Resolves to
 * { text, truncated, spillPath, spillBytes, spillTruncated }: text is at most
 * memoryCapBytes, and everything beyond it is written to spillPath up to
 * spillCapBytes (a runaway command can no longer fill the disk).
 */
export function collectStream(stream, options) {
  return createChannel(options).attach(stream)
}

/**
 * Read a channel for a job poll: the tail (default) or everything from an
 * explicit byte offset, capped at tailBytes per call. Prefers the spill file,
 * which holds the whole stream; falls back to the in-memory head.
 */
export function readChannelText(channel, options) {
  const opts = options || {}
  const cap = Math.max(1, Math.min(opts.tailBytes || JOB_TAIL_BYTES, JOB_TAIL_BYTES))
  const file = channel.spillPath
  if (file) {
    try {
      const total = statSync(file).size
      const start = opts.offsetBytes === undefined
        ? Math.max(0, total - cap)
        : Math.max(0, Math.min(opts.offsetBytes, total))
      const length = Math.max(0, Math.min(total - start, cap))
      const buf = Buffer.alloc(length)
      if (length > 0) {
        const fd = openSync(file, 'r')
        try { readSync(fd, buf, 0, length, start) } finally { closeSync(fd) }
      }
      return {
        text: buf.toString('utf8'),
        offset: start,
        next_offset: start + length,
        bytes_total: total,
        source: 'spill',
        log_path: file,
        log_truncated: channel.spillTruncated,
      }
    } catch (e) {
      void e
    }
  }
  const total = channel.bytes
  const body = Buffer.from(channel.snapshot().text, 'utf8')
  const start = opts.offsetBytes === undefined
    ? Math.max(0, total - cap)
    : Math.max(0, Math.min(opts.offsetBytes, total))
  const slice = body.subarray(start, Math.min(body.length, start + cap))
  return {
    text: slice.toString('utf8'),
    offset: start,
    next_offset: start + slice.length,
    bytes_total: total,
    source: 'memory',
    log_path: channel.spillPath,
    log_truncated: channel.spillTruncated,
  }
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
 * Spawn one bash command and hand back a live handle:
 *   { pid, done, stdout, stderr, armTimeout, kill, detachSignal, snapshot }
 * done resolves to the result contract (see spawnBash). The caller decides what
 * a deadline means: kill it (foreground timeout) or hand the handle to a job.
 */
export function launch(bashPath, command, options) {
  const opts = options || {}
  const startedAt = Date.now()
  const args = opts.login ? ['-lc', command] : ['-c', command]
  const child = spawn(bashPath, args, {
    cwd: opts.cwd || process.cwd(),
    env: buildEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = createChannel()
  const stderr = createChannel()
  let killedBy = null
  let timedOut = false
  let settled = false
  let timer = null
  let lifetimeMs = 0
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  let cancelled = false
  let resolveCancelled
  const whenCancelled = new Promise((resolve) => { resolveCancelled = resolve })

  const collect = () => ({
    stdout: stdout.snapshot().text,
    stderr: stderr.snapshot().text,
    truncated: stdout.truncated || stderr.truncated,
    spill_path: stdout.spillPath || stderr.spillPath,
    spill_bytes: stdout.spillBytes + stderr.spillBytes,
    spill_truncated: stdout.spillTruncated || stderr.spillTruncated,
  })

  const finish = (result) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    resolveDone(result)
  }
  // Kill the tree, then settle within a bounded grace period even when an
  // orphaned MSYS2 grandchild keeps the stdio pipes open (that delays the
  // 'close' event until the orphan exits on its own).
  const killNow = (kind) => {
    if (killedBy) return
    killedBy = kind
    timedOut = kind === 'timeout'
    killTree(child.pid)
    try { child.kill() } catch (e) { void e }
    setTimeout(() => {
      finish(Object.assign(collect(), {
        exit_code: -1,
        stderr: collect().stderr + (kind === 'timeout' ? '[timeout after ' + lifetimeMs + 'ms]' : '[cancelled]'),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        killed_by: kind,
      }))
    }, KILL_GRACE_MS)
  }
  const onAbort = () => {
    // 'report' is what the foreground contract uses: an MCP cancellation is not
    // proof that the human wants the work thrown away (a client request timeout
    // arrives through the same door), so the caller gets to decide - it promotes
    // the command to a job instead of killing it (DESIGN §5.10).
    if (opts.cancelAction === 'report') {
      cancelled = true
      resolveCancelled(true)
      return
    }
    killNow('cancel')
  }
  const signal = opts.signal
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const stdoutEnded = child.stdout ? stdout.attach(child.stdout) : Promise.resolve()
  const stderrEnded = child.stderr ? stderr.attach(child.stderr) : Promise.resolve()

  child.on('error', (err) => {
    finish(Object.assign(collect(), {
      exit_code: -1,
      stderr: collect().stderr + '[spawn error] ' + err.message,
      timed_out: timedOut,
      duration_ms: Date.now() - startedAt,
      killed_by: killedBy,
    }))
  })
  child.on('close', (code) => {
    Promise.all([stdoutEnded, stderrEnded]).then(() => {
      finish(Object.assign(collect(), {
        exit_code: code === null ? -1 : code,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        killed_by: killedBy,
      }))
    })
  })

  return {
    pid: child.pid,
    child,
    done,
    whenCancelled,
    stdout,
    stderr,
    startedAt,
    /** Arm the process-lifetime deadline. 0 disables it (background default). */
    armTimeout(ms) {
      lifetimeMs = Math.max(0, ms || 0)
      if (timer) clearTimeout(timer)
      if (lifetimeMs > 0) timer = setTimeout(() => killNow('timeout'), lifetimeMs)
    },
    kill(kind) { killNow(kind || 'cancel') },
    /** Stop listening to the MCP request signal (the command now outlives it). */
    detachSignal() {
      if (signal) signal.removeEventListener('abort', onAbort)
    },
    get settled() { return settled },
    get killedBy() { return killedBy },
    get cancelled() { return cancelled },
    get timeoutMs() { return lifetimeMs },
    snapshot: collect,
  }
}

/**
 * Run one bash command through bashPath and wait for it. Resolves to the result
 * contract:
 * { exit_code, stdout, stderr, timed_out, truncated, spill_path, spill_bytes,
 *   spill_truncated, duration_ms, killed_by }
 * opts.signal (the MCP request signal) kills the whole tree on cancellation.
 */
export async function spawnBash(bashPath, command, options) {
  const opts = options || {}
  const handle = launch(bashPath, command, opts)
  handle.armTimeout(Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
  return handle.done
}

/**
 * The foreground contract: wait at most waitMs for a command, then decide what
 * the deadline means.
 *   - the process lifetime (timeoutMs) expired  -> a normal timeout result, the
 *     tree is dead and the caller gets it as JSON;
 *   - the caller wanted more than the foreground ceiling -> the command is NOT
 *     killed: it is returned as { detached: true, handle } so the caller can
 *     hand it to the job registry, and its request signal is detached too, so
 *     no client-side timeout can reach it any more;
 *   - the MCP request was cancelled -> same handover (cancelled: true). A
 *     client request timeout and a human pressing stop are indistinguishable
 *     here, and losing the work is the worse of the two mistakes.
 * Returns { result } or { detached: true, cancelled?, handle }.
 */
export async function runWithForegroundBudget(bashPath, command, options) {
  const opts = options || {}
  const lifetime = Math.max(0, opts.timeoutMs || 0)
  const waitMs = Math.max(0, opts.waitMs || 0)
  const handle = launch(bashPath, command, Object.assign({}, opts, { cancelAction: 'report' }))
  if (lifetime > 0) handle.armTimeout(lifetime)
  const CANCELLED = Symbol('cancelled')
  let timer = null
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs) })
  const finished = await Promise.race([handle.done, deadline, handle.whenCancelled.then(() => CANCELLED)])
  clearTimeout(timer)
  if (finished === CANCELLED) {
    handle.detachSignal()
    return { detached: true, cancelled: true, handle }
  }
  if (finished !== null) return { result: finished, handle }
  if (lifetime > waitMs) {
    handle.detachSignal()
    return { detached: true, handle }
  }
  handle.kill('timeout')
  return { result: await handle.done, handle }
}
