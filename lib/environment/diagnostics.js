// Bash information used by the MCP diagnostic tool.
import { detectBash, missingBashResult } from './detect.js'
import { spawnBash } from '../execution/runner.js'

export async function bashInfo() {
  const d = detectBash()
  if (!d.bashPath) {
    return missingBashResult(d).stderr
  }
  const r = await spawnBash(d.bashPath, 'bash --version | head -1; git --version; echo HOME=$HOME; echo PWD=$PWD; echo MSYSTEM=$MSYSTEM', { timeoutMs: 15000 })
  return 'bash: ' + d.bashPath + '\n' + r.stdout + r.stderr
}
