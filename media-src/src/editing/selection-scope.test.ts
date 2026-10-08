// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  caretTextOffset,
  expandCollapsedSelectionToWord,
  installFormatWordExpand,
  installFindReplace,
  installStructuralSelection,
  inlineContentRange,
  findMarkdownMatches,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
  configureFindReplaceActions,
  expandSelectionInEditor,
  openFindReplace,
  rangesEqual,
  selectAllInEditor,
  structuralScopes,
  wordRangeInText,
} from './selection-scope'
import { resetCaretAuthorityForTests } from './caret'

describe('Markdown find/replace engine', () => {
  const markdown = [
    'Alpha alpha alphabet',
    '',
    '```ts',
    'const alpha = "alpha"',
    '```',
    '',
    '| alpha | beta |',
    '| --- | --- |',
    '| gamma | alpha |',
  ].join('\n')

  it('finds literal matches across prose, fenced source, and tables', () => {
    const matches = findMarkdownMatches(markdown, 'alpha', {
      caseSensitive: false,
      wholeWord: false,
    })
    expect(matches).toHaveLength(7)
    expect(matches.map((match) => match.blockIndex)).toEqual([
      0, 0, 0, 1, 1, 2, 2,
    ])
    expect(matches.some((match) => match.line === 3)).toBe(true)
  })

  it('supports case-sensitive and Unicode-aware whole-word matching', () => {
    expect(
      findMarkdownMatches(markdown, 'Alpha', {
        caseSensitive: true,
        wholeWord: true,
      }),
    ).toHaveLength(1)
    expect(
      findMarkdownMatches('ไทยไทย ไทย café cafe', 'ไทย', {
        caseSensitive: true,
        wholeWord: true,
      }),
    ).toHaveLength(1)
    expect(
      findMarkdownMatches(markdown, 'alpha', {
        caseSensitive: false,
        wholeWord: true,
      }),
    ).toHaveLength(6)
  })

  it('keeps source offsets stable when case folding dotted I', () => {
    const source = 'İ i İ'
    expect(
      findMarkdownMatches(source, 'i', {
        caseSensitive: false,
        wholeWord: true,
      }).map(({ start, end }) => [start, end]),
    ).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })

  it('returns no matches for an empty query', () => {
    expect(
      findMarkdownMatches(markdown, '', {
        caseSensitive: false,
        wholeWord: false,
      }),
    ).toEqual([])
  })

  it('replaces one exact match without treating replacement text as syntax', () => {
    const match = findMarkdownMatches(markdown, 'Alpha', {
      caseSensitive: true,
      wholeWord: true,
    })[0]!
    expect(replaceMarkdownMatch(markdown, match, '$& literal')).toMatchObject({
      changed: true,
      markdown: expect.stringContaining('$& literal alpha alphabet'),
    })
  })

  it('replace-all rewrites every captured range in one deterministic transform', () => {
    const matches = findMarkdownMatches(markdown, 'alpha', {
      caseSensitive: false,
      wholeWord: true,
    })
    const result = replaceAllMarkdownMatches(markdown, matches, 'omega')
    expect(result.changed).toBe(true)
    expect(result.replacements).toBe(6)
    expect(result.markdown).not.toMatch(/\balpha\b/i)
    expect(result.markdown).toContain('alphabet')
  })
})

function setupFindReplaceEditor(markdown: string) {
  const editor = document.createElement('div')
  editor.className = 'vditor-reset'
  editor.setAttribute('contenteditable', 'true')
  editor.textContent = markdown
  document.body.appendChild(editor)
  const addToUndoStack = vi.fn()
  const outer = {
    vditor: {
      currentMode: 'ir',
      ir: { element: editor },
      undo: { addToUndoStack },
    },
    getValue: () => editor.textContent ?? '',
    setValue: (value: string) => {
      editor.textContent = value
    },
  }
  ;(window as unknown as { vditor?: unknown }).vditor = outer
  const postExact = vi.fn()
  configureFindReplaceActions({
    setApplying: vi.fn(),
    postExact,
    onError: vi.fn(),
    reportState: vi.fn(),
  })
  return { editor, outer, addToUndoStack, postExact }
}

describe('find/replace widget', () => {
  it('opens accessibly, counts source matches, and keeps UI outside the editable', () => {
    const { editor } = setupFindReplaceEditor('alpha\n\nbeta alpha')
    const dispose = installFindReplace()
    openFindReplace()
    const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
    const input = root.querySelector<HTMLInputElement>('[data-find]')!
    input.value = 'alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(root.hidden).toBe(false)
    expect(root.getAttribute('role')).toBe('dialog')
    expect(root.querySelector('[role="status"]')?.textContent).toBe('1 of 2')
    expect(editor.contains(root)).toBe(false)
    expect(editor.querySelector('[data-action]')).toBeNull()
    dispose()
  })

  it('Replace applies one exact transaction and Escape closes the widget', async () => {
    const { editor, addToUndoStack, postExact } =
      setupFindReplaceEditor('alpha beta alpha')
    const dispose = installFindReplace()
    openFindReplace()
    const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
    const find = root.querySelector<HTMLInputElement>('[data-find]')!
    const replacement = root.querySelector<HTMLInputElement>('[data-replace]')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    replacement.value = 'omega'
    root.querySelector<HTMLButtonElement>('[data-action="replace"]')!.click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(editor.textContent).toBe('omega beta alpha')
    expect(postExact).toHaveBeenCalledWith('omega beta alpha')
    expect(addToUndoStack).toHaveBeenCalledTimes(2)
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(root.hidden).toBe(true)
    dispose()
  })

  it('Replace All is one transaction for every match', async () => {
    const { editor, addToUndoStack, postExact } =
      setupFindReplaceEditor('alpha beta alpha')
    const dispose = installFindReplace()
    openFindReplace()
    const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
    const find = root.querySelector<HTMLInputElement>('[data-find]')!
    const replacement = root.querySelector<HTMLInputElement>('[data-replace]')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    replacement.value = 'omega'
    root
      .querySelector<HTMLButtonElement>('[data-action="replace-all"]')!
      .click()
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(editor.textContent).toBe('omega beta omega')
    expect(postExact).toHaveBeenCalledWith('omega beta omega')
    expect(addToUndoStack).toHaveBeenCalledTimes(2)
    dispose()
  })
})

