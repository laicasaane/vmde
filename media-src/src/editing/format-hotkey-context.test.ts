// @vitest-environment jsdom

// Task 596 Part 2 S1: the pure gate that decides, from the live selection, what Vditor's own
// toolbar highlight (`highlightToolbarIR` / `highlightToolbarWYSIWYG`) would have set on the 12
// hotkey toolbar buttons. The DOM below mirrors the shapes probed in real VS Code
// (tmp/task596-603-evidence/t596): IR wraps an inline mark in `span[data-type]` with marker spans
// and a `strong`/`em`/`s`/`code` child; WYSIWYG uses bare `STRONG`/`EM`/`S`/`CODE` tags.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOOLBAR_COMMAND_NAMES } from '../../../src/shared/editor-shortcuts'
import type { InnerVditor } from '../util/inner-vditor'
import {
  HOTKEY_GATED_TOOLBAR_NAMES,
  clickToolbarHotkeyButton,
  resolveVditorEditorRange,
  syncToolbarButtonGate,
  toolbarHotkeyGate,
} from './format-hotkey-context'

type Mode = 'ir' | 'wysiwyg' | 'sv'
const NAMES = [...HOTKEY_GATED_TOOLBAR_NAMES]

afterEach(() => {
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
  ;(window as unknown as { vditor: unknown }).vditor = undefined
})

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const IR_MARK = (type: string, marker: string, tag: string, text: string) =>
  `<span data-type="${type}" class="vditor-ir__node">` +
  `<span class="vditor-ir__marker vditor-ir__marker--${type}">${marker}</span>` +
  `<${tag} data-newline="1">${text}</${tag}>` +
  `<span class="vditor-ir__marker vditor-ir__marker--${type}">${marker}</span></span>`

const IR_HTML =
  '<h1 data-block="0" data-type="heading" id="h"><span class="vditor-ir__marker" data-type="heading-marker"># </span>Heading one</h1>' +
  '<p data-block="0" id="plain">Alpha bravo charlie delta.</p>' +
  `<p data-block="0" id="code">Echo ${IR_MARK('code', '`', 'code', 'foxtrot')} golf</p>` +
  `<p data-block="0" id="strong">${IR_MARK('strong', '**', 'strong', 'India')} juliet</p>` +
  `<p data-block="0" id="em">${IR_MARK('em', '*', 'em', 'kilo')} x</p>` +
  `<p data-block="0" id="s">${IR_MARK('s', '~~', 's', 'lima')} x</p>` +
  '<ul data-tight="true" data-marker="-" data-block="0" id="ul"><li data-marker="-" id="uli">mike</li><li data-marker="-">november</li></ul>' +
  '<ol data-tight="true" data-marker="1." data-block="0" id="ol"><li data-marker="1." id="oli">one</li></ol>' +
  '<ul data-tight="true" data-marker="-" data-block="0" id="tl"><li data-marker="-" class="vditor-task" id="tli"><input type="checkbox" /> task</li></ul>' +
  '<blockquote data-block="0" id="bq"><p data-block="0" id="bqp">oscar papa</p></blockquote>' +
  '<blockquote data-block="0" id="bqcode"><div class="vditor-ir__node" data-type="code-block" data-block="0"><pre class="vditor-ir__marker--pre"><code id="bqcodetext">inquote</code></pre></div></blockquote>' +
  '<div class="vditor-ir__node" data-type="code-block" data-block="0" id="cb"><span data-type="code-block-open-marker">```</span><pre class="vditor-ir__marker--pre"><code id="cbtext">const x = 1</code></pre><span data-type="code-block-close-marker">```</span></div>' +
  '<table data-block="0" data-type="table" id="tbl"><thead><tr><th>head</th></tr></thead><tbody><tr><td id="cell">cell</td></tr></tbody></table>'

