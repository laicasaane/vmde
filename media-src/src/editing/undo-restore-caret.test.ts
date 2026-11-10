// @vitest-environment jsdom
//
// Task 597 — the Undo/Redo restore fallback for snapshots without a usable caret marker. Each case
// mirrors the patched `Undo.renderDiff` order: capture against the pre-Undo DOM and selection,
// replace the editor HTML with the restored snapshot, admit markers, then restore. jsdom has no
// layout, so caret rects and the scroller's geometry are stubbed where a case needs them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCompositionState } from '../util/caret-gesture'
import {
  hasLiveCaretIntent,
  installCaretInvalidation,
  installCaretWindowBridge,
  resetCaretAuthorityForTests,
  resolveCaretIntent,
} from './caret'
import {
  installUndoRestoreCaret,
  resetUndoRestoreCaretForTests,
  type UndoRestoreCapture,
} from './undo-restore-caret'

type Intent = Parameters<typeof resolveCaretIntent>[0]

const BLOCK =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, [data-block]'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let caretRect: {
  top: number
  bottom: number
  left: number
  right: number
  height: number
}
let request: ReturnType<typeof vi.fn>

function fireFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(0)
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<input id="outside"><pre class="vditor-reset" contenteditable="true">${html}</pre>`
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  ;(window as unknown as Record<string, unknown>).vditor = {
    vditor: { currentMode: 'ir', ir: { element: root } },
  }
  return root
}

function bridge() {
  const installed = window.__vmdeUndoRestoreCaret
  if (!installed) throw new Error('bridge not installed')
  return installed
}

// The patched renderDiff sequence: capture, rebuild, admit markers, then restore.
function undoRestore(
  previous: string,
  restored: string,
  options: { isRedo?: boolean; select?: (root: HTMLElement) => void } = {},
) {
  const root = mount(previous)
  options.select?.(root)
  const capture = bridge().capture(root, previous, restored, !!options.isRedo)
  root.innerHTML = restored
  const usable = bridge().usableMarker(root)
  const handled = usable ? undefined : bridge().restore(capture)
  return { root, capture, usable, handled }
}

const requested = (): Intent => request.mock.calls.at(-1)?.[0] as Intent

// The requested caret drawn into its block's text, e.g. `P:Alpha |bravo`.
function landing(root: HTMLElement): string {
  const target = resolveCaretIntent(requested(), root)
  if (!target) return 'unresolved'
  const host =
    target.node.nodeType === Node.TEXT_NODE
      ? target.node.parentElement
      : (target.node as Element)
  const block = host?.closest(BLOCK) as Element
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(target.node, target.offset)
  const before = range.toString()
  return `${block.tagName}:${before}|${(block.textContent ?? '').slice(before.length)}`
}

function selectText(root: HTMLElement, needle: string, offset = 0): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node as Text).data.indexOf(needle)
    if (index >= 0) {
      getSelection()?.collapse(node, index + offset)
      return node as Text
    }
  }
  throw new Error(`no text ${needle}`)
}

const p = (text: string) => `<p data-block="0">${text}</p>`

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  caretRect = { top: 0, bottom: 0, left: 0, right: 0, height: 0 }
  ;(
    Range.prototype as unknown as Record<string, unknown>
  ).getBoundingClientRect = () => caretRect
  ;(Range.prototype as unknown as Record<string, unknown>).getClientRects =
    () => []
  request = vi.fn(() => true)
  window.__vmdeRequestCaret =
    request as unknown as typeof window.__vmdeRequestCaret
  installUndoRestoreCaret()
})

afterEach(() => {
  resetUndoRestoreCaretForTests()
  resetCaretAuthorityForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (Range.prototype as unknown as Record<string, unknown>)
    .getBoundingClientRect
  delete (Range.prototype as unknown as Record<string, unknown>).getClientRects
  delete window.__vmdeRequestCaret
  delete window.__vmdeUndoRestoreCaret
  getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

describe('change site', () => {
  const probe = (word: string) =>
    `<h1 data-block="0">Probe</h1>${p(`Alpha ${word} charlie`)}${p('Delta')}`

  it('Undo of the probe replacement lands at the change start, top-level [1] offset 6', () => {
    const { root, handled } = undoRestore(probe('BRAVO'), probe('bravo'))
    expect(handled).toBe(true)
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 6 })
    expect(landing(root)).toBe('P:Alpha |bravo charlie')
  })

  it('Redo of the probe replacement lands at the change end', () => {
    const { root } = undoRestore(probe('bravo'), probe('BRAVO'), {
      isRedo: true,
    })
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 11 })
    expect(landing(root)).toBe('P:Alpha BRAVO| charlie')
  })

  it.each([
    ['restored insertion', 'ab', 'aXYb', 'P:a|XYb', 'P:aXY|b'],
    ['restored deletion', 'aXYb', 'ab', 'P:a|b', 'P:a|b'],
    ['longer replacement', 'a12b', 'aXYZb', 'P:a|XYZb', 'P:aXYZ|b'],
    ['shorter replacement', 'aXYZb', 'a1b', 'P:a|1b', 'P:a1|b'],
    ['repeated characters', 'aaa', 'aaaa', 'P:aaa|a', 'P:aaaa|'],
  ])(
    '%s: Undo at the start, Redo at the end',
    (_name, before, after, undo, redo) => {
      expect(landing(undoRestore(p(before), p(after)).root)).toBe(undo)
      expect(
        landing(undoRestore(p(before), p(after), { isRedo: true }).root),
      ).toBe(redo)
    },
  )

  it.each([
    [
      'attribute-only',
      '<p data-block="0" id="a" data-vmde-foldable="1">same</p>',
      '<p data-block="0" id="b">same</p>',
    ],
    [
      'preview-only',
      '<div data-block="0">src<pre class="vditor-ir__preview" data-render="1">old</pre></div>',
      '<div data-block="0">src<pre class="vditor-ir__preview" data-render="1">new</pre></div>',
    ],
    ['caret-only', p('sa<wbr>me'), p('same')],
  ])(
    '%s differences have no change site; the pre-Undo caret is used',
    (_name, before, after) => {
      const { capture } = undoRestore(before, after, {
        select: (el) =>
          getSelection()?.collapse(
            el.querySelector('[data-block]')?.firstChild as Node,
            1,
          ),
      })
      expect(capture.focus).toEqual({ blockPath: [0], offsetInBlock: 1 })
      expect(requested()).toEqual(capture.focus)
      expect(frames.size).toBe(0)
    },
  )

  it('a restored (inserted) block takes the caret at its start for Undo and its end for Redo', () => {
    const before = p('one') + p('three')
    const after = p('one') + p('two') + p('three')
    undoRestore(before, after)
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 0 })
    expect(landing(undoRestore(before, after, { isRedo: true }).root)).toBe(
      'P:two|',
    )
  })

  it('a removed block lands at the following block start, or the preceding end at the tail', () => {
    expect(
      landing(
        undoRestore(p('one') + p('two') + p('three'), p('one') + p('three'))
          .root,
      ),
    ).toBe('P:|three')
    expect(landing(undoRestore(p('one') + p('two'), p('one')).root)).toBe(
      'P:one|',
    )
  })

  it('an empty restored block is a distinct target', () => {
    const { root } = undoRestore(
      p('one') + p('three'),
      `${p('one')}<p data-block="0"></p>${p('three')}`,
    )
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 0 })
    expect(resolveCaretIntent(requested(), root)?.node).toBe(root.children[1])
  })

  it('a block tag replacement lands at the block source start (Undo) or end (Redo)', () => {
    const before = '<h2 data-block="0">Title</h2>'
    const after = p('Title')
    expect(landing(undoRestore(before, after).root)).toBe('P:|Title')
    expect(landing(undoRestore(before, after, { isRedo: true }).root)).toBe(
      'P:Title|',
    )
  })

  it('multiple changed blocks: Undo at the first changed block, Redo at the end of the last', () => {
    const before = p('a') + p('b1') + p('c1') + p('d')
    const after = p('a') + p('bX') + p('cY') + p('d')
    expect(landing(undoRestore(before, after).root)).toBe('P:b|X')
    expect(landing(undoRestore(before, after, { isRedo: true }).root)).toBe(
      'P:cY|',
    )
  })

  it('an SV single source block skips the hidden newline at a line start', () => {
    const sv = (line: string) =>
      `<div data-block="0"><span>alpha</span><span data-type="newline"><br><span style="display:none">\n</span></span><span>${line}</span></div>`
    const { root } = undoRestore(sv('Xbravo'), sv('bravo'))
    const intent = requested() as { node: Node; offset: number }
    expect(intent.node.textContent).toBe('bravo')
    expect(intent.offset).toBe(0)
    expect(root.contains(intent.node)).toBe(true)
  })

  // Task 597 S4, measured in real VS Code SV: the pre-Replace snapshot carried VMDE's empty EOF
  // trailing paragraph and the post-Replace one did not, which paired the changed SV block with that
  // paragraph and put the Redo caret at the end of the document.
  it.each([
    ['trailing', 'data-vmde-trailing'],
    ['gap', 'data-vmde-gap'],
  ])(
    'an empty %s paragraph in one snapshot only is not part of the change',
    (_name, attr) => {
      const helper = `<p data-block="0" ${attr}="">​</p>`
      const before = `${p('a ldbsra b')}${helper}`
      const after = p('a ZZZZ b')
      expect(landing(undoRestore(before, after, { isRedo: true }).root)).toBe(
        'P:a ZZZZ| b',
      )
      expect(landing(undoRestore(after + helper, p('a ldbsra b')).root)).toBe(
        'P:a |ldbsra b',
      )
    },
  )

  it('a restored block without text takes the caret in its innermost leading block', () => {
    undoRestore(p('a'), `${p('a')}<ul data-block="0"><li></li></ul>`)
    expect(requested()).toEqual({ blockPath: [1, 0], offsetInBlock: 0 })
  })

  it('a trailing paragraph that holds text is ordinary content', () => {
    const typed = '<p data-block="0" data-vmde-trailing="">new</p>'
    expect(
      landing(undoRestore(p('one'), p('one') + typed, { isRedo: true }).root),
    ).toBe('P:new|')
  })

  it('nested list item, table cell and code source endpoints name their own block', () => {
    const list = (second: string) =>
      `<ul data-block="0"><li><p>one</p></li><li><p>${second}</p></li></ul>`
    const li = undoRestore(list('Xtwo'), list('two'))
    expect(requested()).toEqual({ blockPath: [0, 1, 0], offsetInBlock: 0 })
    expect(landing(li.root)).toBe('P:|two')

    const table = (cell: string) =>
      `<table data-block="0"><thead><tr><th>h</th></tr></thead><tbody><tr><td>${cell}</td></tr></tbody></table>`
    const td = undoRestore(table('a1'), table('a2'), { isRedo: true })
    expect(requested()).toEqual({ blockPath: [0, 1, 0, 0], offsetInBlock: 2 })
    expect(landing(td.root)).toBe('TD:a2|')

    const code = (value: string) =>
      `<div data-block="0" data-type="code-block" class="vditor-ir__node"><span data-type="code-block-open-marker">\`\`\`</span><pre class="vditor-ir__marker--pre vditor-ir__marker"><code>let kilo = ${value}\n</code></pre><pre class="vditor-ir__preview" data-render="1"><code>let kilo = ${value}\n</code></pre><span data-type="code-block-close-marker">\`\`\`</span></div>`
    const pre = undoRestore(code('2'), code('1'))
    expect(requested()).toEqual({ blockPath: [0, 1], offsetInBlock: 11 })
    expect(landing(pre.root)).toBe('PRE:let kilo = |1\n')
  })

  it('maps through preview text that precedes the target in the same block', () => {
    const math = (tail: string) =>
      p(
        `a <span class="vditor-ir__node" data-type="math-inline"><span class="vditor-ir__marker">$</span><code class="vditor-ir__marker--pre">x</code><span class="vditor-ir__marker">$</span><span class="vditor-ir__preview" data-render="2">RENDERED</span></span>${tail}`,
      )
    // Mid-text: the raw block offset counts the preview, and resolves back to the same spot.
    const inside = undoRestore(math(' tXail'), math(' tail'))
    expect(requested()).toEqual({ blockPath: [0], offsetInBlock: 15 })
    expect(resolveCaretIntent(requested(), inside.root)?.node.textContent).toBe(
      ' tail',
    )
    // Right after the preview: the raw offset would resolve into the preview, so the exact
    // node position is requested instead.
    const boundary = undoRestore(math('Z tail'), math(' tail'))
    const intent = requested() as { node: Node; offset: number }
    expect(intent.node.textContent).toBe(' tail')
    expect(intent.offset).toBe(0)
    expect(boundary.root.contains(intent.node)).toBe(true)
  })

  it('falls back when the live DOM no longer has the projected block', () => {
    // The snapshot strings name a third block the live root does not have.
    const root = mount(p('one'))
    selectText(root, 'one', 1)
    const capture = bridge().capture(
      root,
      p('one') + p('x') + p('tXwo'),
      p('one') + p('x') + p('two'),
      false,
    )
    expect(bridge().restore(capture)).toBe(true)
    expect(requested()).toEqual({ blockPath: [0], offsetInBlock: 1 })
    // A tag mismatch at the projected slot falls back the same way.
    selectText(root, 'one', 1)
    const swapped = bridge().capture(
      root,
      p('tXwo'),
      '<h2 data-block="0">two</h2>',
      false,
    )
    bridge().restore(swapped)
    expect(requested()).toEqual({ blockPath: [0], offsetInBlock: 1 })
  })

  it('moves an end that falls in hidden text to the nearest visible text', () => {
    const hidden = (text: string) => `<span style="display:none">${text}</span>`
    expect(
      landing(
        undoRestore(p('ab'), p(`ab${hidden('X')}`), { isRedo: true }).root,
      ),
    ).toBe('P:ab|X')
    // Only hidden text: the exact hidden position is still inside the block.
    const { root } = undoRestore(p(''), p(hidden('X')), { isRedo: true })
    expect(root.contains((requested() as { node: Node }).node)).toBe(true)
  })

  it('never splits a surrogate pair', () => {
    expect(landing(undoRestore(p('a😀b'), p('a😃b')).root)).toBe('P:a|😃b')
    expect(
      landing(undoRestore(p('a😀b'), p('a😃b'), { isRedo: true }).root),
    ).toBe('P:a😃|b')
  })

  it('maps the projected block index past excluded top-level siblings to the live child', () => {
    const preview =
      '<div class="vditor-ir__preview" data-render="1">rendered</div>'
    const { root } = undoRestore(
      `<wbr>${preview}${p('one')}${p('tXwo')}`,
      `${preview}${p('one')}${p('two')}`,
    )
    expect(requested()).toEqual({ blockPath: [2], offsetInBlock: 1 })
    expect(landing(root)).toBe('P:t|wo')
  })
})

