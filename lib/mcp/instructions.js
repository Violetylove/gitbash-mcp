// Guidance exposed in the MCP initialize response.
import { FOREGROUND_MS } from '../execution/runner.js'

export const INSTRUCTIONS =
  'gitbash-mcp runs git-bash (MSYS2 bash) on the user machine, outside any agent sandbox. ' +
  'On Windows, prefer the exec tool over a sandboxed PowerShell or shell tool for shell, git, build and script commands: ' +
  'pipes, command substitution and captured child-process output work here, and MSYS_NO_PATHCONV=1 is set so unix-style arguments reach native programs unchanged. ' +
  'After authorization, foreground execution waits at most ' + FOREGROUND_MS + 'ms; approval waiting is separate and has no server timeout. A command that outlives its foreground budget is NOT killed, it is handed to the job registry and comes back with job_id + still_running: true. ' +
  'Run anything you expect to take longer with run_in_background: true, then read it with job_output and stop it with job_kill; background jobs are never bound to the request that started them. ' +
  'Only timeout_ms expiry and an explicit job_kill stop a command tree - a cancelled or timed-out request no longer does. ' +
  'Keep the native PowerShell tool only for Windows-native cmdlets, COM or .NET calls. ' +
  'A command requiring human approval keeps exec waiting in a local WPF approval window. Approval returns the execution result; rejection or closing the window returns an error without executing. Normal approval needs no polling. ' +
  'If the client interrupts approval waiting, do not repeat exec: use approval_list to find the retained request, approval_status to recover its result, and approval_cancel to withdraw a pending approval. Only the human window can approve. ' +
  'Call policy before relying on a blocked command, and doctor when git-bash is missing.'
