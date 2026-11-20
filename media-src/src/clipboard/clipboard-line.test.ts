// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  expandToLine,
  installClipboardLine,
  isCaretRange,
} from './clipboard-line'

function editorWith(html: string): HTMLElement {
  document.body.innerHTML = `<div class="vditor-ir__wrap" id="ed">${html}</div>`
  return document.getElementById('ed') as HTMLElement
}

/** Collapsed caret at `offset` inside the first text node of `selector`. */
function caretIn(root: ParentNode, selector: string, offset = 1) {
  const el = root.querySelector(selector) as HTMLElement
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode() as Text
  const range = document.createRange()
  range.setStart(text, offset)
  range.collapse(true)
  const sel = window.getSelection()
  if (!sel) throw new Error('no selection')
  sel.removeAllRanges()
  sel.addRange(range)
}

function selectedText(): string {
  return window.getSelection()?.toString() ?? ''
}

beforeEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('expandToLine', () => {
  it('grows a collapsed caret to the whole paragraph', () => {
    const ed = editorWith('<p>first line</p><p>second line</p>')
    caretIn(ed, 'p')
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('first line')
  })

  it('takes the paragraph the caret is actually in, not the first one', () => {
    const ed = editorWith('<p>first line</p><p>second line</p>')
    caretIn(ed, 'p:nth-of-type(2)')
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('second line')
  })

  it.each([
    ['h2', '<h2>a heading</h2>', 'a heading'],
    ['li', '<ul><li>a bullet</li></ul>', 'a bullet'],
    ['blockquote', '<blockquote>quoted</blockquote>', 'quoted'],
    ['pre', '<pre><code>code line</code></pre>', 'code line'],
  ])('treats a %s as a line', (sel, html, expected) => {
    const ed = editorWith(html)
    caretIn(ed, sel === 'pre' ? 'code' : sel)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe(expected)
  })

  it('takes the innermost block — a list item, not the whole list', () => {
    const ed = editorWith('<ul><li>one</li><li>two</li></ul>')
    caretIn(ed, 'li:nth-of-type(2)')
    expandToLine(ed)
    expect(selectedText()).toBe('two')
  })

  it('leaves a real selection exactly as the user made it', () => {
    const ed = editorWith('<p>hello world</p>')
    const text = ed.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText(), 'the user selection is untouched').toBe('hello')
  })
})

describe('expandToLine — when it must refuse (so a cut deletes nothing)', () => {
  it('refuses on an empty block rather than selecting nothing', () => {
    const ed = editorWith('<p></p>')
    const range = document.createRange()
    range.selectNodeContents(ed.querySelector('p') as HTMLElement)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    expect(expandToLine(ed)).toBe(false)
  })

  it('refuses when the caret is outside this editor', () => {
    const ed = editorWith('<p>inside</p>')
    document.body.insertAdjacentHTML('beforeend', '<p id="out">outside</p>')
    caretIn(document, '#out')
    expect(expandToLine(ed)).toBe(false)
  })

  it('refuses when there is no selection at all', () => {
    const ed = editorWith('<p>text</p>')
    window.getSelection()?.removeAllRanges()
    expect(expandToLine(ed)).toBe(false)
  })

  it('refuses when there is no editor element', () => {
    editorWith('<p>text</p>')
    caretIn(document, 'p')
    expect(expandToLine(null)).toBe(false)
  })
})

// The shape Vditor's undo snapshot leaves behind (Task 580 CP2-11, measured in VS Code): its
// `insertNode` marker split the caret's text node and moved the range end past the removed marker.
function splitCaret(ed: HTMLElement): void {
  const text = ed.querySelector('p')?.firstChild as Text
  const tail = text.splitText(3)
  const empty = document.createTextNode('')
  text.after(empty)
  const range = document.createRange()
  range.setStart(text, 3)
  range.setEnd(tail.parentNode as Node, 2)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
}

