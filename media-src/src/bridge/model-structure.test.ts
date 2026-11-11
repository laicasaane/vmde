// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { domKind, domUnits } from '../nav/unit-pairing'
import { createRealLute } from '../testing/real-lute'
import { applyChanges, type TextChange } from './change-set'
import { installModelSync } from './model-structure'
import {
  createTextModel,
  type HostUnit,
  type TextModel,
  type Unit,
  type UnitHost,
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

// ---- Real Lute with the production patches, and a jsdom adapter over it. ----
let lute: UnitLute
const calls = { serialize: 0 }
beforeAll(() => {
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})
afterEach(() => {
  calls.serialize = 0
})

const alignOf = (th: Element): ColumnAlign => {
  const value = th.getAttribute('align')
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : 'default'
}

function listShell(list: HTMLElement): { open: string; close: string } {
  const open = (list.cloneNode(false) as HTMLElement).outerHTML.replace(
    /<\/(ul|ol)>$/u,
    '',
  )
  return { open, close: `</${list.tagName.toLowerCase()}>` }
}

/** Whole-list serialization split into item sources, once per parent list (OQ-1). */
function serializeList(items: readonly HTMLElement[]): string[] | undefined {
  const out: string[] = []
  for (let at = 0; at < items.length; ) {
    const list = items[at].parentElement as HTMLElement
    let end = at
    while (end < items.length && items[end].parentElement === list) end++
    const { open, close } = listShell(list)
    const markdown = lute.VditorIRDOM2Md(
      open +
        items
          .slice(at, end)
          .map((i) => i.outerHTML)
          .join('') +
        close,
    )
    const blocks = scanMovableBlocks(markdown)
    if (blocks.length !== end - at) return undefined
    for (const block of blocks) out.push(markdown.slice(block.start, block.end))
    at = end
  }
  return out
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
      calls.serialize++
      if (kind === 'cell') return serializeCellHtml(lute, members[0].innerHTML)
      if (kind === 'list-item') {
        const { open, close } = listShell(
          members[0].parentElement as HTMLElement,
        )
        return serializeListItemHtml(lute, open, members[0].outerHTML).replace(
          close,
          '',
        )
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
    serializeList,
  }
}

type Model = TextModel<HTMLElement>
interface Session {
  model: Model
  root: HTMLElement
}

function open(markdown: string): Session {
  const root = document.createElement('div')
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  const model = createTextModel(domHost(root), scanMovableBlocks)
  model.build(markdown)
  expect(model.state, String(model.offReason)).toBe('live')
  return { model, root }
}

function proveAll(model: Model): void {
  const visit = (unit: Unit<HTMLElement>): void => {
    model.prove(unit)
    for (const child of unit.children) visit(child)
  }
  for (const unit of model.units) visit(unit)
}

/** Elements of the render of `markdown` (a detached fragment's top-level blocks). */
function render(markdown: string): HTMLElement[] {
  const div = document.createElement('div')
  div.innerHTML = lute.Md2VditorIRDOM(markdown)
  return Array.from(div.children) as HTMLElement[]
}

function syncChanges(model: Model, sequence?: number): TextChange[] {
  const result = model.sync(sequence)
  if (result.kind !== 'changes') throw new Error(`fallback ${result.reason}`)
  return result.changes
}

/** Syncs and checks that the changes turn the text before into the text after. */
function syncChecked(model: Model): TextChange[] {
  const before = model.text
  const changes = syncChanges(model)
  expect(applyChanges(before, changes)).toBe(model.text)
  return changes
}

const unitAt = (model: Model, source: string): Unit<HTMLElement> => {
  const found = model.units.find(
    (u) => model.text.slice(u.start, u.end) === source,
  )
  if (!found) throw new Error(`no unit ${JSON.stringify(source)}`)
  return found
}
const trimEnd = (text: string): string => text.replace(/\n+$/u, '')
const canonOfMarkdown = (markdown: string): string =>
  trimEnd(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(markdown)))
