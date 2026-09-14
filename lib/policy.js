// Command policy - model D: capability classification + project-declared trust.
//
// Why not a regex denylist: a denylist must enumerate every dangerous spelling
// (impossible - quoting, $IFS, base64 and friends walk around it), while a
// classifier can simply refuse to vouch for what it does not understand.
//
//   read-only        no write redirection, every program is inspection-only
//   project entry    the project itself declares it (package.json script,
//                    Makefile target, justfile recipe, cargo/go/pytest/tsc...)
//   mutating         a known write/execute program (rm, npm install, curl...)
//   unknown          a program we do not vouch for            -> ask
//   opaque           command substitution, variable program, shell -c, source
//                                                             -> ask
//   dangerous        structurally dangerous                    -> ask
//   catastrophic     disk/boot/system level                    -> deny
//
// allow  = every segment is read-only or a project entry, and nothing opaque
// ask    = anything else (the default baseline)
// deny   = catastrophic, unless the human set GITBASH_MCP_RISKY=allow
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseCommand } from './shell-parse.js'

export const READ_ONLY = [
  'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df', 'tree', 'basename', 'dirname',
  'realpath', 'readlink', 'which', 'where', 'whereis', 'type', 'echo', 'printf', 'sort', 'uniq', 'cut', 'tr',
  'rev', 'tac', 'nl', 'fold', 'column', 'expand', 'unexpand', 'grep', 'rg', 'egrep', 'fgrep', 'diff', 'comm',
  'join', 'paste', 'seq', 'expr', 'test', 'true', 'false', 'date', 'whoami', 'groups', 'id', 'uname', 'hostname',
  'env', 'printenv', 'jq', 'yq', 'xxd', 'hexdump', 'od', 'base64', 'md5sum', 'sha1sum', 'sha256sum', 'shasum',
  'cksum', 'cmp', 'less', 'more', 'sleep', 'tty', 'strings', 'cygpath',
  'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'shift', 'umask', 'read', 'local', 'declare', 'typeset', ':', '[',
]

export const GIT_READ_ONLY = [
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'ls-tree', 'shortlog', 'describe', 'rev-parse', 'rev-list',
  'cat-file', 'count-objects', 'reflog', 'grep', 'whatchanged', 'show-ref', 'for-each-ref', 'name-rev', 'fsck',
  'verify-pack', 'symbolic-ref', 'cherry', 'merge-base', 'check-ignore', 'check-attr', 'var',
]

export const SHELLS = ['sh', 'bash', 'dash', 'zsh', 'ksh', 'pwsh', 'powershell', 'cmd']
const WRAPPERS = ['env', 'command', 'nohup', 'time', 'sudo', 'nice', 'stdbuf', 'setsid', 'doas']
const OPAQUE_PROGRAMS = ['eval', 'source', '.', 'xargs', 'exec']
const PROJECT_TOOLS = ['pytest', 'vitest', 'jest', 'mocha', 'tsc', 'eslint', 'ruff', 'mypy', 'golangci-lint']
const MUTATING = [
  'rm', 'rmdir', 'mv', 'cp', 'install', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'dd',
  'tee', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'bzip2', 'xz', '7z', 'rsync', 'scp', 'ssh', 'curl', 'wget',
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'pip', 'pip3', 'docker', 'kubectl', 'gh', 'systemctl', 'service',
  'reg', 'schtasks', 'sc', 'net', 'taskkill', 'make', 'just', 'go', 'cargo', 'node', 'python', 'python3', 'java',
]
const VERSION_FLAGS = ['--version', '-v', '-version', '--help', '-h']
const HOME_VAR = '$' + '{HOME}'

const projectCache = new Map()

function readIfExists(file) {
  try {
    if (!existsSync(file)) return null
    return readFileSync(file, 'utf8')
  } catch (e) {
    return null
  }
}

function parseJsonScripts(text) {
  const names = []
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object' && obj.scripts && typeof obj.scripts === 'object') {
      for (const key of Object.keys(obj.scripts)) names.push(key)
    }
  } catch (e) { void e }
  return names
}

