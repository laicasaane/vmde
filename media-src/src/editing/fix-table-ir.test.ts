// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createRealLute } from '../testing/real-lute'

vi.mock('./table-actions', () => ({ runTableMove: vi.fn(() => true) }))
vi.mock('./table-cell-selection', () => ({
  runTablePanelRectangleAction: vi.fn(() => 'none'),
}))

import { fixTableIr } from './fix-table-ir'
import { runTableMove } from './table-actions'
import { runTablePanelRectangleAction } from './table-cell-selection'

const lute = createRealLute('ir')
const SOURCE =
  'Before.\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| one | two | three |\n| four | five | six |\n\nAfter.\n'
const SELECTOR = '#fix-table-ir-wrapper'
let root: HTMLElement
let mode = 'ir'

function clickAt(element: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(true)
  range.getBoundingClientRect = () => new DOMRect(100, 200, 1, 20)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function wrapper() {
  return document.querySelector<HTMLDivElement>(SELECTOR)!
}

function button(type: string) {
  return wrapper().querySelector<HTMLButtonElement>(`[data-type="${type}"]`)!
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runTablePanelRectangleAction).mockReturnValue('none')
  document.body.innerHTML =
    '<div class="vditor-ir"><pre class="vditor-reset" contenteditable="true"></pre></div>'
  root = document.querySelector('pre')!
  root.innerHTML = lute.render(SOURCE)
  mode = 'ir'
  vi.stubGlobal('vditor', {
    vditor: { ir: { element: root } },
    getCurrentMode: () => mode,
  })
  // jsdom supplies no layout. Real Chromium/VS Code specs own geometry;
  // nonzero rects let these tests exercise panel routing with real Lute DOM.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.matches('.vditor-panel')
        ? new DOMRect(35, 73, 21, 21)
        : new DOMRect(100, 200, 80, 30)
    },
  )
  fixTableIr()
})

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('lazy panel creation and button updates emit no editable-root records', () => {
  expect(wrapper()).toBeNull()
  root.scrollTop = 200
  root.scrollLeft = 12
  const observer = new MutationObserver(() => undefined)
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  try {
    clickAt(root.querySelector('p')!)
    const panel = wrapper().firstElementChild as HTMLElement
    const clip = wrapper().parentElement!
    expect(clip.parentElement).toBe(root.parentElement)
    expect(clip.id).toBe('')
    expect(root.contains(wrapper())).toBe(false)
    expect(clip.style.overflow).toBe('hidden')
    expect(clip.style.pointerEvents).toBe('none')
    expect(clip.style.inset).toBe('0px')
    expect(wrapper().style.pointerEvents).toBe('auto')
    expect(wrapper().contentEditable).toBe('false')
    expect(wrapper().style.userSelect).toBe('none')
    expect(wrapper().style.width).toBe('0px')
    expect(wrapper().style.height).toBe('0px')
    expect(wrapper().style.transform).toBe('translate(-12px, -200px)')
    expect(panel.style.display).toBe('none')

    clickAt(root.querySelector('th')!)
    expect(button('deleteRow').disabled).toBe(true)
    expect(button('moveColumnLeft').disabled).toBe(true)
    clickAt(root.querySelectorAll('td')[2])
    expect(panel.style.display).toBe('block')
    expect(button('deleteRow').disabled).toBe(false)
    expect(button('moveColumnRight').disabled).toBe(true)
    expect(button('right').classList.contains('vditor-icon--current')).toBe(
      true,
    )
    clickAt(root.querySelectorAll('td')[1])
    expect(button('center').classList.contains('vditor-icon--current')).toBe(
      true,
    )
    clickAt(root.querySelectorAll('td')[1]) // repeated disabled writes stay outside too
    root.scrollTop = 400
    root.scrollLeft = 32
    root.dispatchEvent(new Event('scroll'))
    expect(wrapper().style.transform).toBe('translate(-32px, -400px)')
    clickAt(root.querySelector('p')!)
    expect(panel.style.display).toBe('none')
    expect(observer.takeRecords()).toEqual([])
  } finally {
    observer.disconnect()
  }
})

test('real Lute ignores the former in-root wrapper in every alignment and disabled state', () => {
  const expected = lute.serialize(root.innerHTML)
  for (const target of root.querySelectorAll<HTMLElement>('p, th, td')) {
    clickAt(target)
    // Clone the actual production markup into its former top-level location;
    // this proves byte parity for hidden/shown panels, highlights and edge states.
    const oldWrapper = wrapper().cloneNode(true) as HTMLElement
    root.appendChild(oldWrapper)
    expect(lute.serialize(root.innerHTML)).toBe(expected)
    oldWrapper.remove()
    expect(lute.serialize(root.innerHTML)).toBe(expected)
  }
})