const WYS_HTML =
  '<h1 data-block="0" id="h">Heading one</h1>' +
  '<h2 data-block="0" id="hcode">Head <code id="hcodetext">inline</code></h2>' +
  '<p data-block="0" id="plain">Alpha bravo charlie delta.</p>' +
  '<p data-block="0" id="code">Echo <code id="codetext">foxtrot</code> golf</p>' +
  '<p data-block="0" id="strong"><strong data-marker="**">India</strong> juliet</p>' +
  '<p data-block="0" id="b"><b>bee</b> x</p>' +
  '<p data-block="0" id="em"><em data-marker="*">kilo</em> x</p>' +
  '<p data-block="0" id="i"><i>eye</i> x</p>' +
  '<p data-block="0" id="s"><s data-marker="~~">lima</s> x</p>' +
  '<p data-block="0" id="strike"><strike>old</strike> x</p>' +
  '<p data-block="0" id="empty"></p>' +
  '<ul data-tight="true" data-marker="-" data-block="0" id="ul"><li data-marker="-" id="uli">mike</li><li data-marker="-">november</li></ul>' +
  '<ol data-tight="true" data-marker="1." data-block="0" id="ol"><li data-marker="1." id="oli">one</li></ol>' +
  '<ul data-tight="true" data-marker="-" data-block="0" id="tl"><li data-marker="-" class="vditor-task" id="tli"><input type="checkbox" /> task</li></ul>' +
  '<blockquote data-block="0" id="bq"><p data-block="0" id="bqp">oscar papa</p></blockquote>' +
  '<blockquote data-block="0"><p data-block="0"><code id="bqcodetext">quoted</code></p></blockquote>' +
  '<div class="vditor-wysiwyg__block" data-type="code-block" data-block="0"><pre><code id="cbtext" class="language-js">const x = 1</code></pre></div>' +
  '<table data-block="0" id="tbl"><thead><tr><th>head</th></tr></thead><tbody><tr><td id="cell">cell</td></tr></tbody></table>' +
  '<div data-type="footnotes-block" data-block="0" id="fnb"><ol data-type="footnotes-block"><li data-type="footnotes-li" data-marker="1" id="fnli"><p id="fnp">note</p></li></ol></div>'

function mount(mode: 'ir' | 'wysiwyg'): HTMLElement {
  const editor = document.createElement('div')
  editor.className = `vditor-reset vditor-${mode}`
  editor.setAttribute('contenteditable', 'true')
  editor.innerHTML = mode === 'ir' ? IR_HTML : WYS_HTML
  document.body.append(editor)
  return editor
}

const byId = (editor: HTMLElement, id: string): HTMLElement => {
  const el = editor.querySelector<HTMLElement>(`#${id}`)
  if (!el) throw new Error(`fixture id ${id} missing`)
  return el
}

/** A collapsed range at the first text node of `el` (offset `offset`), or at `el` itself when it
 *  has no text. */
function caretIn(el: HTMLElement, offset = 1): Range {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const text = walker.nextNode()
  const range = document.createRange()
  if (text)
    range.setStart(text, Math.min(offset, text.textContent?.length ?? 0))
  else range.setStart(el, 0)
  range.collapse(true)
  return range
}

function rangeAt(node: Node, offset: number): Range {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  return range
}

function gate(
  mode: Mode,
  range: Range | null,
  editor: HTMLElement | null,
  name: string,
  fullPreview = false,
) {
  return toolbarHotkeyGate(mode, range, editor, name, { fullPreview })
}

/** Assert all 12 names: those in `disabled` are disabled, those in `current` are current, all
 *  others are neither. A name in both lists must be both (Vditor sets both for a code block). */
function expectGates(
  mode: Mode,
  range: Range,
  editor: HTMLElement,
  expected: { disabled?: string[]; current?: string[] },
) {
  const disabled = new Set(expected.disabled ?? [])
  const current = new Set(expected.current ?? [])
  for (const name of NAMES) {
    expect(gate(mode, range, editor, name), `${mode} ${name}`).toEqual({
      disabled: disabled.has(name),
      current: current.has(name),
    })
  }
}

const NO_INDENT = ['indent', 'outdent']
const CODE_DISABLED = [
  'headings',
  'bold',
  'italic',
  'strike',
  'quote',
  'list',
  'ordered-list',
  'check',
  'code',
]

// ---------------------------------------------------------------------------------------------
// The name list
// ---------------------------------------------------------------------------------------------

describe('HOTKEY_GATED_TOOLBAR_NAMES', () => {
  it('is every toolbar command name except undo and redo, which take the engine path', () => {
    expect([...HOTKEY_GATED_TOOLBAR_NAMES].sort()).toEqual(
      [...TOOLBAR_COMMAND_NAMES]
        .filter((n) => n !== 'undo' && n !== 'redo')
        .sort(),
    )
    expect(HOTKEY_GATED_TOOLBAR_NAMES).toHaveLength(12)
  })

  it('reads a name the highlight does not decide as enabled and not current', () => {
    const editor = mount('ir')
    const range = caretIn(byId(editor, 'plain'))
    expect(gate('ir', range, editor, 'undo')).toEqual({
      disabled: false,
      current: false,
    })
  })
})

// ---------------------------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------------------------

