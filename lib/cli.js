// gitbash-mcp CLI: register this MCP server with the AI agents installed on
// this machine. Zero dependencies (node:readline), works under Node and Bun.
//
//   gitbash-mcp init [--target dsh,codex] [--yes] [--dry-run] [--root DIR]
//   gitbash-mcp uninstall [--target ...] [--yes] [--dry-run] [--root DIR]
//   gitbash-mcp doctor
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { detectBash, doctorReport, findOnPath } from './detect.js'
import { readCheckboxMenu } from './menu.js'
import { makeStyler } from './theme.js'
import { readAudit, auditPath } from './audit.js'

const ARGS = process.argv.slice(2)
const COMMAND = ARGS[0] || 'help'
const MCP_NAME = 'gitbash'

const hasFlag = (n) => ARGS.includes('--' + n)
const optValue = (n) => {
  const i = ARGS.indexOf('--' + n)
  return i >= 0 && ARGS[i + 1] !== undefined ? ARGS[i + 1] : undefined
}

/** Resolve the config roots. --root DIR makes everything deterministic (tests). */
function roots() {
  const override = optValue('root')
  const home = override ? join(override, 'home') : (process.env.USERPROFILE || homedir())
  const appData = override ? join(override, 'appdata') : (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
  const dshHome = override ? join(override, 'dsh') : (process.env.DSH_HOME || join(home, '.dsh'))
  return { home, appData, dshHome, cwd: process.cwd() }
}

/** Probe a list of [kind, value] checks; returns { found, why } with a short reason. */
function probe(checks) {
  for (const entry of checks) {
    const kind = entry[0]
    const value = entry[1]
    if (kind === 'cmd') {
      const found = findOnPath(value)
      if (found) return { found: true, why: 'command ' + value }
    } else if (existsSync(value)) {
      return { found: true, why: basename(value) }
    }
  }
  return { found: false, why: '' }
}

/** Supported clients. detect() returns { found, why } - the reason is shown in the menu. */
const TARGETS = [
  { id: 'dsh', label: 'DSH', kind: 'yaml', restart: 'restart dsh web',
    file: (r) => join(r.dshHome, 'cordis.patch.yml'), detect: (r) => probe([['dir', r.dshHome]]) },
  { id: 'claude-code', label: 'Claude Code', kind: 'json', key: 'mcpServers', restart: 'restart Claude Code',
    file: (r) => join(r.home, '.claude.json'),
    detect: (r) => probe([['cmd', 'claude'], ['dir', join(r.home, '.claude')], ['file', join(r.home, '.claude.json')]]) },
  { id: 'codex', label: 'Codex CLI', kind: 'toml', restart: 'restart Codex',
    file: (r) => join(r.home, '.codex', 'config.toml'),
    detect: (r) => probe([['cmd', 'codex'], ['dir', join(r.home, '.codex')]]) },
  { id: 'claude-desktop', label: 'Claude Desktop', kind: 'json', key: 'mcpServers', restart: 'restart Claude Desktop',
    file: (r) => join(r.appData, 'Claude', 'claude_desktop_config.json'),
    detect: (r) => probe([['dir', join(r.appData, 'Claude')], ['file', join(r.appData, 'Claude', 'claude_desktop_config.json')]]) },
  { id: 'cursor', label: 'Cursor', kind: 'json', key: 'mcpServers', restart: 'restart Cursor',
    file: (r) => join(r.home, '.cursor', 'mcp.json'),
    detect: (r) => probe([['cmd', 'cursor'], ['dir', join(r.home, '.cursor')]]) },
  { id: 'vscode', label: 'VS Code (workspace .vscode/mcp.json)', kind: 'json', key: 'servers', restart: 'reload the VS Code window',
    file: (r) => join(r.cwd, '.vscode', 'mcp.json'),
    detect: (r) => probe([['cmd', 'code'], ['dir', join(r.cwd, '.vscode')]]) },
]

function entryScript() {
  return fileURLToPath(new URL('../bin/gitbash-mcp.js', import.meta.url))
}

// Absolute runtime + script is the robust default: global shim dirs are often
// absent from PATH, which would make a bare `gitbash-mcp` command unresolvable.
function serverEntry() {
  const runtime = (optValue('runtime') || 'auto').toLowerCase()
  const d = detectBash()
  const env = d.bashPath ? { GITBASH_BASH: d.bashPath } : undefined
  if (runtime === 'name') {
    const byName = { command: 'gitbash-mcp', args: [] }
    if (env) byName.env = env
    return byName
  }
  let command = process.execPath
  if (runtime === 'node') command = findOnPath('node') || 'node'
  else if (runtime === 'bun') command = findOnPath('bun') || 'bun'
  const entry = { command, args: [entryScript()] }
  if (env) entry.env = env
  return entry
}

function readText(file) {
  let raw = readFileSync(file, 'utf8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  return raw
}

function readJson(file) {
  if (!existsSync(file)) return {}
  const raw = readText(file)
  if (raw.trim() === '') return {}
  return JSON.parse(raw)
}

function writeWithBackup(file, content) {
  if (existsSync(file)) copyFileSync(file, file + '.bak')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function jsonPlan(target, r, mode) {
  const file = target.configPath
  const current = existsSync(file) ? readText(file) : ''
  const obj = readJson(file)
  if (!obj[target.key] || typeof obj[target.key] !== 'object') obj[target.key] = {}
  if (mode === 'remove') delete obj[target.key][MCP_NAME]
  else obj[target.key][MCP_NAME] = serverEntry()
  return { file, current, content: JSON.stringify(obj, null, 2) + '\n' }
}

function tomlBody(entry) {
  const esc = (s) => s.replace(/\\/g, '\\\\')
  let body = 'command = "' + esc(entry.command) + '"\n'
  body += 'args = [' + entry.args.map((a) => '"' + esc(a) + '"').join(', ') + ']\n'
  if (entry && entry.env && entry.env.GITBASH_BASH) {
    body += '\n[mcp_servers.' + MCP_NAME + '.env]\nGITBASH_BASH = "' + esc(entry.env.GITBASH_BASH) + '"\n'
  }
  return body
}

function stripToml(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let skipping = false
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      skipping = /^\s*\[mcp_servers\.gitbash(?:\.[A-Za-z0-9_]+)?\]\s*$/.test(line)
      if (skipping) continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function tomlPlan(target, r, mode) {
  const file = target.configPath
  const current = existsSync(file) ? readText(file) : ''
  if (mode === 'remove') {
    const next = stripToml(current)
    return { file, current, content: next.length ? next + '\n' : '' }
  }
  const base = stripToml(current)
  const head = base.length ? base + '\n\n' : ''
  return { file, current, content: head + '[mcp_servers.' + MCP_NAME + ']\n' + tomlBody(serverEntry()) }
}

function yamlBlock(r) {
  const entry = serverEntry()
  const lines = [
    '- insert:',
    '    - id: gitbash-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: ' + MCP_NAME,
    '        transport: stdio',
    "        command: '" + entry.command.replace(/'/g, "''") + "'",
  ]
  if (entry.args.length === 0) {
    lines.push('        args: []')
  } else {
    lines.push('        args:')
    for (const a of entry.args) lines.push("          - '" + a.replace(/'/g, "''") + "'")
  }
  if (entry.env && entry.env.GITBASH_BASH) {
    lines.push('        env:')
    lines.push("          GITBASH_BASH: '" + entry.env.GITBASH_BASH.replace(/'/g, "''") + "'")
  }
  lines.push("        cwd: '" + (r.home.replace(/'/g, "''")) + "'")
  lines.push('        toolCallTimeoutMs: 300000')
  lines.push('        failOnStartupError: true')
  return lines.join('\n')
}

function removeYamlBlock(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const idx = lines.findIndex((l) => /^\s*-\s*id:\s*gitbash-mcp\s*$/.test(l))
  if (idx < 0) return lines.join('\n').trimEnd()
  let start = idx
  while (start > 0 && !/^-\s/.test(lines[start])) start--
  let end = idx + 1
  while (end < lines.length && !/^-\s/.test(lines[end])) end++
  lines.splice(start, end - start)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
}

function yamlPlan(target, r, mode) {
  const file = target.configPath
  const current = existsSync(file) ? readText(file) : ''
  if (mode === 'remove') {
    const next = removeYamlBlock(current)
    return { file, current, content: next.length ? next + '\n' : '' }
  }
  const cleaned = removeYamlBlock(current)
  const head = cleaned.length ? cleaned + '\n\n' : '# gitbash-mcp overlay (managed by gitbash-mcp init)\n'
  return { file, current, content: head + yamlBlock(r) + '\n' }
}

function planFor(target, r, mode) {
  if (target.kind === 'json') return jsonPlan(target, r, mode)
  if (target.kind === 'toml') return tomlPlan(target, r, mode)
  return yamlPlan(target, r, mode)
}

function applyPlan(plan, dryRun) {
  if (plan.content === plan.current) return 'unchanged'
  if (dryRun) return 'would write'
  writeWithBackup(plan.file, plan.content)
  return 'written'
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a) }))
}

async function chooseTargets(candidates) {
  const headless = hasFlag('no-tui') || process.env.GITBASH_MCP_NO_TUI === '1'
  if (process.stdin.isTTY && process.stdout.isTTY && !headless) {
    console.log('')
    const picked = await readCheckboxMenu(candidates, 'Select clients to configure')
    if (picked === null) {
      console.log('Cancelled - nothing was written.')
      return []
    }
    return picked
  }
  console.log('')
  console.log('Select clients to configure (comma separated numbers, "all", or "none"):')
  candidates.forEach((c, i) => {
    console.log('  ' + (i + 1) + ') ' + c.label + (c.detected ? '  [detected]' : '  [not found]'))
    console.log('     ' + c.configPath)
  })
  const answer = (await ask('> ')).trim().toLowerCase()
  if (answer === '' || answer === 'none' || answer === 'n' || answer === 'q') return []
  if (answer === 'all' || answer === 'a') return candidates
  const picked = []
  for (const part of answer.split(',')) {
    const n = parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n >= 1 && n <= candidates.length && !picked.includes(candidates[n - 1])) picked.push(candidates[n - 1])
  }
  return picked
}

function printSnippet() {
  console.log('')
  console.log('Manual configuration (paste into your MCP client):')
  console.log(JSON.stringify({ mcpServers: { [MCP_NAME]: serverEntry() } }, null, 2))
}

async function selectTargets(candidates) {
  const explicit = optValue('target')
  if (explicit) {
    const ids = explicit.split(',').map((s) => s.trim()).filter(Boolean)
    const unknown = ids.filter((id) => !candidates.some((c) => c.id === id))
    if (unknown.length) {
      console.error('unknown target(s): ' + unknown.join(', '))
      console.error('known: ' + candidates.map((c) => c.id).join(', '))
      process.exitCode = 1
      return null
    }
    return candidates.filter((c) => ids.includes(c.id))
  }
  if (hasFlag('yes')) return candidates.filter((c) => c.detected)
  return chooseTargets(candidates)
}

/** Candidate list for a root set: config path + live detection, detected first. */
export function buildCandidates(r) {
  return TARGETS.map((t) => {
    const d = t.detect(r)
    return Object.assign({}, t, { configPath: t.file(r), detected: d.found, why: d.why })
  }).sort((a, b) => (b.detected ? 1 : 0) - (a.detected ? 1 : 0))
}

export { roots }

async function runChange(mode) {
  const style = makeStyler(process.stdout)
  const r = roots()
  const dryRun = hasFlag('dry-run')
  const d = detectBash()
  console.log('gitbash-mcp ' + (mode === 'remove' ? 'uninstall' : 'init') + (dryRun ? ' (dry-run)' : ''))
  console.log('bash: ' + (d.bashPath || 'NOT FOUND - configure anyway, then install Git for Windows or set GITBASH_BASH'))
  const candidates = buildCandidates(r)
  const selected = await selectTargets(candidates)
  if (selected === null) return
  if (selected.length === 0) {
    console.log('')
    console.log('No client selected.')
    if (mode === 'install') printSnippet()
    return
  }
  console.log('')
  let changed = 0
  for (const t of selected) {
    const plan = planFor(t, r, mode)
    const result = applyPlan(plan, dryRun)
    if (result !== 'unchanged') changed++
    const mark = result === 'written' ? style.green('\u2714 written')
      : result === 'would write' ? style.cyan('\u25c7 would write')
      : style.dim('\u00b7 unchanged')
    console.log('  ' + mark + '  ' + style.bold(t.label))
    console.log('    ' + style.gray(plan.file))
  }
  console.log('')
  if (changed === 0) {
    console.log(style.dim('Nothing to do - configuration already up to date.'))
  } else if (dryRun) {
    console.log('Dry run: no files were written.')
  } else {
    console.log('Done. Next steps:')
    for (const t of selected) console.log('  - ' + t.restart)
  }
}

function runHelp() {
  console.log([
    'gitbash-mcp - MCP server exposing git-bash (MSYS2) to AI agents',
    '',
    'Usage:',
    '  gitbash-mcp                     start the MCP server (stdio) - used by MCP clients',
    '  gitbash-mcp init                pick clients and write their MCP config',
    '  gitbash-mcp init --yes          configure every detected client without prompting',
    '  gitbash-mcp init --target dsh,codex --dry-run',
    '  gitbash-mcp uninstall [--target ...] [--yes] [--dry-run]',
    '  gitbash-mcp doctor              print the git-bash environment diagnosis',
    '  gitbash-mcp audit [-n 20]       print the recent command audit log',
    '',
    'Options:',
    '  --target <ids>   comma separated: dsh, claude-code, codex, claude-desktop, cursor, vscode',
    '  --yes            no prompt; use detected clients',
    '  --dry-run        print what would change without writing',
    '  --runtime <r>    auto (default: absolute runtime + script path), node, bun, or name',
    '  --no-tui         plain numbered prompt instead of the arrow-key menu',
    '  --root <dir>     override config roots (testing)',
    '  --version, --help',
  ].join('\n'))
}

function runAudit() {
  const style = makeStyler(process.stdout)
  const limitRaw = optValue('n')
  const limit = limitRaw === undefined ? 20 : Math.max(1, Number(limitRaw) || 20)
  const rows = readAudit(limit)
  const nl = String.fromCharCode(10)
  console.log(style.bold('gitbash-mcp audit') + '  ' + style.gray(auditPath()))
  if (rows.length === 0) {
    console.log(style.dim('(no entries yet)'))
    return
  }
  for (const r of rows) {
    const when = String(r.ts || '').replace('T', ' ').replace(/\..*$/, '')
    const code = r.exit_code === 0 ? style.green('0') : style.red(String(r.exit_code))
    const flags = []
    if (r.timed_out) flags.push('timeout')
    if (r.killed_by === 'cancel') flags.push('cancelled')
    if (r.queued_ms) flags.push('queued ' + r.queued_ms + 'ms')
    if (r.spill_truncated) flags.push('spill truncated')
    if (r.error_code) flags.push(String(r.error_code))
    console.log('  ' + style.gray(when) + '  exit=' + code + '  ' + (r.duration_ms || 0) + 'ms' + (flags.length ? '  ' + style.yellow(flags.join(', ')) : ''))
    const first = String(r.command || '').split(nl)[0]
    console.log('    ' + first.slice(0, 120))
  }
}

async function main() {
  if (COMMAND === 'help' || COMMAND === '--help' || COMMAND === '-h') return runHelp()
  if (COMMAND === '--version' || COMMAND === '-v') { console.log(versionString()); return }
  if (COMMAND === 'doctor') { console.log(await doctorReport()); return }
  if (COMMAND === 'audit') return runAudit()
  if (COMMAND === 'init') return runChange('install')
  if (COMMAND === 'uninstall' || COMMAND === 'remove') return runChange('remove')
  console.error('unknown command: ' + COMMAND)
  runHelp()
  process.exitCode = 1
}

function versionString() {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return 'gitbash-mcp ' + pkg.version
  } catch (e) {
    return 'gitbash-mcp'
  }
}

if (!process.env.GITBASH_MCP_CLI_NO_MAIN) await main()