describe('find/replace invalidation (Task 196)', () => {
  function installWithSource(markdown: string) {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    // jsdom has no Range geometry; the SV mapper returns live ranges.
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    })
    const view = setupFindReplaceEditor(markdown)
    ;(view.outer.vditor as Record<string, unknown>).sv = {
      element: view.editor,
    }
    const state = { revision: {} as object }
    const snapshotPair = vi.fn(() => {
      const text = view.editor.textContent ?? ''
      return { exact: text, rendered: text }
    })
    const dispose = installFindReplace(document, {
      snapshotPair,
      snapshotRevision: () => state.revision,
    })
    openFindReplace()
    const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
    const find = root.querySelector<HTMLInputElement>('[data-find]')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    const status = () => root.querySelector('[role="status"]')?.textContent
    return { ...view, state, snapshotPair, dispose, status }
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    const range = Range.prototype as Partial<Range>
    delete range.getClientRects
    delete range.getBoundingClientRect
    document.body.replaceChildren()
  })

  it('never recomputes on an editor click, and recomputes once after a burst of edits', () => {
    const view = installWithSource('alpha beta alpha')
    expect(view.status()).toBe('1 of 2')
    expect(view.snapshotPair).toHaveBeenCalledOnce()

    view.editor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(view.snapshotPair).toHaveBeenCalledOnce()

    for (const text of ['alpha beta alpha x', 'alpha alpha beta alpha']) {
      view.editor.textContent = text
      view.state.revision = {}
      view.editor.dispatchEvent(new Event('input', { bubbles: true }))
      vi.advanceTimersByTime(60)
    }
    expect(view.snapshotPair).toHaveBeenCalledOnce()
    expect(view.status()).toBe('1 of 2')
    vi.advanceTimersByTime(200)
    expect(view.snapshotPair).toHaveBeenCalledTimes(2)
    expect(view.status()).toBe('1 of 3')
    view.dispose()
  })

  it('notices a mode switch on the next click and recomputes for the new mode', () => {
    const view = installWithSource('alpha beta alpha')
    view.outer.vditor.currentMode = 'sv'
    view.editor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(view.snapshotPair).toHaveBeenCalledTimes(2)
    expect(view.status()).toBe('1 of 2')
    view.dispose()
  })

  it('stops refreshing once the widget is closed', () => {
    const view = installWithSource('alpha beta alpha')
    document
      .querySelector<HTMLElement>('.vmde-find-replace')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    view.editor.dispatchEvent(new Event('input', { bubbles: true }))
    vi.advanceTimersByTime(500)
    expect(view.snapshotPair).toHaveBeenCalledOnce()
    view.dispose()
  })
})

describe('find/replace exact transaction (Task 196)', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function installExact(exact: string, rendered: string) {
    const view = setupFindReplaceEditor(rendered)
    // Vditor keeps one native undo/redo stack pair per mode on `inner.undo`.
    const undoStack: object[] = []
    const redoStack: object[] = []
    const inner = view.outer.vditor as Record<string, unknown>
    ;(inner.undo as Record<string, unknown>).ir = { undoStack, redoStack }
    view.addToUndoStack.mockImplementation(() => undoStack.push({}))
    const source = { exact, rendered }
    const snapshotPair = vi.fn(() => ({ ...source }))
    const revision = {}
    const dispose = installFindReplace(document, {
      snapshotPair,
      snapshotRevision: () => revision,
    })
    openFindReplace()
    const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
    const find = root.querySelector<HTMLInputElement>('[data-find]')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLInputElement>('[data-replace]')!.value = 'omega'
    const click = (action: string) =>
      root
        .querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
        .click()
    return {
      ...view,
      inner,
      undoStack,
      redoStack,
      source,
      dispose,
      click,
      root,
    }
  }

  it('plans on the exact bytes and records exact Undo/Redo history', async () => {
    // The exact file keeps a double space and an unpadded table row that Vditor normalizes.
    const view = installExact(
      'alpha  beta\n|alpha|x|\n',
      'alpha beta\n| alpha | x |\n',
    )
    view.click('replace-all')
    expect(view.postExact).toHaveBeenCalledWith('omega  beta\n|omega|x|\n')
    expect(view.addToUndoStack).toHaveBeenCalledTimes(2)

    // Undo moves Vditor's state to the redo stack and restores the rendered text: the recorded
    // history hands back the exact bytes the replace started from.
    view.redoStack.push(view.undoStack.pop()!)
    const { takeRewrapDocumentHistorySync } = await import('./rewrap-command')
    expect(
      takeRewrapDocumentHistorySync(
        view.inner as never,
        'alpha beta\n| alpha | x |\n',
      ),
    ).toBe('alpha  beta\n|alpha|x|\n')
    view.dispose()
  })

  it('declines and refreshes when the exact source changed after the matches were shown', () => {
    const view = installExact('alpha beta alpha\n', 'alpha beta alpha\n')
    view.source.exact = 'beta alpha\n'
    view.source.rendered = 'beta alpha\n'
    view.click('replace')
    expect(view.postExact).not.toHaveBeenCalled()
    expect(view.addToUndoStack).not.toHaveBeenCalled()
    view.dispose()
  })
})