const canonOfDom = (root: HTMLElement): string =>
  trimEnd(lute.VditorIRDOM2Md(root.innerHTML))

/** Empties the content text of an element (not its markers) and returns the node to type into. */
function emptyContent(el: HTMLElement): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let found: Text | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!(text.parentElement as HTMLElement).closest('[class*="marker"]'))
      found = text
  }
  if (!found) throw new Error('no content text')
  found.data = ''
  return found
}

const blockEl = (session: Session, index: number): HTMLElement =>
  session.root.children[index] as HTMLElement

/** Every unit's range holds exactly the bytes the scan finds for its block (the units are consistent with the text). */
function expectConsistent(model: Model): void {
  const blocks = scanMovableBlocks(model.text)
  const contentUnits = model.units.filter((u) => u.start < u.end)
  expect(contentUnits.map((u) => [u.start, u.end])).toEqual(
    blocks.map((b) => [b.start, b.end]),
  )
  let line = 0
  let offset = 0
  for (const unit of contentUnits) {
    line += model.text.slice(offset, unit.start).split('\n').length - 1
    offset = unit.start
    expect(unit.startLine, `line of ${unit.kind}`).toBe(line)
  }
}

describe('9 root window', () => {
  it('9.1 a block replaced by an element with equal HTML writes nothing and costs no serialization', () => {
    const session = open('a\n\npara\n')
    proveAll(session.model)
    const para = blockEl(session, 1)
    const clone = para.cloneNode(true) as HTMLElement
    para.replaceWith(clone)
    session.model.markStructureDirty('root')
    calls.serialize = 0
    expect(syncChanges(session.model)).toEqual([])
    expect(calls.serialize).toBe(0)
    expect(session.model.units[1].members).toEqual([clone])
    expect(session.model.text).toBe('a\n\npara\n')
  })

  it('9.2 inserting first adds the blank line after the new block', () => {
    const session = open('b\n')
    proveAll(session.model)
    session.root.prepend(...render('a'))
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 0, to: 0, insert: 'a\n\n' },
    ])
    expect(session.model.text).toBe('a\n\nb\n')
    expectConsistent(session.model)
  })

  it('9.3 inserting last adds the blank line before it, with and without a final newline', () => {
    for (const [text, expected] of [
      ['a\n', 'a\n\nb\n'],
      ['a', 'a\n\nb'],
    ]) {
      const session = open(text)
      proveAll(session.model)
      session.root.append(...render('b'))
      session.model.markStructureDirty('root')
      expect(syncChecked(session.model)).toEqual([
        { from: 1, to: 1, insert: '\n\nb' },
      ])
      expect(session.model.text).toBe(expected)
      expectConsistent(session.model)
    }
  })

  it('9.4 inserting between keeps the surrounding separator bytes', () => {
    const session = open('a\n\n\nc\n')
    proveAll(session.model)
    blockEl(session, 0).after(...render('b'))
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 1, to: 1, insert: '\n\nb' },
    ])
    expect(session.model.text).toBe('a\n\nb\n\n\nc\n')
    expectConsistent(session.model)
  })

  it('9.5 to 9.7 deleting removes one adjacent separator', () => {
    const cases: Array<[string, number, TextChange, string]> = [
      ['a\n\n\nb\n', 0, { from: 0, to: 4, insert: '' }, 'b\n'],
      ['a\n\nb\n', 1, { from: 1, to: 4, insert: '' }, 'a\n'],
      ['a\n\nb\n\n\nc\n', 1, { from: 1, to: 4, insert: '' }, 'a\n\n\nc\n'],
    ]
    for (const [text, index, change, expected] of cases) {
      const session = open(text)
      proveAll(session.model)
      blockEl(session, index).remove()
      session.model.markStructureDirty('root')
      expect(syncChecked(session.model), text).toEqual([change])
      expect(session.model.text).toBe(expected)
      expectConsistent(session.model)
    }
  })

  it('9.8 moving a block rewrites the window with blank-line joins', () => {
    const session = open('a\n\nb\n\nc\n')
    proveAll(session.model)
    session.root.append(blockEl(session, 0))
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 0, to: 7, insert: 'b\n\nc\n\na' },
    ])
    expect(session.model.text).toBe('b\n\nc\n\na\n')
    expectConsistent(session.model)
  })

  it('9.9 replacing two blocks by three writes one change', () => {
    const session = open('a\n\nb\n\nc\n')
    proveAll(session.model)
    const [x, y, z] = ['x', 'y', 'z'].map((t) => render(t)[0])
    blockEl(session, 0).replaceWith(x, y, z)
    blockEl(session, 3).remove()
    session.model.markStructureDirty('root')
    const changes = syncChecked(session.model)
    expect(changes).toHaveLength(1)
    expect(session.model.text).toBe('x\n\ny\n\nz\n\nc\n')
    expectConsistent(session.model)
  })

  it('9.10 a block cut and pasted gets its saved bytes back', () => {
    const session = open('# T #\n\nb\n')
    proveAll(session.model)
    const heading = blockEl(session, 0)
    heading.remove()
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([{ from: 0, to: 7, insert: '' }])
    expect(session.model.text).toBe('b\n')
    session.root.append(...render('# T'))
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 1, to: 1, insert: '\n\n# T #' },
    ])
    expect(session.model.text).toBe('b\n\n# T #\n')
    expectConsistent(session.model)
  })

  it('9.11 a block deleted and typed again into a new empty heading gets its saved bytes back', () => {
    const session = open('# T #\n\nb\n')
    proveAll(session.model)
    blockEl(session, 0).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    // The Enter key opens an empty heading; the typed text arrives with a later publication.
    const heading = render('# x')[0]
    const typed = emptyContent(heading)
    session.root.append(heading)
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    typed.data = 'T'
    session.model.markDirty(session.model.units[1])
    syncChecked(session.model)
    expect(session.model.text).toBe('b\n\n# T #\n')
    expectConsistent(session.model)
  })

  it('9.12 a new empty paragraph writes nothing until it has content', () => {
    const session = open('a\n')
    proveAll(session.model)
    const empty = render('x')[0]
    empty.innerHTML = ''
    session.root.append(empty)
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([])
    const unit = session.model.units[1]
    expect(unit.start).toBe(unit.end)
    expect(session.model.text).toBe('a\n')
    empty.textContent = 'c'
    session.model.markDirty(unit)
    expect(syncChecked(session.model)).toEqual([
      { from: 1, to: 1, insert: '\n\nc' },
    ])
    expect(session.model.text).toBe('a\n\nc\n')
  })

  it('9.13 an empty paragraph added, synced and removed writes nothing twice', () => {
    const session = open('a\n')
    proveAll(session.model)
    const empty = render('x')[0]
    empty.innerHTML = ''
    session.root.append(empty)
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([])
    empty.remove()
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([])
    expect(session.model.text).toBe('a\n')
    expect(session.model.units).toHaveLength(1)
  })

  it('9.14 an element without a kind falls back and turns the model off', () => {
    const session = open('a\n')
    proveAll(session.model)
    const refs = document.createElement('div')
    refs.setAttribute('data-block', '0')
    refs.setAttribute('data-type', 'link-ref-defs-block')
    session.root.append(refs)
    session.model.markStructureDirty('root')
    expect(session.model.sync()).toEqual({
      kind: 'fallback',
      reason: 'unit-without-kind',
    })
    expect(session.model.state).toBe('off')
    expect(session.model.offReason).toBe('unit-without-kind')
  })

  it('9.15 a table replaced by a new element changes only the edited cell span', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 |\n')
    proveAll(session.model)
    const next = render('| a | b |\n| - | - |\n| 1 | 2y |')[0]
    blockEl(session, 0).replaceWith(next)
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 27, to: 27, insert: 'y' },
    ])
    expect(session.model.text).toBe('| a | b |\n| - | - |\n| 1 | 2y |\n')
    expect(session.model.units[0].members).toEqual([next])
  })

  it('a failed publication leaves every unit as it was', () => {
    const session = open('a\n\nb\n')
    proveAll(session.model)
    const snapshot = session.model.units.map((u) => [
      u.start,
      u.end,
      u.proof,
      u.canon,
    ])
    const host = domHost(session.root)
    const failing = createTextModel(
      {
        ...host,
        serialize: () => {
          throw new Error('boom')
        },
      },
      scanMovableBlocks,
    )
    failing.build('a\n\nb\n')
    session.root.append(...render('c'))
    failing.markStructureDirty('root')
    expect(failing.sync()).toEqual({ kind: 'fallback', reason: 'sync-error' })
    expect(failing.text).toBe('a\n\nb\n')
    expect(failing.units).toHaveLength(2)
    expect(
      session.model.units.map((u) => [u.start, u.end, u.proof, u.canon]),
    ).toEqual(snapshot)
  })
})

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n'
const tableOf = (session: Session): HTMLElement => blockEl(session, 0)
const cellOf = (td: Element, text: string): HTMLElement => {
  const cell = td.ownerDocument.createElement(td.tagName.toLowerCase())
  cell.textContent = text
  return cell
}

