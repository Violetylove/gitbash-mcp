// P0 guardrail tests: env scrubbing, capped spill, bounded concurrency,
// cancellation kills the tree, and the audit log. Run: node test/test-runner.mjs
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  scrubEnv, buildEnv, collectStream, createChannel, readChannelText, createSemaphore, spawnBash,
  runWithForegroundBudget,
} from '../lib/runner.js'
import {
  startJob, adopt, getJob, listJobs, jobPayload, killJob, waitForJob, runningJobCount,
} from '../lib/jobs.js'
import { appendAudit, readAudit, auditPath } from '../lib/audit.js'
import { detectBash } from '../lib/detect.js'

let failures = 0
function assert(cond, label, detail) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('FAIL  ' + label + (detail !== undefined ? ' - ' + String(detail).slice(0, 220) : '')) }
}
function canned(buffers) {
  const queue = buffers.slice()
  return new Readable({ read() { const b = queue.shift(); if (b) this.push(b); else this.push(null) } })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const d = detectBash()

console.log('== env scrubbing ==')
const scrubbed = scrubEnv({ PATH: 'C:/x', GITBASH_BASH: 'b.exe', MY_TOKEN: 't', DEEPSEEK_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 's', SSH_AUTH_SOCK: '/tmp/s', DB_PASSWORD: 'p', USERPROFILE: 'C:/u' })
assert(scrubbed.PATH === 'C:/x' && scrubbed.GITBASH_BASH === 'b.exe' && scrubbed.USERPROFILE === 'C:/u', 'keeps ordinary vars')
assert(scrubbed.MY_TOKEN === undefined && scrubbed.DEEPSEEK_API_KEY === undefined, 'drops token-shaped and API keys')
assert(scrubbed.AWS_SECRET_ACCESS_KEY === undefined && scrubbed.DB_PASSWORD === undefined, 'drops cloud secret and password')
assert(scrubbed.SSH_AUTH_SOCK === '/tmp/s', 'keeps SSH_AUTH_SOCK (ssh-agent must still work)')

console.log('== stale spill files are swept ==')
const spillDir = join(tmpdir(), 'gitbash-mcp')
mkdirSync(spillDir, { recursive: true })
const stale = join(spillDir, 'stale-probe.log')
writeFileSync(stale, 'old')
const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
utimesSync(stale, longAgo, longAgo)
const swept = await collectStream(canned([Buffer.alloc(4096, 65)]), { memoryCapBytes: 64, spillCapBytes: 4096 })
assert(existsSync(swept.spillPath), 'this run created its own spill file')
assert(!existsSync(stale), 'the 48h-old spill file was swept')
if (swept.spillPath) rmSync(swept.spillPath, { force: true })

console.log('== spill is capped ==')
const big = await collectStream(canned([Buffer.alloc(4096, 65), Buffer.alloc(4096, 66)]), { memoryCapBytes: 1024, spillCapBytes: 2048 })
assert(big.truncated === true, 'truncated flag set')
assert(big.text.length <= 1024, 'in-memory text respects the memory cap', big.text.length)
assert(big.spillBytes <= 2048, 'spill write respects the spill cap', big.spillBytes)
assert(big.spillTruncated === true, 'spillTruncated flag set')
assert(existsSync(big.spillPath) && statSync(big.spillPath).size <= 2048, 'spill file on disk is capped', big.spillPath)
if (big.spillPath) rmSync(big.spillPath, { force: true })
const small = await collectStream(canned([Buffer.from('hello')]), {})
assert(small.truncated === false && small.spillPath === null, 'small output needs no spill')

console.log('== bounded concurrency ==')
const sem = createSemaphore(2)
let active = 0
let peak = 0
const work = () => new Promise((res) => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; res('done') }, 80) })
const gated = await Promise.all([1, 2, 3, 4, 5].map(() => sem.run(work)))
assert(peak === 2, 'never more than 2 tasks at once', peak)
assert(gated.length === 5 && gated.every((g) => g.value === 'done'), 'all tasks complete')
assert(gated.some((g) => g.queuedMs > 0), 'queued tasks report queuedMs', JSON.stringify(gated.map((g) => g.queuedMs)))

console.log('== cancellation kills the process tree ==')
if (!d.bashPath) {
  console.log('  skip  no bash on this machine')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'gbm-cancel-'))
  const late = join(dir, 'LATE')
  const ctl = new AbortController()
  const started = Date.now()
  const p = spawnBash(d.bashPath, 'sleep 3; touch "' + late.replace(/\\/g, '/') + '"', { signal: ctl.signal, timeoutMs: 30000 })
  await sleep(300)
  ctl.abort()
  const r = await p
  const elapsed = Date.now() - started
  assert(r.killed_by === 'cancel', 'killed_by is cancel', r.killed_by)
  assert(elapsed < 2500, 'resolved right after the abort, not after the sleep', elapsed)
  await sleep(3200)
  assert(!existsSync(late), 'the late marker was never written (tree really died)')
  rmSync(dir, { recursive: true, force: true })
}