describe('wordRangeInText', () => {
  it('expands from inside a word to its whitespace-delimited boundaries', () => {
    expect(wordRangeInText('hello world', 7)).toEqual([6, 11])
  })
  it('expands from the start edge of a word', () => {
    expect(wordRangeInText('hello world', 6)).toEqual([6, 11])
  })
  it('expands from the end edge of a word', () => {
    expect(wordRangeInText('hello world', 5)).toEqual([0, 5])
  })
  it('expands a lone word at either of its edges', () => {
    expect(wordRangeInText('hello', 0)).toEqual([0, 5])
    expect(wordRangeInText('hello', 5)).toEqual([0, 5])
  })
  it('treats an unbroken run (no whitespace) as one word', () => {
    expect(wordRangeInText('helloworld', 5)).toEqual([0, 10])
  })
  it('expands a caret immediately after a word (before the following space) — Word-consistent', () => {
    // "hello| world" — the caret sits between the last letter and the space; Word bolds "hello".
    expect(wordRangeInText('hello world', 5)).toEqual([0, 5])
  })
  it('returns null for a caret parked in the middle of a space run', () => {
    expect(wordRangeInText('aa  bb', 3)).toBeNull() // offset 3 = the second of the two spaces
    expect(wordRangeInText('hello  world', 6)).toBeNull()
  })
  it('returns null for an empty text node', () => {
    expect(wordRangeInText('', 0)).toBeNull()
  })
  it('returns null for an out-of-range offset', () => {
    expect(wordRangeInText('hello', -1)).toBeNull()
    expect(wordRangeInText('hello', 6)).toBeNull()
  })
})

// A minimal editable + toolbar in the jsdom page; `window.vditor` is stubbed to what
// activeModeElement(window.vditor) needs (current mode -> its element).
function setupEditorPage() {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.textContent = 'hello world'
  document.body.appendChild(editor)

  const toolbar = document.createElement('div')
  toolbar.setAttribute('role', 'toolbar')
  for (const type of ['bold', 'italic', 'strike', 'quote']) {
    const b = document.createElement('button')
    b.setAttribute('data-type', type)
    toolbar.appendChild(b)
  }
  document.body.appendChild(toolbar)

  ;(window as unknown as { vditor?: unknown }).vditor = {
    vditor: { currentMode: 'ir', ir: { element: editor } },
  }
  return { editor, toolbar, textNode: editor.firstChild as Text }
}

function placeCaret(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  return sel!
}

afterEach(() => {
  document.body.replaceChildren()
  ;(window as unknown as { vditor?: unknown }).vditor = undefined
})

describe('expandCollapsedSelectionToWord', () => {
  it('expands a collapsed caret inside a word', () => {
    const { editor, textNode } = setupEditorPage()
    const sel = placeCaret(textNode, 7) // inside "world"
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(true)
    expect(sel.isCollapsed).toBe(false)
    expect(sel.toString()).toBe('world')
  })

  it("expands an empty range built WITHOUT collapse() — Vditor's caret representation", () => {
    // MEASURED in the real webview (task 506): Vditor's caret restoration leaves the caret as a
    // non-collapsed EMPTY range (`setStart` + `setEnd` at the same offset, no `collapse()`; the
    // only way to tell it apart from a real selection is `range.toString() === ''`). This must
    // expand too, or the feature dies in the real editor. (jsdom collapses start===end ranges
    // automatically, so `isCollapsed` here is true — the empty-text semantics are what matter.)
    const { editor, textNode } = setupEditorPage()
    const range = document.createRange()
    range.setStart(textNode, 7) // inside "world"
    range.setEnd(textNode, 7) // no collapse()
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(range.toString()).toBe('')
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(true)
    expect(sel.toString()).toBe('world')
  })

  it('re-joins a word split across adjacent text nodes (Vditor splits at the caret) and trims trailing punctuation', () => {
    // Real-webview shape (task 506): Vditor splits the containing text node at the caret, so a
    // caret mid-word sits at the boundary of e.g. "Hello wo" | "rld.". The word must re-join across
    // the direct text siblings, and the trailing "." must stay OUTSIDE the wrap.
    const editor = document.createElement('div')
    editor.append('Hello wo', 'rld.') // two adjacent text nodes = "Hello world."
    document.body.appendChild(editor)
    const first = editor.firstChild as Text
    const sel = placeCaret(first, 8) // end of "Hello wo" — inside "world"
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(true)
    expect(sel.toString()).toBe('world')
  })

  it('re-joins a caret-split word across an empty text-node leftover', () => {
    const editor = document.createElement('div')
    editor.append('Hello wo', '', 'rld.')
    document.body.appendChild(editor)
    const first = editor.firstChild as Text
    const sel = placeCaret(first, 8)

    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(true)
    expect(sel.toString()).toBe('world')
  })

  it('trims trailing punctuation from a single-node word (caret in "world" of "Hello world.")', () => {
    const editor = document.createElement('div')
    editor.textContent = 'Hello world.'
    document.body.appendChild(editor)
    const textNode = editor.firstChild as Text
    const sel = placeCaret(textNode, 8) // between 'o' and 'r' of "world"
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(true)
    expect(sel.toString()).toBe('world')
  })

  it('leaves a non-collapsed selection alone', () => {
    const { editor, textNode } = setupEditorPage()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, 5)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(false)
    expect(sel.toString()).toBe('hello')
  })

  it('leaves an element-container caret alone (no text node)', () => {
    const { editor } = setupEditorPage()
    const sel = placeCaret(editor, 0)
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(false)
  })

  it('leaves a caret outside the editor alone', () => {
    const { editor } = setupEditorPage()
    const other = document.createElement('div')
    other.textContent = 'elsewhere'
    document.body.appendChild(other)
    const sel = placeCaret(other.firstChild as Text, 2)
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(false)
  })

  it('leaves a caret parked in the middle of a space run alone', () => {
    const editor = document.createElement('div')
    editor.textContent = 'hello  world'
    document.body.appendChild(editor)
    const textNode = editor.firstChild as Text
    const sel = placeCaret(textNode, 6) // between the two spaces
    expect(expandCollapsedSelectionToWord(sel, editor)).toBe(false)
    expect(sel.isCollapsed).toBe(true)
  })
})

