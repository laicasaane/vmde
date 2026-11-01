// @vitest-environment jsdom
import { test, expect, beforeEach, describe } from 'vitest'
import { blockScopeOf, findBlocks, resetCustomBlocks } from './diagram-dom'

beforeEach(() => {
  document.body.innerHTML = ''
})

// Regression for the "diagram sits on a code-PANEL background" bug: Vditor highlights these unknown
// languages as code first (adds `.hljs` to the <code>); findBlocks swaps <code>→<div> and MUST NOT
// carry `.hljs` over, else the highlight.js theme paints the code-panel bg behind the diagram svg.
// (e2e counterpart: test/vscode-e2e/diagram-render-sweep.spec.ts's diagram-bg case, task 511.)

test('code→div swap drops the hljs class (keeps language-X)', () => {
  document.body.innerHTML =
    '<pre class="vditor-ir__preview"><code class="language-d2 hljs">a -> b</code></pre>'
  const blocks = findBlocks(document, 'd2')
  expect(blocks).toHaveLength(1)
  const w = blocks[0].wrapper
  expect(w.tagName).toBe('DIV')
  expect(w.classList.contains('hljs')).toBe(false)
  expect(w.classList.contains('language-d2')).toBe(true)
  expect(w.className).toBe('language-d2')
  expect(blocks[0].code).toBe('a -> b')
})

test('preserves OTHER classes while stripping only hljs', () => {
  document.body.innerHTML =
    '<pre class="vditor-ir__preview"><code class="language-wavedrom hljs extra-x">{}</code></pre>'
  const blocks = findBlocks(document, 'wavedrom')
  expect(blocks).toHaveLength(1)
  const w = blocks[0].wrapper
  expect(w.classList.contains('hljs')).toBe(false)
  expect(w.classList.contains('language-wavedrom')).toBe(true)
  expect(w.classList.contains('extra-x')).toBe(true)
})

test('a code block without hljs swaps cleanly to a language-only div', () => {
  document.body.innerHTML =
    '<pre class="vditor-ir__preview"><code class="language-stl">solid x</code></pre>'
  const blocks = findBlocks(document, 'stl')
  expect(blocks).toHaveLength(1)
  expect(blocks[0].wrapper.className).toBe('language-stl')
})

test('skips the editable IR source marker (only renders in the preview)', () => {
  document.body.innerHTML =
    '<pre class="vditor-ir__marker--pre"><code class="language-d2 hljs">a -> b</code></pre>'
  expect(findBlocks(document, 'd2')).toHaveLength(0)
})

test('skips diagram targets inside blocks hidden by section hoisting', () => {
  document.body.innerHTML =
    '<div data-block="0" data-vmde-hoist-hidden>' +
    '<pre class="vditor-ir__preview"><code class="language-d2">a -> b</code></pre>' +
    '</div>'

  expect(findBlocks(document, 'd2')).toHaveLength(0)
})

test('an existing rendered div is reused as the wrapper (idempotent, no hljs)', () => {
  document.body.innerHTML =
    '<pre class="vditor-ir__preview"><div class="language-d2" data-code="a -> b"></div></pre>'
  const blocks = findBlocks(document, 'd2')
  expect(blocks).toHaveLength(1)
  expect(blocks[0].wrapper.tagName).toBe('DIV')
  expect(blocks[0].wrapper.classList.contains('hljs')).toBe(false)
})