describe('toolbarHotkeyGate in IR', () => {
  it('plain text: nothing current, indent and outdent disabled', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'plain')), editor, {
      disabled: NO_INDENT,
    })
  })

  it('heading: headings current', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'h'), 3), editor, {
      disabled: NO_INDENT,
      current: ['headings'],
    })
  })

  it.each([
    ['strong', 'bold'],
    ['em', 'italic'],
    ['s', 'strike'],
  ])('inside %s: only %s is current', (id, name) => {
    const editor = mount('ir')
    const text = byId(editor, id).querySelector('strong,em,s') as HTMLElement
    expectGates('ir', caretIn(text, 2), editor, {
      disabled: NO_INDENT,
      current: [name],
    })
  })

  it('inline code: disables bold but not inline-code, which is current', () => {
    const editor = mount('ir')
    const code = byId(editor, 'code').querySelector('code') as HTMLElement
    expectGates('ir', caretIn(code, 3), editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
  })

  it('code block: code is disabled and current at once; inline-code disabled', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'cbtext'), 2), editor, {
      disabled: [...CODE_DISABLED, 'inline-code', ...NO_INDENT],
      current: ['code'],
    })
  })

  it('inline code inside a list item: list is current and disabled at once, indent enabled', () => {
    const editor = mount('ir')
    const ul = document.createElement('ul')
    ul.innerHTML = `<li data-marker="-">${IR_MARK('code', '`', 'code', 'x')}</li>`
    editor.append(ul)
    const code = ul.querySelector('code') as HTMLElement
    expectGates('ir', caretIn(code, 1), editor, {
      disabled: CODE_DISABLED,
      current: ['list', 'inline-code'],
    })
  })

  it('a code block inside a quote is quote current and disabled at once', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'bqcodetext'), 2), editor, {
      disabled: [...CODE_DISABLED, 'inline-code', ...NO_INDENT],
      current: ['code', 'quote'],
    })
  })

  it.each([
    ['uli', 'list'],
    ['oli', 'ordered-list'],
    ['tli', 'check'],
  ])('list item %s: %s current, indent and outdent enabled', (id, name) => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, id), 1), editor, {
      current: [name],
    })
  })

  it('blockquote: quote current', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'bqp'), 2), editor, {
      disabled: NO_INDENT,
      current: ['quote'],
    })
  })

  it('table cell: headings, the list family, quote and code disabled', () => {
    const editor = mount('ir')
    expectGates('ir', caretIn(byId(editor, 'cell'), 1), editor, {
      disabled: [
        'headings',
        'list',
        'ordered-list',
        'check',
        'quote',
        'code',
        ...NO_INDENT,
      ],
    })
  })

  it('an element start that is not the editor is classified as itself, not by child', () => {
    // Vditor's IR rule: `P`@0 whose first child is a strong node resolves to the P (IR only maps
    // the `.vditor-reset` root to a child), so bold is NOT current. WYSIWYG differs, below.
    const editor = mount('ir')
    const p = byId(editor, 'strong')
    expectGates('ir', rangeAt(p, 0), editor, { disabled: NO_INDENT })
  })

  it('the editor root resolves to childNodes[startOffset]', () => {
    const editor = mount('ir')
    const index = (id: string) =>
      Array.prototype.indexOf.call(editor.childNodes, byId(editor, id))
    expectGates('ir', rangeAt(editor, index('h')), editor, {
      disabled: NO_INDENT,
      current: ['headings'],
    })
    expectGates('ir', rangeAt(editor, index('bq')), editor, {
      disabled: NO_INDENT,
      current: ['quote'],
    })
    expectGates('ir', rangeAt(editor, index('ul')), editor, {
      disabled: NO_INDENT,
    })
  })

  it('a root offset past the end has no element, so nothing is current', () => {
    const editor = mount('ir')
    expectGates('ir', rangeAt(editor, editor.childNodes.length), editor, {
      disabled: NO_INDENT,
    })
  })

  it('a text node directly under the root maps through the root offset like Vditor', () => {
    // highlightToolbarIR.ts:21-27 maps text to its parent, then re-maps a `.vditor-reset` parent
    // through `childNodes[startOffset]` using the TEXT offset. Mirror that, quirk included.
    const editor = document.createElement('div')
    editor.className = 'vditor-reset'
    editor.setAttribute('contenteditable', 'true')
    editor.innerHTML = '<h1 id="h">title</h1>'
    editor.prepend(document.createTextNode('x'))
    document.body.append(editor)
    const text = editor.firstChild as Text
    // text offset 1 -> childNodes[1] is the h1.
    expectGates('ir', rangeAt(text, 1), editor, {
      disabled: NO_INDENT,
      current: ['headings'],
    })
    // text offset 0 -> childNodes[0] is the text node itself.
    expectGates('ir', rangeAt(text, 0), editor, { disabled: NO_INDENT })
  })

  it('a backward selection is gated on its range start', () => {
    const editor = mount('ir')
    const code = byId(editor, 'code').querySelector('code') as HTMLElement
    const plain = byId(editor, 'plain').firstChild as Text
    const codeText = code.firstChild as Text
    // anchor in plain text AFTER the code, focus inside the code: the normalized range starts in
    // the code even though the user dragged backward.
    const after = byId(editor, 'strong').querySelector('strong')?.firstChild
    const selection = getSelection()
    selection?.setBaseAndExtent(after as Node, 2, codeText, 2)
    const range = (selection as Selection).getRangeAt(0)
    expect(range.startContainer).toBe(codeText)
    expectGates('ir', range, editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
    // the mirror image: starts in plain text, ends inside code -> plain context.
    const spanning = document.createRange()
    spanning.setStart(plain, 2)
    spanning.setEnd(codeText, 2)
    expectGates('ir', spanning, editor, { disabled: NO_INDENT })
  })
})