describe('installFormatWordExpand', () => {
  it('registers a capture-phase click listener', () => {
    const add = vi.spyOn(window.document, 'addEventListener')
    const teardown = installFormatWordExpand()
    expect(add).toHaveBeenCalledWith(
      'click',
      expect.any(Function),
      true, // capture — must run before Vditor's bubble-phase MenuItem handler
    )
    teardown()
  })

  it('word-expands before a bold/italic/strike button click (real click)', () => {
    const { editor, toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    placeCaret(textNode, 7) // inside "world"
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="bold"]')!
      .click()
    const sel = window.getSelection()!
    expect(editor.contains(sel.anchorNode)).toBe(true)
    expect(sel.toString()).toBe('world')
    teardown()
  })

  it('word-expands for the hotkey path — a synthetic click dispatched on the button', () => {
    const { toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    placeCaret(textNode, 0) // start edge of "hello"
    const button = toolbar.querySelector<HTMLButtonElement>(
      'button[data-type="strike"]',
    )!
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    const sel = window.getSelection()!
    expect(sel.toString()).toBe('hello')
    teardown()
  })

  it('ignores clicks on non-word-format buttons (quote)', () => {
    const { toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    const sel = placeCaret(textNode, 7)
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="quote"]')!
      .click()
    expect(sel.toString()).toBe('') // still collapsed — quote is not in WORD_FORMAT_BUTTONS
    expect(sel.isCollapsed).toBe(true)
    teardown()
  })

  it('does not disturb an existing non-collapsed selection', () => {
    const { toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    const range = document.createRange()
    range.setStart(textNode, 6)
    range.setEnd(textNode, 11)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="italic"]')!
      .click()
    expect(sel.toString()).toBe('world')
    teardown()
  })

  it('stops expanding after teardown', () => {
    const { editor, toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    teardown()
    const sel = placeCaret(textNode, 7)
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="bold"]')!
      .click()
    expect(sel.isCollapsed).toBe(true) // listener removed — selection untouched
    expect(editor.contains(sel.anchorNode)).toBe(true)
  })

  it('schedules the caret restore (setTimeout 0) after a word-format click', () => {
    const { toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    placeCaret(textNode, 7) // inside "world"
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="bold"]')!
      .click()
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0)
    teardown()
  })

  it('does not schedule a caret restore when the selection is already a real one', () => {
    const { toolbar, textNode } = setupEditorPage()
    const teardown = installFormatWordExpand()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const range = document.createRange()
    range.setStart(textNode, 6)
    range.setEnd(textNode, 11)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    const callsBefore = setTimeoutSpy.mock.calls.length
    toolbar
      .querySelector<HTMLButtonElement>('button[data-type="italic"]')!
      .click()
    // No expansion → no restore to schedule. Measured as a delta: jsdom/vitest call setTimeout
    // for their own reasons, so an absolute "not called" assertion is noise-prone.
    expect(setTimeoutSpy.mock.calls.length).toBe(callsBefore)
    teardown()
  })
})

describe('caretTextOffset', () => {
  it('returns the absolute char offset of the caret within the editor', () => {
    const { editor, textNode } = setupEditorPage() // "hello world"
    expect(caretTextOffset(editor, placeCaret(textNode, 0))).toBe(0)
    expect(caretTextOffset(editor, placeCaret(textNode, 7))).toBe(7)
    expect(caretTextOffset(editor, placeCaret(textNode, 11))).toBe(11)
  })

  it('returns -1 for a selection outside the editor', () => {
    const { editor } = setupEditorPage()
    const other = document.createElement('div')
    other.textContent = 'x'
    document.body.appendChild(other)
    expect(
      caretTextOffset(editor, placeCaret(other.firstChild as Text, 0)),
    ).toBe(-1)
  })
})

