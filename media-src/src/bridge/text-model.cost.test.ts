import { beforeAll, describe, expect, it } from 'vitest'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { installModelSync } from './model-structure'
import {
  createTextModel,
  type HostUnit,
  type TextModel,
  type Unit,
  type UnitHost,
} from './text-model'

// Cost of the edit paths (rule P5), counted and not timed: a document of one paragraph and a table
// of 5,000 rows by 5 columns. The adapter is made of plain objects, so the counts are the model's own.
interface El {
  id: string
  html: string
  canon: string
}

const ROWS = 5000
const COLUMNS = 5
const el = (id: string, text: string): El => ({
  id,
  html: `<x>${text}</x>`,
  canon: text,
})

interface World {
  model: TextModel<El>
  paragraph: El
  table: HostUnit<El>
  counts: { serialize: number; html: number; listUnits: number }
  listing: HostUnit<El>[]
}

function tableText(): string {
  const head = `| ${Array.from({ length: COLUMNS }, (_, c) => `h${c}`).join(' | ')} |`
  const delimiter = `| ${Array.from({ length: COLUMNS }, () => '-').join(' | ')} |`
  const body = Array.from(
    { length: ROWS },
    (_, r) =>
      `| ${Array.from({ length: COLUMNS }, (_, c) => `r${r}c${c}`).join(' | ')} |`,
  )
  return [head, delimiter, ...body].join('\n')
}

function world(paragraphFirst: boolean): World {
  const counts = { serialize: 0, html: 0, listUnits: 0 }
  const paragraph = el('para', 'para')
  const header = Array.from({ length: COLUMNS }, (_, c) => el(`h${c}`, `h${c}`))
  const body = Array.from({ length: ROWS }, (_, r) =>
    Array.from({ length: COLUMNS }, (_, c) => el(`r${r}c${c}`, `r${r}c${c}`)),
  )
  const table: HostUnit<El> = {
    kind: 'table',
    members: [el('table', 'table')],
    rows: [header, ...body],
    align: Array.from({ length: COLUMNS }, () => 'default' as const),
  }
  const para: HostUnit<El> = { kind: 'paragraph', members: [paragraph] }
  const listing = paragraphFirst ? [para, table] : [table, para]
  const host: UnitHost<El> = {
    listUnits: () => {
      counts.listUnits++
      return listing
    },
    html: (_kind, element) => {
      counts.html++
      return element.html
    },
    serialize: (_kind, members) => {
      counts.serialize++
      return members.map((m) => m.canon).join('')
    },
    roundTrip: (_kind, source) => source,
    serializeList: () => undefined,
  }
  const text = paragraphFirst
    ? `para\n\n${tableText()}\n`
    : `${tableText()}\n\npara\n`
  const model = createTextModel(host, scanMovableBlocks)
  model.build(text)
  expect(model.state, String(model.offReason)).toBe('live')
  return { model, paragraph, table, counts, listing }
}

function proveAll(model: TextModel<El>): void {
  const visit = (unit: Unit<El>): void => {
    model.prove(unit)
    for (const child of unit.children) visit(child)
  }
  for (const unit of model.units) visit(unit)
}

/** Everything about a unit except its position. */
const state = (unit: Unit<El>): unknown[] => [
  unit.proof,
  unit.html,
  unit.canon,
  unit.forms,
  unit.dirty,
  unit.explicit,
  unit.changedAt,
  unit.members,
]

function snapshot(model: TextModel<El>): Map<Unit<El>, unknown[]> {
  const out = new Map<Unit<El>, unknown[]>()
  const visit = (unit: Unit<El>): void => {
    out.set(unit, state(unit))
    for (const child of unit.children) visit(child)
  }
  for (const unit of model.units) visit(unit)
  return out
}

function starts(model: TextModel<El>): Map<Unit<El>, number> {
  const out = new Map<Unit<El>, number>()
  const visit = (unit: Unit<El>): void => {
    out.set(unit, unit.start)
    for (const child of unit.children) visit(child)
  }
  for (const unit of model.units) visit(unit)
  return out
}

function movedUnits(before: Map<Unit<El>, number>): number {
  let moved = 0
  for (const [unit, start] of before) if (unit.start !== start) moved++
  return moved
}

function changedUnits(before: Map<Unit<El>, unknown[]>): number {
  let changed = 0
  for (const [unit, old] of before) {
    const now = state(unit)
    if (now.some((value, k) => value !== old[k])) changed++
  }
  return changed
}

