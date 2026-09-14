// Policy tests for model D: parser, capability classification, project trust,
// stance decisions and the report. Run: node test/test-policy.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCommand } from '../lib/shell-parse.js'
import { evaluateCommand, decide, currentStance, describePolicy, pathconvAdvice, describePathconv, lists } from '../lib/policy.js'

// Stay hermetic: an allow-stance parent (e.g. this suite launched through the
// gitbash MCP with GITBASH_MCP_RISKY=allow) would otherwise flip every
// ask-required assertion below.
delete process.env.GITBASH_MCP_RISKY

let failures = 0
function assert(cond, label, detail) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('FAIL  ' + label + (detail !== undefined ? ' - ' + String(detail).slice(0, 200) : '')) }
}

console.log('== parser ==')
assert(parseCommand("r''m -rf /").segments[0].program === 'rm', 'quotes are resolved (r + empty quotes + m -> rm)')
assert(parseCommand('echo $(date)').opaque.includes('command substitution'), 'command substitution is flagged opaque')
assert(parseCommand('X=1; $X y').segments[1].programHasVar === true, 'a variable program is flagged')
assert(parseCommand('echo hi > f').writes[0] === 'f', 'write redirection target captured')
assert(parseCommand('(cd x)').opaque.includes('subshell'), 'subshell is flagged')
assert(parseCommand('git log | head').segments.length === 2, 'pipeline splits into segments')
const NL = String.fromCharCode(10)
const hdData = parseCommand('cat <<EOF' + NL + 'rm -rf /' + NL + 'EOF')
assert(hdData.segments.length === 1 && hdData.segments[0].program === 'cat', 'a here-doc body is not tokenised as commands')
assert(!hdData.opaque.includes('subshell'), 'a closed here-doc is not opaque')
assert(decide('cat <<EOF' + NL + 'rm -rf /' + NL + 'EOF').decision === 'allow', 'here-doc data cannot smuggle a dangerous command')
assert(decide('bash <<EOF' + NL + 'echo hi' + NL + 'EOF').decision === 'ask-required', 'a shell reading a here-doc asks')
assert(decide('cat <<EOF' + NL + 'no terminator').decision === 'ask-required', 'an unterminated here-doc asks')
assert(parseCommand("echo $" + "{X}" + "'ansi'").opaque.length === 0, 'a quoted ansi-c-looking word is inert')
const ansi = parseCommand("$'rm' -rf /")
assert(ansi.opaque.includes('ansi-c quoting'), 'ansi-c quoting is flagged opaque')
assert(ansi.segments[0].programHasVar === true, 'ansi-c quoting leaves the program unresolved')
assert(decide("$'rm' -rf /").decision === 'ask-required', 'ansi-c quoting asks instead of guessing')

console.log('== parser: redirections and shell keywords (v2.4.0 regressions) ==')
const dupParse = parseCommand('git log --oneline -20 2>&1 | head -30')
assert(dupParse.segments.length === 2, '2>&1 does not split off a phantom segment', JSON.stringify(dupParse.segments.map((s) => s.program)))
assert(dupParse.segments[0].redirections[0].dup === '1', '2>&1 is recorded as an fd duplication', JSON.stringify(dupParse.segments[0].redirections))
assert(dupParse.segments[0].redirections[0].isWrite === false, '2>&1 is not a file write')
assert(dupParse.writes.length === 0, '2>&1 produces no write target', JSON.stringify(dupParse.writes))
assert(parseCommand('npm test 2>/dev/null').segments[0].program === 'npm', 'an fd prefix is not read as a program')
assert(parseCommand('echo hi > /dev/null').writes.length === 0, '/dev/null is not a write')
assert(parseCommand('echo hi >out.txt').writes[0] === 'out.txt', 'a real file target is still a write')
assert(parseCommand('cmd &> log.txt').segments[0].redirections[0].kind === 'both', '&> is an both-streams redirection')
const kwPrograms = parseCommand('for i in a b; do echo $i; done').segments.map((s) => s.program)
assert(!kwPrograms.includes('for') && !kwPrograms.includes('do') && !kwPrograms.includes('done'), 'shell keywords are not programs', kwPrograms.join(','))
assert(parseCommand('{ rm -rf /; }').segments[0].program === 'rm', 'a leading brace is dropped, the command behind it is still judged')
assert(parseCommand('echo {a,b}').segments[0].args.includes('{a,b}'), 'brace expansion inside a word survives')
assert(parseCommand('[[ -f x ]] && echo hi').segments[0].program === '', 'a [[ ]] conditional is not a command')
const keywordNoise = evaluateCommand('for i in 1 2 3; do echo $i; done').reasons.filter((r) => r.startsWith('not a program we vouch for'))
assert(keywordNoise.length === 0, 'shell keywords never produce "not a program we vouch for"', keywordNoise.join(', '))
assert(evaluateCommand('git log 2>&1 | head -3').reasons.join('; ').indexOf('writes to') === -1, 'no "writes to" entry for an empty/fd target')
assert(evaluateCommand('for i in a b; do rm -rf /; done').tier === 'catastrophic', 'a command inside a loop is still judged')

