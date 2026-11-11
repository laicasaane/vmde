// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { applyChanges, type TextChange } from './change-set'
import { setStructureSync, syncLeaves } from './model-sync'
import { domKind, domUnits } from '../nav/unit-pairing'
import { createRealLute } from '../testing/real-lute'
import {
  createTextModel,
  setSyncImplementation,
  type HostUnit,
  type TextModel,
  type Unit,
  type UnitHost,
} from './text-model'
import {
  roundTripBlock,
  roundTripCell,
  serializeBlockHtml,
  serializeCellHtml,
  serializeListItemHtml,
  type UnitLute,
} from './unit-lute'

// ---- Real Lute with the production patches, and a jsdom adapter over it. ----
let lute: UnitLute
beforeAll(() => {
  setSyncImplementation(syncLeaves)
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})
afterEach(() => setStructureSync(undefined))

function domHost(root: HTMLElement): UnitHost<HTMLElement> {
  return {
    listUnits() {
      const out: HostUnit<HTMLElement>[] = []
      for (const element of domUnits(root, false) ?? []) {
        const kind = domKind(element) as MovableKind
        const unit: HostUnit<HTMLElement> = { kind, members: [element] }
        if (kind === 'table') {
          unit.rows = Array.from(element.querySelectorAll('tr')).map(
            (tr) => Array.from(tr.children) as HTMLElement[],
          )
          unit.align = Array.from(element.querySelectorAll('thead th')).map(
            () => 'default' as const,
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
  const walk = (unit: Unit<HTMLElement>): void => {
    model.prove(unit)
    for (const child of unit.children) walk(child)
  }
  for (const unit of model.units) walk(unit)
}

/** Replaces `from` by `to` in the first text node that holds it, then marks the owning unit dirty. */
function edit(session: Session, from: string, to: string): void {
  const walker = document.createTreeWalker(session.root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data.includes(from)) continue
    text.data = text.data.replace(from, to)
    const unit = session.model.unitOf(text.parentElement as HTMLElement)
    // Walk up to the first element the model knows (a text node sits inside spans of a block).
    let element: HTMLElement | null = text.parentElement
    let owner = unit
    while (!owner && element) {
      element = element.parentElement
      owner = element ? session.model.unitOf(element) : undefined
    }
    if (!owner) throw new Error('edited node has no unit')
    session.model.markDirty(owner)
    return
  }
  throw new Error(`no text node holds ${JSON.stringify(from)}`)
}

function syncChanges(model: Model, sequence?: number): TextChange[] {
  const result = model.sync(sequence)
  if (result.kind !== 'changes') throw new Error(`fallback ${result.reason}`)
  return result.changes
}

const unitAt = (model: Model, source: string): Unit<HTMLElement> => {
  const found = model.units.find(
    (u) => model.text.slice(u.start, u.end) === source,
  )
  if (!found) throw new Error(`no unit ${JSON.stringify(source)}`)
  return found
}

describe('8.1 in-unit edit of a block', () => {
  it('writes only the inserted character and keeps every separator', () => {
    const session = open('a\n\npara\n')
    proveAll(session.model)
    const before = session.model.text
    edit(session, 'para', 'parax')
    const changes = syncChanges(session.model)
    expect(changes).toEqual([{ from: 7, to: 7, insert: 'x' }])
    expect(session.model.text).toBe('a\n\nparax\n')
    expect(applyChanges(before, changes)).toBe(session.model.text)
    const para = session.model.units[1]
    expect([para.start, para.end]).toEqual([3, 8])
    expect(para.dirty).toBe(false)
    expect(para.canon).toBe('parax')
  })
})

describe('8.2 equal HTML (string adapter)', () => {
  it('a dirty unit with unchanged HTML is clean and costs no serialization', () => {
    interface El {
      id: string
      outerHtml: string
    }
    const els: El[] = [
      { id: 'a', outerHtml: '<p>a</p>' },
      { id: 'p', outerHtml: '<p>para</p>' },
    ]
    let serializes = 0
    const host: UnitHost<El> = {
      listUnits: () => els.map((el) => ({ kind: 'paragraph', members: [el] })),
      html: (_kind, el) => el.outerHtml,
      serialize: (_kind, members) => {
        serializes++
        return members.map((m) => m.outerHtml.replace(/<\/?p>/gu, '')).join('')
      },
      roundTrip: (_kind, source) => source,
      serializeList: () => undefined,
    }
    const model = createTextModel(host, scanMovableBlocks)
    model.build('a\n\npara\n')
    for (const unit of model.units) expect(model.prove(unit)).toBe('proven')
    serializes = 0
    model.markDirty(model.units[1])
    expect(model.sync()).toEqual({ kind: 'changes', changes: [] })
    expect(serializes).toBe(0)
    expect(model.units[1].dirty).toBe(false)
    expect(model.text).toBe('a\n\npara\n')
  })
})

describe('8.3 explicit edit', () => {
  it('writes the canon of an unchanged unit', () => {
    const session = open('***\n')
    proveAll(session.model)
    session.model.markExplicit(session.model.units[0])
    expect(syncChanges(session.model)).toEqual([
      { from: 0, to: 3, insert: '---' },
    ])
    expect(session.model.text).toBe('---\n')
    expect(session.model.units[0].explicit).toBe(false)
  })
})

describe('8.4 and 8.5 saved forms', () => {
  it('8.4 a canon that returns to the saved form restores its bytes', () => {
    const session = open('# T #\n')
    proveAll(session.model)
    edit(session, 'T', 'Tx')
    expect(syncChanges(session.model)).toEqual([
      { from: 3, to: 5, insert: 'x' },
    ])
    expect(session.model.text).toBe('# Tx\n')
    expect(session.model.units[0].forms).toEqual([
      { canon: '# T', bytes: '# T #' },
    ])
    edit(session, 'Tx', 'T')
    expect(syncChanges(session.model)).toEqual([
      { from: 3, to: 4, insert: ' #' },
    ])
    expect(session.model.text).toBe('# T #\n')
  })

  it('8.5 clearForms drops the saved form: the canon is written', () => {
    const session = open('# T #\n')
    proveAll(session.model)
    edit(session, 'T', 'Tx')
    syncChanges(session.model)
    session.model.clearForms()
    edit(session, 'Tx', 'T')
    expect(syncChanges(session.model)).toEqual([{ from: 3, to: 4, insert: '' }])
    expect(session.model.text).toBe('# T\n')
  })
})

describe('8.6 to 8.8 cell edits', () => {
  it('8.6 changes only the span between the pipes', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 |\n')
    proveAll(session.model)
    const before = session.model.text
    edit(session, '1', '1x')
    const changes = syncChanges(session.model)
    expect(changes).toEqual([{ from: 23, to: 23, insert: 'x' }])
    expect(session.model.text).toBe('| a | b |\n| - | - |\n| 1x | 2 |\n')
    expect(applyChanges(before, changes)).toBe(session.model.text)
    const row = session.model.units[0].children[2]
    expect(
      row.children.map((c) => session.model.text.slice(c.start, c.end)),
    ).toEqual(['1x', '2'])
    expect(session.model.units[0].end).toBe(session.model.text.length - 1)
  })

  it('8.7 keeps the bare pipe of a code span on every edit', () => {
    const session = open('| `a|b` | c |\n| - | - |\n| 1 | 2 |\n')
    proveAll(session.model)
    edit(session, 'c', 'cx')
    expect(syncChanges(session.model)).toEqual([
      { from: 11, to: 11, insert: 'x' },
    ])
    expect(session.model.text).toBe('| `a|b` | cx |\n| - | - |\n| 1 | 2 |\n')
    edit(session, 'a|b', 'a|bz')
    syncChanges(session.model)
    expect(session.model.text).toBe('| `a|bz` | cx |\n| - | - |\n| 1 | 2 |\n')
  })

  it('8.8 a span-less row is rewritten as one change in its line', () => {
    const session = open('| a | b |\n| - | - |\n| 1 | 2 \\|\n')
    proveAll(session.model)
    const before = session.model.text
    edit(session, '1', '1x')
    const changes = syncChanges(session.model)
    expect(changes).toHaveLength(1)
    expect(session.model.text).toBe('| a | b |\n| - | - |\n| 1x | 2 \\| |\n')
    expect(applyChanges(before, changes)).toBe(session.model.text)
    expect(changes[0].from).toBeGreaterThanOrEqual(20)
  })
})

describe('8.9 to 8.11 fallbacks and sequence', () => {
  it('8.9 a dirty unproven unit falls back and changes nothing', () => {
    const session = open('a\n\npara\n')
    edit(session, 'para', 'parax')
    expect(session.model.sync()).toEqual({
      kind: 'fallback',
      reason: 'unproven-unit',
    })
    expect(session.model.text).toBe('a\n\npara\n')
    expect(session.model.units[1].dirty).toBe(true)
  })

  it('8.10 a throwing serialize falls back with sync-error and leaves the units unchanged', () => {
    const session = open('a\n\npara\n')
    proveAll(session.model)
    const host = domHost(session.root)
    const throwing = createTextModel(
      {
        ...host,
        serialize: (kind, members) => {
          if (members[0].textContent === 'parax') throw new Error('boom')
          return host.serialize(kind, members)
        },
      },
      scanMovableBlocks,
    )
    throwing.build('a\n\npara\n')
    proveAll(throwing)
    edit({ model: throwing, root: session.root }, 'para', 'parax')
    const snapshot = throwing.units.map((u) => [
      u.start,
      u.end,
      u.dirty,
      u.canon,
    ])
    expect(throwing.sync()).toEqual({ kind: 'fallback', reason: 'sync-error' })
    expect(throwing.text).toBe('a\n\npara\n')
    expect(
      throwing.units.map((u) => [u.start, u.end, u.dirty, u.canon]),
    ).toEqual(snapshot)
  })

  it('8.11 sync(sequence) sets changedAt of changed units only; a later sync() keeps it', () => {
    const session = open('a\n\npara\n')
    proveAll(session.model)
    edit(session, 'para', 'parax')
    syncChanges(session.model, 7)
    expect(session.model.units.map((u) => u.changedAt)).toEqual([0, 7])
    edit(session, 'parax', 'paraxy')
    syncChanges(session.model)
    expect(session.model.units[1].changedAt).toBe(7)
  })
})

describe('8.12 lists (8.13 and 8.14 run through the structure path in model-structure.test.ts)', () => {
  it('8.12 a leaf edit in a loose list keeps the blank lines', () => {
    const session = open('- a\n\n- b\n\n- c\n')
    proveAll(session.model)
    edit(session, 'b', 'bx')
    expect(syncChanges(session.model)).toEqual([
      { from: 8, to: 8, insert: 'x' },
    ])
    expect(session.model.text).toBe('- a\n\n- bx\n\n- c\n')
    expect(unitAt(session.model, '- bx').start).toBe(5)
  })

  it('without a structure handler a structure scope falls back and changes nothing', () => {
    const session = open('a\n\nb\n')
    proveAll(session.model)
    session.model.markStructureDirty('root')
    expect(session.model.sync()).toEqual({
      kind: 'fallback',
      reason: 'sync-error',
    })
    expect(session.model.text).toBe('a\n\nb\n')
  })
})

describe('empty units (handoff 6.12)', () => {
  it('an empty paragraph that receives text gets its separator; emptying it removes the bytes and the separator', () => {
    const session = open('a\n\nb\n')
    proveAll(session.model)
    edit(session, 'b', '')
    expect(syncChanges(session.model)).toEqual([{ from: 1, to: 4, insert: '' }])
    expect(session.model.text).toBe('a\n')
    expect(session.model.units[1].start).toBe(session.model.units[1].end)
    edit(session, 'a', 'ax')
    expect(syncChanges(session.model)).toEqual([
      { from: 1, to: 1, insert: 'x' },
    ])
    expect(session.model.text).toBe('ax\n')
  })
})

describe('leaf bytes outside the changed span are kept (task 733, 007 repair)', () => {
  const TASKS = '- [ ] one\n- [ ] two\n\nAlpha.\n'

  function toggle(session: Session, index: number, checked: boolean): void {
    const input = session.root.querySelectorAll('input')[index]
    input.checked = checked
    if (checked) input.setAttribute('checked', '')
    else input.removeAttribute('checked')
    const owner = session.model.unitOf(input.closest('li') as HTMLElement)
    if (!owner) throw new Error('item has no unit')
    session.model.markDirty(owner)
  }

  it('toggling a task item writes only the mark, in lowercase', () => {
    const session = open(TASKS)
    proveAll(session.model)
    toggle(session, 0, true)
    syncChanges(session.model)
    expect(session.model.text).toBe('- [x] one\n- [ ] two\n\nAlpha.\n')
  })

  it('toggling a checked item back writes a space and keeps the rest', () => {
    const session = open('- [x] one\n- [ ] two\n')
    proveAll(session.model)
    toggle(session, 0, false)
    syncChanges(session.model)
    expect(session.model.text).toBe('- [ ] one\n- [ ] two\n')
  })

  it('toggling on, off and on again keeps the bytes of the item', () => {
    const session = open(TASKS)
    proveAll(session.model)
    for (const checked of [true, false, true]) {
      toggle(session, 0, checked)
      syncChanges(session.model)
    }
    expect(session.model.text).toBe('- [x] one\n- [ ] two\n\nAlpha.\n')
  })

  it('an edit of an item after its toggle keeps the single space', () => {
    const session = open(TASKS)
    proveAll(session.model)
    toggle(session, 0, true)
    syncChanges(session.model)
    edit(session, 'one', 'onex')
    syncChanges(session.model)
    expect(session.model.text).toBe('- [x] onex\n- [ ] two\n\nAlpha.\n')
  })

  it('an edit of an unchecked item keeps its bytes', () => {
    const session = open(TASKS)
    proveAll(session.model)
    edit(session, 'two', 'twoy')
    syncChanges(session.model)
    expect(session.model.text).toBe('- [ ] one\n- [ ] twoy\n\nAlpha.\n')
  })

  it('writes the canon when the changed span lies in the part where bytes and canon differ', () => {
    // The bytes `*  a*` and the canon differ inside the edited span: the layout is ambiguous.
    const session = open('*a*\n')
    proveAll(session.model)
    edit(session, 'a', 'ab')
    syncChanges(session.model)
    expect(session.model.text.trim()).toMatch(/^[*_]ab[*_]$/u)
  })
})
