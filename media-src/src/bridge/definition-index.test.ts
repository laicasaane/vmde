// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import {
  costClock,
  countBudget,
  fakeLanes,
  type Factor,
} from '../testing/budget-harness'
import { createRealLute } from '../testing/real-lute'
import type { LiveUnit, UnitsChange } from '../util/unit-changes'

// Task 733 / 017-T1 (task 017 sections 6.3, 6.7, 6.8): the definition index and its two background
// jobs, on fake units and the cost clock. Fails before 017-I1 on the missing modules
// `B/definition-index.ts` and `U/background-budget.ts` (012-19-I); both are loaded at run time so the
// file fails by assertion. B-D1: a label change re-renders its dependents in frame slices; B-D2:
// `contextFor` costs only the source and the referenced definitions, at every factor.

const INDEX_MODULE = './definition-index'
const BUDGET_MODULE = '../util/background-budget'

interface DefinitionContext {
  readonly html: string
  readonly blocks: number
}
interface FootnoteInfo {
  readonly number: number
  readonly tooltip: string
}
interface DefinitionIndex {
  contextFor(source: string): DefinitionContext | undefined
  footnoteOf(label: string): FootnoteInfo | undefined
  onUnitsChange(change: UnitsChange): void
  dispose(): void
}
interface IndexDeps {
  units(): readonly LiveUnit[] | undefined
  bytesOf(el: HTMLElement): string | undefined
  /** Task 733 / 021: the kind of the live unit whose element is `el`. */
  kindOf(el: HTMLElement): LiveUnit['kind'] | undefined
  rerender(el: HTMLElement, context: DefinitionContext | undefined): boolean
  setFootnoteTooltip(el: HTMLElement, label: string, tooltip: string): void
  scheduler: unknown
}
interface Modules {
  createDefinitionIndex(deps: IndexDeps): DefinitionIndex
  createBackgroundScheduler(deps: ReturnType<typeof fakeLanes>): unknown
}

let modules: Modules | undefined
beforeAll(async () => {
  try {
    const index = await import(/* @vite-ignore */ INDEX_MODULE)
    const budget = await import(/* @vite-ignore */ BUDGET_MODULE)
    modules = {
      createDefinitionIndex: index.createDefinitionIndex,
      createBackgroundScheduler: budget.createBackgroundScheduler,
    }
  } catch {
    modules = undefined
  }
})

const loaded = (): Modules => {
  expect(
    modules,
    'B/definition-index.ts (017-I1) and U/background-budget.ts (012-19-I) exist',
  ).toBeDefined()
  return modules as Modules
}

const real = createRealLute('ir')

/** Kind of a rendered top-level element, as the listing of 017-I1 names it. */
function kindOf(el: HTMLElement): LiveUnit['kind'] {
  const type = el.getAttribute('data-type')
  if (type === 'link-ref-defs-block') return 'definition' as LiveUnit['kind']
  if (type === 'toc-block') return 'toc' as LiveUnit['kind']
  return /^H[1-6]$/u.test(el.tagName) ? 'heading' : 'paragraph'
}

interface Rig {
  root: HTMLElement
  units: LiveUnit[]
  bytes: Map<HTMLElement, string>
  rerendered: HTMLElement[]
  contexts: Array<DefinitionContext | undefined>
  skip: Set<HTMLElement>
  tooltips: Array<[string, string]>
  /** Task 733 / 021: calls of `units()` so far. */
  unitCalls: { count: number }
  clock: ReturnType<typeof costClock>
  lanes: ReturnType<typeof fakeLanes>
  index: DefinitionIndex
}

/**
 * Top-level blocks from `sources` (one Markdown block each, rendered together so references resolve)
 * as live units; footnote definitions become one `footnote` unit per `footnotes-def` child.
 */
function rig(sources: readonly string[]): Rig {
  const { createDefinitionIndex, createBackgroundScheduler } = loaded()
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.innerHTML = real.render(sources.join('\n\n'))
  document.body.append(root)
  const units: LiveUnit[] = []
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.getAttribute('data-type') === 'footnotes-block') {
      for (const def of Array.from(child.children) as HTMLElement[])
        units.push({
          el: def,
          members: [def],
          kind: 'footnote' as LiveUnit['kind'],
          top: child,
        })
    } else
      units.push({
        el: child,
        members: [child],
        kind: kindOf(child),
        top: child,
      })
  }
  expect(units).toHaveLength(sources.length)
  const bytes = new Map(units.map((unit, i) => [unit.el, sources[i]]))
  const clock = costClock()
  const lanes = fakeLanes(clock)
  const rerendered: HTMLElement[] = []
  const contexts: Array<DefinitionContext | undefined> = []
  const skip = new Set<HTMLElement>()
  const tooltips: Array<[string, string]> = []
  const unitCalls = { count: 0 }
  const index = createDefinitionIndex({
    units: () => {
      unitCalls.count++
      return units
    },
    bytesOf: (el) => bytes.get(el),
    kindOf: (el) => units.find((unit) => unit.el === el)?.kind,
    rerender(el, context) {
      // One render costs one Lute call on the cost clock (the default charge).
      clock.advance(0.5)
      rerendered.push(el)
      contexts.push(context)
      return !skip.has(el)
    },
    setFootnoteTooltip: (_el, label, tooltip) => {
      tooltips.push([label, tooltip])
    },
    scheduler: createBackgroundScheduler(lanes),
  })
  return {
    root,
    units,
    bytes,
    rerendered,
    contexts,
    skip,
    tooltips,
    unitCalls,
    clock,
    lanes,
    index,
  }
}

