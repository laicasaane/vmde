// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest'
import { morphPreviewInto, setPreviewMorphBaseline } from './preview-morph'

// Task 187: the morph must keep the LIVE DOM of blocks whose RAW html is unchanged
// (diagram instances survive an edit settle) and splice only the changed region.
describe('morphPreviewInto (task 187)', () => {
  let pane: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    pane = document.createElement('div')
    document.body.appendChild(pane)
  })

  const A = '<p>alpha</p>'
  const B = '<div class="language-mermaid">graph TD</div>'
  const C = '<p>charlie</p>'
  const html = (...blocks: string[]) => blocks.join('\n')

  test('first render populates the pane like innerHTML would (incl. text nodes)', () => {
    morphPreviewInto(pane, html(A, B, C))
    expect(pane.children).toHaveLength(3)
    expect(pane.innerHTML).toBe(html(A, B, C))
  })

  test('an unchanged block keeps its live (post-processed) DOM across a morph', () => {
    morphPreviewInto(pane, html(A, B, C))
    // Simulate the engine pass: the mermaid block gets rendered + marked.
    const diagram = pane.children[1] as HTMLElement
    diagram.setAttribute('data-processed', 'true')
    diagram.innerHTML = '<svg data-live="1"></svg>'
    // Edit the LAST block only.
    morphPreviewInto(pane, html(A, B, '<p>charlie edited</p>'))
    expect(pane.children[1]).toBe(diagram) // same node — instance survived
    expect(pane.children[1].querySelector('svg[data-live]')).toBeTruthy()
    expect(pane.children[2].textContent).toBe('charlie edited')
  })

  test('a changed middle block is replaced while prefix and suffix keep identity', () => {
    morphPreviewInto(pane, html(A, B, C))
    const [first, , third] = Array.from(pane.children)
    morphPreviewInto(
      pane,
      html(A, '<div class="language-mermaid">graph LR</div>', C),
    )
    expect(pane.children[0]).toBe(first)
    expect(pane.children[2]).toBe(third)
    expect(pane.children[1].textContent).toBe('graph LR')
  })

  test('insertion in the middle keeps both neighbours', () => {
    morphPreviewInto(pane, html(A, C))
    const [first, second] = Array.from(pane.children)
    morphPreviewInto(pane, html(A, B, C))
    expect(pane.children).toHaveLength(3)
    expect(pane.children[0]).toBe(first)
    expect(pane.children[2]).toBe(second)
  })

  test('deletion in the middle keeps both neighbours', () => {
    morphPreviewInto(pane, html(A, B, C))
    const first = pane.children[0]
    const third = pane.children[2]
    morphPreviewInto(pane, html(A, C))
    expect(pane.children).toHaveLength(2)
    expect(pane.children[0]).toBe(first)
    expect(pane.children[1]).toBe(third)
  })

  test('identical html is a no-op (all nodes keep identity)', () => {
    morphPreviewInto(pane, html(A, B, C))
    const nodes = Array.from(pane.children)
    morphPreviewInto(pane, html(A, B, C))
    expect(Array.from(pane.children)).toEqual(nodes)
  })

  test('external mutation (child count drift) → full set + re-baseline, no stale keeps', () => {
    morphPreviewInto(pane, html(A, B, C))
    // Theme flip / setValue path: someone rebuilt the pane outside the morph.
    pane.innerHTML = '<p>foreign</p>'
    morphPreviewInto(pane, html(A, B, C))
    expect(pane.children).toHaveLength(3)
    expect(pane.innerHTML).toBe(html(A, B, C))
    // …and the new baseline works: next morph keeps identity again.
    const second = pane.children[1]
    morphPreviewInto(pane, html(A, B, '<p>tail</p>'))
    expect(pane.children[1]).toBe(second)
  })

  test('nodes before the first element → safe full fallback', () => {
    morphPreviewInto(pane, `leading text${A}`)
    expect(pane.textContent).toBe('leading textalpha')
  })
})

// Task 643: a streamed Preview is built chunk by chunk outside the morph, so the cache has no
// baseline for it. The renderer records the raw unit strings it appended; the next morph then keeps
// every unchanged leading block instead of falling back to a full innerHTML set.
describe('setPreviewMorphBaseline (task 643)', () => {
  const A = '<p>alpha</p>'
  const B = '<p>bravo</p>'
  const C = '<p>charlie</p>'

  test('lets the next morph keep unchanged blocks of a pane built outside the morph', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    pane.innerHTML = [A, B, C].join('\n')
    setPreviewMorphBaseline(pane, [A, B, C])
    const [first, second] = Array.from(pane.children)
    morphPreviewInto(pane, [A, B, '<p>charlie edited</p>'].join('\n'))
    expect(pane.children[0]).toBe(first)
    expect(pane.children[1]).toBe(second)
    expect(pane.children[2].textContent).toBe('charlie edited')
  })

  test('without a baseline the same morph rebuilds the whole pane', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    pane.innerHTML = [A, B, C].join('\n')
    const first = pane.children[0]
    morphPreviewInto(pane, [A, B, '<p>charlie edited</p>'].join('\n'))
    expect(pane.children[0]).not.toBe(first)
  })

  test('a baseline that disagrees with the pane children is ignored safely', () => {
    const pane = document.createElement('div')
    document.body.appendChild(pane)
    pane.innerHTML = [A, B].join('\n')
    setPreviewMorphBaseline(pane, [A, B, C])
    morphPreviewInto(pane, [A, B, C].join('\n'))
    expect(pane.children).toHaveLength(3)
    expect(pane.innerHTML).toBe([A, B, C].join('\n'))
  })
})
