// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import {
  createSourceBlockIndex,
  type SourceBlockIndexHandle,
} from '../nav/source-block-index'

const {
  state,
  runSelectionFormat,
  runSelectedLink,
  requestBlockTransformOptions,
  cancelBlockTransformChoice,
} = vi.hoisted(() => ({
  state: {
    editor: null as HTMLElement | null,
    inner: null as object | null,
  },
  runSelectionFormat: vi.fn(),
  runSelectedLink: vi.fn((..._args: any[]) => true),
  requestBlockTransformOptions: vi.fn((..._args: any[]) => null as unknown),
  cancelBlockTransformChoice: vi.fn(),
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({
  activeModeElement: () => state.editor,
}))
vi.mock('../util/caret-gesture', () => ({ isCompositionActive: () => false }))
vi.mock('./block-transform-command', () => ({
  applyBlockTransformChoice: vi.fn(),
  requestBlockTransformOptions,
  cancelBlockTransformChoice,
}))
vi.mock('./selection-link-actions', () => ({ runSelectedLink }))
vi.mock('./selection-format-actions', () => ({
  formatIsActive: () => false,
  runSelectionFormat,
}))

import { installSelectionBubble } from './selection-bubble'

const originalRangeRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
)

/** Real editable DOM (not the production Vditor editor) with two paragraphs to select in. */
function setupDom(): { editor: HTMLElement; first: Text; second: Text } {
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
  return { editor, first, second }
}

/** A real source-block-index over `setupDom()`'s editor, driven by a mutable revision cell so
 * tests can simulate an out-of-band revision bump without touching the DOM. */
function testIndex(revision: () => object | undefined): SourceBlockIndexHandle {
  return createSourceBlockIndex({
    getActiveRoot: () => state.editor,
    projection: () =>
      state.inner ? { owner: state.inner, mode: 'ir' as const } : null,
    // The bubble never builds the index (only currentKey(), never peek()/read()), so a build
    // here is itself a regression.
    snapshotPair: () => {
      throw new Error('the bubble must never build the shared source index')
    },
    snapshotRevision: revision,
    resolveUnits: () => null,
  })
}

function selectRange(node: Text, start: number, end: number): void {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  runSelectionFormat.mockClear()
  runSelectedLink.mockClear()
  requestBlockTransformOptions.mockReset().mockReturnValue(null)
  cancelBlockTransformChoice.mockClear()
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

it('owns a visible selection without serializing, and declines a stale format click', () => {
  vi.useFakeTimers()
  const { editor, first, second } = setupDom()
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  const revision = {}
  const getValue = vi.fn(() => {
    throw new Error('getValue must not be called for passive selection')
  })
  const snapshotPair = vi.fn(() => {
    throw new Error('snapshotPair must not be called for passive selection')
  })
  const snapshotExactMarkdown = vi.fn(() => {
    throw new Error(
      'snapshotExactMarkdown must not be called for passive selection',
    )
  })
  const outer = { getValue } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown,
    snapshotPair,
    index: testIndex(() => revision),
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  selectRange(first, 0, 5)
  vi.advanceTimersByTime(40)
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  expect(bubble.hidden).toBe(false)
  expect(editor.contains(bubble)).toBe(false)
  // Formatting buttons and the range-derived Link/Wiki enablement are visible and correct —
  // none of that reads formatIsActive/link-eligibility through a serialization.
  expect(
    bubble
      .querySelector('button[data-action="bold"]')
      ?.getAttribute('aria-pressed'),
  ).toBe('false')
  expect(
    bubble.querySelector<HTMLButtonElement>('button[data-action="link"]')
      ?.disabled,
  ).toBe(false)
  expect(getValue).not.toHaveBeenCalled()
  expect(snapshotPair).not.toHaveBeenCalled()
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()

  // Move the live selection without letting the debounce refresh the bookmark: the click below
  // must see a stale Range and decline, all without any serialization.
  selectRange(second, 0, 4)
  bubble.querySelector<HTMLButtonElement>('button[data-action="bold"]')!.click()
  expect(runSelectionFormat).not.toHaveBeenCalled()
  expect(bubble.hidden).toBe(true)
  expect(getValue).not.toHaveBeenCalled()
  expect(snapshotPair).not.toHaveBeenCalled()
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  dispose()
  expect(document.querySelector('.vmde-selection-bubble')).toBeNull()
})

it('declines a click after a revision change leaves the DOM identical', () => {
  vi.useFakeTimers()
  const { editor, first } = setupDom()
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  let revision = {}
  const outer = {
    getValue: () => 'alpha\n\nbeta\n',
  } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown: () => 'alpha\n\nbeta\n',
    snapshotPair: () => ({
      exact: 'alpha\n\nbeta\n',
      rendered: 'alpha\n\nbeta\n',
    }),
    index: testIndex(() => revision),
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  selectRange(first, 0, 5)
  vi.advanceTimersByTime(40)
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  expect(bubble.hidden).toBe(false)

  // A trusted-edit revision bump (e.g. an external host-applied change) with no observed DOM
  // mutation still invalidates the bookmark's key.
  revision = {}
  bubble.querySelector<HTMLButtonElement>('button[data-action="bold"]')!.click()
  expect(runSelectionFormat).not.toHaveBeenCalled()
  expect(bubble.hidden).toBe(true)
  dispose()
})

it('declines a click after a characterData edit drained before observer delivery', () => {
  vi.useFakeTimers()
  const { editor, first } = setupDom()
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  const revision = {}
  const outer = {
    getValue: () => 'alpha\n\nbeta\n',
  } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown: () => 'alpha\n\nbeta\n',
    snapshotPair: () => ({
      exact: 'alpha\n\nbeta\n',
      rendered: 'alpha\n\nbeta\n',
    }),
    index: testIndex(() => revision),
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  selectRange(first, 0, 5)
  vi.advanceTimersByTime(40)
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  expect(bubble.hidden).toBe(false)

  // A live text edit lands synchronously; the MutationObserver callback has not run yet (no
  // microtask/task boundary crossed), but currentKey() must drain it via takeRecords() before
  // trusting the bookmark's key.
  first.data = 'ALPHA'
  bubble.querySelector<HTMLButtonElement>('button[data-action="bold"]')!.click()
  expect(runSelectionFormat).not.toHaveBeenCalled()
  expect(bubble.hidden).toBe(true)
  dispose()
})

it('takes exactly one snapshotPair for a Link activation', () => {
  vi.useFakeTimers()
  const { editor, second } = setupDom()
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  const revision = {}
  const outer = {
    getValue: () => 'alpha\n\nbeta\n',
  } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const snapshotPair = vi.fn(() => ({
    exact: 'alpha\n\nbeta\n',
    rendered: 'alpha\n\nbeta\n',
  }))
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown: () => 'alpha\n\nbeta\n',
    snapshotPair,
    index: testIndex(() => revision),
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  selectRange(second, 0, 4)
  vi.advanceTimersByTime(40)
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  expect(bubble.hidden).toBe(false)
  bubble.querySelector<HTMLButtonElement>('button[data-action="link"]')!.click()
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(runSelectedLink).toHaveBeenCalledOnce()
  expect(runSelectedLink.mock.calls[0][0]).toBe('link')
  expect(runSelectedLink.mock.calls[0][1]).toMatchObject({
    exact: 'alpha\n\nbeta\n',
    rendered: 'alpha\n\nbeta\n',
  })
  dispose()
})

it('tolerates a Turn Into menu marker round-trip, but closes the menu on a real revision change', async () => {
  const { editor, first } = setupDom()
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    ir: { element: editor, composingLock: false },
    preview: { element: { style: { display: 'none' } } },
  }
  let revision = {}
  const outer = {
    getValue: () => 'alpha\n\nbeta\n',
  } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  vi.stubGlobal('vscode', { postMessage: vi.fn() })
  requestBlockTransformOptions.mockReturnValue({
    token: 1,
    span: { start: 0, end: 5 },
    spans: [{ start: 0, end: 5 }],
    currentType: 'paragraph',
    targets: [
      { type: 'paragraph', status: 'noop', losses: [] },
      { type: 'h1', status: 'changed', losses: [] },
    ],
  })
  const dispose = installSelectionBubble({
    enabled: true,
    wikiEnabled: true,
    snapshotExactMarkdown: () => 'alpha\n\nbeta\n',
    snapshotPair: () => ({
      exact: 'alpha\n\nbeta\n',
      rendered: 'alpha\n\nbeta\n',
    }),
    index: testIndex(() => revision),
    setApplying: vi.fn(),
    postExact: vi.fn(),
    onError: vi.fn(),
  })
  selectRange(first, 0, 5)
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLElement>('.vmde-selection-bubble')?.hidden,
    ).toBe(false),
  )
  const bubble = document.querySelector<HTMLElement>('.vmde-selection-bubble')!
  bubble
    .querySelector<HTMLButtonElement>('button[data-action="turn-into"]')!
    .click()
  const menu = bubble.querySelector<HTMLElement>('.vmde-selection-bubble-menu')!
  expect(menu.hidden).toBe(false)

  // Turn Into's own capture (block-transform-command.ts -> rewrap-command.ts) inserts and
  // removes a rewrap marker synchronously while mapping the live selection to an exact source
  // range. That round-trip is real DOM churn observed by the shared index, but it does not
  // change the source bytes, so the open menu must survive it.
  const roundTrip = document.createTextNode('VMDE_REWRAP_START')
  first.parentElement!.append(roundTrip)
  roundTrip.remove()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(menu.hidden).toBe(false)
  expect(bubble.hidden).toBe(false)

  // A real edit's DOM change coincides with a source revision bump; the still-open menu must
  // close because the choice it would apply is no longer about the current source.
  revision = {}
  const edit = document.createTextNode('x')
  first.parentElement!.append(edit)
  edit.remove()
  // The menu closes; the plain bubble may legitimately reappear afterward through the same
  // passive refresh cycle that a click-away or Escape would also trigger, since the selection
  // itself is still live — that reappearance is correct and is not part of this assertion.
  await vi.waitFor(() => expect(menu.hidden).toBe(true))
  dispose()
})