describe('usableMarker', () => {
  const admit = (html: string) => {
    const root = mount(html)
    return { root, usable: bridge().usableMarker(root) }
  }

  it('keeps a marker inside a block', () => {
    const { root, usable } = admit(p('a<wbr>b'))
    expect(usable).toBe(true)
    expect(root.querySelector('wbr')?.parentElement?.tagName).toBe('P')
  })

  it('removes a root-level marker while blocks exist, keeps one in an empty document', () => {
    const blocks = admit(`<wbr>${p('a')}`)
    expect(blocks.usable).toBe(false)
    expect(blocks.root.querySelector('wbr')).toBeNull()
    const empty = admit('<wbr>')
    expect(empty.usable).toBe(true)
    expect(empty.root.querySelector('wbr')).not.toBeNull()
  })

  it('removes markers inside previews and non-editable subtrees', () => {
    for (const html of [
      p('a<span class="vditor-ir__preview" data-render="2">x<wbr>y</span>'),
      '<div class="vditor-wysiwyg__preview">x<wbr></div>',
      p('a<span data-render="1"><wbr></span>'),
      p('a<span contenteditable="false">x<wbr></span>'),
    ]) {
      const { root, usable } = admit(html)
      expect(usable).toBe(false)
      expect(root.querySelector('wbr')).toBeNull()
    }
  })

  it('an invalid first marker does not hide a later valid one; duplicates stay for upstream', () => {
    const { root, usable } = admit(
      p('<span class="vditor-ir__preview" data-render="2"><wbr></span>') +
        p('a<wbr>b<wbr>'),
    )
    expect(usable).toBe(true)
    expect(root.querySelectorAll('wbr')).toHaveLength(2)
    expect(root.querySelector('wbr')?.closest('.vditor-ir__preview')).toBeNull()
  })

  it('a usable marker leaves the restore to upstream', () => {
    const { usable, handled } = undoRestore(p('ab'), p('a<wbr>Xb'))
    expect(usable).toBe(true)
    expect(handled).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
  })

  // Task 720, measured in real VS Code: WYSIWYG after a mode switch records its first snapshot with
  // the caret at the document start, inside the front matter; Undo restored that marker and the
  // front matter showed its YAML source.
  const frontMatter = (yaml: string) =>
    `<div class="vditor-wysiwyg__block" data-type="yaml-front-matter" data-block="0"><pre><code>${yaml}</code></pre></div>`

  it('drops a front-matter marker when the change is elsewhere and places the caret at the change', () => {
    const { root, usable, handled } = undoRestore(
      frontMatter('title: a') + p('aXb'),
      frontMatter('title: a<wbr>') + p('ab'),
    )
    expect(usable).toBe(false)
    expect(root.querySelector('wbr')).toBeNull()
    expect(handled).toBe(true)
    expect(landing(root)).toBe('P:a|b')
  })

  it('keeps a front-matter marker when the restore changed the front matter', () => {
    const { root, usable, handled } = undoRestore(
      frontMatter('title: aX') + p('ab'),
      frontMatter('title: a<wbr>') + p('ab'),
    )
    expect(usable).toBe(true)
    expect(root.querySelector('wbr')?.closest('pre')).not.toBeNull()
    expect(handled).toBeUndefined()
  })

  it('keeps a front-matter marker without a capture or for an unchanged projection', () => {
    const plain = mount(frontMatter('title: a<wbr>') + p('ab'))
    expect(bridge().usableMarker(plain)).toBe(true)
    const same = undoRestore(
      frontMatter('title: a') + p('ab'),
      frontMatter('title: a<wbr>') + p('ab'),
    )
    expect(same.usable).toBe(true)
  })
})

