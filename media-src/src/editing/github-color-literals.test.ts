// @vitest-environment jsdom

import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest'
import {
  applyGithubColorLiterals,
  observeGithubColorLiterals,
  parseGithubColorLiteral,
  setGithubColorLiteralsEnabled,
} from './github-color-literals'
import {
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
  type LiveUnit,
} from '../util/unit-changes'
import {
  countBudget,
  type Factor,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

describe('parseGithubColorLiteral', () => {
  it.each([
    ['#0969DA', '#0969DA'],
    ['#abcdef', '#abcdef'],
    ['rgb(9, 105, 218)', 'rgb(9, 105, 218)'],
    ['rgb(9,105,218)', 'rgb(9, 105, 218)'],
    ['rgb(9 , 105 , 218)', 'rgb(9, 105, 218)'],
    ['rgb(000, 255, 255)', 'rgb(0, 255, 255)'],
    ['hsl(212, 92%, 45%)', 'hsl(212, 92%, 45%)'],
    ['hsl(360,100%,0%)', 'hsl(360, 100%, 0%)'],
    ['hsl(000 , 100% , 050%)', 'hsl(0, 100%, 50%)'],
  ])('normalizes valid literal %s to safe CSS %s', (source, expected) => {
    expect(parseGithubColorLiteral(source)).toBe(expected)
  })

  it.each([
    '',
    ' #0969DA',
    '#0969DA ',
    '#123',
    '#gggggg',
    '\\#0969DA',
    '#12345678',
    'rgb(1, 2)',
    'rgb(256, 0, 0)',
    'rgb(-1, 0, 0)',
    'rgb(+1, 0, 0)',
    'rgb(1.5, 0, 0)',
    'rgb(1, 2, 3, 4)',
    'rgb( 1, 2, 3)',
    'rgb(1, 2, 3 )',
    'rgb(1,\t2,3)',
    'rgba(1, 2, 3, 1)',
    'hsl(361, 50%, 50%)',
    'hsl(-1, 50%, 50%)',
    'hsl(0, 101%, 50%)',
    'hsl(0, 50%, -1%)',
    'hsl(0, 50.5%, 50%)',
    'hsl(0, 50, 50%)',
    'hsla(0, 50%, 50%, 1)',
    'rgb(1, 2, 3) trailing',
  ])('rejects malformed or out-of-range literal %s', (source) => {
    expect(parseGithubColorLiteral(source)).toBeNull()
  })
})

const COLOR_CLASS = 'vmde-github-color-literal'
const COLOR_PROPERTY = '--vmde-github-color-literal'

function mountEditor(html: string): HTMLElement {
  const app = document.createElement('div')
  app.innerHTML = `<pre class="vditor-reset">${html}</pre>`
  document.body.appendChild(app)
  return app
}

afterEach(() => {
  setGithubColorLiteralsEnabled(false)
  document.body.innerHTML = ''
})

describe('applyGithubColorLiterals', () => {
  it('adds the swatch as attributes while preserving inline-code text and children', () => {
    const root = mountEditor(
      '<p><code>#0969DA</code> <code>rgb(9, 105, 218)</code></p>' +
        '<p><code data-marker="`">\u200bhsl(212, 92%, 45%)</code></p>' +
        '<p><code>#12345</code></p>' +
        '<pre class="vditor-wysiwyg__pre"><code>#ffffff</code></pre>' +
        '<p><span data-type="html-inline"><code class="vditor-ir__marker">&lt;code&gt;</code></span>#abcdef<span data-type="html-inline"><code class="vditor-ir__marker">&lt;/code&gt;</code></span></p>',
    )
    const code = Array.from(root.querySelectorAll('code'))

    applyGithubColorLiterals(root, true)

    expect(code[0].classList.contains(COLOR_CLASS)).toBe(true)
    expect(code[0].style.getPropertyValue(COLOR_PROPERTY)).toBe('#0969DA')
    expect(code[1].style.getPropertyValue(COLOR_PROPERTY)).toBe(
      'rgb(9, 105, 218)',
    )
    expect(code[2].style.getPropertyValue(COLOR_PROPERTY)).toBe(
      'hsl(212, 92%, 45%)',
    )
    expect(code[3].classList.contains(COLOR_CLASS)).toBe(false)
    expect(code[4].classList.contains(COLOR_CLASS)).toBe(false)
    expect(code[5].classList.contains(COLOR_CLASS)).toBe(false)
    expect(code[6].classList.contains(COLOR_CLASS)).toBe(false)
    expect(code.map((element) => element.textContent)).toEqual([
      '#0969DA',
      'rgb(9, 105, 218)',
      '\u200bhsl(212, 92%, 45%)',
      '#12345',
      '#ffffff',
      '<code>',
      '</code>',
    ])
    expect(code.map((element) => element.childNodes.length)).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ])
    expect(
      root.querySelector('.vditor-ir__marker')?.parentElement?.parentElement
        ?.textContent,
    ).toContain('<code>#abcdef</code>')
  })

  it('accepts only one leading WYSIWYG caret marker, not arbitrary zero-width padding', () => {
    const root = mountEditor(
      '<p><code>\u200b#112233</code> <code data-marker="`">\u200b\u200b#445566</code></p>',
    )
    const code = root.querySelectorAll('code')

    applyGithubColorLiterals(root, true)

    expect(code[0].classList.contains(COLOR_CLASS)).toBe(false)
    expect(code[1].classList.contains(COLOR_CLASS)).toBe(false)
  })

  it('clears stale swatches when an edit makes a literal invalid or the setting is off', () => {
    const root = mountEditor('<p><code>rgb(9, 105, 218)</code></p>')
    const code = root.querySelector('code')!
    applyGithubColorLiterals(root, true)
    expect(code.classList.contains(COLOR_CLASS)).toBe(true)

    code.textContent = 'rgb(256, 105, 218)'
    applyGithubColorLiterals(root, true)
    expect(code.classList.contains(COLOR_CLASS)).toBe(false)
    expect(code.style.getPropertyValue(COLOR_PROPERTY)).toBe('')

    code.textContent = '#0969DA'
    applyGithubColorLiterals(root, true)
    applyGithubColorLiterals(root, false)
    expect(code.classList.contains(COLOR_CLASS)).toBe(false)
    expect(code.style.getPropertyValue(COLOR_PROPERTY)).toBe('')
  })

  it('keeps the caret range in place when decorating the code span that holds it', () => {
    const root = mountEditor('<p><code>#0969DA</code></p>')
    const text = root.querySelector('code')!.firstChild!
    const selection = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 4)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)

    applyGithubColorLiterals(root, true)

    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(4)
  })

  it('leaves code-like nodes in the raw Source editor undecorated', () => {
    const source = document.createElement('pre')
    source.className = 'vditor-sv vditor-reset'
    source.innerHTML = '<code>#abcdef</code>'

    applyGithubColorLiterals(source, true)

    expect(source.querySelector('code')?.classList.contains(COLOR_CLASS)).toBe(
      false,
    )
  })

  it('decorates rendered raw HTML code where Preview output has no source-spelling marker', () => {
    const root = mountEditor('<p><code>#abcdef</code></p>')
    const code = root.querySelector('code')!

    applyGithubColorLiterals(root, true)

    expect(code.classList.contains(COLOR_CLASS)).toBe(true)
    expect(code.textContent).toBe('#abcdef')
  })
})

