#!/usr/bin/env node
// MCP stdio entry: compose services, register tools and manage shutdown.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpSession } from './lib/mcp/server.js'

const session = createMcpSession()

await session.server.connect(new StdioServerTransport())
console.error('[gitbash-mcp] listening on stdio; run doctor for bash diagnostics')

// Stop registered command trees when the client closes this server.
process.on('exit', () => session.close())
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { session.close(); process.exit(0) })
}
