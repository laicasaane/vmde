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
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('./rewrap-command', () => ({
  captureRewrapSourceSelection: () => ({
    markdown: state.source,
    startOffset: state.caret,
    endOffset: state.caret,
    caretOffset: state.caret,
  }),
  checkpointEditorUndo: vi.fn(),
  recordRewrapDocumentHistory: vi.fn(),
  replaceSvMarkdownRange: vi.fn(),
}))

let dispose: (() => void) | undefined
let postExact = vi.fn((_markdown: string) => undefined)
let snapshotExactMarkdown = vi.fn(() => state.source)
let getValue = vi.fn(() => state.source)

beforeEach(() => {
  state.source = 'before\n\nalpha **beta**\n\nafter\n'
  state.caret = state.source.indexOf('beta') + 2
  state.revision = {}
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
  state.editor?.remove()
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

it('keeps a retained source target through a root-zero focus sentinel', () => {
  state.editor!.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
  )
  const range = document.createRange()
  range.setStart(state.editor!, 0)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
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

it('cancels a pending selection request after a cheap live selection change', () => {
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
  expect(applyBlockTransformChoice(window, options.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})
