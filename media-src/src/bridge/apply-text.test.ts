// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import { applyChanges, type TextChange } from './change-set'
import { installModelSync } from './model-structure'
import {
  createTextModel,
  type ApplyPlan,
  type TextModel,
  type Unit,
} from './text-model'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import type { UnitHost } from './text-model'
import type { UnitLute } from './unit-lute'

// Task 733 / 010-T: planning and committing an apply (shared rules 3.7). Real Lute with the two
// production patches renders the IR DOM; the model and its DOM adapter are the real ones, so
// `planApply` runs against the as-built scanner and unit list.
let lute: UnitLute
beforeAll(() => {
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

type Model = TextModel<HTMLElement>
type U = Unit<HTMLElement>
interface Rig {
  root: HTMLElement
  dom: UnitHost<HTMLElement> & UnitDomControl
  model: Model
}

const attached: UnitDomControl[] = []
afterEach(() => {
  for (const dom of attached.splice(0)) dom.detach()
  document.body.replaceChildren()
})

function open(markdown: string): Rig {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  document.body.appendChild(root)
  const dom = createUnitDom(root, lute)
  const model = createTextModel(dom, scanMovableBlocks)
  model.build(markdown)
  expect(model.state, String(model.offReason)).toBe('live')
  dom.attach(model)
  attached.push(dom)
  return { root, dom, model }
}

/** The plan of `changes`, or a failure that names the fallback reason. */
function planOf(model: Model, changes: TextChange[]): ApplyPlan<HTMLElement> {
  const result = model.planApply(changes)
  if (result.kind !== 'plan') throw new Error(`fallback ${result.reason}`)
  return result.plan
}

function fallbackOf(model: Model, changes: TextChange[]): string | undefined {
  const result = model.planApply(changes)
  return result.kind === 'fallback' ? result.reason : undefined
}

const at = (text: string, needle: string): number => {
  const index = text.indexOf(needle)
  if (index < 0) throw new Error('fixture needle missing')
  return index
}

const replace = (text: string, needle: string, insert: string): TextChange => {
  const from = at(text, needle)
  return { from, to: from + needle.length, insert }
}

const bytes = (model: Model, unit: U): string =>
  model.text.slice(unit.start, unit.end)

/** Renders the plan's sources in place of its removed units and commits it. */
function commit(r: Rig, plan: ApplyPlan<HTMLElement>): void {
  // A same-shape table plan removes no unit: its rows are what the render replaces.
  const rows = plan.tableRows?.[0]
  const replaceEls = rows
    ? rows.rows.map(
        (r) => rows.table.children[r].members[0].parentElement as HTMLElement,
      )
    : plan.removed.flatMap((unit) => unit.members)
  const rendered = r.dom.render(plan.sources, replaceEls)
  if (!rendered) throw new Error('render returned undefined')
  r.dom.drain()
  r.model.commitApply(plan, rendered)
}

function tableDoc(rows: number): string {
  const lines = ['| A | B |', '| --- | --- |']
  for (let row = 1; row <= rows; row++) lines.push(`| a${row} | b${row} |`)
  return `before\n\n${lines.join('\n')}\n\nafter\n`
}

const THREE = 'alpha one\n\nbeta two\n\ngamma three\n'

describe('planApply: windows', () => {
  it('plans one removed unit and one source for a change inside one paragraph', () => {
    const r = open(THREE)
    const plan = planOf(r.model, [replace(THREE, 'two', 'TWO')])
    expect(plan.removed).toEqual([r.model.units[1]])
    expect(plan.sources).toEqual([{ kind: 'paragraph', source: 'beta TWO' }])
    expect(plan.tableRows).toBeUndefined()
    expect(plan.window.from).toBeLessThanOrEqual(r.model.units[1].start)
    expect(plan.window.to).toBeGreaterThanOrEqual(r.model.units[1].end)
  })

  it('plans both blocks for a change that spans two blocks', () => {
    const r = open(THREE)
    const from = at(THREE, 'one')
    const to = at(THREE, 'two') + 3
    const plan = planOf(r.model, [{ from, to, insert: 'ONE\n\nbeta TWO' }])
    expect(plan.removed).toEqual([r.model.units[0], r.model.units[1]])
    expect(plan.sources).toEqual([
      { kind: 'paragraph', source: 'alpha ONE' },
      { kind: 'paragraph', source: 'beta TWO' },
    ])
  })

  it('plans the previous paragraph too when a removed blank line joins it (lazy continuation)', () => {
    const r = open(THREE)
    const gap = at(THREE, '\n\nbeta')
    const plan = planOf(r.model, [{ from: gap, to: gap + 2, insert: '\n' }])
    expect(plan.removed).toEqual([r.model.units[0], r.model.units[1]])
    expect(plan.sources).toEqual([
      { kind: 'paragraph', source: 'alpha one\nbeta two' },
    ])
  })

  it('re-plans a paragraph as a heading when the line under it becomes a setext underline', () => {
    const r = open(THREE)
    const end = r.model.units[1].end
    const plan = planOf(r.model, [{ from: end, to: end, insert: '\n===' }])
    expect(plan.sources).toEqual([{ kind: 'heading', source: 'beta two\n===' }])
  })

  it('never plans front matter for a thematic break at a window start below a paragraph', () => {
    const doc = 'para\n\n---\n\nquote here\n'
    const r = open(doc)
    const plan = planOf(r.model, [replace(doc, 'here', 'HERE')])
    expect(plan.sources.map((source) => source.kind)).not.toContain(
      'front-matter',
    )
    expect(plan.sources).toEqual([{ kind: 'paragraph', source: 'quote HERE' }])
  })

  it('rescans the whole list run for a change inside item 3 of 5, and reuses the untouched items', () => {
    const doc = 'intro\n\n- one\n- two\n- three\n- four\n- five\n\noutro\n'
    const r = open(doc)
    const items = r.model.units.filter((unit) => unit.kind === 'list-item')
    expect(items).toHaveLength(5)
    const plan = planOf(r.model, [replace(doc, 'three', 'THREE')])
    expect(plan.window.from).toBeLessThanOrEqual(items[0].start)
    expect(plan.window.to).toBeGreaterThanOrEqual(items[4].end)
    expect(plan.removed).toEqual([items[2]])
    expect(plan.sources).toEqual([{ kind: 'list-item', source: '- THREE' }])
  })

  it('never puts the look-ahead unit in removed', () => {
    const r = open(THREE)
    const plan = planOf(r.model, [replace(THREE, 'one', 'ONE')])
    expect(plan.removed).not.toContain(r.model.units[1])
    expect(plan.removed).not.toContain(r.model.units[2])
  })

  it('plans a block move as the two moved paragraphs', () => {
    const r = open(THREE)
    const after = 'beta two\n\nalpha one\n\ngamma three\n'
    const changes: TextChange[] = [
      { from: 0, to: r.model.units[1].end, insert: 'beta two\n\nalpha one' },
    ]
    expect(applyChanges(THREE, changes)).toBe(after)
    const plan = planOf(r.model, changes)
    expect(plan.removed).toEqual([r.model.units[0], r.model.units[1]])
    expect(plan.sources).toEqual([
      { kind: 'paragraph', source: 'beta two' },
      { kind: 'paragraph', source: 'alpha one' },
    ])
  })
})

describe('planApply: same-shape tables', () => {
  it('plans tableRows with one row and no whole-table source for a cell change in a 300-row table', () => {
    const doc = tableDoc(300)
    const r = open(doc)
    const table = r.model.units.find((unit) => unit.kind === 'table') as U
    const plan = planOf(r.model, [replace(doc, 'b150 ', 'B150 ')])
    expect(plan.removed).toEqual([])
    expect(plan.tableRows).toEqual([{ table, rows: [151] }])
    expect(plan.sources).toHaveLength(1)
    expect(plan.sources[0].kind).toBe('table')
    // Header, delimiter and the changed row: never the 300 body rows.
    expect(plan.sources[0].source.split('\n')).toEqual([
      '| A | B |',
      '| --- | --- |',
      '| a150 | B150 |',
    ])
  })

  it('plans the whole table when a row is inserted', () => {
    const doc = tableDoc(3)
    const r = open(doc)
    const table = r.model.units.find((unit) => unit.kind === 'table') as U
    const end = at(doc, '| a3 | b3 |') + '| a3 | b3 |'.length
    const plan = planOf(r.model, [
      { from: end, to: end, insert: '\n| a4 | b4 |' },
    ])
    expect(plan.tableRows).toBeUndefined()
    expect(plan.removed).toEqual([table])
    expect(plan.sources).toHaveLength(1)
    expect(plan.sources[0].kind).toBe('table')
  })
})

describe('planApply: fallbacks', () => {
  it('falls back dependent-construct for a change that adds a reference definition', () => {
    const r = open(THREE)
    const end = THREE.length
    expect(
      fallbackOf(r.model, [
        { from: end, to: end, insert: '\n[ref]: https://example.com\n' },
      ]),
    ).toBe('dependent-construct')
  })

  it('falls back dependent-construct for a footnote definition and for a table of contents', () => {
    const r = open(THREE)
    const end = THREE.length
    expect(
      fallbackOf(r.model, [{ from: end, to: end, insert: '\n[^1]: note\n' }]),
    ).toBe('dependent-construct')
    expect(fallbackOf(r.model, [{ from: 0, to: 0, insert: '[toc]\n\n' }])).toBe(
      'dependent-construct',
    )
  })

  it('falls back too-many-changes above 256 changes', () => {
    const doc = `${'x '.repeat(300)}\n`
    const r = open(doc)
    const changes: TextChange[] = []
    for (let i = 0; i < 257; i++)
      changes.push({ from: i * 2, to: i * 2 + 1, insert: 'y' })
    expect(fallbackOf(r.model, changes)).toBe('too-many-changes')
    expect(fallbackOf(r.model, changes.slice(0, 256))).toBeUndefined()
  })

  it('falls back oversize-unit for a window source above 20 000 characters', () => {
    const r = open(THREE)
    const end = r.model.units[1].end
    expect(
      fallbackOf(r.model, [
        { from: end, to: end, insert: ` ${'w'.repeat(20_001)}` },
      ]),
    ).toBe('oversize-unit')
  })

  it('falls back model-off while the model is off', () => {
    const r = open(THREE)
    r.model.turnOff('mode')
    expect(fallbackOf(r.model, [replace(THREE, 'one', 'ONE')])).toBe(
      'model-off',
    )
  })
})

describe('commitApply', () => {
  it('sets the text to applyChanges(old, changes) and proves the new units', () => {
    const r = open(THREE)
    const changes = [replace(THREE, 'two', 'TWO')]
    const plan = planOf(r.model, changes)
    commit(r, plan)
    expect(r.model.text).toBe(applyChanges(THREE, changes))
    const fresh = r.model.units[1]
    expect(fresh.proof).toBe('proven')
    expect(bytes(r.model, fresh)).toBe('beta TWO')
    expect(fresh.el?.textContent).toContain('beta TWO')
  })

  it('keeps the element identity and bytes of untouched units', () => {
    const r = open(THREE)
    const [first, , last] = r.model.units
    const firstEl = first.el
    const lastEl = last.el
    const plan = planOf(r.model, [replace(THREE, 'two', 'a longer two')])
    commit(r, plan)
    expect(r.model.units[0]).toBe(first)
    expect(r.model.units[0].el).toBe(firstEl)
    expect(bytes(r.model, r.model.units[0])).toBe('alpha one')
    expect(r.model.units[2].el).toBe(lastEl)
    expect(bytes(r.model, r.model.units[2])).toBe('gamma three')
  })

  it('maps the new members to their units and forgets the removed ones', () => {
    const r = open(THREE)
    const old = r.model.units[1]
    const oldEl = old.el as HTMLElement
    const plan = planOf(r.model, [replace(THREE, 'two', 'TWO')])
    commit(r, plan)
    const fresh = r.model.units[1]
    expect(r.model.unitOf(fresh.el as HTMLElement)).toBe(fresh)
    expect(r.model.unitOf(oldEl)).toBeUndefined()
  })

  it('shifts the start lines of the units after the window by the line delta', () => {
    const r = open(THREE)
    const lastLine = r.model.units[2].startLine
    const plan = planOf(r.model, [
      replace(THREE, 'two', 'two\nand a third line'),
    ])
    commit(r, plan)
    expect(r.model.units[2].startLine).toBe(lastLine + 1)
  })

  it('leaves no dirty unit and no structure scope behind for its own DOM writes', () => {
    const r = open(THREE)
    const plan = planOf(r.model, [replace(THREE, 'two', 'TWO')])
    commit(r, plan)
    r.dom.drain()
    expect(r.model.hasDirty()).toBe(false)
    expect(r.model.sync()).toEqual({ kind: 'changes', changes: [] })
  })

  it('replaces only the changed row of a same-shape table and keeps the other rows', () => {
    const doc = tableDoc(5)
    const r = open(doc)
    const rowsBefore = Array.from(r.root.querySelectorAll('tbody > tr'))
    const plan = planOf(r.model, [replace(doc, 'b3 ', 'B3 ')])
    commit(r, plan)
    const rowsAfter = Array.from(r.root.querySelectorAll('tbody > tr'))
    expect(rowsAfter).toHaveLength(5)
    for (const index of [0, 1, 3, 4])
      expect(rowsAfter[index]).toBe(rowsBefore[index])
    expect(rowsAfter[2]).not.toBe(rowsBefore[2])
    expect(rowsAfter[2].textContent).toContain('B3')
    expect(r.model.text).toBe(doc.replace('b3 ', 'B3 '))
  })
})

describe('planApply: review repairs (010-R)', () => {
  it('F2: an opened fence in a large document falls back after a few scans', () => {
    const paragraphs: string[] = []
    for (let i = 0; i < 3000; i++) paragraphs.push(`paragraph number ${i}`)
    const doc = `${paragraphs.join('\n\n')}\n`
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-ir'
    root.innerHTML = lute.Md2VditorIRDOM(doc)
    document.body.appendChild(root)
    const dom = createUnitDom(root, lute)
    let scans = 0
    const model = createTextModel(dom, (markdown) => {
      scans++
      return scanMovableBlocks(markdown)
    })
    model.build(doc)
    expect(model.state).toBe('live')
    dom.attach(model)
    attached.push(dom)
    scans = 0
    const at = doc.indexOf('paragraph number 1\n')
    const result = model.planApply([{ from: at, to: at, insert: '```\n' }])
    expect(result.kind).toBe('fallback')
    expect(scans).toBeLessThanOrEqual(16)
  })

  it('F3: a loose list made tight by its gaps only falls back', () => {
    const doc = 'intro\n\n- a\n\n- b\n\n- c\n\noutro\n'
    const r = open(doc)
    const first = doc.indexOf('- a') + 3
    const second = doc.indexOf('- b') + 3
    expect(
      fallbackOf(r.model, [
        { from: first, to: first + 2, insert: '\n' },
        { from: second, to: second + 2, insert: '\n' },
      ]),
    ).toBe('window-without-kind')
  })

  it('F3: a blank line added inside one item of a tight list falls back', () => {
    const doc = 'intro\n\n- a\n- b\n- c\n\noutro\n'
    const r = open(doc)
    const end = doc.indexOf('- b') + 3
    expect(
      fallbackOf(r.model, [{ from: end, to: end, insert: '\n\n  more' }]),
    ).toBe('window-without-kind')
  })
})