describe('observeGithubColorLiterals', () => {
  it('reapplies after a DOM rebuild and removes swatches immediately when disabled', async () => {
    const root = mountEditor('<p><code>ordinary</code></p>')
    const dispose = observeGithubColorLiterals(root)

    setGithubColorLiteralsEnabled(true)
    const replacement = document.createElement('p')
    replacement.innerHTML = '<code>#abcdef</code>'
    root.querySelector('p')!.replaceWith(replacement)
    await new Promise((resolve) => setTimeout(resolve, 40))

    const code = root.querySelector('code')!
    expect(code.classList.contains(COLOR_CLASS)).toBe(true)
    expect(code.style.getPropertyValue(COLOR_PROPERTY)).toBe('#abcdef')

    setGithubColorLiteralsEnabled(false)
    expect(code.classList.contains(COLOR_CLASS)).toBe(false)
    expect(code.style.getPropertyValue(COLOR_PROPERTY)).toBe('')
    dispose()
  })
})

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-11): with a live feed over the IR root, the feed's changes decorate their scopes
// and the observer leaves records inside the feed root to the feed.
describe('observeGithubColorLiterals on unit feed changes (Task 733, B-11)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  const liveFeed = (feedRoot: HTMLElement) => {
    const listeners = new Set<(change: UnitsChange) => void>()
    const feed: UnitFeed = {
      root: feedRoot,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    return (change: Pick<UnitsChange, 'whole'> & Partial<UnitsChange>) => {
      const full = { cause: 'mutation', changed: [], structural: [], ...change }
      for (const listener of Array.from(listeners))
        listener(full as UnitsChange)
    }
  }
  const nodesIn = (node: Node): number => {
    let count = 1
    for (let child = node.firstChild; child; child = child.nextSibling)
      count += nodesIn(child)
    return count
  }
  const paragraph = (ir: HTMLElement, start: string) =>
    Array.from(ir.children).find((block) =>
      block.textContent?.startsWith(start),
    ) as HTMLElement
  const paragraphChange = (p: HTMLElement) => ({
    whole: false,
    changed: [{ el: p, members: [p], kind: 'paragraph' as const, top: p }],
    structural: [],
    scopes: [p],
  })
  const settleFrames = () => new Promise((resolve) => setTimeout(resolve, 40))

  afterEach(() => {
    provideUnitFeed(window, undefined)
    setGithubColorLiteralsEnabled(false)
  })

  it.each([1, 4, 16] as Factor[])(
    'decorates the scope of a paragraph change with no root query at factor %i',
    async (factor) => {
      const ir = irFixture(tableHeavyMarkdown(factor), () => undefined).root
      const emit = liveFeed(ir)
      setGithubColorLiteralsEnabled(true)
      const dispose = observeGithubColorLiterals(ir)
      await settleFrames()
      const p = paragraph(ir, 'Fifth paragraph')
      p.innerHTML = 'Fifth paragraph <code>#abcdef</code>'
      const { counts } = countBudget(ir, () => emit(paragraphChange(p)))
      expect(p.querySelector('code')?.classList.contains(COLOR_CLASS)).toBe(
        true,
      )
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(p) + ir.childElementCount,
      )
      dispose()
    },
  )

  it('leaves records inside the live feed root to the feed', async () => {
    const ir = irFixture(tableHeavyMarkdown(1), () => undefined).root
    liveFeed(ir)
    setGithubColorLiteralsEnabled(true)
    const dispose = observeGithubColorLiterals(ir)
    await settleFrames()
    const p = paragraph(ir, 'Fourth paragraph')
    p.innerHTML = 'Fourth paragraph <code>#123456</code>'
    await settleFrames()
    expect(p.querySelector('code')?.classList.contains(COLOR_CLASS)).toBe(false)
    dispose()
  })

  it('runs the whole pass for a whole change', async () => {
    const ir = irFixture(tableHeavyMarkdown(1), () => undefined).root
    const emit = liveFeed(ir)
    setGithubColorLiteralsEnabled(true)
    const dispose = observeGithubColorLiterals(ir)
    await settleFrames()
    const first = paragraph(ir, 'First paragraph')
    const second = paragraph(ir, 'Second paragraph')
    first.innerHTML = 'First <code>#111111</code>'
    second.innerHTML = 'Second <code>#222222</code>'
    emit({ whole: true, cause: 'rebind' })
    for (const p of [first, second])
      expect(p.querySelector('code')?.classList.contains(COLOR_CLASS)).toBe(
        true,
      )
    dispose()
  })
})

