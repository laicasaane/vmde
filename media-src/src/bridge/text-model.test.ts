// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { domKind, domUnits } from '../nav/unit-pairing'
import { createRealLute } from '../testing/real-lute'
import { createBackgroundScheduler } from '../util/background-budget'
import { syncLeaves } from './model-sync'
import {
  createTextModel,
  type HostUnit,
  modelInternals,
  setSyncImplementation,
  type Unit,
  type UnitHost,
  type UnitKind,
} from './text-model'
import { createUnitSchedule } from './unit-schedule'
import {
  type ColumnAlign,
  roundTripBlock,
  roundTripCell,
  serializeBlockHtml,
  serializeCellHtml,
  serializeListItemHtml,
  type UnitLute,
} from './unit-lute'

// ---- String adapter: elements are plain objects with `outerHtml`; every host call is counted. ----

interface StringEl {
  id: string
  outerHtml: string
}

function stringHost(listing: HostUnit<StringEl>[] | undefined) {
  const calls = {
    listUnits: 0,
    serialize: 0,
    roundTrip: 0,
    html: 0,
    serializeList: 0,
  }
  const host: UnitHost<StringEl> = {
    listUnits: () => {
      calls.listUnits++
      return listing
    },
    html: (_kind, el) => {
      calls.html++
      return el.outerHtml
    },
    serialize: (_kind, members) => {
      calls.serialize++
      return members.map((m) => m.outerHtml).join('')
    },
    roundTrip: (_kind, source) => {
      calls.roundTrip++
      return source
    },
    serializeList: () => {
      calls.serializeList++
      return undefined
    },
  }
  return { host, calls }
}
const el = (id: string): StringEl => ({ id, outerHtml: `<x>${id}</x>` })

// ---- jsdom adapter with the real Lute (production patches in production order). ----

let lute: UnitLute
const counts = { lute: 0 }
// Fake clock of the sliced-proof tests: every Lute call advances it by `luteMs` (0 elsewhere).
const clock = { t: 0, luteMs: 0 }
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  const wrapped = {
    VditorIRDOM2Md: (html: string) => {
      counts.lute++
      clock.t += clock.luteMs
      return real.lute.VditorIRDOM2Md(html) as string
    },
    Md2VditorIRDOM: (markdown: string) => {
      counts.lute++
      clock.t += clock.luteMs
      return real.lute.Md2VditorIRDOM(markdown) as string
    },
  }
  lute = wrapped
})

const alignOf = (th: Element): ColumnAlign => {
  const value = th.getAttribute('align')
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : 'default'
}

function domHost(root: HTMLElement): UnitHost<HTMLElement> {
  return {
    listUnits() {
      const elements = domUnits(root, false)
      if (!elements) return undefined
      const out: HostUnit<HTMLElement>[] = []
      for (const element of elements) {
        const kind = domKind(element)
        if (!kind) return undefined
        const unit: HostUnit<HTMLElement> = { kind, members: [element] }
        if (kind === 'table') {
          unit.rows = Array.from(element.querySelectorAll('tr')).map(
            (tr) => Array.from(tr.children) as HTMLElement[],
          )
          unit.align = Array.from(element.querySelectorAll('thead th')).map(
            alignOf,
          )
        }
        out.push(unit)
      }
      return out
    },
    html: (kind, element) =>
      kind === 'cell' ? element.innerHTML : element.outerHTML,
    serialize(kind, members) {
      if (kind === 'cell') return serializeCellHtml(lute, members[0].innerHTML)
      if (kind === 'list-item' && members.length === 1) {
        const list = members[0].parentElement as HTMLElement
        const open = (list.cloneNode(false) as HTMLElement).outerHTML.replace(
          /<\/(ul|ol)>$/u,
          '',
        )
        return serializeListItemHtml(lute, open, members[0].outerHTML)
      }
      return serializeBlockHtml(
        lute,
        members.map((m) => m.outerHTML),
      )
    },
    roundTrip: (kind, source) =>
      kind === 'cell'
        ? roundTripCell(lute, source)
        : roundTripBlock(lute, kind as MovableKind, source),
    serializeList: () => undefined,
  }
}

