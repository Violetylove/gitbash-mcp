import { z } from 'zod'
import { json } from '../responses.js'

export function registerApprovalTools(server, approvals) {
  server.registerTool('approval_list', {
    title: 'List command approvals',
    description: 'List pending and retained command approvals. Pending approvals have no human-response timeout. Only the local human window can approve; this tool cannot approve.',
    inputSchema: {},
  }, async () => json(approvals.list()))
  server.registerTool('approval_status', {
    title: 'Read command approval status',
    description: 'Read a pending approval or its execution result without blocking. After approval the result may contain job_id; use job_output to collect that job. Do not resubmit exec while approval is pending.',
    inputSchema: { approval_id: z.string().describe('Approval id returned by exec or approval_list') },
  }, async args => json(approvals.status(args.approval_id)))
  server.registerTool('approval_cancel', {
    title: 'Cancel a pending command approval',
    description: 'Explicitly cancel a pending approval before its command starts. Does not stop approved commands; use job_kill for running jobs. Cannot approve a command.',
    inputSchema: { approval_id: z.string().describe('Approval id to cancel') },
  }, async args => json(approvals.cancel(args.approval_id)))
}
