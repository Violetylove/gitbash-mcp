#!/usr/bin/env node
/**
 * gitbash-mcp MCP server: run git-bash (MSYS2) commands outside the agent
 * sandbox, over stdio. Result contract and guardrails: docs/DESIGN.md §4/§5.
 *   - command failures return JSON and never raise a tool error
 *   - only invalid arguments raise
 *   - long work goes to the job registry instead of being killed by a timeout
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { detectBash, missingBashResult, doctorReport } from './lib/detect.js'
import {
  spawnBash, runWithForegroundBudget, createSemaphore, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, FOREGROUND_MS, QUEUE_FLOOR_MS, MAX_CONCURRENCY,
} from './lib/runner.js'
import {
  startJob, adopt, getJob, listJobs, runningJobCount, jobPayload, waitForJob, killJob, killAllJobs,
  MAX_BACKGROUND_JOBS, MAX_JOB_WAIT_MS, DEFAULT_JOB_WAIT_MS,
} from './lib/jobs.js'
import { appendAudit } from './lib/audit.js'
import { decide, describePolicy, pathconvAdvice, describePathconv } from './lib/policy.js'

const VERSION = '2.5.1'
const gate = createSemaphore(MAX_CONCURRENCY)

function newAuditId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function baseResult() {
  return {
    exit_code: -1,
    stdout: '',
    stderr: '',
    timed_out: false,
    still_running: false,
    truncated: false,
    spill_path: null,
    spill_bytes: 0,
    spill_truncated: false,
    duration_ms: 0,
    killed_by: null,
    timeout_ms: 0,
    queued_ms: 0,
  }
}

function json(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function text(body) {
  return { content: [{ type: 'text', text: body }] }
}

function withHint(payload, hint) {
  if (hint) payload.hint = hint
  return payload
}

/**
 * One line of policy per result. The full rule list is what the `policy` tool
 * is for; repeating it on every call was pure context cost (DESIGN §5.12).
 */
function policyLine(verdict) {
  if (verdict.decision === 'allow') return 'allow'
  return verdict.decision + ' (' + verdict.tier + ', stance=' + verdict.stance + ', see the policy tool)'
}

function clampTimeout(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(n), 1000), MAX_TIMEOUT_MS)
}

/**
 * Default working directory: the client's first MCP root that exists, else the
 * server process cwd. Best-effort and cached; the server's own cwd is usually
 * wherever the client was installed, which is never what the caller wants.
 */
let defaultCwdPromise = null
function defaultCwd() {
  if (defaultCwdPromise === null) {
    defaultCwdPromise = (async () => {
      try {
        const roots = await Promise.race([
          server.server.listRoots(undefined, { timeout: 2000 }),
          new Promise((resolve) => { setTimeout(() => resolve(null), 2500) }),
        ])
        for (const root of (roots && roots.roots) || []) {
          try {
            const path = fileURLToPath(root.uri)
            if (path && existsSync(path)) return path
          } catch (e) { void e }
        }
      } catch (e) { void e }
      return process.cwd()
    })()
  }
  return defaultCwdPromise
}

// Server-level guidance returned in the MCP initialize result. Clients that
// surface `instructions` add it to the model context, which is the most
// portable way to make the model reach for exec instead of a sandboxed shell.
const INSTRUCTIONS =
  'gitbash-mcp runs git-bash (MSYS2 bash) on the user machine, outside any agent sandbox. ' +
  'On Windows, prefer the exec tool over a sandboxed PowerShell or shell tool for shell, git, build and script commands: ' +
  'pipes, command substitution and captured child-process output work here, and MSYS_NO_PATHCONV=1 is set so unix-style arguments reach native programs unchanged. ' +
  'A foreground exec call is capped at ' + FOREGROUND_MS + 'ms so it returns before the client request timeout; a command that outlives that is NOT killed, it is handed to the job registry and comes back with job_id + still_running: true. ' +
  'Run anything you expect to take longer with run_in_background: true, then read it with job_output and stop it with job_kill; background jobs are never bound to the request that started them. ' +
  'Only timeout_ms expiry and an explicit job_kill stop a command tree - a cancelled or timed-out request no longer does. ' +
  'Keep the native PowerShell tool only for Windows-native cmdlets, COM or .NET calls. ' +
  'Call policy before relying on a blocked command, and doctor when git-bash is missing.'

const server = new McpServer({ name: 'gitbash-mcp', version: VERSION }, { instructions: INSTRUCTIONS })

