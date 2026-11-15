// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import {
  cleanupGapParagraphs,
  ensureLeadingBlock,
  isThematicBreakParagraph,
  observeGapParagraphs,
  observeTrailingParagraph,
  promoteThematicBreaks,
} from './gap-paragraph'
import { installCompositionState } from '../util/caret-gesture'
// ensureTrailingParagraph moved to trailing-paragraph.ts (task 472) along with the rest of its
// own describe blocks (trailing-paragraph.test.ts) — still needed here for the one integration
// test below that exercises promoteThematicBreaks + ensureTrailingParagraph together.
import { ensureTrailingParagraph } from './trailing-paragraph'
import {
  type BudgetCounts,
  countBudget,
  type Factor,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'

const TRAILING = 'data-vmde-trailing'
const GAP = 'data-vmde-gap'
const LEADING = 'data-vmde-leading'
const ZWSP = '​'

function editorWith(innerHTML: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = innerHTML
  document.body.replaceChildren(el)
  return el
}
const trailingPs = (el: HTMLElement) =>
  el.querySelectorAll(`:scope > p[${TRAILING}]`)

beforeEach(() => {
  document.body.replaceChildren()
  ;(window as unknown as { vditor?: unknown }).vditor = undefined
})

describe('observeTrailingParagraph Enter follow', () => {
  it('moves a trailing-paragraph Enter into the newly split last paragraph', () => {
    const editor = editorWith(
      `<blockquote data-block="0" data-callout="note">note</blockquote><p data-block="0" ${TRAILING}>${ZWSP}</p>`,
    )
    const original = editor.lastElementChild as HTMLElement
    const selection = getSelection()!
    const range = document.createRange()
    range.setStart(original.firstChild as Text, 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as unknown as { vditor?: unknown }).vditor = {
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }

    let mutationCallback: MutationCallback = () => undefined
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: MutationCallback) {
          mutationCallback = callback
        }
        observe() {
          /* callback is driven explicitly below */
        }
        disconnect() {
          /* no external observer resources in this test double */
        }
      },
    )
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const dispose = observeTrailingParagraph(editor)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    const split = document.createElement('p')
    split.dataset.block = '0'
    split.textContent = ZWSP
    original.insertAdjacentElement('afterend', split)
    range.setStart(split.firstChild as Text, 1)
    selection.removeAllRanges()
    selection.addRange(range)
    ensureTrailingParagraph(editor, split.firstChild)
    range.setStart(original.firstChild as Text, 1)
    selection.removeAllRanges()
    selection.addRange(range)
    mutationCallback([], {} as MutationObserver)
    frames.shift()?.(0)

    expect(split.hasAttribute(TRAILING)).toBe(true)
    expect(
      split.contains(getSelection()?.getRangeAt(0).startContainer ?? null),
    ).toBe(true)
    dispose()
    vi.unstubAllGlobals()
  })
})