console.log('== env defaults: MSYS_NO_PATHCONV ==')
assert(buildEnv({}).MSYS_NO_PATHCONV === '1', 'path conversion is off by default')
assert(buildEnv({ MSYS_NO_PATHCONV: '' }).MSYS_NO_PATHCONV === undefined, 'an empty env value removes the default')
const envKept = buildEnv({ GITBASH_MCP_RISKY: 'allow' })
assert(envKept.GITBASH_MCP_RISKY === 'allow' && envKept.GIT_PAGER === 'cat' && envKept.NO_COLOR === '1', 'extra env is merged over the defaults')

console.log('== channels: tail and offset reads ==')
const ch = createChannel({ memoryCapBytes: 4 })
const chHead = await ch.attach(canned([Buffer.from('abcdefghij')]))
assert(chHead.text === 'abcd' && chHead.truncated === true, 'the in-memory head is capped', JSON.stringify(chHead))
assert(readChannelText(ch, {}).text === 'abcdefghij', 'a full read comes from the spill file', readChannelText(ch, {}).text)
assert(readChannelText(ch, { offsetBytes: 6 }).text === 'ghij', 'an offset read continues where the last poll stopped')
assert(readChannelText(ch, { tailBytes: 3 }).text === 'hij', 'a tail read returns the newest bytes')
const chTail = readChannelText(ch, { offsetBytes: 6 })
assert(chTail.next_offset === 10 && chTail.bytes_total === 10, 'next_offset and bytes_total are reported', JSON.stringify(chTail))
if (ch.spillPath) rmSync(ch.spillPath, { force: true })

console.log('== foreground budget: hand off instead of kill ==')
const jobsHome = mkdtempSync(join(tmpdir(), 'gbm-jobs-audit-'))
process.env.LOCALAPPDATA = jobsHome
delete process.env.XDG_STATE_HOME
if (!d.bashPath) {
  console.log('  skip  no bash on this machine')
} else {
  const hand = await runWithForegroundBudget(d.bashPath, 'echo partial; sleep 5; echo late', { timeoutMs: 120000, waitMs: 400 })
  assert(hand.detached === true, 'a command with a long budget is handed over, not killed')
  const adopted = adopt(hand.handle, { command: 'handoff probe', cwd: process.cwd() })
  assert(adopted.status === 'running' && jobPayload(adopted).still_running === true, 'the adopted job is still running')
  assert(jobPayload(adopted).timeout_ms === 0, 'the handover clears the lifetime nobody is waiting on', jobPayload(adopted).timeout_ms)
  assert(jobPayload(adopted).stdout.includes('partial'), 'its output so far is readable', jobPayload(adopted).stdout)
  const stopped = killJob(adopted.id)
  await waitForJob(stopped, 6000)
  assert(adopted.status === 'killed' && adopted.killedBy === 'kill', 'job_kill ends it explicitly', adopted.status + '/' + adopted.killedBy)
  const short = await runWithForegroundBudget(d.bashPath, 'sleep 5', { timeoutMs: 1200, waitMs: 45000 })
  assert(short.detached !== true && short.result.killed_by === 'timeout', 'a budget below the ceiling is still killed as a timeout', short.result && short.result.killed_by)

  // v3 BUG-1: a handed-over command must outlive the timeout_ms it inherited,
  // otherwise the handover's "not killed" promise is a lie 15s later.
  const brief = await runWithForegroundBudget(d.bashPath, 'echo kept; sleep 4; echo late-kept', { timeoutMs: 1200, waitMs: 300 })
  assert(brief.detached === true && brief.handle.timeoutMs === 0, 'a handover fires before the short lifetime and clears it', String(brief.handle.timeoutMs))
  const keptJob = adopt(brief.handle, { command: 'outlive old timeout', cwd: process.cwd() })
  await sleep(1800)
  assert(jobPayload(keptJob).still_running === true, 'it is still running well past the old timeout_ms', JSON.stringify({ status: jobPayload(keptJob).status, timeout_ms: jobPayload(keptJob).timeout_ms }))
  killJob(keptJob.id)
  await waitForJob(keptJob, 6000)

  const ctl = new AbortController()
  const pendingCancel = runWithForegroundBudget(d.bashPath, 'echo cancel-start; sleep 5; echo late-cancel', { timeoutMs: 30000, waitMs: 20000, signal: ctl.signal })
  await sleep(300)
  ctl.abort()
  const cancelled = await pendingCancel
  assert(cancelled.detached === true && cancelled.cancelled === true, 'a cancelled call is handed over instead of killed', JSON.stringify({ d: cancelled.detached, c: cancelled.cancelled }))
  const cancelJob = adopt(cancelled.handle, { command: 'cancel probe', cwd: process.cwd() })
  assert(jobPayload(cancelJob).still_running === true, 'the cancelled command is still running as a job')
  assert(jobPayload(cancelJob).timeout_ms === 0, 'cancelling also clears the lifetime', jobPayload(cancelJob).timeout_ms)
  assert(jobPayload(cancelJob).stdout.includes('cancel-start'), 'its output survived the cancellation', jobPayload(cancelJob).stdout)
  killJob(cancelJob.id)
  await waitForJob(cancelJob, 6000)
  assert(cancelJob.status === 'killed', 'job_kill is how it is stopped', cancelJob.status)
}

