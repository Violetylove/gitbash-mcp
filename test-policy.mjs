// Policy tests for model D: parser, capability classification, project trust,
// stance decisions and the report. Run: node test-policy.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCommand } from './lib/shell-parse.js'
import { evaluateCommand, decide, currentStance, describePolicy, lists } from './lib/policy.js'

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
]

console.log('== capability classification (' + CASES.length + ' cases) ==')
let bad = 0
for (const entry of CASES) {
  const got = evaluateCommand(entry[0]).tier
  if (got !== entry[1]) { bad++; console.log('FAIL  expected ' + entry[1] + ', got ' + got + '  <- ' + entry[0]) }
}
assert(bad === 0, 'every command lands in the expected tier', bad + ' mismatches')

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