// ---------------------------------------------------------------------------------------------
// WYSIWYG
// ---------------------------------------------------------------------------------------------

describe('toolbarHotkeyGate in WYSIWYG', () => {
  it('plain text: nothing current, indent and outdent disabled', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'plain')), editor, {
      disabled: NO_INDENT,
    })
  })

  it('heading: headings current and bold disabled', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'h'), 3), editor, {
      disabled: ['bold', ...NO_INDENT],
      current: ['headings'],
    })
  })

  it('a heading containing STRONG: bold is current and disabled at once, headings current', () => {
    // Vditor: STRONG ancestor -> bold current; heading outside CODE -> bold disabled + headings current.
    const editor = mount('wysiwyg')
    const h = document.createElement('h3')
    h.innerHTML = '<strong id="hs">bold title</strong>'
    editor.append(h)
    expectGates('wysiwyg', caretIn(byId(editor, 'hs'), 2), editor, {
      disabled: ['bold', ...NO_INDENT],
      current: ['bold', 'headings'],
    })
  })

  it('inline code inside a list item: list is current and disabled at once, indent enabled', () => {
    // Vditor: LI -> list current + indent/outdent enabled; CODE outside PRE -> list disabled,
    // inline-code current.
    const editor = mount('wysiwyg')
    const ul = document.createElement('ul')
    ul.innerHTML = '<li data-marker="-"><code id="licode">x</code></li>'
    editor.append(ul)
    expectGates('wysiwyg', caretIn(byId(editor, 'licode'), 1), editor, {
      disabled: CODE_DISABLED,
      current: ['list', 'inline-code'],
    })
  })

  it('a heading with inline code reads as code: headings neither current nor spared', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'hcodetext'), 2), editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
  })

  it.each([
    ['strong', 'bold'],
    ['b', 'bold'],
    ['em', 'italic'],
    ['i', 'italic'],
    ['s', 'strike'],
    ['strike', 'strike'],
  ])('inside <%s>: only %s is current', (id, name) => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, id), 1), editor, {
      disabled: NO_INDENT,
      current: [name],
    })
  })

  it('inline code (a bare CODE): disables bold, inline-code is current', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'codetext'), 2), editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
  })

  it('code block (CODE in PRE): code disabled and current, inline-code disabled', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'cbtext'), 2), editor, {
      disabled: [...CODE_DISABLED, 'inline-code', ...NO_INDENT],
      current: ['code'],
    })
  })

  it('inline code inside a quote: quote is current and disabled at once', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'bqcodetext'), 2), editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code', 'quote'],
    })
  })

  it.each([
    ['uli', 'list'],
    ['oli', 'ordered-list'],
    ['tli', 'check'],
  ])('list item %s: %s current, indent and outdent enabled', (id, name) => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, id), 1), editor, {
      current: [name],
    })
  })

  it('blockquote: quote current', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'bqp'), 2), editor, {
      disabled: NO_INDENT,
      current: ['quote'],
    })
  })

  it('table cell: none of the 12 names is disabled except indent and outdent', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'cell'), 1), editor, {
      disabled: NO_INDENT,
    })
  })

  it('footnotes block: every button enabled and not current, even inside its list item', () => {
    // highlightToolbarWYSIWYG.ts:65-72 returns before the list/quote/code rules, so the LI inside
    // the footnotes block neither marks `list` current nor disables indent/outdent.
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', caretIn(byId(editor, 'fnp'), 1), editor, {})
    expectGates('wysiwyg', caretIn(byId(editor, 'fnli'), 0), editor, {})
  })

  it('P@0 whose first child is STRONG resolves to the STRONG: bold is current', () => {
    const editor = mount('wysiwyg')
    const p = byId(editor, 'strong')
    expectGates('wysiwyg', rangeAt(p, 0), editor, {
      disabled: NO_INDENT,
      current: ['bold'],
    })
  })

  it('an element offset at the end clamps to the last child', () => {
    // `P`@(length) with STRONG as the only child: childNodes[min(1, 0)] is the STRONG. An unclamped
    // read of childNodes[1] would be undefined and leave bold off.
    const editor = mount('wysiwyg')
    const p = document.createElement('p')
    p.innerHTML = '<strong>solo</strong>'
    editor.append(p)
    expectGates('wysiwyg', rangeAt(p, p.childNodes.length), editor, {
      disabled: NO_INDENT,
      current: ['bold'],
    })
    // Offset in range resolves to that child: "Echo ", CODE, " golf" -> offset 1 is the CODE.
    expectGates('wysiwyg', rangeAt(byId(editor, 'code'), 1), editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
  })

  it('an empty element has no child to resolve, so nothing is current', () => {
    const editor = mount('wysiwyg')
    expectGates('wysiwyg', rangeAt(byId(editor, 'empty'), 0), editor, {
      disabled: NO_INDENT,
    })
  })

  it('the editor root resolves to its block child', () => {
    const editor = mount('wysiwyg')
    const index = Array.prototype.indexOf.call(
      editor.childNodes,
      byId(editor, 'bq'),
    )
    expectGates('wysiwyg', rangeAt(editor, index), editor, {
      disabled: NO_INDENT,
      current: ['quote'],
    })
  })

  it('a backward selection is gated on its range start', () => {
    const editor = mount('wysiwyg')
    const codeText = byId(editor, 'codetext').firstChild as Text
    const after = byId(editor, 'plain').firstChild as Text
    const selection = getSelection()
    selection?.setBaseAndExtent(
      byId(editor, 'strong').lastChild as Text,
      2,
      codeText,
      1,
    )
    const range = (selection as Selection).getRangeAt(0)
    expect(range.startContainer).toBe(codeText)
    expectGates('wysiwyg', range, editor, {
      disabled: [...CODE_DISABLED, ...NO_INDENT],
      current: ['inline-code'],
    })
    // plain start, code end: plain context (parity with Vditor's start-based read).
    const spanning = document.createRange()
    spanning.setStart(after, 2)
    spanning.setEnd(codeText, 2)
    expectGates('wysiwyg', spanning, editor, { disabled: NO_INDENT })
  })
})