function parseMakeTargets(text) {
  const names = []
  for (const line of String(text).split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

function parseJustRecipes(text) {
  const names = []
  for (const line of String(text).split('\n')) {
    const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

/** Snapshot the project's declared entry points for a working directory. */
export function projectEntry(cwd) {
  const key = cwd || process.cwd()
  if (projectCache.has(key)) return projectCache.get(key)
  const found = { root: null, scripts: [], make: [], just: [] }
  let dir = key
  for (let depth = 0; depth < 6; depth++) {
    const pkg = readIfExists(join(dir, 'package.json'))
    const mk = readIfExists(join(dir, 'Makefile'))
    const jf = readIfExists(join(dir, 'justfile'))
    if (pkg !== null && found.scripts.length === 0) found.scripts = parseJsonScripts(pkg)
    if (mk !== null && found.make.length === 0) found.make = parseMakeTargets(mk)
    if (jf !== null && found.just.length === 0) found.just = parseJustRecipes(jf)
    if (pkg !== null || mk !== null || jf !== null) { found.root = dir; break }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  projectCache.set(key, found)
  return found
}

function stripWrappers(program, args) {
  let prog = program
  const rest = args.slice()
  let guard = 0
  while (WRAPPERS.includes(prog) && rest.length > 0 && guard++ < 6) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest.shift()
    while (rest.length > 0 && rest[0].startsWith('-')) rest.shift()
    prog = rest.shift()
  }
  return { program: prog, args: rest }
}

function rmInfo(program, args) {
  if (program !== 'rm') return null
  const flags = args.filter((a) => a.startsWith('-'))
  const operands = args.filter((a) => !a.startsWith('-'))
  const recursive = flags.some((f) => /^-[a-z]*r/i.test(f)) || flags.includes('--recursive')
  if (!recursive) return null
  const target = String(operands[0] || '').replace(/^["']|["']$/g, '')
  const rootish =
    target === '/' || target === '/*' || target === '~' || target.startsWith('~/') ||
    target === '$HOME' || target === HOME_VAR || target === '$HOME/*' || target === HOME_VAR + '/*'
  return { recursive: true, rootish }
}

function projectMatch(program, args, cwd) {
  const project = projectEntry(cwd)
  const sub = args[0] || ''
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (sub === 'run' || sub === 'run-script') return args[1] !== undefined && project.scripts.includes(args[1]) ? 'npm run ' + args[1] : null
    if (sub === 'test' || sub === 'start' || sub === 'stop' || sub === 'restart') return project.scripts.includes(sub) ? 'npm ' + sub : null
    if (['pnpm', 'yarn', 'bun'].includes(program) && sub !== '' && project.scripts.includes(sub)) return program + ' ' + sub
    return null
  }
  if (program === 'make' || program === 'gmake') {
    const target = args.find((a) => !a.startsWith('-'))
    if (target === undefined) return project.make.length > 0 ? 'make (default target)' : null
    return project.make.includes(target) ? 'make ' + target : null
  }
  if (program === 'just') {
    const recipe = args.find((a) => !a.startsWith('-'))
    if (recipe === undefined) return null
    return project.just.includes(recipe) ? 'just ' + recipe : null
  }
  if (program === 'cargo' && ['build', 'test', 'run', 'check', 'clippy', 'bench', 'doc'].includes(sub)) return 'cargo ' + sub
  if (program === 'go' && ['build', 'test', 'run', 'vet', 'generate'].includes(sub)) return 'go ' + sub
  if (PROJECT_TOOLS.includes(program)) return program
  return null
}

function readOnlyMatch(program, args) {
  if (!READ_ONLY.includes(program) && !['sed', 'awk', 'gawk', 'mawk', 'find', 'git', 'node', 'bun', 'deno', 'python', 'python3', 'java', 'go', 'cargo', 'pip', 'pip3', 'docker', 'kubectl', 'npm', 'pnpm', 'yarn'].includes(program)) return null
  if (READ_ONLY.includes(program)) return program
  if (program === 'sed') return args.some((a) => a === '-i' || a.startsWith('-i')) ? null : 'sed (read-only)'
  if (['awk', 'gawk', 'mawk'].includes(program)) {
    const joined = args.join(' ')
    return /system\s*\(/.test(joined) || joined.includes('>') || joined.includes('|') ? null : 'awk (read-only)'
  }
  if (program === 'find') return args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'].includes(a)) ? null : 'find (read-only)'
  if (program === 'git') {
    if (args.some((a) => VERSION_FLAGS.includes(a)) && args.length === 1) return 'git (version)'
    const sub = args.find((a) => !a.startsWith('-')) || ''
    return GIT_READ_ONLY.includes(sub) ? 'git ' + sub : null
  }
  if (['node', 'bun', 'deno', 'python', 'python3', 'java', 'cargo', 'pip', 'pip3', 'npm', 'pnpm', 'yarn'].includes(program)) {
    return args.some((a) => VERSION_FLAGS.includes(a)) && args.length <= 2 ? program + ' (version)' : null
  }
  if (program === 'go') return (args[0] === 'version' || args[0] === 'env') ? 'go ' + args[0] : null
  if (program === 'docker') return ['ps', 'images', 'version', 'inspect', 'logs'].includes(args[0]) ? 'docker ' + args[0] : null
  if (program === 'kubectl') return ['get', 'describe', 'logs', 'version'].includes(args[0]) ? 'kubectl ' + args[0] : null
  return null
}

function classifySegment(seg, ctx) {
  if (seg.programHasVar) return { kind: 'opaque', reason: 'variable used as the program name' }
  const redirections = seg.redirections || []
  const fileWrites = redirections.filter((r) => r.isWrite === true)
  if (seg.program === '') {
    if (fileWrites.length > 0) return { kind: 'mutating', reason: 'writes to ' + fileWrites.map((r) => r.target).join(', ') }
    if (seg.keywordOnly) return { kind: 'read-only', reason: 'shell keyword' }
    return { kind: 'read-only', reason: redirections.length > 0 ? 'redirection only' : 'shell assignment' }
  }
  const stripped = stripWrappers(seg.program, seg.args)
  const program = stripped.program
  const args = stripped.args
  const name = program.split('/').pop().replace(/\.exe$/i, '')

  if (OPAQUE_PROGRAMS.includes(name)) return { kind: 'opaque', reason: name + ' runs text or files we cannot inspect' }
  if (SHELLS.includes(name)) {
    if (seg.piped) return { kind: 'dangerous', reason: 'piped into a shell' }
    if (args.some((a) => a === '-c' || a.startsWith('-c'))) return { kind: 'opaque', reason: 'shell -c' }
    if (args.some((a) => VERSION_FLAGS.includes(a))) return { kind: 'read-only', reason: name + ' (version)' }
    return { kind: 'opaque', reason: 'shell interpreting a file or stdin' }
  }

  const rm = rmInfo(name, args)
  if (rm !== null) {
    if (rm.rootish) return { kind: 'catastrophic', reason: 'recursive delete of root or home' }
    return { kind: 'dangerous', reason: 'recursive delete' }
  }
  if (name.startsWith('mkfs') || name === 'diskpart' || name === 'format' || name === 'bcdedit') return { kind: 'catastrophic', reason: 'disk or boot level command' }
  if (name === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) return { kind: 'catastrophic', reason: 'writing to a raw device' }
  if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name)) return { kind: 'catastrophic', reason: 'shutting the machine down' }
  if (name === 'vssadmin' && args.includes('delete')) return { kind: 'catastrophic', reason: 'deleting shadow copies' }
  if (name === 'reg' && args[0] === 'delete' && args.some((a) => /HKLM/i.test(a))) return { kind: 'catastrophic', reason: 'deleting HKLM registry keys' }
  if (name === 'cipher' && args.includes('/w')) return { kind: 'catastrophic', reason: 'wiping free space' }
  if (redirections.some((r) => /^\/dev\/(sd|hd|nvme)/.test(r.target || ''))) return { kind: 'catastrophic', reason: 'writing to a raw device' }

  if (name === 'git' && args[0] === 'push' && (args.includes('--force') || args.includes('-f'))) return { kind: 'dangerous', reason: 'git push --force' }
  if (name === 'git' && args[0] === 'reset' && args.includes('--hard')) return { kind: 'dangerous', reason: 'git reset --hard' }
  if (name === 'git' && args[0] === 'clean' && args.some((a) => /^-[a-z]*[fdx]/.test(a))) return { kind: 'dangerous', reason: 'git clean -fdx' }
  if (name === 'npm' && ['publish', 'unpublish'].includes(args[0])) return { kind: 'dangerous', reason: 'npm publish' }
  if (['chmod', 'chown'].includes(name) && args.some((a) => /^-[a-z]*R/.test(a))) return { kind: 'dangerous', reason: 'recursive permission change' }
  if (['schtasks', 'sc', 'systemctl', 'service'].includes(name)) return { kind: 'dangerous', reason: 'changing a scheduled task or service' }
  if (name === 'reg' && args[0] === 'add') return { kind: 'dangerous', reason: 'adding registry entries' }
  if (redirections.some((r) => /(\.bashrc|\.bash_profile|\.profile$|authorized_keys|\.ssh[\/\\])/.test(r.target || ''))) return { kind: 'dangerous', reason: 'writing to a shell profile or ssh keys' }
  if (fileWrites.length > 0) return { kind: 'mutating', reason: 'writes to ' + fileWrites.map((r) => r.target).join(', ') }

  const project = projectMatch(name, args, ctx.cwd)
  if (project !== null) return { kind: 'project', reason: 'project entry: ' + project }

  const readOnly = readOnlyMatch(name, args)
  if (readOnly !== null) return { kind: 'read-only', reason: readOnly }

  if (MUTATING.includes(name)) return { kind: 'mutating', reason: name + ' changes state' }
  return { kind: 'unknown', reason: 'not a program we vouch for: ' + name }
}

/** Classify a raw command string. Returns { tier, reasons, segments, opaque }. */
export function evaluateCommand(command, options) {
  const ctx = { cwd: (options && options.cwd) || process.cwd() }
  const parsed = parseCommand(command)
  const reasons = []
  const kinds = []
  const seen = new Set()
  const push = (kind, reason) => {
    kinds.push(kind)
    if (!seen.has(reason)) { seen.add(reason); reasons.push(reason) }
  }
  if (/:\s*\(\s*\)\s*\{/.test(String(command || ''))) push('catastrophic', 'fork bomb')
  for (const seg of parsed.segments) {
    const verdict = classifySegment(seg, ctx)
    push(verdict.kind, verdict.reason)
  }
  for (const item of parsed.opaque) {
    push('opaque', item)
  }
  const tier = kinds.includes('catastrophic') ? 'catastrophic'
    : kinds.includes('dangerous') ? 'dangerous'
    : (kinds.includes('opaque') || kinds.includes('unknown') || kinds.includes('mutating')) ? 'ask-required'
    : kinds.includes('project') ? 'project'
    : 'read-only'
  return { tier, reasons, opaque: parsed.opaque, segments: parsed.segments }
}

export function currentStance() {
  const raw = String(process.env.GITBASH_MCP_RISKY || '').trim().toLowerCase()
  return raw === 'allow' ? 'allow' : 'ask'
}

/**
 *   'allow'        run it: everything is read-only or a project entry
 *   'allow-risky'  run it although it is not vouched for (stance = allow)
 *   'ask-required' blocked: the model must ask the human
 *   'deny'         catastrophic: blocked outright
 */
export function decide(command, options) {
  const stance = currentStance()
  const verdict = evaluateCommand(command, options)
  const tier = verdict.tier
  if (tier === 'read-only' || tier === 'project') {
    return { decision: 'allow', tier, reason: verdict.reasons.join('; '), matched: verdict.reasons, stance }
  }
  if (stance === 'allow') {
    return { decision: 'allow-risky', tier, reason: verdict.reasons.join('; '), matched: verdict.reasons, stance }
  }
  return { decision: tier === 'catastrophic' ? 'deny' : 'ask-required', tier, reason: verdict.reasons.join('; '), matched: verdict.reasons, stance }
}

// The `//x` escape (`//c` = a literal `/c`) only means that while MSYS path
// conversion is ON; this server turns conversion off by default. Other programs
// then just reject the argument, but cmd.exe ignores the switch and waits for
// stdin - a silent hang, so cmd gets a hard error and the rest a warning.
const FLAG_ESCAPE_RE = /^\/\/[A-Za-z]{1,4}$/
const SINGLE_SWITCH_RE = /^\/[A-Za-z]$/
const CMD_FAMILY = ['cmd']
const PRINTS_ARGS = ['echo', 'printf', 'print', 'cat', 'tee']

/**
 * `//x`-style arguments that do not mean what the writer thinks.
 * Returns [{ severity: 'error'|'warning', program, arg }], deduplicated.
 */
export function pathconvAdvice(command, options) {
  const conversionOn = !!(options && options.conversionOn)
  const found = []
  const seen = new Set()
  for (const seg of parseCommand(command).segments) {
    const name = String(seg.program || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase()
    if (name === '') continue
    const isCmd = CMD_FAMILY.includes(name)
    for (let idx = 0; idx < seg.args.length; idx++) {
      const arg = seg.args[idx]
      const switchPosition = idx === 0
      let severity = null
      if (!conversionOn && FLAG_ESCAPE_RE.test(arg)) {
        // Only the switch position: `cmd /c echo //c` is passing data around.
        if (isCmd) severity = switchPosition ? 'error' : null
        else if (switchPosition && !PRINTS_ARGS.includes(name)) severity = 'warning'
      } else if (conversionOn && isCmd && SINGLE_SWITCH_RE.test(arg)) {
        severity = switchPosition ? 'error' : null
      }
      if (severity === null) continue
      const key = severity + '|' + name + '|' + arg
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ severity, program: name, arg })
    }
  }
  return found
}

/** One-line, actionable text for one pathconvAdvice entry. */
export function describePathconv(item) {
  const fix = item.arg.replace(/^\/\//, '/')
  if (item.severity === 'error') {
    return '`' + item.arg + '` is the MSYS path-conversion escape for `' + fix + '`, and it only means that while path conversion is ON. ' +
      'This call runs bash with conversion off, so ' + item.program + '.exe receives `' + item.arg + '` literally: it ignores the switch, prints its banner and waits for stdin, ' +
      'and the call would hang until its timeout. Write `' + item.program + ' ' + fix + '` instead, or pass env {"MSYS_NO_PATHCONV": ""} to restore conversion for this call.'
  }
  return '`' + item.arg + '` looks like the MSYS path-conversion escape for `' + fix + '`, but conversion is off for this call, so ' + item.program + ' receives it literally and will reject it. ' +
    'Use `' + fix + '`, or pass env {"MSYS_NO_PATHCONV": ""} if you really need the old rewriting.'
}

/** Text report for the policy tool. */
export function describePolicy() {
  const stance = currentStance()
  const lines = []
  lines.push('gitbash-mcp command policy (capability classification)')
  lines.push('')
  lines.push('stance        : ' + stance + '  (GITBASH_MCP_RISKY=' + (process.env.GITBASH_MCP_RISKY || 'unset') + ')')
  lines.push('to change it  : set GITBASH_MCP_RISKY=allow in the MCP client env, then restart the server')
  lines.push('')
  lines.push('how a command is judged (not a regex denylist):')
  lines.push('  1. parse it into simple commands (quotes resolved, pipelines split)')
  lines.push('  2. allow  - every segment is read-only, or a script the project itself declares')
  lines.push('  3. ask    - mutating, unknown, or opaque (command substitution, variable program, shell -c, source)')
  lines.push('  4. deny   - catastrophic (disk, boot, rm -rf on root or home, fork bomb)')
  lines.push('')
  lines.push('read-only programs (' + READ_ONLY.length + '): ' + READ_ONLY.join(' '))
  lines.push('read-only git subcommands (' + GIT_READ_ONLY.length + '): ' + GIT_READ_ONLY.join(' '))
  lines.push('project entry points: package.json scripts, Makefile targets, justfile recipes,')
  lines.push('  cargo build/test/run/check/clippy/bench/doc, go build/test/run/vet/generate, ' + PROJECT_TOOLS.join(' '))
  lines.push('')
  lines.push('This reduces accidents; it is not a security boundary. Anything the classifier')
  lines.push('cannot vouch for is sent to the human, but a determined command can still hide.')
  lines.push('Real isolation belongs in the OS (a low-privilege account, container or VM).')
  return lines.join('\n')
}

export const lists = {
  readOnly: READ_ONLY,
  gitReadOnly: GIT_READ_ONLY,
  shells: SHELLS,
  mutating: MUTATING,
  projectTools: PROJECT_TOOLS,
}
