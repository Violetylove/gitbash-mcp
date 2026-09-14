// gitbash-mcp smoke test: drive the MCP server over stdio with the official SDK client.
// Run: node test/test-client.mjs   (or: bun test/test-client.mjs)
// Asserts the result contract of exec, timeout tree-kill, output spill, and doctor.
// NOTE: this test spawns bash.exe and uses pipes, so it must run OUTSIDE a
// restricted sandbox (any normal shell works).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const cwd = join(dirname(fileURLToPath(import.meta.url)), '..')
// Keep the server's audit log inside a temp dir so the real one is never touched.
const auditHome = mkdtempSync(join(tmpdir(), 'gbm-client-audit-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(cwd, 'server.js')],
  cwd,
  // The contract suite runs under stance=allow; policy behaviour is asserted
  // separately below with a default-stance server.
  env: { LOCALAPPDATA: auditHome, XDG_STATE_HOME: auditHome, GITBASH_MCP_RISKY: 'allow' },
})
const client = new Client({ name: 'gitbash-mcp-test', version: '1.0.0' })

let failures = 0
const step = (s) => console.log('  >> ' + s)
function assert(cond, label, detail) {
  if (cond) {
    console.log('  ok  ' + label)
  } else {
    failures++
    console.log('FAIL  ' + label + (detail !== undefined ? ' - ' + JSON.stringify(detail) : ''))
  }
}