console.log('== background jobs ==')
if (!d.bashPath) {
  console.log('  skip  no bash on this machine')
} else {
  const before = runningJobCount('background')
  const job = startJob({ bashPath: d.bashPath, command: 'echo one; sleep 0.4; echo two', cwd: process.cwd() })
  assert(job.status === 'running' && runningJobCount('background') === before + 1, 'a started job is running')
  const early = jobPayload(job)
  assert(early.still_running === true && early.exit_code === null, 'the first poll reports a running job', JSON.stringify({ status: early.status, exit_code: early.exit_code }))
  await waitForJob(job, 8000)
  const settled = jobPayload(job)
  assert(settled.status === 'exited' && settled.exit_code === 0 && settled.still_running === false, 'the job finishes with its exit code', JSON.stringify({ status: settled.status, exit_code: settled.exit_code }))
  assert(settled.stdout.includes('one') && settled.stdout.includes('two'), 'the whole output is available', settled.stdout)
  assert(settled.stdout_bytes === Buffer.byteLength(settled.stdout), 'byte totals match the output', String(settled.stdout_bytes))
  assert(getJob(job.id) !== null && listJobs().some((j) => j.id === job.id), 'the job is listed')
  assert(killJob('job-does-not-exist') === null, 'an unknown job id resolves to null')
  const audited = readAudit(20).filter((row) => row.job_id === job.id)
  assert(audited.length >= 1, 'job activity lands in the audit log', String(audited.length))
}

console.log('== audit log ==')
const auditDir = mkdtempSync(join(tmpdir(), 'gbm-audit-'))
process.env.LOCALAPPDATA = auditDir
delete process.env.XDG_STATE_HOME
const wrote = appendAudit({ id: 'test-1', ts: 'T', tool: 'exec', command: 'echo hi', exit_code: 0 })
assert(wrote === true, 'appendAudit reports success')
assert(auditPath().startsWith(auditDir), 'audit path follows LOCALAPPDATA', auditPath())
assert(existsSync(auditPath()), 'audit file exists')
const rows = readAudit(5)
assert(rows.length === 1 && rows[0].id === 'test-1', 'readAudit returns the record', JSON.stringify(rows))
const raw = readFileSync(auditPath(), 'utf8')
assert(raw.trim().split(String.fromCharCode(10)).length === 1 && raw.endsWith(String.fromCharCode(10)), 'one JSONL line per record')
rmSync(auditDir, { recursive: true, force: true })

console.log('== audit rotation ==')
const rotDir = mkdtempSync(join(tmpdir(), 'gbm-rot-'))
process.env.LOCALAPPDATA = rotDir
const rotTarget = auditPath()
mkdirSync(dirname(rotTarget), { recursive: true })
writeFileSync(rotTarget, 'x'.repeat(5 * 1024 * 1024 + 32))
appendAudit({ id: 'after-rotate' })
assert(existsSync(rotTarget.slice(0, -'.jsonl'.length) + '.1.jsonl'), 'the oversized log rotated to .1.jsonl')
const rotated = readAudit(5)
assert(rotated.length === 1 && rotated[0].id === 'after-rotate', 'a fresh log starts after rotation', JSON.stringify(rotated))
rmSync(rotDir, { recursive: true, force: true })

console.log(failures === 0 ? String.fromCharCode(10) + 'RUNNER ALL PASS' : String.fromCharCode(10) + failures + ' RUNNER FAILURES')
process.exit(failures === 0 ? 0 : 1)