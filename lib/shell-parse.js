// Minimal shell command parser: enough structure to judge capability.
// It is NOT a full POSIX parser. It resolves quotes and escapes, splits the
// command into simple-command segments on operators, records write
// redirections, and flags the constructs it cannot reason about (command
// substitution, variable programs, sourcing files). Anything flagged opaque is
// treated as "ask the human" by the policy layer.

const BACKTICK = String.fromCharCode(96)

const OPERATORS = ['&&', '||', '>>', '2>>', '&>', '<<<', '<<', '2>', '1>', '|', ';', '&', '\n', '>', '<', '(', ')']

function matchOperator(s, i) {
  for (const op of OPERATORS) {
    if (s.startsWith(op, i)) return op
  }
  return null
}

/** Index just past the ')' that closes the '(' at openIndex. */
function skipBalanced(s, openIndex) {
  let depth = 0
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      while (i < s.length && s[i] !== quote) { if (s[i] === '\\' && quote === '"') i++; i++ }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i + 1 }
  }
  return s.length
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*/

/** Read one word starting at i; resolves quotes and reports $ usage. */
function readWord(s, i) {
  let value = ''
  let hasVar = false
  let substitution = null
  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break
    if ('|;&<>()'.includes(ch)) break
    if (ch === '\\') { value += s[i + 1] === undefined ? '' : s[i + 1]; i += 2; continue }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      const stop = end === -1 ? s.length : end
      value += s.slice(i + 1, stop)
      i = stop + 1
      continue
    }
    if (ch === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && ['"', '\\', '$', BACKTICK].includes(s[i + 1])) { value += s[i + 1]; i += 2; continue }
        if (s[i] === '$' && s[i + 1] === '(') { substitution = 'command substitution'; hasVar = true; i = skipBalanced(s, i + 1); continue }
        if (s[i] === '$' || s[i] === BACKTICK) { hasVar = true }
        value += s[i]
        i++
      }
      i++
      continue
    }
    if (ch === '$') {
      if (s[i + 1] === "'") {
        const end = s.indexOf("'", i + 2)
        const stop = end === -1 ? s.length : end + 1
        substitution = 'ansi-c quoting'
        hasVar = true
        value += s.slice(i, stop)
        i = stop
        continue
      }
      if (s[i + 1] === '(') { substitution = 'command substitution'; hasVar = true; i = skipBalanced(s, i + 1); continue }
      if (s[i + 1] === '{') {
        const end = s.indexOf('}', i + 2)
        const stop = end === -1 ? s.length : end + 1
        value += s.slice(i, stop)
        hasVar = true
        i = stop
        continue
      }
      const m = VAR_NAME.exec(s.slice(i + 1))
      if (m) { value += '$' + m[0]; hasVar = true; i += 1 + m[0].length; continue }
      value += '$'
      i++
      continue
    }
    if (ch === BACKTICK) {
      const end = s.indexOf(BACKTICK, i + 1)
      const stop = end === -1 ? s.length : end + 1
      substitution = 'command substitution'
      hasVar = true
      value += s.slice(i, stop)
      i = stop
      continue
    }
    value += ch
    i++
  }
  return { value, next: i, hasVar, substitution }
}

function newSegment() {
  return { words: [], redirections: [], piped: false }
}

function finishSegment(raw) {
  const assignments = []
  let index = 0
  while (index < raw.words.length) {
    const head = VAR_NAME.exec(raw.words[index].value)
    if (head === null || raw.words[index].value[head[0].length] !== '=') break
    assignments.push(raw.words[index].value)
    index++
  }
  const rest = raw.words.slice(index)
  const first = rest[0]
  return {
    assignments,
    words: raw.words.map((w) => w.value),
    program: first === undefined ? '' : first.value,
    programHasVar: first === undefined ? false : first.hasVar,
    args: rest.slice(1).map((w) => w.value),
    piped: raw.piped,
    redirections: raw.redirections,
  }
}

/**
 * Split a command line into simple-command segments.
 * Returns { segments, opaque, writes } where opaque lists constructs the policy
 * layer must treat as unknown, and writes lists redirection targets.
 */
export function parseCommand(text) {
  const source = String(text || '')
  const segments = []
  const opaque = []
  const writes = []
  let segment = newSegment()
  const pushSegment = () => {
    if (segment.words.length > 0 || segment.redirections.length > 0) segments.push(finishSegment(segment))
    segment = newSegment()
  }
  let pendingDocs = []
  // A here-doc body is DATA for the consumer, not a list of commands: skip it
  // verbatim (a body containing 'rm -rf /' must not be read as a command).
  const skipHereDocs = () => {
    for (const doc of pendingDocs) {
      let found = false
      while (i < source.length) {
        const lineEnd = source.indexOf('\n', i)
        const line = lineEnd === -1 ? source.slice(i) : source.slice(i, lineEnd)
        const text = doc.stripTabs ? line.replace(/^\t+/, '') : line
        i = lineEnd === -1 ? source.length : lineEnd + 1
        if (text === doc.delimiter) { found = true; break }
      }
      if (!found) opaque.push('unterminated here-doc')
    }
    pendingDocs = []
  }
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    const op = matchOperator(source, i)
    if (op !== null) {
      if (op === '>' || op === '>>' || op === '2>' || op === '2>>' || op === '&>') {
        const redir = { kind: op.startsWith('2') ? 'stderr' : 'stdout', append: op.includes('>>') }
        i += op.length
        while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
        const target = readWord(source, i)
        redir.target = target.value
        if (target.value !== '') writes.push(target.value)
        segment.redirections.push(redir)
        i = target.next
        continue
      }
      if (op === '<<' || op === '<<-') {
        i += op.length
        while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
        const target = readWord(source, i)
        i = target.next
        pendingDocs.push({ delimiter: target.value.replace(/^['"]|['"]$/g, ''), stripTabs: op === '<<-' })
        continue
      }
      if (op === '<' || op === '<<<') {
        i += op.length
        while (i < source.length && (source[i] === ' ' || source[i] === '\t')) i++
        const target = readWord(source, i)
        i = target.next
        continue
      }
      if (op === '(' || op === ')') { opaque.push('subshell'); i += op.length; pushSegment(); continue }
      if (op === '|') { pushSegment(); segment.piped = true; i += op.length; continue }
      pushSegment()
      if (op === '\n' && pendingDocs.length > 0) skipHereDocs()
      i += op.length
      continue
    }
    const word = readWord(source, i)
    if (word.substitution !== null) opaque.push(word.substitution)
    segment.words.push({ value: word.value, hasVar: word.hasVar })
    i = word.next
  }
  pushSegment()
  if (pendingDocs.length > 0) { skipHereDocs(); opaque.push('here-doc without a terminating newline') }
  return { segments, opaque, writes }
}
