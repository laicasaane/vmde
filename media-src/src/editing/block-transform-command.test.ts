// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  applyBlockTransformChoice,
  cancelBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
} from './block-transform-command'

const state = vi.hoisted(() => ({
  inner: null as any,
  editor: null as HTMLElement | null,
  source: 'before\n\nalpha **beta**\n\nafter\n',
  caret: 0,
  revision: {} as object | undefined,
  realCapture: false,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('./rewrap-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rewrap-command')>()
  return {
    captureRewrapSourceSelection: (
      ...args: Parameters<typeof actual.captureRewrapSourceSelection>
    ) =>
      state.realCapture
        ? actual.captureRewrapSourceSelection(...args)
        : {
            markdown: state.source,
            startOffset: state.caret,
            endOffset: state.caret,
            caretOffset: state.caret,
          },
    checkpointEditorUndo: vi.fn(),
    recordRewrapDocumentHistory: vi.fn(),
    replaceSvMarkdownRange: vi.fn(),
  }
})

let dispose: (() => void) | undefined
let postExact = vi.fn((_markdown: string) => undefined)
let snapshotExactMarkdown = vi.fn(() => state.source)
let getValue = vi.fn(() => state.source)

beforeEach(() => {
  state.source = 'before\n\nalpha **beta**\n\nafter\n'
  state.caret = state.source.indexOf('beta') + 2
  state.revision = {}
  state.realCapture = false
  const editor = document.createElement('pre')
  editor.contentEditable = 'true'
  editor.textContent = 'beta'
  document.body.append(editor)
  state.editor = editor
  state.inner = { currentMode: 'ir' }
  postExact = vi.fn((_markdown: string) => undefined)
  snapshotExactMarkdown = vi.fn(() => state.source)
  getValue = vi.fn(() => state.source)
  ;(window as any).vditor = {
    getValue,
    vditor: state.inner,
  }
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  dispose = configureBlockTransformCommand({
    snapshotExactMarkdown,
    snapshotRevision: () => state.revision,
    setApplying: vi.fn(),
    postExact,
    onError: vi.fn(),
  })
  document.dispatchEvent(new Event('selectionchange'))
})

afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  delete (window as any).__vmdeBlockHandleCacheMetrics
  state.editor = null
  delete (window as any).vditor
  getSelection()?.removeAllRanges()
})

it('returns source-derived target statuses and consumes a confirm-required choice without an edit', () => {
  const options = requestBlockTransformOptions(window)
  expect(options?.currentType).toBe('paragraph')
  expect(options?.targets.find((item) => item.type === 'h2')?.status).toBe(
    'changed',
  )
  expect(options?.targets.find((item) => item.type === 'fence')?.status).toBe(
    'confirm-required',
  )
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'fence' }),
  ).toBe(false)
  expect(postExact).not.toHaveBeenCalled()
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(false)
})