describe('10 table structure', () => {
  it('10.1 and 10.2 a row added after a row, then removed', () => {
    const session = open(TABLE)
    proveAll(session.model)
    const table = tableOf(session)
    const next = render(
      '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |',
    )[0].querySelectorAll('tbody tr')[1]
    table.querySelector('tbody')?.append(next)
    session.model.markStructureDirty(session.model.units[0])
    expect(syncChecked(session.model)).toEqual([
      { from: 29, to: 29, insert: '\n| 3 | 4 |' },
    ])
    expect(session.model.text).toBe(
      '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n',
    )
    expectConsistent(session.model)
    table.querySelectorAll('tbody tr')[0].remove()
    session.model.markStructureDirty(session.model.units[0])
    expect(syncChecked(session.model)).toEqual([
      { from: 19, to: 29, insert: '' },
    ])
    expect(session.model.text).toBe('| a | b |\n| - | - |\n| 3 | 4 |\n')
    expectConsistent(session.model)
  })

  it('a moved row keeps its bytes', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n')
    proveAll(session.model)
    const rows = tableOf(session).querySelectorAll('tbody tr')
    rows[0].before(rows[1])
    session.model.markStructureDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe(
      '| a | b |\n| - | - |\n| 3 | 4 |\n| 1 | 2 |\n',
    )
    expectConsistent(session.model)
  })

  it('10.3 and 10.5 an empty column appended, then removed', () => {
    const session = open(TABLE)
    proveAll(session.model)
    const table = tableOf(session)
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      row.append(cellOf(row.lastElementChild as Element, ''))
    }
    session.model.markStructureDirty(session.model.units[0])
    const changes = syncChecked(session.model)
    expect(changes).toHaveLength(3)
    expect(session.model.text).toBe(
      '| a | b |  |\n| - | - | - |\n| 1 | 2 |  |\n',
    )
    expectConsistent(session.model)
    for (const row of Array.from(table.querySelectorAll('tr')))
      row.lastElementChild?.remove()
    session.model.markStructureDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe(TABLE)
  })

  it('10.4 an alignment change rewrites only the delimiter row', () => {
    const session = open(TABLE)
    proveAll(session.model)
    tableOf(session).querySelector('th')?.setAttribute('align', 'center')
    session.model.markStructureDirty(session.model.units[0])
    const changes = syncChecked(session.model)
    expect(changes).toHaveLength(1)
    expect(session.model.text).toBe('| a | b |\n| :-: | - |\n| 1 | 2 |\n')
  })

  it('10.6 a table whose shape does not match is one opaque unit and falls back on an edit', () => {
    const session = open('| a | b |\n| - | - |\n| 1 |\n')
    expect(session.model.units[0].proof).toBe('opaque')
    session.model.markDirty(session.model.units[0])
    expect(session.model.sync()).toEqual({
      kind: 'fallback',
      reason: 'unproven-unit',
    })
  })
})

