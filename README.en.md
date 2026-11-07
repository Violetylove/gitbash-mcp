# gitbash-mcp

English · [简体中文](README.md) · [npm](https://www.npmjs.com/package/gitbash-mcp)

Run Git Bash commands from AI clients on Windows, with local human approval, background jobs, diagnostics and audit logs. Use it for Git, shell pipelines, builds and scripts; use PowerShell for Windows-native cmdlets, COM and .NET operations.

## Install and connect

Requires Windows, Node.js 18 or later and Git Bash. Human approval also requires an available Windows desktop, Windows PowerShell and WPF.

```powershell
npm install -g gitbash-mcp
gitbash-mcp init
```

Select a client, restart it and check that the MCP tools loaded. Supported clients: DSH, Claude Code, Codex CLI, Claude Desktop, Cursor and VS Code. VS Code configuration goes into the current directory, so enter your project first. Existing configuration files are backed up before changes.

```powershell
gitbash-mcp init --dry-run                 # Preview target paths and whether writes are needed
gitbash-mcp init --target codex,cursor     # Select clients
```

Only global installation is supported; npx / bunx startup is not provided. The MCP client starts the service, so a separate terminal is usually unnecessary. Running `gitbash-mcp` without arguments starts the stdio MCP server.

## Usage

Ask your AI to use gitbash-mcp to check Git status or run a build in the background. The JSON below contains MCP tool arguments.

### Execute commands

Example `exec` call:

```json
{
  "command": "git status --short",
  "cwd": "C:\\projects\\demo"
}
```

| Parameter | Purpose |
|---|---|
| `command` | Required; Bash command or multiline script |
| `cwd` | Windows working directory; defaults to the client workspace, then the service directory |
| `run_in_background` | `true`: return a `job_id` immediately after authorization |
| `timeout_ms` | Execution limit, 1000–600000 milliseconds; defaults to 60000 for foreground, unlimited when omitted for background |
| `login` | `true` uses a login shell and loads Bash login configuration |

There is no `env` parameter: put environment variables in the command, such as `FOO=1 npm test`, for policy evaluation. Such assignments require approval in the default mode. Path conversion is disabled by default; restore it for a program with `env -u MSYS_NO_PATHCONV prog`. The command is still evaluated for risk. Use `cmd /c`; the legacy `cmd //c` form is rejected when conversion is disabled.

Inspect `exit_code`, `stdout` and `stderr`; if a result includes `job_id`, use the job tools to continue. Command failures return structured results and available hints. Invalid directories return `INVALID_CWD` without starting the command. Each call starts a fresh shell; state such as `cd` does not persist, so supply `cwd` when needed.

### Human approval

The default mode automatically allows read-only commands and recognized project entry points. Other commands require local human approval; catastrophic commands are denied.

The window shows the original command and directory, with expandable long content and navigation between requests. **Approve** allows that original request once; **Reject** rejects it; closing the window cancels all pending requests. The window closes when no approvals remain pending, while approved commands continue running. Login shell, background mode and timeout are fixed in the request and are not shown in the window; approval uses those original parameters. Only the local window can approve; MCP provides query and cancellation tools.

`exec` waits for the decision, then returns the execution result (possibly with a `job_id`) or the rejection/cancellation reason. Human approval has no service timeout and consumes neither execution concurrency nor execution time. Normal approval needs no polling.

If the client interrupts waiting or times out, accepted approvals survive. **Do not resubmit the command**:

- `approval_list {}`: recover the `approval_id` by command, directory and creation time.
- `approval_status {approval_id}`: read its state and available execution result.
- `approval_cancel {approval_id}`: withdraw a pending approval.

The client may impose its own request timeout. Client disconnection or service exit cleans up approvals; records do not survive a restart.

Risk mode is set through `GITBASH_MCP_RISKY` in the client's MCP startup environment:

| Value | Behavior |
|---|---|
| `ask` (default) | Apply the approval and denial rules above |
| `allow` | Skip risk approval, including allowing catastrophic commands |

Only when explicitly requested by the user, merge `"GITBASH_MCP_RISKY": "allow"` into the current client's server `env`, preserving other settings. The server key created by init is `gitbash`; use the client's corresponding format for TOML, YAML and other configurations. Restart the service and verify with MCP `policy`. To restore the default, remove the variable or set it to `ask`, then restart. Setting it inside an execution command changes neither the running service mode nor host permissions.

### Background jobs

For long commands, use:

```json
{
  "command": "npm run build",
  "cwd": "C:\\projects\\demo",
  "run_in_background": true
}
```

| Tool | Purpose |
|---|---|
| `job_output {job_id}` | Read status and output; add `wait: true` to wait |
| `job_list {}` | Find jobs in the current service |
| `job_kill {job_id}` | Stop a job and its entire child process tree |

After authorization, foreground calls wait at most 45 seconds, including queue time; approval waiting is separate. When that budget expires or a cancellation signal arrives, a running command transfers to the job registry and its inherited execution timeout is cleared. Recover it with `job_list` and stop it with `job_kill`. Execution timeout expiry before transfer stops the process tree; explicitly started background jobs obey their supplied timeout. The service cannot detect a client timeout that sends no cancellation signal.

Jobs do not survive service restarts. Client disconnection or service exit cleans up running tasks.

## Diagnostics and maintenance

```powershell
gitbash-mcp doctor       # Check the environment and Bash path
gitbash-mcp policy       # Show this terminal process's command policy
gitbash-mcp audit        # Read local execution and approval records
```

AI clients can call `doctor`, `policy` and `bash_info`. Use MCP `policy` to verify the risk mode in the client's startup environment. If Bash is missing, install Git for Windows or set `GITBASH_BASH` to the `bash.exe` path in the client startup environment, then restart the service. After interrupted calls, check approvals and jobs before retrying.

To remove client configuration and the global installation:

```powershell
gitbash-mcp uninstall
npm uninstall -g gitbash-mcp
```

## Permissions and boundaries

This service runs **outside the agent sandbox**, with the **full user permissions of the agent process that starts it**, and **has no file sandbox**. Classification, approval and auditing reduce mistakes; they provide no security isolation. Recognized project scripts have not been individually verified as safe.

## Agent Skill

The standalone [Agent Skill](skills/gitbash-mcp/SKILL.md) can be installed in a client-supported skill directory to guide dependency checks, global installation, setup and use. It contains no MCP service and is excluded from the npm package.

## Further documentation

[Design and contracts](docs/DESIGN.md) · [Goals and progress](docs/PROGRESS.md) · [Contributor instructions](AGENTS.md)

MIT License.
