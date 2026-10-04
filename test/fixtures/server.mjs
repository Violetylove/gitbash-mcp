// Protocol fixture: same production composition with an inert human window.
// No command is approved automatically; real UI tests run separately.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpSession } from '../../lib/mcp/server.js'
const session = createMcpSession({ createWindow: () => ({ update() {}, close() {} }) })
await session.server.connect(new StdioServerTransport())
process.on('exit', () => session.close())
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { session.close(); process.exit(0) })
}