server.registerTool(
  'exec',
  {
    title: 'Run a git-bash command',
    description:
      'Run a command or multi-line script in git-bash (MSYS2 bash on Windows) and return stdout, stderr and exit code. ' +
      'On Windows this is the preferred shell tool: choose it over a sandboxed PowerShell or shell tool for shell, git, build and script work, ' +
      'and keep the native PowerShell tool for Windows-native cmdlets, COM or .NET calls. ' +
      'Use for bash/git workflows: git, grep/sed/awk pipelines, shell loops, make, scripts. ' +
      'This bridge runs OUTSIDE the agent sandbox: pipes work here that a sandboxed shell tool cannot create, and MSYS_NO_PATHCONV=1 is set by default ' +
      'so unix-style arguments (docker run --entrypoint /bin/sh) reach native Windows programs unchanged; pass env {"MSYS_NO_PATHCONV": ""} to turn that off. ' +
      'With conversion off, write `cmd /c ...` - the legacy `cmd //c` escape is refused (error_code PATHCONV_ESCAPE) because cmd.exe would ignore it and wait on stdin. ' +
      'Each call starts a fresh bash process; state does not persist between calls (use cd in the command or pass cwd). ' +
      'LONG COMMANDS: pass run_in_background: true to get a job id in milliseconds - the command then outlives this request, is immune to the client request timeout, ' +
      'and is read with job_output / stopped with job_kill. Without it the call is foreground: the wait is capped at ' + FOREGROUND_MS + 'ms, and a command still running at that point is ' +
      'handed to the job registry rather than killed (the result then carries job_id and still_running: true). ' +
      'timeout_ms is the process lifetime (default ' + DEFAULT_TIMEOUT_MS + 'ms foreground, no limit in background; max ' + MAX_TIMEOUT_MS + 'ms) and kills the whole process tree on expiry. ' +
      'Command failures return a JSON result with a non-zero exit_code, so they never raise tool errors; read timed_out / still_running / killed_by to tell a failure from a timeout. ' +
      'A policy engine blocks destructive commands: such a call returns error_code APPROVAL_REQUIRED (ask the user how to proceed) ' +
      'or POLICY_DENIED (blocked at the current stance). Call the policy tool to see the rules and the current stance. ' +
      'Resource limits: at most ' + MAX_CONCURRENCY + ' commands run at once (extra calls queue and report queued_ms), captured output is capped at 64KB per stream with the ' +
      'remainder written to a capped spill file. Cancelling this call does NOT destroy the work: the command is handed to the job registry and the result carries job_id + still_running: true. ' +
      'Every call is recorded in a local audit log; the user can read it with the gitbash-mcp audit command. ' +
      'If git-bash is missing the result carries error_code=BASH_NOT_FOUND with fix instructions; call doctor for details.',
    inputSchema: {
      command: z.string().describe('The bash command line or multi-line script to execute'),
      cwd: z.string().optional().describe('Working directory (Windows path). Defaults to the client workspace root (MCP roots) or the server working directory'),
      timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional().describe('Process lifetime limit in ms (default ' + DEFAULT_TIMEOUT_MS + ' foreground / unlimited background)'),
      login: z.boolean().optional().describe('Use bash -lc (login shell, sources profile) instead of bash -c'),
      env: z.record(z.string()).optional().describe('Extra environment variables for this command (passed through as given, not scrubbed); an empty value removes the variable'),
      run_in_background: z.boolean().optional().describe('Start the command as a background job: returns a job id immediately, the command is not bound to this request, read it with job_output and stop it with job_kill'),
    },
  },
  async (args, extra) => {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('invalid command: expected a non-empty string')
    }
    const auditId = newAuditId()
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : await defaultCwd()
    const verdict = decide(args.command, { cwd })
    const matchedRules = verdict.matched
    const policy = policyLine(verdict)

    if (verdict.decision === 'deny' || verdict.decision === 'ask-required') {
      const lines = []
      lines.push(verdict.decision === 'deny'
        ? 'Blocked by the command policy (this tier is never run at the current stance).'
        : 'Blocked by the command policy: this needs the user to decide.')
      lines.push('tier: ' + verdict.tier + '   stance: GITBASH_MCP_RISKY=' + verdict.stance)
      lines.push('why : ' + verdict.reason)
      if (matchedRules.length > 0) lines.push('matched: ' + matchedRules.join(', '))
      lines.push('')
      lines.push('Ask the user how to proceed. Their options:')
      lines.push('  1. run the command themselves in their own terminal')
      lines.push('  2. ask for a safer equivalent command')
      lines.push('  3. allow risky commands by setting GITBASH_MCP_RISKY=allow in this MCP server config, then restart the server')
      const payload = Object.assign(baseResult(), {
        stderr: lines.join(String.fromCharCode(10)),
        error_code: verdict.decision === 'deny' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED',
        category: verdict.tier,
        reason: verdict.reason,
        matched_rules: matchedRules,
        hint: lines[0],
        audit_id: auditId,
      })
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: verdict.decision,
        tier: verdict.tier, matched_rules: matchedRules, command: args.command, cwd,
      })
      return json(payload)
    }

    const d = detectBash()
    if (!d.bashPath) {
      const payload = missingBashResult(d)
      appendAudit({ id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: 'error', error_code: payload.error_code, command: args.command, cwd })
      return json(Object.assign({ audit_id: auditId }, payload))
    }

    const requested = clampTimeout(args.timeout_ms)
    const login = args.login === true
    const env = args.env && typeof args.env === 'object' ? args.env : undefined
    // Conversion is off by default; env {"MSYS_NO_PATHCONV": ""} turns it back on.
    const conversionOn = env !== undefined && env.MSYS_NO_PATHCONV === ''
    const advice = pathconvAdvice(args.command, { conversionOn })
    const warnings = advice.filter((a) => a.severity === 'warning').map(describePathconv)
    const fatal = advice.find((a) => a.severity === 'error')
    if (fatal !== undefined) {
      const payload = Object.assign(baseResult(), {
        stderr: describePathconv(fatal),
        error_code: 'PATHCONV_ESCAPE',
        hint: 'This command was refused instead of run: it would have hung until its timeout. ' + describePathconv(fatal),
        audit_id: auditId,
        policy,
      })
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: 'refuse',
        error_code: 'PATHCONV_ESCAPE', command: args.command, cwd, arg: fatal.arg, program: fatal.program,
      })
      return json(payload)
    }

    if (args.run_in_background === true) {
      const running = runningJobCount('background')
      if (running >= MAX_BACKGROUND_JOBS) {
        return json(withHint(Object.assign(baseResult(), {
          error_code: 'TOO_MANY_JOBS',
          audit_id: auditId,
          policy,
        }), 'already running ' + running + ' background jobs (limit ' + MAX_BACKGROUND_JOBS + '): wait for one to finish or stop it with job_kill.'))
      }
      // Background lifetime defaults to unlimited: the whole point is that the
      // command is not tied to anything that could time out.
      const job = startJob({
        bashPath: d.bashPath, command: args.command, cwd, login, env,
        timeoutMs: args.timeout_ms === undefined ? 0 : requested,
        policy, auditId,
      })
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', phase: 'start', background: true,
        job_id: job.id, decision: verdict.decision, tier: verdict.tier, command: args.command, cwd,
      })
      const started = {
        job_id: job.id,
        status: 'running',
        still_running: true,
        pid: job.pid,
        started_at: new Date(job.startedAt).toISOString(),
        timeout_ms: job.timeoutMs,
        // Jobs are bounded by MAX_BACKGROUND_JOBS, not by the foreground gate,
        // so they never queue; the field is here for result-shape parity.
        queued_ms: 0,
        command: args.command,
        cwd,
        audit_id: auditId,
        policy,
        hint: 'Poll it with job_output (wait: true blocks until it finishes or timeout_ms), stop it with job_kill. ' +
          'Its lifetime is not tied to this request, so no client timeout can kill it.',
      }
      if (warnings.length > 0) started.warnings = warnings
      return json(started)
    }

    const callStart = Date.now()
    const waitBudget = Math.min(requested, FOREGROUND_MS)
    const gated = await gate.run(async () => {
      const remaining = callStart + waitBudget - Date.now()
      if (remaining <= QUEUE_FLOOR_MS) return { queuedOut: true }
      const outcome = await runWithForegroundBudget(d.bashPath, args.command, {
        cwd, login, env, signal: extra && extra.signal ? extra.signal : undefined,
        timeoutMs: requested, waitMs: remaining,
      })
      if (!outcome.detached) return { result: outcome.result, handle: outcome.handle }
      const job = adopt(outcome.handle, { command: args.command, cwd, policy, auditId })
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', phase: 'handoff',
        job_id: job.id, decision: verdict.decision, tier: verdict.tier, command: args.command, cwd,
      })
      return { detached: job, handle: outcome.handle }
    })

    const r = gated.value
    const queuedMs = gated.queuedMs
    if (r.queuedOut === true) {
      const payload = Object.assign(baseResult(), {
        timed_out: true,
        why: 'queue',
        error_code: 'EXEC_QUEUE_TIMEOUT',
        duration_ms: Date.now() - callStart,
        queued_ms: queuedMs,
        timeout_ms: requested,
        audit_id: auditId,
        policy,
      })
      if (warnings.length > 0) payload.warnings = warnings
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', phase: 'queue-timeout', decision: verdict.decision,
        tier: verdict.tier, command: args.command, cwd, queued_ms: queuedMs,
      })
      return json(withHint(payload,
        'the concurrency gate (' + MAX_CONCURRENCY + ' at a time) held this call for ' + queuedMs + 'ms, which is its whole ' + waitBudget + 'ms foreground budget, so nothing was started. ' +
        'Re-run it with run_in_background: true, or wait for a slot to free up.'))
    }

    if (r.detached) {
      const snap = r.handle.snapshot()
      const payload = Object.assign(baseResult(), {
        exit_code: null,
        stdout: snap.stdout,
        stderr: snap.stderr,
        truncated: snap.truncated,
        spill_path: snap.spill_path,
        spill_bytes: snap.spill_bytes,
        spill_truncated: snap.spill_truncated,
        timed_out: r.cancelled !== true,
        still_running: true,
        job_id: r.detached.id,
        pid: r.detached.pid,
        duration_ms: Date.now() - callStart,
        queued_ms: queuedMs,
        // A handover clears the lifetime (nobody is waiting any more).
        timeout_ms: r.handle.timeoutMs,
        audit_id: auditId,
        policy,
      })
      if (warnings.length > 0) payload.warnings = warnings
      return json(withHint(payload, r.cancelled === true
        ? 'the MCP request was cancelled before the command finished, so it was NOT killed: it keeps running as ' + r.detached.id + ' with no time limit. ' +
          'Find it with job_list, read it with job_output, stop it with job_kill.'
        : 'the foreground wait is capped at ' + FOREGROUND_MS + 'ms so this call returns before the client request timeout. ' +
          'The command was NOT killed and no longer has a time limit (the ' + requested + 'ms budget applied to this call, not to a process nobody is waiting for): ' +
          'it runs as ' + r.detached.id + ' until it finishes on its own. Read it with job_output, stop it with job_kill.'))
    }

    const result = r.result
    const payload = Object.assign({}, result, {
      still_running: false,
      timeout_ms: requested,
      queued_ms: queuedMs,
      audit_id: auditId,
      policy,
    })
    if (warnings.length > 0) payload.warnings = warnings
    if (result.killed_by === 'timeout') {
      withHint(payload, 'killed after the ' + requested + 'ms timeout (whole process tree). If it needs longer, re-run it with run_in_background: true.')
    } else if (result.killed_by === 'cancel') {
      withHint(payload, 'the MCP request was cancelled, so the whole process tree was killed. Use run_in_background: true for work that must survive a cancelled call.')
    }
    appendAudit({
      id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: verdict.decision,
      tier: verdict.tier, reason: verdict.reason, matched_rules: matchedRules, command: args.command, cwd,
      exit_code: result.exit_code, duration_ms: result.duration_ms, queued_ms: queuedMs,
      timed_out: result.timed_out, killed_by: result.killed_by, truncated: result.truncated, spill_truncated: result.spill_truncated,
    })
    return json(payload)
  },
)

