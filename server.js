#!/usr/bin/env node
/**
 * gitbash-mcp MCP server: execute git-bash (MSYS2) commands outside the agent
 * sandbox. Spawned over stdio by an MCP client (DSH, Claude Code, Codex, ...),
 * it is not subject to DSH's WRITE_RESTRICTED token, so bash.exe can create its
 * signal pipe and captured-stdio spawns work (both fail inside the sandbox).
 *
 * Result contract (docs/DESIGN.md section 4.1):
 *   { exit_code, stdout, stderr, timed_out, truncated, spill_path }
 * plus error_code/hint when git-bash is missing. Command failures return JSON
 * and never raise a tool error; only invalid arguments raise.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { detectBash, missingBashResult, doctorReport } from './lib/detect.js'
import { spawnBash } from './lib/runner.js'

const VERSION = '2.2.0'

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
      'If git-bash is missing the result carries error_code=BASH_NOT_FOUND with fix instructions; call doctor for details.',
    inputSchema: {
      command: z.string().describe('The bash command line or multi-line script to execute'),
      cwd: z.string().optional().describe('Working directory (Windows path). Defaults to the server working directory'),
      timeout_ms: z.number().int().min(1000).max(600000).optional().describe('Kill the command after this many ms (default 60000)'),
      login: z.boolean().optional().describe('Use bash -lc (login shell, sources profile) instead of bash -c'),
      env: z.record(z.string()).optional().describe('Extra environment variables for this command'),
    },
  },
  async (args) => {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('invalid command: expected a non-empty string')
    }
    const d = detectBash()
    if (!d.bashPath) {
      return { content: [{ type: 'text', text: JSON.stringify(missingBashResult(d), null, 2) }] }
    }
    const r = await spawnBash(d.bashPath, args.command, {
      cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
      timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
      login: args.login === true,
      env: args.env && typeof args.env === 'object' ? args.env : undefined,
    })
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] }
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
      'git on PATH, and the exact fix steps when bash is missing. Run this first when exec reports BASH_NOT_FOUND or when bash behaves unexpectedly.',
    inputSchema: {},
  },
  async () => {
    const text = await doctorReport()
    return { content: [{ type: 'text', text }] }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
const startup = detectBash()
console.error('[gitbash-mcp] listening on stdio; bash=' + (startup.bashPath || 'NOT FOUND (exec will report BASH_NOT_FOUND; run doctor)'))
