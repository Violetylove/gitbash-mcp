// Append-only JSONL audit log: the answer to "what did the agent do to my
// machine". Best-effort writes; auditing failure must never break a call.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** State directory. Overridable in tests by pointing LOCALAPPDATA elsewhere. */
export function auditDir() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'gitbash-mcp')
}

export function auditPath() {
  return join(auditDir(), 'audit.jsonl')
}

/** Append one record. Returns false (and warns on stderr) when it cannot write. */
export function appendAudit(record) {
  try {
    mkdirSync(auditDir(), { recursive: true })
    appendFileSync(auditPath(), JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch (e) {
    console.error('[gitbash-mcp] audit write failed: ' + e.message)
    return false
  }
}

/** Read the last N records (oldest first). */
export function readAudit(limit) {
  const n = Math.max(1, limit || 20)
  try {
    if (!existsSync(auditPath())) return []
    const lines = readFileSync(auditPath(), 'utf8').split('\n').filter((l) => l.trim() !== '')
    return lines.slice(-n).map((l) => {
      try { return JSON.parse(l) } catch (e) { return { raw: l } }
    })
  } catch (e) {
    return []
  }
}