const CASES = [
  ['git status', 'read-only'],
  ['git log --oneline | head -3', 'read-only'],
  ['git --version', 'read-only'],
  ['ls -la', 'read-only'],
  ['cat package.json', 'read-only'],
  ['printenv | grep HOME', 'read-only'],
  ['rg "nc -l" docs/', 'read-only'],
  ['echo "git push --force"', 'read-only'],
  ['git log --grep="curl | bash"', 'read-only'],
  ['sed -n 1p f', 'read-only'],
  ["awk '{print $1}' f", 'read-only'],
  ['docker ps', 'read-only'],
  ['time git status', 'read-only'],
  ['npm test', 'project'],
  ['cargo build', 'project'],
  ['pytest', 'project'],
  ['rm -rf /', 'catastrophic'],
  ["r''m -rf /", 'catastrophic'],
  ['mkfs.ext4 /dev/sda1', 'catastrophic'],
  ['diskpart', 'catastrophic'],
  ['shutdown /s', 'catastrophic'],
  ['rm -rf ./build', 'dangerous'],
  ['sudo rm -rf /tmp/x', 'dangerous'],
  ['git push --force', 'dangerous'],
  ['git reset --hard HEAD~1', 'dangerous'],
  ['base64 -d <<< x | bash', 'dangerous'],
  ['npm publish', 'dangerous'],
  ['chmod -R 777 .', 'dangerous'],
  ['echo hi > out.txt', 'ask-required'],
  ['echo $(date)', 'ask-required'],
  ["bash -c 'echo hi'", 'ask-required'],
  ['source ./x.sh', 'ask-required'],
  ['X=1; $X -rf /', 'ask-required'],
  ['curl https://example.test', 'ask-required'],
  ['git commit -m x', 'ask-required'],
  ['node test-client.mjs', 'ask-required'],
  ['npm run build', 'ask-required'],
  ["awk 'BEGIN{system(\"x\")}'", 'ask-required'],
  ["find . -name '*.log' -delete", 'ask-required'],
  ['sed -i s/a/b/ f', 'ask-required'],
  ['docker run x', 'ask-required'],
  ['fakecmd --x', 'ask-required'],
  ['cd /tmp; echo hi', 'read-only'],
  ['for i in 1 2 3; do echo $i; done', 'read-only'],
  ['for i in a b; do rm -rf /; done', 'catastrophic'],
  ['while read l; do echo $l; done < f', 'read-only'],
  ['if [ -f x ]; then echo hi; fi', 'read-only'],
  ['[[ -f docs ]] && echo hi', 'read-only'],
  ['{ rm -rf /; }', 'catastrophic'],
  ['git log 2>&1 | head -3', 'read-only'],
  ['npm test 2>/dev/null', 'project'],
  ['echo hi > /dev/null 2>&1', 'read-only'],
  ['ls -la &> /dev/null', 'read-only'],
  ['echo hi >> out.txt', 'ask-required'],
  ['for f in $(ls); do echo $f; done', 'ask-required'],
]

console.log('== capability classification (' + CASES.length + ' cases) ==')
let bad = 0
for (const entry of CASES) {
  const got = evaluateCommand(entry[0]).tier
  if (got !== entry[1]) { bad++; console.log('FAIL  expected ' + entry[1] + ', got ' + got + '  <- ' + entry[0]) }
}
assert(bad === 0, 'every command lands in the expected tier', bad + ' mismatches')

