// Interactive checkbox menu, clack-style but dependency-free: alternates to the
// terminal's secondary screen, hides the cursor, and repaints the whole frame on
// every key. The key logic is a pure reducer so it is unit-testable without a TTY.
//
//   up/down or k/j   move the cursor      space   toggle the highlighted item
//   a / n            select all / none    1-9     jump to and toggle that item
//   enter            confirm              q/esc/ctrl-c  cancel
import { emitKeypressEvents } from 'node:readline'
import { makeStyler, esc } from './theme.js'

const SYM = {
  cursor: '\u276f',
  on: '\u25fc',
  off: '\u25fb',
  title: '\u25c7',
  done: '\u2714',
  cancel: '\u2716',
}

export function createMenuState(items) {
  return { items, cursor: 0, selected: new Set(), rendered: 0, first: true }
}

/** Pure key reducer. Returns 'confirm', 'cancel', or null to keep going. */
export function reduceMenu(state, str, key) {
  const name = key && key.name ? key.name : ''
  const count = state.items.length
  const toggle = (i) => {
    if (state.selected.has(i)) state.selected.delete(i)
    else state.selected.add(i)
  }
  if (name === 'up' || str === 'k') {
    state.cursor = (state.cursor - 1 + count) % count
  } else if (name === 'down' || str === 'j') {
    state.cursor = (state.cursor + 1) % count
  } else if (name === 'space' || str === ' ') {
    toggle(state.cursor)
  } else if (str === 'a') {
    for (let i = 0; i < count; i++) state.selected.add(i)
  } else if (str === 'n') {
    state.selected.clear()
  } else if (/^[1-9]$/.test(str)) {
    const i = Number(str) - 1
    if (i < count) { state.cursor = i; toggle(i) }
  } else if (name === 'return' || name === 'enter') {
    return 'confirm'
  } else if (name === 'escape' || str === 'q' || (key && key.ctrl && name === 'c')) {
    return 'cancel'
  }
  return null
}

export function selectedItems(state) {
  return [...state.selected].sort((a, b) => a - b).map((i) => state.items[i])
}

/** Rows for the frame. Pure: no ANSI, no stream. */
export function menuRows(state) {
  return state.items.map((it, i) => ({
    index: i,
    active: i === state.cursor,
    checked: state.selected.has(i),
    detected: !!it.detected,
    why: it.why || '',
    label: it.label,
    path: it.configPath,
  }))
}

/** Plain-text frame (used by tests and by --no-tui terminals). */
export function menuLines(state, headerLines) {
  const lines = headerLines.slice()
  for (const row of menuRows(state)) {
    const flag = row.detected ? '  (detected: ' + (row.why || '?') + ')' : '  (not found)'
    lines.push(' ' + (row.active ? '>' : ' ') + ' ' + (row.checked ? '[x]' : '[ ]') + ' ' + (row.index + 1) + '. ' + row.label + flag)
    lines.push('          ' + row.path)
  }
  lines.push('')
  lines.push('  space toggle  |  a all  |  n none  |  enter confirm  |  q cancel')
  return lines
}

/** Colored frame with the clack-style look. */
export function renderFrame(state, style, headerText) {
  const out = []
  out.push('')
  out.push('  ' + style.cyan(SYM.title) + '  ' + style.bold(headerText))
  out.push('  ' + style.gray('\u2502'))
  for (const row of menuRows(state)) {
    const box = row.checked ? style.green(SYM.on) : style.dim(SYM.off)
    const pointer = row.active ? style.cyan(SYM.cursor) : ' '
    const num = style.gray((row.index + 1) + '.')
    const label = row.active ? style.bold(row.label) : row.label
    const flag = row.detected
      ? '  ' + style.dim('(detected: ' + (row.why || '?') + ')')
      : '  ' + style.dim('(not found)')
    out.push('  ' + pointer + ' ' + box + ' ' + num + ' ' + label + flag)
    out.push('      ' + style.gray(row.path))
  }
  out.push('  ' + style.gray('\u2502'))
  out.push('  ' + style.gray('space toggle \u00b7 a all \u00b7 n none \u00b7 \u2191\u2193 move \u00b7 enter confirm \u00b7 q cancel'))
  out.push('')
  return out
}

/** Paint one frame over the previous one (whole-frame repaint, no scrollback). */
export function paintFrame(lines, stream, state) {
  stream.write(esc.home)
  for (const line of lines) stream.write(line + '\n')
  stream.write(esc.clearBelow)
  state.rendered = lines.length
  state.first = false
}

/** Present the menu; resolves to the picked items, or null when cancelled. */
export function readCheckboxMenu(items, headerText) {
  return new Promise((resolve) => {
    const state = createMenuState(items)
    items.forEach((it, i) => { if (it.detected) state.selected.add(i) })
    const stdin = process.stdin
    const stdout = process.stdout
    const style = makeStyler(stdout)
    const repaint = () => paintFrame(renderFrame(state, style, headerText), stdout, state)
    let finished = false
    const restore = () => {
      stdout.write(esc.altScreenOff + esc.cursorShow)
      try { stdin.setRawMode(false) } catch (e) { void e }
    }
    process.once('exit', restore)
    const cleanup = () => {
      if (finished) return
      finished = true
      process.removeListener('exit', restore)
      stdin.removeListener('keypress', onKey)
      stdout.removeListener('resize', repaint)
      try { stdin.setRawMode(false) } catch (e) { void e }
      stdin.pause()
      stdout.write(esc.altScreenOff + esc.cursorShow)
    }

    const onKey = (str, key) => {
      const action = reduceMenu(state, str, key)
      if (action === 'confirm') {
        const picked = selectedItems(state)
        cleanup()
        if (picked.length === 0) stdout.write('  ' + style.yellow('!') + ' nothing selected\n')
        else for (const it of picked) stdout.write('  ' + style.green(SYM.done) + ' ' + it.label + '\n')
        resolve(picked)
      } else if (action === 'cancel') {
        cleanup()
        stdout.write('  ' + style.red(SYM.cancel) + ' cancelled\n')
        resolve(null)
      } else {
        repaint()
      }
    }
    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(esc.altScreenOn + esc.cursorHide)
    repaint()
    stdin.on('keypress', onKey)
    stdout.on('resize', repaint)
  })
}