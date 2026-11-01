// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findMarkdownMatches } from './find-engine'
import {
  collectPreviewText,
  createPreviewFindMapper,
  fullPreviewRoot,
} from './preview-find'

// Task 643 step 8 (RED): Find in full Preview searches the rendered document's text, not Markdown
// source. These tests cover the text collection, the mapping back to DOM ranges, and the surface
// detection that decides when the widget searches the Preview pane.
function pane(html: string): HTMLElement {
  document.body.innerHTML = `<div class="vditor-reset">${html}</div>`
  return document.body.firstElementChild as HTMLElement
}

const options = { caseSensitive: false, wholeWord: false }
const find = (root: HTMLElement, query: string) => {
  const snapshot = collectPreviewText(root)
  return {
    snapshot,
    matches: findMarkdownMatches(snapshot.text, query, options),
    mapper: createPreviewFindMapper(snapshot),
  }
}

afterEach(() => {
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('collectPreviewText', () => {
  it('joins inline elements into continuous text', () => {
    const root = pane('<p>hel<strong>lo</strong> <em>wor</em>ld</p>')
    expect(collectPreviewText(root).text).toContain('hello world')
  })

  it('separates blocks, so a single-line query never matches across a block boundary', () => {
    const root = pane(
      '<p>alpha</p><p>beta</p><ul><li>gamma</li><li>delta</li></ul>',
    )
    const { text } = collectPreviewText(root)
    expect(text).not.toContain('alphabeta')
    expect(text).not.toContain('alpha beta')
    expect(text).not.toContain('gammadelta')
    expect(find(root, 'alpha beta').matches).toEqual([])
    expect(find(root, 'beta').matches).toHaveLength(1)
  })

  it('treats a line break inside a block as a separator too', () => {
    const root = pane('<p>one<br>two</p>')
    expect(find(root, 'onetwo').matches).toEqual([])
    expect(find(root, 'one two').matches).toEqual([])
  })

  it('skips diagram SVG, KaTeX MathML, copy buttons, hidden and aria-hidden nodes', () => {
    const root = pane(
      [
        '<p>visible</p>',
        '<svg><text>svgtext</text></svg>',
        '<span class="katex"><span class="katex-mathml">mathmltext</span><span class="katex-html">katextext</span></span>',
        '<pre><code>codetext</code><span class="vditor-copy"><button>copybutton</button></span></pre>',
        '<p hidden>hiddentext</p>',
        '<p aria-hidden="true">ariahidden</p>',
      ].join(''),
    )
    const { text } = collectPreviewText(root)
    expect(text).toContain('visible')
    expect(text).toContain('katextext')
    expect(text).toContain('codetext')
    for (const skipped of [
      'svgtext',
      'mathmltext',
      'copybutton',
      'hiddentext',
      'ariahidden',
    ])
      expect(text).not.toContain(skipped)
  })

  it('skips a heavy block that has not been rendered yet', () => {
    const root = pane(
      '<p>shown</p><div class="language-mermaid" data-vmde-preview-pending="true">graph pendingsource</div>',
    )
    expect(collectPreviewText(root).text).not.toContain('pendingsource')
  })

  // Review R1 (finding 9): a held-back code block is plain visible text; only diagram or math source
  // (replaced by its render once released) is skipped.
  it('keeps the text of a pending code block, and skips a pending diagram or math block', () => {
    const root = pane(
      [
        '<pre data-vmde-preview-pending="true"><code class="language-ts">codevisible</code></pre>',
        '<div class="language-mermaid" data-vmde-preview-pending="true">graph mermaidsource</div>',
        '<div class="language-math" data-vmde-preview-pending="true">x^2 mathsource</div>',
        '<p data-vmde-preview-pending="true">before <span class="language-math">inlinemath</span> after</p>',
      ].join(''),
    )
    const { text } = collectPreviewText(root)
    expect(text).toContain('codevisible')
    expect(text).toContain('before')
    expect(text).not.toContain('mermaidsource')
    expect(text).not.toContain('mathsource')
    expect(text).not.toContain('inlinemath')
  })

  it('skips display:none content', () => {
    const root = pane('<p>shown</p><p style="display:none">invisible</p>')
    expect(collectPreviewText(root).text).not.toContain('invisible')
  })

  it('records where every text node starts in the collected text', () => {
    const root = pane('<p>ab<b>cd</b></p><p>ef</p>')
    const { text, nodes } = collectPreviewText(root)
    for (const { node, start, end } of nodes)
      expect(text.slice(start, end)).toBe(node.data)
  })
})

describe('createPreviewFindMapper', () => {
  it('maps a match inside one text node to a range with exactly that text', () => {
    const root = pane('<p>find the needle here</p>')
    const { matches, mapper } = find(root, 'needle')
    expect(matches).toHaveLength(1)
    expect(mapper.range(matches[0])?.toString()).toBe('needle')
  })

  it('maps a match across inline elements to one range', () => {
    const root = pane('<p>hel<strong>lo</strong> wor<em>ld</em></p>')
    const { matches, mapper } = find(root, 'llo wor')
    expect(matches).toHaveLength(1)
    const range = mapper.range(matches[0])
    expect(range?.toString()).toBe('llo wor')
    expect(range?.startContainer.textContent).toBe('hel')
  })

  it('maps every match of a repeated query, in document order', () => {
    const root = pane('<p>cat cat</p><p>cat</p>')
    const { matches, mapper } = find(root, 'cat')
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => mapper.range(m)?.toString())).toEqual([
      'cat',
      'cat',
      'cat',
    ])
  })

  it('reports visible matches by their on-screen position', () => {
    const root = pane('<p>cat one</p><p>cat two</p><p>cat three</p>')
    const { matches, mapper } = find(root, 'cat')
    const tops = new Map<string, number>([
      ['cat one', 0],
      ['cat two', 500],
      ['cat three', 5000],
    ])
    // jsdom has no layout and its Range has no rect method: supply one keyed by the paragraph.
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: Range) {
        const owner = this.startContainer.parentElement?.textContent ?? ''
        return new DOMRect(0, tops.get(owner) ?? 0, 50, 20)
      },
    })
    expect(mapper.visible(matches, { top: 0, bottom: 600 }, 0)).toEqual([0, 1])
    expect(mapper.visible(matches, { top: 0, bottom: 600 }, 5000)).toEqual([
      0, 1, 2,
    ])
  })

  it('returns null for a match whose text nodes are gone', () => {
    const root = pane('<p>cat</p>')
    const { matches, mapper } = find(root, 'cat')
    root.innerHTML = ''
    expect(mapper.range(matches[0])).toBeNull()
  })
})