try {
  const watchdog = setTimeout(() => { console.error('[watchdog] 60s hard timeout'); process.exit(2) }, 60000)

  await client.connect(transport)
  step('connected')
  console.log('== handshake + tools ==')
  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name)
  assert(names.includes('exec'), 'tools list contains exec', names)
  assert(names.includes('bash_info'), 'tools list contains bash_info', names)
  assert(names.includes('doctor'), 'tools list contains doctor', names)
  assert(names.includes('policy'), 'tools list contains policy', names)
  assert(names.includes('job_output') && names.includes('job_list') && names.includes('job_kill'), 'tools list contains the job tools', names)

  console.log('== doctor ==')
  step('calling doctor')
  const rd = await client.callTool({ name: 'doctor', arguments: {} })
  const td = rd.content[0].text
  assert(td.includes('candidate scan'), 'doctor reports candidate scan', td.slice(0, 120))
  assert(td.includes('FOUND'), 'doctor finds bash on this machine', td.slice(0, 200))
  assert(td.includes('GITBASH_BASH'), 'doctor reports GITBASH_BASH state', td.slice(0, 200))

  console.log('== exec: echo + git version (exit 0) ==')
  step('calling exec echo+git')
  const r1 = await client.callTool({ name: 'exec', arguments: { command: 'echo hello-mcp; git --version' } })
  const j1 = JSON.parse(r1.content[0].text)
  assert(j1.exit_code === 0, 'exit_code === 0', j1)
  assert(String(j1.stdout).includes('hello-mcp'), 'stdout contains hello-mcp', j1.stdout)
  assert(String(j1.stdout).includes('git version'), 'stdout contains git version', j1.stdout)
  assert(j1.timed_out === false && j1.truncated === false && j1.spill_path === null, 'default flags', j1)
  assert(j1.still_running === false, 'a finished foreground call is not still running', j1.still_running)
  assert(j1.policy === 'allow', 'the policy verdict is one line', JSON.stringify(j1.policy))
  assert(typeof j1.audit_id === 'string' && j1.audit_id.length > 0, 'result carries an audit_id', j1.audit_id)
  assert(j1.killed_by === null, 'a normal run is not attributed to a kill', j1.killed_by)
  assert(typeof j1.duration_ms === 'number' && j1.duration_ms >= 0, 'duration_ms reported', j1.duration_ms)
  assert(j1.queued_ms === 0, 'an unqueued run reports queued_ms 0', j1.queued_ms)

  console.log('== exec: pipeline (bash pipes work here) ==')
  step('calling exec pipeline')
  const r2 = await client.callTool({ name: 'exec', arguments: { command: "printf 'a\\nb\\nc\\nd\\n' | head -2" } })
  const j2 = JSON.parse(r2.content[0].text)
  assert(j2.exit_code === 0, 'pipeline exit_code === 0', j2)
  assert(j2.stdout === 'a\nb\n', 'pipeline stdout is a,b', j2.stdout)

  console.log('== exec: non-zero exit stays JSON ==')
  step('calling exec exit 7')
  const r3 = await client.callTool({ name: 'exec', arguments: { command: 'exit 7' } })
  const j3 = JSON.parse(r3.content[0].text)
  assert(j3.exit_code === 7, 'exit_code === 7', j3)

  console.log('== exec: timeout tree-kill ==')
  step('calling exec timeout')
  const r4 = await client.callTool({ name: 'exec', arguments: { command: 'sleep 30', timeout_ms: 1000 } })
  const j4 = JSON.parse(r4.content[0].text)
  assert(j4.timed_out === true, 'timed_out === true', j4)
  assert(typeof j4.exit_code === 'number', 'exit_code is a number', j4)
  assert(j4.killed_by === 'timeout', 'timeout is attributed as killed_by timeout', j4.killed_by)
  assert(j4.still_running === false, 'a timed-out command is not still running', j4.still_running)
  assert(j4.timeout_ms === 1000, 'the applied timeout is reported', j4.timeout_ms)
  assert(String(j4.hint).includes('run_in_background'), 'the timeout hint points at background jobs', j4.hint)

  console.log('== exec: background job outlives the request ==')
  step('calling exec run_in_background')
  const bgStart = Date.now()
  const rb = await client.callTool({ name: 'exec', arguments: { command: 'echo bg-start; sleep 2; echo bg-end; exit 5', run_in_background: true } })
  const jb = JSON.parse(rb.content[0].text)
  assert(Date.now() - bgStart < 2000, 'a background start returns immediately', String(Date.now() - bgStart))
  assert(typeof jb.job_id === 'string' && jb.job_id.startsWith('job-'), 'it returns a job id', jb.job_id)
  assert(jb.still_running === true, 'the job is running', jb.still_running)
  assert(jb.timeout_ms === 0, 'a background job has no lifetime limit by default', jb.timeout_ms)
  const rbgPoll = await client.callTool({ name: 'job_output', arguments: { job_id: jb.job_id } })
  const jp0 = JSON.parse(rbgPoll.content[0].text)
  assert(jp0.still_running === true, 'polling mid-flight reports a running job', jp0.status)
  let partial = jp0.stdout
  for (let i = 0; i < 20 && !String(partial).includes('bg-start'); i++) {
    await new Promise((r) => setTimeout(r, 200))
    partial = JSON.parse((await client.callTool({ name: 'job_output', arguments: { job_id: jb.job_id } })).content[0].text).stdout
  }
  assert(String(partial).includes('bg-start'), 'partial output is readable while it runs', partial)
  const rbgWait = await client.callTool({ name: 'job_output', arguments: { job_id: jb.job_id, wait: true, timeout_ms: 20000 } })
  const jw = JSON.parse(rbgWait.content[0].text)
  assert(jw.still_running === false && jw.exit_code === 5, 'wait: true collects the exit code', JSON.stringify({ s: jw.status, c: jw.exit_code }))
  assert(String(jw.stdout).includes('bg-end'), 'the finished output contains the last line', jw.stdout)
  const rbgOff = await client.callTool({ name: 'job_output', arguments: { job_id: jb.job_id, offset_bytes: 0 } })
  const jo = JSON.parse(rbgOff.content[0].text)
  assert(String(jo.stdout).startsWith('bg-start'), 'an offset read returns the head again', jo.stdout)
  assert(jo.next_offset === jo.stdout_bytes, 'next_offset tracks the byte total', JSON.stringify({ next: jo.next_offset, total: jo.stdout_bytes }))
  const rbgList = await client.callTool({ name: 'job_list', arguments: {} })
  const jl = JSON.parse(rbgList.content[0].text)
  assert(Array.isArray(jl.jobs) && jl.jobs.some((j) => j.job_id === jb.job_id), 'job_list contains the job', JSON.stringify(jl).slice(0, 160))
  const rbgUnknown = await client.callTool({ name: 'job_output', arguments: { job_id: 'job-nope' } })
  const junk = JSON.parse(rbgUnknown.content[0].text)
  assert(junk.error_code === 'JOB_NOT_FOUND' && rbgUnknown.isError !== true, 'an unknown job id is a structured result, not a tool error', junk.error_code)

  console.log('== job_kill stops a background job explicitly ==')
  step('starting a long job and killing it')
  const rbgLong = await client.callTool({ name: 'exec', arguments: { command: 'sleep 300', run_in_background: true } })
  const jk = JSON.parse(rbgLong.content[0].text)
  const rbgKill = await client.callTool({ name: 'job_kill', arguments: { job_id: jk.job_id } })
  const jkk = JSON.parse(rbgKill.content[0].text)
  assert(jkk.still_running === false, 'the job is no longer running', jkk.status)
  assert(jkk.killed_by === 'kill', 'killed_by is kill', jkk.killed_by)

  console.log('== exec: output spill over 64KB cap ==')
  step('calling exec spill')
  const r5 = await client.callTool({ name: 'exec', arguments: { command: 'for i in $(seq 1 20000); do echo "line-$i"; done' } })
  const j5 = JSON.parse(r5.content[0].text)
  assert(j5.exit_code === 0, 'spill exit_code === 0', j5)
  assert(j5.truncated === true, 'truncated === true', j5)
  assert(typeof j5.spill_path === 'string' && j5.spill_path.length > 0, 'spill_path present', j5)
  assert(j5.stdout.length < 200000, 'in-memory stdout stays small', j5.stdout.length)
  if (j5.spill_path) {
    assert(existsSync(j5.spill_path), 'spill file exists', j5.spill_path)
    const full = readFileSync(j5.spill_path, 'utf8')
    assert(full.includes('line-1') && full.includes('line-20000'), 'spill file has full content', full.length)
  }

  console.log('== msys path conversion: /c works, //c is refused instead of hanging ==')
  step('calling cmd /c and cmd //c')
  const rcmd = await client.callTool({ name: 'exec', arguments: { command: 'cmd /c echo pathconv-ok' } })
  const jcmd = JSON.parse(rcmd.content[0].text)
  assert(jcmd.exit_code === 0 && String(jcmd.stdout).includes('pathconv-ok'), 'cmd /c runs with conversion off', JSON.stringify({ c: jcmd.exit_code, o: jcmd.stdout }))
  const escStart = Date.now()
  const resc = await client.callTool({ name: 'exec', arguments: { command: 'cmd //c echo never-runs' } })
  const escElapsed = Date.now() - escStart
  const jesc = JSON.parse(resc.content[0].text)
  assert(escElapsed < 5000, 'the refused form returns immediately instead of hanging for its timeout', String(escElapsed))
  assert(jesc.error_code === 'PATHCONV_ESCAPE' && resc.isError !== true, 'the //c escape is a structured refusal, not a tool error', jesc.error_code)
  assert(!String(jesc.stdout).includes('never-runs'), 'it really did not run', jesc.stdout)
  assert(String(jesc.hint).includes('cmd /c') && String(jesc.hint).includes('MSYS_NO_PATHCONV'), 'the refusal names the fix and the escape hatch', String(jesc.hint).slice(0, 140))
  const ron = await client.callTool({ name: 'exec', arguments: { command: 'cmd //c echo pathconv-on', env: { MSYS_NO_PATHCONV: '' } } })
  const jon = JSON.parse(ron.content[0].text)
  assert(jon.exit_code === 0 && String(jon.stdout).includes('pathconv-on'), 'with conversion restored the legacy //c idiom works again', JSON.stringify({ c: jon.exit_code, o: jon.stdout }))

  console.log('== bash_info ==')
  step('calling bash_info')
  const r6 = await client.callTool({ name: 'bash_info', arguments: {} })
  const t6 = r6.content[0].text
  assert(t6.includes('bash:'), 'bash_info reports bash path', t6.slice(0, 120))
  assert(t6.includes('git version'), 'bash_info reports git version', t6.slice(0, 120))

  console.log('== protocol error: empty command raises ==')
  step('calling exec with empty command')
  let raised = false
  try {
    const r7 = await client.callTool({ name: 'exec', arguments: { command: '   ' } })
    raised = r7.isError === true
  } catch (e) {
    raised = true
  }
  assert(raised, 'empty command surfaces as an error result', raised)

  console.log('== cancellation: a cancelled call hands the work over instead of killing it ==')
  step('calling exec then aborting')
  const ctl = new AbortController()
  const abortStart = Date.now()
  const pending = client.callTool({ name: 'exec', arguments: { command: 'echo cancelled-start; sleep 30; echo never', timeout_ms: 60000 } }, undefined, { signal: ctl.signal })
  setTimeout(() => ctl.abort(), 500)
  let abortRejected = false
  try {
    await pending
  } catch (e) {
    abortRejected = true
  }
  const abortElapsed = Date.now() - abortStart
  assert(abortRejected, 'the aborted call rejects instead of returning', abortElapsed)
  assert(abortElapsed < 6000, 'the abort settles promptly, not after the 30s sleep', abortElapsed)
  let handedOver = null
  for (let i = 0; i < 25 && handedOver === null; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const rjobs = await client.callTool({ name: 'job_list', arguments: {} })
    const jobs = JSON.parse(rjobs.content[0].text).jobs
    handedOver = jobs.find((j) => j.still_running === true && String(j.command).includes('sleep 30')) || null
  }
  assert(handedOver !== null, 'the cancelled command is still running as a job (work is recoverable)', JSON.stringify(handedOver).slice(0, 200))
  if (handedOver !== null) {
    const rkill = await client.callTool({ name: 'job_kill', arguments: { job_id: handedOver.job_id } })
    const jkill = JSON.parse(rkill.content[0].text)
    assert(jkill.still_running === false, 'job_kill is the explicit way to stop it', jkill.status)
  }

  console.log('== policy tool ==')
  step('calling policy')
  const rpol = await client.callTool({ name: 'policy', arguments: {} })
  const tpol = rpol.content[0].text
  assert(tpol.includes('stance        : allow'), 'the contract suite server reports stance allow', tpol.slice(0, 90))
  assert(tpol.includes('not a regex denylist'), 'policy describes the classification model', tpol.slice(0, 120))
  assert(tpol.includes('not a security boundary'), 'policy states the honest limitation')

  console.log('== policy: a default-stance server asks before dangerous commands ==')
  const askEnv = { LOCALAPPDATA: auditHome, XDG_STATE_HOME: auditHome }
  const t3 = new StdioClientTransport({ command: process.execPath, args: [join(cwd, 'server.js')], cwd, env: askEnv })
  const c3 = new Client({ name: 'gitbash-mcp-test-ask', version: '1.0.0' })
  await c3.connect(t3)
  const rpolAsk = await c3.callTool({ name: 'policy', arguments: {} })
  assert(rpolAsk.content[0].text.includes('stance        : ask'), 'a default server reports the ask stance')

  const victim = mkdtempSync(join(tmpdir(), 'gbm-victim-'))
  writeFileSync(join(victim, 'keep.txt'), 'x')
  const victimPosix = victim.replace(/[\\]/g, '/')
  step('calling exec with a recursive delete')
  const rp = await c3.callTool({ name: 'exec', arguments: { command: 'rm -rf "' + victimPosix + '"' } })
  const jp = JSON.parse(rp.content[0].text)
  assert(jp.error_code === 'APPROVAL_REQUIRED', 'a dangerous command asks the user', jp.error_code)
  assert(jp.category === 'dangerous', 'category is dangerous', jp.category)
  assert(Array.isArray(jp.matched_rules) && jp.matched_rules.length > 0, 'matched rules are reported', jp.matched_rules)
  assert(String(jp.hint).includes('Blocked'), 'hint explains the block', jp.hint)
  assert(existsSync(victim), 'the blocked command never ran')

  console.log('== policy: catastrophic is denied outright ==')
  const rc = await c3.callTool({ name: 'exec', arguments: { command: 'mkfs.ext4 /dev/sda1' } })
  const jc = JSON.parse(rc.content[0].text)
  assert(jc.error_code === 'POLICY_DENIED', 'catastrophic returns POLICY_DENIED', jc.error_code)
  assert(jc.category === 'catastrophic', 'category is catastrophic', jc.category)

  console.log('== policy: opaque constructs ask instead of guessing ==')
  const opaqueProbes = ['eval "echo nope"', 'bash -c "echo nope"', "rm$x -rf /"]
  for (const probe of opaqueProbes) {
    const ro = await c3.callTool({ name: 'exec', arguments: { command: probe } })
    const jo = JSON.parse(ro.content[0].text)
    assert(jo.error_code === 'APPROVAL_REQUIRED', 'opaque asks: ' + probe, jo.error_code)
    assert(jo.category === 'opaque' || jo.category === 'ask-required', 'opaque is not labelled safe: ' + probe, jo.category)
  }
  assert(existsSync(victim), 'no opaque probe ran')

  console.log('== policy: read-only commands run under the default stance ==')
  const rro = await c3.callTool({ name: 'exec', arguments: { command: 'git status --porcelain && echo read-only-ran' } })
  const jro = JSON.parse(rro.content[0].text)
  assert(jro.exit_code === 0, 'a read-only chain runs', jro.exit_code)
  assert(jro.policy === 'allow', 'the result records the allow verdict', jro.policy)

  console.log('== policy: project-declared entries are trusted, undeclared ones are not ==')
  const projDir = mkdtempSync(join(tmpdir(), 'gbm-proj-'))
  writeFileSync(join(projDir, 'package.json'), JSON.stringify({ name: 'gbm-proj', version: '1.0.0', private: true, scripts: { hello: 'echo project-entry-ran' } }))
  const t4 = new StdioClientTransport({ command: process.execPath, args: [join(cwd, 'server.js')], cwd: projDir, env: askEnv })
  const c4 = new Client({ name: 'gitbash-mcp-test-project', version: '1.0.0' })
  await c4.connect(t4)
  const rproj = await c4.callTool({ name: 'exec', arguments: { command: 'npm run hello' } })
  const jproj = JSON.parse(rproj.content[0].text)
  assert(jproj.exit_code === 0, 'a declared project script runs', jproj.exit_code)
  assert(jproj.policy === 'allow', 'the result records the allow verdict', jproj.policy)
  assert(String(jproj.stdout).includes('project-entry-ran'), 'the script really produced its output', jproj.stdout)
  const runknown = await c4.callTool({ name: 'exec', arguments: { command: 'npm run not-declared' } })
  const junknown = JSON.parse(runknown.content[0].text)
  assert(junknown.error_code === 'APPROVAL_REQUIRED', 'an undeclared script still asks', junknown.error_code)

  console.log('== policy: stance=allow runs the dangerous command ==')
  const ra = await client.callTool({ name: 'exec', arguments: { command: 'rm -rf "' + victimPosix + '"' } })
  const ja = JSON.parse(ra.content[0].text)
  assert(ja.exit_code === 0, 'the allow-stance server ran the command', ja.exit_code)
  assert(ja.policy.startsWith('allow-risky ('), 'the result records allow-risky in one line', ja.policy)
  assert(!String(ja.policy).includes('matched_rules'), 'the per-call policy verdict is not the whole rule dump', ja.policy)
  assert(!existsSync(victim), 'the directory was really removed')
  await c4.close()
  await c3.close()

  console.log('== missing bash: structured BASH_NOT_FOUND ==')
  step('spawning a second server with no reachable bash')
  const t2 = new StdioClientTransport({
    command: process.execPath,
    args: [join(cwd, 'server.js')],
    cwd,
    env: {
      PATH: 'C:/no-bash-here',
      PROGRAMFILES: 'C:/no-bash-here/pf',
      LOCALAPPDATA: 'C:/no-bash-here/lad',
      USERPROFILE: 'C:/no-bash-here/home',
      GITBASH_BASH: 'C:/no-bash-here/bash.exe',
    },
  })
  const c2 = new Client({ name: 'gitbash-mcp-test-nobash', version: '1.0.0' })
  await c2.connect(t2)
  const r8 = await c2.callTool({ name: 'exec', arguments: { command: 'echo hi' } })
  const j8 = JSON.parse(r8.content[0].text)
  assert(j8.error_code === 'BASH_NOT_FOUND', 'error_code is BASH_NOT_FOUND', j8.error_code)
  assert(r8.isError !== true, 'missing bash is not a tool error', r8.isError)
  assert(String(j8.stderr).includes('GITBASH_BASH is set to'), 'reports the invalid env value', String(j8.stderr).slice(0, 160))
  assert(String(j8.stderr).includes('git-scm.com'), 'hint includes the download URL', String(j8.stderr).slice(0, 160))
  const r9 = await c2.callTool({ name: 'doctor', arguments: {} })
  assert(r9.content[0].text.includes('bash         : NOT FOUND'), 'doctor reports bash NOT FOUND', r9.content[0].text.slice(0, 240))
  await c2.close()
  try { rmSync(auditHome, { recursive: true, force: true }) } catch (e) { void e }
  step('missing-bash server closed')

  clearTimeout(watchdog)
  step('closing client')
  await client.close()
  step('client closed')
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
  process.exit(failures === 0 ? 0 : 1)
} catch (err) {
  console.error('[test-client] crashed:', err)
  process.exit(1)
}