// Task 596: the caret shift after a word-expand follows the CLICKED button's `vditor-menu--current`
// class (the class Vditor's own click reads, and that the router's live gate sets for a hotkey),
// not a second DOM test of the caret.
describe('installFormatWordExpand caret shift follows the button state', () => {
  it.each([
    ['not current (the click wraps)', false, 7 + 2],
    ['current (the click unwraps)', true, 7 - 2],
  ])(
    'shifts the restored caret when the button is %s',
    (_label, current, expected) => {
      vi.useFakeTimers()
      const { editor, toolbar, textNode } = setupEditorPage()
      const teardown = installFormatWordExpand()
      placeCaret(textNode, 7) // inside "world"
      const button = toolbar.querySelector<HTMLButtonElement>(
        'button[data-type="bold"]',
      )!
      button.classList.toggle('vditor-menu--current', current)
      button.click()
      vi.runAllTimers()
      expect(caretTextOffset(editor, window.getSelection()!)).toBe(expected)
      resetCaretAuthorityForTests()
      teardown()
      vi.useRealTimers()
    },
  )
})

function mountIrEditor(html: string): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'vditor-ir vditor-reset'
  editor.contentEditable = 'true'
  editor.innerHTML = html
  document.body.appendChild(editor)
  ;(window as unknown as { vditor?: unknown }).vditor = {
    vditor: { currentMode: 'ir', ir: { element: editor } },
  }
  return editor
}

function setupStructuralEditor() {
  const editor = mountIrEditor(`
    <p data-block="0">alpha <strong class="vditor-ir__node vditor-ir__node--expand" data-type="strong"><span class="vditor-ir__marker">**</span>bold scope<span class="vditor-ir__marker">**</span></strong> omega</p>
    <ul data-block="0"><li data-block="0"><p>nested item</p></li></ul>
    <table data-block="0"><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>
    <div class="vditor-ir__node" data-block="0" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>const fence = true</code></pre><div data-render="true">render</div></div>
    <p data-block="0">final paragraph</p>`)
  return {
    editor,
    strong: editor.querySelector<HTMLElement>('[data-type="strong"]')!,
    nested: editor.querySelector<HTMLElement>('li')!,
    cell: editor.querySelector<HTMLElement>('td')!,
    table: editor.querySelector<HTMLElement>('table')!,
    fence: editor.querySelector<HTMLElement>('[data-type="code-block"]')!,
    code: editor.querySelector<HTMLElement>('code')!,
  }
}

function structuralKey(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(event)
  return event
}

describe('structural scope walker', () => {
  it('selects inline authored content without marker spans', () => {
    const { strong } = setupStructuralEditor()
    const range = inlineContentRange(strong)
    expect(range?.toString()).toBe('bold scope')
    expect(range?.toString()).not.toContain('**')
  })

  // Task 580 CP2-6: Chromium collapses an element-boundary selection around Vditor's wrapper.
  it('puts the inline scope ends on text inside a wrapped content element', () => {
    const node = document.createElement('span')
    node.className = 'vditor-ir__node'
    node.innerHTML =
      '<span class="vditor-ir__marker">**</span><strong data-newline="1">bold scope</strong><span class="vditor-ir__marker">**</span>'
    document.body.append(node)
    const text = node.querySelector('strong')!.firstChild as Text
    const range = inlineContentRange(node)!
    expect(range.toString()).toBe('bold scope')
    expect([range.startContainer, range.startOffset]).toEqual([text, 0])
    expect([range.endContainer, range.endOffset]).toEqual([text, 10])
  })

  it('walks inline → block → document and nested item → document', () => {
    const { editor, strong, nested } = setupStructuralEditor()
    const inlineText = strong.childNodes[1] as Text
    const inline = document.createRange()
    inline.setStart(inlineText, 2)
    inline.collapse(true)
    expect(structuralScopes(editor, inline).map((scope) => scope.kind)).toEqual(
      ['inline', 'block', 'document'],
    )

    const nestedRange = document.createRange()
    nestedRange.setStart(nested.querySelector('p')!.firstChild!, 2)
    nestedRange.collapse(true)
    const nestedScopes = structuralScopes(editor, nestedRange)
    expect(nestedScopes.map((scope) => scope.kind)).toEqual([
      'block',
      'document',
    ])
    expect(nestedScopes[0]?.element).toBe(nested)
  })

  it('walks a table caret through cell → table block → document', () => {
    const { editor, cell, table } = setupStructuralEditor()
    const range = document.createRange()
    range.setStart(cell.firstChild!, 2)
    range.collapse(true)
    const scopes = structuralScopes(editor, range)
    expect(scopes.map((scope) => scope.kind)).toEqual([
      'cell',
      'block',
      'document',
    ])
    expect(scopes[1]?.element).toBe(table)
  })

  it('rejects a range outside the editor', () => {
    const { editor } = setupStructuralEditor()
    const outside = document.createTextNode('outside')
    document.body.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    expect(structuralScopes(editor, range)).toEqual([])
  })
})

