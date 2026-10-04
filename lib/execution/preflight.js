// Execution preflight shared by admission and foreground launch.
import { statSync } from 'node:fs'
import { baseResult } from './results.js'

export function directoryFailure(cwd) {
  let reason
  try {
    if (statSync(cwd).isDirectory()) return null
    reason = 'The working directory path is not a directory.'
  } catch (error) {
    reason = ['ENOENT', 'ENOTDIR'].includes(error.code)
      ? 'The working directory does not exist.'
      : 'The working directory cannot be accessed (' + (error.code || 'unknown error') + ').'
  }
  return Object.assign(baseResult(), {
    error_code: 'INVALID_CWD', cwd,
    stderr: reason + ' cwd: ' + cwd,
    hint: 'Set cwd to an existing, accessible directory. The command was not started.',
  })
}