// ---------------------------------------------------------------------------------------------
// SV and blocked cases
// ---------------------------------------------------------------------------------------------

describe('toolbarHotkeyGate in SV', () => {
  function svEditor(): HTMLElement {
    const editor = document.createElement('pre')
    editor.className = 'vditor-reset'
    editor.setAttribute('contenteditable', 'true')
    editor.innerHTML =
      '<div data-block="0" data-type="blockquote">&gt; quoted **text**</div>'
    document.body.append(editor)
    return editor
  }

  it('enables every name and clears current, except indent and outdent', () => {
    const editor = svEditor()
    const range = caretIn(editor.firstElementChild as HTMLElement, 4)
    expectGates('sv', range, editor, { disabled: NO_INDENT })
  })

  it('treats a both-pane layout (preview shown beside an editable SV) as editable', () => {
    // `preview.element.style.display === 'block'` also holds in the SV both layout, so the
    // helper must not read it: only the explicit fullPreview flag blocks.
    const editor = svEditor()
    const preview = document.createElement('div')
    preview.style.display = 'block'
    document.body.append(preview)
    const range = caretIn(editor.firstElementChild as HTMLElement, 2)
    expect(gate('sv', range, editor, 'bold', false)).toEqual({
      disabled: false,
      current: false,
    })
    expect(gate('sv', range, editor, 'bold', true)).toBe('blocked')
  })
})

