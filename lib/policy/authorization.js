// Current execution authorization: classify commands and describe blocked calls.
// The execution service consumes this result before starting a process.
import { decide } from './index.js'
import { baseResult } from '../execution/results.js'

function policyLine(verdict) {
  if (verdict.decision === 'allow') return 'allow'
  return verdict.decision + ' (' + verdict.tier + ', stance=' + verdict.stance + ', see the policy tool)'
}

export function authorizeCommand(command, { cwd }) {
  const verdict = decide(command, { cwd })
  const policy = policyLine(verdict)
  if (verdict.decision !== 'deny' && verdict.decision !== 'ask-required') {
    return { verdict, policy, rejection: null }
  }
  const matchedRules = verdict.matched
  const lines = []
  lines.push(verdict.decision === 'deny'
    ? 'Blocked by the command policy (this tier is never run at the current stance).'
    : 'Blocked by the command policy: this needs the user to decide.')
  lines.push('tier: ' + verdict.tier + '   stance: GITBASH_MCP_RISKY=' + verdict.stance)
  lines.push('why : ' + verdict.reason)
  if (matchedRules.length > 0) lines.push('matched: ' + matchedRules.join(', '))
  lines.push('')
  lines.push('Ask the user how to proceed. Their options:')
  lines.push('  1. run the command themselves in their own terminal')
  lines.push('  2. ask for a safer equivalent command')
  lines.push('  3. allow risky commands by setting GITBASH_MCP_RISKY=allow in this MCP server config, then restart the server')
  const payload = Object.assign(baseResult(), {
    stderr: lines.join(String.fromCharCode(10)),
    error_code: verdict.decision === 'deny' ? 'POLICY_DENIED' : 'APPROVAL_REQUIRED',
    category: verdict.tier,
    reason: verdict.reason,
    matched_rules: matchedRules,
    hint: lines[0],
  })

  return { verdict, policy, rejection: payload }
}
