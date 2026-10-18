// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
// Partial mock: checkpointEditorUndo/recordRewrapDocumentHistory are pure side-effect/history
// plumbing this command delegates to (already covered by rewrap-command.test.ts); mapCaretOffsetByLine
// stays REAL because runTableFormatCommand's own before/after caret remapping depends on its actual
// line-matching behavior, not a stand-in.
vi.mock('./rewrap-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rewrap-command')>()
  return {
    ...actual,
    checkpointEditorUndo: vi.fn(),
    recordRewrapDocumentHistory: vi.fn(),
  }
})

import {
  captureTableFormatSvSelection,
  configureTableFormatCommand,
  runTableFormatCommand,
} from './table-format-command'
import { requestCaret } from './caret'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import { restoreTableUndoForRollback } from './table-actions'
import { isCompositionActive } from '../util/caret-gesture'

// One caret-formatted, one-cell-per-line table: `before\n\n|a|b|\n|-|-|\n|1|2|\n\nafter\n`. The fake
// FormatStr below swaps 'a' -> 'A' without changing any line's length, so the SAME source acts as
// both the rendered SV text and the "authoritative"/exact snapshot in every test (deps.snapshotExactMarkdown
// reads editor.textContent directly) -- mapCaretOffsetByLine(x, x, offset) is an identity when its
// two markdown arguments are equal (real behavior, verified against the source), so every caret math
// below reduces to plain string offsets instead of needing a real Lute round trip.
const SOURCE = 'before\n\n|a|b|\n|-|-|\n|1|2|\n\nafter\n'
const FORMATTED = 'before\n\n|A|b|\n|-|-|\n|1|2|\n\nafter\n'
const CARET_IN_TABLE = SOURCE.indexOf('|a|') + 1 // right after the opening pipe, before "a"

function makeEditor(text: string = SOURCE): HTMLPreElement {
  const pre = document.createElement('pre')
  pre.contentEditable = 'true'
  pre.textContent = text
  document.body.append(pre)
  return pre
}

