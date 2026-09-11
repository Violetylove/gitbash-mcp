// Command policy: three tiers of "how bad is this", one human stance.
//
//   tier 'safe'          nothing matched
//   tier 'suspicious'    allowed, audited, and flagged in the result
//   tier 'dangerous'     blocked under the default stance ('ask')
//   tier 'catastrophic'  blocked under 'ask'
//
// The single stance switch is GITBASH_MCP_RISKY: 'ask' (default) or 'allow'.
// There is deliberately NO in-band approval code: the model holds the same
// shell, so anything it could present as approval it could also have forged.
// The only unspoofable consent is the MCP launch configuration (set by the
// human in their MCP client), which is why the stance is read there.
//
// Honest limit: these are regex heuristics over the raw command text. They are
// speed bumps that reduce accidents and obvious abuse. They are NOT a security
// boundary - quoting, $IFS, base64 and other interpreters all get around them.

const CATASTROPHIC = [
  ['mkfs', /\bmkfs(\.\w+)?\b/i],
  ['format drive', /\bformat\s+[a-z]:/i],
  ['diskpart', /\bdiskpart\b/i],
  ['dd to device', /\bdd\b[^\n]*\bof=\/dev\//i],
  ['fork bomb', /:\s*\(\s*\)\s*\{[^\n]*\}\s*;\s*:/],
  ['shutdown or reboot', /\b(shutdown|reboot|halt|poweroff)\b/i],
  ['boot config edit', /\bbcdedit\b/i],
  ['shadow copy delete', /\bvssadmin\b[^\n]*\bdelete\b/i],
  ['registry HKLM delete', /\breg\s+delete\b[^\n]*\bHKLM\b/i],
  ['wipe free space', /\bcipher\s+\/w/i],
  ['write to raw device', />\s*\/dev\/(sd|hd|nvme)/i],
]

const DANGEROUS = [
  ['git push --force', /\bgit\s+push\b[^\n]*(--force\b|\s-f(\s|$))/i],
  ['git reset --hard', /\bgit\s+reset\s+--hard\b/i],
  ['git clean -fdx', /\bgit\s+clean\b[^\n]*\s-[a-z]*[fdx]/i],
  ['remote script piped to shell', /\b(curl|wget)\b[^\n|]*\|\s*(ba|z|k|da)?sh\b/i],
  ['publish package', /\bnpm\s+(publish|unpublish)\b/i],
  ['recursive chmod or chown', /\b(chmod|chown)\s+[^\n]*-[a-z]*R[a-z]*\b/i],
  ['shell rc or ssh key write', />>?\s*[^\n]*(\.bashrc|\.bash_profile|\.profile\b|authorized_keys|\.ssh\/)/i],
  ['scheduled task or service', /\b(schtasks|sc\s+(create|delete)|reg\s+add)\b/i],
]

const SUSPICIOUS = [
  ['eval', /\beval\b/i],
  ['base64 decode piped', /\bbase64\b[^\n|]*\|\s*\w+/i],
  ['/dev/tcp', /\/dev\/tcp\//i],
  ['netcat', /\b(nc|ncat|netcat)\b/i],
  ['environment piped out', /\b(env|printenv)\b[^\n|]*\|/i],
  ['curl posting data', /\bcurl\b[^\n]*\s(-d|--data)\b/i],
]

const TIERS = [
  ['catastrophic', CATASTROPHIC],
  ['dangerous', DANGEROUS],
  ['suspicious', SUSPICIOUS],
]

const RM_CALL_RE = /(?:^|[;&|]\s*|\bsudo\s+)\brm\b([^\n;&|]*)/gi

/**
 * rm is the case that matters most, and flag order ('rm -rf' / 'rm -fr' /
 * 'rm --recursive -f') makes a single regex unreliable - so it is parsed:
 * collect the invocation's flags and its first operand.
 */
function checkRm(text) {
  const hits = []
  let match
  RM_CALL_RE.lastIndex = 0
  while ((match = RM_CALL_RE.exec(text)) !== null) {
    const tokens = String(match[1] || '').trim().split(/\s+/).filter(Boolean)
    const flags = tokens.filter((t) => t.startsWith('-'))
    const operands = tokens.filter((t) => !t.startsWith('-'))
    const recursive = flags.some((f) => /^-[a-z]*r/i.test(f)) || flags.includes('--recursive')
    if (!recursive) continue
    const target = operands[0] || ''
    const rootish = target === '/' || target === '/*' || target === '~' || target === '~/' || target.startsWith('~/') || /^\/\*?$/.test(target)
    if (rootish) hits.push({ tier: 'catastrophic', rule: 'recursive delete of root or home' })
    else hits.push({ tier: 'dangerous', rule: 'recursive delete' })
  }
  return hits
}

/** Highest tier matched by the raw command, plus every rule that matched. */
export function evaluateCommand(command) {
  const text = String(command || '')
  const matched = checkRm(text)
  for (const entry of TIERS) {
    const tier = entry[0]
    for (const rule of entry[1]) {
      if (rule[1].test(text)) matched.push({ tier, rule: rule[0] })
    }
  }
  let tier = 'safe'
  for (const name of ['catastrophic', 'dangerous', 'suspicious']) {
    if (matched.some((m) => m.tier === name)) { tier = name; break }
  }
  return { tier, matched }
}

/** The human's stance. Unknown or unset values fall back to the safe default. */
export function currentStance() {
  const raw = String(process.env.GITBASH_MCP_RISKY || '').trim().toLowerCase()
  return raw === 'allow' ? 'allow' : 'ask'
}

/**
 *   'allow'        run it (safe, or only suspicious)
 *   'allow-risky'  run it although it is dangerous/catastrophic (stance=allow)
 *   'ask-required' dangerous: blocked, the model must ask the human
 *   'deny'         catastrophic: blocked outright
 */
export function decide(command) {
  const stance = currentStance()
  const verdict = evaluateCommand(command)
  const tier = verdict.tier
  if (tier === 'safe' || tier === 'suspicious') {
    return { decision: 'allow', tier, matched: verdict.matched, stance }
  }
  if (stance === 'allow') {
    return { decision: 'allow-risky', tier, matched: verdict.matched, stance }
  }
  return { decision: tier === 'catastrophic' ? 'deny' : 'ask-required', tier, matched: verdict.matched, stance }
}

/** Text report used by the policy tool. */
export function describePolicy() {
  const stance = currentStance()
  const lines = []
  lines.push('gitbash-mcp command policy')
  lines.push('')
  lines.push('stance        : ' + stance + '  (GITBASH_MCP_RISKY=' + (process.env.GITBASH_MCP_RISKY || 'unset') + ')')
  lines.push('to allow risky: set GITBASH_MCP_RISKY=allow in the MCP client env, then restart the server')
  lines.push('')
  lines.push('what each tier does under this stance:')
  lines.push('  catastrophic : ' + (stance === 'allow' ? 'ALLOWED + audited' : 'BLOCKED (error_code POLICY_DENIED)'))
  lines.push('  dangerous    : ' + (stance === 'allow' ? 'ALLOWED + audited' : 'BLOCKED (error_code APPROVAL_REQUIRED - ask the human)'))
  lines.push('  suspicious   : allowed, audited, flagged in the result')
  lines.push('')
  lines.push('rm is parsed structurally; everything else is a regex:')
  for (const entry of TIERS) {
    lines.push(entry[0] + ' rules (' + entry[1].length + '):')
    for (const rule of entry[1]) lines.push('  - ' + rule[0] + '  ' + String(rule[1]))
  }
  lines.push('  - recursive delete of root or home  (structural rm check -> catastrophic)')
  lines.push('  - recursive delete                   (structural rm check -> dangerous)')
  lines.push('')
  lines.push('These are heuristics, not a security boundary: quoting tricks, $IFS, base64')
  lines.push('and other interpreters can bypass them. Real isolation belongs in the OS.')
  return lines.join('\n')
}

export const counts = {
  catastrophic: CATASTROPHIC.length + 1,
  dangerous: DANGEROUS.length + 1,
  suspicious: SUSPICIOUS.length,
}