describe('toolbarHotkeyGate blocked cases', () => {
  it.each<Mode>(['ir', 'wysiwyg'])('full Preview blocks in %s', (mode) => {
    const editor = mount(mode as 'ir' | 'wysiwyg')
    const range = caretIn(byId(editor, 'plain'))
    expect(gate(mode, range, editor, 'bold', true)).toBe('blocked')
  })

  it('blocks a read-only editor in every mode', () => {
    for (const mode of ['ir', 'wysiwyg'] as const) {
      const editor = mount(mode)
      editor.setAttribute('contenteditable', 'false')
      expect(gate(mode, caretIn(byId(editor, 'plain')), editor, 'bold')).toBe(
        'blocked',
      )
      document.body.replaceChildren()
    }
    const sv = document.createElement('pre')
    sv.setAttribute('contenteditable', 'false')
    sv.textContent = 'x'
    document.body.append(sv)
    expect(gate('sv', caretIn(sv), sv, 'bold')).toBe('blocked')
  })

  it('blocks when there is no editor or no range', () => {
    const editor = mount('ir')
    expect(gate('ir', caretIn(byId(editor, 'plain')), null, 'bold')).toBe(
      'blocked',
    )
    expect(gate('ir', null, editor, 'bold')).toBe('blocked')
  })

  it('blocks a stored range whose start is in a detached tree', () => {
    const editor = mount('ir')
    const orphan = document.createElement('p')
    orphan.textContent = 'orphan'
    const range = caretIn(orphan)
    expect(range.startContainer.isConnected).toBe(false)
    expect(gate('ir', range, editor, 'bold')).toBe('blocked')
  })

  it('blocks when the editor itself was disconnected', () => {
    const editor = mount('wysiwyg')
    const range = caretIn(byId(editor, 'plain'))
    editor.remove()
    expect(gate('wysiwyg', range, editor, 'bold')).toBe('blocked')
  })

  it('blocks a range whose start is in another element, not this editor', () => {
    const editor = mount('wysiwyg')
    const other = document.createElement('p')
    other.textContent = 'elsewhere'
    document.body.append(other)
    expect(gate('wysiwyg', caretIn(other), editor, 'bold')).toBe('blocked')
  })
})

// ---------------------------------------------------------------------------------------------
// resolveVditorEditorRange
// ---------------------------------------------------------------------------------------------

describe('resolveVditorEditorRange', () => {
  function innerFor(
    mode: 'ir' | 'wysiwyg' | 'sv',
    editor: HTMLElement,
    range?: Range,
  ): InnerVditor {
    return { currentMode: mode, [mode]: { element: editor, range } }
  }

  it('returns the live range when it starts inside the editor', () => {
    const editor = mount('ir')
    const live = caretIn(byId(editor, 'plain'))
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(live)
    const stored = caretIn(byId(editor, 'h'))
    const got = resolveVditorEditorRange(innerFor('ir', editor, stored), 'ir')
    expect(got?.startContainer).toBe(live.startContainer)
    expect(got?.startOffset).toBe(live.startOffset)
  })

  it('accepts a live range that starts on the editor element itself', () => {
    const editor = mount('wysiwyg')
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(rangeAt(editor, 1))
    const got = resolveVditorEditorRange(innerFor('wysiwyg', editor), 'wysiwyg')
    expect(got?.startContainer).toBe(editor)
    expect(got?.startOffset).toBe(1)
  })

  it('falls back to the stored range when the live selection is outside the editor', () => {
    const editor = mount('ir')
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    document.body.append(outside)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(caretIn(outside))
    const stored = caretIn(byId(editor, 'code'))
    expect(resolveVditorEditorRange(innerFor('ir', editor, stored), 'ir')).toBe(
      stored,
    )
  })

  it('falls back to the stored range when there is no selection at all', () => {
    const editor = mount('wysiwyg')
    getSelection()?.removeAllRanges()
    const stored = caretIn(byId(editor, 'strong'))
    expect(
      resolveVditorEditorRange(innerFor('wysiwyg', editor, stored), 'wysiwyg'),
    ).toBe(stored)
  })

  it('falls back to the editor start, without focusing anything, when nothing is stored', () => {
    const editor = mount('ir')
    const focus = vi.spyOn(editor, 'focus')
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    document.body.append(outside)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(caretIn(outside))
    const got = resolveVditorEditorRange(innerFor('ir', editor), 'ir')
    expect(got?.collapsed).toBe(true)
    expect(got?.startContainer).toBe(editor)
    expect(got?.startOffset).toBe(0)
    expect(focus).not.toHaveBeenCalled()
    // and the live selection was not moved.
    expect(getSelection()?.anchorNode).toBe(outside.firstChild)
  })

  it('resolves the SV editor too', () => {
    const editor = document.createElement('pre')
    editor.textContent = 'sv'
    document.body.append(editor)
    const got = resolveVditorEditorRange(innerFor('sv', editor), 'sv')
    expect(got?.startContainer).toBe(editor)
  })

  it('returns null without an editor element for the mode', () => {
    expect(resolveVditorEditorRange({ currentMode: 'ir' }, 'ir')).toBeNull()
    expect(
      resolveVditorEditorRange({ currentMode: 'ir', ir: {} }, 'ir'),
    ).toBeNull()
  })

  it('feeds the stale-class scenario: stored range decides when the selection left the editor', () => {
    // The Task 596 corruption row: the live selection moved, Vditor's button classes still
    // describe the old caret. With the stored range inside inline code the gate says so.
    const editor = mount('ir')
    getSelection()?.removeAllRanges()
    const stored = caretIn(
      byId(editor, 'code').querySelector('code') as HTMLElement,
    )
    const range = resolveVditorEditorRange(innerFor('ir', editor, stored), 'ir')
    expect(gate('ir', range, editor, 'bold')).toEqual({
      disabled: true,
      current: false,
    })
  })
})

