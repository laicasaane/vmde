// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from 'vitest'
import { countBudget } from '../testing/budget-harness'
import * as previewMorph from './preview-morph'
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

// Task 733 / 015-T1, S-09 (task 015 sections 6.2 D-6 and 6.4): the Split pane morph by Source units.
// A unit's HTML may hold several top-level elements; the baseline keeps their count per unit. Read
// through the namespace so this file typechecks before the two functions exist.
interface UnitMorph {
  morphPreviewUnits?(
    pane: HTMLElement,
    from: number,
    removed: number,
    htmls: readonly string[],
  ): boolean
  setPreviewUnitBaseline?(
    pane: HTMLElement,
    elementCounts: readonly number[],
  ): void
}
const unitMorph = previewMorph as unknown as UnitMorph

// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'morphPreviewUnits at factor %i (S-09)',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    let pane: HTMLElement
    const units = 10 * factor
    beforeEach(() => {
      document.body.innerHTML = ''
      pane = document.createElement('div')
      // Every unit is one paragraph, except unit 1, which renders as two elements.
      const parts: string[] = []
      for (let i = 0; i < units; i++)
        parts.push(i === 1 ? '<p>b1</p><p>b2</p>' : `<p>unit ${i}</p>`)
      pane.innerHTML = parts.join('')
      document.body.appendChild(pane)
    })
    const counts = () =>
      Array.from({ length: units }, (_, i) => (i === 1 ? 2 : 1))

    test('replaces only the elements of the changed unit', () => {
      expect(typeof unitMorph.morphPreviewUnits).toBe('function')
      unitMorph.setPreviewUnitBaseline?.(pane, counts())
      const kept = Array.from(pane.children).filter(
        (_, i) => i !== 1 && i !== 2,
      )
      const { result, counts: budget } = countBudget(pane, () =>
        unitMorph.morphPreviewUnits?.(pane, 1, 1, ['<p>changed</p>']),
      )
      expect(result).toBe(true)
      expect(pane.children).toHaveLength(units)
      expect(pane.children[1]?.textContent).toBe('changed')
      const after = Array.from(pane.children).filter((_, i) => i !== 1)
      expect(after).toEqual(kept)
      expect(budget.innerHtmlReads).toBe(0)
      expect(budget.rootQueries).toBe(0)
    })

    test('inserts and removes whole units', () => {
      unitMorph.setPreviewUnitBaseline?.(pane, counts())
      expect(unitMorph.morphPreviewUnits?.(pane, 2, 0, ['<p>new</p>'])).toBe(
        true,
      )
      expect(pane.children[3]?.textContent).toBe('new')
      expect(unitMorph.morphPreviewUnits?.(pane, 1, 1, [])).toBe(true)
      expect(pane.children[1]?.textContent).toBe('new')
    })

    test('returns false (the caller falls back to morphPreviewInto) when the pane left the baseline', () => {
      unitMorph.setPreviewUnitBaseline?.(pane, counts())
      pane.appendChild(document.createElement('p'))
      expect(unitMorph.morphPreviewUnits?.(pane, 0, 1, ['<p>x</p>'])).toBe(
        false,
      )
    })
  },
)

// Task 733 / 019 (C5, Q-157): a unit morph gives the same pane DOM as a whole render. `Md2HTML` writes
// one `\n` Text node after each top-level element; the morph keeps it with its element.
describe('019 morphPreviewUnits keeps the block separators (C5)', () => {
  const whole = (...blocks: string[]) => blocks.map((b) => `${b}\n`).join('')
  let pane: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    pane = document.createElement('div')
    pane.innerHTML = whole('<p>a</p>', '<p>b</p>', '<p>c</p>')
    document.body.appendChild(pane)
    unitMorph.setPreviewUnitBaseline?.(pane, [1, 1, 1])
  })

  test('a replaced unit leaves the pane equal to a whole render', () => {
    expect(unitMorph.morphPreviewUnits?.(pane, 1, 1, ['<p>bx</p>\n'])).toBe(
      true,
    )
    expect(pane.innerHTML).toBe(whole('<p>a</p>', '<p>bx</p>', '<p>c</p>'))
  })

  test('an inserted and a removed unit keep one separator per element', () => {
    expect(unitMorph.morphPreviewUnits?.(pane, 1, 0, ['<p>n</p>\n'])).toBe(true)
    expect(pane.innerHTML).toBe(
      whole('<p>a</p>', '<p>n</p>', '<p>b</p>', '<p>c</p>'),
    )
    expect(unitMorph.morphPreviewUnits?.(pane, 2, 1, [])).toBe(true)
    expect(pane.innerHTML).toBe(whole('<p>a</p>', '<p>n</p>', '<p>c</p>'))
  })
})

// Task 733 run 1 repair (`edit-counter-gates:789`): the front-matter observer adds a view-only table after
// the front matter's `pre` once the pane is built. The unit morph counts it with that unit instead of
// refusing (which rendered the whole pane on every key).
describe('morphPreviewUnits with a view-only element a renderer added (733 run 1)', () => {
  const build = () => {
    const pane = document.createElement('div')
    pane.innerHTML = '<pre>fm</pre>\n<p>alpha</p>\n<p>bravo</p>\n'
    previewMorph.setPreviewUnitBaseline(pane, [1, 1, 1])
    const table = document.createElement('div')
    table.className = 'vmde-front-matter'
    table.setAttribute('data-render', '1')
    table.setAttribute('contenteditable', 'false')
    pane.querySelector('pre')?.after(table)
    return { pane, table }
  }

  test('a later unit morphs and the view-only element stays', () => {
    const { pane, table } = build()
    expect(
      previewMorph.morphPreviewUnits(pane, 2, 1, ['<p>bravox</p>\n']),
    ).toBe(true)
    expect(pane.children[1]).toBe(table)
    expect(pane.textContent).toContain('bravox')
    // The next key needs no recount.
    expect(
      previewMorph.morphPreviewUnits(pane, 1, 1, ['<p>alphay</p>\n']),
    ).toBe(true)
    expect(pane.children.length).toBe(4)
  })

  test('the unit that holds it takes it out with its own elements', () => {
    const { pane, table } = build()
    expect(
      previewMorph.morphPreviewUnits(pane, 0, 1, ['<pre>fm2</pre>\n']),
    ).toBe(true)
    expect(table.isConnected).toBe(false)
    expect(pane.children.length).toBe(3)
  })

  test('a pane with an element of no unit still refuses (guard)', () => {
    const { pane } = build()
    pane.append(document.createElement('p'))
    expect(
      previewMorph.morphPreviewUnits(pane, 1, 1, ['<p>alphay</p>\n']),
    ).toBe(false)
  })
})