describe('fullPreviewRoot', () => {
  function vditorWith(parts: {
    mode: 'ir' | 'wysiwyg' | 'sv'
    editHidden: boolean
    previewShown: boolean
  }) {
    const preview = document.createElement('div')
    preview.style.display = parts.previewShown ? 'block' : 'none'
    const previewElement = document.createElement('div')
    preview.append(previewElement)
    const edit = document.createElement('div')
    const wrapper = document.createElement('div')
    wrapper.append(edit)
    const display = parts.editHidden ? 'none' : 'block'
    if (parts.mode === 'sv') edit.style.display = display
    else wrapper.style.display = display
    return {
      previewElement,
      vditor: {
        vditor: {
          currentMode: parts.mode,
          [parts.mode]: { element: edit },
          preview: { element: preview, previewElement },
        },
      },
    }
  }

  it.each(['ir', 'wysiwyg', 'sv'] as const)(
    'is the preview pane when %s is hidden behind a shown Preview',
    (mode) => {
      const { vditor, previewElement } = vditorWith({
        mode,
        editHidden: true,
        previewShown: true,
      })
      expect(fullPreviewRoot(vditor)).toBe(previewElement)
    },
  )

  it('is null while the edit pane is shown (including Split, which shows both)', () => {
    for (const mode of ['ir', 'sv'] as const)
      expect(
        fullPreviewRoot(
          vditorWith({ mode, editHidden: false, previewShown: true }).vditor,
        ),
      ).toBeNull()
  })

  it('is null when Preview is hidden, or when there is no Vditor', () => {
    expect(
      fullPreviewRoot(
        vditorWith({ mode: 'ir', editHidden: true, previewShown: false })
          .vditor,
      ),
    ).toBeNull()
    expect(fullPreviewRoot(undefined)).toBeNull()
    expect(fullPreviewRoot({ vditor: { currentMode: 'sv' } })).toBeNull()
  })
})

beforeEach(() => {
  document.body.innerHTML = ''
})