function setCaret(editor: HTMLElement, start: number, end = start): void {
  const range = document.createRange()
  range.setStart(editor.firstChild as Text, start)
  range.setEnd(editor.firstChild as Text, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

describe('table-format-command', () => {
  let editor: HTMLPreElement
  let inner: {
    currentMode: string
    sv: { element: HTMLElement }
    lute: { FormatStr(origin: string, table: string): string }
    undo: { sv: { undoStack: unknown[] } }
  }
  // Typed inline (not `ReturnType<typeof vi.fn>`, too generic to satisfy TableFormatCommandDeps)
  // so configureTableFormatCommand's parameter types check, matching block-transform-command.test.ts.
  // The exact text the fake acquisition returns; tests override it once to simulate a changed host.
  let acquiredExact = vi.fn((): string => '')
  let postExact = vi.fn(
    (_markdown: string, _opts: { rollback: { restore(): void } }) => undefined,
  )
  let setApplying = vi.fn((_value: boolean) => undefined)
  let onError = vi.fn((_error: unknown) => undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    editor = makeEditor()
    inner = {
      currentMode: 'sv',
      sv: { element: editor },
      lute: { FormatStr: (_origin, table) => table.replace(/a/gu, 'A') },
      // One native undo entry so recordRewrapDocumentHistory's `undoStack.at(-1)` guard finds a
      // state to record against -- checkpointEditorUndo is mocked to a no-op, so nothing pushes a
      // new one during the run itself.
      undo: { sv: { undoStack: [{ marker: 'native' }] } },
    }
    ;(window as any).vditor = { vditor: inner }
    acquiredExact = vi.fn(() => editor.textContent ?? '')
    postExact = vi.fn(
      (_markdown: string, _opts: { rollback: { restore(): void } }) =>
        undefined,
    )
    setApplying = vi.fn((_value: boolean) => undefined)
    onError = vi.fn((_error: unknown) => undefined)
    configureTableFormatCommand({
      acquireExactAuthority: async () => {
        const text = acquiredExact()
        return { exact: text, rendered: editor.textContent ?? '' }
      },
      setApplying,
      postExact,
      onError,
    })
  })

  describe('captureTableFormatSvSelection', () => {
    test('returns true for a caret inside the table', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
    })

    test('returns false in non-SV mode', () => {
      inner.currentMode = 'ir'
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(false)
    })

    test('returns false for a range outside the editor', () => {
      const outside = document.createElement('div')
      outside.textContent = 'zzz'
      document.body.append(outside)
      const range = document.createRange()
      range.setStart(outside.firstChild!, 0)
      range.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      expect(captureTableFormatSvSelection()).toBe(false)
    })

    test('returns false for the collapsed editor-root sentinel', () => {
      const sentinel = document.createRange()
      sentinel.setStart(editor, 0)
      sentinel.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(sentinel)
      expect(captureTableFormatSvSelection()).toBe(false)
    })

    test('returns false before configureTableFormatCommand has ever run', async () => {
      // `deps` lives in module scope (set only by configureTableFormatCommand), so the only way
      // to observe its unconfigured default is a genuinely fresh module instance -- resetModules
      // plus a dynamic import, per this module's own "deps/retained in module scope" shape. The
      // vi.mock calls above still apply: they are hoisted and keyed by specifier, not by instance.
      vi.resetModules()
      const fresh = await import('./table-format-command')
      setCaret(editor, CARET_IN_TABLE)
      expect(fresh.captureTableFormatSvSelection()).toBe(false)
    })
  })

  describe('runTableFormatCommand happy path', () => {
    test('formats the retained table through one exact history edit and restores the caret', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)

      expect(await runTableFormatCommand(window)).toBe(true)

      expect(editor.textContent).toBe(FORMATTED)
      expect(postExact).toHaveBeenCalledTimes(1)
      expect(postExact).toHaveBeenCalledWith(FORMATTED, {
        rollback: { restore: expect.any(Function) },
      })
      expect(setApplying.mock.calls).toEqual([[true], [false]])
      expect(checkpointEditorUndo).toHaveBeenCalledTimes(2)
      expect(recordRewrapDocumentHistory).toHaveBeenCalledTimes(1)
      expect(recordRewrapDocumentHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: inner,
          mode: 'sv',
          nativeState: { marker: 'native' },
          beforeRendered: SOURCE,
          beforeExact: SOURCE,
          afterRendered: FORMATTED,
          afterExact: FORMATTED,
        }),
      )
      // The fake formatter doesn't reflow the table, so the caret returns to the same offset.
      expect(requestCaret).toHaveBeenCalledWith({ textOffset: CARET_IN_TABLE })

      // The retained selection was consumed by the first run; a second run has nothing to apply.
      expect(await runTableFormatCommand(window)).toBe(false)
    })
  })

  describe('runTableFormatCommand guards (no postExact)', () => {
    test('exact bytes changed after capture', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // The acquired exact text differs from the editor text beyond line endings: decline.
      acquiredExact.mockReturnValueOnce('changed externally\n')
      expect(await runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
      expect(editor.textContent).toBe(SOURCE)
    })

    test('editor text changed after capture', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      editor.textContent = 'a real external DOM edit\n'
      expect(await runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('editor is contenteditable="false"', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      editor.setAttribute('contenteditable', 'false')
      expect(await runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('composition is active', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // Once, not a lasting mockReturnValue: vi.clearAllMocks() (beforeEach) resets call history
      // but not a mock's configured return value, so a persistent override here would leak into
      // every later test that shares this mock.
      ;(isCompositionActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      )
      expect(await runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('nothing retained', async () => {
      expect(await runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })
  })

  describe('rollback', () => {
    test('a failed caret restore rolls back the source, undo, and skips postExact', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // Only the FIRST restoreSvSelection call (the one whose failure triggers the rollback) needs
      // to fail; the rollback path's own best-effort caret restore afterward is unchecked by the
      // command, and a lasting mockReturnValue(false) would otherwise leak into later tests.
      ;(requestCaret as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)

      expect(await runTableFormatCommand(window)).toBe(false)

      expect(editor.textContent).toBe(SOURCE)
      expect(restoreTableUndoForRollback).toHaveBeenCalledWith(
        inner,
        'SNAPSHOT',
      )
      expect(postExact).not.toHaveBeenCalled()
      expect(setApplying.mock.calls).toEqual([[true], [false]])
    })
  })

  describe('retention', () => {
    test.each(['input', 'pointerdown', 'keydown'] as const)(
      'a real %s inside the editor clears the retained selection',
      async (type) => {
        setCaret(editor, CARET_IN_TABLE)
        expect(captureTableFormatSvSelection()).toBe(true)
        editor.dispatchEvent(new Event(type, { bubbles: true }))
        expect(await runTableFormatCommand(window)).toBe(false)
        expect(postExact).not.toHaveBeenCalled()
      },
    )

    test('a start-of-editor sentinel capture after a real caret keeps the earlier caret', async () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)

      const sentinel = document.createRange()
      sentinel.setStart(editor, 0)
      sentinel.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(sentinel)
      // The sentinel itself is rejected by captureTableFormatSvSelection (it is focus-loss noise,
      // not a real user caret) -- but it must NOT overwrite the still-retained real selection.
      expect(captureTableFormatSvSelection()).toBe(false)

      expect(await runTableFormatCommand(window)).toBe(true)
      expect(editor.textContent).toBe(FORMATTED)
    })
  })

  describe('formatter failure', () => {
    test('reports a thrown formatter error and does not apply anything', async () => {
      inner.lute.FormatStr = () => {
        throw new Error('boom')
      }
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)

      expect(await runTableFormatCommand(window)).toBe(false)

      expect(onError).toHaveBeenCalledWith(expect.any(Error))
      expect(postExact).not.toHaveBeenCalled()
      expect(editor.textContent).toBe(SOURCE)
    })
  })
})

// Task 630 S1 (RED): the SV table formatter acquires exact authority inside the command, plans on
// the acquired exact text and posts with a rollback. `configureTableFormatCommand` has no acquire
// seam yet, so `acquireExactAuthority` and `postExact(markdown, opts)` are declared here and cast
// onto the product type. SV text is the LF-normalized source: a CRLF host differs from the editor.
describe('runTableFormatCommand exact authority (Task 630)', () => {
  interface ExactEdit {
    rollback?: { restore(): void }
    before?: string
  }
  type AcquiredPair = { exact: string; rendered: string }
  type Deps = Parameters<typeof configureTableFormatCommand>[0] & {
    acquireExactAuthority(): Promise<AcquiredPair | null>
    postExact(markdown: string, opts?: ExactEdit): void
  }
  const HOST_EXACT = SOURCE.replace(/\n/gu, '\r\n')
  const HOST_FORMATTED = FORMATTED.replace(/\n/gu, '\r\n')
  const lf = (text: string) => text.replace(/\r\n|\r/gu, '\n')

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
    editor = makeEditor()
    ;(window as any).vditor = {
      vditor: {
        currentMode: 'sv',
        sv: { element: editor },
        lute: {
          FormatStr: (_origin: string, table: string) =>
            table.replace(/a/gu, 'A'),
        },
        undo: { sv: { undoStack: [{ marker: 'native' }] } },
      },
    }
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
    configureTableFormatCommand({
      // The legacy source after a trusted edit: the LF editor text, not the host bytes.
      snapshotExactMarkdown: () => editor.textContent ?? '',
      setApplying: vi.fn(),
      postExact,
      acquireExactAuthority,
      onError,
    } as Deps)
    setCaret(editor, CARET_IN_TABLE)
    expect(captureTableFormatSvSelection()).toBe(true)
  })

  test('acquires authority and formats on the acquired CRLF host text, posting with a rollback', async () => {
    expect(await runTableFormatCommand(window)).toBe(true)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).toHaveBeenCalledOnce()
    // Every byte outside the formatted table, including the CRLF line ends, is the host's.
    expect(postExact.mock.calls[0][0]).toBe(HOST_FORMATTED)
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(host.text).toBe(HOST_FORMATTED)
    expect(editor.textContent).toBe(FORMATTED)
  })

  test('refuses a stale host: no write, the rollback runs and the editor shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\r\n`
    acquireExactAuthority.mockImplementationOnce(async () => {
      host.owned = HOST_EXACT
      host.text = drifted
      return { exact: HOST_EXACT, rendered: editor.textContent ?? '' }
    })

    await runTableFormatCommand(window)

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

    expect(await runTableFormatCommand(window)).toBe(false)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).not.toHaveBeenCalled()
    expect(editor.textContent).toBe(SOURCE)
    expect(onError).not.toHaveBeenCalled()
  })
})
