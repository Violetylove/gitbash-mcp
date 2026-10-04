// Approval state tests use a private window adapter, never a client approve API.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createApprovalService, MAX_PENDING_APPROVALS, MAX_FINISHED_APPROVALS, MAX_APPROVAL_BYTES } from '../lib/approval/service.js'
import { createExecutionService } from '../lib/execution/service.js'
import { detectBash } from '../lib/environment/detect.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
const verdict = { decision: 'ask-required', tier: 'ask-required', reason: 'unknown command', matched: ['unknown command'] }
function harness() {
  const views = []
  const audits = []
  let events
  let opens = 0
  let closes = 0
  const service = createApprovalService({ audit: row => audits.push(row), createWindow: callbacks => {
    events = callbacks
    opens++
    return { update: requests => views.push(requests), close: () => { closes++ } }
  } })
  const submit = (args = {}, execute = async () => ({ exit_code: 0 })) => service.request({
    args: { command: 'example command', cwd: process.cwd(), ...args }, verdict,
    policy: 'ask-required', auditId: 'test-audit', execute,
  })
  return { service, submit, views, audits, get events() { return events }, get opens() { return opens }, get closes() { return closes } }
}

console.log('== approval queue, immutable request and one-time decisions ==')
const first = harness()
let executions = 0
let executedArgs
const original = { command: 'echo one', login: true, timeout_ms: 30000 }
const a = first.service.request({ args: original, verdict, policy: 'ask-required', auditId: 'test-audit',
  execute: async args => { executions++; executedArgs = args; return { exit_code: 0, stdout: 'one' } } })
const b = first.submit({ command: 'echo two' })
assert.equal(a.status, 'pending_approval')
assert.equal(a.started, false)
assert.equal(a.error_code, 'APPROVAL_REQUIRED')
assert.equal(first.opens, 1)
assert.equal(first.views.at(-1).length, 2)
assert.equal(executions, 0)
// The window shows every execution parameter the human approves.
assert.deepEqual(first.views.at(-1)[0].parameters, { login: true, timeout_ms: 30000, run_in_background: false })
assert(!('env' in first.views.at(-1)[0].parameters))
original.command = 'echo changed'
first.events.onDecision(a.approval_id, 'approve')
first.events.onDecision(a.approval_id, 'approve')
first.events.onDecision(a.approval_id, 'reject')
await flush()
assert.equal(executions, 1)
assert.equal(executedArgs.command, 'echo one')
assert(Object.isFrozen(executedArgs))
assert.equal(first.service.status(a.approval_id).result.stdout, 'one')
assert.equal(first.views.at(-1).length, 1)
assert(first.audits.some(row => row.phase === 'approved' && row.approval_id === a.approval_id))
first.events.onDecision(b.approval_id, 'reject')
assert.equal(first.service.status(b.approval_id).status, 'rejected')
assert.equal(first.service.status('unknown').error_code, 'APPROVAL_NOT_FOUND')
assert.equal(first.service.cancel('unknown').error_code, 'APPROVAL_NOT_FOUND')
first.service.close()

console.log('== explicit cancellation, window failure and session cleanup ==')
const cancel = harness()
let cancelledRuns = 0
const c = cancel.submit({}, async () => { cancelledRuns++; return {} })
cancel.service.cancel(c.approval_id)
cancel.events.onDecision(c.approval_id, 'approve')
await flush()
assert.equal(cancelledRuns, 0)
assert.equal(cancel.service.status(c.approval_id).status, 'cancelled')
const closed = cancel.submit()
cancel.events.onClose()
assert.equal(cancel.service.status(closed.approval_id).status, 'cancelled')
const reopened = cancel.submit()
assert.equal(cancel.opens, 3)
cancel.events.onFailure('desktop unavailable')
assert.equal(cancel.service.status(reopened.approval_id).error_code, 'APPROVAL_UI_UNAVAILABLE')
const shutdown = cancel.submit()
cancel.service.close()
cancel.events.onDecision(shutdown.approval_id, 'approve')
assert.equal(cancel.service.status(shutdown.approval_id).status, 'cancelled')
assert.equal(cancel.submit().error_code, 'APPROVAL_CANCELLED')
const unavailable = createApprovalService({ audit() {}, createWindow() { throw new Error('no desktop') } })
const failed = unavailable.request({ args: { command: 'probe', cwd: process.cwd() }, verdict, auditId: 'failed', execute() {} })
assert.equal(failed.status, 'failed')
assert.equal(failed.error_code, 'APPROVAL_UI_UNAVAILABLE')
unavailable.close()

