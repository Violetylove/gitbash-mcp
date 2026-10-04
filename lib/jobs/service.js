// Job query and stop operations, independent of MCP response formatting.
import { getJob, listJobs, jobPayload, waitForJob, killJob, MAX_BACKGROUND_JOBS, MAX_JOB_WAIT_MS, DEFAULT_JOB_WAIT_MS } from './registry.js'
import { withHint } from '../execution/results.js'

export async function readJob(args) {
  const job = getJob(args.job_id)
  if (job === null) {
    return withHint({ error_code: 'JOB_NOT_FOUND', job_id: String(args.job_id || ''), still_running: false },
      'unknown job id. Job ids live only in this server process: call job_list to see the jobs it is running.')
  }
  if (args.wait === true && job.status === 'running') {
    await waitForJob(job, Math.min(args.timeout_ms === undefined ? DEFAULT_JOB_WAIT_MS : args.timeout_ms, MAX_JOB_WAIT_MS))
  }
  return jobPayload(job, { offsetBytes: args.offset_bytes, tailBytes: args.tail_bytes })
}

export function listJobSummaries() {
  const jobs = listJobs()
  return {
    running: jobs.filter((j) => j.status === 'running').length,
    limit: MAX_BACKGROUND_JOBS,
    jobs: jobs.map((j) => jobPayload(j, { summary: true })),
  }
}

export async function stopJob(args) {
  const job = killJob(args.job_id)
  if (job === null) {
    return withHint({ error_code: 'JOB_NOT_FOUND', job_id: String(args.job_id || ''), still_running: false },
      'unknown job id. Job ids live only in this server process: call job_list to see the jobs it is running.')
  }
  await waitForJob(job, 3000)
  return withHint(jobPayload(job, { summary: true }), 'the whole process tree was killed; killed_by reports which signal stopped it.')
}
