// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  cellUnit,
  countBudget,
  type Factor,
  fakeUnitFeed,
  irFixture,
} from '../testing/budget-harness'
import { provideUnitFeed, type UnitsChange } from '../util/unit-changes'
import {
  applyCommentPreviews,
  observeHtmlComments,
  revealPreviewComments,
} from './html-comment'

// In the full Preview pane Lute emits raw HTML, so an authored `<!-- … -->` arrives as a DOM Comment
// node with no wrapper; revealPreviewComments turns each into a visible element.

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  return root
}

describe('revealPreviewComments', () => {
  it('replaces an authored comment with a visible element', () => {
    const root = mount('<p>a</p><!-- note --><p>b</p>')
    revealPreviewComments(root)
    const el = root.querySelector('.vmde-comment')
    expect(el?.textContent).toBe('<!-- note -->')
    expect(el?.getAttribute('contenteditable')).toBe('false')
  })

  it('is idempotent (a second pass finds no Comment nodes left)', () => {
    const root = mount('<!-- note -->')
    revealPreviewComments(root)
    revealPreviewComments(root)
    expect(root.querySelectorAll('.vmde-comment')).toHaveLength(1)
  })

  it('labels an empty comment rather than rendering a blank box', () => {
    const root = mount('<!---->')
    revealPreviewComments(root)
    expect(root.querySelector('.vmde-comment')?.textContent).toBe(
      '<!-- (empty) -->',
    )
  })

  // Task 366 — graphviz carries the DOT source's own comments through into its rendered SVG (one
  // `<!-- A -->` per node). Rewriting those injected a <div> into an <svg> and made the Preview
  // pane's graphviz markup differ from the IR pane's, where this pass never runs.
  it('leaves comments INSIDE a rendered diagram alone', () => {
    const root = mount(
      '<div class="language-graphviz"><svg><!-- A --><g><!-- B --></g></svg></div>',
    )
    revealPreviewComments(root)
    expect(root.querySelectorAll('.vmde-comment')).toHaveLength(0)
    expect(root.querySelector('svg')?.innerHTML).toContain('<!-- A -->')
  })

  it('still reveals an authored comment that merely SITS NEXT TO a diagram', () => {
    const root = mount(
      '<div class="language-graphviz"><svg><!-- A --></svg></div><!-- mine -->',
    )
    revealPreviewComments(root)
    const found = Array.from(root.querySelectorAll('.vmde-comment')).map(
      (e) => e.textContent,
    )
    expect(found).toEqual(['<!-- mine -->'])
  })
})

// Task 367 — the preview render sanitises, and Lute's sanitiser drops HTML comments outright, so an
// authored comment was missing from the Preview pane entirely while IR showed it. Rewrite it into
// something the sanitiser keeps, without disabling sanitising.
import { maskCommentsForPreview } from './html-comment'