describe('10 list structure', () => {
  const item = (source: string): HTMLElement =>
    render(source)[0].firstElementChild as HTMLElement

  it('10.7 a new item after a keeps the other bytes', () => {
    const session = open('- a\n- b\n')
    proveAll(session.model)
    const list = blockEl(session, 0)
    list.children[0].after(item('- c'))
    session.model.markStructureDirty(session.model.units[0])
    expect(syncChecked(session.model)).toEqual([
      { from: 6, to: 6, insert: 'c\n- ' },
    ])
    expect(session.model.text).toBe('- a\n- c\n- b\n')
    expectConsistent(session.model)
  })

  it('10.8 a new item in a loose list takes the blank-line separator', () => {
    const session = open('- a\n\n- b\n')
    proveAll(session.model)
    blockEl(session, 0).children[0].after(item('- c'))
    session.model.markStructureDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe('- a\n\n- c\n\n- b\n')
    expectConsistent(session.model)
  })

  it('10.9 a removed item', () => {
    const session = open('- a\n- b\n- c\n')
    proveAll(session.model)
    blockEl(session, 0).children[1].remove()
    session.model.markStructureDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe('- a\n- c\n')
    expectConsistent(session.model)
  })

  it('10.10 an indented item moves into its neighbour', () => {
    const session = open('- a\n- b\n')
    proveAll(session.model)
    const list = blockEl(session, 0)
    const [a, b] = Array.from(list.children) as HTMLElement[]
    const nested = document.createElement('ul')
    nested.append(b)
    a.append(nested)
    session.model.markStructureDirty(session.model.units[0])
    session.model.markDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe('- a\n  - b\n')
  })

  // The real Lute writes the first item with the list marker and the others with their own
  // data-marker, which is also what the whole-text path writes: `1. b\n3. c`.
  it('10.11 removing the first item of an ordered list writes the real Lute numbering', () => {
    const session = open('1. a\n2. b\n3. c\n')
    proveAll(session.model)
    blockEl(session, 0).children[0].remove()
    session.model.markStructureDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe('1. b\n3. c\n')
    expectConsistent(session.model)
  })

  it('10.12 a tight list re-rendered as loose keeps its bytes', () => {
    const session = open('- a\n- b\n')
    proveAll(session.model)
    blockEl(session, 0).replaceWith(...render('- a\n\n- b'))
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([])
    expect(session.model.text).toBe('- a\n- b\n')
  })

  it('8.13 an item that gains a blank line goes through the list path', () => {
    const session = open('- a\n- b\n')
    proveAll(session.model)
    const target = render('- a\n\n  more\n- b')[0]
      .firstElementChild as HTMLElement
    const first = blockEl(session, 0).firstElementChild as HTMLElement
    first.innerHTML = target.innerHTML
    session.model.markDirty(session.model.units[0])
    syncChecked(session.model)
    expect(session.model.text).toBe('- a\n\n  more\n- b\n')
    expect(session.model.hasDirty()).toBe(false)
  })

  it('8.14 an edit of a list-routed ordered item goes through the list path', () => {
    const session = open('1. a\n2. b\n')
    const second = unitAt(session.model, '2. b')
    session.model.prove(second)
    const walker = document.createTreeWalker(session.root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data === 'b') (node as Text).data = 'bx'
    }
    session.model.markDirty(second)
    expect(syncChecked(session.model)).toEqual([
      { from: 9, to: 9, insert: 'x' },
    ])
    expect(session.model.text).toBe('1. a\n2. bx\n')
  })
})

