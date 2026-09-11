// Menu reducer tests: the interactive key logic is pure, so it is testable
// without a TTY. Run: node test-menu.mjs
import { createMenuState, reduceMenu, selectedItems, menuLines, menuRows, renderFrame } from './lib/menu.js'
import { makeStyler } from './lib/theme.js'
const ESC = String.fromCharCode(27)

let failures = 0
function assert(cond, label, detail) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('FAIL  ' + label + (detail !== undefined ? ' - ' + String(detail) : '')) }
}
const items = [
  { label: 'DSH', configPath: 'C:/x/dsh.yml', detected: true, why: '.dsh' },
  { label: 'Claude Code', configPath: 'C:/x/claude.json', detected: true, why: 'claude.json' },
  { label: 'Cursor', configPath: 'C:/x/cursor.json', detected: false, why: '' },
]
const key = (name, ctrl) => ({ name, ctrl: !!ctrl })

console.log('== initial state ==')
let s = createMenuState(items)
assert(s.cursor === 0 && s.selected.size === 0, 'cursor at 0, nothing selected')

console.log('== space toggles the highlighted item ==')
assert(reduceMenu(s, ' ', key('space')) === null, 'space is not a terminal action')
assert(s.selected.has(0) && s.selected.size === 1, 'first item selected')
reduceMenu(s, ' ', key('space'))
assert(s.selected.size === 0, 'space again deselects')

console.log('== arrows / jk move, space toggles the new row ==')
reduceMenu(s, '', key('down'))
assert(s.cursor === 1, 'down moves to row 2')
reduceMenu(s, '', key('down'))
reduceMenu(s, '', key('down'))
assert(s.cursor === 0, 'down wraps around')
reduceMenu(s, '', key('up'))
assert(s.cursor === 2, 'up wraps backwards')
reduceMenu(s, 'j', key('j'))
assert(s.cursor === 0, 'j moves down')
reduceMenu(s, 'k', key('k'))
assert(s.cursor === 2, 'k moves up')

console.log('== arbitrary multi-select ==')
s = createMenuState(items)
reduceMenu(s, ' ', key('space'))
reduceMenu(s, 'j', key('j'))
reduceMenu(s, 'j', key('j'))
reduceMenu(s, ' ', key('space'))
assert(selectedItems(s).length === 2, 'rows 1 and 3 selected (non-adjacent)', JSON.stringify(selectedItems(s).map(i => i.label)))

console.log('== a / n shortcuts and number keys ==')
reduceMenu(s, 'a', key('a'))
assert(s.selected.size === 3, 'a selects all')
reduceMenu(s, 'n', key('n'))
assert(s.selected.size === 0, 'n clears all')
reduceMenu(s, '2', key('2'))
assert(s.selected.has(1) && s.cursor === 1, 'number key jumps and toggles')

console.log('== confirm / cancel ==')
s = createMenuState(items)
assert(reduceMenu(s, '', key('return')) === 'confirm', 'enter confirms')
assert(reduceMenu(s, 'q', key('q')) === 'cancel', 'q cancels')
assert(reduceMenu(s, '', key('escape')) === 'cancel', 'esc cancels')
assert(reduceMenu(s, 'c', key('c', true)) === 'cancel', 'ctrl-c cancels')

console.log('== rendering shows boxes and the cursor ==')
s = createMenuState(items)
s.selected.add(1)
const rendered = menuLines(s, ['header']).join('\n')
assert(rendered.includes('> [ ] 1. DSH'), 'cursor on unselected row renders > [ ]', rendered)
assert(rendered.includes('  [x] 2. Claude Code  (detected: claude.json)'), 'selected row shows the detection reason', rendered)
assert(rendered.includes('C:/x/claude.json'), 'config path is shown')
assert(rendered.includes('(not found)'), 'undetected rows are labelled')

console.log('== frame rendering: colors on / off ==')
s = createMenuState(items)
s.selected.add(1)
process.env.FORCE_COLOR = '1'
delete process.env.NO_COLOR
const frameOn = renderFrame(s, makeStyler({ isTTY: true }), 'Select clients').join('\n')
assert(frameOn.includes(ESC + '['), 'FORCE_COLOR emits ANSI', JSON.stringify(frameOn.slice(0, 30)))
assert(frameOn.includes('\u25fb') || frameOn.includes('\u25fc'), 'frame uses checkbox glyphs')
assert(frameOn.includes('(detected: claude.json)'), 'frame shows the detection reason')
assert(frameOn.includes('(not found)'), 'frame labels undetected clients')
assert(frameOn.includes('Select clients'), 'frame keeps the title')
process.env.NO_COLOR = '1'
delete process.env.FORCE_COLOR
const frameOff = renderFrame(s, makeStyler({ isTTY: true }), 'Select clients').join('\n')
assert(!frameOff.includes(ESC + '['), 'NO_COLOR emits no ANSI')
delete process.env.NO_COLOR

console.log('== menuRows is pure model data ==')
const rows = menuRows(s)
assert(rows.length === 3, 'one row per item')
assert(rows[0].active === true && rows[1].checked === true, 'rows expose active/checked')
assert(rows[2].detected === false && rows[1].detected === true, 'rows expose detected')

console.log(failures === 0 ? '\nMENU ALL PASS' : '\n' + failures + ' MENU FAILURES')
process.exit(failures === 0 ? 0 : 1)