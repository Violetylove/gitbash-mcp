import { bashInfo } from '../../environment/diagnostics.js'
import { doctorReport } from '../../environment/detect.js'
import { describePolicy } from '../../policy/index.js'
import { text } from '../responses.js'

export function registerDiagnosticTools(server) {
  server.registerTool(
    'bash_info',
    {
      title: 'Show git-bash environment info',
      description: 'Report the resolved bash path, bash/git versions and key environment values. Use doctor for a full diagnosis.',
      inputSchema: {},
    },
    async () => text(await bashInfo()),
  )

  server.registerTool(
    'doctor',
    {
      title: 'Diagnose the git-bash environment',
      description:
        'Report how git-bash and git are resolved: every candidate path probed, which one won, the GITBASH_BASH value and whether it is valid, ' +
        'git on PATH, the audit log location, and the exact fix steps when bash is missing. Run this first when exec reports BASH_NOT_FOUND or when bash behaves unexpectedly.',
      inputSchema: {},
    },
    async () => text(await doctorReport()),
  )

  server.registerTool(
    'policy',
    {
      title: 'Show the command policy',
      description:
        'Report the active risky-command stance (GITBASH_MCP_RISKY, set by the user in the MCP client config), what each rule tier does under it, ' +
        'and the full rule list. Call this after exec returns error_code POLICY_DENIED or APPROVAL_REQUIRED, so you can explain the block and the ' +
        'user options accurately. exec results only carry a one-line policy verdict; this tool has the detail.',
      inputSchema: {},
    },
    async () => text(describePolicy()),
  )
}