const changeOf = (unit: LiveUnit): UnitsChange => ({
  cause: 'mutation',
  whole: false,
  changed: [unit],
  structural: [],
})

/** Runs idle callbacks (8 ms each) until no idle work is left, at most `limit` times. */
function drainIdle(r: Rig, limit = 1000): void {
  for (let i = 0; i < limit; i++) r.lanes.runIdle(8)
}

describe('B-D1: dependents of a label change', () => {
  const REFERRERS = 500
  const sources = [
    ...Array.from(
      { length: REFERRERS },
      (_, i) => `Paragraph ${i} cites [ref].`,
    ),
    'An unrelated paragraph.',
    '[ref]: https://example.com/ref',
  ]

  it('re-renders every referencing unit once, in frame slices of at most 4 + 2 ms', () => {
    const r = rig(sources)
    drainIdle(r)
    const definition = r.units.at(-1) as LiveUnit
    r.bytes.set(definition.el, '[renamed]: https://example.com/ref')
    r.index.onUnitsChange(changeOf(definition))
    let maxSlice = 0
    for (
      let frame = 0;
      frame < 2000 && r.rerendered.length < REFERRERS;
      frame++
    ) {
      const start = r.clock.now()
      r.lanes.runFrame()
      maxSlice = Math.max(maxSlice, r.clock.now() - start)
    }
    expect(new Set(r.rerendered).size).toBe(REFERRERS)
    expect(r.rerendered).toHaveLength(REFERRERS)
    expect(r.rerendered).not.toContain(r.units[REFERRERS].el)
    expect(maxSlice).toBeLessThanOrEqual(6)
    // The label is no longer defined, so no dependent gets a context.
    expect(r.contexts.every((context) => context === undefined)).toBe(true)
  })

  it('a unit edited during the job is skipped and the job goes on', () => {
    const r = rig(sources)
    drainIdle(r)
    r.skip.add(r.units[3].el)
    const definition = r.units.at(-1) as LiveUnit
    r.bytes.set(definition.el, '[renamed]: https://example.com/ref')
    r.index.onUnitsChange(changeOf(definition))
    for (let frame = 0; frame < 2000; frame++) r.lanes.runFrame()
    expect(r.rerendered.filter((el) => el === r.units[3].el)).toHaveLength(1)
    expect(new Set(r.rerendered).size).toBe(REFERRERS)
  })

  it('a change that keeps the label set re-renders nothing', () => {
    const r = rig(sources)
    drainIdle(r)
    const definition = r.units.at(-1) as LiveUnit
    r.bytes.set(definition.el, '[ref]: https://example.com/other')
    r.index.onUnitsChange(changeOf(definition))
    for (let frame = 0; frame < 50; frame++) r.lanes.runFrame()
    expect(r.rerendered).toEqual([])
  })
})

describe('footnotes (section 6.3)', () => {
  const sources = [
    'Text cites [^a] and [^b].',
    '[^b]: The second note.',
    '[^a]: The first note.',
  ]

  it('numbers footnotes by definition order and answers their tooltip', () => {
    const r = rig(sources)
    drainIdle(r)
    expect(r.index.footnoteOf('b')).toEqual({
      number: 1,
      tooltip: 'The second note.',
    })
    expect(r.index.footnoteOf('a')?.number).toBe(2)
    expect(r.index.footnoteOf('missing')).toBeUndefined()
  })

  it('a footnote text change writes the tooltip of its references and re-renders nothing', () => {
    const r = rig(sources)
    drainIdle(r)
    const note = r.units[2]
    r.bytes.set(note.el, '[^a]: The first note, edited.')
    r.index.onUnitsChange(changeOf(note))
    for (let frame = 0; frame < 50; frame++) r.lanes.runFrame()
    expect(r.tooltips).toEqual([['a', 'The first note, edited.']])
    expect(r.rerendered).toEqual([])
  })
})