console.log('== no human timeout, request cancellation independence and bounds ==')
const independent = harness()
const ctl = new AbortController()
const durable = independent.service.request({ args: { command: 'probe', cwd: process.cwd() }, verdict,
  auditId: 'durable', execute: async () => ({}), signal: ctl.signal })
ctl.abort()
await flush()
assert.equal(independent.service.status(durable.approval_id).status, 'pending_approval')
// No expiry metadata or deadline exists: records persist until an explicit event.
assert(!('expires_at' in independent.service.status(durable.approval_id)))
for (let i = 1; i < MAX_PENDING_APPROVALS; i++) independent.submit()
assert.equal(independent.submit().error_code, 'TOO_MANY_APPROVALS')
assert.equal(independent.service.list().pending, MAX_PENDING_APPROVALS)
const alreadyAborted = independent.service.request({ args: { command: 'probe' }, verdict, auditId: 'aborted', signal: ctl.signal })
assert.equal(alreadyAborted.error_code, 'APPROVAL_CANCELLED')
independent.service.close()
// One oversized command is refused alone; the other pending requests stay.
const sized = harness()
const small = sized.submit()
const huge = sized.submit({ command: 'echo ' + 'x'.repeat(MAX_APPROVAL_BYTES) })
assert.equal(huge.error_code, 'APPROVAL_TOO_LARGE')
assert(!huge.approval_id)
assert.equal(sized.service.status(small.approval_id).status, 'pending_approval')
assert.equal(sized.service.list().approvals.length, 1)
sized.service.close()
const retained = harness()
const keep = retained.submit()
for (let i = 0; i < MAX_FINISHED_APPROVALS + 4; i++) {
  const record = retained.submit()
  retained.service.cancel(record.approval_id)
}
assert.equal(retained.service.list().approvals.length, MAX_FINISHED_APPROVALS + 1)
assert.equal(retained.service.status(keep.approval_id).status, 'pending_approval')
// Pruning follows end order: the oldest request, finished last, is kept.
retained.service.cancel(keep.approval_id)
retained.service.cancel(retained.submit().approval_id)
assert.equal(retained.service.status(keep.approval_id).status, 'cancelled')
retained.service.close()

console.log('== exec result waiting, terminal outcomes and interrupted recovery ==')
const waitingApproval = harness()
let waitingRuns = 0
const waitingRequest = waitingApproval.submit({}, async () => {
  waitingRuns++
  return { exit_code: 7, stdout: 'original-result', queued_ms: 0 }
})
let returned = false
const originalCall = waitingApproval.service.awaitResult(waitingRequest.approval_id).then(result => {
  returned = true
  return result
})
await flush()
assert.equal(returned, false)
waitingApproval.events.onDecision(waitingRequest.approval_id, 'approve')
const originalResult = await originalCall
assert.equal(originalResult.exit_code, 7)
assert.equal(originalResult.stdout, 'original-result')
assert.equal(originalResult.approval_id, waitingRequest.approval_id)
assert.equal(waitingRuns, 1)

const declinedRequest = waitingApproval.submit()
const declinedCall = waitingApproval.service.awaitResult(declinedRequest.approval_id)
waitingApproval.events.onDecision(declinedRequest.approval_id, 'reject')
assert.equal((await declinedCall).error_code, 'APPROVAL_REJECTED')
const closedRequest = waitingApproval.submit()
const closedCall = waitingApproval.service.awaitResult(closedRequest.approval_id)
waitingApproval.events.onClose()
assert.equal((await closedCall).error_code, 'APPROVAL_CANCELLED')
const brokenRequest = waitingApproval.submit()
const brokenCall = waitingApproval.service.awaitResult(brokenRequest.approval_id)
waitingApproval.events.onFailure('window failed')
assert.equal((await brokenCall).error_code, 'APPROVAL_UI_UNAVAILABLE')