// Task 720, measured in real VS Code on the 112 KB fixture: the rebuilt blocks above the view lost
// their remembered size and the edit line moved up 97.5 px.
describe('block sizes across a content-visibility restore', () => {
  function contentVisibility(value: string) {
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      const style = real(el, pseudo)
      return new Proxy(style, {
        get(target, key) {
          if (key === 'contentVisibility') return value
          const got = Reflect.get(target, key)
          return typeof got === 'function' ? got.bind(target) : got
        },
      })
    })
  }
  // Each block's height is 10 px per character of its text.
  function heights() {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        return { height: (this.textContent ?? '').length * 10 } as DOMRect
      },
    )
  }
  const sizes = (root: HTMLElement) =>
    Array.from(root.children, (child) =>
      (child as HTMLElement).style.getPropertyValue('contain-intrinsic-size'),
    )

  it('gives every unchanged rebuilt block its previous height as its placeholder', () => {
    contentVisibility('auto')
    heights()
    const { root } = undoRestore(
      p('aa') + p('bXb') + p('c') + p('dddd'),
      p('aa') + p('bb') + p('c') + p('dddd'),
    )
    expect(sizes(root)).toEqual(['auto 20px', '', 'auto 10px', 'auto 40px'])
  })

  it('matches the blocks after an inserted or removed block from the end', () => {
    contentVisibility('auto')
    heights()
    const { root } = undoRestore(
      p('aa') + p('new') + p('c') + p('dddd'),
      p('aa') + p('c') + p('dddd'),
    )
    expect(sizes(root)).toEqual(['auto 20px', 'auto 10px', 'auto 40px'])
  })

  it('leaves a block the block-scoped restore kept without a placeholder', () => {
    // Task 720 with undo-block-restore.ts: a kept block is the same node and keeps its own
    // remembered size; only the replaced block gets a placeholder.
    contentVisibility('auto')
    heights()
    const root = mount(p('aa') + p('bXb') + p('c'))
    const capture = bridge().capture(
      root,
      p('aa') + p('bXb') + p('c'),
      p('aa') + p('bb') + p('c'),
      false,
    )
    const [first, edited, last] = Array.from(root.children)
    const fresh = document.createElement('p')
    fresh.textContent = 'bXb'
    edited.replaceWith(fresh)
    bridge().usableMarker(root)
    bridge().restore(capture)
    expect(root.firstElementChild).toBe(first)
    expect(root.lastElementChild).toBe(last)
    expect(sizes(root)).toEqual(['', 'auto 30px', ''])
  })

  it('writes nothing outside a content-visibility document', () => {
    contentVisibility('visible')
    heights()
    const { root } = undoRestore(p('aa') + p('bXb'), p('aa') + p('bb'))
    expect(sizes(root)).toEqual(['', ''])
  })

  it('drops the placeholder once the block renders', () => {
    contentVisibility('auto')
    heights()
    const { root } = undoRestore(p('aa') + p('bXb'), p('aa') + p('bb'))
    const first = root.firstElementChild as HTMLElement
    const skipped = (value: boolean) =>
      Object.assign(
        new Event('contentvisibilityautostatechange', { bubbles: false }),
        { skipped: value },
      )
    first.dispatchEvent(skipped(true))
    expect(sizes(root)[0]).toBe('auto 20px')
    first.dispatchEvent(skipped(false))
    expect(sizes(root)[0]).toBe('')
  })
})

