// Command orchestration: authorization, preflight, scheduling, handoff and audit.
import { detectBash, missingBashResult } from '../environment/detect.js'
import { runWithForegroundBudget, createSemaphore, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, FOREGROUND_MS, QUEUE_FLOOR_MS, MAX_CONCURRENCY } from './runner.js'
import { startJob, adopt, runningJobCount, MAX_BACKGROUND_JOBS } from '../jobs/registry.js'
import { appendAudit } from '../audit/index.js'
import { pathconvAdvice, describePathconv } from '../policy/index.js'
import { authorizeCommand } from '../policy/authorization.js'
import { baseResult, withHint } from './results.js'

function newAuditId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function clampTimeout(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(n), 1000), MAX_TIMEOUT_MS)
}

// Each server session owns its foreground gate and workspace resolver.
export function createExecutionService({ defaultCwd, approvals }) {
  const gate = createSemaphore(MAX_CONCURRENCY)
  const active = new Set()
  let closed = false
  async function execute(args, extra, approved) {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('invalid command: expected a non-empty string')
    }
    const auditId = approved ? approved.auditId : newAuditId()
    if (closed) return Object.assign(baseResult(), { audit_id: auditId,
      error_code: 'SERVER_CLOSED', hint: 'The server session ended before this command could start.' })
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : await defaultCwd()
    const { verdict, policy, rejection } = approved || authorizeCommand(args.command, { cwd })
    const matchedRules = verdict.matched
    if (rejection && (verdict.decision === 'deny' || !approvals)) {
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: verdict.decision,
        tier: verdict.tier, matched_rules: matchedRules, command: args.command, cwd,
      })
      return Object.assign(rejection, { audit_id: auditId })
    }
    const d = detectBash()
    if (!d.bashPath) {
      const payload = missingBashResult(d)
      appendAudit({ id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: 'error', error_code: payload.error_code, command: args.command, cwd })
      return Object.assign({ audit_id: auditId }, payload)
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
      return payload
    }

    if (rejection) {
      const accepted = approvals.request({
        args: { command: args.command, cwd, login, env, timeout_ms: args.timeout_ms,
          run_in_background: args.run_in_background === true },
        verdict, policy, auditId, signal: extra?.signal,
        execute: frozenArgs => execute(frozenArgs, { signal: extra?.signal }, {
          verdict: { ...verdict, decision: 'approved-once' },
          policy: 'approved-once (' + verdict.tier + ')', auditId,
        }),
      })
      const response = accepted.approval_id
        ? await approvals.awaitResult(accepted.approval_id, extra?.signal)
        : accepted
      if (warnings.length > 0) response.warnings = warnings
      return response
    }

    if (args.run_in_background === true) {
      const running = runningJobCount('background')
      if (running >= MAX_BACKGROUND_JOBS) {
        return withHint(Object.assign(baseResult(), {
          error_code: 'TOO_MANY_JOBS',
          audit_id: auditId,
          policy,
        }), 'already running ' + running + ' background jobs (limit ' + MAX_BACKGROUND_JOBS + '): wait for one to finish or stop it with job_kill.')
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
      return started
    }

    const callStart = Date.now()
    const waitBudget = Math.min(requested, FOREGROUND_MS)
    const gated = await gate.run(async () => {
      if (closed) return { result: Object.assign(baseResult(), {
        error_code: 'SERVER_CLOSED', hint: 'The server session ended while this command was queued.' }) }
      const remaining = callStart + waitBudget - Date.now()
      if (remaining <= QUEUE_FLOOR_MS) return { queuedOut: true }
      const outcome = await runWithForegroundBudget(d.bashPath, args.command, {
        cwd, login, env, signal: extra && extra.signal ? extra.signal : undefined,
        timeoutMs: requested, waitMs: remaining,
        onLaunch: handle => {
          active.add(handle)
          handle.done.then(() => active.delete(handle))
        },
      })
      if (!outcome.detached) return { result: outcome.result, handle: outcome.handle }
      const job = adopt(outcome.handle, { command: args.command, cwd, policy, auditId })
      active.delete(outcome.handle)
      if (closed) job.handle.kill('kill')
      appendAudit({
        id: auditId, ts: new Date().toISOString(), tool: 'exec', phase: 'handoff',
        job_id: job.id, decision: verdict.decision, tier: verdict.tier, command: args.command, cwd,
      })
      return { detached: job, cancelled: outcome.cancelled, handle: outcome.handle }
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
      return withHint(payload,
        'the concurrency gate (' + MAX_CONCURRENCY + ' at a time) held this call for ' + queuedMs + 'ms, which is its whole ' + waitBudget + 'ms foreground budget, so nothing was started. ' +
        'Re-run it with run_in_background: true, or wait for a slot to free up.')
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
      return withHint(payload, r.cancelled === true
        ? 'the MCP request was cancelled before the command finished, so it was NOT killed: it keeps running as ' + r.detached.id + ' with no time limit. ' +
          'Find it with job_list, read it with job_output, stop it with job_kill.'
        : 'the foreground wait is capped at ' + FOREGROUND_MS + 'ms so this call returns before the client request timeout. ' +
          'The command was NOT killed and no longer has a time limit (the ' + requested + 'ms budget applied to this call, not to a process nobody is waiting for): ' +
          'it runs as ' + r.detached.id + ' until it finishes on its own. Read it with job_output, stop it with job_kill.')
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
    return payload
  }
  execute.close = () => {
    closed = true
    for (const handle of active) handle.kill('kill')
  }
  return execute
}