describe('maskCommentsForPreview', () => {
  it('rewrites a block comment into a sanitiser-proof element carrying the same text', () => {
    expect(maskCommentsForPreview('a\n\n<!-- note -->\n\nb')).toBe(
      'a\n\n<div class="vmde-comment" data-vmde-comment="1">&lt;!-- note --&gt;</div>\n\nb',
    )
  })

  it('joins a multi-line comment into one block', () => {
    const out = maskCommentsForPreview('<!-- line one\nline two -->')
    expect(out).toBe(
      '<div class="vmde-comment" data-vmde-comment="1">&lt;!-- line one\nline two --&gt;</div>',
    )
  })

  it('escapes the comment body so it cannot inject markup', () => {
    const out = maskCommentsForPreview('<!-- <img src=x onerror=alert(1)> -->')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).not.toContain('<img')
  })

  // The one that makes a naive regex wrong: inside a fence the comment is literal text the reader
  // asked to see.
  it('leaves a comment inside a fenced code block alone', () => {
    const md = 'a\n\n```html\n<!-- kept literal -->\n```\n\nb'
    expect(maskCommentsForPreview(md)).toBe(md)
  })

  it('handles tilde fences and longer closing fences', () => {
    const md = 'a\n\n~~~~\n<!-- kept -->\n~~~~\n\n<!-- masked -->'
    const out = maskCommentsForPreview(md)
    expect(out).toContain('~~~~\n<!-- kept -->\n~~~~')
    expect(out).toContain('&lt;!-- masked --&gt;')
  })

  it('resumes masking after a fence closes', () => {
    const out = maskCommentsForPreview('```\n<!-- a -->\n```\n\n<!-- b -->')
    expect(out).toContain('```\n<!-- a -->\n```')
    expect(out).toContain('&lt;!-- b --&gt;')
  })

  it('leaves a mid-paragraph comment inline (rewriting it would reflow the paragraph)', () => {
    const md = 'text <!-- inline --> more'
    expect(maskCommentsForPreview(md)).toBe(md)
  })

  it('labels an empty comment and is a no-op on a document without any', () => {
    expect(maskCommentsForPreview('<!---->')).toContain(
      '&lt;!-- (empty) --&gt;',
    )
    const plain = 'just prose\n\nmore'
    expect(maskCommentsForPreview(plain)).toBe(plain)
  })

  it('runs a comment left unterminated to the end rather than dropping the rest', () => {
    const out = maskCommentsForPreview('a\n\n<!-- never closed\nstill inside')
    expect(out).toContain('&lt;!-- never closed\nstill inside --&gt;')
  })
})

// IR/WYSIWYG html-block dual-node: `pre.vditor-ir__marker--pre > code` is the editable source, a
// sibling preview element gets the visible comment text injected (applyCommentPreviews). Mirrors the
// shape Vditor actually emits closely enough for mutation-scope.ts's topLevelBlock climb.
function htmlBlockNode(commentText: string): HTMLElement {
  const node = document.createElement('div')
  node.className = 'vditor-ir__node'
  node.setAttribute('data-type', 'html-block')
  const markerPre = document.createElement('pre')
  markerPre.className = 'vditor-ir__marker--pre'
  const code = document.createElement('code')
  code.textContent = `<!-- ${commentText} -->`
  markerPre.appendChild(code)
  const preview = document.createElement('pre')
  preview.className = 'vditor-ir__preview'
  preview.setAttribute('data-render', '2')
  node.append(markerPre, preview)
  return node
}

describe('applyCommentPreviews', () => {
  it('injects the visible comment text into each html-block preview', () => {
    const root = document.createElement('div')
    root.append(htmlBlockNode('alpha'), htmlBlockNode('bravo'))
    applyCommentPreviews(root)
    const previews = Array.from(root.querySelectorAll('.vmde-comment')).map(
      (e) => e.textContent,
    )
    expect(previews).toEqual(['<!-- alpha -->', '<!-- bravo -->'])
  })
})

// Task 173: observeHtmlComments is scoped via mutation-scope.ts (applyCommentPreviewsWithin) instead
// of a whole-editor applyCommentPreviews on every batch. These exercise the REAL MutationObserver-
// driven path (a genuine DOM mutation), not a direct applyCommentPreviews() call, so the scoped
// branch is covered.
//
// Deterministic rAF (same pattern as observe-coalesce.test.ts / callouts.test.ts): the leading edge
// runs synchronously, but it ALSO arms a trailing-edge rAF that a real, un-stubbed jsdom rAF may not
// resolve within a plain `await` — stub it so the trailing pass is triggered via `fireFrame()`.
describe('observeHtmlComments scoping (task 173/174)', () => {
  let dispose: (() => void) | null = null
  let frameCallbacks: FrameRequestCallback[]
  beforeEach(() => {
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameCallbacks.push(cb)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      // Mark the slot cancelled so a later flush of frameCallbacks can't
      // re-invoke a callback the code under test already cancelled.
      frameCallbacks[id - 1] = () => {
        /* cancelled */
      }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    dispose?.()
    dispose = null
    document.body.innerHTML = ''
  })
  const fireFrame = () => {
    const cbs = frameCallbacks
    frameCallbacks = []
    for (const cb of cbs) cb(0)
  }

  it('a real outerHTML replace of ONE html-block re-decorates the FRESH node via the scoped path, sibling untouched', async () => {
    const ir = document.createElement('div')
    ir.className = 'vditor-ir vditor-reset'
    ir.setAttribute('contenteditable', 'true')
    const nodeA = htmlBlockNode('alpha')
    const nodeB = htmlBlockNode('bravo')
    ir.append(nodeA, nodeB)
    document.body.appendChild(ir)

    dispose = observeHtmlComments(ir) // mount's leading run also arms a trailing-edge rAF
    expect(
      Array.from(ir.querySelectorAll('.vmde-comment')).map(
        (e) => e.textContent,
      ),
    ).toEqual(['<!-- alpha -->', '<!-- bravo -->'])

    // Mirrors the spin's `blockElement.outerHTML = html`: the pre-existing node is destroyed and a
    // brand-new one takes its place — the real regression risk task 173 warns about (a freshly
    // recreated node the scoped re-decorate pass must still find).
    nodeA.outerHTML = htmlBlockNode('alpha renamed').outerHTML
    await Promise.resolve() // flush the MutationObserver microtask → coalesced (mount's rAF is armed)
    fireFrame() // flush the trailing pass, which resolves the scoped block via mutation-scope.ts

    expect(
      Array.from(ir.querySelectorAll('.vmde-comment')).map(
        (e) => e.textContent,
      ),
    ).toEqual(['<!-- alpha renamed -->', '<!-- bravo -->']) // fresh node decorated, sibling untouched
  })
})

