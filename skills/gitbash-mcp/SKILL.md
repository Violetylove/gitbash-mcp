---
name: gitbash-mcp
description: Set up and use gitbash-mcp on Windows to run Git Bash commands, Git workflows, pipelines, builds, and scripts, including human approval recovery and background jobs. Use for this MCP's setup and shell work; use native PowerShell tools for Windows cmdlets, COM, and .NET operations.
---

# gitbash-mcp

## Connection and permissions

This skill provides usage instructions. It contains no executable scripts or MCP server; follow the setup steps below when installation or connection is needed. The server requires Windows, Node.js 18 or later, and Git Bash. Human approval also requires an available Windows desktop, Windows PowerShell, and WPF.

Use the host's tool discovery mechanism to find tools belonging to the gitbash-mcp server: `exec`, `job_output`, `job_list`, `job_kill`, `approval_list`, `approval_status`, `approval_cancel`, `doctor`, `policy`, and `bash_info`. Clients may add namespaces or prefixes. Check the actual tool source, description, and schema instead of hardcoding a client-specific name or treating another server's `exec` as this tool.

If the tools are unavailable and the user wants to use or set up gitbash-mcp, perform setup yourself using the host's available terminal or configuration tools, within the user's authorization and the host's permission boundaries. Do not merely tell the user to run installation commands when you can run them:

1. Check for Windows, Node.js 18 or later, npm, and Git Bash. If a prerequisite is missing, install it with an available trusted Windows package manager when authorized and feasible; otherwise explain the specific blocker and the smallest user action needed. For an existing installation, check `gitbash-mcp doctor` and fix the reported issue when possible.
2. If the server is not installed, run `npm install -g gitbash-mcp`. Use a supported terminal before this MCP exists. Only global installation is supported; do not use npx or bunx. If installation needs elevation or another unavailable permission, report the blocker instead of repeatedly retrying or bypassing it.
3. Identify the current client and configure only that client. The built-in init uses the server key `gitbash` (for example `mcpServers.gitbash` in JSON and `[mcp_servers.gitbash]` in TOML). Inspect its existing server entry first: if already configured, try reconnecting and diagnosing before reconfiguring. `init` replaces the existing gitbash-mcp entry, including custom environment settings, so preserve and restore any needed custom settings if reconfiguration is necessary. For DSH, Claude Code, Codex CLI, Claude Desktop, Cursor, and VS Code, use `gitbash-mcp init --target <id> --dry-run` to check the target path and whether it would be written, then `gitbash-mcp init --target <id>` to apply it; the dry run does not show a full diff. Target IDs are `dsh`, `claude-code`, `codex`, `claude-desktop`, `cursor`, and `vscode`. Run from the intended project directory for VS Code. Do not use `--yes` to configure unrelated detected clients. If the client is unknown or not supported by init, use its documented configuration method for the globally installed `gitbash-mcp` command with no arguments, preserving existing settings; if the right target or location cannot be determined, ask the user.
4. Reload or reconnect the MCP server through the host if that is available, then discover the tools again and use `doctor` or a harmless command to verify the connection. If restarting or reconnecting the current client requires the user's action, explain that concrete step and resume verification after reconnection. Do not claim the server is connected before the tools are discoverable.

Installing the skill and configuring MCP are separate steps. A host may be unable to install packages, change its own MCP configuration, or reload tools in the current session; report such limitations accurately. Compatibility with every client is not guaranteed.

The server runs outside the agent sandbox with the full user permissions of the agent process that launches it. **There is no filesystem sandbox.** Command policy, approvals, and auditing do not provide OS security isolation. Respect user authorization and the host's permission, approval, and sandbox restrictions. Tool availability does not authorize bypassing those restrictions. Do not separately launch Git Bash inside a restricted sandbox or switch tools or rewrite commands to bypass a denial.

## Risk mode configuration

The MCP server's startup environment variable is `GITBASH_MCP_RISKY` (not `GITBASH_MCP_RICKY`). The default `ask` mode requests human approval for risky or opaque commands and denies catastrophic commands. `allow` skips risk approvals and permits commands the default mode would deny, including catastrophic ones. This affects the server's subsequent commands, not just the current request, and does not override host permissions or create a sandbox.

