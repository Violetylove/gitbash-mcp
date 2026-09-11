// gitbash-mcp smoke test: drive the MCP server over stdio with the official SDK client.
// Run: node test-client.mjs   (or: bun test-client.mjs)
// Asserts the result contract of exec, timeout tree-kill, output spill, and doctor.
// NOTE: this test spawns bash.exe and uses pipes, so it must run OUTSIDE a
// restricted sandbox (any normal shell works).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const cwd = dirname(fileURLToPath(import.meta.url))
// Keep the server's audit log inside a temp dir so the real one is never touched.
const auditHome = mkdtempSync(join(tmpdir(), 'gbm-client-audit-'))
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(cwd, 'server.js')],
  cwd,
  env: { LOCALAPPDATA: auditHome, XDG_STATE_HOME: auditHome },
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

  console.log('== cancellation: aborting a tool call kills the tree ==')
  step('calling exec then aborting')
  const ctl = new AbortController()
  const abortStart = Date.now()
  const pending = client.callTool({ name: 'exec', arguments: { command: 'sleep 30', timeout_ms: 60000 } }, undefined, { signal: ctl.signal })
  setTimeout(() => ctl.abort(), 500)
  let abortRejected = false
  let abortElapsed = 0
  try {
    await pending
  } catch (e) {
    abortRejected = true
  }
  abortElapsed = Date.now() - abortStart
  assert(abortRejected, 'the aborted call rejects instead of returning', abortElapsed)
  assert(abortElapsed < 6000, 'the abort settles promptly, not after the 30s sleep', abortElapsed)

  console.log('== policy tool ==')
  step('calling policy')
  const rpol = await client.callTool({ name: 'policy', arguments: {} })
  const tpol = rpol.content[0].text
  assert(tpol.includes('stance        : ask'), 'policy reports the default ask stance', tpol.slice(0, 90))
  assert(tpol.includes('catastrophic rules'), 'policy lists the rule tiers')

  console.log('== policy: dangerous command is blocked under ask ==')
  const victim = mkdtempSync(join(tmpdir(), 'gbm-victim-'))
  writeFileSync(join(victim, 'keep.txt'), 'x')
  const victimPosix = victim.replace(/[\\]/g, '/')
  step('calling exec with a recursive delete')
  const rp = await client.callTool({ name: 'exec', arguments: { command: 'rm -rf "' + victimPosix + '"' } })
  const jp = JSON.parse(rp.content[0].text)
  assert(jp.error_code === 'APPROVAL_REQUIRED', 'dangerous command asks the user', jp.error_code)
  assert(jp.category === 'dangerous', 'category is dangerous', jp.category)
  assert(Array.isArray(jp.matched_rules) && jp.matched_rules.length > 0, 'matched rules are reported', jp.matched_rules)
  assert(String(jp.hint).includes('Blocked'), 'hint explains the block', jp.hint)
  assert(existsSync(victim), 'the blocked command never ran')

  console.log('== policy: catastrophic is denied outright ==')
  const rc = await client.callTool({ name: 'exec', arguments: { command: 'mkfs.ext4 /dev/sda1' } })
  const jc = JSON.parse(rc.content[0].text)
  assert(jc.error_code === 'POLICY_DENIED', 'catastrophic returns POLICY_DENIED', jc.error_code)
  assert(jc.category === 'catastrophic', 'category is catastrophic', jc.category)

  console.log('== policy: suspicious runs but is flagged ==')
  const rs = await client.callTool({ name: 'exec', arguments: { command: 'eval "echo suspicious-ran"' } })
  const js = JSON.parse(rs.content[0].text)
  assert(js.exit_code === 0, 'suspicious command runs', js.exit_code)
  assert(js.policy && js.policy.tier === 'suspicious', 'result flags the suspicious tier', js.policy)

  console.log('== policy: stance=allow runs the dangerous command ==')
  const allowEnv = { LOCALAPPDATA: auditHome, XDG_STATE_HOME: auditHome, GITBASH_MCP_RISKY: 'allow' }
  const t3 = new StdioClientTransport({ command: process.execPath, args: [join(cwd, 'server.js')], cwd, env: allowEnv })
  const c3 = new Client({ name: 'gitbash-mcp-test-allow', version: '1.0.0' })
  await c3.connect(t3)
  const ra = await c3.callTool({ name: 'exec', arguments: { command: 'rm -rf "' + victimPosix + '"' } })
  const ja = JSON.parse(ra.content[0].text)
  assert(ja.exit_code === 0, 'allow stance ran the command', ja.exit_code)
  assert(ja.policy && ja.policy.decision === 'allow-risky', 'result records allow-risky', ja.policy)
  assert(!existsSync(victim), 'the directory was really removed')
  const rpol2 = await c3.callTool({ name: 'policy', arguments: {} })
  assert(rpol2.content[0].text.includes('stance        : allow'), 'second server reports the allow stance')
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