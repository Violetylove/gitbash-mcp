// Execution result payloads shared by business services.
export function baseResult() {
  return {
    exit_code: -1,
    stdout: '',
    stderr: '',
    timed_out: false,
    still_running: false,
    truncated: false,
    spill_path: null,
    spill_bytes: 0,
    spill_truncated: false,
    duration_ms: 0,
    killed_by: null,
    timeout_ms: 0,
    queued_ms: 0,
  }
}

export function withHint(payload, hint) {
  if (hint) payload.hint = hint
  return payload
}