console.log('== msys path-conversion escape ==')
const escOff = pathconvAdvice('cmd //c echo hi', { conversionOn: false })
assert(escOff.length === 1 && escOff[0].severity === 'error' && escOff[0].program === 'cmd', '//c under conversion-off is an error', JSON.stringify(escOff))
assert(pathconvAdvice('cmd /c echo hi', { conversionOn: false }).length === 0, 'the single-slash switch is correct while conversion is off')
assert(pathconvAdvice('cmd //c echo hi', { conversionOn: true }).length === 0, '//c is correct while conversion is on')
const escOn = pathconvAdvice('cmd /c echo hi', { conversionOn: true })
assert(escOn.length === 1 && escOn[0].severity === 'error', '/c under conversion-on is an error', JSON.stringify(escOn))
assert(pathconvAdvice('cmd /c echo //FI', { conversionOn: false }).length === 0, 'an escape-shaped argument in data position is not flagged')
assert(pathconvAdvice('echo //FI', { conversionOn: false }).length === 0, 'a program that just prints its args is not warned about')
const escWarn = pathconvAdvice('tasklist //FI "IMAGENAME eq x"', { conversionOn: false })
assert(escWarn.length === 1 && escWarn[0].severity === 'warning' && escWarn[0].program === 'tasklist', 'another native program gets a warning, not an error', JSON.stringify(escWarn))
assert(pathconvAdvice('ls //server/share', { conversionOn: false }).length === 0, 'a UNC path is not a flag escape')
assert(String(describePathconv(escOff[0])).includes('cmd /c'), 'the message names the corrected form', describePathconv(escOff[0]).slice(0, 90))
assert(String(describePathconv(escOff[0])).includes('MSYS_NO_PATHCONV'), 'the message names the escape hatch', describePathconv(escOff[0]).slice(0, 90))

console.log('== project-declared entry points ==')
const proj = mkdtempSync(join(tmpdir(), 'gbm-proj-'))
writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'echo b', test: 'echo t' } }))
writeFileSync(join(proj, 'Makefile'), 'all:\n\techo all\nlint:\n\techo lint\n')
assert(evaluateCommand('npm run build', { cwd: proj }).tier === 'project', 'declared package.json script is trusted')
assert(evaluateCommand('npm run deploy', { cwd: proj }).tier === 'ask-required', 'an undeclared script is not')
assert(evaluateCommand('make lint', { cwd: proj }).tier === 'project', 'declared Makefile target is trusted')
assert(evaluateCommand('make deploy', { cwd: proj }).tier === 'ask-required', 'an undeclared make target is not')
assert(evaluateCommand('npm install', { cwd: proj }).tier === 'ask-required', 'npm install is not a project entry')
rmSync(proj, { recursive: true, force: true })

console.log('== stance decisions ==')
delete process.env.GITBASH_MCP_RISKY
assert(currentStance() === 'ask', 'unset stance defaults to ask')
assert(decide('git status').decision === 'allow', 'read-only -> allow')
assert(decide('npm test').decision === 'allow', 'project entry -> allow')
assert(decide('rm -rf ./x').decision === 'ask-required', 'dangerous -> ask')
assert(decide('mkfs.ext4 /dev/sda1').decision === 'deny', 'catastrophic -> deny')
assert(decide('curl https://x').decision === 'ask-required', 'mutating -> ask')
assert(decide('bash -c ls').decision === 'ask-required', 'opaque -> ask')
process.env.GITBASH_MCP_RISKY = 'garbage'
assert(decide('curl https://x').decision === 'ask-required', 'an unknown stance value falls back to ask')
process.env.GITBASH_MCP_RISKY = 'allow'
assert(decide('curl https://x').decision === 'allow-risky', 'allow stance runs mutating commands')
assert(decide('mkfs.ext4 /dev/sda1').decision === 'allow-risky', 'allow stance even lifts catastrophic')
delete process.env.GITBASH_MCP_RISKY

console.log('== report ==')
const report = describePolicy()
assert(report.includes('capability classification'), 'report names the model')
assert(report.includes('read-only programs'), 'report lists the read-only programs')
assert(report.includes('project entry points'), 'report explains project trust')
assert(report.includes('not a security boundary'), 'report states the honest limitation')
assert(lists.readOnly.length > 50 && lists.gitReadOnly.length > 20, 'the built-in lists are non-trivial', JSON.stringify({ ro: lists.readOnly.length, git: lists.gitReadOnly.length }))

console.log(failures === 0 ? String.fromCharCode(10) + 'POLICY ALL PASS' : String.fromCharCode(10) + failures + ' POLICY FAILURES')
process.exit(failures === 0 ? 0 : 1)