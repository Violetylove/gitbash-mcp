// Background job registry: commands whose lifetime is NOT tied to the MCP
// request that started them. A job is a running bash process plus its live
// output channels; job_output/job_kill are the only ways to read or stop it.
//
// Why this exists (see docs/DESIGN.md §5.10): MCP clients impose their own
// request timeout (the SDK defaults to 60s) and a timed-out request is
// delivered to the server as a cancellation, which kills the process tree. A
// background job is started by a request that returns in milliseconds, so no
// client-side timeout can ever reach it: stopping is an explicit action.
import { randomBytes } from 'node:crypto'
import { launch, readChannelText, JOB_TAIL_BYTES } from './runner.js'
import { appendAudit } from './audit.js'

export const MAX_BACKGROUND_JOBS = 8
export const MAX_RETAINED_JOBS = 32
export const MAX_JOB_WAIT_MS = 50000
export const DEFAULT_JOB_WAIT_MS = 30000

const jobs = new Map()

function newJobId() {
  return 'job-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
}

/** Drop the oldest finished records once the registry grows past the cap. */
function prune() {
  while (jobs.size > MAX_RETAINED_JOBS) {
    let victim = null
    for (const job of jobs.values()) {
      if (job.status !== 'running' && job.mode === 'background') { victim = job; break }
    }
    if (victim === null) {
      for (const job of jobs.values()) {
        if (job.status !== 'running') { victim = job; break }
      }
    }
    if (victim === null) return
    jobs.delete(victim.id)
  }
}

function register(handle, meta) {
  const job = {
    id: meta.id,
    mode: meta.mode,
    command: meta.command,
    cwd: meta.cwd,
    pid: handle.pid,
    startedAt: handle.startedAt,
    endedAt: null,
    status: 'running',
    exitCode: null,
    timedOut: false,
    killedBy: null,
    timeoutMs: handle.timeoutMs,
    policy: meta.policy || null,
    auditId: meta.auditId || null,
    handle,
  }
  handle.done.then((r) => {
    job.endedAt = Date.now()
    job.exitCode = r.exit_code
    job.timedOut = r.timed_out === true
    job.killedBy = r.killed_by
    job.status = r.killed_by === 'timeout' ? 'timeout' : (r.killed_by ? 'killed' : 'exited')
    appendAudit({
      id: job.auditId, ts: new Date().toISOString(), tool: 'job', phase: 'finish',
      job_id: job.id, command: job.command, cwd: job.cwd,
      exit_code: r.exit_code, status: job.status, duration_ms: r.duration_ms,
      timed_out: r.timed_out, killed_by: r.killed_by,
      // The output file survives a server restart, so a job lost with the
      // process can still be recovered from disk.
      log_path: job.handle.stdout.spillPath || job.handle.stderr.spillPath || null,
    })
    prune()
  })
  jobs.set(job.id, job)
  return job
}

/** Start a background job. Returns as soon as the process exists. */
export function startJob(opts) {
  const id = newJobId()
  const handle = launch(opts.bashPath, opts.command, {
    cwd: opts.cwd,
    login: opts.login === true,
    env: opts.env,
  })
  handle.armTimeout(opts.timeoutMs || 0)
  return register(handle, {
    id,
    mode: opts.mode || 'background',
    command: opts.command,
    cwd: opts.cwd,
    policy: opts.policy,
    auditId: opts.auditId,
  })
}

/**
 * Take over a foreground handle that outlived its call: the process keeps
 * running, its output keeps being collected, and the request signal is detached
 * so no client-side timeout can kill it any more.
 */
export function adopt(handle, meta) {
  handle.detachSignal()
  return register(handle, {
    id: newJobId(),
    mode: 'foreground',
    command: meta.command,
    cwd: meta.cwd,
    policy: meta.policy,
    auditId: meta.auditId,
  })
}

export function getJob(id) {
  return jobs.get(String(id || '')) || null
}

export function listJobs() {
  return Array.from(jobs.values())
}

export function runningJobCount(mode) {
  let n = 0
  for (const job of jobs.values()) {
    if (job.status === 'running' && (mode === undefined || job.mode === mode)) n++
  }
  return n
}

/** Resolves when the job settles, or after waitMs (whichever comes first). */
export function waitForJob(job, waitMs) {
  if (job.status !== 'running') return Promise.resolve(job)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(job), Math.max(0, waitMs))
    job.handle.done.then(() => { clearTimeout(timer); resolve(job) })
  })
}

export function killJob(id) {
  const job = getJob(id)
  if (job === null) return null
  if (job.status === 'running') job.handle.kill('kill')
  return job
}

export function killAllJobs() {
  for (const job of jobs.values()) {
    if (job.status === 'running') job.handle.kill('kill')
  }
}

function streamPayload(channel, opts) {
  return readChannelText(channel, { offsetBytes: opts.offsetBytes, tailBytes: opts.tailBytes || JOB_TAIL_BYTES })
}

/** The JSON a poll returns for one job. summary omits the output bodies. */
export function jobPayload(job, opts) {
  const options = opts || {}
  const running = job.status === 'running'
  if (options.summary === true) {
    return {
      job_id: job.id,
      status: job.status,
      still_running: running,
      mode: job.mode,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      started_at: new Date(job.startedAt).toISOString(),
      ended_at: job.endedAt === null ? null : new Date(job.endedAt).toISOString(),
      duration_ms: (job.endedAt === null ? Date.now() : job.endedAt) - job.startedAt,
      exit_code: running ? null : job.exitCode,
      timed_out: job.timedOut,
      killed_by: job.killedBy,
      timeout_ms: job.timeoutMs,
      audit_id: job.auditId,
      policy: job.policy,
      stdout_bytes: job.handle.stdout.bytes,
      stderr_bytes: job.handle.stderr.bytes,
      log_path: job.handle.stdout.spillPath || job.handle.stderr.spillPath || null,
    }
  }
  const out = streamPayload(job.handle.stdout, options)
  // stderr always comes back as a tail: it is normally short, and the reader
  // asked for an incremental stdout stream, not two interleaved cursors.
  const err = streamPayload(job.handle.stderr, { tailBytes: options.tailBytes })
  return {
    job_id: job.id,
    status: job.status,
    still_running: running,
    mode: job.mode,
    command: job.command,
    cwd: job.cwd,
    pid: job.pid,
    started_at: new Date(job.startedAt).toISOString(),
    ended_at: job.endedAt === null ? null : new Date(job.endedAt).toISOString(),
    duration_ms: (job.endedAt === null ? Date.now() : job.endedAt) - job.startedAt,
    exit_code: running ? null : job.exitCode,
    timed_out: job.timedOut,
    killed_by: job.killedBy,
    timeout_ms: job.timeoutMs,
    audit_id: job.auditId,
    policy: job.policy,
    stdout: out.text,
    stderr: err.text,
    stdout_offset: out.offset,
    stderr_offset: err.offset,
    // The cursor for the next incremental poll of stdout (see offset_bytes).
    next_offset: out.next_offset,
    stdout_bytes: out.bytes_total,
    stderr_bytes: err.bytes_total,
    log_path: out.log_path || err.log_path || null,
    log_truncated: out.log_truncated || err.log_truncated,
  }
}