// ---------------------------------------------------------------------------------------------
// syncToolbarButtonGate
// ---------------------------------------------------------------------------------------------

describe('syncToolbarButtonGate', () => {
  it('sets and clears only the two gate classes on that one button', () => {
    const button = document.createElement('button')
    button.className = 'vditor-menu vditor-tooltipped keep'
    const sibling = document.createElement('button')
    sibling.className = 'vditor-menu vditor-menu--disabled vditor-menu--current'

    syncToolbarButtonGate(button, { disabled: true, current: true })
    expect(button.className).toBe(
      'vditor-menu vditor-tooltipped keep vditor-menu--disabled vditor-menu--current',
    )
    syncToolbarButtonGate(button, { disabled: false, current: true })
    expect(button.classList.contains('vditor-menu--disabled')).toBe(false)
    expect(button.classList.contains('vditor-menu--current')).toBe(true)
    syncToolbarButtonGate(button, { disabled: false, current: false })
    expect(button.className).toBe('vditor-menu vditor-tooltipped keep')
    expect(sibling.className).toBe(
      'vditor-menu vditor-menu--disabled vditor-menu--current',
    )
  })

  it("leaves a button untouched for 'blocked'", () => {
    const button = document.createElement('button')
    button.className = 'vditor-menu vditor-menu--disabled'
    syncToolbarButtonGate(button, 'blocked')
    expect(button.className).toBe('vditor-menu vditor-menu--disabled')
  })
})

// ---------------------------------------------------------------------------------------------
// clickToolbarHotkeyButton (gate-and-click)
// ---------------------------------------------------------------------------------------------