// Task 733 / 031 (F-7): with the live feed, one cell key rescans the cell only, never its table or the
// whole root; an HTML comment block change still decorates through its own block scope.
// Building the factor 16 fixture with the real Lute can pass 5 s under a full parallel run.
describe('scoped budgets (Task 733 / 031, F-7)', { timeout: 60_000 }, () => {
  const FACTORS: readonly Factor[] = [1, 4, 16]

  afterEach(() => {
    provideUnitFeed(window, undefined)
  })

  // Counts one change of the first body cell with the observer installed on the factor's fixture.
  function cellKey(factor: Factor) {
    const { root } = irFixture(tableHeavyMarkdown(factor))
    const feed = fakeUnitFeed<UnitsChange>(root)
    provideUnitFeed(window, feed)
    const dispose = observeHtmlComments(root)
    try {
      const cell = root.querySelector<HTMLElement>('table tbody td')!
      const subtree = cell.getElementsByTagName('*').length + 1
      const { counts } = countBudget(root, () =>
        feed.emit({
          cause: 'mutation',
          whole: false,
          changed: [cellUnit(cell)],
          structural: [],
          scopes: [cell],
        }),
      )
      return { counts, subtree }
    } finally {
      dispose()
    }
  }

  it.each(FACTORS)(
    'a cell key decorates without a table or root query at factor %i',
    (factor) => {
      const { counts, subtree } = cellKey(factor)
      expect(counts.tableQueries).toBe(0)
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes + counts.nodesWalked).toBeLessThanOrEqual(
        subtree + 8,
      )
    },
  )

  it('costs the same at every factor', () => {
    const costs = FACTORS.map((factor) => {
      const { counts } = cellKey(factor)
      return counts.queriedNodes + counts.nodesWalked
    })
    expect(new Set(costs).size).toBe(1)
  })

  it('an HTML comment block change still decorates', () => {
    const ir = document.createElement('div')
    ir.className = 'vditor-ir vditor-reset'
    const node = htmlBlockNode('alpha')
    ir.append(node)
    document.body.replaceChildren(ir)
    const feed = fakeUnitFeed<UnitsChange>(ir)
    provideUnitFeed(window, feed)
    const dispose = observeHtmlComments(ir)
    try {
      node.querySelector('code')!.textContent = '<!-- alpha renamed -->'
      feed.emit({
        cause: 'mutation',
        whole: false,
        changed: [{ el: node, members: [node], kind: 'html', top: node }],
        structural: [],
        scopes: [node],
      })
      expect(node.querySelector('.vmde-comment')?.textContent).toBe(
        '<!-- alpha renamed -->',
      )
    } finally {
      dispose()
      document.body.innerHTML = ''
    }
  })
})
