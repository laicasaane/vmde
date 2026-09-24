// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
} from './block-transform-command'

const state = vi.hoisted(() => ({
  inner: null as any,
  editor: null as HTMLElement | null,
  source: 'before\n\nalpha **beta**\n\nafter\n',
  caret: 0,
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

beforeEach(() => {
  state.source = 'before\n\nalpha **beta**\n\nafter\n'
  state.caret = state.source.indexOf('beta') + 2
  const editor = document.createElement('pre')
  editor.contentEditable = 'true'
  editor.textContent = 'beta'
  document.body.append(editor)
  state.editor = editor
  state.inner = { currentMode: 'ir' }
  ;(window as any).vditor = {
    getValue: () => state.source,
    vditor: state.inner,
  }
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  postExact = vi.fn((_markdown: string) => undefined)
  dispose = configureBlockTransformCommand({
    snapshotExactMarkdown: () => state.source,
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
  expect(applyBlockTransformChoice(window, second.token, { type: 'h2' })).toBe(
    false,
  )
  expect(postExact).not.toHaveBeenCalled()
})

it('keeps a retained source target through a root-zero focus sentinel', () => {
  const range = document.createRange()
  range.setStart(state.editor!, 0)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  expect(requestBlockTransformOptions(window)?.currentType).toBe('paragraph')
})
