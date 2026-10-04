import { z } from 'zod'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, FOREGROUND_MS, MAX_CONCURRENCY } from '../../execution/runner.js'
import { json } from '../responses.js'

export function registerExecTool(server, execute) {
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
        'LONG COMMANDS: pass run_in_background: true to get a job id in milliseconds after any required human approval - the command then outlives this request, is immune to the client request timeout, ' +
        'and is read with job_output / stopped with job_kill. Without it execution is foreground: after authorization its wait is capped at ' + FOREGROUND_MS + 'ms, and a command still running at that point is ' +
        'handed to the job registry rather than killed (the result then carries job_id and still_running: true). ' +
        'timeout_ms is the process lifetime (default ' + DEFAULT_TIMEOUT_MS + 'ms foreground, no limit in background; max ' + MAX_TIMEOUT_MS + 'ms) and kills the whole process tree on expiry. ' +
        'Command failures return a JSON result with a non-zero exit_code, so they never raise tool errors; read timed_out / still_running / killed_by to tell a failure from a timeout. ' +
        'Commands requiring approval open the local human approval window and keep this exec call waiting. Approval has no human-response timeout and does not consume the execution budget. ' +
        'After approval this call returns the execution result with approval_id (and job_id for a continuing job); rejection returns APPROVAL_REJECTED, closing the window returns APPROVAL_CANCELLED. ' +
        'Normal approval needs no polling. If the client interrupts this call, the accepted approval survives: do not resubmit, find it with approval_list and read approval_status. ' +
        'Use approval_cancel to withdraw a pending request. Commands denied by policy return ' +
        'POLICY_DENIED (blocked at the current stance). Call the policy tool to see the rules and the current stance. ' +
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
        run_in_background: z.boolean().optional().describe('After any required human approval, start as a background job and return job_id immediately; read with job_output and stop with job_kill'),
      },
    },
    async (args, extra) => json(await execute(args, extra)),
  )
}
