// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCaretAuthorityForTests } from './caret'
import { placeInitialCaret, resetInitialCaretForTests } from './initial-caret'

/**
 * A minimal stand-in for the live editor: activeModeElement reads
 * `vditor.vditor[currentMode].element` (source-map.ts), and placeInitialCaret separately reads
 * `vditor.getValue()` for the emptiness gate — `value` is independent of the mounted DOM so a
 * test can exercise the one-shot/existing-selection paths against a DOM with visible blocks
 * while still driving the "document is empty" gate deliberately.
 *
 * Also assigned to `window.vditor`: caret.ts's requestCaret (ADR-0007 / task 446) resolves the
 * active editor from the GLOBAL `window.vditor`, same as every other migrated call site
 * (gap-nav.ts, gap-paragraph.ts, …) — matching how finish-init.ts always calls
 * `placeInitialCaret(window.vditor)` in production. The `vditor` parameter this function still
 * takes is used for the OTHER two reads below (activeModeElement, getValue) that are not caret
 * writes and so stay outside the authority's scope.
 */
function mountEditor(
  html: string,
  value = '',
): { editor: HTMLElement; vditor: unknown } {
  document.body.innerHTML = `<div id="ed" contenteditable="true">${html}</div>`
  const editor = document.getElementById('ed') as HTMLElement
  const vditor = {
    vditor: { currentMode: 'ir', ir: { element: editor } },
    getValue: () => value,
  }
  ;(window as unknown as Record<string, unknown>).vditor = vditor
  return { editor, vditor }
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  resetInitialCaretForTests()
  resetCaretAuthorityForTests() // cancel any rAF the authority armed in a previous test
  ;(window as unknown as Record<string, unknown>).vditor = undefined
})