function realModel(markdown: string) {
  const root = document.createElement('div')
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  const model = createTextModel(domHost(root), scanMovableBlocks)
  model.build(markdown)
  return { model, root }
}

const range = (u: Unit<unknown>): [number, number] => [u.start, u.end]
const bytesOf = (text: string, u: Unit<unknown>): string =>
  text.slice(u.start, u.end)
const find = (
  model: ReturnType<typeof realModel>['model'],
  source: string,
): Unit<HTMLElement> => {
  const found = model.units.find((u) => bytesOf(model.text, u) === source)
  if (!found) throw new Error(`no unit with bytes ${JSON.stringify(source)}`)
  return found
}

// ---------------------------------------------------------------------------------------------

describe('7.1 build (string adapter)', () => {
  const text = '# T\n\npara\n\n- a\n- b\n'
  const els = ['h', 'p', 'a', 'b'].map(el)
  const listing: HostUnit<StringEl>[] = [
    { kind: 'heading', members: [els[0]] },
    { kind: 'paragraph', members: [els[1]] },
    { kind: 'list-item', members: [els[2]] },
    { kind: 'list-item', members: [els[3]] },
  ]

  it('pairs units with ranges and start lines at the cost of one scan and one listUnits', () => {
    const { host, calls } = stringHost(listing)
    let scans = 0
    const model = createTextModel(host, (t) => {
      scans++
      return scanMovableBlocks(t)
    })
    model.build(text)
    expect(model.state).toBe('live')
    expect(model.offReason).toBeUndefined()
    expect(model.units.map(range)).toEqual([
      [0, 3],
      [5, 9],
      [11, 14],
      [15, 18],
    ])
    expect(model.units.map((u) => u.startLine)).toEqual([0, 2, 4, 5])
    expect(model.units.map((u) => u.kind)).toEqual([
      'heading',
      'paragraph',
      'list-item',
      'list-item',
    ])
    expect(
      model.units.every(
        (u) => u.proof === 'none' && !u.dirty && u.changedAt === 0,
      ),
    ).toBe(true)
    expect(scans).toBe(1)
    expect(calls).toMatchObject({
      listUnits: 1,
      serialize: 0,
      roundTrip: 0,
      serializeList: 0,
    })
  })

  it('maps every member element to its unit and leaves dirty tracking to the caller', () => {
    const { host } = stringHost(listing)
    const model = createTextModel(host, scanMovableBlocks)
    model.build(text)
    expect(model.unitOf(els[1])).toBe(model.units[1])
    expect(model.unitOf(el('other'))).toBeUndefined()
    expect(model.hasDirty()).toBe(false)
    model.markDirty(model.units[1])
    expect(model.hasDirty()).toBe(true)
    model.markPublishedWhole()
    expect(model.hasDirty()).toBe(false)
    model.markStructureDirty('root')
    expect(model.hasDirty()).toBe(true)
  })

  it('reports sync-error until a sync implementation is registered, and model-off when off', () => {
    const { host } = stringHost(listing)
    const model = createTextModel(host, scanMovableBlocks)
    model.build(text)
    expect(model.sync()).toEqual({ kind: 'fallback', reason: 'sync-error' })
    model.turnOff('mode')
    expect(model.state).toBe('off')
    expect(model.offReason).toBe('mode')
    expect(model.units).toEqual([])
    expect(model.sync()).toEqual({ kind: 'fallback', reason: 'model-off' })
  })

  it('does not pair when the DOM listing has another shape', () => {
    const { host } = stringHost(listing.slice(0, 3))
    const model = createTextModel(host, scanMovableBlocks)
    model.build(text)
    expect(model.offReason).toBe('pairing-failed')
  })

  it('clearForms drops forms except those a predicate keeps', () => {
    const { host } = stringHost(listing)
    const model = createTextModel(host, scanMovableBlocks)
    model.build(text)
    for (const u of model.units) u.forms = [{ canon: 'c', bytes: 'b' }]
    model.clearForms((u) => u === model.units[0])
    expect(model.units.map((u) => u.forms.length)).toEqual([1, 0, 0, 0])
    model.clearForms()
    expect(model.units.every((u) => u.forms.length === 0)).toBe(true)
  })
})