// Task 580: Vditor's undo snapshot inserts and removes a `<wbr>` marker, which splits text nodes,
// leaves empty ones, and restores the caret on different nodes. A scope must still match the live
// selection when both cover the same characters.
describe('rangesEqual content equivalence', () => {
  function block(html: string): HTMLElement {
    const p = document.createElement('p')
    p.innerHTML = html
    document.body.append(p)
    return p
  }

  function rangeOf(start: [Node, number], end: [Node, number] = start): Range {
    const range = document.createRange()
    range.setStart(...start)
    range.setEnd(...end)
    return range
  }

  it('treats a text node split as the same range', () => {
    const p = block('hello world')
    const whole = rangeOf([p.firstChild!, 0], [p.firstChild!, 11])
    const tail = (p.firstChild as Text).splitText(5)
    const split = rangeOf([p.firstChild!, 0], [tail, 6])
    expect(rangesEqual(whole, split)).toBe(true)
    // The end of the first half and the start of the second are the same position.
    expect(rangesEqual(rangeOf([p.firstChild!, 5]), rangeOf([tail, 0]))).toBe(
      true,
    )
  })

  it('ignores empty text nodes at either end', () => {
    const p = block('')
    p.append('', 'bold scope', '')
    const [left, text, right] = Array.from(p.childNodes)
    expect(
      rangesEqual(
        rangeOf([left!, 0], [right!, 0]),
        rangeOf([text!, 0], [text!, 10]),
      ),
    ).toBe(true)
  })

  it('treats an element boundary and the adjacent text boundary as equal', () => {
    const p = block('alpha <strong>bold</strong> omega')
    const first = p.firstChild as Text
    const last = p.lastChild as Text
    expect(
      rangesEqual(
        rangeOf([p, 0], [p, p.childNodes.length]),
        rangeOf([first, 0], [last, last.length]),
      ),
    ).toBe(true)
    const strong = p.querySelector('strong')!
    expect(
      rangesEqual(rangeOf([strong, 0]), rangeOf([first, first.length])),
    ).toBe(true)
  })

  it('keeps ranges over different characters unequal', () => {
    const p = block('alpha <strong>bold</strong> omega')
    const first = p.firstChild as Text
    const bold = p.querySelector('strong')!.firstChild as Text
    expect(
      rangesEqual(
        rangeOf([first, 0], [first, 6]),
        rangeOf([first, 0], [bold, 4]),
      ),
    ).toBe(false)
    expect(rangesEqual(rangeOf([first, 1]), rangeOf([first, 0]))).toBe(false)
    expect(rangesEqual(rangeOf([p, 0]), rangeOf([p, 1]))).toBe(false)
    // Order does not matter: the later point first is just as unequal.
    expect(rangesEqual(rangeOf([bold, 4]), rangeOf([first, 0]))).toBe(false)
    const other = block('alpha')
    expect(
      rangesEqual(rangeOf([first, 0]), rangeOf([other.firstChild!, 0])),
    ).toBe(false)
  })
})

describe('selectAllInEditor (Task 580 CP2-6 vmde.selectAll)', () => {
  it('advances past the block after an undo snapshot moves its ends onto text', () => {
    const { editor } = setupStructuralEditor()
    const paragraph = editor.querySelector('p')!
    placeCaret(paragraph.firstChild!, 2)
    expect(selectAllInEditor()).toBe(true)
    // Vditor's `<wbr>` round trip restores the same block selection on its edge text nodes.
    const last = paragraph.lastChild as Text
    getSelection()!.setBaseAndExtent(
      paragraph.firstChild!,
      0,
      last,
      last.length,
    )
    expect(selectAllInEditor()).toBe(true)
    expect(getSelection()?.toString()).toContain('final paragraph')
  })

  it('stages IR Select All from block to document', () => {
    const { editor } = setupStructuralEditor()
    const alpha = editor.querySelector('p')!.firstChild as Text
    placeCaret(alpha, 2)
    expect(selectAllInEditor()).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toContain('alpha')
    expect(selection.toString()).not.toContain('final paragraph')
    const blockRange = selection.getRangeAt(0).cloneRange()

    expect(selectAllInEditor()).toBe(true)
    expect(selection.toString()).toContain('final paragraph')
    expect(rangesEqual(blockRange, selection.getRangeAt(0))).toBe(false)
    // The document is the last stage: a further Select All leaves it in place.
    expect(selectAllInEditor()).toBe(false)
    expect(selection.getRangeAt(0).startContainer).toBe(editor)
  })

  it('keeps the IR fence-source stage first, then widens block → document', () => {
    const { editor, code } = setupStructuralEditor()
    placeCaret(code.firstChild!, 3)
    expect(selectAllInEditor()).toBe(true)
    expect(getSelection()?.toString()).toBe('const fence = true')

    expect(selectAllInEditor()).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toContain('const fence = true')
    expect(selection.toString()).toContain('render')
    expect(selectAllInEditor()).toBe(true)
    expect(selection.getRangeAt(0).startContainer).toBe(editor)
  })

  it('selects the whole surface in WYSIWYG and Split View', () => {
    for (const mode of ['wysiwyg', 'sv'] as const) {
      const { editor } = setupStructuralEditor()
      ;(window as unknown as { vditor?: unknown }).vditor = {
        vditor: { currentMode: mode, [mode]: { element: editor } },
      }
      placeCaret(editor.querySelector('code')!.firstChild!, 3)
      expect(selectAllInEditor(), mode).toBe(true)
      const range = getSelection()!.getRangeAt(0)
      expect(range.toString(), mode).toContain('alpha')
      expect(range.toString(), mode).toContain('final paragraph')
      editor.remove()
    }
  })
})