const interruptedRequest = waitingApproval.submit({}, async () => ({ exit_code: 0, stdout: 'recoverable' }))
const waitingSignal = new AbortController()
const interruptedCall = waitingApproval.service.awaitResult(interruptedRequest.approval_id, waitingSignal.signal)
waitingSignal.abort()
assert.equal((await interruptedCall).error_code, 'APPROVAL_DETACHED')
assert.equal(waitingApproval.service.status(interruptedRequest.approval_id).status, 'pending_approval')
waitingApproval.events.onDecision(interruptedRequest.approval_id, 'approve')
await flush()
assert.equal(waitingApproval.service.status(interruptedRequest.approval_id).result.stdout, 'recoverable')
const sessionRequest = waitingApproval.submit()
const sessionCall = waitingApproval.service.awaitResult(sessionRequest.approval_id)
waitingApproval.service.close()
assert.equal((await sessionCall).error_code, 'APPROVAL_CANCELLED')

console.log('== approved execution uses the original command and execution path ==')
const auditHome = mkdtempSync(join(tmpdir(), 'gbm-approval-test-'))
const oldLocal = process.env.LOCALAPPDATA
const oldStance = process.env.GITBASH_MCP_RISKY
process.env.LOCALAPPDATA = auditHome
delete process.env.GITBASH_MCP_RISKY
try {
  const approved = harness()
  const execute = createExecutionService({ defaultCwd: async () => process.cwd(), approvals: approved.service })
  if (detectBash().bashPath) {
    const command = 'bash -c "echo approved-command-output"'
    const waiting = execute({ command })
    await flush()
    const pending = approved.service.list().approvals.find(item => item.status === 'pending_approval')
    assert.equal(pending.status, 'pending_approval')
    approved.events.onDecision(pending.approval_id, 'approve')
    const response = await waiting
    const result = approved.service.status(response.approval_id)
    assert.equal(result.status, 'completed')
    assert.equal(response.exit_code, 0)
    assert(response.stdout.includes('approved-command-output'))
    assert.equal(result.result.audit_id, response.audit_id)
    assert.equal(result.result.policy, 'approved-once (ask-required)')
    const denied = await execute({ command: 'mkfs.ext4 /dev/sda1' })
    assert.equal(denied.error_code, 'POLICY_DENIED')
    assert(!denied.approval_id)
    const escape = await execute({ command: 'cmd //c echo cannot-run' })
    assert.equal(escape.error_code, 'PATHCONV_ESCAPE')
    assert(!escape.approval_id)
    const running = execute({ command: 'sleep 10', timeout_ms: 30000 })
    await new Promise(resolve => setTimeout(resolve, 200))
    execute.close()
    const stopped = await running
    assert.equal(stopped.killed_by, 'kill')
    assert.equal((await execute({ command: 'echo must-not-start' })).error_code, 'SERVER_CLOSED')
  }
  approved.service.close()
} finally {
  if (oldLocal === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = oldLocal
  if (oldStance === undefined) delete process.env.GITBASH_MCP_RISKY
  else process.env.GITBASH_MCP_RISKY = oldStance
  rmSync(auditHome, { recursive: true, force: true })
}
if (process.platform === 'win32') {
  console.log('== WPF layout, selection and rejection serialization ==')
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = fileURLToPath(new URL('../lib/approval/windows.ps1', import.meta.url))
  const checked = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Validate'],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 })
  assert.equal(checked.status, 0, checked.stderr)
  assert(checked.stdout.includes('WPF layout validated'))
  assert(checked.stdout.includes('"action":"reject"'))
}
console.log('APPROVAL ALL PASS')
