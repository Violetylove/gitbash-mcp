// Resolve and cache a session default cwd without coupling to the MCP server.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function createWorkspaceResolver(listRoots) {
  let defaultCwdPromise = null
  return function defaultCwd() {
    if (defaultCwdPromise === null) {
      defaultCwdPromise = (async () => {
        try {
          const roots = await Promise.race([
            listRoots(),
            new Promise((resolve) => { setTimeout(() => resolve(null), 2500) }),
          ])
          for (const root of (roots && roots.roots) || []) {
            try {
              const path = fileURLToPath(root.uri)
              if (path && existsSync(path)) return path
            } catch (e) { void e }
          }
        } catch (e) { void e }
        return process.cwd()
      })()
    }
    return defaultCwdPromise
  }

}