describe('expandSelectionInEditor (Task 580 CP2-6 vmde.expandSelection)', () => {
  it('widens from marker-free inline content to block to document', () => {
    const { strong } = setupStructuralEditor()
    placeCaret(strong.childNodes[1]!, 2)
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toBe('bold scope')
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toContain('alpha')
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toContain('final paragraph')
  })

  // Task 620: each first-keydown undo snapshot leaves an empty text node on both sides of the
  // inline text, so the freshly built inline scope ends on different nodes than the selection.
  it('widens past the inline scope when empty text nodes appear around it', () => {
    const { strong } = setupStructuralEditor()
    const text = strong.childNodes[1] as Text
    placeCaret(text, 2)
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toBe('bold scope')
    text.before('')
    text.after('')
    getSelection()!.setBaseAndExtent(text, 0, text, text.length)
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toContain('alpha')
  })

  it('restores the intended scope after focus disturbs the old Range', () => {
    const { editor, strong } = setupStructuralEditor()
    placeCaret(strong.childNodes[1]!, 2)
    editor.focus = () => getSelection()?.removeAllRanges()
    expandSelectionInEditor()
    expect(getSelection()?.toString()).toBe('bold scope')
  })

  it('does nothing outside IR', () => {
    const { editor, strong } = setupStructuralEditor()
    ;(window as unknown as { vditor?: unknown }).vditor = {
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: editor } },
    }
    placeCaret(strong.childNodes[1]!, 2)
    expect(expandSelectionInEditor()).toBe(false)
    expect(getSelection()?.isCollapsed).toBe(true)
  })
})

// Task 620: a cell, block or document selection that starts on the `**` marker text of a leading
// inline node (the cell scope is built that way; Vditor's undo round trip restores a block the
// same way) lies inside that node, so the ladder rebuilt the inline scope and went back down.
// The ladder now picks the first scope the selection does not already cover.
describe('ladder never re-selects a scope the selection already covers (Task 620)', () => {
  const bold = (text: string) =>
    `<strong class="vditor-ir__node" data-type="strong"><span class="vditor-ir__marker">**</span>${text}<span class="vditor-ir__marker">**</span></strong>`

  function edgeTextOf(root: Node, edge: 'first' | 'last'): Text {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let found = walker.nextNode() as Text
    if (edge === 'last')
      for (let next = walker.nextNode(); next; next = walker.nextNode())
        found = next as Text
    return found
  }

  // The selection Vditor's undo round trip leaves: the same characters, ends on the edge text nodes.
  function restoreOnEdgeText(root: Node) {
    const first = edgeTextOf(root, 'first')
    const last = edgeTextOf(root, 'last')
    getSelection()!.setBaseAndExtent(first, 0, last, last.length)
  }

  function expandTexts(count: number): string[] {
    return Array.from({ length: count }, () => {
      expandSelectionInEditor()
      return getSelection()!.toString()
    })
  }

  it('widens a cell that starts with a bold span to the table, then the document', () => {
    const editor = mountIrEditor(
      `<p data-block="0">before</p><table data-block="0"><tbody><tr><td>${bold('cellbold')} word</td><td>plain</td></tr></tbody></table><p data-block="0">after</p>`,
    )
    placeCaret(editor.querySelector('strong')!.childNodes[1]!, 2)
    const [inline, cell, table, whole] = expandTexts(4)
    expect(inline).toBe('cellbold')
    expect(cell).toContain('cellbold')
    expect(cell).toContain('word')
    expect(cell).not.toContain('plain')
    expect(table).toContain('plain')
    expect(table).not.toContain('before')
    expect(whole).toContain('before')
    expect(whole).toContain('after')
    expect(expandSelectionInEditor()).toBe(false)
  })

  it('widens a paragraph that starts with a bold span from its edge-text block selection', () => {
    const editor = mountIrEditor(
      `<p data-block="0">${bold('lead')} tail</p><p data-block="0">other</p>`,
    )
    const paragraph = editor.querySelector('p')!
    placeCaret(paragraph.querySelector('strong')!.childNodes[1]!, 2)
    const [inline, block] = expandTexts(2)
    expect(inline).toBe('lead')
    expect(block).toContain('tail')
    expect(block).not.toContain('other')
    restoreOnEdgeText(paragraph)
    expect(getSelection()!.getRangeAt(0).startContainer).toBe(
      paragraph.querySelector('.vditor-ir__marker')!.firstChild,
    )
    expect(expandSelectionInEditor()).toBe(true)
    expect(getSelection()!.toString()).toContain('other')
  })

  it('keeps a heading that starts with a bold span on inline, block, document', () => {
    const editor = mountIrEditor(
      `<h2 data-block="0" class="vditor-ir__node" data-marker="##"><span class="vditor-ir__marker vditor-ir__marker--heading">## </span>${bold('head')} tail</h2><p data-block="0">other</p>`,
    )
    const heading = editor.querySelector('h2')!
    placeCaret(heading.querySelector('strong')!.childNodes[1]!, 2)
    const [inline, block, whole] = expandTexts(3)
    expect(inline).toBe('head')
    expect(block).toContain('tail')
    expect(block).not.toContain('other')
    expect(whole).toContain('other')
    // The same block selection restored on the edge text nodes still widens to the document.
    placeCaret(heading.querySelector('strong')!.childNodes[1]!, 2)
    expandTexts(2)
    restoreOnEdgeText(heading)
    expect(expandSelectionInEditor()).toBe(true)
    expect(getSelection()!.toString()).toContain('other')
  })

  function mountTerminalDocument(): HTMLElement {
    const editor = mountIrEditor(
      `<p data-block="0">${bold('lead')} tail</p><p data-block="0">other</p>`,
    )
    placeCaret(editor.querySelector('strong')!.childNodes[1]!, 2)
    expandTexts(3)
    restoreOnEdgeText(editor)
    expect(getSelection()!.toString()).toContain('tail')
    expect(getSelection()!.toString()).toContain('other')
    return editor
  }

  it('stops Expand Selection at a document selection restored on the first and last text nodes', () => {
    mountTerminalDocument()
    const before = getSelection()!.toString()
    expect(expandSelectionInEditor()).toBe(false)
    expect(getSelection()!.toString()).toBe(before)
  })

  it('stops Select All at a document selection restored on the first and last text nodes', () => {
    mountTerminalDocument()
    const before = getSelection()!.toString()
    expect(selectAllInEditor()).toBe(false)
    expect(getSelection()!.toString()).toBe(before)
  })

  it('widens Select All from a restored fence block to the document', () => {
    const editor = mountIrEditor(
      `<p data-block="0">before</p><div class="vditor-ir__node" data-block="0" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>const fence = true</code></pre><div data-render="true">render</div></div><p data-block="0">after</p>`,
    )
    const code = editor.querySelector('code')!
    placeCaret(code.firstChild!, 3)
    expect(selectAllInEditor()).toBe(true)
    expect(getSelection()!.toString()).toBe('const fence = true')
    expect(selectAllInEditor()).toBe(true)
    expect(getSelection()!.toString()).toContain('render')
    // Vditor's undo round trip puts the block selection's start back on the code text.
    const render = editor.querySelector('[data-render]')!.firstChild as Text
    getSelection()!.setBaseAndExtent(code.firstChild!, 0, render, render.length)
    expect(selectAllInEditor()).toBe(true)
    const range = getSelection()!.getRangeAt(0)
    expect(range.startContainer).toBe(editor)
    expect(getSelection()!.toString()).toContain('before')
    expect(getSelection()!.toString()).toContain('after')
  })

  it('still selects the inline scope from a caret on an expanded marker', () => {
    const { strong } = setupStructuralEditor()
    placeCaret(strong.firstChild!.firstChild!, 1)
    expect(expandSelectionInEditor()).toBe(true)
    expect(getSelection()!.toString()).toBe('bold scope')
  })
})

