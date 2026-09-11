// Minimal ANSI styling. No dependencies; respects NO_COLOR / FORCE_COLOR / TERM=dumb.
const ESC = String.fromCharCode(27)
const RESET = ESC + '[0m'

export function makeStyler(stream) {
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== ''
  const force = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'
  const tty = !!(stream && stream.isTTY)
  const term = process.env.TERM || ''
  const enabled = !noColor && (force || (tty && term !== 'dumb'))
  const wrap = (open) => (s) => (enabled ? open + String(s) + RESET : String(s))
  return {
    enabled,
    bold: wrap(ESC + '[1m'),
    dim: wrap(ESC + '[2m'),
    cyan: wrap(ESC + '[36m'),
    green: wrap(ESC + '[32m'),
    red: wrap(ESC + '[31m'),
    yellow: wrap(ESC + '[33m'),
    inverse: wrap(ESC + '[7m'),
    gray: wrap(ESC + '[90m'),
  }
}

export const esc = {
  altScreenOn: ESC + '[?1049h',
  altScreenOff: ESC + '[?1049l',
  cursorHide: ESC + '[?25l',
  cursorShow: ESC + '[?25h',
  home: ESC + '[H',
  clearBelow: ESC + '[J',
}