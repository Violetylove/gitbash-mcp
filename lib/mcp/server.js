// Compose one MCP session. Window injection is for local tests, not a tool input.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createExecutionService } from '../execution/service.js'
import { createWorkspaceResolver } from './workspace.js'
import { registerExecTool } from './tools/exec.js'
import { registerJobTools } from './tools/jobs.js'
import { registerDiagnosticTools } from './tools/diagnostics.js'
import { registerApprovalTools } from './tools/approval.js'
import { createApprovalService } from '../approval/service.js'
import { killAllJobs } from '../jobs/registry.js'
import { INSTRUCTIONS } from './instructions.js'

export function createMcpSession({ createWindow } = {}) {
  const server = new McpServer({ name: 'gitbash-mcp', version: '2.5.2' }, { instructions: INSTRUCTIONS })
  const approvals = createApprovalService({ createWindow })
  const defaultCwd = createWorkspaceResolver(() => server.server.listRoots(undefined, { timeout: 2000 }))
  const execute = createExecutionService({ defaultCwd, approvals })
  registerExecTool(server, execute)
  registerJobTools(server)
  registerDiagnosticTools(server)
  registerApprovalTools(server, approvals)
  const close = () => { approvals.close(); execute.close(); killAllJobs() }
  // A live WPF helper otherwise keeps Node alive after the client closes stdin.
  server.server.onclose = close
  return { server, close }
}
