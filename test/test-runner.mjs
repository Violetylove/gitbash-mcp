// P0 guardrail tests: env scrubbing, capped spill, bounded concurrency,
// cancellation kills the tree, and the audit log. Run: node test/test-runner.mjs
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { scrubEnv, collectStream, createSemaphore, spawnBash } from '../lib/runner.js'
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
const d = detectBash()
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