describe('clickToolbarHotkeyButton', () => {
  type Harness = {
    editor: HTMLElement
    buttons: Record<string, HTMLElement>
    inner: InnerVditor
    seen: { name: string; disabled: boolean; current: boolean }[]
  }

  function install(
    mode: 'ir' | 'wysiwyg' | 'sv',
    html?: string,
    stale: Record<string, string> = {},
  ): Harness {
    const editor = mode === 'sv' ? document.createElement('pre') : mount(mode)
    if (mode === 'sv') {
      editor.className = 'vditor-reset'
      editor.setAttribute('contenteditable', 'true')
      editor.innerHTML = html ?? '<div data-block="0">plain</div>'
      document.body.append(editor)
    }
    const elements: Record<string, HTMLElement> = {}
    const buttons: Record<string, HTMLElement> = {}
    const seen: Harness['seen'] = []
    for (const name of [...NAMES, 'preview']) {
      const wrapper = document.createElement('div')
      const button = document.createElement('button')
      button.className = `vditor-menu ${stale[name] ?? ''}`.trim()
      button.addEventListener('click', () => {
        seen.push({
          name,
          disabled: button.classList.contains('vditor-menu--disabled'),
          current: button.classList.contains('vditor-menu--current'),
        })
      })
      wrapper.append(button)
      elements[name] = wrapper
      buttons[name] = button
    }
    const inner: InnerVditor = {
      currentMode: mode,
      [mode]: { element: editor },
      toolbar: { elements },
    }
    ;(window as unknown as { vditor: unknown }).vditor = { vditor: inner }
    return { editor, buttons, inner, seen }
  }

  const select = (range: Range) => {
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  }

  it('stale disabled Bold in plain text is enabled before its click runs', () => {
    const h = install('ir', undefined, { bold: 'vditor-menu--disabled' })
    select(caretIn(byId(h.editor, 'plain')))
    expect(clickToolbarHotkeyButton('bold')).toBe(true)
    expect(h.seen).toEqual([{ name: 'bold', disabled: false, current: false }])
  })

  it('stale enabled Bold inside inline code is disabled before its click runs', () => {
    const h = install('ir')
    select(caretIn(byId(h.editor, 'code').querySelector('code') as HTMLElement))
    expect(clickToolbarHotkeyButton('bold')).toBe(true)
    expect(h.seen).toEqual([{ name: 'bold', disabled: true, current: false }])
  })

  it('stale current inline-code over plain text is cleared before the click', () => {
    const h = install('wysiwyg', undefined, {
      'inline-code': 'vditor-menu--current',
    })
    select(caretIn(byId(h.editor, 'plain')))
    clickToolbarHotkeyButton('inline-code')
    expect(h.seen).toEqual([
      { name: 'inline-code', disabled: false, current: false },
    ])
  })

  it('stale non-current Bold inside strong text is made current before the click', () => {
    const h = install('ir')
    const text = byId(h.editor, 'strong').querySelector('strong') as HTMLElement
    select(caretIn(text))
    clickToolbarHotkeyButton('bold')
    expect(h.seen).toEqual([{ name: 'bold', disabled: false, current: true }])
  })

  it('gates on the stored range when the live selection is outside the editor', () => {
    const h = install('ir')
    const stored = caretIn(
      byId(h.editor, 'code').querySelector('code') as HTMLElement,
    )
    h.inner.ir = { element: h.editor, range: stored }
    getSelection()?.removeAllRanges()
    clickToolbarHotkeyButton('italic')
    expect(h.seen).toEqual([{ name: 'italic', disabled: true, current: false }])
  })

  it('touches only the named button', () => {
    const h = install('ir', undefined, { italic: 'vditor-menu--current' })
    select(caretIn(byId(h.editor, 'plain')))
    clickToolbarHotkeyButton('bold')
    expect(h.buttons.italic.className).toBe('vditor-menu vditor-menu--current')
    expect(h.buttons.strike.className).toBe('vditor-menu')
  })

  it('SV: enabled and not current, but indent is disabled', () => {
    const h = install('sv', undefined, {
      bold: 'vditor-menu--disabled',
      indent: 'vditor-menu--current',
    })
    select(caretIn(h.editor.firstElementChild as HTMLElement))
    clickToolbarHotkeyButton('bold')
    clickToolbarHotkeyButton('indent')
    expect(h.seen).toEqual([
      { name: 'bold', disabled: false, current: false },
      { name: 'indent', disabled: true, current: false },
    ])
  })

  it('SV both-pane layout (preview visible, Preview button not current) still clicks', () => {
    const h = install('sv')
    h.inner.preview = { element: document.createElement('div') }
    ;(h.inner.preview.element as HTMLElement).style.display = 'block'
    select(caretIn(h.editor.firstElementChild as HTMLElement))
    expect(clickToolbarHotkeyButton('bold')).toBe(true)
    expect(h.seen).toHaveLength(1)
  })

  it('full Preview (Preview button current) never clicks, in any mode', () => {
    for (const mode of ['ir', 'wysiwyg'] as const) {
      const h = install(mode, undefined, { preview: 'vditor-menu--current' })
      select(caretIn(byId(h.editor, 'plain')))
      expect(clickToolbarHotkeyButton('bold')).toBe(false)
      expect(h.seen).toEqual([])
      document.body.replaceChildren()
    }
  })

  it('a read-only editor, an unknown mode or a missing button never clicks', () => {
    const readOnly = install('ir')
    select(caretIn(byId(readOnly.editor, 'plain')))
    readOnly.editor.setAttribute('contenteditable', 'false')
    expect(clickToolbarHotkeyButton('bold')).toBe(false)
    expect(readOnly.seen).toEqual([])

    const unknown = install('ir')
    unknown.inner.currentMode = 'preview'
    expect(clickToolbarHotkeyButton('bold')).toBe(false)

    const missing = install('ir')
    delete missing.inner.toolbar?.elements?.bold
    expect(clickToolbarHotkeyButton('bold')).toBe(false)

    ;(window as unknown as { vditor: unknown }).vditor = undefined
    expect(clickToolbarHotkeyButton('bold')).toBe(false)
  })

  it('click is bubbling and cancelable, the same click the router already sends', () => {
    const h = install('ir')
    select(caretIn(byId(h.editor, 'plain')))
    let event: Event | undefined
    h.buttons.bold.addEventListener('click', (e) => {
      event = e
    })
    clickToolbarHotkeyButton('bold')
    expect(event?.bubbles).toBe(true)
    expect(event?.cancelable).toBe(true)
  })
})