// Task 446 Part 1 — the mirror of the trailing invariant: the document must always offer AT LEAST
// ONE editable block, so caret code (caret.ts's 'document-start' intent) never has to anchor on
// the bare editable — the unpaintable Range that shipped as task 439.
describe('ensureLeadingBlock — the document always has at least one editable block', () => {
  it('a genuinely empty editor (zero element children) gets a seeded leading paragraph', () => {
    const el = editorWith('')
    expect(ensureLeadingBlock(el)).toBe(true)
    expect(el.childElementCount).toBe(1)
    const p = el.firstElementChild as HTMLElement
    expect(p.tagName).toBe('P')
    expect(p.hasAttribute(LEADING)).toBe(true)
    // ZWSP seed — Lute drops it, so the file on disk stays empty (task 439's shipped guarantee).
    expect(p.textContent).toBe(ZWSP)
  })

  it('an editor that already has a first block (even an atomic one) is left untouched', () => {
    // Deliberately narrower than a full mirror of endsWithBlock (see the file comment): a code
    // block already offers a typeable position inside it, so nothing is manufactured above it.
    const el = editorWith(
      '<div data-block="0" data-type="code-block"><pre><code>x</code></pre></div>',
    )
    expect(ensureLeadingBlock(el)).toBe(false)
    expect(el.childElementCount).toBe(1)
    expect(el.querySelector(`[${LEADING}]`)).toBeNull()
  })

  it('is idempotent — a second run adds no second leading paragraph', () => {
    const el = editorWith('')
    ensureLeadingBlock(el)
    ensureLeadingBlock(el)
    ensureLeadingBlock(el)
    expect(el.querySelectorAll(`[${LEADING}]`).length).toBe(1)
  })

  it('a leading paragraph the user typed into loses its tag (becomes real content)', () => {
    const el = editorWith('')
    ensureLeadingBlock(el)
    const p = el.firstElementChild as HTMLElement
    p.textContent = 'now real content'
    expect(ensureLeadingBlock(el)).toBe(true)
    expect(p.hasAttribute(LEADING)).toBe(false)
    // …and since the editor now has a real first block, nothing new is manufactured.
    expect(el.childElementCount).toBe(1)
  })

  it('does not get reclaimed by cleanupGapParagraphs next to a code-block neighbour', () => {
    // The trap Part 1 called out explicitly: an empty leading <p> next to a code block looks
    // exactly like a transient navigation gap to cleanupGapParagraphs, which would otherwise
    // remove it — and the observer would just re-add it next frame, flickering forever.
    const el = editorWith(
      `<p ${LEADING}="">${ZWSP}</p><div data-block="0" data-type="code-block"><pre><code>x</code></pre></div>`,
    )
    cleanupGapParagraphs(el, null)
    expect(el.querySelectorAll(`[${LEADING}]`).length).toBe(1)
    expect(el.firstElementChild?.hasAttribute(LEADING)).toBe(true)
  })
})

// Guard the interaction the selector collision exposed: the maintained trailing paragraph
// must NOT be reclaimed by the gap cleanup (they look alike — both empty <p> — but the
// trailing one is load-bearing).
describe('cleanupGapParagraphs leaves the trailing paragraph alone', () => {
  it('does not remove a data-vmde-trailing paragraph next to a callout', () => {
    const el = editorWith(
      `<blockquote data-block="0" data-callout="note"><p>note</p></blockquote><p ${TRAILING}="">${ZWSP}</p>`,
    )
    cleanupGapParagraphs(el, null)
    expect(trailingPs(el).length).toBe(1)
    expect(el.lastElementChild?.hasAttribute(TRAILING)).toBe(true)
  })
})

// Task 486: repeated Enter below a callout/code-block built a CHAIN of empty paragraphs — each
// one Vditor's native split leaves untagged, so they look exactly like a stale navigation splice
// to the code above unless the cleanup can tell "part of the chain reaching the caret" apart from
// "caret moved on entirely".
describe('cleanupGapParagraphs — a chain of blank lines the user is building via Enter survives', () => {
  it('keeps every paragraph in an unbroken empty-<p> chain that reaches the caret', () => {
    const el = editorWith(
      `<blockquote data-block="0" data-callout="note"><p>note</p></blockquote><p data-block="0"></p><p data-block="0"></p><p data-block="0"></p>`,
    )
    const caret = el.querySelectorAll('p')[2] // the LAST (newest) blank line holds the caret
    cleanupGapParagraphs(el, caret)
    expect(el.querySelectorAll(':scope > p').length).toBe(3) // none reclaimed
  })

  it('still reclaims a stale gap paragraph when the caret moved past it into a real block', () => {
    // The chain breaks on a non-<p> sibling (a real block, not another blank line) — the
    // original transient-splice behaviour: ArrowDown past a code block, through the gap, into
    // the blockquote below it.
    const el = editorWith(
      `<div data-block="0" data-type="code-block"><pre><code>x</code></pre></div><p data-block="0"></p><blockquote data-block="0"><p>quote</p></blockquote>`,
    )
    const caret = el.querySelector('blockquote p')?.firstChild as Text
    cleanupGapParagraphs(el, caret)
    expect(el.querySelectorAll(':scope > p').length).toBe(0) // the empty gap p was reclaimed
  })
})