describe('003 review repairs', () => {
  const emptyParagraph = (): HTMLElement => {
    const p = render('x')[0]
    p.innerHTML = ''
    return p
  }

  it('B1 two empty paragraphs filled in one sync get their own ranges', () => {
    const session = open('a\n')
    proveAll(session.model)
    const [first, second] = [emptyParagraph(), emptyParagraph()]
    session.root.append(first, second)
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([])
    const [, u1, u2] = session.model.units
    first.textContent = 'b'
    second.textContent = 'c'
    session.model.markDirty(u1)
    session.model.markDirty(u2)
    syncChecked(session.model)
    expect(session.model.text).toBe('a\n\nb\n\nc\n')
    expect(
      session.model.units.map((u) => [u.start, u.end, u.startLine]),
    ).toEqual([
      [0, 1, 0],
      [3, 4, 2],
      [6, 7, 4],
    ])
    expectConsistent(session.model)
  })

  it('B1 a paragraph edited and the empty paragraph below filled in one sync, then edited again', () => {
    const session = open('a\n')
    proveAll(session.model)
    const empty = emptyParagraph()
    session.root.append(empty)
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    const [u0, u1] = session.model.units
    blockEl(session, 0).textContent = 'ax'
    empty.textContent = 'b'
    session.model.markDirty(u0)
    session.model.markDirty(u1)
    syncChecked(session.model)
    expect(session.model.text).toBe('ax\n\nb\n')
    expectConsistent(session.model)
    empty.textContent = 'bz'
    session.model.markDirty(u1)
    syncChecked(session.model)
    expect(session.model.text).toBe('ax\n\nbz\n')
    expectConsistent(session.model)
  })

  it('B2 a table replaced by one that only differs in alignment writes the delimiter row', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 |\n')
    proveAll(session.model)
    blockEl(session, 0).replaceWith(
      render('| a | b |\n| :-: | - |\n| 1 | 2 |')[0],
    )
    session.model.markStructureDirty('root')
    expect(syncChecked(session.model)).toEqual([
      { from: 12, to: 13, insert: ':-:' },
    ])
    expect(session.model.text).toBe('| a | b |\n| :-: | - |\n| 1 | 2 |\n')
    expect(canonOfMarkdown(session.model.text)).toBe(canonOfDom(session.root))
    expectConsistent(session.model)
  })

  const TABLE_TEXT = '| aaa | b |\n| - | - |\n| 1 | 2 |\n'

  it('M1 deleting a table serializes nothing; pasting it back restores its bytes', () => {
    const session = open(`p\n\n${TABLE_TEXT}\nq\n`)
    proveAll(session.model)
    calls.serialize = 0
    blockEl(session, 1).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    expect(calls.serialize).toBe(0)
    expect(session.model.text).toBe('p\n\nq\n')
    blockEl(session, 0).after(render(TABLE_TEXT)[0])
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    expect(session.model.text).toBe(`p\n\n${TABLE_TEXT}\nq\n`)
    expectConsistent(session.model)
  })

  it('M1 the bytes of a table that was never proven are not reused', () => {
    const session = open(`p\n\n${TABLE_TEXT}`)
    blockEl(session, 1).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    blockEl(session, 0).after(render(TABLE_TEXT)[0])
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    expect(session.model.text).not.toBe(`p\n\n${TABLE_TEXT}`)
    expect(session.model.text).toContain('| --- |')
  })

  it('M1 the bytes of an opaque unit are never reused', () => {
    const session = open('# T #\n\nb\n')
    proveAll(session.model)
    session.model.units[0].proof = 'opaque'
    blockEl(session, 0).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    session.root.append(...render('# T'))
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    expect(session.model.text).toBe('b\n\n# T\n')
  })

  it('N1 a throwing adapter leaves the model unchanged when a row has to be rewritten', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 |\n')
    proveAll(session.model)
    const host = domHost(session.root)
    const cells = Array.from(
      session.root.querySelectorAll('tbody td'),
    ) as HTMLElement[]
    let armed = false
    const throwing = createTextModel(
      {
        ...host,
        // The second cell serializes to text with an unescaped pipe: the splice check fails and the row is rewritten.
        serialize: (kind, members) =>
          armed && kind === 'cell' && members[0] === cells[1]
            ? 'x | y'
            : host.serialize(kind, members),
        html: (kind, el) => {
          if (armed && kind === 'cell' && el === cells[0])
            throw new Error('html failed')
          return host.html(kind, el)
        },
      },
      scanMovableBlocks,
    )
    throwing.build('| a | b |\n| - | - |\n| 1 | 2 |\n')
    proveAll(throwing)
    const snapshot = throwing.units[0].children.map((r) => [
      r.start,
      r.end,
      r.children.length,
      r.dirty,
    ])
    cells[1].textContent = '2z'
    throwing.markDirty(throwing.units[0].children[2].children[1])
    armed = true
    expect(throwing.sync()).toEqual({ kind: 'fallback', reason: 'sync-error' })
    expect(throwing.text).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n')
    expect(
      throwing.units[0].children.map((r) => [
        r.start,
        r.end,
        r.children.length,
        r.dirty,
      ]),
    ).toEqual(snapshot.map(([a, b, c, d], k) => [a, b, c, k === 2 ? d : d]))
  })

  it('N2 the changed-at sequence follows the bytes: moved units keep it, new and rewritten units take it', () => {
    const session = open('- a\n- b\n')
    proveAll(session.model)
    const list = blockEl(session, 0)
    list.children[0].after(render('- c')[0].firstElementChild as HTMLElement)
    session.model.markStructureDirty(session.model.units[0])
    syncChanges(session.model, 9)
    expect(session.model.text).toBe('- a\n- c\n- b\n')
    expect(session.model.units.map((u) => u.changedAt)).toEqual([0, 9, 0])
  })

  it('N3 installModelSync is idempotent', () => {
    installModelSync()
    installModelSync()
    const session = open('a\n\npara\n')
    proveAll(session.model)
    const walker = document.createTreeWalker(session.root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node as Text).data === 'para') (node as Text).data = 'parax'
    }
    session.model.markDirty(session.model.units[1])
    expect(syncChanges(session.model)).toEqual([
      { from: 7, to: 7, insert: 'x' },
    ])
  })

  // Q-12 (a): pins today's bytes. A loose list left with one item, or deleted whole, comes back tight.
  it('Q-12 (a) a loose list that is deleted whole or left with one item comes back tight', () => {
    const left = open('- alpha\n\n- alpha\n')
    proveAll(left.model)
    const list = blockEl(left, 0)
    const [first] = Array.from(list.children) as HTMLElement[]
    first.remove()
    left.model.markStructureDirty(left.model.units[0])
    syncChecked(left.model)
    list.prepend(first)
    left.model.markStructureDirty(left.model.units[0])
    syncChecked(left.model)
    expect(left.model.text).toBe('- alpha\n- alpha\n')

    const whole = open('- alpha\n\n- alpha\n')
    proveAll(whole.model)
    const gone = blockEl(whole, 0)
    gone.remove()
    whole.model.markStructureDirty('root')
    syncChecked(whole.model)
    whole.root.append(gone)
    whole.model.markStructureDirty('root')
    syncChecked(whole.model)
    expect(whole.model.text).toBe('- alpha\n- alpha\n')
  })

  it('Q-14 an owner-less saved entry is taken once per sync (structure path)', () => {
    const session = open('# T #\n\nb\n')
    proveAll(session.model)
    blockEl(session, 0).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    session.root.append(...render('# T'), ...render('# T'))
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    expect(session.model.text).toBe('b\n\n# T #\n\n# T\n')
    expectConsistent(session.model)
  })

  it('Q-14 an owner-less saved entry is taken once per sync (leaf path)', () => {
    const session = open('# T #\n\nb\n')
    proveAll(session.model)
    blockEl(session, 0).remove()
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    const headings = [render('# x')[0], render('# x')[0]]
    const typed = headings.map((h) => emptyContent(h))
    session.root.append(...headings)
    session.model.markStructureDirty('root')
    syncChecked(session.model)
    for (const node of typed) node.data = 'T'
    session.model.markDirty(session.model.units[1])
    session.model.markDirty(session.model.units[2])
    syncChecked(session.model)
    expect(session.model.text).toBe('b\n\n# T #\n\n# T\n')
    expectConsistent(session.model)
  })
})
