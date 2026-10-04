// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 580 CP2-9 — the contained synthetic-chord helper and the table command runner. Vditor is
// stood in for by a keydown listener on the mode element, registered before the helper runs.
const h = vi.hoisted(() => ({
  mode: 'ir' as string,
  root: null as HTMLElement | null,
  mac: false,
}))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: () => ({ currentMode: h.mode }),
}))
vi.mock('../util/source-map', () => ({ activeModeElement: () => h.root }))
vi.mock('../util/platform', () => ({ isMac: () => h.mac }))
vi.mock('./table-actions', () => ({ runTableMove: vi.fn(() => true) }))
vi.mock('./undo-boundaries', () => ({
  markToolbarHotkeyKeydownBridged: vi.fn(),
}))

import {
  dispatchContainedKeydown,
  dispatchTableHotkey,
  runTableCommand,
  TABLE_EDITOR_ACTIONS,
} from './table-hotkey'
import { runTableMove } from './table-actions'
import { markToolbarHotkeyKeydownBridged } from './undo-boundaries'

let root: HTMLElement
const removers: (() => void)[] = []

function listen(
  target: EventTarget,
  listener: (event: KeyboardEvent) => void,
  capture = false,
) {
  const wrapped = (event: Event) => listener(event as KeyboardEvent)
  target.addEventListener('keydown', wrapped, capture)
  removers.push(() => target.removeEventListener('keydown', wrapped, capture))
}

function caretIn(node: Node) {
  const range = document.createRange()
  range.setStart(node, 0)
  range.collapse(true)
  getSelection()?.removeAllRanges()
  getSelection()?.addRange(range)
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML =
    '<div class="vditor-ir"><pre class="vditor-reset" contenteditable="true"><p>text</p><table><tbody><tr><td>cell</td></tr></tbody></table></pre></div>'
  root = document.querySelector('pre')!
  h.root = root
  h.mode = 'ir'
  h.mac = false
  ;(window as any).vditor = { vditor: {} }
})

afterEach(() => {
  for (const remove of removers.splice(0)) remove()
  getSelection()?.removeAllRanges()
  ;(window as any).vditor = undefined
})

describe('dispatchContainedKeydown', () => {
  it('runs the element listener first, then stops the event before the document and window', () => {
    const order: string[] = []
    listen(window, () => order.push('window-capture'), true)
    listen(root, (event) => {
      order.push('vditor')
      expect(event.isTrusted).toBe(false)
      event.preventDefault()
    })
    listen(document, () => order.push('document-bubble'))
    listen(window, () => order.push('window-bubble'))
    expect(dispatchContainedKeydown(root, { key: '=', ctrlKey: true })).toBe(
      true,
    )
    expect(order).toEqual(['window-capture', 'vditor'])
  })

  it('reports an unhandled chord and leaves later keys alone', () => {
    const bubbled = vi.fn()
    listen(window, bubbled)
    expect(dispatchContainedKeydown(root, { key: 'x', ctrlKey: true })).toBe(
      false,
    )
    expect(bubbled).not.toHaveBeenCalled()
    root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    )
    expect(bubbled).toHaveBeenCalledOnce()
  })

  it('tags the event before any listener sees it', () => {
    const tagged = new WeakSet<Event>()
    let seenTagged = false
    listen(window, (event) => (seenTagged = tagged.has(event)), true)
    dispatchContainedKeydown(root, { key: '=', ctrlKey: true }, (event) =>
      tagged.add(event),
    )
    expect(seenTagged).toBe(true)
  })
})

describe('dispatchTableHotkey', () => {
  it.each([
    [false, 'insertColumnR', { key: '+', shiftKey: true, ctrlKey: true }],
    [true, 'insertColumnR', { key: '=', shiftKey: true, metaKey: true }],
    [false, 'deleteColumn', { key: '_', shiftKey: true, ctrlKey: true }],
    [true, 'deleteColumn', { key: '-', shiftKey: true, metaKey: true }],
    [false, 'insertRowB', { key: '=', shiftKey: false, ctrlKey: true }],
    [false, 'left', { key: 'l', shiftKey: true, ctrlKey: true }],
  ] as const)('mac=%s %s sends %o', (mac, action, expected) => {
    const seen = vi.fn()
    listen(root, seen)
    dispatchTableHotkey(root, action, mac)
    expect(seen.mock.calls[0][0]).toMatchObject(expected)
  })
})

describe('runTableCommand', () => {
  it('maps the 13 table editor actions', () => {
    expect(TABLE_EDITOR_ACTIONS).toHaveLength(13)
    expect(new Set(TABLE_EDITOR_ACTIONS.map(([action]) => action)).size).toBe(
      13,
    )
  })

  it('sends the chord on the mode element, marked for the undo boundary, only from a cell', () => {
    const seen = vi.fn((event: KeyboardEvent) => event.preventDefault())
    listen(root, seen)
    const bubbled = vi.fn()
    listen(window, bubbled)

    caretIn(root.querySelector('p')!.firstChild!)
    expect(runTableCommand('insertRowB')).toBe(false)
    expect(seen).not.toHaveBeenCalled()

    caretIn(root.querySelector('td')!.firstChild!)
    expect(runTableCommand('insertRowB')).toBe(true)
    expect(seen).toHaveBeenCalledOnce()
    expect(seen.mock.calls[0][0]).toMatchObject({ key: '=', ctrlKey: true })
    expect(markToolbarHotkeyKeydownBridged).toHaveBeenCalledWith(
      seen.mock.calls[0][0],
    )
    expect(bubbled).not.toHaveBeenCalled()
  })

  it('runs the moves through the table transaction', () => {
    caretIn(root.querySelector('td')!.firstChild!)
    for (const move of [
      'moveColumnLeft',
      'moveColumnRight',
      'moveRowUp',
      'moveRowDown',
    ] as const) {
      expect(runTableCommand(move)).toBe(true)
      expect(runTableMove).toHaveBeenLastCalledWith(move)
    }
  })

  it('runs in WYSIWYG and does nothing in Split View', () => {
    const seen = vi.fn()
    listen(root, seen)
    caretIn(root.querySelector('td')!.firstChild!)
    h.mode = 'wysiwyg'
    runTableCommand('left')
    expect(seen).toHaveBeenCalledOnce()
    h.mode = 'sv'
    expect(runTableCommand('left')).toBe(false)
    expect(runTableCommand('moveRowUp')).toBe(false)
    expect(seen).toHaveBeenCalledOnce()
    expect(runTableMove).not.toHaveBeenCalled()
  })

  it('does nothing when the cell is outside the active mode element', () => {
    const other = document.createElement('table')
    other.innerHTML = '<tbody><tr><td>x</td></tr></tbody>'
    document.body.append(other)
    caretIn(other.querySelector('td')!.firstChild!)
    expect(runTableCommand('moveRowUp')).toBe(false)
    expect(runTableMove).not.toHaveBeenCalled()
  })
})
