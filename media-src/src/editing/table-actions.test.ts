// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { configureTableActions, runTableMove } from './table-actions'

// Task 607: the table move acquires exact authority before it plans, and a host refusal restores
// what the action changed besides the DOM.
const state = vi.hoisted(() => ({
  inner: null as any,
  editor: null as HTMLElement | null,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('./caret', () => ({ requestCaret: vi.fn() }))
vi.mock('./rewrap-command', () => ({
  checkpointEditorUndo: vi.fn(),
  recordRewrapDocumentHistory: vi.fn(),
}))

const SOURCE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
const MOVED_RIGHT = '| b | a |\n| --- | --- |\n| 2 | 1 |\n'

type Pair = { exact: string; rendered: string }
let owned: string | null
let rendered: string
let setValue: Mock<(value: string) => void>
let postExact: Mock<
  (markdown: string, opts?: { rollback?: { restore(): void } }) => void
>
let acquire: ReturnType<typeof vi.fn<() => Promise<Pair | null>>>
let onError: Mock<(error: unknown) => void>
let table: HTMLTableElement

beforeEach(() => {
  owned = SOURCE
  rendered = SOURCE
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.innerHTML =
    '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  document.body.append(editor)
  state.editor = editor
  table = editor.querySelector('table')!
  state.inner = {
    currentMode: 'ir',
    undo: {
      ir: {
        undoStack: ['u1'],
        redoStack: ['r1'],
        lastText: 'last',
        hasUndo: true,
      },
    },
  }
  setValue = vi.fn<(value: string) => void>((value) => {
    rendered = value
    // The action's own rebuild leaves new Undo state behind, as Vditor's checkpoints do.
    state.inner.undo.ir.undoStack = ['u1', 'u2']
    state.inner.undo.ir.redoStack = []
    state.inner.undo.ir.lastText = 'changed'
  })
  ;(window as any).vditor = { getValue: () => rendered, setValue }
  postExact = vi.fn()
  acquire = vi.fn<() => Promise<Pair | null>>()
  onError = vi.fn()
  configureTableActions({
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    postExact,
    onError,
    checkpointUndo: vi.fn(),
  })
  const cell = table.querySelector('th')!
  const range = document.createRange()
  range.setStart(cell.firstChild!, 0)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as any).vditor
  state.editor = null
  getSelection()?.removeAllRanges()
})

it('plans at once on owned exact bytes without asking for authority', () => {
  expect(runTableMove('moveColumnRight')).toBe(true)
  expect(acquire).not.toHaveBeenCalled()
  expect(setValue).toHaveBeenCalledExactlyOnceWith(MOVED_RIGHT)
  expect(postExact).toHaveBeenCalledExactlyOnceWith(MOVED_RIGHT, {
    rollback: { restore: expect.any(Function) },
  })
})

it('asks the host once when no exact source is owned and plans on the adopted bytes', async () => {
  owned = null
  acquire.mockImplementation(async () => {
    owned = SOURCE
    return { exact: SOURCE, rendered: SOURCE }
  })
  expect(runTableMove('moveColumnRight')).toBe(true)
  expect(setValue).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(postExact).toHaveBeenCalledOnce())
  expect(acquire).toHaveBeenCalledOnce()
  expect(setValue).toHaveBeenCalledExactlyOnceWith(MOVED_RIGHT)
  expect(postExact.mock.calls[0][0]).toBe(MOVED_RIGHT)
})

it('declines with no DOM change and no post when authority is refused', async () => {
  owned = null
  acquire.mockResolvedValue(null)
  const before = state.editor!.innerHTML
  runTableMove('moveColumnRight')
  await acquire.mock.results[0].value
  await Promise.resolve()
  expect(setValue).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
  expect(state.editor!.innerHTML).toBe(before)
  expect(onError).not.toHaveBeenCalled()
})

it('declines without a request seam when no exact source is owned', () => {
  owned = null
  configureTableActions({
    snapshotExactMarkdown: () => owned,
    setApplying: vi.fn(),
    postExact,
    onError,
  })
  expect(runTableMove('moveColumnRight')).toBe(false)
  expect(setValue).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
})

it('declines when the table is gone after the wait', async () => {
  owned = null
  let resolve!: (pair: Pair | null) => void
  acquire.mockReturnValue(new Promise<Pair | null>((done) => (resolve = done)))
  runTableMove('moveColumnRight')
  table.remove()
  owned = SOURCE
  resolve({ exact: SOURCE, rendered: SOURCE })
  await Promise.resolve()
  await Promise.resolve()
  expect(setValue).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
})

it('declines when ownership is lost again during the wait (typed meanwhile)', async () => {
  owned = null
  acquire.mockResolvedValue({ exact: SOURCE, rendered: SOURCE })
  runTableMove('moveColumnRight')
  await acquire.mock.results[0].value
  await Promise.resolve()
  // Still unowned after the wait: no second request, nothing written.
  expect(acquire).toHaveBeenCalledOnce()
  expect(setValue).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
})

it('restores the Undo stacks when the host refuses the edit', () => {
  runTableMove('moveColumnRight')
  const rollback = postExact.mock.calls[0][1].rollback as { restore(): void }
  expect(state.inner.undo.ir.undoStack).toEqual(['u1', 'u2'])
  rollback.restore()
  expect(state.inner.undo.ir.undoStack).toEqual(['u1'])
  expect(state.inner.undo.ir.redoStack).toEqual(['r1'])
  expect(state.inner.undo.ir.lastText).toBe('last')
})
