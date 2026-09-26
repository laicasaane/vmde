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
  let snapshotExactMarkdown = vi.fn((): string => '')
  let postExact = vi.fn((_markdown: string) => undefined)
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
    snapshotExactMarkdown = vi.fn(() => editor.textContent ?? '')
    postExact = vi.fn((_markdown: string) => undefined)
    setApplying = vi.fn((_value: boolean) => undefined)
    onError = vi.fn((_error: unknown) => undefined)
    configureTableFormatCommand({
      snapshotExactMarkdown,
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
    test('formats the retained table through one exact history edit and restores the caret', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)

      expect(runTableFormatCommand(window)).toBe(true)

      expect(editor.textContent).toBe(FORMATTED)
      expect(postExact).toHaveBeenCalledTimes(1)
      expect(postExact).toHaveBeenCalledWith(FORMATTED)
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
      expect(runTableFormatCommand(window)).toBe(false)
    })
  })

  describe('runTableFormatCommand guards (no postExact)', () => {
    test('exact bytes changed after capture', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // Overrides only the NEXT snapshotExactMarkdown() call (the one runTableFormatCommand makes)
      // without touching the DOM, isolating "exact source changed" from "editor text changed".
      snapshotExactMarkdown.mockReturnValueOnce('changed externally\n')
      expect(runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
      expect(editor.textContent).toBe(SOURCE)
    })

    test('editor text changed after capture', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      editor.textContent = 'a real external DOM edit\n'
      // Keeps the exact-bytes check passing so only the rendered-text guard trips.
      snapshotExactMarkdown.mockReturnValueOnce(SOURCE)
      expect(runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('editor is contenteditable="false"', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      editor.setAttribute('contenteditable', 'false')
      expect(runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('composition is active', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // Once, not a lasting mockReturnValue: vi.clearAllMocks() (beforeEach) resets call history
      // but not a mock's configured return value, so a persistent override here would leak into
      // every later test that shares this mock.
      ;(isCompositionActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      )
      expect(runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })

    test('nothing retained', () => {
      expect(runTableFormatCommand(window)).toBe(false)
      expect(postExact).not.toHaveBeenCalled()
    })
  })

  describe('rollback', () => {
    test('a failed caret restore rolls back the source, undo, and skips postExact', () => {
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)
      // Only the FIRST restoreSvSelection call (the one whose failure triggers the rollback) needs
      // to fail; the rollback path's own best-effort caret restore afterward is unchecked by the
      // command, and a lasting mockReturnValue(false) would otherwise leak into later tests.
      ;(requestCaret as ReturnType<typeof vi.fn>).mockReturnValueOnce(false)

      expect(runTableFormatCommand(window)).toBe(false)

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
      (type) => {
        setCaret(editor, CARET_IN_TABLE)
        expect(captureTableFormatSvSelection()).toBe(true)
        editor.dispatchEvent(new Event(type, { bubbles: true }))
        expect(runTableFormatCommand(window)).toBe(false)
        expect(postExact).not.toHaveBeenCalled()
      },
    )

    test('a start-of-editor sentinel capture after a real caret keeps the earlier caret', () => {
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

      expect(runTableFormatCommand(window)).toBe(true)
      expect(editor.textContent).toBe(FORMATTED)
    })
  })

  describe('formatter failure', () => {
    test('reports a thrown formatter error and does not apply anything', () => {
      inner.lute.FormatStr = () => {
        throw new Error('boom')
      }
      setCaret(editor, CARET_IN_TABLE)
      expect(captureTableFormatSvSelection()).toBe(true)

      expect(runTableFormatCommand(window)).toBe(false)

      expect(onError).toHaveBeenCalledWith(expect.any(Error))
      expect(postExact).not.toHaveBeenCalled()
      expect(editor.textContent).toBe(SOURCE)
    })
  })
})