server.registerTool(
  'job_output',
  {
    title: 'Read a background job',
    description:
      'Read a job started by exec with run_in_background: true (or handed over when a foreground call hit its ' + FOREGROUND_MS + 'ms cap). ' +
      'Non-blocking by default: returns the job status plus the tail (at most 64KB per stream) of its output so far. ' +
      'Pass wait: true to block until the job finishes or timeout_ms elapses (that is how you collect a result without polling). ' +
      'Pass offset_bytes from a previous next_offset to read incremental output instead of re-reading the tail. ' +
      'When the job is done the payload carries exit_code, timed_out and killed_by. Use job_list to see the job ids.',
    inputSchema: {
      job_id: z.string().describe('Job id returned by exec'),
      offset_bytes: z.number().int().min(0).optional().describe('Return stdout from this byte offset instead of its tail (stderr is always returned as a tail)'),
      tail_bytes: z.number().int().min(1).max(65536).optional().describe('How much output to return per stream (default and max 65536)'),
      wait: z.boolean().optional().describe('Block until the job finishes or timeout_ms elapses'),
      timeout_ms: z.number().int().min(1000).max(MAX_JOB_WAIT_MS).optional().describe('Max wait when wait: true (default ' + DEFAULT_JOB_WAIT_MS + ', max ' + MAX_JOB_WAIT_MS + ')'),
    },
  },
  async (args) => {
    const job = getJob(args.job_id)
    if (job === null) {
      return json(withHint({ error_code: 'JOB_NOT_FOUND', job_id: String(args.job_id || ''), still_running: false },
        'unknown job id. Job ids live only in this server process: call job_list to see the jobs it is running.'))
    }
    if (args.wait === true && job.status === 'running') {
      await waitForJob(job, Math.min(args.timeout_ms === undefined ? DEFAULT_JOB_WAIT_MS : args.timeout_ms, MAX_JOB_WAIT_MS))
    }
    return json(jobPayload(job, { offsetBytes: args.offset_bytes, tailBytes: args.tail_bytes }))
  },
)