// The hr-adjacent gap (gap-nav.ts): its neighbours — a thematic break, front matter, a table —
// are outside isGapNeighbour's set, so the tag is what makes it self-cleaning.
describe('cleanupGapParagraphs — the tagged hr-adjacent gap paragraph', () => {
  const hrGapEditor = () =>
    editorWith(
      `<hr data-block="0"><p data-block="0" ${GAP}="">${ZWSP}</p><div data-block="0" data-type="code-block"><pre><code>x</code></pre></div>`,
    )

  it('reclaims it once the caret has left it still empty', () => {
    const el = hrGapEditor()
    cleanupGapParagraphs(el, el.querySelector('code')?.firstChild ?? null)
    expect(el.querySelectorAll(':scope > p').length).toBe(0)
  })

  it('keeps it while the caret is inside', () => {
    const el = hrGapEditor()
    const p = el.querySelector('p') as HTMLElement
    cleanupGapParagraphs(el, p.firstChild)
    expect(el.querySelectorAll(':scope > p').length).toBe(1)
  })

  it('keeps it once it holds typed text (it is real content now)', () => {
    const el = hrGapEditor()
    const p = el.querySelector('p') as HTMLElement
    p.textContent = 'between'
    cleanupGapParagraphs(el, el.querySelector('code')?.firstChild ?? null)
    expect(el.querySelector('p')?.textContent).toBe('between')
  })

  it('keeps the Enter-built blank-line chain that starts in it (task 486 rule wins)', () => {
    const el = editorWith(
      `<hr data-block="0"><p data-block="0" ${GAP}="">${ZWSP}</p><p data-block="0"></p><div data-block="0" data-type="code-block"><pre><code>x</code></pre></div>`,
    )
    const caret = el.querySelectorAll(':scope > p')[1] // the newest blank line holds the caret
    cleanupGapParagraphs(el, caret)
    expect(el.querySelectorAll(':scope > p').length).toBe(2)
  })
})

describe('observeGapParagraphs composition deferral', () => {
  it('keeps transient structure untouched until composition ends', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const el = editorWith(
      `<hr data-block="0"><p data-block="0" ${GAP}="">${ZWSP}</p><div data-block="0" data-type="code-block"><pre><code>after</code></pre></div>`,
    )
    const after = el.querySelector('code')?.firstChild as Text
    const range = document.createRange()
    range.setStart(after, 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    const disposeComposition = installCompositionState(document)
    const disposeObserver = observeGapParagraphs(() => el)

    try {
      document.dispatchEvent(new CompositionEvent('compositionstart'))
      document.dispatchEvent(new Event('selectionchange'))

      expect(el.querySelector(`[${GAP}]`)).not.toBeNull()

      document.dispatchEvent(new CompositionEvent('compositionend'))
      document.dispatchEvent(new Event('selectionchange'))

      expect(el.querySelector(`[${GAP}]`)).toBeNull()
    } finally {
      disposeObserver()
      disposeComposition()
      vi.unstubAllGlobals()
    }
  })
})

// Task 100: a `---` typed under another `---` stayed as literal `<p>--- </p>` source (the
// block-scoped re-spin never promotes the LAST one). We promote a lone thematic-break paragraph the
// caret has left to a real <hr>, and the trailing invariant then offers an escape line below it.
describe('isThematicBreakParagraph — recognising a lone rule marker', () => {
  const p = (html: string) => {
    const el = document.createElement('p')
    el.innerHTML = html
    return el
  }
  it('matches ---, ***, ___ and spaced variants (with trailing spaces / ZWSP)', () => {
    expect(isThematicBreakParagraph(p('---'))).toBe(true)
    expect(isThematicBreakParagraph(p('--- '))).toBe(true) // the live-IR `--- ` source
    expect(isThematicBreakParagraph(p('***'))).toBe(true)
    expect(isThematicBreakParagraph(p('___'))).toBe(true)
    expect(isThematicBreakParagraph(p('- - -'))).toBe(true)
    expect(isThematicBreakParagraph(p('----'))).toBe(true)
    expect(isThematicBreakParagraph(p(`${ZWSP}---${ZWSP}`))).toBe(true)
  })
  it('rejects non-rules, mid-edit, and non-paragraphs', () => {
    expect(isThematicBreakParagraph(p('--'))).toBe(false) // only two dashes
    expect(isThematicBreakParagraph(p('---foo'))).toBe(false) // has other text
    expect(isThematicBreakParagraph(p('-*-'))).toBe(false) // mixed markers
    expect(isThematicBreakParagraph(p('text'))).toBe(false)
    expect(isThematicBreakParagraph(p('---<wbr>'))).toBe(false) // mid-edit (element child)
    const hr = document.createElement('hr')
    expect(isThematicBreakParagraph(hr)).toBe(false) // already a rule, not a <p>
  })
})