// Task 400: resetCustomBlocks() is the shared reset step every reRenderX (wavedrom, nomnoml,
// geojson, topojson, vega/vega-lite, stl) now delegates to, replacing 6 near-identical bodies.
describe('resetCustomBlocks (task 400)', () => {
  function pane(html: string): HTMLElement {
    const p = document.createElement('div')
    p.className = 'vditor-ir__preview'
    p.innerHTML = html
    document.body.appendChild(p)
    return p
  }

  test('clears data-processed and blanks a processed block inside a preview pane', () => {
    const p = pane(
      '<div class="language-nomnoml" data-processed="true"><svg></svg></div>',
    )
    resetCustomBlocks(document, 'nomnoml')
    const el = p.querySelector('.language-nomnoml')!
    expect(el.hasAttribute('data-processed')).toBe(false)
    expect(el.innerHTML).toBe('')
  })

  test('leaves an UN-processed block untouched (no data-processed attr at all)', () => {
    const p = pane('<div class="language-nomnoml"><svg></svg></div>')
    resetCustomBlocks(document, 'nomnoml')
    expect(p.querySelector('.language-nomnoml')!.innerHTML).toBe('<svg></svg>')
  })

  test('ignores a matching block OUTSIDE any preview pane', () => {
    const outside = document.createElement('div')
    outside.className = 'language-nomnoml'
    outside.setAttribute('data-processed', 'true')
    outside.innerHTML = '<svg></svg>'
    document.body.appendChild(outside)
    resetCustomBlocks(document, 'nomnoml')
    expect(outside.innerHTML).toBe('<svg></svg>')
  })

  test('clears the given error attribute when provided (the wavedrom/vega wrinkle)', () => {
    const p = pane(
      '<div class="language-wavedrom" data-processed="true" data-wavedrom-error="render"></div>',
    )
    resetCustomBlocks(document, 'wavedrom', 'data-wavedrom-error')
    expect(
      p
        .querySelector('.language-wavedrom')!
        .hasAttribute('data-wavedrom-error'),
    ).toBe(false)
  })

  test('without an error attribute arg, other attributes are left alone (only data-processed + innerHTML change)', () => {
    const p = pane(
      '<div class="language-stl" data-processed="true" data-keep="x"></div>',
    )
    resetCustomBlocks(document, 'stl')
    expect(p.querySelector('.language-stl')!.getAttribute('data-keep')).toBe(
      'x',
    )
  })

  test('accepts an array of langs, resetting each (the vega + vega-lite wrinkle)', () => {
    const p = pane(
      '<div class="language-vega" data-processed="true"></div>' +
        '<div class="language-vega-lite" data-processed="true"></div>',
    )
    resetCustomBlocks(document, ['vega', 'vega-lite'], 'data-vega-error')
    expect(
      p.querySelector('.language-vega')!.hasAttribute('data-processed'),
    ).toBe(false)
    expect(
      p.querySelector('.language-vega-lite')!.hasAttribute('data-processed'),
    ).toBe(false)
  })

  test('resets both `code.language-X` and `div.language-X` forms', () => {
    const p = pane(
      '<code class="language-nomnoml" data-processed="true">src</code>',
    )
    resetCustomBlocks(document, 'nomnoml')
    expect(p.querySelector('.language-nomnoml')!.innerHTML).toBe('')
  })

  // Task 412 follow-up (confirmed-HIGH bug) — `container` here can be a NARROWED per-diagram scope
  // (blockScopeOf's `.vditor-preview` fallback: the target's own immediate parent, e.g. `owner`
  // below), which does NOT itself carry a preview-pane class — the real `.vditor-preview` ancestor
  // sits further up, OUTSIDE `container`. The OLD "find panes as descendants of container" shape
  // found nothing in that case and silently skipped the reset; the fix (a combined `:is(pane) el`
  // selector) is evaluated against the target's FULL ancestor chain, not just container's
  // descendants, so it still finds it.
  test('resets a rendered block when scoped to its full-Preview owner (not a pane-classed ancestor)', () => {
    const preview = document.createElement('div')
    preview.className = 'vditor-preview'
    const owner = document.createElement('pre')
    owner.innerHTML =
      '<div class="language-nomnoml" data-processed="true"><svg></svg></div>'
    preview.append(owner)
    document.body.append(preview)

    resetCustomBlocks(owner, 'nomnoml')

    const live = owner.querySelector('.language-nomnoml')!
    expect(live.hasAttribute('data-processed')).toBe(false)
    expect(live.innerHTML).toBe('')
  })
})

