#!/usr/bin/env node
/**
 * gitbash-mcp MCP server: execute git-bash (MSYS2) commands outside the agent
 * sandbox. Spawned over stdio by an MCP client (DSH, Claude Code, Codex, ...),
 * it is not subject to DSH's WRITE_RESTRICTED token, so bash.exe can create its
 * signal pipe and captured-stdio spawns work (both fail inside the sandbox).
 *
 * Result contract (docs/DESIGN.md section 4.1):
 *   { exit_code, stdout, stderr, timed_out, truncated, spill_path, spill_bytes,
 *     spill_truncated, duration_ms, killed_by, audit_id, queued_ms, policy? }
 * plus error_code/category/matched_rules/hint when the policy blocks a command
 * or git-bash is missing. Command failures return JSON and never raise a tool
 * error; only invalid arguments raise.
 *
 * Guardrails:
 *   P0 (always on): cancellation kills the tree, bounded concurrency, capped
 *   memory + capped spill file, credential-shaped env scrubbed, audit log.
 *   P1 (one switch): the policy engine blocks dangerous commands. The single
 *   stance switch is GITBASH_MCP_RISKY=ask (default) | allow, set by the human
 *   in the MCP client config - never by the model.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { detectBash, missingBashResult, doctorReport } from './lib/detect.js'
import { spawnBash, createSemaphore, MAX_CONCURRENCY } from './lib/runner.js'
import { appendAudit } from './lib/audit.js'
import { decide, describePolicy } from './lib/policy.js'

const VERSION = '2.3.0'
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
    truncated: false,
    spill_path: null,
    spill_bytes: 0,
    spill_truncated: false,
    duration_ms: 0,
    killed_by: null,
    queued_ms: 0,
  }
}

const server = new McpServer({ name: 'gitbash-mcp', version: VERSION })

server.registerTool(
  'exec',
  {
    title: 'Run a git-bash command',
    description:
      'Run a command or multi-line script in git-bash (MSYS2 bash on Windows) and return stdout, stderr and exit code. ' +
      'Use for bash/git workflows: git, grep/sed/awk pipelines, shell loops, make, scripts. ' +
      'This bridge runs OUTSIDE the agent sandbox: pipes work here that a sandboxed shell tool cannot create. ' +
      'Each call starts a fresh bash process; state does not persist between calls (use cd in the command or pass cwd). ' +
      'Command failures return a JSON result with a non-zero exit_code, so they never raise tool errors. ' +
      'A policy engine blocks destructive commands: such a call returns error_code APPROVAL_REQUIRED (ask the user how to proceed) ' +
      'or POLICY_DENIED (blocked at the current stance). Call the policy tool to see the rules and the current stance. ' +
      'Resource limits: at most 4 commands run at once (extra calls queue and report queued_ms), captured output is capped at 64KB per stream with the ' +
      'remainder written to a capped spill file, and cancelling the tool call kills the whole process tree (killed_by: "cancel"). ' +
      'Every call is recorded in a local audit log; the user can read it with the gitbash-mcp audit command. ' +
      'If git-bash is missing the result carries error_code=BASH_NOT_FOUND with fix instructions; call doctor for details.',
    inputSchema: {
      command: z.string().describe('The bash command line or multi-line script to execute'),
      cwd: z.string().optional().describe('Working directory (Windows path). Defaults to the server working directory'),
      timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Kill the command after this many ms (default 60000)'),
      login: z.boolean().optional().describe('Use bash -lc (login shell, sources profile) instead of bash -c'),
      env: z.record(z.string()).optional().describe('Extra environment variables for this command (passed through as given, not scrubbed)'),
    },
  },
  async (args, extra) => {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('invalid command: expected a non-empty string')
    }
    const auditId = newAuditId()
    const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd()
    const verdict = decide(args.command, { cwd })
    const matchedRules = verdict.matched

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
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
    }

    const d = detectBash()
    if (!d.bashPath) {
      const payload = missingBashResult(d)
      appendAudit({ id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: 'error', error_code: payload.error_code, command: args.command, cwd })
      return { content: [{ type: 'text', text: JSON.stringify(Object.assign({ audit_id: auditId }, payload), null, 2) }] }
    }
    const signal = extra && extra.signal ? extra.signal : undefined
    const gated = await gate.run(() => spawnBash(d.bashPath, args.command, {
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      login: args.login === true,
      env: args.env && typeof args.env === 'object' ? args.env : undefined,
      signal,
    }))
    const r = gated.value
    appendAudit({
      id: auditId, ts: new Date().toISOString(), tool: 'exec', decision: verdict.decision,
      tier: verdict.tier, reason: verdict.reason, matched_rules: matchedRules, command: args.command, cwd,
      exit_code: r.exit_code, duration_ms: r.duration_ms, queued_ms: gated.queuedMs,
      timed_out: r.timed_out, killed_by: r.killed_by, truncated: r.truncated, spill_truncated: r.spill_truncated,
    })
    const payload = Object.assign({}, r, {
      audit_id: auditId,
      queued_ms: gated.queuedMs,
      policy: { decision: verdict.decision, tier: verdict.tier, stance: verdict.stance, reason: verdict.reason, matched_rules: matchedRules },
    })
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
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
      return { content: [{ type: 'text', text: missingBashResult(d).stderr }] }
    }
    const r = await spawnBash(d.bashPath, 'bash --version | head -1; git --version; echo HOME=$HOME; echo PWD=$PWD; echo MSYSTEM=$MSYSTEM', { timeoutMs: 15000 })
    return { content: [{ type: 'text', text: 'bash: ' + d.bashPath + '\n' + r.stdout + r.stderr }] }
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
    const text = await doctorReport()
    return { content: [{ type: 'text', text }] }
  },
)

server.registerTool(
  'policy',
  {
    title: 'Show the command policy',
    description:
      'Report the active risky-command stance (GITBASH_MCP_RISKY, set by the user in the MCP client config), what each rule tier does under it, ' +
      'and the full rule list. Call this after exec returns error_code POLICY_DENIED or APPROVAL_REQUIRED, so you can explain the block and the ' +
      'user options accurately.',
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: 'text', text: describePolicy() }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
const startup = detectBash()
console.error('[gitbash-mcp] listening on stdio; bash=' + (startup.bashPath || 'NOT FOUND (exec will report BASH_NOT_FOUND; run doctor)'))
