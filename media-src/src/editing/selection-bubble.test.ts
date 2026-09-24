// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'

const { state, runSelectionFormat } = vi.hoisted(() => ({
  state: {
    editor: null as HTMLElement | null,
    inner: null as object | null,
  },
  runSelectionFormat: vi.fn(),
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({
  activeModeElement: () => state.editor,
}))
vi.mock('../util/caret-gesture', () => ({ isCompositionActive: () => false }))
vi.mock('./block-transform-command', () => ({
  applyBlockTransformChoice: vi.fn(),
  requestBlockTransformOptions: vi.fn(),
}))
vi.mock('./selection-link-actions', () => ({ runSelectedLink: vi.fn() }))
vi.mock('./selection-format-actions', () => ({
  formatIsActive: () => false,
  runSelectionFormat,
}))

import { installSelectionBubble } from './selection-bubble'

const originalRangeRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
)

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  runSelectionFormat.mockClear()
  state.editor = null
  state.inner = null
  if (originalRangeRect)
    Object.defineProperty(
      Range.prototype,
      'getBoundingClientRect',
      originalRangeRect,
    )
  else
    delete (Range.prototype as Range & { getBoundingClientRect?: unknown })
      .getBoundingClientRect
})

it('owns a visible selection outside editable DOM and declines a stale format click', () => {
  vi.useFakeTimers()
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 200,
      right: 250,
      top: 100,
      bottom: 120,
      width: 50,
      height: 20,
    }),
  })
  const app = document.createElement('div')
  app.id = 'app'
  const editor = document.createElement('pre')
  editor.setAttribute('contenteditable', 'true')
  const first = document.createTextNode('alpha')
  const second = document.createTextNode('beta')
  const firstParagraph = document.createElement('p')
  const secondParagraph = document.createElement('p')
  firstParagraph.append(first)
  secondParagraph.append(second)
  editor.append(firstParagraph, secondParagraph)
  app.append(editor)
  document.body.append(app)
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  const outer = { getValue: () => 'alpha\n\nbeta\n' } as NonNullable<
    Window['vditor']
  >
  vi.stubGlobal('vditor', outer)
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown: () => 'alpha\n\nbeta\n',
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  const selection = window.getSelection()!
  const firstRange = document.createRange()
  firstRange.setStart(first, 0)
  firstRange.setEnd(first, 5)
  selection.removeAllRanges()
  selection.addRange(firstRange)
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(40)
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  expect(bubble.hidden).toBe(false)
  expect(editor.contains(bubble)).toBe(false)

  const secondRange = document.createRange()
  secondRange.setStart(second, 0)
  secondRange.setEnd(second, 4)
  selection.removeAllRanges()
  selection.addRange(secondRange)
  document.dispatchEvent(new Event('selectionchange'))
  bubble.querySelector<HTMLButtonElement>('button[data-action="bold"]')!.click()
  expect(runSelectionFormat).not.toHaveBeenCalled()
  expect(bubble.hidden).toBe(true)
  dispose()
  expect(document.querySelector('.vmde-selection-bubble')).toBeNull()
})
