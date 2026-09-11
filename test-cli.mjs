// CLI smoke test: exercises init/uninstall/dry-run against a temp root, so it
// never touches the real user config. Run: node test-cli.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bin = join(here, 'bin', 'gitbash-mcp.js')
const work = mkdtempSync(join(tmpdir(), 'gitbash-mcp-cli-'))
const home = join(work, 'home')
const appData = join(work, 'appdata')
const dshHome = join(work, 'dsh')

mkdirSync(home, { recursive: true })
mkdirSync(join(home, '.codex'), { recursive: true })
mkdirSync(join(appData, 'Claude'), { recursive: true })
mkdirSync(dshHome, { recursive: true })
writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2))
writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.existing]\ncommand = "y"\n')
writeFileSync(join(dshHome, 'cordis.patch.yml'), '# user patch\n')

let failures = 0
function assert(cond, label, detail) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('FAIL  ' + label + (detail !== undefined ? ' - ' + String(detail).slice(0, 300) : '')) }
}
const run = (args, extraEnv) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8',
  cwd: work,
  env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
})
const read = (p) => readFileSync(p, 'utf8')

const claudeFile = join(home, '.claude.json')
const codexFile = join(home, '.codex', 'config.toml')
const dshFile = join(dshHome, 'cordis.patch.yml')

console.log('== help / version / doctor ==')
assert(run(['--help']).stdout.includes('gitbash-mcp init'), 'help lists init')
const pkgVersion = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
assert(run(['--version']).stdout.includes(pkgVersion), 'version prints the package version', pkgVersion)
const doc = run(['doctor'])
assert(doc.stdout.includes('candidate scan'), 'doctor prints the candidate scan')

console.log('== dry-run writes nothing ==')
const dry = run(['init', '--target', 'claude-code,codex,dsh', '--dry-run', '--root', work])
assert(dry.stdout.includes('would write'), 'dry-run reports would write', dry.stdout)
assert(!read(claudeFile).includes('gitbash'), 'dry-run left claude.json untouched')

console.log('== init writes all three, preserving existing content ==')
const init = run(['init', '--target', 'claude-code,codex,dsh', '--root', work])
assert(init.status === 0, 'init exits 0', init.stderr)
const claude = JSON.parse(read(claudeFile))
const entry = claude.mcpServers.gitbash
assert(entry && typeof entry.command === 'string' && entry.command.length > 0, 'claude-code entry written')
assert(Array.isArray(entry.args) && entry.args.length === 1 && entry.args[0].includes('gitbash-mcp.js'), 'entry points at the absolute bin script', entry.args)
assert(entry.env && typeof entry.env.GITBASH_BASH === 'string', 'entry records GITBASH_BASH when detected')
assert(claude.mcpServers.other && claude.mcpServers.other.command === 'x', 'claude-code preserved the existing server')
assert(existsSync(claudeFile + '.bak'), 'claude-code backup created')
const codex = read(codexFile)
assert(codex.includes('[mcp_servers.gitbash]'), 'codex section written')
assert(codex.includes('[mcp_servers.existing]'), 'codex preserved the existing section')
const dsh = read(dshFile)
assert(dsh.includes('id: gitbash-mcp'), 'dsh entry written')
assert(dsh.includes('# user patch'), 'dsh preserved the user comment')

console.log('== idempotency ==')
const again = run(['init', '--target', 'claude-code,codex,dsh', '--root', work])
assert(again.stdout.includes('Nothing to do'), 'second init reports nothing to do', again.stdout)

console.log('== uninstall removes only our entries ==')
const un = run(['uninstall', '--target', 'claude-code,codex,dsh', '--root', work])
assert(un.status === 0, 'uninstall exits 0', un.stderr)
const claude2 = JSON.parse(read(claudeFile))
assert(claude2.mcpServers.gitbash === undefined, 'claude-code entry removed')
assert(claude2.mcpServers.other !== undefined, 'claude-code other entry kept')
assert(!read(codexFile).includes('[mcp_servers.gitbash]'), 'codex section removed')
assert(read(codexFile).includes('[mcp_servers.existing]'), 'codex existing section kept')
assert(!read(dshFile).includes('id: gitbash-mcp'), 'dsh entry removed')
assert(read(dshFile).includes('# user patch'), 'dsh user comment kept')

console.log('== --yes picks detected clients ==')
const yes = run(['init', '--yes', '--root', work])
assert(yes.status === 0, 'init --yes exits 0', yes.stderr)
assert(read(claudeFile).includes('gitbash'), 'init --yes configured detected claude-code')

console.log('== audit command ==')
const aud = run(['audit'], { LOCALAPPDATA: work, XDG_STATE_HOME: work })
assert(aud.stdout.includes('gitbash-mcp audit'), 'audit prints its header', aud.stdout)
assert(aud.stdout.includes('no entries yet'), 'audit reports an empty log', aud.stdout)

console.log('== --runtime name writes the bare command ==')
run(['uninstall', '--target', 'claude-code', '--root', work])
run(['init', '--target', 'claude-code', '--runtime', 'name', '--root', work])
const named = JSON.parse(read(claudeFile))
assert(named.mcpServers.gitbash.command === 'gitbash-mcp', 'runtime name writes the bare command', named.mcpServers.gitbash.command)
assert(named.mcpServers.gitbash.args.length === 0, 'runtime name writes empty args')

console.log('== --runtime bun writes a bun runtime ==')
run(['init', '--target', 'claude-code', '--runtime', 'bun', '--root', work])
const bunned = JSON.parse(read(claudeFile))
assert(/bun/i.test(bunned.mcpServers.gitbash.command), 'runtime bun resolves a bun executable', bunned.mcpServers.gitbash.command)

rmSync(work, { recursive: true, force: true })
console.log(failures === 0 ? '\nCLI ALL PASS' : '\n' + failures + ' CLI FAILURES')
process.exit(failures === 0 ? 0 : 1)
