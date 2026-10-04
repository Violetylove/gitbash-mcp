// WPF host over private process pipes. No HTTP endpoint or approval CLI is exposed.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const STARTUP_MS = 15000
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const MAX_REPLY_CHARS = 4096

export function createWindowsWindow({ onDecision, onClose, onFailure }) {
  if (process.platform !== 'win32') throw new Error('The approval window requires a Windows interactive desktop.')
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = fileURLToPath(new URL('./windows.ps1', import.meta.url))
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] })
  let ended = false
  let ready = false
  let replies = ''
  let diagnostics = ''
  const decoder = new StringDecoder('utf8')
  const fail = message => {
    if (ended) return
    ended = true
    clearTimeout(startup)
    child.kill()
    onFailure(message)
  }
  const startup = setTimeout(() => fail('The WPF window did not become ready. ' + diagnostics), STARTUP_MS)
  child.on('error', error => fail('Unable to start the WPF window: ' + error.message))
  child.stdin.on('error', error => fail('The approval window input pipe failed: ' + error.message))
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192) })
  child.stdout.on('data', chunk => {
    if (ended) return
    replies += decoder.write(chunk)
    if (replies.length > MAX_REPLY_CHARS) { fail('The approval window sent an oversized reply.'); return }
    let end
    while ((end = replies.indexOf('\n')) >= 0) {
      const line = replies.slice(0, end).trim()
      replies = replies.slice(end + 1)
      if (!line) continue
      let reply
      try { reply = JSON.parse(line) } catch { fail('The approval window sent invalid JSON.'); return }
      if (reply.type === 'ready') { ready = true; clearTimeout(startup) }
      else if (reply.type === 'decision' && ready && typeof reply.id === 'string' && ['approve', 'reject'].includes(reply.action)) {
        onDecision(reply.id, reply.action)
      } else if (reply.type === 'closed') {
        ended = true
        clearTimeout(startup)
        onClose()
      } else { fail('The approval window sent an invalid message.'); return }
    }
  })
  child.on('exit', () => {
    if (!ended) fail('The WPF window exited unexpectedly. ' + diagnostics)
  })
  return {
    update(requests) {
      if (ended) return
      const message = JSON.stringify({ type: 'snapshot', requests }) + '\n'
      if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new Error('The approval window snapshot exceeds its display limit.')
      child.stdin.write(message)
    },
    close() {
      ended = true
      clearTimeout(startup)
      child.stdin.destroy()
      child.kill()
    },
  }
}
