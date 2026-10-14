// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { planBlockAction } from '../../../src/shared/block-move'
import {
  acquireBlockActionAuthority,
  cancelPendingBlockActions,
  configureBlockActionClient,
  finishBlockAction,
  prepareBlockAction,
  requestBlockAction,
} from './block-action-client'

// Task 607: Move Block pulls the host's bytes (never a rebased pair) before it plans, recomputes
// the block units on them, and keeps its two-phase rollback.
const state = vi.hoisted(() => ({
  inner: null as any,
  editor: null as HTMLElement | null,
  unitCalls: [] as string[],
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('../nav/block-handle', () => ({
  currentBlockProjection: () => null,
  // One unit per paragraph of the exact source passed in, so a unit list proves which bytes the
  // client planned on.
  resolveBlockHandleUnits: (_root: HTMLElement, exact: string) => {
    state.unitCalls.push(exact)
    return [...exact.matchAll(/[^\n]+/gu)].map((match) => {
      const element = document.createElement('p')
      element.textContent = match[0]
      return {
        element,
        start: match.index!,
        end: match.index! + match[0].length,
      }
    })
  },
}))
vi.mock('./rewrap-command', () => ({
  checkpointEditorUndo: (inner: any) => {
    inner.undo.ir.undoStack.push({ checkpoint: inner.undo.ir.undoStack.length })
  },
  recordRewrapDocumentHistory: vi.fn(),
}))

const HOST = 'a\n\nb\n\nc\n'
const MOVE_A_AFTER_C = { kind: 'move', sourceStart: 0, targetStart: 6 } as const
const ACTION = { ...MOVE_A_AFTER_C, placement: 'after' } as const
type Pair = { exact: string; rendered: string }

let owned: string | null
let rendered: string
let acquire: ReturnType<
  typeof vi.fn<(opts: { publish: true }) => Promise<Pair | null>>
>
let setValue: ReturnType<typeof vi.fn>
let post: ReturnType<typeof vi.fn>
let dispose: (() => void) | undefined

beforeEach(() => {
  state.unitCalls = []
  owned = HOST
  rendered = HOST
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  document.body.append(editor)
  state.editor = editor
  state.inner = {
    currentMode: 'ir',
    undo: {
      ir: {
        undoStack: [{ id: 'u1' }],
        redoStack: [{ id: 'r1' }],
        lastText: 'last',
        hasUndo: true,
      },
    },
  }
  setValue = vi.fn((value: string) => {
    rendered = value
  })
  ;(window as any).vditor = { getValue: () => rendered, setValue }
  post = vi.fn()
  ;(window as any).vscode = { postMessage: post }
  ;(globalThis as any).vscode = (window as any).vscode
  acquire = vi.fn(async () => ({ exact: HOST, rendered: HOST }))
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    onError: vi.fn(),
  })
})

afterEach(() => {
  cancelPendingBlockActions()
  dispose?.()
  document.body.replaceChildren()
  delete (window as any).vditor
  state.editor = null
})

const requests = () =>
  post.mock.calls
    .map(([message]) => message)
    .filter((message) => message.command === 'request-block-action')

it('always pulls the host bytes, even when exact bytes are owned, and plans on them', async () => {
  const HOST_AFTER_TYPING = 'a\n\nb2\n\nc\n'
  owned = HOST
  acquire.mockResolvedValue({
    exact: HOST_AFTER_TYPING,
    rendered: HOST_AFTER_TYPING,
  })
  rendered = HOST_AFTER_TYPING
  const done = requestBlockAction(
    { ...ACTION, targetStart: 7 },
    { exact: HOST_AFTER_TYPING },
  )
  expect(acquire).toHaveBeenCalledExactlyOnceWith({ publish: true })
  // The units are recomputed on the acquired bytes, after the wait.
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  expect(state.unitCalls).toEqual([HOST_AFTER_TYPING])
  expect(requests()[0].before).toBe(HOST_AFTER_TYPING)
  cancelPendingBlockActions()
  await expect(done).resolves.toBe(false)
})

it('declines with no DOM change and no request when authority is refused', async () => {
  acquire.mockResolvedValue(null)
  const before = state.editor!.innerHTML
  await expect(requestBlockAction(ACTION, { exact: HOST })).resolves.toBe(false)
  expect(requests()).toHaveLength(0)
  expect(setValue).not.toHaveBeenCalled()
  expect(state.editor!.innerHTML).toBe(before)
})

it('declines when the editor was replaced during the wait', async () => {
  let resolve!: (pair: Pair | null) => void
  acquire.mockReturnValue(new Promise<Pair | null>((done) => (resolve = done)))
  const done = requestBlockAction(ACTION, { exact: HOST })
  const replacement = document.createElement('div')
  replacement.contentEditable = 'true'
  document.body.append(replacement)
  state.editor = replacement
  resolve({ exact: HOST, rendered: HOST })
  await expect(done).resolves.toBe(false)
  expect(requests()).toHaveLength(0)
})

it('allows one request at a time while it waits for the host bytes', async () => {
  let resolve!: (pair: Pair | null) => void
  acquire.mockReturnValue(new Promise<Pair | null>((done) => (resolve = done)))
  const first = requestBlockAction(ACTION, { exact: HOST })
  await expect(requestBlockAction(ACTION, { exact: HOST })).resolves.toBe(false)
  expect(acquire).toHaveBeenCalledOnce()
  resolve({ exact: HOST, rendered: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  cancelPendingBlockActions()
  await expect(first).resolves.toBe(false)
})

it('exposes the same publish acquisition to the keyboard move', async () => {
  await expect(acquireBlockActionAuthority()).resolves.toEqual({
    exact: HOST,
    rendered: HOST,
  })
  expect(acquire).toHaveBeenCalledExactlyOnceWith({ publish: true })
})

it('keeps the two-phase rollback: a stale outcome restores the DOM and the Undo stacks', async () => {
  const done = requestBlockAction(ACTION, { exact: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  const request = requests()[0]
  const plan = planBlockAction(HOST, ACTION)
  if (plan.status !== 'ok') throw new Error('fixture move must plan')
  const after = plan.markdown
  prepareBlockAction({
    command: 'prepare-block-action',
    requestId: request.requestId,
    uri: 'file:///doc.md',
    version: 1,
    before: HOST,
    after,
    caretOffset: plan.caretOffset,
  } as never)
  expect(setValue).toHaveBeenLastCalledWith(after)
  expect(
    post.mock.calls.some(([m]) => m.command === 'apply-block-action'),
  ).toBe(true)
  expect(state.inner.undo.ir.undoStack.length).toBeGreaterThan(1)

  finishBlockAction({
    command: 'block-action-outcome',
    requestId: request.requestId,
    status: 'stale',
    content: HOST,
  } as never)
  await expect(done).resolves.toBe(false)
  expect(setValue).toHaveBeenLastCalledWith(HOST)
  expect(state.inner.undo.ir.undoStack).toEqual([{ id: 'u1' }])
  expect(state.inner.undo.ir.redoStack).toEqual([{ id: 'r1' }])
})

// The offsets of an action belong to the bytes they were computed on (the basis). The host's
// bytes can differ after the wait (here: a line inserted before the target).
const HOST_WITH_INSERT = 'a\n\nINS\n\nb\n\nc\n'

it('never reuses old offsets on host bytes that differ from the basis', async () => {
  acquire.mockResolvedValue({
    exact: HOST_WITH_INSERT,
    rendered: HOST_WITH_INSERT,
  })
  rendered = HOST_WITH_INSERT
  const before = state.editor!.innerHTML
  await expect(requestBlockAction(ACTION, { exact: HOST })).resolves.toBe(false)
  expect(requests()).toHaveLength(0)
  expect(setValue).not.toHaveBeenCalled()
  expect(state.editor!.innerHTML).toBe(before)
})

it('re-derives the action from the caller on the host bytes when the basis differs', async () => {
  acquire.mockResolvedValue({
    exact: HOST_WITH_INSERT,
    rendered: HOST_WITH_INSERT,
  })
  rendered = HOST_WITH_INSERT
  const rederive = vi.fn((pair: Pair) => ({
    kind: 'move' as const,
    sourceStart: 0,
    targetStart: pair.exact.indexOf('c\n'),
    placement: 'after' as const,
  }))
  const done = requestBlockAction(ACTION, { exact: HOST, rederive })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  expect(rederive).toHaveBeenCalledExactlyOnceWith({
    exact: HOST_WITH_INSERT,
    rendered: HOST_WITH_INSERT,
  })
  expect(requests()[0].before).toBe(HOST_WITH_INSERT)
  // The block at the old target offset (6) is not the one moved after.
  expect(requests()[0].action.targetStart).toBe(HOST_WITH_INSERT.indexOf('c\n'))
  expect(requests()[0].action.targetStart).not.toBe(ACTION.targetStart)
  cancelPendingBlockActions()
  await expect(done).resolves.toBe(false)
})

it('declines when the caller cannot re-derive on the host bytes', async () => {
  acquire.mockResolvedValue({
    exact: HOST_WITH_INSERT,
    rendered: HOST_WITH_INSERT,
  })
  rendered = HOST_WITH_INSERT
  await expect(
    requestBlockAction(ACTION, { exact: HOST, rederive: () => null }),
  ).resolves.toBe(false)
  expect(requests()).toHaveLength(0)
})
