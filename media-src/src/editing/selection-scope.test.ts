// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  caretTextOffset,
  expandCollapsedSelectionToWord,
  installFormatWordExpand,
  installFindReplace,
  installStructuralSelection,
  inlineContentRange,
  isInsideInlineFormat,
  findMarkdownMatches,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
  configureFindReplaceActions,
  openFindReplace,
  rangesEqual,
  structuralScopes,
  wordRangeInText,
} from './selection-scope'

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
    expect(root.querySelector('[role="status"]')?.textContent).toBe('1/2')
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

describe('isInsideInlineFormat', () => {
  it('detects a caret inside a bolded word', () => {
    const editor = document.createElement('div')
    editor.innerHTML = 'Hello <strong data-type="strong">world</strong>.'
    document.body.appendChild(editor)
    const strong = editor.querySelector('strong')!.firstChild as Text
    expect(isInsideInlineFormat(strong, 'bold')).toBe(true)
    expect(isInsideInlineFormat(strong, 'italic')).toBe(false)
  })

  it('is false for plain text', () => {
    const editor = document.createElement('div')
    editor.textContent = 'plain'
    document.body.appendChild(editor)
    expect(isInsideInlineFormat(editor.firstChild as Text, 'bold')).toBe(false)
  })
})

function setupStructuralEditor() {
  const editor = document.createElement('div')
  editor.className = 'vditor-ir vditor-reset'
  editor.contentEditable = 'true'
  editor.innerHTML = `
    <p data-block="0">alpha <strong class="vditor-ir__node vditor-ir__node--expand" data-type="strong"><span class="vditor-ir__marker">**</span>bold scope<span class="vditor-ir__marker">**</span></strong> omega</p>
    <ul data-block="0"><li data-block="0"><p>nested item</p></li></ul>
    <table data-block="0"><tbody><tr><td>cell one</td><td>cell two</td></tr></tbody></table>
    <div class="vditor-ir__node" data-block="0" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>const fence = true</code></pre><div data-render="true">render</div></div>
    <p data-block="0">final paragraph</p>`
  document.body.appendChild(editor)
  ;(window as unknown as { vditor?: unknown }).vditor = {
    vditor: { currentMode: 'ir', ir: { element: editor } },
  }
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

describe('installStructuralSelection', () => {
  it('stages Ctrl+A from block to document', () => {
    const { editor } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    const alpha = editor.querySelector('p')!.firstChild as Text
    placeCaret(alpha, 2)
    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(true)
    const selection = getSelection()!
    expect(selection.toString()).toContain('alpha')
    expect(selection.toString()).not.toContain('final paragraph')
    const blockRange = selection.getRangeAt(0).cloneRange()

    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(selection.toString()).toContain('final paragraph')
    expect(rangesEqual(blockRange, selection.getRangeAt(0))).toBe(false)
    teardown()
  })

  it('keeps Vditor fence-source Ctrl+A as stage 0, then widens block → document', () => {
    const { editor, code } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(code.firstChild!, 3)
    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(getSelection()?.toString()).toBe('const fence = true')

    const source = document.createRange()
    source.selectNodeContents(code)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(source)
    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(selection.toString()).toContain('const fence = true')
    expect(selection.toString()).toContain('render')
    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(selection.getRangeAt(0).startContainer).toBe(editor)
    teardown()
  })

  it('widens Ctrl+E from marker-free inline content to block to document', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(strong.childNodes[1]!, 2)
    structuralKey('e', { ctrlKey: true })
    expect(getSelection()?.toString()).toBe('bold scope')
    structuralKey('e', { ctrlKey: true })
    expect(getSelection()?.toString()).toContain('alpha')
    structuralKey('e', { ctrlKey: true })
    expect(getSelection()?.toString()).toContain('final paragraph')
    teardown()
  })

  it('restores the intended scope after focus disturbs the old Range', () => {
    const { editor, strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(strong.childNodes[1]!, 2)
    editor.focus = () => getSelection()?.removeAllRanges()
    structuralKey('e', { ctrlKey: true })
    expect(getSelection()?.toString()).toBe('bold scope')
    teardown()
  })

  it('keeps later document handlers from collapsing a handled scope', () => {
    const { strong } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    const later = vi.fn(() => getSelection()?.removeAllRanges())
    document.addEventListener('keydown', later, true)
    placeCaret(strong.childNodes[1]!, 2)
    structuralKey('e', { ctrlKey: true })
    expect(later).not.toHaveBeenCalled()
    expect(getSelection()?.toString()).toBe('bold scope')
    document.removeEventListener('keydown', later, true)
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
    const { editor } = setupStructuralEditor()
    const teardown = installStructuralSelection()
    placeCaret(editor.querySelector('p')!.firstChild!, 2)
    expect(
      structuralKey('a', { ctrlKey: true, isComposing: true }).defaultPrevented,
    ).toBe(false)
    teardown()
    expect(structuralKey('a', { ctrlKey: true }).defaultPrevented).toBe(false)
  })
})