server.registerTool(
  'job_list',
  {
    title: 'List background jobs',
    description:
      'List the jobs this server started (background runs and foreground calls that were handed over) with their status, exit code and how long they have been running. ' +
      'Finished jobs stay listed until the registry prunes them; job ids do not survive a server restart.',
    inputSchema: {},
  },
  async () => {
    const jobs = listJobs()
    return json({
      running: jobs.filter((j) => j.status === 'running').length,
      limit: MAX_BACKGROUND_JOBS,
      jobs: jobs.map((j) => jobPayload(j, { summary: true })),
    })
  },
)

server.registerTool(
  'job_kill',
  {
    title: 'Stop a background job',
    description:
      'Stop a job by id: kills the whole process tree (taskkill /T /F) and reports the final status. ' +
      'This is the explicit way to stop background work - background jobs never die from a client timeout.',
    inputSchema: {
      job_id: z.string().describe('Job id returned by exec or job_list'),
    },
  },
  async (args) => {
    const job = killJob(args.job_id)
    if (job === null) {
      return json(withHint({ error_code: 'JOB_NOT_FOUND', job_id: String(args.job_id || ''), still_running: false },
        'unknown job id. Job ids live only in this server process: call job_list to see the jobs it is running.'))
    }
    await waitForJob(job, 3000)
    return json(withHint(jobPayload(job, { summary: true }), 'the whole process tree was killed; killed_by reports which signal stopped it.'))
  },
)