describe('isCaretRange', () => {
  it('is true for a collapsed range and for an empty split-off text span', () => {
    const ed = editorWith('<p>a line</p>')
    caretIn(ed, 'p')
    expect(isCaretRange(window.getSelection()?.getRangeAt(0) as Range)).toBe(
      true,
    )
    splitCaret(ed)
    const range = window.getSelection()?.getRangeAt(0) as Range
    expect(range.collapsed).toBe(false)
    expect(isCaretRange(range)).toBe(true)
  })

  it('is false for selected text and for a selected line break', () => {
    const ed = editorWith('<p>ab<br>cd</p>')
    const range = document.createRange()
    range.setStart(ed.querySelector('p') as Node, 0)
    range.setEnd(ed.querySelector('p') as Node, 1)
    expect(isCaretRange(range)).toBe(false)
    range.setStart(ed.querySelector('p') as Node, 1)
    range.setEnd(ed.querySelector('p') as Node, 2)
    expect(range.toString()).toBe('')
    expect(isCaretRange(range)).toBe(false)
  })

  it('lets expandToLine take the line from the empty split-off span', () => {
    const ed = editorWith('<p>a line</p><p>other</p>')
    splitCaret(ed)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('a line')
  })
})

describe('installClipboardLine', () => {
  it('exposes the helper under the name the Vditor patches call', () => {
    const win = window as unknown as Window & typeof globalThis
    installClipboardLine(win)
    const ed = editorWith('<p>a line</p>')
    caretIn(ed, 'p')
    const fn = (win as unknown as Record<string, unknown>)
      .__vmdeExpandToLine as (el: HTMLElement | null) => boolean
    expect(fn(ed)).toBe(true)
    expect(selectedText()).toBe('a line')
  })

  it('reports TRUE on an internal error so Vditor keeps its own behaviour', () => {
    const win = window as unknown as Window & typeof globalThis
    installClipboardLine(win)
    const ed = editorWith('<p>a line</p>')
    caretIn(ed, 'p')
    const fn = (win as unknown as Record<string, unknown>)
      .__vmdeExpandToLine as (el: unknown) => boolean
    // A collapsed caret gets as far as the containment check, where this argument throws.
    expect(fn({ contains: () => throwing() })).toBe(true)
  })
})

function throwing(): never {
  throw new Error('boom')
}

