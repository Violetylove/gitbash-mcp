// git-bash detection and environment diagnosis, shared by the MCP server and CLI.
// Nothing here throws on a missing bash: callers get a report and fix instructions.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnBash } from './runner.js'

export const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win'

/** Resolve an executable name through PATH + PATHEXT (never throws). */
export function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(';').filter(Boolean)
  const exts = ['']
  if (!/\.[a-z0-9]+$/i.test(name)) {
    for (const e of (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')) if (e) exts.push(e)
  }
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Candidate bash locations in priority order; nothing needs to exist. */
export function buildBashCandidates() {
  const list = []
  const envVal = process.env.GITBASH_BASH
  if (envVal) list.push({ label: 'GITBASH_BASH env', path: envVal })
  list.push({ label: 'PATH (bash)', pathLookup: 'bash' })
  const roots = [
    [process.env.ProgramFiles, ['Git', 'bin', 'bash.exe']],
    [process.env.ProgramFiles, ['Git', 'usr', 'bin', 'bash.exe']],
    [process.env['ProgramFiles(x86)'], ['Git', 'bin', 'bash.exe']],
    [process.env.LOCALAPPDATA, ['Programs', 'Git', 'bin', 'bash.exe']],
    [process.env.USERPROFILE, ['scoop', 'shims', 'bash.exe']],
    ['C:', ['msys64', 'usr', 'bin', 'bash.exe']],
    ['C:', ['cygwin64', 'bin', 'bash.exe']],
  ]
  for (const entry of roots) {
    const root = entry[0]
    const parts = entry[1]
    if (!root) continue
    const full = join.apply(null, [root].concat(parts))
    list.push({ label: full, path: full })
  }
  return list
}

let cache = null

/** Detect git-bash once (cached). Returns a report object; never throws. */
export function detectBash(force) {
  if (cache && !force) return cache
  const candidates = buildBashCandidates().map((c) => {
    if (c.pathLookup) return { label: c.label, resolved: findOnPath(c.pathLookup) }
    return { label: c.label, resolved: existsSync(c.path) ? c.path : null }
  })
  const hit = candidates.find((c) => c.resolved)
  const envValue = process.env.GITBASH_BASH || null
  cache = {
    candidates: candidates,
    bashPath: hit ? hit.resolved : null,
    source: hit ? hit.label : null,
    envValue: envValue,
    envValid: !!(envValue && existsSync(envValue)),
  }
  return cache
}

/** Structured BASH_NOT_FOUND result carrying the fix instructions. */
export function missingBashResult(d) {
  const lines = []
  lines.push('git-bash (MSYS2 bash) was not found on this machine, so bash commands cannot run.')
  lines.push('Fix (either one), then restart the MCP server:')
  lines.push('  1. Install Git for Windows (it includes git-bash): ' + GIT_FOR_WINDOWS_URL)
  lines.push('  2. Set GITBASH_BASH to your bash.exe, e.g. GITBASH_BASH=C:/Program Files/Git/bin/bash.exe')
  if (d.envValue && !d.envValid) {
    lines.push('Note: GITBASH_BASH is set to "' + d.envValue + '" but that file does not exist.')
  }
  lines.push('Run the doctor tool for the full detection report.')
  return {
    exit_code: -1,
    stdout: '',
    stderr: lines.join('\n'),
    timed_out: false,
    truncated: false,
    spill_path: null,
    error_code: 'BASH_NOT_FOUND',
    hint: lines[0],
  }
}

/** Full environment diagnosis (used by the doctor tool and the CLI). */
export async function doctorReport() {
  const d = detectBash(true)
  const lines = []
  lines.push('gitbash-mcp doctor')
  lines.push('platform : ' + process.platform + ' ' + process.arch)
  lines.push('runtime  : ' + (process.versions.bun ? 'bun ' + process.versions.bun : 'node ' + process.version))
  lines.push('execPath : ' + process.execPath)
  lines.push('')
  lines.push('GITBASH_BASH : ' + (d.envValue ? d.envValue + (d.envValid ? ' (valid)' : ' (INVALID: file not found)') : '(unset)'))
  lines.push('bash         : ' + (d.bashPath ? 'FOUND ' + d.bashPath : 'NOT FOUND'))
  if (d.bashPath) lines.push('bash source  : ' + d.source)
  lines.push('git on PATH  : ' + (findOnPath('git') || 'NOT FOUND'))
  if (d.bashPath) {
    const probe = await spawnBash(d.bashPath, 'bash --version | head -1; git --version; echo MSYSTEM=$MSYSTEM; echo HOME=$HOME', { timeoutMs: 15000 })
    const text = (probe.stdout + probe.stderr).trim()
    lines.push('probe        : ' + (text || '(no output)'))
  }
  lines.push('')
  lines.push('candidate scan:')
  for (const c of d.candidates) {
    lines.push('  [' + (c.resolved ? 'ok  ' : 'miss') + '] ' + c.label + (c.resolved && c.resolved !== c.label ? '  -> ' + c.resolved : ''))
  }
  if (!d.bashPath) {
    lines.push('')
    lines.push('HOW TO FIX:')
    lines.push('  1. Install Git for Windows: ' + GIT_FOR_WINDOWS_URL)
    lines.push('  2. Or set GITBASH_BASH to your bash.exe path, then restart the MCP server.')
  }
  return lines.join('\n')
}