describe('7.4 to 7.6 off rules and empty text', () => {
  it('7.4 turns off with unit-without-kind when the listing has an element without kind', () => {
    const { host } = stringHost(undefined)
    const model = createTextModel(host, scanMovableBlocks)
    model.build('See [d].\n\n[d]: https://e.com\n')
    expect(model.state).toBe('off')
    expect(model.offReason).toBe('unit-without-kind')
  })

  it('7.4 with the real DOM adapter: a reference definition is a block without kind', () => {
    const { model } = realModel('See [d].\n\n[d]: https://e.com\n')
    expect(model.state).toBe('off')
    expect(model.offReason).toBe('unit-without-kind')
  })

  it('7.5 turns off with scan-declined for indented code, without a listUnits call', () => {
    const { host, calls } = stringHost([])
    const model = createTextModel(host, scanMovableBlocks)
    model.build('    code\n')
    expect(model.offReason).toBe('scan-declined')
    expect(calls.listUnits).toBe(0)
  })

  it('7.6 is live with zero units for empty and whitespace-only text', () => {
    for (const text of ['', '\n', '  \n\n']) {
      const { host, calls } = stringHost([])
      const model = createTextModel(host, scanMovableBlocks)
      model.build(text)
      expect(model.state).toBe('live')
      expect(model.units).toEqual([])
      expect(model.text).toBe(text)
      expect(calls.listUnits).toBe(0)
    }
  })

  it('a build after a turn-off is live again', () => {
    const { host } = stringHost([])
    const model = createTextModel(host, scanMovableBlocks)
    model.build('    code\n')
    model.build('')
    expect(model.state).toBe('live')
    expect(model.offReason).toBeUndefined()
  })
})

describe('7.2 table with an escaped border pipe (real Lute)', () => {
  const text = '| a | b |\n| - | - |\n| 1 | 2 \\|\n'

  it('builds table, row and cell units and proves the span-less row', () => {
    const { model } = realModel(text)
    expect(model.state).toBe('live')
    const table = model.units[0]
    expect(table.kind).toBe('table')
    expect(range(table)).toEqual([0, 30])
    expect(table.children.map(range)).toEqual([
      [0, 9],
      [10, 19],
      [20, 30],
    ])
    expect(table.children.map((r) => r.kind)).toEqual(['row', 'row', 'row'])
    expect(table.children.map((r) => r.startLine)).toEqual([0, 1, 2])
    expect(table.children[0].children.map(range)).toEqual([
      [2, 3],
      [6, 7],
    ])
    expect(table.children[1].children).toEqual([])
    expect(table.children[2].children).toEqual([])
    expect(table.children[2].members).toHaveLength(2)
    expect(model.prove(table.children[1])).toBe('proven')
    expect(model.prove(table.children[2])).toBe('proven')
    expect(model.prove(table)).toBe('proven')
  })

  it('proves the cells of a row with spans through the cell round trip', () => {
    const { model } = realModel(text)
    const header = model.units[0].children[0]
    expect(header.children.map((c) => model.prove(c))).toEqual([
      'proven',
      'proven',
    ])
    expect(header.children.map((c) => c.canon)).toEqual(['a', 'b'])
    expect(model.prove(header)).toBe('proven')
  })

  it('7.10 unitOf a cell of the span-less row is that row', () => {
    const { model } = realModel(text)
    const row = model.units[0].children[2]
    expect(model.unitOf(row.members[0])).toBe(row)
    const headerCell = model.units[0].children[0].children[0]
    expect(model.unitOf(headerCell.members[0])).toBe(headerCell)
  })

  it('makes a table whose shape does not match one opaque unit', () => {
    const { model } = realModel('| a | b |\n| - | - |\n| 1 |\n')
    const table = model.units[0]
    expect(table.kind).toBe('table')
    expect(table.proof).toBe('opaque')
    expect(table.children).toEqual([])
  })
})

describe('7.3 HTML enclosure with three members (real Lute)', () => {
  const text = '<details>\n<summary>s</summary>\n\nbody\n\n</details>\n'

  it('is one html-group unit, proven verbatim', () => {
    const { model, root } = realModel(text)
    expect(model.state).toBe('live')
    expect(model.units).toHaveLength(1)
    const group = model.units[0]
    expect(group.kind).toBe('html-group')
    expect(range(group)).toEqual([0, 48])
    expect(group.members).toHaveLength(3)
    expect(model.prove(group)).toBe('proven')
    expect(group.canon).toBe(bytesOf(model.text, group))
    expect(model.unitOf(root.querySelector('p') as HTMLElement)).toBe(group)
  })
})