describe('placeInitialCaret', () => {
  it('collapses to (block, 0) for an empty document whose first block has no text node', () => {
    const { editor, vditor } = mountEditor('<p><br></p>', '')
    const placed = placeInitialCaret(vditor)
    expect(placed).toBe(true)

    const sel = window.getSelection()!
    const range = sel.getRangeAt(0)
    expect(range.collapsed).toBe(true)
    expect(range.startContainer).toBe(editor.firstElementChild)
    expect(range.startOffset).toBe(0)
  })

  // Stage 1 (task 446) moved "does a first block exist at all" out of this module entirely —
  // gap-paragraph.ts's leading-block invariant now guarantees one before placeInitialCaret ever
  // runs (see finish-init.ts's wiring order). This test simulates that pre-condition explicitly
  // (a pre-seeded leading paragraph, the exact shape ensureLeadingBlock produces — see
  // gap-paragraph.test.ts for that invariant's own coverage) and checks the RESOLUTION half that
  // still lives here: land after the seed, not before it.
  it('lands AFTER a pre-seeded leading paragraph, the shape the leading invariant guarantees', () => {
    const { editor, vditor } = mountEditor(
      '<p data-block="0" data-vmde-leading>​</p>',
      '',
    )
    const placed = placeInitialCaret(vditor)
    expect(placed).toBe(true)

    const block = editor.firstElementChild as HTMLElement
    const range = window.getSelection()!.getRangeAt(0)
    expect(range.collapsed).toBe(true)
    expect(range.startContainer).toBe(block.firstChild)
    // AFTER the seed, so the first keystroke lands on the right side of it.
    expect(range.startOffset).toBe(1)
  })

  it.each([
    ['unknown', undefined],
    ['empty', ''],
    ['whitespace-only', ' \t\n '],
  ])(
    'uses the live value for %s initial Markdown',
    (_label, initialMarkdown) => {
      const { vditor } = mountEditor('<p><br></p>', '\n')
      const getValue = vi.spyOn(
        vditor as { getValue: () => string },
        'getValue',
      )

      expect(placeInitialCaret(vditor, initialMarkdown)).toBe(true)
      expect(getValue).toHaveBeenCalledOnce()
    },
  )

  it('treats a whitespace-only value as empty (Lute trailing-newline convention)', () => {
    const { vditor } = mountEditor('<p><br></p>', '\n')
    const placed = placeInitialCaret(vditor)
    expect(placed).toBe(true)
    expect(window.getSelection()!.rangeCount).toBe(1)
  })

  it('is a no-op for a document with content: no Range created, focus not called', () => {
    const { editor, vditor } = mountEditor(
      '<h1>First heading</h1><p>First paragraph.</p>',
      '# First heading\n\nFirst paragraph.\n',
    )
    let focusCalled = false
    editor.focus = (() => {
      focusCalled = true
    }) as typeof editor.focus
    const original = document.hasFocus
    document.hasFocus = () => true
    try {
      const placed = placeInitialCaret(vditor)
      expect(placed).toBe(false)
      expect(window.getSelection()!.rangeCount, 'no Range was created').toBe(0)
      expect(focusCalled, 'focus was never called').toBe(false)
    } finally {
      document.hasFocus = original
    }
  })

  it('does not serialize a known nonempty initial document', () => {
    const { editor } = mountEditor('<p>Nonempty</p>')
    const getValue = vi.fn(() => {
      throw new Error('unexpected serialization')
    })
    const focus = vi.spyOn(editor, 'focus')
    const outer = {
      vditor: { currentMode: 'ir', ir: { element: editor } },
      getValue,
    }

    expect(placeInitialCaret(outer, '# Nonempty\n')).toBe(false)
    expect(getValue).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    expect(window.getSelection()?.rangeCount).toBe(0)

    // The known-nonempty decision consumes the existing one-shot guard.
    expect(placeInitialCaret(outer)).toBe(false)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('is a one-shot: the second call is a no-op and leaves a caret the user moved', () => {
    const { editor, vditor } = mountEditor(
      '<p>first block</p><p>second block</p>',
      '',
    )
    expect(placeInitialCaret(vditor)).toBe(true)

    // Simulate the user moving the caret into the second block.
    const secondText = editor.children[1].firstChild as Text
    const range = document.createRange()
    range.setStart(secondText, 3)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const placedAgain = placeInitialCaret(vditor)
    expect(placedAgain).toBe(false)

    const now = window.getSelection()!.getRangeAt(0)
    expect(now.startContainer).toBe(secondText)
    expect(now.startOffset).toBe(3)
  })

  it('does not disturb an existing in-editor selection on the first call', () => {
    const { editor, vditor } = mountEditor(
      '<p>first block</p><p>second block</p>',
      '',
    )
    const secondText = editor.children[1].firstChild as Text
    const range = document.createRange()
    range.setStart(secondText, 3)
    range.collapse(true)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)

    const placed = placeInitialCaret(vditor)
    expect(placed).toBe(false)

    const now = window.getSelection()!.getRangeAt(0)
    expect(now.startContainer).toBe(secondText)
    expect(now.startOffset).toBe(3)
  })

  it('calls focus with {preventScroll: true} when the document has focus', () => {
    const { editor, vditor } = mountEditor('<p><br></p>', '')
    const calls: (FocusOptions | undefined)[] = []
    editor.focus = ((opts?: FocusOptions) => {
      calls.push(opts)
    }) as typeof editor.focus
    // jsdom's document.hasFocus() defaults to false (no real window manager) — force it true to
    // exercise the "webview IS focused" branch explicitly.
    const original = document.hasFocus
    document.hasFocus = () => true
    try {
      placeInitialCaret(vditor)
      expect(calls).toEqual([{ preventScroll: true }])
    } finally {
      document.hasFocus = original
    }
  })

  it('does NOT call focus when the webview lacks focus, but still sets the selection', () => {
    const { editor, vditor } = mountEditor('<p><br></p>', '')
    let focusCalled = false
    editor.focus = (() => {
      focusCalled = true
    }) as typeof editor.focus
    const original = document.hasFocus
    document.hasFocus = () => false
    try {
      const placed = placeInitialCaret(vditor)
      expect(placed).toBe(true)
      expect(focusCalled).toBe(false)
      expect(window.getSelection()!.rangeCount).toBe(1)
    } finally {
      document.hasFocus = original
    }
  })

  it('returns false and does nothing when there is no active mode element', () => {
    document.body.innerHTML = ''
    const vditor = { vditor: { currentMode: 'ir' }, getValue: () => '' }
    ;(window as unknown as Record<string, unknown>).vditor = vditor
    const placed = placeInitialCaret(vditor)
    expect(placed).toBe(false)
    expect(window.getSelection()!.rangeCount).toBe(0)
  })
})
