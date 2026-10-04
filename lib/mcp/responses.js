// MCP content formatting. Business services return ordinary payloads.
export function json(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

export function text(body) {
  return { content: [{ type: 'text', text: body }] }
}