// Task 580 (CP2-11): the expansion runs on `beforecopy`/`beforecut`, which Chromium fires for
// every copy/cut (VS Code's command path included), so no copy/cut key is matched any more.
describe('the before-event expansion', () => {
  const before = (type: 'beforecopy' | 'beforecut') => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event
  }
  const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    )
  const take = () =>
    (
      window as unknown as Record<string, () => boolean | undefined>
    ).__vmdeTakeCutIntent()

  function irEditor(html = '<p>a line</p><p>other</p>'): HTMLElement {
    document.body.innerHTML = `<div class="vditor-ir"><pre class="vditor-reset" id="ed" contenteditable="true">${html}</pre></div><input id="find">`
    const ed = document.getElementById('ed') as HTMLElement
    ed.focus()
    return ed
  }

  function selectFirst(ed: HTMLElement, end: number) {
    const text = ed.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, end)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  beforeEach(() => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    ;(window as unknown as Record<string, unknown>).__vmdeCutIntent = undefined
  })

  it('expands a collapsed caret on beforecopy and cancels it so the copy runs', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    expect(before('beforecopy').defaultPrevented).toBe(true)
    expect(selectedText()).toBe('a line')
    expect(take(), 'only the cut path records an intent').toBe(undefined)
  })

  it('expands a collapsed caret on beforecut and records FALSE so the cut deletes the block', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    expect(before('beforecut').defaultPrevented).toBe(true)
    expect(selectedText()).toBe('a line')
    expect(take()).toBe(false)
  })

  it("treats the empty split-off span Vditor's undo snapshot leaves as a caret", () => {
    const ed = irEditor()
    splitCaret(ed)
    expect(before('beforecut').defaultPrevented).toBe(true)
    expect(selectedText()).toBe('a line')
    expect(take()).toBe(false)
  })

  it('leaves a real selection alone and records FALSE for its cut', () => {
    const ed = irEditor()
    selectFirst(ed, 1)
    expect(before('beforecopy').defaultPrevented).toBe(false)
    expect(selectedText()).toBe('a')
    expect(before('beforecut').defaultPrevented).toBe(false)
    expect(selectedText()).toBe('a')
    expect(take()).toBe(false)
  })

  it('records TRUE when a collapsed caret has no line to take, so the cut stays inert', () => {
    const ed = irEditor('<p></p>')
    const range = document.createRange()
    range.setStart(ed.querySelector('p') as HTMLElement, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(before('beforecut').defaultPrevented).toBe(false)
    expect(take()).toBe(true)
  })

  it('does not expand when focus is outside the editor (Find input, link popover)', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    ;(document.getElementById('find') as HTMLInputElement).focus()
    caretIn(ed, 'p')
    expect(before('beforecopy').defaultPrevented).toBe(false)
    expect(selectedText()).toBe('')
  })

  it('is READ-ONCE — a second cut falls back to the live selection', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    before('beforecut')
    expect(take()).toBe(false)
    expect(take(), 'a synthetic cut must not reuse an earlier answer').toBe(
      undefined,
    )
  })

  it('goes stale, so an old before-event cannot govern a much later cut', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    before('beforecut')
    ;(
      window as unknown as Record<string, { collapsed: boolean; at: number }>
    ).__vmdeCutIntent = { collapsed: true, at: Date.now() - 60_000 }
    expect(take()).toBe(undefined)
  })

  it('matches no copy/cut key: Ctrl+C, Ctrl+X and Ctrl+Shift+C leave the caret collapsed', () => {
    const ed = irEditor()
    caretIn(ed, 'p')
    press('c')
    press('x')
    press('C', { shiftKey: true })
    expect(selectedText()).toBe('')
    expect(take()).toBe(undefined)
  })
})

