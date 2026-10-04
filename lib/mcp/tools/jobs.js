import { z } from 'zod'
import { FOREGROUND_MS } from '../../execution/runner.js'
import { MAX_JOB_WAIT_MS, DEFAULT_JOB_WAIT_MS } from '../../jobs/registry.js'
import { readJob, listJobSummaries, stopJob } from '../../jobs/service.js'
import { json } from '../responses.js'

export function registerJobTools(server) {
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
    async (args) => json(await readJob(args)),
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
    async () => json(listJobSummaries()),
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
    async (args) => json(await stopJob(args)),
  )
}