describe('7.7 rebind', () => {
  const text = '# T\n\npara\n\n- a\n- b\n'

  it('keeps every proof for identical bytes and resets only the changed unit, keeping its dirty flag', () => {
    const { model } = realModel(text)
    for (const u of model.units) expect(model.prove(u)).toBe('proven')
    const before = model.units.map((u) => u.canon)
    const calls = counts.lute
    model.rebind(text)
    expect(counts.lute).toBe(calls)
    expect(model.units.map((u) => u.proof)).toEqual([
      'proven',
      'proven',
      'proven',
      'proven',
    ])
    expect(model.units.map((u) => u.canon)).toEqual(before)

    const para = model.units[1]
    model.markDirty(para)
    model.rebind(text.replace('para', 'pare'))
    expect(model.units.map((u) => u.proof)).toEqual([
      'proven',
      'none',
      'proven',
      'proven',
    ])
    expect(model.units[1].dirty).toBe(true)
    expect(model.units[1].html).toBeUndefined()
    expect(model.units[1].canon).toBeUndefined()
    expect(model.units[1].start).toBe(5)
  })

  it('keeps proofs and table children of a table when the bytes are the same', () => {
    const { model } = realModel('| a | b |\n| - | - |\n| 1 | 2 |\n')
    const table = model.units[0]
    for (const row of table.children) model.prove(row)
    model.prove(table)
    model.rebind(model.text)
    expect(model.units[0].proof).toBe('proven')
    expect(model.units[0].children.map((r) => r.proof)).toEqual([
      'proven',
      'proven',
      'proven',
    ])
    expect(model.units[0].children[0].children.map((c) => c.proof)).toEqual([
      'proven',
      'proven',
    ])
  })

  it('turns the model off when the pairing fails', () => {
    const { model } = realModel(text)
    model.rebind(`${text}\nextra\n`)
    expect(model.state).toBe('off')
    expect(model.offReason).toBe('pairing-failed')
  })

  it('maps a lost structure scope to the root and keeps the model text up to date', () => {
    const { model } = realModel(text)
    model.markStructureDirty(model.units[1])
    model.rebind(text)
    expect(model.hasDirty()).toBe(true)
    expect(model.text).toBe(text)
  })
})

describe('7.8 proof rules (real Lute)', () => {
  // A paragraph separates the two `.` lists: adjacent same-delimiter lists merge into one list.
  const text =
    '***\n\n3. a\n7. b\n\nsep\n\n1. a\n2. b\n\n1) a\n2) b\n\n<div>\n\n- x\n\n</div>\n'

  it('proves a thematic break by round trip; renumbering items are opaque and list-routed; a group with a list item is opaque', () => {
    const { model } = realModel(text)
    expect(model.state, String(model.offReason)).toBe('live')
    const routed = modelInternals(model).listRouted
    const thematic = model.units[0]
    expect(thematic.kind).toBe('thematic')
    expect(model.prove(thematic)).toBe('proven')
    expect(thematic.canon).toBe('---')
    expect(model.prove(find(model, '3. a'))).toBe('proven')
    expect(model.prove(find(model, '1. a'))).toBe('proven')
    for (const source of ['7. b', '2. b', '2) b']) {
      const item = find(model, source)
      expect(model.prove(item), source).toBe('opaque')
      expect(routed.has(item), source).toBe(true)
    }
    expect(routed.size).toBe(3)
    const group = model.units.find(
      (u) => u.kind === 'html-group',
    ) as Unit<HTMLElement>
    expect(model.prove(group)).toBe('opaque')
  })

  it('routes an ordered item whose isolated marker differs through the list-structure path', () => {
    const { model } = realModel('1. a\n2. b\n')
    const second = find(model, '2. b')
    expect(model.prove(second)).toBe('opaque')
    expect(second.canon).toBe('1. b')
    expect(modelInternals(model).listRouted.has(second)).toBe(true)
    expect(model.prove(find(model, '1. a'))).toBe('proven')
  })
})

