// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./caret', () => ({ requestCaret: vi.fn(() => true) }))
vi.mock('../chrome/toolbar-scroll-guard', () => ({
  findScroller: vi.fn(() => ({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  })),
}))
vi.mock('../util/caret-gesture', () => ({
  isCompositionActive: vi.fn(() => false),
}))
vi.mock('./table-actions', () => ({
  snapshotTableUndoForRollback: vi.fn(() => 'SNAPSHOT'),
  restoreTableUndoForRollback: vi.fn(),
}))
// Partial mock: checkpoint and history plumbing are covered by rewrap-command.test.ts; the caret
// line mapping stays real because the command's offset math depends on it.
vi.mock('./rewrap-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rewrap-command')>()
  return {
    ...actual,
    checkpointEditorUndo: vi.fn(),
    recordRewrapDocumentHistory: vi.fn(),
  }
})

import {
  captureSourceListSvSelection,
  configureSourceListCommand,
  runSourceListCommand,
} from './list-normalize-source-command'

// Task 630 S1 (RED): the SV list command acquires exact authority inside the command, plans on the
// acquired exact text and posts with a rollback. `configureSourceListCommand` has no acquire seam yet,
// so `acquireExactAuthority` and `postExact(markdown, opts)` are declared here and cast onto the
// product type. SV text is the LF-normalized source: a CRLF host differs from the editor text.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type Deps = Parameters<typeof configureSourceListCommand>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

const HOST_EXACT = 'Intro\r\n\r\n1. one\r\n3. two\r\n\r\nTail\r\n'
const HOST_NORMALIZED = 'Intro\r\n\r\n1. one\r\n2. two\r\n\r\nTail\r\n'
const lf = (text: string) => text.replace(/\r\n|\r/gu, '\n')
const RENDERED = lf(HOST_EXACT)

let editor: HTMLPreElement
let host: { text: string; owned: string | null; restored: number }
let acquireExactAuthority: ReturnType<
  typeof vi.fn<() => Promise<AcquiredPair | null>>
>
let postExact: ReturnType<typeof vi.fn<(m: string, o?: ExactEdit) => void>>
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  editor = document.createElement('pre')
  editor.contentEditable = 'true'
  editor.textContent = RENDERED
  document.body.append(editor)
  const inner = {
    currentMode: 'sv',
    sv: { element: editor },
    undo: { sv: { undoStack: [{ marker: 'native' }] } },
  }
  ;(window as any).vditor = { vditor: inner }
  host = { text: HOST_EXACT, owned: null, restored: 0 }
  acquireExactAuthority = vi.fn(async () => {
    host.owned = host.text
    return { exact: host.text, rendered: editor.textContent ?? '' }
  })
  postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      editor.textContent = lf(host.text)
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  onError = vi.fn()
  configureSourceListCommand({
    // The legacy source after a trusted edit: the LF editor text, not the host bytes.
    snapshotExactMarkdown: () => editor.textContent ?? '',
    setApplying: vi.fn(),
    postExact,
    acquireExactAuthority,
    onError,
  } as Deps)
  const text = editor.firstChild as Text
  const range = document.createRange()
  const caret = RENDERED.indexOf('3. two') + 2
  range.setStart(text, caret)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  expect(captureSourceListSvSelection()).toBe(true)
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as any).vditor
})

describe('SV list normalize exact authority (Task 630)', () => {
  test('acquires authority and renumbers on the acquired CRLF host text, posting with a rollback', async () => {
    expect(await runSourceListCommand(window, 'caret')).toBe(1)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).toHaveBeenCalledOnce()
    // Every byte outside the renumbered line, including the CRLF line ends, is the host's.
    expect(postExact.mock.calls[0][0]).toBe(HOST_NORMALIZED)
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(host.text).toBe(HOST_NORMALIZED)
    expect(editor.textContent).toBe(lf(HOST_NORMALIZED))
  })

  test('refuses a stale host: no write, the rollback runs and the editor shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\r\n`
    acquireExactAuthority.mockImplementationOnce(async () => {
      host.owned = HOST_EXACT
      host.text = drifted
      return { exact: HOST_EXACT, rendered: editor.textContent ?? '' }
    })

    await runSourceListCommand(window, 'caret')

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(host.restored).toBe(1)
    expect(host.text).toBe(drifted)
    expect(editor.textContent).toBe(lf(drifted))
  })

  test('declines without a write or a DOM change when acquisition fails', async () => {
    acquireExactAuthority.mockResolvedValueOnce(null)

    expect(await runSourceListCommand(window, 'caret')).toBe(0)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).not.toHaveBeenCalled()
    expect(editor.textContent).toBe(RENDERED)
    expect(onError).not.toHaveBeenCalled()
  })
})