it('rejects a stale exact snapshot and a token from another request', () => {
  const first = requestBlockTransformOptions(window)!
  expect(
    applyBlockTransformChoice(window, first.token + 1, { type: 'h2' }),
  ).toBe(false)
  const second = requestBlockTransformOptions(window)!
  state.source = 'external edit\n'
  state.revision = {}
  expect(applyBlockTransformChoice(window, second.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})

it.each([true, false])(
  'keeps a source-verified target through a focus sentinel with revision authority=%s',
  (revisionAuthority) => {
    if (!revisionAuthority) state.revision = undefined
    state.editor!.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    )
    const range = document.createRange()
    range.setStart(state.editor!, 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
  },
)

it('declines a focus sentinel without a prior capture or focus transfer', () => {
  const range = document.createRange()
  range.setStart(state.editor!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  expect(requestBlockTransformOptions(window)).toBeNull()
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()
})

it('refreshes a retained proof on focus transfer when revision authority is absent', () => {
  state.revision = undefined
  const focusOut = () =>
    state.editor!.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    )
  focusOut()
  state.source += 'new paragraph\n'
  document.dispatchEvent(new Event('selectionchange'))
  focusOut()
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(2)
  const sentinel = document.createRange()
  sentinel.setStart(state.editor!, 0)
  sentinel.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(sentinel)
  expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
})

it('expires a canceled native warning token without a source edit', () => {
  const options = requestBlockTransformOptions(window)!
  cancelBlockTransformChoice(options.token)
  expect(applyBlockTransformChoice(window, options.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})

it('offers fence removal only when both live Lute projections prove one paragraph', () => {
  state.source = '```ts\nalpha\n```'
  state.revision = {}
  state.caret = state.source.indexOf('alpha') + 2
  state.editor!.textContent = 'alpha'
  state.inner.lute = {
    Md2VditorIRDOM: () => '<p>alpha</p>',
    Md2VditorDOM: () => '<p>alpha</p>',
  }
  const range = document.createRange()
  range.setStart(state.editor!.firstChild!, 2)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  expect(
    requestBlockTransformOptions(window)?.targets.find(
      (item) => item.type === 'paragraph',
    )?.status,
  ).toBe('confirm-required')
  state.inner.lute.Md2VditorDOM = () => '<h1>alpha</h1>'
  expect(
    requestBlockTransformOptions(window)?.targets.find(
      (item) => item.type === 'paragraph',
    )?.status,
  ).toBe('unsupported')
})

it('defers changed-selection snapshots until a live block-transform request', () => {
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  for (let index = 0; index < 30; index++)
    document.dispatchEvent(new Event('selectionchange'))
  const moved = document.createRange()
  moved.setStart(state.editor!.firstChild!, 3)
  moved.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(moved)
  state.caret = state.source.indexOf('after') + 2
  document.dispatchEvent(new Event('selectionchange'))

  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()
  const options = requestBlockTransformOptions(window)
  expect(options?.span.start).toBe(state.source.indexOf('after'))
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(2)
  expect(getValue).toHaveBeenCalledTimes(2)
})

it('captures a dirty live selection on focusout and retains it through the focus sentinel', () => {
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  const moved = document.createRange()
  moved.setStart(state.editor!.firstChild!, 3)
  moved.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(moved)
  state.caret = state.source.indexOf('after') + 2
  document.dispatchEvent(new Event('selectionchange'))
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()

  state.editor!.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
  )
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(1)
  expect(getValue).toHaveBeenCalledTimes(1)
  const sentinel = document.createRange()
  sentinel.setStart(state.editor!, 0)
  sentinel.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(sentinel)
  document.dispatchEvent(new Event('selectionchange'))

  const options = requestBlockTransformOptions(window)!
  expect(options.span.start).toBe(state.source.indexOf('after'))
  state.source = 'changed while palette owned focus\n'
  state.revision = {}
  expect(applyBlockTransformChoice(window, options.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})

it('defers path and revision changes until a fresh request', () => {
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  const moved = document.createRange()
  moved.setStart(state.editor!.firstChild!, 3)
  moved.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(moved)
  document.dispatchEvent(new Event('selectionchange'))
  state.revision = {}
  document.dispatchEvent(new Event('selectionchange'))
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()

  expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(2)
  expect(getValue).toHaveBeenCalledTimes(2)
})

it('re-proves an equivalent selection after text-node replacement at the same path', () => {
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  const previous = state.editor!.firstChild!
  const replacement = document.createTextNode(previous.textContent ?? '')
  previous.replaceWith(replacement)
  const samePath = document.createRange()
  samePath.setStart(replacement, 2)
  samePath.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(samePath)
  document.dispatchEvent(new Event('selectionchange'))
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()

  expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(2)
  expect(getValue).toHaveBeenCalledTimes(2)
})

it('keeps selectionchange cheap without revision authority and captures at request', () => {
  state.revision = undefined
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  for (let index = 0; index < 3; index++)
    document.dispatchEvent(new Event('selectionchange'))
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()

  expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
  expect(snapshotExactMarkdown).toHaveBeenCalledTimes(2)
  expect(getValue).toHaveBeenCalledTimes(2)
})

it('retains a live request across QuickPick cancellation and reopens after selection loss', () => {
  const first = requestBlockTransformOptions(window)!
  cancelBlockTransformChoice(first.token)
  const sentinel = document.createRange()
  sentinel.setStart(state.editor!, 0)
  sentinel.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(sentinel)
  document.dispatchEvent(new Event('selectionchange'))

  const second = requestBlockTransformOptions(window)
  expect(second?.span.start).toBe(state.source.indexOf('alpha'))
  state.source = 'changed after the reopened palette\n'
  state.revision = {}
  expect(applyBlockTransformChoice(window, second!.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})

it.each([true, false])(
  'cancels a pending selection after a cheap live selection change with revision authority=%s',
  (revisionAuthority) => {
    if (!revisionAuthority) state.revision = undefined
    const options = requestBlockTransformOptions(window)!
    snapshotExactMarkdown.mockClear()
    getValue.mockClear()
    const moved = document.createRange()
    moved.setStart(state.editor!.firstChild!, 3)
    moved.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(moved)
    document.dispatchEvent(new Event('selectionchange'))

    expect(snapshotExactMarkdown).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
    expect(
      applyBlockTransformChoice(window, options.token, { type: 'h2' }),
    ).toBe(false)
    expect(snapshotExactMarkdown).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
    expect(postExact).not.toHaveBeenCalled()
  },
)

// Real SV capture inserts/removes rewrap markers, so this measures the source-index-invalidating
// path as well as the snapshot calls; a stubbed capture would miss the navigation regression.
function findFocusTransfer() {
  state.realCapture = true
  state.inner.currentMode = 'sv'
  state.inner.sv = { element: state.editor }
  state.editor!.textContent = state.source
  const range = document.createRange()
  range.setStart(state.editor!.firstChild!, state.source.indexOf('beta'))
  range.setEnd(state.editor!.firstChild!, state.source.indexOf('beta') + 4)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  const widget = document.createElement('div')
  widget.className = 'vmde-find-replace'
  const input = document.createElement('input')
  widget.append(input)
  document.body.append(widget)
  const observer = new MutationObserver(() => undefined)
  observer.observe(state.editor!, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  const metrics = { blockTransformCaptureCalls: 0 }
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  snapshotExactMarkdown.mockClear()
  getValue.mockClear()
  state.editor!.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: input }),
  )
  const mutations = observer.takeRecords().length
  observer.disconnect()
  return { metrics, insertNode, mutations }
}

it('defers Find focusout without snapshots, captures or markers and restores the match on request', () => {
  const work = findFocusTransfer()
  expect({
    snapshots: snapshotExactMarkdown.mock.calls.length,
    captures: work.metrics.blockTransformCaptureCalls,
    markers: work.insertNode.mock.calls.length,
    mutations: work.mutations,
    getValue: getValue.mock.calls.length,
  }).toEqual({
    snapshots: 0,
    captures: 0,
    markers: 0,
    mutations: 0,
    getValue: 0,
  })
  getSelection()!.removeAllRanges()
  const result = requestBlockTransformOptions(window)
  expect(result?.span.start).toBe(state.source.indexOf('alpha'))
  expect(getSelection()!.toString()).toBe('beta')
  expect(work.metrics.blockTransformCaptureCalls).toBe(1)
  expect(work.insertNode).toHaveBeenCalledTimes(2)
})

it('declines deferred Find capture without revision authority', () => {
  state.revision = undefined
  findFocusTransfer()
  getSelection()!.removeAllRanges()
  expect(requestBlockTransformOptions(window)).toBeNull()
  expect(snapshotExactMarkdown).not.toHaveBeenCalled()
  expect(getValue).not.toHaveBeenCalled()
})

it.each(['revision', 'detached', 'mode'] as const)(
  'rejects a deferred Find range after a %s change without serializing',
  (change) => {
    findFocusTransfer()
    getSelection()!.removeAllRanges()
    if (change === 'revision') state.revision = {}
    if (change === 'detached') state.editor!.remove()
    if (change === 'mode') state.inner.currentMode = 'wysiwyg'
    snapshotExactMarkdown.mockClear()
    getValue.mockClear()
    expect(requestBlockTransformOptions(window)).toBeNull()
    expect(snapshotExactMarkdown).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
  },
)

it.each(['body', 'null'] as const)(
  'keeps eager capture for focusout to %s',
  (target) => {
    const metrics = { blockTransformCaptureCalls: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    state.editor!.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: target === 'body' ? document.body : null,
      }),
    )
    expect(snapshotExactMarkdown).toHaveBeenCalledTimes(1)
    expect(metrics.blockTransformCaptureCalls).toBe(1)
  },
)
