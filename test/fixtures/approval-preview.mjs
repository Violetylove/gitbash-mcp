// Manual WPF preview. All execution callbacks are stubs: no shell commands run.
import { createApprovalService } from '../../lib/approval/service.js'
import { createWindowsWindow } from '../../lib/approval/windows.js'
let poll
let timer
let finished = false
function stop() {
  if (finished) return
  finished = true
  clearInterval(poll)
  clearTimeout(timer)
  approvals.close()
}
const approvals = createApprovalService({ audit() {}, createWindow(callbacks) {
  return createWindowsWindow({ ...callbacks,
    onClose() { callbacks.onClose(); stop() },
    onFailure(message) {
      callbacks.onFailure(message)
      console.error(message)
      process.exitCode = 1
      stop()
    },
  })
} })
for (const command of ['bash -c "echo preview-one"', 'python -c "print(\'preview-two\')"', 'echo 中文示例\necho second-line']) {
  console.log(JSON.stringify(approvals.request({
    args: { command, cwd: process.cwd(), env: { PREVIEW: 'No command is executed by this fixture' } },
    verdict: { decision: 'ask-required', tier: 'ask-required', reason: 'UI preview only. Execution is a stub.', matched: ['preview'] },
    policy: 'ask-required', auditId: 'preview',
    execute: async () => ({ exit_code: 0, stdout: 'Preview callback only; no shell was started.' }),
  })))
}
let previous = ''
poll = setInterval(() => {
  const state = JSON.stringify(approvals.list())
  if (state !== previous) { console.log(state); previous = state }
}, 1000)
timer = setTimeout(stop, 120000)
if (finished) { clearInterval(poll); clearTimeout(timer) }
process.on('exit', () => approvals.close())
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stop(); process.exit(0) })
}
