// @vitest-environment jsdom
import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { minimalDiffWriteback } from '../../../src/markdown/minimal-diff-writeback'
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

// Property tests of the text model (Task 733 action 11, handoff 6.15): generated documents, random
// edits applied to the jsdom DOM of the real Lute render, then `sync()`. The seed is fixed; a
// failing property prints it with the counterexample (fast-check reports the shrunk input).
const RUN = { seed: 733003, numRuns: 200 }
// 200 runs with the real Lute take several seconds per property.
const TIMEOUT = 120_000

let lute: UnitLute
beforeAll(() => {
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

// ---- Adapter over the real Lute (same shape as the production adapter of task 004). ----

const alignOf = (th: Element): ColumnAlign => {
  const value = th.getAttribute('align')
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : 'default'
}
const shellOf = (list: HTMLElement): { open: string; close: string } => ({
  open: (list.cloneNode(false) as HTMLElement).outerHTML.replace(
    /<\/(ul|ol)>$/u,
    '',
  ),
  close: `</${list.tagName.toLowerCase()}>`,
})

function serializeList(items: readonly HTMLElement[]): string[] | undefined {
  const out: string[] = []
  for (let at = 0; at < items.length; ) {
    const list = items[at].parentElement as HTMLElement
    let end = at
    while (end < items.length && items[end].parentElement === list) end++
    const { open, close } = shellOf(list)
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
      if (kind === 'cell') return serializeCellHtml(lute, members[0].innerHTML)
      if (kind === 'list-item') {
        const { open, close } = shellOf(members[0].parentElement as HTMLElement)
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

// ---- Generators (handoff 6.15 item 2 and 3). ----

const word = fc.constantFrom('alpha', 'x1', '*em*', '`c`', '中文', '😀')
const words = fc
  .array(word, { minLength: 1, maxLength: 6 })
  .map((w) => w.join(' '))
const itemWords = fc.array(words, { minLength: 2, maxLength: 5 })
const tableCell = fc.oneof(words, fc.constant('`a|b`'))
const tableBlock = fc
  .tuple(fc.integer({ min: 2, max: 4 }), fc.integer({ min: 1, max: 4 }))
  .chain(([columns, rows]) =>
    fc.tuple(
      fc.array(tableCell, { minLength: columns, maxLength: columns }),
      fc.array(fc.constantFrom(':-', '-', '-:', ':-:'), {
        minLength: columns,
        maxLength: columns,
      }),
      fc.array(
        fc.array(tableCell, { minLength: columns, maxLength: columns }),
        { minLength: rows, maxLength: rows },
      ),
    ),
  )
  .map(([head, align, body]) =>
    [head, align, ...body]
      .map((cells) => `| ${cells.join(' | ')} |`)
      .join('\n'),
  )

interface GenBlock {
  text: string
  list: boolean
}
const block = (
  text: fc.Arbitrary<string>,
  list = false,
): fc.Arbitrary<GenBlock> => text.map((t) => ({ text: t, list }))
const blockArbitrary = (loose: boolean): fc.Arbitrary<GenBlock> =>
  fc.oneof(
    block(words),
    block(
      fc
        .tuple(fc.integer({ min: 1, max: 3 }), words)
        .map(([n, w]) => `${'#'.repeat(n)} ${w}`),
    ),
    block(words.map((w) => `> ${w}`)),
    block(words.map((w) => `\`\`\`\n${w}\n\`\`\``)),
    block(fc.constant('***')),
    block(
      itemWords.map((a) => a.map((w) => `- ${w}`).join('\n')),
      true,
    ),
    block(
      itemWords.map((a) => a.map((w) => `- ${w}`).join(loose ? '\n\n' : '\n')),
      true,
    ),
    block(
      fc
        .tuple(fc.integer({ min: 1, max: 9 }), itemWords)
        .map(([n, a]) => a.map((w, i) => `${n + i}. ${w}`).join('\n')),
      true,
    ),
    block(tableBlock),
  )

interface Doc {
  text: string
  separators: string[]
}
const MIXED = fc.constantFrom('\n\n', '\n\n\n', '\n\n\n\n')
// Reversal needs a blank line on the block's P side (PD-8): weighting keeps the skipped cases few.
const MOSTLY_BLANK = fc.oneof(
  { weight: 14, arbitrary: fc.constant('\n\n') },
  { weight: 1, arbitrary: MIXED },
)
const BLANK = fc.constant('\n\n')

/** Documents of 0 to 8 blocks; `loose` allows blank lines between list items, `separators` draws the separator between blocks. */
const docArbitrary = (
  loose: boolean,
  separators: fc.Arbitrary<string>,
  minBlocks = 0,
): fc.Arbitrary<Doc> =>
  fc
    .tuple(
      fc.array(blockArbitrary(loose), { minLength: minBlocks, maxLength: 8 }),
      fc.array(separators, {
        minLength: 16,
        maxLength: 16,
      }),
      fc.boolean(),
    )
    .map(([blocks, seps, finalNewline]) => {
      // Two adjacent lists would merge: a fixed paragraph keeps them apart.
      const spaced: string[] = []
      blocks.forEach((b, i) => {
        if (i > 0 && b.list && blocks[i - 1].list) spaced.push('sep')
        spaced.push(b.text)
      })
      const separators = spaced.slice(1).map((_, i) => seps[i])
      const joined = spaced
        .map((t, i) => (i === 0 ? t : separators[i - 1] + t))
        .join('')
      return {
        text:
          spaced.length === 0
            ? finalNewline
              ? '\n'
              : ''
            : joined + (finalNewline ? '\n' : ''),
        separators,
      }
    })

// ---- Session and edits. ----

type Model = TextModel<HTMLElement>
interface Session {
  model: Model
  root: HTMLElement
}
const trimEnd = (text: string): string => text.replace(/\n+$/u, '')
const canonOfMarkdown = (markdown: string): string =>
  trimEnd(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(markdown)))
const canonOfDom = (root: HTMLElement): string =>
  trimEnd(lute.VditorIRDOM2Md(root.innerHTML))

function openSession(doc: Doc): Session {
  const root = document.createElement('div')
  root.innerHTML = lute.Md2VditorIRDOM(doc.text)
  const model = createTextModel(domHost(root), scanMovableBlocks)
  model.build(doc.text)
  fc.pre(model.state === 'live')
  const prove = (unit: Unit<HTMLElement>): void => {
    model.prove(unit)
    for (const child of unit.children) prove(child)
  }
  for (const unit of model.units) prove(unit)
  return { model, root }
}

/** Units with content have the ranges and the start lines the scan finds in the model text. */
function expectUnitsMatchText(model: Model): void {
  const content = model.units.filter((u) => u.start < u.end)
  expect(content.map((u) => [u.start, u.end])).toEqual(
    scanMovableBlocks(model.text).map((b) => [b.start, b.end]),
  )
  let line = 0
  let offset = 0
  for (const unit of content) {
    line += model.text.slice(offset, unit.start).split('\n').length - 1
    offset = unit.start
    expect(unit.startLine, `line of ${unit.kind} at ${unit.start}`).toBe(line)
  }
}

function render(markdown: string): HTMLElement[] {
  const div = document.createElement('div')
  div.innerHTML = lute.Md2VditorIRDOM(markdown)
  return Array.from(div.children) as HTMLElement[]
}

/** Last text node of the element that is not a marker (heading hash, quote sign, fence). */
function contentText(el: HTMLElement): Text | undefined {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let found: Text | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (text.data.trim() === '') continue
    if ((text.parentElement as HTMLElement).closest('[class*="marker"]'))
      continue
    found = text
  }
  return found
}

const topOf = (session: Session, el: HTMLElement): HTMLElement => {
  let node: HTMLElement = el
  while (node.parentElement && node.parentElement !== session.root)
    node = node.parentElement
  return node
}

type EditKind =
  | 'text'
  | 'cell'
  | 'spin'
  | 'insert'
  | 'delete'
  | 'move'
  | 'rowInsert'
  | 'rowDelete'
  | 'itemInsert'
  | 'itemDelete'
const EDIT_KINDS: EditKind[] = [
  'text',
  'cell',
  'spin',
  'insert',
  'delete',
  'move',
  'rowInsert',
  'rowDelete',
  'itemInsert',
  'itemDelete',
]

interface Plan {
  kind: EditKind
  forward(): void
  backward(): void
  markForward(): void
  markBackward(): void
  /** Old unit indexes the edit touches, and the gap (index between two old units) it adds to. */
  touched: number[]
  gap?: number
  /** Reversal holds only when the stated byte rule allows it (PD-8, code-span pipes). */
  reversible: boolean
}

interface Snapshot {
  text: string
  ranges: Array<{ start: number; end: number }>
}
const snapshotOf = (model: Model): Snapshot => ({
  text: model.text,
  ranges: model.units.map((u) => ({ start: u.start, end: u.end })),
})

/** Allowed byte interval of an edit: from the end of the unit before its first touched unit to the start of the unit after its last (rule 6.3). */
function allowedInterval(snapshot: Snapshot, plan: Plan): [number, number] {
  const content = (index: number): boolean =>
    snapshot.ranges[index].start < snapshot.ranges[index].end
  const indexes = plan.touched.length > 0 ? plan.touched : []
  let lo = snapshot.text.length
  let hi = 0
  const widen = (from: number, to: number): void => {
    let before = from - 1
    while (before >= 0 && !content(before)) before--
    let after = to + 1
    while (after < snapshot.ranges.length && !content(after)) after++
    lo = Math.min(lo, before >= 0 ? snapshot.ranges[before].end : 0)
    hi = Math.max(
      hi,
      after < snapshot.ranges.length
        ? snapshot.ranges[after].start
        : snapshot.text.length,
    )
  }
  if (indexes.length > 0) widen(Math.min(...indexes), Math.max(...indexes))
  if (plan.gap !== undefined) widen(plan.gap - 1, plan.gap)
  return [lo, hi]
}

function unitIndexesOf(session: Session, top: HTMLElement): number[] {
  return session.model.units.flatMap((u, index) =>
    topOf(session, u.members[0]) === top ? [index] : [],
  )
}

const isList = (el: Element | undefined): boolean =>
  el?.tagName === 'UL' || el?.tagName === 'OL'
/** Two adjacent lists are not representable in Markdown (they merge): such a DOM is not a valid edit result. */
const adjacentLists = (tops: readonly (Element | undefined)[]): boolean =>
  tops.some((el, i) => i > 0 && isList(el) && isList(tops[i - 1]))

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one planner for the ten edit kinds of handoff 6.15 item 4
function planEdit(
  session: Session,
  kind: EditKind,
  pick: number,
): Plan | undefined {
  const { model, root } = session
  const units = model.units
  const tops = Array.from(root.children) as HTMLElement[]
  const choose = <T>(items: T[]): T | undefined =>
    items.length ? items[pick % items.length] : undefined
  const markDirty = (unit: Unit<HTMLElement>) => () => model.markDirty(unit)
  const rootDirty = () => model.markStructureDirty('root')

  if (kind === 'text' || kind === 'cell') {
    const leaves: Array<Unit<HTMLElement>> = []
    for (const unit of units) {
      if (
        kind === 'text' &&
        ['paragraph', 'heading', 'quote', 'list-item'].includes(unit.kind) &&
        unit.proof === 'proven'
      )
        leaves.push(unit)
      if (kind === 'cell')
        for (const row of unit.children)
          for (const cell of row.children)
            if (cell.proof === 'proven') leaves.push(cell)
    }
    const unit = choose(leaves.filter((u) => contentText(u.members[0])))
    const node = unit && contentText(unit.members[0])
    if (!unit || !node) return undefined
    const original = node.data
    const index =
      kind === 'text'
        ? [units.indexOf(unit)]
        : [
            units.findIndex((u) =>
              u.children.some((r) => r.children.includes(unit)),
            ),
          ]
    return {
      kind,
      forward: () => {
        node.data = `${original}z`
      },
      backward: () => {
        node.data = original
      },
      markForward: markDirty(unit),
      markBackward: markDirty(unit),
      touched: index,
      reversible: true,
    }
  }

  if (kind === 'spin') {
    const unit = choose(
      units.filter(
        (u) =>
          ['paragraph', 'heading'].includes(u.kind) && u.proof === 'proven',
      ),
    )
    if (!unit) return undefined
    const bytes = model.text.slice(unit.start, unit.end)
    const original = unit.members[0]
    let current = original
    const swap = (source: string): void => {
      const next = render(source)[0]
      current.replaceWith(next)
      current = next
    }
    return {
      kind,
      forward: () => swap(`${bytes} q`),
      backward: () => swap(bytes),
      markForward: rootDirty,
      markBackward: rootDirty,
      touched: [units.indexOf(unit)],
      reversible: true,
    }
  }

  if (kind === 'insert') {
    const position = pick % (tops.length + 1)
    const inserted = render('inserted q')[0]
    const gapUnit = tops[position]
      ? unitIndexesOf(session, tops[position])[0]
      : units.length
    return {
      kind,
      forward: () =>
        tops[position]
          ? tops[position].before(inserted)
          : root.append(inserted),
      backward: () => inserted.remove(),
      markForward: rootDirty,
      markBackward: rootDirty,
      touched: [],
      gap: gapUnit,
      reversible: true,
    }
  }

  if (kind === 'delete' || kind === 'move') {
    const top = choose(tops)
    if (!top) return undefined
    const index = tops.indexOf(top)
    const indexes = unitIndexesOf(session, top)
    const first = indexes[0]
    const last = indexes[indexes.length - 1]
    const text = model.text
    const before = [...Array(first).keys()]
      .reverse()
      .find((k) => units[k].start < units[k].end)
    const after = units.findIndex((u, k) => k > last && u.start < u.end)
    // PD-8: delete and move return the exact bytes only with a blank line on the block's P side.
    const pSide =
      before !== undefined
        ? text.slice(units[before].end, units[first].start) === '\n\n'
        : after >= 0
          ? text.slice(units[last].end, units[after].start) === '\n\n'
          : true
    if (kind === 'delete') {
      if (adjacentLists(tops.filter((t) => t !== top))) return undefined
      const next = top.nextElementSibling
      return {
        kind,
        forward: () => top.remove(),
        backward: () => (next ? next.before(top) : root.append(top)),
        markForward: rootDirty,
        markBackward: rootDirty,
        touched: indexes,
        // Q-12 (a) as well: a loose list that is deleted whole loses its blank-line separators.
        reversible:
          pSide &&
          !(
            isList(top) &&
            text.slice(units[first].start, units[last].end).includes('\n\n')
          ),
      }
    }
    if (tops.length < 2) return undefined
    const target = (index + 1 + (pick % (tops.length - 1))) % tops.length
    const original = top.nextElementSibling
    const destination = tops[target]
    const moved = tops.filter((t) => t !== top)
    moved.splice(moved.indexOf(destination) + (target > index ? 1 : 0), 0, top)
    if (adjacentLists(moved)) return undefined
    const destIndexes = unitIndexesOf(session, destination)
    return {
      kind,
      forward: () =>
        target > index ? destination.after(top) : destination.before(top),
      backward: () => (original ? original.before(top) : root.append(top)),
      markForward: rootDirty,
      markBackward: rootDirty,
      touched: [...indexes, ...destIndexes],
      reversible: pSide,
    }
  }

  if (kind === 'rowInsert' || kind === 'rowDelete') {
    const tables = units.filter(
      (u) => u.kind === 'table' && u.children.length > 0,
    )
    const table = choose(
      tables.filter((u) => kind === 'rowInsert' || u.children.length > 3),
    )
    if (!table) return undefined
    const rows = Array.from(
      table.members[0].querySelectorAll('tbody tr'),
    ) as HTMLElement[]
    const at = pick % rows.length
    const tableIndex = units.indexOf(table)
    if (kind === 'rowInsert') {
      const row = rows[at].cloneNode(true) as HTMLElement
      const cell = contentText(row.firstElementChild as HTMLElement)
      if (cell) cell.data = `${cell.data}q`
      return {
        kind,
        forward: () => rows[at].after(row),
        backward: () => row.remove(),
        markForward: () => model.markStructureDirty(table),
        markBackward: () => model.markStructureDirty(table),
        touched: [tableIndex],
        reversible: true,
      }
    }
    const row = rows[at]
    const next = row.nextElementSibling
    const sourceLine = model.text.slice(table.start, table.end).split('\n')[
      at + 2
    ]
    return {
      kind,
      forward: () => row.remove(),
      backward: () =>
        next
          ? next.before(row)
          : (
              row.parentElement ?? table.members[0].querySelector('tbody')
            )?.append(row),
      markForward: () => model.markStructureDirty(table),
      markBackward: () => model.markStructureDirty(table),
      touched: [tableIndex],
      // A re-added row is written from its cells' canons: a code-span pipe is written escaped.
      reversible: !sourceLine.includes('|`') && !sourceLine.includes('a|b'),
    }
  }

  // itemInsert, itemDelete
  const lists = tops.filter((t) => t.tagName === 'UL' || t.tagName === 'OL')
  const list = choose(
    lists.filter((l) => kind === 'itemInsert' || l.children.length > 1),
  )
  if (!list) return undefined
  const items = Array.from(list.children) as HTMLElement[]
  const at = pick % items.length
  const listUnits = unitIndexesOf(session, list)
  const scope = units[listUnits[0]]
  const first = /^(\d+)([.)])$/u.exec(
    items[0].getAttribute('data-marker') ?? '',
  )
  // An ordered list is numbered again after an edit, as its render would be.
  const renumber = (): void => {
    if (!first) return
    for (const [index, li] of (
      Array.from(list.children) as HTMLElement[]
    ).entries()) {
      li.setAttribute('data-marker', `${Number(first[1]) + index}${first[2]}`)
    }
  }
  const mark = (): void => model.markStructureDirty(scope)
  if (kind === 'itemInsert') {
    const item = items[at].cloneNode(true) as HTMLElement
    const text = contentText(item)
    if (text) text.data = `${text.data}q`
    return {
      kind,
      forward: () => {
        items[at].after(item)
        renumber()
      },
      backward: () => {
        item.remove()
        renumber()
      },
      markForward: mark,
      markBackward: mark,
      touched: listUnits,
      reversible: true,
    }
  }
  const item = items[at]
  const next = item.nextElementSibling
  return {
    kind,
    forward: () => {
      item.remove()
      renumber()
    },
    backward: () => {
      if (next) next.before(item)
      else list.append(item)
      renumber()
    },
    markForward: mark,
    markBackward: mark,
    touched: listUnits,
    // Q-12 (a): a loose list left with one item has no blank-line separator to copy when the
    // item comes back, so it is written tight (pinned by a unit test in model-structure.test.ts).
    reversible: !(
      items.length === 2 &&
      model.text
        .slice(
          units[listUnits[0]].start,
          units[listUnits[listUnits.length - 1]].end,
        )
        .includes('\n\n')
    ),
  }
}

interface Outcome {
  plan: Plan
  before: Snapshot
  changes: TextChange[]
  session: Session
}

function sync(model: Model): TextChange[] {
  const result = model.sync()
  if (result.kind !== 'changes') throw new Error(`fallback ${result.reason}`)
  return result.changes
}

/** Applies the planned edit and syncs; the plan falls back to an insert when the document has no target. */
function runEdit(doc: Doc, kind: EditKind, pick: number): Outcome {
  const session = openSession(doc)
  const plan =
    planEdit(session, kind, pick) ?? (planEdit(session, 'insert', pick) as Plan)
  const before = snapshotOf(session.model)
  plan.forward()
  plan.markForward()
  const changes = sync(session.model)
  return { plan, before, changes, session }
}

const editArbitrary = (
  loose: boolean,
  separators: fc.Arbitrary<string> = MIXED,
) =>
  fc.tuple(
    docArbitrary(loose, separators),
    fc.constantFrom(...EDIT_KINDS),
    fc.nat(1000),
  )
const editArb = editArbitrary(true)

describe('text model properties (seed 733003)', { timeout: TIMEOUT }, () => {
  it('rendering: the canon of the model text equals the canon of the DOM', () => {
    fc.assert(
      fc.property(editArb, ([doc, kind, pick]) => {
        const { session } = runEdit(doc, kind, pick)
        expect(canonOfMarkdown(session.model.text)).toBe(
          canonOfDom(session.root),
        )
      }),
      RUN,
    )
  })

  it('preservation: changes stay between the neighbours of the touched units and the units match the text', () => {
    fc.assert(
      fc.property(editArb, ([doc, kind, pick]) => {
        const { plan, before, changes, session } = runEdit(doc, kind, pick)
        expect(applyChanges(before.text, changes)).toBe(session.model.text)
        const [lo, hi] = allowedInterval(before, plan)
        for (const change of changes) {
          expect(
            change.from,
            `${plan.kind} change ${JSON.stringify(change)}`,
          ).toBeGreaterThanOrEqual(lo)
          expect(
            change.to,
            `${plan.kind} change ${JSON.stringify(change)}`,
          ).toBeLessThanOrEqual(hi)
        }
        expectUnitsMatchText(session.model)
      }),
      RUN,
    )
  })

  it('preservation: two leaf edits and the fill of an empty unit in one sync keep ranges, lines and rendering', () => {
    fc.assert(
      fc.property(
        fc.tuple(docArbitrary(true, MIXED), fc.nat(1000), fc.nat(1000)),
        ([doc, pickA, pickB]) => {
          const session = openSession(doc)
          const { model, root } = session
          const empty = render('x')[0]
          empty.innerHTML = ''
          root.append(empty)
          model.markStructureDirty('root')
          sync(model)
          const emptyUnit = model.units[model.units.length - 1]
          expect(emptyUnit.start).toBe(emptyUnit.end)
          const first = planEdit(session, 'text', pickA)
          const second =
            planEdit(session, 'cell', pickB) ??
            planEdit(session, 'text', pickB + 1)
          const before = model.text
          const plans = [first, second].filter(
            (p): p is Plan => p !== undefined,
          )
          const distinct = plans.filter(
            (p, k) =>
              plans.findIndex((q) => q.touched[0] === p.touched[0]) === k,
          )
          for (const plan of distinct) {
            plan.forward()
            plan.markForward()
          }
          empty.textContent = 'fill'
          model.markDirty(emptyUnit)
          const changes = sync(model)
          expect(applyChanges(before, changes)).toBe(model.text)
          expectUnitsMatchText(model)
          expect(canonOfMarkdown(model.text)).toBe(canonOfDom(root))
        },
      ),
      RUN,
    )
  })

  // Skipped cases (fc.pre) are counted: they must stay below 5% of the runs.
  const skips = { total: 0, skipped: 0 }
  const expectFewSkips = (): void => {
    expect(skips.skipped / skips.total).toBeLessThan(0.05)
    skips.total = 0
    skips.skipped = 0
  }
  const reversal = (loose: boolean) => () => {
    fc.assert(
      fc.property(editArbitrary(loose, MOSTLY_BLANK), ([doc, kind, pick]) => {
        const { plan, before, session } = runEdit(doc, kind, pick)
        skips.total++
        if (!plan.reversible) skips.skipped++
        fc.pre(plan.reversible)
        plan.backward()
        plan.markBackward()
        sync(session.model)
        expect(session.model.text, plan.kind).toBe(before.text)
      }),
      { ...RUN, maxSkipsPerRun: 20 },
    )
    expectFewSkips()
  }
  it(
    'reversal: an edit followed by its inverse returns the starting bytes (all but Q-12 (a))',
    reversal(true),
  )

  const agreement = (loose: boolean) => () => {
    fc.assert(
      fc.property(
        fc.tuple(
          // An in-unit edit needs a unit: the document has at least one block.
          docArbitrary(loose, BLANK, 1),
          fc.constantFrom<EditKind>('text', 'cell'),
          fc.nat(1000),
        ),
        ([doc, kind, pick]) => {
          skips.total++
          fc.pre(doc.text.length <= 100_000)
          const session = openSession(doc)
          const plan =
            planEdit(session, kind, pick) ??
            (planEdit(session, kind === 'text' ? 'cell' : 'text', pick) as
              | Plan
              | undefined)
          if (plan === undefined) skips.skipped++
          fc.pre(plan !== undefined)
          const edit = plan as Plan
          const original = session.model.text
          edit.forward()
          edit.markForward()
          sync(session.model)
          const next = lute.VditorIRDOM2Md(session.root.innerHTML)
          const expected = minimalDiffWriteback(original, next, (md) =>
            canonOfMarkdown(md),
          )
          expect(session.model.text).toBe(expected)
        },
      ),
      { ...RUN, maxSkipsPerRun: 50 },
    )
    expectFewSkips()
  }
  // Q-12 (b): the subset of rule 6.3 has tight lists; the model keeps the item bytes of a list with
  // blank lines between items, which the whole-text path writes tight.
  it(
    'agreement: an in-unit edit equals minimalDiffWriteback on the subset of rule 6.3 (tight lists)',
    agreement(false),
  )
})