// Task 614: split mode (SV) puts the whole document in one `div[data-block]` (Vditor's `setValue`)
// or in a few of them (its re-spin splits at blank lines), so the block is not a line there. The
// line is the SOURCE line: everything between two `span[data-type="newline"]`, plus the newline
// that ends it — what VS Code's own collapsed copy/cut takes.
describe('expandToLine — split mode takes the source line', () => {
  // Lute's `SpinVditorSVDOM` output for these sources (lute.min.js run in Node), unchanged.
  const NL =
    '<span data-type="newline"><br><span style="display: none">\n</span></span>'
  const text = (t: string, cls = '') =>
    `<span data-type="text"${cls ? ` class="${cls}"` : ''}>${t}</span>`
  const SOURCE =
    '# Title\n\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\nLast paragraph ZULU.\n'
  const SOURCE_DOM =
    `<span class="vditor-sv__marker--heading h1" data-type="heading-marker"># </span>${text('Title', 'h1')}${NL}${NL}` +
    `${text('First paragraph ALPHA.')}${NL}${NL}` +
    `${text('Anchor line BRAVO with a second sentence.')}${NL}${NL}` +
    `${text('Last paragraph ZULU.')}${NL}${NL}`

  function svEditor(blocks: string[]): HTMLElement {
    document.body.innerHTML = `<pre class="vditor-sv vditor-reset" id="ed" contenteditable="true">${blocks
      .map((b) => `<div data-block="0">${b}</div>`)
      .join('')}</pre><input id="find">`
    const ed = document.getElementById('ed') as HTMLElement
    ed.focus()
    return ed
  }

  /** Collapsed caret `offset` characters into the first text node containing `needle`. */
  function caretAt(ed: HTMLElement, needle: string, offset: number) {
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n.textContent ?? '').indexOf(needle)
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i + offset)
      range.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      return
    }
    throw new Error(`anchor ${needle} not found`)
  }

  /** The editor text after deleting the selection, as a cut's delete leaves it. */
  function textAfterDelete(ed: HTMLElement): string {
    window.getSelection()?.getRangeAt(0).deleteContents()
    return ed.textContent ?? ''
  }

  // The DOM has one more trailing newline than the source (Lute ends with a blank line); the
  // editor's text is the source plus that newline.
  const dom = (source: string) => `${source}\n`

  it('a caret in the middle line takes that line and its newline, not the document', () => {
    const ed = svEditor([SOURCE_DOM])
    expect(ed.textContent).toBe(dom(SOURCE))
    caretAt(ed, 'BRAVO', 2)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
    expect(textAfterDelete(ed)).toBe(
      dom('# Title\n\nFirst paragraph ALPHA.\n\n\nLast paragraph ZULU.\n'),
    )
  })

  it('the first line keeps its marker', () => {
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'Title', 2)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('# Title\n')
    expect(textAfterDelete(ed)).toBe(
      dom(
        '\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\nLast paragraph ZULU.\n',
      ),
    )
  })

  it('the last line', () => {
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'ZULU', 2)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('Last paragraph ZULU.\n')
    expect(textAfterDelete(ed)).toBe(
      dom(
        '# Title\n\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\n',
      ),
    )
  })

  it('a last line without a newline after it takes its text only', () => {
    const ed = svEditor([`${text('one')}${NL}${text('two')}`])
    caretAt(ed, 'two', 1)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('two')
    expect(textAfterDelete(ed)).toBe('one\n')
  })

  it('one source line of a multi-line paragraph, not the paragraph', () => {
    const ed = svEditor([`${text('line A')}${NL}${text('line B')}${NL}${NL}`])
    caretAt(ed, 'line B', 3)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('line B\n')
  })

  it('a list item line keeps its marker', () => {
    const ed = svEditor([
      `<span data-type="li-marker" class="vditor-sv__marker">- </span>${text('item one')}${NL}` +
        `<span data-type="li-marker" class="vditor-sv__marker">- </span>${text('item two')}${NL}${NL}`,
    ])
    caretAt(ed, 'item two', 2)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('- item two\n')
  })

  it('a caret in an empty line takes just its newline', () => {
    const ed = svEditor([SOURCE_DOM])
    // The caret Chromium shows on the blank line after "Title": inside its newline span.
    const blank = ed.querySelectorAll('span[data-type="newline"]')[1] as Element
    const range = document.createRange()
    range.setStart(blank, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('\n')
  })

  it('a caret right after a newline span is on the next line', () => {
    const ed = svEditor([SOURCE_DOM])
    const block = ed.querySelector('div[data-block]') as Element
    const third = ed.querySelectorAll('span[data-type="newline"]')[3] as Element
    const range = document.createRange()
    range.setStart(block, [...block.childNodes].indexOf(third) + 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
  })

  it('a line in a later re-spun block starts inside that block, not at the end of the previous one', () => {
    // Vditor's SV re-spin (`processSpinVditorSVDOM`) splits blocks after a blank line.
    const ed = svEditor([
      `${text('First paragraph ALPHA.')}${NL}${NL}`,
      `${text('Anchor line BRAVO with a second sentence.')}${NL}${NL}`,
      `${text('Last paragraph ZULU.')}${NL}${NL}`,
    ])
    caretAt(ed, 'BRAVO', 2)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
    const range = window.getSelection()?.getRangeAt(0) as Range
    const second = ed.querySelectorAll('div[data-block]')[1] as Element
    expect(second.contains(range.startContainer)).toBe(true)
    expect(second.contains(range.endContainer)).toBe(true)
  })

  it('refuses on the empty line after the final newline', () => {
    const ed = svEditor([`${text('only')}${NL}`])
    const block = ed.querySelector('div[data-block]') as Element
    const range = document.createRange()
    range.setStart(block, block.childNodes.length)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(expandToLine(ed)).toBe(false)
  })

  it('takes the line from the empty split-off span the undo snapshot leaves', () => {
    const ed = svEditor([SOURCE_DOM])
    const bravo = [...ed.querySelectorAll('span[data-type="text"]')].find((s) =>
      s.textContent?.includes('BRAVO'),
    ) as Element
    const node = bravo.firstChild as Text
    node.splitText(2)
    node.after(document.createTextNode(''))
    const range = document.createRange()
    range.setStart(node, 2)
    range.setEnd(bravo, 2)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
  })

  it('leaves a real selection alone', () => {
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'BRAVO', 0)
    const range = window.getSelection()?.getRangeAt(0) as Range
    range.setEnd(range.startContainer, range.startOffset + 5)
    expect(expandToLine(ed)).toBe(true)
    expect(selectedText()).toBe('BRAVO')
  })

  const selectLineDelete = () =>
    (
      window as unknown as Record<string, () => boolean>
    ).__vmdeSelectSvLineDelete()
  const beforeCut = () =>
    document.dispatchEvent(
      new Event('beforecut', { bubbles: true, cancelable: true }),
    )

  // Chromium's delete of a range that starts at an SV line start also eats the previous newline
  // span's hidden "\n" (measured), so the cut deletes the previous newline and the line's content
  // instead: the same characters as the copied line and its newline.
  it.each([
    [
      'middle',
      'BRAVO',
      '\nAnchor line BRAVO with a second sentence.',
      '# Title\n\nFirst paragraph ALPHA.\n\n\nLast paragraph ZULU.\n',
    ],
    [
      'first',
      'Title',
      '# Title\n',
      '\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\nLast paragraph ZULU.\n',
    ],
    [
      'last',
      'ZULU',
      '\nLast paragraph ZULU.',
      '# Title\n\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\n',
    ],
  ])(
    'the %s line cut deletes the same text from a range Chromium deletes exactly',
    (_name, needle, removed, rest) => {
      installClipboardLine(window as unknown as Window & typeof globalThis)
      const ed = svEditor([SOURCE_DOM])
      caretAt(ed, needle, 2)
      beforeCut()
      expect(selectLineDelete()).toBe(true)
      expect(selectedText()).toBe(removed)
      expect(textAfterDelete(ed)).toBe(dom(rest))
    },
  )

  it('an empty line cut deletes the previous newline', () => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    const ed = svEditor([SOURCE_DOM])
    const blank = ed.querySelectorAll('span[data-type="newline"]')[1] as Element
    const range = document.createRange()
    range.setStart(blank, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    beforeCut()
    expect(selectLineDelete()).toBe(true)
    expect(selectedText()).toBe('\n')
    expect(textAfterDelete(ed)).toBe(
      dom(
        '# Title\nFirst paragraph ALPHA.\n\nAnchor line BRAVO with a second sentence.\n\nLast paragraph ZULU.\n',
      ),
    )
  })

  it('a line in a re-spun block deletes from the end of the previous block', () => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    const ed = svEditor([
      `${text('Alpha')}${NL}${NL}`,
      `${text('Bravo')}${NL}${NL}`,
      `${text('Charlie')}${NL}${NL}`,
    ])
    caretAt(ed, 'Bravo', 2)
    beforeCut()
    expect(selectLineDelete()).toBe(true)
    expect(selectedText()).toBe('\nBravo')
    expect(textAfterDelete(ed)).toBe('Alpha\n\n\nCharlie\n\n')
  })

  it('the delete range is read once, and only while the selection is still the copied line', () => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'BRAVO', 2)
    beforeCut()
    expect(selectLineDelete()).toBe(true)
    expect(selectLineDelete(), 'read once').toBe(false)

    caretAt(ed, 'BRAVO', 2)
    beforeCut()
    caretAt(ed, 'Last', 0)
    const moved = window.getSelection()?.getRangeAt(0) as Range
    moved.setEnd(moved.startContainer, 4)
    expect(selectLineDelete(), 'the selection moved').toBe(false)
    expect(selectedText()).toBe('Last')
  })

  it('a copy line never steers a later real-selection cut', () => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'BRAVO', 2)
    document.dispatchEvent(
      new Event('beforecopy', { bubbles: true, cancelable: true }),
    )
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
    // The copied line is still selected, so a cut now is a real-selection cut.
    beforeCut()
    expect(selectLineDelete()).toBe(false)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
  })

  it('beforecut expands the line and records a real range for the cut', () => {
    installClipboardLine(window as unknown as Window & typeof globalThis)
    const ed = svEditor([SOURCE_DOM])
    caretAt(ed, 'BRAVO', 2)
    const event = new Event('beforecut', { bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(selectedText()).toBe('Anchor line BRAVO with a second sentence.\n')
    expect(
      (
        window as unknown as Record<string, () => boolean | undefined>
      ).__vmdeTakeCutIntent(),
    ).toBe(false)
  })
})