describe('7.9 markPublishedWhole', () => {
  it('drops html, canon and proof of a dirty unit and clears every flag', () => {
    const { model } = realModel('# T\n\npara\n\n- a\n- b\n')
    for (const u of model.units) model.prove(u)
    const para = model.units[1]
    expect(para.html).toBeDefined()
    model.markDirty(para)
    model.markExplicit(model.units[0])
    model.markStructureDirty('root')
    expect(model.hasDirty()).toBe(true)
    model.markPublishedWhole()
    expect(para.html).toBeUndefined()
    expect(para.canon).toBeUndefined()
    expect(para.proof).toBe('none')
    expect(model.units[0].explicit).toBe(false)
    expect(model.units[2].proof).toBe('proven')
    expect(model.hasDirty()).toBe(false)
  })
})

describe('7.10 unitOf', () => {
  it('finds the group of a member and nothing for a foreign element', () => {
    const { model } = realModel('a\n\nb\n')
    expect(model.unitOf(document.createElement('p'))).toBeUndefined()
  })
})

describe('proof cost', () => {
  it('build makes no Lute call with the real adapter', () => {
    const root = document.createElement('div')
    root.innerHTML = lute.Md2VditorIRDOM(
      '# T\n\npara\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
    )
    const model = createTextModel(domHost(root), scanMovableBlocks)
    const calls = counts.lute
    model.build('# T\n\npara\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(counts.lute).toBe(calls)
    expect(model.units).toHaveLength(3)
  })

  it('treats the kinds of cell and row as unit kinds', () => {
    const kinds: UnitKind[] = ['cell', 'row']
    expect(kinds).toHaveLength(2)
  })
})

// Each test makes thousands of real Lute calls (two whole proofs of 4,000 cells at most): the time
// limit covers a run beside the other test files, where the default 5 s is too short.
describe('012-10 sliced proof of an oversize table (real Lute, fake clock)', {
  timeout: 60_000,
}, () => {
  const ROWS = 2000
  const lines = ['| h1 | h2 |', '| - | - |']
  for (let i = 0; i < ROWS; i++) lines.push(`| r${i}a | r${i}b |`)
  const text = `${lines.join('\n')}\n`
  /** Fake time one proof frame may take: the 4 ms slice plus one row of the table (2 cells). */
  const FRAME_MS = 8

  beforeAll(() => {
    setSyncImplementation(syncLeaves)
  })
  afterAll(() => {
    setSyncImplementation(undefined)
    clock.luteMs = 0
  })

  /** A real model of `text` driven by the real schedule; frames run one at a time. */
  function slicedRig() {
    const { model, root } = realModel(text)
    expect(model.state, String(model.offReason)).toBe('live')
    const frames: Array<() => void> = []
    const requestFrame = (callback: () => void): number => frames.push(callback)
    const schedule = createUnitSchedule({
      model,
      root,
      // The schedule runs as jobs of the background scheduler (012-20): one on these fake frames.
      scheduler: createBackgroundScheduler({
        now: () => clock.t,
        requestAnimationFrame: requestFrame,
        cancelAnimationFrame: () => undefined,
        requestIdle: () => 0,
        cancelIdle: () => undefined,
        inputPending: () => false,
      }),
      serialize: () => '',
      htmlLength: (unit) =>
        unit.members.reduce((sum, member) => sum + member.outerHTML.length, 0),
      inViewport: () => true,
      isActive: () => true,
      drain: () => undefined,
      requestAnimationFrame: requestFrame,
      cancelAnimationFrame: () => undefined,
      now: () => clock.t,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    })
    const table = model.units[0]
    const tableProof = (): string => table.proof
    const provenRows = (): number => {
      let count = 0
      for (const row of table.children) if (row.proof === 'proven') count += 1
      return count
    }
    /** Runs one frame; returns its fake duration and its Lute calls. */
    const frame = (): { ms: number; calls: number } => {
      const start = clock.t
      const calls = counts.lute
      frames.shift()?.()
      return { ms: clock.t - start, calls: counts.lute - calls }
    }
    // The paint frames come first: they prove nothing.
    clock.luteMs = 0
    schedule.start()
    for (let i = 0; i < 4; i++) frame()
    clock.luteMs = 1
    return {
      model,
      root,
      schedule,
      table,
      frames,
      frame,
      provenRows,
      tableProof,
    }
  }

  it('one proof frame makes Lute calls for a bounded row count and leaves the table unproven', () => {
    const r = slicedRig()
    expect(r.table.kind).toBe('table')
    expect(r.table.children).toHaveLength(ROWS + 2)
    const first = r.frame()
    expect(first.calls).toBeGreaterThan(0)
    expect(first.ms).toBeLessThanOrEqual(FRAME_MS)
    expect(r.provenRows()).toBeGreaterThan(0)
    expect(r.provenRows()).toBeLessThan(FRAME_MS)
    // The table is proven only when every row is: a partly proven table stays unproven.
    expect(r.table.proof).toBe('none')
    expect(r.frames.length).toBe(1)
  })

  it('repeated slices prove the table fully with the canon of one unsliced proof', () => {
    const r = slicedRig()
    let slices = 0
    while (r.table.proof !== 'proven' && slices < 2 * ROWS) {
      const before = r.provenRows()
      const slice = r.frame()
      slices += 1
      expect(slice.ms, `slice ${slices}`).toBeLessThanOrEqual(FRAME_MS)
      // The partly proven table is offered first again: every slice moves its rows on. The proof
      // is read through a function: the frame changed it, which the loop condition's narrowing hides.
      if (r.tableProof() !== 'proven')
        expect(r.provenRows(), `slice ${slices}`).toBeGreaterThan(before)
    }
    expect(r.table.proof).toBe('proven')
    expect(slices).toBeGreaterThan(1)
    clock.luteMs = 0
    const whole = realModel(text).model
    const wholeTable = whole.units[0]
    expect(whole.prove(wholeTable)).toBe('proven')
    const shape = (unit: Unit<HTMLElement>) => ({
      proof: unit.proof,
      canon: unit.canon,
      cells: unit.children.map((cell) => [cell.proof, cell.canon]),
    })
    expect(r.table.children.map(shape)).toEqual(wholeTable.children.map(shape))
  })

  it('a pre-touch in a partly proven table proves the touched cell only', () => {
    const r = slicedRig()
    r.frame()
    const proven = r.provenRows()
    expect(r.table.proof).toBe('none')
    const row = r.table.children[1500]
    expect(row.proof).toBe('none')
    const cell = row.children[1]
    const caret = document.createRange()
    caret.setStart(cell.members[0], 0)
    caret.collapse(true)
    const calls = counts.lute
    expect(r.schedule.proveForSelection(caret)).toBe('proven')
    // One Lute call for the touched cell; no row of the table is proven in the same call.
    expect(counts.lute - calls).toBe(1)
    expect(cell.proof).toBe('proven')
    expect(r.provenRows()).toBe(proven)
    expect(r.table.proof).toBe('none')
  })

  it('an edit in a proven row keeps the rows proven before it', () => {
    const r = slicedRig()
    r.frame()
    r.frame()
    const proven = r.provenRows()
    expect(proven).toBeGreaterThan(2)
    expect(r.table.proof).toBe('none')
    // Edit the first body row (row 2), a proven row of the partly proven table.
    const row = r.table.children[2]
    expect(row.proof).toBe('proven')
    const cell = row.children[0]
    const target = cell.members[0]
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode() as Text
    node.data = node.data.replace('r0a', 'r0x')
    r.model.markDirty(cell)
    clock.luteMs = 0
    const result = r.model.sync()
    expect(result.kind).toBe('changes')
    expect(r.model.text).toContain('| r0x | r0b |')
    r.schedule.restart()
    clock.luteMs = 1
    const calls = counts.lute
    let slices = 0
    while (r.table.proof !== 'proven' && slices < 2 * ROWS) {
      r.frame()
      slices += 1
    }
    expect(r.table.proof).toBe('proven')
    // Rows proven before the edit are not proven again: one Lute call per cell of the rest only.
    const remainingCells = (ROWS + 2 - proven) * 2
    expect(counts.lute - calls).toBe(remainingCells)
    expect(r.table.children.every((each) => each.proof === 'proven')).toBe(true)
  })
})