describe('installStructuralSelection', () => {
  it('leaves Ctrl/Cmd+A and Ctrl/Cmd+E to their commands and to VS Code', () => {
    const { editor } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(editor.querySelector('p')!.firstChild!, 2)
    for (const init of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(structuralKey('a', init).defaultPrevented).toBe(false)
      expect(structuralKey('e', init).defaultPrevented).toBe(false)
    }
    expect(getSelection()?.isCollapsed).toBe(true)
    teardown()
  })

  it('keeps later document handlers from collapsing a handled Escape scope', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    const later = vi.fn(() => getSelection()?.removeAllRanges())
    document.addEventListener('keydown', later, true)
    placeCaret(strong.childNodes[1]!, 2)
    structuralKey('Escape')
    expect(later).not.toHaveBeenCalled()
    document.removeEventListener('keydown', later, true)
    teardown()
  })

  it('yields Escape to a visible Find widget', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    const widget = document.createElement('div')
    widget.className = 'vmde-find-replace'
    document.body.append(widget)
    placeCaret(strong.childNodes[1]!, 2)
    expect(structuralKey('Escape').defaultPrevented).toBe(false)
    expect(strong.classList.contains('vditor-ir__node--expand')).toBe(true)
    widget.hidden = true
    expect(structuralKey('Escape').defaultPrevented).toBe(true)
    widget.remove()
    teardown()
  })

  it('Esc collapses an expanded inline scope, then selects its block', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(strong.childNodes[1]!, 2)
    expect(structuralKey('Escape').defaultPrevented).toBe(true)
    expect(strong.classList.contains('vditor-ir__node--expand')).toBe(false)
    expect(getSelection()?.isCollapsed).toBe(true)
    expect(structuralKey('Escape').defaultPrevented).toBe(true)
    expect(getSelection()?.toString()).toContain('alpha')
    teardown()
  })

  it('does not steal the shipped Ctrl+D strike or Ctrl+L list chords', () => {
    const { editor } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(editor.querySelector('p')!.firstChild!, 2)
    expect(structuralKey('d', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(structuralKey('l', { ctrlKey: true }).defaultPrevented).toBe(false)
    teardown()
  })

  it('normalizes a triple-click selection to the complete code-fence block', () => {
    const { fence, code } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(code.firstChild!, 2)
    code.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 3 }))
    const selection = getSelection()!
    expect(selection.toString()).toContain('const fence = true')
    expect(selection.toString()).toContain('render')
    expect(selection.getRangeAt(0).startContainer).toBe(fence)
    teardown()
  })

  it('ignores composition and stops after teardown', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(strong.childNodes[1]!, 2)
    expect(
      structuralKey('Escape', { isComposing: true }).defaultPrevented,
    ).toBe(false)
    teardown()
    expect(structuralKey('Escape').defaultPrevented).toBe(false)
  })
})