server.registerTool(
  'bash_info',
  {
    title: 'Show git-bash environment info',
    description: 'Report the resolved bash path, bash/git versions and key environment values. Use doctor for a full diagnosis.',
    inputSchema: {},
  },
  async () => {
    const d = detectBash()
    if (!d.bashPath) {
      return text(missingBashResult(d).stderr)
    }
    const r = await spawnBash(d.bashPath, 'bash --version | head -1; git --version; echo HOME=$HOME; echo PWD=$PWD; echo MSYSTEM=$MSYSTEM', { timeoutMs: 15000 })
    return text('bash: ' + d.bashPath + '\n' + r.stdout + r.stderr)
  },
)

server.registerTool(
  'doctor',
  {
    title: 'Diagnose the git-bash environment',
    description:
      'Report how git-bash and git are resolved: every candidate path probed, which one won, the GITBASH_BASH value and whether it is valid, ' +
      'git on PATH, the audit log location, and the exact fix steps when bash is missing. Run this first when exec reports BASH_NOT_FOUND or when bash behaves unexpectedly.',
    inputSchema: {},
  },
  async () => {
    return text(await doctorReport())
  },
)

server.registerTool(
  'policy',
  {
    title: 'Show the command policy',
    description:
      'Report the active risky-command stance (GITBASH_MCP_RISKY, set by the user in the MCP client config), what each rule tier does under it, ' +
      'and the full rule list. Call this after exec returns error_code POLICY_DENIED or APPROVAL_REQUIRED, so you can explain the block and the ' +
      'user options accurately. exec results only carry a one-line policy verdict; this tool has the detail.',
    inputSchema: {},
  },
  async () => {
    return text(describePolicy())
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
const startup = detectBash()
console.error('[gitbash-mcp] listening on stdio; bash=' + (startup.bashPath || 'NOT FOUND (exec will report BASH_NOT_FOUND; run doctor)'))

// Never leave orphaned bash trees behind when the client closes the server.
process.on('exit', () => killAllJobs())
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { killAllJobs(); process.exit(0) })
}