// Task 733/037: a collapsed caret at an element point (`UL,1`, the surface `PRE,n`) used to reach the
// mode wrapper's editable `<pre>` through `closest`, which passed the guard and selected the whole
// document, so Ctrl+C disclosed it and Ctrl+X deleted it. These cases use Vditor's real surface
// shape: `div.vditor-<mode> > pre.vditor-reset[contenteditable]` followed by VMDE's and Vditor's
// panels, and check all three entry points (beforecopy, beforecut, and the copy fallback the Vditor
// copy patch calls with the surface).
describe('the collapsed line stays one line block inside the editable surface', () => {
  const W = window as unknown as Window & typeof globalThis
  const store = window as unknown as Record<string, unknown>
  const FIXTURE =
    '<p>Head ALPHA</p><ul><li>item one</li><li>item two</li></ul><hr><ul><li>item three</li><li>item four</li></ul><p>Tail ZULU</p>'
  const NESTED =
    '<p>Head</p><ul><li>item a<ul><li>sub b</li></ul></li></ul><hr><p>Tail</p>'

  function surface(mode: 'ir' | 'wysiwyg', html = FIXTURE): HTMLElement {
    document.body.innerHTML =
      `<div class="vditor-${mode}"><pre class="vditor-reset" id="ed" contenteditable="true">${html}</pre>` +
      '<div class="vmde-cell-selection-status"></div><div class="vditor-panel"><button id="panel">b</button></div></div><input id="find">'
    const ed = document.getElementById('ed') as HTMLElement
    ed.focus()
    return ed
  }
  function caretAt(node: Node, offset: number) {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  }
  function textCaret(ed: HTMLElement, needle: string, at = 2) {
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n as Text).data.indexOf(needle)
      if (i >= 0) return caretAt(n, i + at)
    }
    throw new Error(`no text ${needle}`)
  }
  const fire = (type: 'beforecopy' | 'beforecut') => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    return event.defaultPrevented
  }
  const take = () => (store.__vmdeTakeCutIntent as () => boolean | undefined)()
  const fallback = (ed: HTMLElement) =>
    (store.__vmdeExpandToLine as (e: HTMLElement) => boolean)(ed)
  const collapsed = () => window.getSelection()?.getRangeAt(0).collapsed

  beforeEach(() => {
    installClipboardLine(W)
    store.__vmdeCutIntent = undefined
  })

  /** Declined at all three entry points: not cancelled, caret kept, cut inert, fallback false. */
  function expectDeclined(ed: HTMLElement, place: () => void) {
    place()
    expect(fire('beforecopy'), 'beforecopy not cancelled').toBe(false)
    expect(collapsed(), 'caret kept after beforecopy').toBe(true)
    place()
    expect(fire('beforecut'), 'beforecut not cancelled').toBe(false)
    expect(collapsed(), 'caret kept after beforecut').toBe(true)
    expect(take(), 'cut stays inert').toBe(true)
    place()
    expect(fallback(ed), 'copy fallback declines').toBe(false)
    expect(collapsed(), 'caret kept after the fallback').toBe(true)
  }
  /** Resolved at all three entry points to exactly `line`. */
  function expectLine(ed: HTMLElement, line: string, place: () => void) {
    place()
    expect(fire('beforecopy'), 'beforecopy cancelled').toBe(true)
    expect(selectedText()).toBe(line)
    place()
    expect(fire('beforecut'), 'beforecut cancelled').toBe(true)
    expect(selectedText()).toBe(line)
    expect(take(), 'cut deletes the line').toBe(false)
    place()
    expect(fallback(ed), 'copy fallback resolves').toBe(true)
    expect(selectedText()).toBe(line)
  }

  for (const mode of ['ir', 'wysiwyg'] as const)
    describe(mode, () => {
      it('UL,1 between two items declines', () => {
        const ed = surface(mode)
        expectDeclined(ed, () => caretAt(ed.querySelector('ul') as Element, 1))
      })
      it('every interior surface point PRE,n declines', () => {
        const ed = surface(mode)
        for (let n = 1; n < ed.childNodes.length; n++)
          expectDeclined(ed, () => caretAt(ed, n))
      })
      it('UL,0 (the arrow landing over a rule) takes the first item', () => {
        const ed = surface(mode)
        expectLine(ed, 'item three', () =>
          caretAt(ed.querySelectorAll('ul')[1], 0),
        )
      })
      it('UL,len takes the last item', () => {
        const ed = surface(mode)
        const ul = ed.querySelector('ul') as Element
        expectLine(ed, 'item two', () => caretAt(ul, ul.childNodes.length))
      })
      it('the end of a nested list takes the innermost last item', () => {
        const ed = surface(mode, NESTED)
        const ul = ed.querySelector('ul') as Element
        expectLine(ed, 'sub b', () => caretAt(ul, ul.childNodes.length))
      })
      it('PRE,0 and PRE,len take the first and the last block', () => {
        const ed = surface(mode)
        expectLine(ed, 'Head ALPHA', () => caretAt(ed, 0))
        expectLine(ed, 'Tail ZULU', () => caretAt(ed, ed.childNodes.length))
      })
      it('an edge that is a rule declines', () => {
        const ed = surface(mode, '<hr><p>after</p>')
        expectDeclined(ed, () => caretAt(ed, 0))
      })
      it('text directly under the surface declines', () => {
        const ed = surface(mode, 'stray<p>after</p>')
        expectDeclined(ed, () => textCaret(ed, 'stray'))
      })
      it('whitespace text between items is skipped: still ambiguous', () => {
        const ed = surface(mode, '<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
        expectDeclined(ed, () => caretAt(ed.querySelector('ul') as Element, 2))
      })
      it('table: TBODY,1 declines; TR,1 takes the row; TABLE,0 takes the header row', () => {
        const ed = surface(
          mode,
          '<p>x</p><table><thead><tr><th>h1</th><th>h2</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table><p>y</p>',
        )
        expectDeclined(ed, () =>
          caretAt(ed.querySelector('tbody') as Element, 1),
        )
        const row = ed.querySelector('tbody tr') as Element
        expectLine(ed, 'ab', () => caretAt(row, 1))
        expectLine(ed, 'h1h2', () =>
          caretAt(ed.querySelector('table') as Element, 0),
        )
      })
      it('a blockquote point between two paragraphs declines', () => {
        const ed = surface(mode, '<blockquote><p>q1</p><p>q2</p></blockquote>')
        expectDeclined(ed, () =>
          caretAt(ed.querySelector('blockquote') as Element, 1),
        )
      })
      it('an inline element point P,1 takes the paragraph (an inline IR node is not a block)', () => {
        const ed = surface(
          mode,
          '<p>a <span class="vditor-ir__node" data-type="strong">bold</span> c</p><p>z</p>',
        )
        expectLine(ed, 'a bold c', () =>
          caretAt(ed.querySelector('p') as Element, 1),
        )
      })

      // A tight list item that holds a nested list is two lines: its own text and the nested item.
      it('mixed item: LI,1 after its text takes only its own text', () => {
        const ed = surface(mode, NESTED)
        expectLine(ed, 'item a', () =>
          caretAt(ed.querySelector('li') as Element, 1),
        )
      })
      it('mixed item: a text caret in its own text takes only that text', () => {
        const ed = surface(mode, NESTED)
        expectLine(ed, 'item a', () => textCaret(ed, 'item a'))
      })
      it('mixed item: the outer UL,0 takes only the first item text', () => {
        const ed = surface(mode, NESTED)
        expectLine(ed, 'item a', () =>
          caretAt(ed.querySelector('ul') as Element, 0),
        )
      })
      it('mixed item: a text caret in the nested item takes the nested item', () => {
        const ed = surface(mode, NESTED)
        expectLine(ed, 'sub b', () => textCaret(ed, 'sub b'))
      })
      it('mixed item: a point between two nested lists declines', () => {
        const ed = surface(
          mode,
          '<ul><li>item a<ul><li>s1</li></ul><ul><li>s2</li></ul></li></ul>',
        )
        expectDeclined(ed, () => caretAt(ed.querySelector('li') as Element, 2))
      })
      it('mixed item: a whitespace-only run declines', () => {
        const ed = surface(
          mode,
          '<ul><li><ul><li>s1</li></ul> <ul><li>s2</li></ul></li></ul>',
        )
        expectDeclined(ed, () => {
          const li = ed.querySelector('li') as Element
          caretAt(li.childNodes[1], 0)
        })
      })

      it('control: a text caret takes its item', () => {
        const ed = surface(mode)
        expectLine(ed, 'item one', () => textCaret(ed, 'item one'))
      })
      it('control: an explicit selection is untouched and not cancelled', () => {
        const ed = surface(mode)
        const text = ed.querySelector('p')?.firstChild as Text
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 4)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        expect(fire('beforecopy')).toBe(false)
        expect(fire('beforecut')).toBe(false)
        expect(selectedText()).toBe('Head')
        expect(take()).toBe(false)
        expect(fallback(ed)).toBe(true)
        expect(selectedText()).toBe('Head')
      })
      it('control: an explicit selection across table cells is untouched', () => {
        const ed = surface(
          mode,
          '<table><tbody><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>',
        )
        const cells = ed.querySelectorAll('td')
        const range = document.createRange()
        range.setStart(cells[0].firstChild as Text, 0)
        range.setEnd(cells[3].firstChild as Text, 2)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        expect(fire('beforecopy')).toBe(false)
        expect(fire('beforecut')).toBe(false)
        expect(selectedText()).toBe('a1b1a2b2')
        expect(take()).toBe(false)
      })
      it('control: an empty paragraph declines', () => {
        const ed = surface(mode, '<p></p><p>x</p>')
        expectDeclined(ed, () => caretAt(ed.querySelector('p') as Element, 0))
      })
      it('focus on a control inside the mode wrapper but outside the surface does not expand', () => {
        const ed = surface(mode)
        ;(document.getElementById('panel') as HTMLButtonElement).focus()
        textCaret(ed, 'item one')
        expect(fire('beforecopy')).toBe(false)
        expect(collapsed()).toBe(true)
        textCaret(ed, 'item one')
        expect(fire('beforecut')).toBe(false)
        expect(take()).toBe(true)
      })
      it('a wrapper whose first child is not the editable pre does not expand', () => {
        document.body.innerHTML =
          `<div class="vditor-${mode}"><div class="vditor-panel" id="ed" contenteditable="true"><p>Head ALPHA</p></div>` +
          '<pre class="vditor-reset" contenteditable="true"><p>other</p></pre></div>'
        const ed = document.getElementById('ed') as HTMLElement
        ed.focus()
        textCaret(ed, 'Head')
        expect(fire('beforecopy')).toBe(false)
        expect(collapsed()).toBe(true)
        textCaret(ed, 'Head')
        expect(fire('beforecut')).toBe(false)
        expect(take()).toBe(true)
      })
    })
})