test('mode round-trips and root replacement retain the one live panel and its handlers', () => {
  mode = 'wysiwyg'
  clickAt(root.querySelector('p')!)
  expect(wrapper()).toBeNull()
  mode = 'ir'
  clickAt(root.querySelector('td')!)
  const original = wrapper()
  for (const next of ['wysiwyg', 'ir']) {
    mode = next
    // setValue/reseed and IR history restore replace the root's HTML.
    root.innerHTML = lute.render(SOURCE)
    clickAt(root.querySelector('td')!)
  }
  expect(wrapper()).toBe(original)
  expect(document.querySelectorAll(SELECTOR)).toHaveLength(1)
  button('moveColumnRight').click()
  expect(runTableMove).toHaveBeenCalledWith('moveColumnRight')
})

test.each([
  'left',
  'center',
  'right',
  'insertRowA',
  'insertRowB',
  'insertColumnL',
  'insertColumnR',
  'deleteRow',
  'deleteColumn',
])(
  'sibling panel retains caret and routes %s without leaking its hotkey',
  (action) => {
    clickAt(root.querySelectorAll('td')[1])
    const anchor = window.getSelection()!.anchorNode
    const bubbled = vi.fn()
    root.parentElement!.addEventListener('keydown', bubbled)
    const dispatched = vi.fn()
    root.addEventListener('keydown', dispatched)
    const panelBubbled = vi.fn()
    root.parentElement!.addEventListener('click', panelBubbled)
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    button(action).dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    button(action).click()
    expect(window.getSelection()!.anchorNode).toBe(anchor)
    expect(dispatched).toHaveBeenCalledOnce()
    expect(dispatched.mock.calls[0][0].defaultPrevented).toBe(true)
    expect(bubbled).not.toHaveBeenCalled()
    expect(panelBubbled).not.toHaveBeenCalled()
    // Suppression applies only during dispatch, never to a later editor key.
    root.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    )
    expect(bubbled).toHaveBeenCalledOnce()
  },
)

test.each(['moveColumnLeft', 'moveColumnRight', 'moveRowUp', 'moveRowDown'])(
  'sibling panel routes %s to the table move transaction',
  (action) => {
    clickAt(root.querySelectorAll('td')[1])
    // Exercise each route independently of the edge-state guard tested above.
    button(action).disabled = false
    button(action).click()
    expect(runTableMove).toHaveBeenCalledWith(action)
  },
)

// Task 580 CP2-9 — the IR move chords are gone: the moves are the unbound `vmde.table.move*`
// commands, and Ctrl/Cmd+Shift+[ / ] in a cell reaches VS Code (Fold/Unfold) unhandled.
test('Ctrl/Cmd+Shift move chords in an IR cell no longer move the table', () => {
  clickAt(root.querySelectorAll('td')[1])
  const bubbled = vi.fn()
  root.parentElement!.addEventListener('keydown', bubbled)
  for (const key of ['[', '{', ']', '}', 'PageUp', 'PageDown']) {
    const event = new KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    root.querySelectorAll('td')[1].dispatchEvent(event)
    expect(event.defaultPrevented, key).toBe(false)
  }
  expect(runTableMove).not.toHaveBeenCalled()
  expect(bubbled).toHaveBeenCalledTimes(6)
})

test('a panel range action uses painted cells after native selection moves away', () => {
  clickAt(root.querySelector('td')!)
  root.querySelector('td')!.classList.add('vmde-cell-selected')
  window.getSelection()!.removeAllRanges()
  vi.mocked(runTablePanelRectangleAction).mockReturnValue('applied')
  const dispatched = vi.fn()
  root.addEventListener('keydown', dispatched)
  button('insertRowB').click()
  expect(runTablePanelRectangleAction).toHaveBeenCalledWith(
    root.querySelector('table'),
    'insertRowB',
  )
  expect(dispatched).not.toHaveBeenCalled()
})

test('missing IR root or parent fails before installing a panel', () => {
  vi.stubGlobal('vditor', { vditor: {} })
  expect(fixTableIr).toThrow('IR editor element not initialized')
  root.remove()
  vi.stubGlobal('vditor', { vditor: { ir: { element: root } } })
  expect(fixTableIr).toThrow('IR editor has no parent')
})
