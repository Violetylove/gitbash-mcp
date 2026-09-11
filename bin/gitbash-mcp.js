#!/usr/bin/env node
// Single entry point for the gitbash-mcp package.
//   no args                  -> start the MCP server (stdio)
//   init|uninstall|doctor|help -> CLI commands
const cliCommands = new Set(['init', 'uninstall', 'doctor', 'help', '--help', '-h', '--version', '-v'])
const cmd = process.argv[2]
if (cmd !== undefined && cliCommands.has(cmd)) {
  await import('../lib/cli.js')
} else {
  await import('../server.js')
}