describe.each<Factor>([1, 4, 16])('B-D2: contextFor at factor %i', (factor) => {
  const sources = [
    ...Array.from({ length: 100 * factor }, (_, i) => `Filler paragraph ${i}.`),
    ...Array.from(
      { length: 10 * factor },
      (_, i) => `[unused${i}]: https://example.com/${i}`,
    ),
    '[ref]: https://example.com/ref',
    '[^n]: A note.',
  ]

  it('holds only the referenced definitions and costs the same at every size', () => {
    const r = rig(sources)
    drainIdle(r)
    const { result, counts } = countBudget(r.root, () =>
      r.index.contextFor('See [x][ref] and a note[^n].'),
    )
    expect(result?.blocks).toBe(2)
    expect(result?.html).toContain('[ref]: https://example.com/ref')
    expect(result?.html).toContain('A note.')
    expect(result?.html).not.toContain('unused')
    expect(counts.rootQueries).toBe(0)
    // Bounded by the source and the two referenced definitions, independent of the factor.
    expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(16)
    expect(r.index.contextFor('Plain text.')).toBeUndefined()
  })
})

// Task 733 / 021 (design 021 sections 3.1 and 7.1): a `whole` change (a gap click, a build, a rebind, a
// fallback publication) and a structural change (a restore replacing an element) keep the index and the
// rendering of references current. Fails before 021-I: `rebuild` queues nothing and `structural` is ignored.
describe('021: whole and structural changes (D-1, D-2, D-3b)', () => {
  const GUIDE = '[guide]: https://example.com/guide'
  const GUIDEX = '[guidex]: https://example.com/guide'
  const WHOLE: UnitsChange = {
    cause: 'sync',
    whole: true,
    changed: [],
    structural: [],
    scopes: [],
  }

  const runFrames = (r: Rig, frames = 50): void => {
    for (let frame = 0; frame < frames; frame++) r.lanes.runFrame()
  }

  /** Replaces the unit at `at` by a freshly rendered element of `source` (the old one leaves the root). */
  const replaceUnit = (r: Rig, at: number, source: string): HTMLElement => {
    const old = r.units[at]
    const template = document.createElement('template')
    template.innerHTML = real.render(source)
    const next = template.content.firstElementChild as HTMLElement
    old.el.replaceWith(next)
    r.units[at] = { el: next, members: [next], kind: old.kind, top: next }
    r.bytes.delete(old.el)
    r.bytes.set(next, source)
    return next
  }

  const structuralOf = (next: HTMLElement): UnitsChange => ({
    cause: 'sync',
    whole: false,
    changed: [],
    structural: [next],
    scopes: [next],
  })

  it('a whole change after a label rename re-renders the referencing unit', () => {
    const r = rig(['See [the guide][guide].', GUIDE])
    drainIdle(r)
    r.bytes.set(r.units[1].el, GUIDEX)
    r.index.onUnitsChange(WHOLE)
    drainIdle(r)
    runFrames(r)
    expect(r.rerendered).toEqual([r.units[0].el])
  })

  it('a whole change after a footnote text change writes the tooltip of its references', () => {
    const r = rig(['A note[^n].', '[^n]: Old text.'])
    drainIdle(r)
    r.bytes.set(r.units[1].el, '[^n]: New text.')
    r.index.onUnitsChange(WHOLE)
    drainIdle(r)
    runFrames(r)
    expect(r.tooltips).toEqual([['n', 'New text.']])
    expect(r.rerendered).toEqual([])
  })

  it('a replaced definition element in scopes re-renders the references of both labels', () => {
    const r = rig(['See [the guide][guide].', GUIDE])
    drainIdle(r)
    const next = replaceUnit(r, 1, GUIDEX)
    r.index.onUnitsChange(structuralOf(next))
    runFrames(r)
    expect(r.rerendered).toEqual([r.units[0].el])
    expect(r.index.contextFor('[a][guidex]')?.html).toContain(next.outerHTML)
    expect(r.index.contextFor('[a][guide]')).toBeUndefined()
  })

  it('a replaced referencing paragraph in scopes is indexed', () => {
    const r = rig(['See [the guide][guide].', GUIDE])
    drainIdle(r)
    const next = replaceUnit(r, 0, 'See [the guide][guide].')
    r.index.onUnitsChange(structuralOf(next))
    runFrames(r)
    r.bytes.set(r.units[1].el, GUIDEX)
    r.index.onUnitsChange(changeOf(r.units[1]))
    runFrames(r)
    expect(r.rerendered).toEqual([next])
  })

  it('a structural change with no definition in its scopes reads no unit list (guard)', () => {
    const r = rig(['See [the guide][guide].', GUIDE, 'Tail.'])
    drainIdle(r)
    const template = document.createElement('template')
    template.innerHTML = real.render('A new paragraph.')
    const next = template.content.firstElementChild as HTMLElement
    r.units[2].el.after(next)
    r.units.push({ el: next, members: [next], kind: 'paragraph', top: next })
    r.bytes.set(next, 'A new paragraph.')
    const before = r.unitCalls.count
    r.index.onUnitsChange(structuralOf(next))
    expect(r.unitCalls.count - before).toBe(0)
  })
})
