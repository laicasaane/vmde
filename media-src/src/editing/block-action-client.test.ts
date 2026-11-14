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
  refuseUnits: false,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('../nav/block-handle', () => ({
  currentBlockProjection: () => null,
  // One unit per paragraph of the exact source passed in, so a unit list proves which bytes the
  // client planned on.
  resolveBlockHandleUnits: (_root: HTMLElement, exact: string) => {
    state.unitCalls.push(exact)
    if (state.refuseUnits) return null
    return [...exact.matchAll(/[^\n]+/gu)].map((match) => {
      const element = document.createElement('p')
      element.textContent = match[0]
      return {
        element,
        kind:
          match.index === 0 && exact.startsWith('---')
            ? 'front-matter'
            : 'paragraph',
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
  state.refuseUnits = false
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

it('re-adopts confirmed front matter bytes after a block move before a later save can serialize them', async () => {
  const prefix = '---\ntitle: doc\n---\n\n'
  const before = prefix + HOST
  const canonical = (value: string) => value.replace('---\n\n', '---\n')
  owned = before
  rendered = canonical(before)
  acquire.mockResolvedValue({ exact: before, rendered })
  setValue.mockImplementation((value: string) => {
    rendered = canonical(value)
  })
  const reown = vi.fn((value: string) => {
    owned = value
  })
  dispose?.()
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    reown,
    onError: vi.fn(),
  })
  const action = {
    ...ACTION,
    sourceStart: prefix.length,
    targetStart: prefix.length + 6,
  }
  const done = requestBlockAction(action, { exact: before })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  const request = requests()[0]
  const plan = planBlockAction(before, action)
  if (plan.status !== 'ok') throw new Error('fixture move must plan')
  prepareBlockAction({
    command: 'prepare-block-action',
    requestId: request.requestId,
    uri: 'file:///doc.md',
    version: 1,
    before,
    after: plan.markdown,
    caretOffset: plan.caretOffset,
  } as never)
  expect(reown).not.toHaveBeenCalled()
  finishBlockAction({
    command: 'block-action-outcome',
    requestId: request.requestId,
    status: 'applied',
    content: plan.markdown,
  } as never)
  await expect(done).resolves.toBe(true)
  expect(reown).toHaveBeenCalledExactlyOnceWith(plan.markdown)
  expect(owned?.startsWith(prefix)).toBe(true)
})

// Task 733 / 010-T (Q-31, Q-79 OQ-1): while the text model owns the text, the action plans on the
// confirmed model units, applies `after` by units and posts the change as a delta; the host binding is
// cancelled. No whole-document read on that route.
function modelRoute(applied: 'applied' | 'fallback' = 'applied') {
  const getValue = vi.fn(() => rendered)
  ;(window as any).vditor = { getValue, setValue }
  const units = [...HOST.matchAll(/[^\n]+/gu)].map((match) => {
    const element = document.createElement('p')
    element.textContent = match[0]
    state.editor!.append(element)
    return {
      element,
      members: [element],
      kind: 'paragraph' as const,
      start: match.index!,
      end: match.index! + match[0].length,
      movable: true,
    }
  })
  const applyExactText = vi.fn(
    (_after: string, _opts?: { rollback?: { restore(): void } }) => applied,
  )
  dispose?.()
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    onError: vi.fn(),
    applyExactText,
    modelUnits: () => ({ exact: HOST, units }),
  })
  return { getValue, applyExactText, units }
}

async function preparedOnModelRoute(t: ReturnType<typeof modelRoute>) {
  const done = requestBlockAction(ACTION, { exact: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  const request = requests()[0]
  const plan = planBlockAction(HOST, ACTION)
  if (plan.status !== 'ok') throw new Error('fixture move must plan')
  prepareBlockAction({
    command: 'prepare-block-action',
    requestId: request.requestId,
    uri: 'file:///doc.md',
    version: 1,
    before: HOST,
    after: plan.markdown,
    caretOffset: plan.caretOffset,
  } as never)
  return { done, request, after: plan.markdown, t }
}

it('plans on the model units without a whole-document read while the model owns the text', async () => {
  const t = modelRoute()
  const done = requestBlockAction(ACTION, { exact: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  expect(requests()[0].before).toBe(HOST)
  expect(state.unitCalls).toEqual([])
  expect(t.getValue).not.toHaveBeenCalled()
  cancelPendingBlockActions()
  await expect(done).resolves.toBe(false)
})

it('applies a prepared action by units, cancels the host binding and posts no apply-block-action', async () => {
  const t = modelRoute()
  const undoBefore = state.inner.undo.ir.undoStack.length
  const { done, request, after } = await preparedOnModelRoute(t)
  expect(t.applyExactText).toHaveBeenCalledTimes(1)
  expect(t.applyExactText.mock.calls[0][0]).toBe(after)
  expect(setValue).not.toHaveBeenCalled()
  const commands = post.mock.calls.map(([message]) => message.command)
  expect(commands).not.toContain('apply-block-action')
  expect(post).toHaveBeenCalledWith({
    command: 'cancel-block-action',
    requestId: request.requestId,
  })
  // One checkpoint before and one after the apply: the unit engine records the move as one entry.
  expect(state.inner.undo.ir.undoStack.length).toBe(undoBefore + 2)
  await expect(done).resolves.toBe(true)
  expect(t.getValue).not.toHaveBeenCalled()
  expect(state.unitCalls).toEqual([])
})

// Q-82 (010-R N2): a fallback runs today's route on a rendering proven to be `before`.
it("runs today's setValue and apply-block-action route when the apply falls back on a proven rendering", async () => {
  const t = modelRoute('fallback')
  const undoBefore = state.inner.undo.ir.undoStack.length
  const { request, after } = await preparedOnModelRoute(t)
  expect(t.applyExactText).toHaveBeenCalledTimes(1)
  expect(setValue).toHaveBeenLastCalledWith(after)
  const apply = post.mock.calls
    .map(([message]) => message)
    .find((message) => message.command === 'apply-block-action')
  expect(apply).toMatchObject({ requestId: request.requestId, after })
  // The empty checkpoint before the apply, then today's two.
  expect(state.inner.undo.ir.undoStack.length).toBe(undoBefore + 3)
  cancelPendingBlockActions()
})

it('declines without setValue when the apply falls back and the rendering is not proven (010-R F1, N2)', async () => {
  const t = modelRoute('fallback')
  const done = requestBlockAction(ACTION, { exact: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  const request = requests()[0]
  const plan = planBlockAction(HOST, ACTION)
  if (plan.status !== 'ok') throw new Error('fixture move must plan')
  state.refuseUnits = true
  prepareBlockAction({
    command: 'prepare-block-action',
    requestId: request.requestId,
    uri: 'file:///doc.md',
    version: 1,
    before: HOST,
    after: plan.markdown,
    caretOffset: plan.caretOffset,
  } as never)
  expect(setValue).not.toHaveBeenCalled()
  expect(post.mock.calls.map(([m]) => m.command)).not.toContain(
    'apply-block-action',
  )
  expect(post).toHaveBeenCalledWith({
    command: 'cancel-block-action',
    requestId: request.requestId,
  })
  await expect(done).resolves.toBe(false)
  expect(t.getValue).toHaveBeenCalled()
})

it('declines without setValue when a unit is dirty at prepare (010-R F1)', async () => {
  const t = modelRoute()
  let confirmed: string | undefined = HOST
  dispose?.()
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    onError: vi.fn(),
    applyExactText: t.applyExactText,
    modelUnits: () => ({ exact: HOST, units: t.units }),
    modelText: () => confirmed,
  })
  const done = requestBlockAction(ACTION, { exact: HOST })
  await vi.waitFor(() => expect(requests()).toHaveLength(1))
  const request = requests()[0]
  const plan = planBlockAction(HOST, ACTION)
  if (plan.status !== 'ok') throw new Error('fixture move must plan')
  // Typing in a unit that no publication took yet: the confirmed text is gone.
  confirmed = undefined
  prepareBlockAction({
    command: 'prepare-block-action',
    requestId: request.requestId,
    uri: 'file:///doc.md',
    version: 1,
    before: HOST,
    after: plan.markdown,
    caretOffset: plan.caretOffset,
  } as never)
  expect(t.applyExactText).not.toHaveBeenCalled()
  expect(setValue).not.toHaveBeenCalled()
  expect(post).toHaveBeenCalledWith({
    command: 'cancel-block-action',
    requestId: request.requestId,
  })
  await expect(done).resolves.toBe(false)
})

it('reads the model units once to plan and once to place the caret (010-R F12)', async () => {
  const t = modelRoute()
  const modelUnits = vi.fn(() => ({ exact: HOST, units: t.units }))
  dispose?.()
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    onError: vi.fn(),
    applyExactText: t.applyExactText,
    modelUnits,
    modelText: () => HOST,
  })
  const { done } = await preparedOnModelRoute(t)
  await expect(done).resolves.toBe(true)
  expect(modelUnits).toHaveBeenCalledTimes(2)
})

it('places the caret from the plan when no model units are confirmed after the apply (010-R N6)', async () => {
  const t = modelRoute()
  let calls = 0
  dispose?.()
  dispose = configureBlockActionClient({
    settleInput: vi.fn(),
    snapshotExactMarkdown: () => owned,
    acquireExactAuthority: acquire,
    setApplying: vi.fn(),
    onError: vi.fn(),
    applyExactText: t.applyExactText,
    // Confirmed for the plan, not after the apply (a new unit committed opaque).
    modelUnits: () =>
      calls++ === 0 ? { exact: HOST, units: t.units } : undefined,
    modelText: () => HOST,
  })
  const { done } = await preparedOnModelRoute(t)
  await expect(done).resolves.toBe(true)
  // The caret fallback resolved units on the planned bytes.
  expect(state.unitCalls.length).toBeGreaterThan(0)
  expect(setValue).not.toHaveBeenCalled()
})