describe('capture', () => {
  const capture = (html: string, select: (root: HTMLElement) => void) => {
    const root = mount(html)
    select(root)
    return bridge().capture(root, 'old', 'new', false)
  }

  it('keeps root identity, both snapshots and direction', () => {
    const root = mount(p('a'))
    const result = bridge().capture(root, '<p>x</p>', '<p>y</p>', true)
    expect(result).toEqual({
      root,
      previousHtml: '<p>x</p>',
      restoredHtml: '<p>y</p>',
      isRedo: true,
      focus: null,
    })
  })

  it('rejects focus outside the editor, on the root, and under a preview or non-editable', () => {
    expect(
      capture(p('a'), () =>
        getSelection()?.collapse(document.getElementById('outside'), 0),
      ).focus,
    ).toBeNull()
    expect(
      capture(p('a'), (root) => getSelection()?.collapse(root, 1)).focus,
    ).toBeNull()
    expect(
      capture(
        p('a<span class="vditor-ir__preview" data-render="2">pv</span>'),
        (root) => selectText(root, 'pv'),
      ).focus,
    ).toBeNull()
    expect(
      capture(p('a<span contenteditable="false">ne</span>'), (root) =>
        selectText(root, 'ne'),
      ).focus,
    ).toBeNull()
  })

  it('bookmarks a nested list item endpoint by its own block path', () => {
    const focus = capture(
      `<ul data-block="0"><li><p>one</p></li><li><p><em>tw</em>o</p></li></ul>`,
      (root) => selectText(root, 'one', 2),
    ).focus
    expect(focus).toEqual({ blockPath: [0, 0, 0], offsetInBlock: 2 })
    const inner = capture(
      `<ul data-block="0"><li><p>one</p></li><li><p><em>tw</em>o</p></li></ul>`,
      (root) => selectText(root, 'tw', 1),
    ).focus
    expect(inner).toEqual({ blockPath: [0, 1, 0], offsetInBlock: 1 })
  })

  it('uses the focus endpoint of a backward selection', () => {
    const focus = capture(p('alpha') + p('bravo'), (root) => {
      const [first, second] = [
        root.children[0].firstChild,
        root.children[1].firstChild,
      ]
      getSelection()?.setBaseAndExtent(second as Node, 3, first as Node, 1)
    }).focus
    expect(focus).toEqual({ blockPath: [0], offsetInBlock: 1 })
  })

  it('does no parse, serialization, DOM write or selection change', () => {
    const root = mount(p('alpha') + p('bravo'))
    const text = selectText(root, 'bravo', 2)
    const created = vi.spyOn(document, 'createElement')
    const serialized = vi.spyOn(Element.prototype, 'innerHTML', 'get')
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    bridge().capture(
      root,
      p('alpha') + p('bXravo'),
      p('alpha') + p('bravo'),
      false,
    )
    expect(created).not.toHaveBeenCalled()
    expect(serialized).not.toHaveBeenCalled()
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(getSelection()?.focusNode).toBe(text)
    expect(getSelection()?.focusOffset).toBe(2)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('restore order and guards', () => {
  it('prefers the change site over the pre-Undo caret', () => {
    const { capture } = undoRestore(p('one') + p('tXwo'), p('one') + p('two'), {
      select: (root) => selectText(root, 'one', 1),
    })
    expect(capture.focus).toEqual({ blockPath: [0], offsetInBlock: 1 })
    expect(request).toHaveBeenCalledTimes(1)
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 1 })
  })

  it('falls back to the pre-Undo caret, then the literal first block start', () => {
    undoRestore(p('one') + p('two'), p('one') + p('two'), {
      select: (root) => selectText(root, 'two', 2),
    })
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 2 })
    undoRestore(p('one') + p('two'), p('one') + p('two'))
    expect(requested()).toEqual({ blockPath: [0], offsetInBlock: 0 })
  })

  // Task 720: a caret in the front matter shows its YAML source.
  it('the document-start fallback skips the front matter', () => {
    const fm =
      '<div class="vditor-ir__node" data-type="yaml-front-matter" data-block="0"><pre><code>t: a</code></pre></div>'
    const { root } = undoRestore(fm + p('one'), fm + p('one'))
    expect(requested()).toEqual({ blockPath: [1], offsetInBlock: 0 })
    expect(landing(root)).toBe('P:|one')
  })

  it('skips a pre-Undo caret that now resolves into a preview, and a hidden first marker', () => {
    const heading =
      '<h1 data-block="0"><span style="display:none"># </span>Probe</h1>'
    // Equal snapshots, so no change site. The bookmark after the preview counts the preview's
    // text, so it now resolves into the preview and is rejected.
    const html =
      heading +
      p('<span class="vditor-ir__preview" data-render="2">pv</span>zz')
    const { root, capture } = undoRestore(html, html, {
      select: (el) => selectText(el, 'zz'),
    })
    expect(capture.focus).toEqual({ blockPath: [1], offsetInBlock: 2 })
    const intent = requested() as { node: Node; offset: number }
    expect(intent.node.textContent).toBe('Probe')
    expect(intent.offset).toBe(0)
    expect(root.contains(intent.node)).toBe(true)
  })

  it('submits the deferred document-start intent for a blockless root', () => {
    undoRestore(p('x'), '')
    expect(requested()).toBe('document-start')
  })

  it('always requests one collapsed caret and focuses the editor first', () => {
    const focused: Element[] = []
    request.mockImplementation(() => {
      focused.push(document.activeElement as Element)
      return true
    })
    const { root } = undoRestore(p('ab'), p('aXb'), {
      select: (el) => {
        const text = el.querySelector('p')?.firstChild as Node
        getSelection()?.setBaseAndExtent(text, 0, text, 2)
      },
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(requested()).not.toHaveProperty('anchor')
    expect(focused).toEqual([root])
  })

  it('restores with no selection range at all', () => {
    const { handled } = undoRestore(p('ab'), p('aXb'), {
      select: () => getSelection()?.removeAllRanges(),
    })
    expect(handled).toBe(true)
    expect(requested()).toEqual({ blockPath: [0], offsetInBlock: 1 })
  })

  it('reports handled while the authority defers an unplaceable caret', () => {
    request.mockReturnValue(false)
    expect(undoRestore(p('ab'), p('aXb')).handled).toBe(true)
  })

  it('without the caret bridge it leaves the upstream collapse in charge', () => {
    delete window.__vmdeRequestCaret
    const { handled, root } = undoRestore(p('ab'), p('aXb'), {
      select: () => document.getElementById('outside')?.focus(),
    })
    expect(handled).toBe(false)
    expect(document.activeElement).not.toBe(root)
  })

  it('a stale root or an active composition is handled without focusing or arming', () => {
    const stale = mount(p('ab'))
    const capture = bridge().capture(stale, p('ab'), p('aXb'), false)
    mount(p('other'))
    expect(bridge().restore(capture)).toBe(true)
    expect(request).not.toHaveBeenCalled()

    const detached: UndoRestoreCapture = {
      ...capture,
      root: document.createElement('pre'),
    }
    expect(bridge().restore(detached)).toBe(true)
    expect(request).not.toHaveBeenCalled()

    const uninstall = installCompositionState()
    const root = mount(p('ab'))
    document.dispatchEvent(new Event('compositionstart'))
    const composing = bridge().capture(root, p('ab'), p('aXb'), false)
    root.innerHTML = p('aXb')
    expect(bridge().restore(composing)).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(root)
    uninstall()
  })

  it('adds no write, history step or serialization beyond the caret request', () => {
    const getValue = vi.fn()
    const addToUndoStack = vi.fn()
    const root = mount(p('ab'))
    ;(window as unknown as Record<string, unknown>).vditor = {
      getValue,
      vditor: {
        currentMode: 'ir',
        ir: { element: root },
        undo: { addToUndoStack },
      },
    }
    const capture = bridge().capture(root, p('ab'), p('aXb'), false)
    root.innerHTML = p('aXb')
    const before = root.innerHTML
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    expect(bridge().restore(capture)).toBe(true)
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(root.innerHTML).toBe(before)
    expect(getValue).not.toHaveBeenCalled()
    expect(addToUndoStack).not.toHaveBeenCalled()
  })

  it('installing twice keeps one bridge', () => {
    const first = window.__vmdeUndoRestoreCaret
    installUndoRestoreCaret()
    expect(window.__vmdeUndoRestoreCaret).toBe(first)
  })
})

describe('reveal', () => {
  let scrollTop: number

  // A 100 px tall scrolling editor; the caret rect is set per case.
  function scrollingEditor(root: HTMLElement): void {
    root.style.overflowY = 'auto'
    Object.defineProperty(root, 'clientHeight', {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(root, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(root, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
      configurable: true,
    })
    root.getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 300,
        height: 100,
        width: 300,
      }) as DOMRect
  }

  function restoreWithAuthority(
    before: string,
    after: string,
    rect: typeof caretRect,
    options: { isRedo?: boolean; select?: (root: HTMLElement) => void } = {},
  ) {
    installCaretWindowBridge()
    const root = mount(before)
    scrollingEditor(root)
    options.select?.(root)
    const capture = bridge().capture(root, before, after, !!options.isRedo)
    root.innerHTML = after
    caretRect = rect
    expect(bridge().usableMarker(root)).toBe(false)
    expect(bridge().restore(capture)).toBe(true)
    return root
  }

  beforeEach(() => {
    scrollTop = 500
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // One rendering update: animation frames, then the task the reveal schedules after them.
  function nextRendering(): void {
    fireFrames()
    vi.runOnlyPendingTimers()
  }

  const visibleRect = { top: 40, bottom: 60, left: 10, right: 11, height: 20 }
  const belowRect = { top: 400, bottom: 420, left: 10, right: 11, height: 20 }
  const aboveRect = { top: -50, bottom: -30, left: 10, right: 11, height: 20 }

  it('keeps the scroll position when the change site is visible', () => {
    restoreWithAuthority(p('aXb'), p('ab'), visibleRect)
    expect(scrollTop).toBe(500)
  })

  it('scrolls just enough to reveal a change site below or above the view', () => {
    restoreWithAuthority(p('aXb'), p('ab'), belowRect)
    expect(scrollTop).toBe(500 + 420 - (100 - 12))
    scrollTop = 500
    restoreWithAuthority(p('aXb'), p('ab'), aboveRect, { isRedo: true })
    expect(scrollTop).toBe(500 - (12 + 50))
  })

  // Task 720: the margin is breathing room for a reveal, not a reason to move a line already in view
  // (measured in real VS Code: a table-cell Undo moved the view 3 px).
  it('keeps the scroll position for a caret line fully in view inside the margin', () => {
    restoreWithAuthority(p('aXb'), p('ab'), {
      top: 75,
      bottom: 95,
      left: 10,
      right: 11,
      height: 20,
    })
    expect(scrollTop).toBe(500)
    restoreWithAuthority(p('aXb'), p('ab'), {
      top: 2,
      bottom: 22,
      left: 10,
      right: 11,
      height: 20,
    })
    expect(scrollTop).toBe(500)
    // A line cut by the edge is revealed with the margin.
    restoreWithAuthority(p('aXb'), p('ab'), {
      top: 90,
      bottom: 110,
      left: 10,
      right: 11,
      height: 20,
    })
    expect(scrollTop).toBe(500 + 110 - (100 - 12))
  })

  // Task 720 with the block-scoped restore: after the reveal scrolled, the change-site block renders
  // at its real height and moves the line; the correction keeps the margin, so the line does not
  // stay at the view edge (measured in real VS Code: "Undo after Find checkpoint" left it outside).
  it('keeps the margin on correction passes after the reveal scrolled', () => {
    restoreWithAuthority(p('aXb'), p('ab'), belowRect)
    expect(scrollTop).toBe(500 + 420 - (100 - 12))
    const afterFirst = scrollTop
    // The block above rendered taller: the line now sits inside the margin, not past the edge.
    caretRect = { top: 79, bottom: 99, left: 10, right: 11, height: 20 }
    nextRendering()
    expect(scrollTop).toBe(afterFirst + 99 - (100 - 12))
  })

  it('scrolls horizontally only when the caret is entirely outside the view', () => {
    let scrollLeft = 0
    const root = restoreWithAuthority(p('aXb'), p('ab'), visibleRect)
    Object.defineProperty(root, 'scrollLeft', {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      },
      configurable: true,
    })
    bridge().restore(bridge().capture(root, p('aXb'), p('ab'), false))
    expect(scrollLeft).toBe(0)
    caretRect = { ...visibleRect, left: 400, right: 401 }
    bridge().restore(bridge().capture(root, p('aXb'), p('ab'), false))
    expect(scrollLeft).toBe(401 - (300 - 12))
    caretRect = { ...visibleRect, left: -40, right: -39 }
    bridge().restore(bridge().capture(root, p('aXb'), p('ab'), false))
    expect(scrollLeft).toBe(113 - 52)
  })

  it('reveals inside the window when the document itself scrolls', () => {
    installCaretWindowBridge()
    const root = mount(p('aXb'))
    const page = document.scrollingElement ?? document.documentElement
    let pageTop = 0
    Object.defineProperty(page, 'scrollTop', {
      get: () => pageTop,
      set: (value: number) => {
        pageTop = value
      },
      configurable: true,
    })
    const capture = bridge().capture(root, p('aXb'), p('ab'), false)
    root.innerHTML = p('ab')
    caretRect = {
      top: window.innerHeight + 100,
      bottom: window.innerHeight + 120,
      left: 1,
      right: 2,
      height: 20,
    }
    expect(bridge().restore(capture)).toBe(true)
    expect(pageTop).toBe(120 + 12)
    delete (page as unknown as Record<string, unknown>).scrollTop
  })

  it('never scrolls for the pre-Undo caret or document-start fallbacks', () => {
    restoreWithAuthority(p('ab'), p('ab'), belowRect, {
      select: (root) => selectText(root, 'ab', 1),
    })
    expect(scrollTop).toBe(500)
    expect(frames.size).toBeGreaterThan(0) // the authority's own retry frame only
    nextRendering()
    expect(scrollTop).toBe(500)
  })

  it('reveals after the next rendering update when the caret is not paintable yet', () => {
    const root = restoreWithAuthority(p('aXb'), p('ab'), {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      height: 0,
    })
    expect(root.contains(getSelection()?.focusNode ?? null)).toBe(true)
    expect(scrollTop).toBe(500)
    caretRect = belowRect
    nextRendering()
    expect(scrollTop).toBe(500 + 420 - 88)
    caretRect = visibleRect
    nextRendering()
    nextRendering()
    expect(scrollTop).toBe(832) // shown: no further correction
  })

  // Task 597 S4, measured in real VS Code on the large fixture: a large document skips rendering
  // off-screen blocks (content-visibility), so the blocks a reveal scrolls past render at their
  // real height and push the change site out of view again.
  it('corrects a reveal that later layout moved, at most REVEAL_STEPS more times', () => {
    restoreWithAuthority(p('aXb'), p('ab'), belowRect)
    expect(scrollTop).toBe(500 + 332)
    caretRect = { ...belowRect, top: 300, bottom: 320 }
    nextRendering()
    expect(scrollTop).toBe(832 + 232)
    caretRect = visibleRect
    nextRendering()
    expect(scrollTop).toBe(1064)
    // A caret that never comes into view stops after the bound: 1 + 8 scrolls in all.
    scrollTop = 500
    restoreWithAuthority(p('aXb'), p('ab'), belowRect)
    for (let step = 0; step < 12; step++) nextRendering()
    expect(scrollTop).toBe(500 + 9 * 332)
  })

  it('waits without scrolling while the caret line is in view but its block is still skipped', () => {
    let laidOut = false
    ;(Element.prototype as unknown as Record<string, unknown>).checkVisibility =
      () => laidOut
    restoreWithAuthority(p('aXb'), p('ab'), visibleRect)
    expect(scrollTop).toBe(500)
    caretRect = belowRect
    nextRendering()
    expect(scrollTop).toBe(832)
    caretRect = visibleRect
    laidOut = true
    nextRendering()
    nextRendering()
    expect(scrollTop).toBe(832)
    delete (Element.prototype as unknown as Record<string, unknown>)
      .checkVisibility
  })

  it.each([
    [
      'a newer restore',
      (root: HTMLElement) => {
        bridge().restore(
          bridge().capture(root, root.innerHTML, root.innerHTML, false),
        )
      },
    ],
    [
      'a user gesture',
      () => {
        const uninstall = installCaretInvalidation()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
        expect(hasLiveCaretIntent()).toBe(false)
        return uninstall
      },
    ],
    [
      'a composition',
      () => {
        const uninstall = installCompositionState()
        document.dispatchEvent(new Event('compositionstart'))
        return uninstall
      },
    ],
    ['a root change', () => void mount(p('other'))],
  ] as const)('drops the deferred reveal after %s', (_name, interrupt) => {
    const notPaintable = { top: 0, bottom: 0, left: 0, right: 0, height: 0 }
    const root = restoreWithAuthority(p('aXb'), p('ab'), notPaintable)
    const cleanup = interrupt(root)
    caretRect = belowRect
    nextRendering()
    expect(scrollTop).toBe(500)
    cleanup?.()
  })
})