describe('cost of the edit paths on a 5,000 x 5 table', () => {
  beforeAll(() => installModelSync())

  it('a paragraph leaf sync serializes once and changes one unit, whichever side of the table it is on', () => {
    for (const paragraphFirst of [true, false]) {
      const w = world(paragraphFirst)
      proveAll(w.model)
      const paragraphUnit = w.model.units[paragraphFirst ? 0 : 1]
      const before = snapshot(w.model)
      const startsBefore = starts(w.model)
      w.paragraph.html = '<x>paraz</x>'
      w.paragraph.canon = 'paraz'
      w.model.markDirty(paragraphUnit)
      w.counts.serialize = 0
      w.counts.html = 0
      w.counts.listUnits = 0
      const result = w.model.sync()
      expect(result.kind).toBe('changes')
      expect(w.counts.serialize).toBe(1)
      // Before the table every later unit moves (numbers only); after it nothing starts elsewhere.
      const total = startsBefore.size
      expect(movedUnits(startsBefore)).toBe(paragraphFirst ? total - 1 : 0)
      expect(w.counts.html).toBe(1)
      expect(w.counts.listUnits).toBe(0)
      // Only the paragraph changes; the table behind it only moves.
      expect(changedUnits(before)).toBe(1)
      expect(w.model.text.slice(paragraphUnit.start, paragraphUnit.end)).toBe(
        'paraz',
      )
      const table = w.model.units[paragraphFirst ? 1 : 0]
      const lastRow = table.children[table.children.length - 1]
      expect(w.model.text.slice(lastRow.start, lastRow.end)).toBe(
        `| ${Array.from({ length: COLUMNS }, (_, c) => `r${ROWS - 1}c${c}`).join(' | ')} |`,
      )
      expect(lastRow.children[2].start).toBe(
        lastRow.start +
          w.model.text
            .slice(lastRow.start, lastRow.end)
            .indexOf(`r${ROWS - 1}c2`),
      )
    }
  })

  it('a row insert serializes the cells of the new row only and reuses every other row unit', () => {
    const w = world(true)
    proveAll(w.model)
    const table = w.model.units[1]
    const oldRows = [...table.children]
    const at = 2500
    const cells = Array.from({ length: COLUMNS }, (_, c) =>
      el(`new${c}`, `n${c}`),
    )
    ;(w.table.rows as El[][]).splice(at, 0, cells)
    w.model.markStructureDirty(table)
    w.counts.serialize = 0
    const result = w.model.sync()
    expect(result.kind).toBe('changes')
    expect(w.counts.serialize).toBe(COLUMNS)
    const rows = table.children
    expect(rows).toHaveLength(oldRows.length + 1)
    const reused = rows.filter((row) => oldRows.includes(row)).length
    expect(reused).toBe(oldRows.length)
    expect(w.model.text.slice(rows[at + 1].start, rows[at + 1].end)).toBe(
      '| n0 | n1 | n2 | n3 | n4 |',
    )
    const last = rows[rows.length - 1]
    expect(w.model.text.slice(last.start, last.end)).toBe(
      `| ${Array.from({ length: COLUMNS }, (_, c) => `r${ROWS - 1}c${c}`).join(' | ')} |`,
    )
    expect(w.model.units[1].end).toBe(last.end)
  })
})

describe('saved bytes of removed tables', () => {
  beforeAll(() => installModelSync())

  /** 33 small tables (2 to 34 lines) in one document; the adapter counts serialize calls. */
  function manyTables() {
    const counts = { serialize: 0 }
    const tables: HostUnit<El>[] = []
    const texts: string[] = []
    for (let t = 0; t < 33; t++) {
      const body = t + 1
      const rows = [[el(`t${t}h0`, 'h0'), el(`t${t}h1`, 'h1')]]
      for (let r = 0; r < body; r++)
        rows.push([el(`t${t}r${r}a`, `a${r}`), el(`t${t}r${r}b`, `b${r}`)])
      tables.push({
        kind: 'table',
        members: [el(`t${t}`, `t${t}`)],
        rows,
        align: ['default', 'default'],
      })
      texts.push(
        [
          '| h0 | h1 |',
          '| - | - |',
          ...rows.slice(1).map((_, r) => `| a${r} | b${r} |`),
        ].join('\n'),
      )
    }
    let listing = [...tables]
    const host: UnitHost<El> = {
      listUnits: () => listing,
      html: (_kind, element) => element.html,
      serialize: (_kind, members) => {
        counts.serialize++
        return members.map((m) => m.canon).join('')
      },
      roundTrip: (_kind, source) => source,
      serializeList: () => undefined,
    }
    const model = createTextModel(host, scanMovableBlocks)
    model.build(`${texts.join('\n\n')}\n`)
    expect(model.state, String(model.offReason)).toBe('live')
    for (const unit of model.units) model.prove(unit)
    return {
      model,
      tables,
      counts,
      setListing: (next: HostUnit<El>[]) => (listing = next),
    }
  }

  it('a paste serializes no removed table whose lines or columns differ', () => {
    const w = manyTables()
    // Remove 32 tables (the first 32), keep the last one.
    w.setListing([w.tables[32]])
    w.model.markStructureDirty('root')
    expect(w.model.sync().kind).toBe('changes')
    expect(w.model.units).toHaveLength(1)
    // Paste a table with 40 lines: none of the 32 removed tables has that many.
    const rows = [[el('nh0', 'h0'), el('nh1', 'h1')]]
    for (let r = 0; r < 39; r++)
      rows.push([el(`n${r}a`, `x${r}`), el(`n${r}b`, `y${r}`)])
    const pasted: HostUnit<El> = {
      kind: 'table',
      members: [el('pasted', 'pasted')],
      rows,
      align: ['default', 'default'],
    }
    w.setListing([w.tables[32], pasted])
    w.model.markStructureDirty('root')
    w.counts.serialize = 0
    expect(w.model.sync().kind).toBe('changes')
    expect(w.counts.serialize).toBe(1)
  })

  it('a paste serializes only the removed table with the same lines and columns', () => {
    const w = manyTables()
    w.setListing([w.tables[32]])
    w.model.markStructureDirty('root')
    w.model.sync()
    // A table with 4 lines and 2 columns: the removed table with 2 body rows has those; so has no other.
    const rows = [
      [el('nh0', 'h0'), el('nh1', 'h1')],
      [el('c0', 'q'), el('c1', 'r')],
      [el('c2', 's'), el('c3', 't')],
    ]
    const pasted: HostUnit<El> = {
      kind: 'table',
      members: [el('pasted', 'pasted')],
      rows,
      align: ['default', 'default'],
    }
    w.setListing([w.tables[32], pasted])
    w.model.markStructureDirty('root')
    w.counts.serialize = 0
    w.model.sync()
    expect(w.counts.serialize).toBe(2)
  })
})