describe('promoteThematicBreaks — render a left-behind `---` as an <hr>', () => {
  it('promotes a lone `--- ` paragraph the caret has left, leaving normal paragraphs alone', () => {
    const el = editorWith(
      '<p>before</p><p data-block="0">plain text</p><p data-block="0">--- </p>',
    )
    const before = el.querySelector('p:first-child')?.firstChild as Text
    expect(promoteThematicBreaks(el, before)).toBe(true)
    expect(el.querySelectorAll('hr').length).toBe(1) // only the rule promoted
    expect(el.querySelector('p:nth-child(2)')?.textContent).toBe('plain text') // normal p untouched
    expect((el.lastElementChild as HTMLElement).tagName).toBe('HR') // the `--- ` became the rule
  })

  it('promotes a rule with only a stale caret wbr after the caret leaves', () => {
    const el = editorWith('<p>before</p><p data-block="0">--- <wbr></p>')
    expect(promoteThematicBreaks(el, el.firstChild)).toBe(true)
    expect(el.querySelectorAll('hr')).toHaveLength(1)
  })

  it('does NOT promote the paragraph that holds the caret (still being edited)', () => {
    const el = editorWith('<p data-block="0">---</p>')
    const caret = el.querySelector('p')?.firstChild as Text
    expect(promoteThematicBreaks(el, caret)).toBe(false)
    expect(el.querySelectorAll('hr').length).toBe(0)
    expect(el.querySelector('p')?.textContent).toBe('---') // left as editable source
  })

  it('promoted <hr> then earns a trailing escape paragraph (integration)', () => {
    const el = editorWith('<p>x</p><p data-block="0">---</p>')
    promoteThematicBreaks(el, el.querySelector('p')?.firstChild ?? null)
    ensureTrailingParagraph(el, null)
    // the rule rendered, and there's a caret slot (trailing paragraph) below it
    expect(el.querySelector('hr')).not.toBeNull()
    const last = el.lastElementChild as HTMLElement
    expect(last.tagName).toBe('P')
    expect(last.hasAttribute(TRAILING)).toBe(true)
  })

  it('promotes every left-behind rule but keeps the focused one as source', () => {
    const el = editorWith(
      '<hr data-block="0"><p data-block="0">---</p><p data-block="0">---</p>',
    )
    const focused = el.querySelectorAll('p')[1]?.firstChild as Text // caret in the LAST one
    promoteThematicBreaks(el, focused)
    expect(el.querySelectorAll('hr').length).toBe(2) // original + the un-focused promotion
    expect(el.querySelectorAll('p').length).toBe(1) // the focused `---` stays editable
  })

  it('repairs an empty front-matter node spun from a rule after real content', () => {
    const el = editorWith(
      '<p data-block="0">before</p>' +
        '<div data-block="0" data-type="yaml-front-matter">' +
        '<span data-type="yaml-front-matter-open-marker">---</span>' +
        '<pre><code data-type="yaml-front-matter"></code></pre>' +
        '<span data-type="yaml-front-matter-close-marker">---</span></div>',
    )
    expect(promoteThematicBreaks(el, el.firstChild)).toBe(true)
    expect(el.querySelectorAll('hr')).toHaveLength(1)
  })

  it('keeps real leading front matter and non-empty YAML content intact', () => {
    const leading = editorWith(
      '<div data-block="0" data-type="yaml-front-matter"><pre><code data-type="yaml-front-matter"></code></pre></div>',
    )
    expect(promoteThematicBreaks(leading, null)).toBe(false)
    const nonempty = editorWith(
      '<p>before</p><div data-block="0" data-type="yaml-front-matter"><pre><code data-type="yaml-front-matter">key: value</code></pre></div>',
    )
    expect(promoteThematicBreaks(nonempty, null)).toBe(false)
  })
})

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-11): counted budgets on the probe fixture. The top-level passes iterate the
// root's children; none of them queries the root.
describe('gap paragraph budgets (Task 733, B-11)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  const FACTORS: Factor[] = [1, 4, 16]
  const frameCosts: number[] = []
  const cost = (counts: BudgetCounts) =>
    counts.nodesWalked + counts.queriedNodes
  const nodesIn = (node: Node): number => {
    let count = 1
    for (let child = node.firstChild; child; child = child.nextSibling)
      count += nodesIn(child)
    return count
  }

  describe.each(FACTORS)('at factor %i', (factor) => {
    const mount = () =>
      irFixture(tableHeavyMarkdown(factor), () => undefined).root

    it.each([
      [
        'promoteThematicBreaks',
        (ir: HTMLElement) => promoteThematicBreaks(ir, null),
      ],
      [
        'cleanupGapParagraphs',
        (ir: HTMLElement) => cleanupGapParagraphs(ir, null),
      ],
      ['ensureLeadingBlock', (ir: HTMLElement) => ensureLeadingBlock(ir)],
    ])(
      '%s makes no root query and visits the top level only',
      (_name, pass) => {
        const ir = mount()
        const { counts } = countBudget(ir, () => pass(ir))
        expect(counts.rootQueries).toBe(0)
        expect(cost(counts)).toBeLessThanOrEqual(ir.childElementCount + 8)
      },
    )

    it('the selection frame makes no root query', () => {
      const ir = mount()
      const frames: FrameRequestCallback[] = []
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
        frames.push(callback),
      )
      const dispose = observeGapParagraphs(() => ir)
      const caretBlock = Array.from(ir.children).find((block) =>
        block.textContent?.startsWith('Fourth paragraph'),
      ) as HTMLElement
      document.getSelection()!.collapse(caretBlock.firstChild!, 3)
      document.dispatchEvent(new Event('selectionchange'))
      // A case above may leave its own observer subscribed; its frame runs here too.
      expect(frames.length).toBeGreaterThan(0)
      const { counts } = countBudget(ir, () => {
        for (const frame of frames.splice(0)) frame(0)
      })
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(caretBlock) + ir.childElementCount,
      )
      frameCosts.push(cost(counts))
      document.getSelection()?.removeAllRanges()
      dispose()
      vi.unstubAllGlobals()
    })
  })

  it('costs the same at every factor', () => {
    expect(frameCosts).toHaveLength(FACTORS.length)
    expect(new Set(frameCosts).size).toBe(1)
  })
})

// ---- Task 733 / 013-T5: B-11 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `observeGapParagraphs` over a live feed of Lute's WYSIWYG root (the table-heavy fixture). B-11: a scoped change and a selection change
// query nothing on the root and at most the scope's nodes plus the top-level count.
describe('013 B-11 observeGapParagraphs on the WYSIWYG fixture', () => {
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
    stop = observeGapParagraphs(() => root)
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
    it('a selection change in a paragraph queries nothing on the root', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelectorAll(':scope > p')[2] as HTMLElement
      const range = document.createRange()
      range.setStart(paragraph.firstChild as Text, 2)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      await settleWysiwyg()
      const { counts } = countBudget(root, () => {
        document.dispatchEvent(new Event('selectionchange'))
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(counts.queriedNodes, 'queried nodes').toBeLessThanOrEqual(
        nodesOf([paragraph]) + root.children.length,
      )
    }, 60_000)
  })
})