// ---- Task 733 / 013-T5: B-11 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeGithubColorLiterals` over a live feed of Lute's WYSIWYG root (the table-heavy fixture). B-11: `applyGithubColorLiterals` runs only on
// the scope of a change.
describe('013 B-11 observeGithubColorLiterals on the WYSIWYG fixture', () => {
  const feedListeners = new Set<(change: UnitsChange) => void>()
  let wysiwygFrames: FrameRequestCallback[] = []
  let stop: (() => void) | undefined
  beforeEach(() => {
    wysiwygFrames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      wysiwygFrames.push(cb)
      return wysiwygFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    provideUnitFeed(window, undefined)
    feedListeners.clear()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  /** The observer callbacks of the edit run; the frames they queue run inside the count. */
  const flushRecords = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }
  const nodesOf = (elements: readonly Element[]): number =>
    elements.reduce((sum, el) => sum + 1 + el.querySelectorAll('*').length, 0)
  const emit = (partial: Partial<UnitsChange>): void => {
    const change = {
      cause: 'mutation',
      whole: false,
      changed: [],
      structural: [],
      ...partial,
    } as UnitsChange
    for (const listener of Array.from(feedListeners)) listener(change)
  }
  const unitOf = (
    el: HTMLElement,
    kind: LiveUnit['kind'],
    top = el,
  ): LiveUnit => ({
    el,
    members: [el],
    kind,
    top,
  })
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    // The production mount: observers watch `#app`, so its queries count as root queries.
    app.id = 'app'
    app.className = 'vditor vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(MARKDOWN(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'wysiwyg',
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
    })
    const feed: UnitFeed = {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        feedListeners.add(listener)
        return () => feedListeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    stop = observeGithubColorLiterals(app)
    await settleWysiwyg()
    return { app, root }
  }

  const MARKDOWN = (factor: Factor): string => tableHeavyMarkdown(factor)

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('a paragraph change queries nothing on the root and at most its scope plus the top-level count', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      ;(paragraph.firstChild as Text).data += 'x'
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({
          changed: [unitOf(paragraph, 'paragraph')],
          scopes: [paragraph],
        } as Partial<UnitsChange>)
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(counts.queriedNodes, 'queried nodes').toBeLessThanOrEqual(
        nodesOf([paragraph]) + root.children.length,
      )
    }, 60_000)
  })
})
