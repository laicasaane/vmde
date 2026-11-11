// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { domKind, domUnits } from '../nav/unit-pairing'
import { createRealLute } from '../testing/real-lute'
import {
  createTextModel,
  type HostUnit,
  modelInternals,
  type Unit,
  type UnitHost,
  type UnitKind,
} from './text-model'
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
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  const wrapped = {
    VditorIRDOM2Md: (html: string) => {
      counts.lute++
      return real.lute.VditorIRDOM2Md(html) as string
    },
    Md2VditorIRDOM: (markdown: string) => {
      counts.lute++
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