When the user explicitly requests this broader mode, configure `GITBASH_MCP_RISKY=allow` in this server's environment in the current client's MCP configuration, preserving its other settings and environment variables. For a JSON-style client, merge `"GITBASH_MCP_RISKY": "allow"` into the `env` object of the actual server entry (`gitbash` when created by init); use the client's documented equivalent for other formats. Do not enable it merely because a command was denied or the agent wants to avoid an approval. Restart or reconnect the server after a change and use `policy` to verify the active stance. To restore the default, remove the variable or set it to `ask`, then restart and verify. Setting it inside an `exec` command changes the child command's environment, not the already running server's policy.

## Running commands

On Windows, when use of this service is permitted, prefer it for shell commands, Git, pipelines, builds, and scripts. This example contains MCP arguments, not a command to paste into a terminal:

```json
{"command":"git status --short","cwd":"C:\\projects\\demo"}
```

- Pass the Bash command or multiline script directly as `command`. Do not add another `bash -c` wrapper or shell-quoting layer.
- Set `cwd` to an explicit Windows path to select the project. Otherwise, the server uses the client workspace or its own working directory. Each call starts a fresh shell: `cd`, variables, and shell state do not persist across calls.
- Set `login: true` only when login configuration is needed. There is no `env` parameter. Put required environment assignments in the command, such as `FOO=1 npm test`, so command policy can evaluate them.
- `MSYS_NO_PATHCONV=1` disables path conversion by default. To restore it for a program, prefix that program with `env -u MSYS_NO_PATHCONV`. With the default setting, use `cmd /c`, not the legacy `cmd //c` form. Follow the returned hint for `PATHCONV_ESCAPE`.
- Command failures return JSON; a successful tool invocation does not establish command success. Read `exit_code`, `stdout`, `stderr`, `error_code`, `hint`, `timed_out`, `still_running`, and `killed_by`. Follow any `job_id` with job tools. Both `timed_out: true` and `still_running: true` can appear together; this does not mean the process stopped. Check `truncated`, `spill_path`, and related fields before treating output as complete.

For `BASH_NOT_FOUND`, call `doctor` for repair steps, install Git for Windows or correct the path as instructed, and reconnect. For `INVALID_CWD`, correct the directory first. For `POLICY_DENIED`, use `policy` to understand the reason and report it to the user. Do not report a failed or denied command as completed successfully.

## Human approval and recovery

In the default `ask` mode, commands requiring confirmation must be approved through the local human approval window. Commands denied by policy do not start. During normal approval, let the original `exec` call wait; polling is unnecessary. Approval returns the execution result, while rejection or closing the window returns a reason. Human waiting has no server timeout and does not consume the command's execution time limit. Only the local human window can approve. MCP exposes no tool that can approve a command and no `approval_wait` tool.

After a client interruption or request timeout, do not resubmit the command. An accepted approval request can remain available. Use `approval_list {}` to locate it by command, directory, and time, then query `approval_status {"approval_id":"..."}`. If the result contains `job_id`, continue with job tools. An interrupted response may contain `APPROVAL_DETACHED`, but receipt is not guaranteed. `approval_cancel` only withdraws pending approval requests; it cannot stop an already approved execution. Closing the window cancels all pending approvals while approved commands continue. If a client times out without sending a cancellation signal, the server cannot detect that timeout itself.

## Long commands and stopping work

For commands expected to take a long time, set `run_in_background: true`. The server returns `job_id` promptly after authorization; human approval can still require waiting. Collect results with `job_output {"job_id":"...","wait":true}`. Its default wait is 30000ms and maximum wait is 50000ms. Here, `timeout_ms` limits only the query wait and does not kill the job. For incremental stdout, pass the previous `next_offset` as `offset_bytes`; stderr is always returned as a tail.

`exec.timeout_ms` limits process lifetime: 1000–600000ms, with a 60000ms foreground default and no limit when omitted for an explicit background run. Foreground waiting is capped at 45000ms. When that budget expires or the call is cancelled, the same running process is handed to the job registry and its inherited execution timeout is cleared. Cancelling a request does not stop the command. If no handle was received, use `job_list {}` to recover the job before considering another execution. Report success only after confirming the result.

An execution lifetime limit that expires while waiting kills the entire process tree. To stop a job explicitly, use `job_kill {"job_id":"..."}`. Expiry of a job query's wait does not indicate command failure. Client disconnection or server exit clears pending approvals and stops running work. Approval and job handles do not survive server restarts, and completed records may also be pruned.
