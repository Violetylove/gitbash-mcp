// Session-local approvals. Only the private window adapter can approve a request.
import { randomUUID } from 'node:crypto'
import { appendAudit } from '../audit/index.js'
import { baseResult } from '../execution/results.js'
import { createWindowsWindow } from './windows.js'

export const MAX_PENDING_APPROVALS = 32
export const MAX_FINISHED_APPROVALS = 64

export function createApprovalService({ createWindow = createWindowsWindow, audit = appendAudit } = {}) {
  const records = new Map()
  let window = null
  let stopped = false

  function log(record, phase) {
    audit({ id: record.auditId, ts: new Date().toISOString(), tool: 'approval', phase,
      approval_id: record.id, command: record.args.command, cwd: record.args.cwd,
      status: record.status, error_code: record.errorCode, job_id: record.result?.job_id })
  }

  function pending() {
    return [...records.values()].filter(record => record.status === 'pending_approval')
  }

  function prune() {
    const finished = [...records.values()].filter(record => !['pending_approval', 'executing'].includes(record.status))
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_APPROVALS))) records.delete(record.id)
  }

  function payload(record, summary = false) {
    const value = { approval_id: record.id, status: record.status,
      started: record.status === 'executing' || (record.result && !record.result.error_code) || false,
      command: record.args.command, cwd: record.args.cwd,
      category: record.verdict.tier, reason: record.verdict.reason,
      matched_rules: record.verdict.matched,
      created_at: record.createdAt, decided_at: record.decidedAt, ended_at: record.endedAt,
      audit_id: record.auditId, job_id: record.result?.job_id || null }
    if (record.errorCode) { value.error_code = record.errorCode; value.hint = record.message }
    if (!summary && record.result) value.result = record.result
    return value
  }

  function syncWindow() {
    if (!window) return
    try {
      window.update(pending().map(record => ({ ...payload(record, true),
        parameters: { login: record.args.login === true, timeout_ms: record.args.timeout_ms ?? null,
          run_in_background: record.args.run_in_background === true, env: record.args.env || {} } })))
    } catch (error) { windowEnded('failed', error.message) }
  }

  function resultFor(record) {
    if (record.result) return { ...record.result, approval_id: record.id }
    return Object.assign(baseResult(), payload(record), { policy: record.policy })
  }

  function settleWaiters(record) {
    const result = resultFor(record)
    for (const resolve of record.waiters) resolve(result)
    record.waiters.clear()
  }

  // Internal execution-service wait, not an MCP tool. No human-response timer.
  function awaitResult(id, signal) {
    const record = records.get(id)
    if (!record) return Promise.resolve(Object.assign(baseResult(), status(id)))
    if (!['pending_approval', 'executing'].includes(record.status)) return Promise.resolve(resultFor(record))
    return new Promise(resolve => {
      const done = result => {
        signal?.removeEventListener('abort', detach)
        record.waiters.delete(done)
        resolve(result)
      }
      const detach = () => done(Object.assign(baseResult(), payload(record), {
        exit_code: null, policy: record.policy, error_code: 'APPROVAL_DETACHED',
        hint: 'This call stopped waiting, but the accepted approval or execution was not cancelled. ' +
          'Do not repeat exec: find it with approval_list and read approval_status; use approval_cancel only to withdraw a pending approval.',
      }))
      record.waiters.add(done)
      signal?.addEventListener('abort', detach, { once: true })
      if (signal?.aborted) detach()
    })
  }

  function finish(record, status, errorCode, message) {
    record.status = status
    record.decidedAt = new Date().toISOString()
    record.endedAt = record.decidedAt
    record.errorCode = errorCode
    record.message = message
    record.execute = null
    log(record, status)
    settleWaiters(record)
    prune()
  }

  function windowEnded(status, message) {
    const oldWindow = window
    window = null
    for (const record of pending()) finish(record, status,
      status === 'failed' ? 'APPROVAL_UI_UNAVAILABLE' : 'APPROVAL_CANCELLED', message)
    oldWindow?.close()
  }

  function decide(id, action) {
    const record = records.get(id)
    if (stopped || !record || record.status !== 'pending_approval') return
    if (action === 'reject') {
      finish(record, 'rejected', 'APPROVAL_REJECTED', 'The user rejected this command.')
      syncWindow()
      return
    }
    if (action !== 'approve') return
    // Claim synchronously before invoking execution: duplicate or late clicks cannot run twice.
    record.status = 'executing'
    record.decidedAt = new Date().toISOString()
    log(record, 'approved')
    syncWindow()
    Promise.resolve().then(() => {
      if (stopped) throw new Error('The server session ended before execution started.')
      return record.execute(record.args)
    }).then(result => {
      record.result = result
      record.status = result.error_code ? 'failed' : 'completed'
      record.errorCode = result.error_code || null
      record.message = result.hint || null
      record.endedAt = new Date().toISOString()
      record.execute = null
      log(record, 'execution-result')
      settleWaiters(record)
      prune()
    }, error => {
      record.execute = null
      finish(record, 'failed', 'APPROVAL_EXECUTION_FAILED', error.message)
    })
  }

  function request({ args, verdict, policy, auditId, execute, signal }) {
    if (stopped || signal?.aborted) return Object.assign(baseResult(), {
      error_code: 'APPROVAL_CANCELLED', audit_id: auditId, policy, hint: 'The request was cancelled before approval was accepted.' })
    if (pending().length >= MAX_PENDING_APPROVALS) return Object.assign(baseResult(), {
      error_code: 'TOO_MANY_APPROVALS', audit_id: auditId, policy, hint: 'Resolve or cancel a pending approval before submitting another.' })
    const env = args.env ? Object.freeze({ ...args.env }) : undefined
    const record = { id: 'approval-' + randomUUID(), args: Object.freeze({ ...args, env }),
      verdict, policy, auditId, execute, status: 'pending_approval',
      createdAt: new Date().toISOString(), decidedAt: null, endedAt: null, result: null, waiters: new Set() }
    records.set(record.id, record)
    log(record, 'created')
    if (!window) {
      try {
        window = createWindow({ onDecision: decide,
          onClose: () => windowEnded('cancelled', 'The approval window was closed.'),
          onFailure: message => windowEnded('failed', message) })
      } catch (error) { windowEnded('failed', error.message) }
    }
    syncWindow()
    return Object.assign(baseResult(), payload(record), {
      exit_code: null, policy, error_code: record.errorCode || 'APPROVAL_REQUIRED',
      hint: record.message || 'Waiting for the user in the approval window, without an approval timeout. Query approval_status; cancel with approval_cancel.' })
  }

  function status(id) {
    const record = records.get(id)
    return record ? payload(record) : { error_code: 'APPROVAL_NOT_FOUND', approval_id: id,
      hint: 'Approval ids belong to this server session. Call approval_list.' }
  }

  return {
    request,
    awaitResult,
    status,
    list: () => ({ pending: pending().length, limit: MAX_PENDING_APPROVALS,
      approvals: [...records.values()].map(record => payload(record, true)) }),
    cancel(id) {
      const record = records.get(id)
      if (!record) return status(id)
      if (record.status === 'pending_approval') {
        finish(record, 'cancelled', 'APPROVAL_CANCELLED', 'The client explicitly cancelled this approval.')
        syncWindow()
      }
      return status(id)
    },
    close() {
      if (stopped) return
      stopped = true
      windowEnded('cancelled', 'The server session ended.')
    },
  }
}