// blockScopeOf had ZERO permanent coverage — the "two sibling diagrams inside the same
// blockquote/list-item resolve to SEPARATE wrappers" claim in its own header comment was
// verified once, by hand, in a real webview (task 412 pre-check) and never pinned down here.
// Lute nests one `.vditor-ir__node` / `.vditor-wysiwyg__block` per top-level block even when
// several blocks share a container element (blockquote, <li>) — these two shapes are exactly
// the ones its comment calls out, so a regression that widened blockScopeOf's match back up to
// the shared container (silently coupling two unrelated diagrams' redraw/reset scope) would go
// unnoticed without this.
describe('blockScopeOf (task 412 follow-up)', () => {
  test('two D2 blocks sharing a blockquote ancestor resolve to their OWN wrapper, never the blockquote', () => {
    const blockquote = document.createElement('blockquote')
    blockquote.setAttribute('data-type', 'blockquote')
    blockquote.setAttribute('data-block', '0')

    const block1 = document.createElement('div')
    block1.className = 'vditor-ir__node'
    block1.innerHTML =
      '<pre class="vditor-ir__preview"><div class="language-d2" data-code="a -> b"></div></pre>'

    const block2 = document.createElement('div')
    block2.className = 'vditor-ir__node'
    block2.innerHTML =
      '<pre class="vditor-ir__preview"><div class="language-d2" data-code="c -> d"></div></pre>'

    blockquote.append(block1, block2)
    document.body.append(blockquote)

    const live1 = block1.querySelector<HTMLElement>('.language-d2')!
    const live2 = block2.querySelector<HTMLElement>('.language-d2')!

    const scope1 = blockScopeOf(live1)
    const scope2 = blockScopeOf(live2)

    expect(scope1).toBe(block1)
    expect(scope2).toBe(block2)
    expect(scope1).not.toBe(scope2)
    expect(scope1).not.toBe(blockquote) // never widens to the shared ancestor
    expect(scope1.contains(live2)).toBe(false) // never crosses into the sibling's scope
    expect(scope2.contains(live1)).toBe(false)
  })

  test('two D2 blocks sharing a list-item ancestor resolve to their OWN wrapper, never the <li>', () => {
    const li = document.createElement('li')
    li.setAttribute('data-block', '0')

    const block1 = document.createElement('div')
    block1.className = 'vditor-wysiwyg__block'
    block1.innerHTML = '<div class="language-d2" data-code="a -> b"></div>'

    const block2 = document.createElement('div')
    block2.className = 'vditor-wysiwyg__block'
    block2.innerHTML = '<div class="language-d2" data-code="c -> d"></div>'

    li.append(block1, block2)
    document.body.append(li)

    const live1 = block1.querySelector<HTMLElement>('.language-d2')!
    const live2 = block2.querySelector<HTMLElement>('.language-d2')!

    const scope1 = blockScopeOf(live1)
    const scope2 = blockScopeOf(live2)

    expect(scope1).toBe(block1)
    expect(scope2).toBe(block2)
    expect(scope1).not.toBe(scope2)
    expect(scope1).not.toBe(li) // never widens to the shared <li>
    expect(scope1.contains(live2)).toBe(false) // never crosses into the sibling's scope
    expect(scope2.contains(live1)).toBe(false)
  })
})

// Task 643: full Preview holds heavy blocks that are far off screen as `data-vmde-preview-pending`
// until they scroll near. An engine sweep must not render them early.
describe('findBlocks skips pending full-Preview blocks (task 643)', () => {
  function previewWith(pending: boolean): HTMLElement {
    document.body.innerHTML = ''
    const pane = document.createElement('div')
    pane.className = 'vditor-reset'
    pane.innerHTML = `<div ${pending ? 'data-vmde-preview-pending="true"' : ''}><div class="language-d2">a -> b</div></div>`
    document.body.appendChild(pane)
    return pane
  }

  test('a block inside a pending wrapper is not returned', () => {
    previewWith(true)
    expect(findBlocks(document, 'd2')).toHaveLength(0)
  })

  test('a block that is itself pending is not returned', () => {
    const pane = previewWith(false)
    pane
      .querySelector('.language-d2')!
      .setAttribute('data-vmde-preview-pending', 'true')
    expect(findBlocks(document, 'd2')).toHaveLength(0)
  })

  test('the same block is returned once the pending mark is removed', () => {
    const pane = previewWith(true)
    pane.firstElementChild!.removeAttribute('data-vmde-preview-pending')
    expect(findBlocks(document, 'd2')).toHaveLength(1)
  })
})
