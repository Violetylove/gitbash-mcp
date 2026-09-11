// Subprocess helpers shared by the MCP server and the CLI.
// Owns the result contract fields used across the package.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const DEFAULT_TIMEOUT_MS = 60000
export const MAX_TIMEOUT_MS = 600000
export const OUTPUT_CAP_BYTES = 64 * 1024

/**
 * Collect one stream with a memory cap + spill file. Resolves to
 * { text, truncated, spillPath }: text is at most OUTPUT_CAP_BYTES (UTF-8),
 * and the FULL stream is written to spillPath once the cap is exceeded.
 */
export function collectStream(stream) {
  return new Promise((resolve) => {
    let memory = Buffer.alloc(0)
    let size = 0
    let truncated = false
    let spillPath = null
    let spillStream = null
    let done = false
    let spillFailed = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
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
    const onData = (d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
      const bytes = Buffer.byteLength(buf)
      if (!truncated && size + bytes <= OUTPUT_CAP_BYTES) {
        memory = Buffer.concat([memory, buf])
        size += bytes
      } else {
        if (!truncated) {
          truncated = true
          const s = openSpill()
          if (memory.length) s.write(memory)
          s.write(buf)
        } else if (spillStream) {
          spillStream.write(buf)
        }
      }
    }
    const onEnd = () => {
      const s = spillStream
      if (!s) {
        finish({ text: memory.toString('utf8'), truncated, spillPath: null })
        return
      }
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(force)
        finish({ text: memory.toString('utf8'), truncated, spillPath: spillFailed ? null : spillPath })
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

/** Run one bash command through bashPath; resolves to the result JSON. */
export function spawnBash(bashPath, command, options) {
  const opts = options || {}
  return new Promise((resolve) => {
    const args = opts.login ? ['-lc', command] : ['-c', command]
    const child = spawn(bashPath, args, {
      cwd: opts.cwd || process.cwd(),
      env: Object.assign({}, process.env, { GIT_PAGER: 'cat', NO_COLOR: '1' }, opts.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch (e) { void e }
      try { child.kill() } catch (e) { void e }
    }, Math.min(opts.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', (err) => {
      finish({ exit_code: -1, stdout: '', stderr: '[spawn error] ' + err.message, timed_out: timedOut, truncated: false, spill_path: null })
    })
    const outs = child.stdout ? collectStream(child.stdout) : Promise.resolve({ text: '', truncated: false, spillPath: null })
    const errs = child.stderr ? collectStream(child.stderr) : Promise.resolve({ text: '', truncated: false, spillPath: null })
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
        })
      })
    })
  })
}
