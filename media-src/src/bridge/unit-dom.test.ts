// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { createRealLute } from '../testing/real-lute'
import { writeQuietly } from '../util/mutation-impact'
import { insertWrapHint } from '../util/wrap-hint-mark'
import { createTextModel, type TextModel } from './text-model'
import { installModelSync } from './model-structure'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import type { UnitHost } from './text-model'
import type { UnitLute } from './unit-lute'
import { countBudget, wysiwygFixture } from '../testing/budget-harness'
import * as unitLuteModule from './unit-lute'

// Task 733 / 004-A: the DOM adapter of the text model and its mutation observer. Real Lute with the
// two production patches serves the HTML; the model is the real one over the adapter, so the mapping
// cases call the real `unitOf`.
let lute: UnitLute
beforeAll(() => {
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

const MIXED =
  '# Title\n\npara\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- one\n- two\n  - nested\n\n1. x\n2. y\n\n```js\nx\n```\n'

type Model = TextModel<HTMLElement>
interface Session {
  root: HTMLElement
  dom: UnitHost<HTMLElement> & UnitDomControl
  model: Model
  dirty: ReturnType<typeof vi.spyOn>
  structure: ReturnType<typeof vi.spyOn>
}

const attached: UnitDomControl[] = []
afterEach(() => {
  for (const dom of attached.splice(0)) dom.detach()
  document.body.replaceChildren()
})

function rootOf(html: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

function open(
  markdown: string,
  options?: Parameters<typeof createUnitDom>[2],
): Session {
  const root = rootOf(lute.Md2VditorIRDOM(markdown))
  const dom = createUnitDom(root, lute, options)
  const model = createTextModel(dom, scanMovableBlocks)
  model.build(markdown)
  expect(model.state, String(model.offReason)).toBe('live')
  const dirty = vi.spyOn(model, 'markDirty')
  const structure = vi.spyOn(model, 'markStructureDirty')
  dom.attach(model)
  attached.push(dom)
  return { root, dom, model, dirty, structure }
}

const text = (root: HTMLElement, selector: string): Text =>
  root.querySelector(selector)?.firstChild as Text

describe('createUnitDom listUnits', () => {
  it('lists one unit per element with lists expanded to their top-level items', () => {
    const { dom } = open(MIXED)
    expect(dom.listUnits()?.map((unit) => unit.kind)).toEqual([
      'heading',
      'paragraph',
      'table',
      'list-item',
      'list-item',
      'list-item',
      'list-item',
      'fence',
    ])
    for (const unit of dom.listUnits() ?? [])
      expect(unit.members).toHaveLength(1)
  })

  it('gives table rows in thead, tbody order and one align entry per column', () => {
    const { dom } = open(MIXED)
    const table = dom.listUnits()?.find((unit) => unit.kind === 'table')
    expect(
      table?.rows?.map((row) => row.map((cell) => cell.textContent)),
    ).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(table?.align).toEqual(['left', 'right'])
  })

  it('reads the rows of a table inside a wrapper div and defaults the alignment', () => {
    const root = rootOf(
      '<div data-block="0"><table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></div>',
    )
    const units = createUnitDom(root, lute).listUnits()
    expect(units?.[0].kind).toBe('table')
    expect(units?.[0].rows?.[1][0].textContent).toBe('c')
    expect(units?.[0].align).toEqual(['default'])
  })

  it('leaves out view-only elements: trailing, gap, leading, diff markers and helpers', () => {
    const root = rootOf(
      '<p data-vmde-leading data-block="0">&#8203;</p><p data-block="0">a</p><p data-vmde-gap data-block="0">&#8203;</p><div class="me-diff-marker"></div><div id="fix-table-ir-wrapper" contenteditable="false"></div><p data-vmde-trailing data-block="0">&#8203;</p>',
    )
    const units = createUnitDom(root, lute).listUnits()
    expect(units).toHaveLength(1)
    expect(units?.[0].members[0].textContent).toBe('a')
  })

  it('gives undefined for a list with a non-li child', () => {
    const root = rootOf('<ul data-block="0"><li>a</li><p>x</p></ul>')
    expect(createUnitDom(root, lute).listUnits()).toBeUndefined()
  })

  it('gives undefined for a root text node', () => {
    const root = rootOf('<p data-block="0">a</p>stray')
    expect(createUnitDom(root, lute).listUnits()).toBeUndefined()
  })

  it('gives undefined for a top-level element without data-block', () => {
    const root = rootOf('<p>a</p>')
    expect(createUnitDom(root, lute).listUnits()).toBeUndefined()
  })

  it('gives undefined for a link reference definitions block', () => {
    const root = rootOf(
      // Task 733 / 017: one definition line is a unit; a definitions div merged by Vditor (two lines) is not.
      '<p data-block="0">a</p><div data-block="0" data-type="link-ref-defs-block">[x]: https://example.test\n[y]: https://example.test/y\n</div>',
    )
    expect(createUnitDom(root, lute).listUnits()).toBeUndefined()
  })

  it('gives undefined for a top-level element without a kind', () => {
    const root = rootOf('<div data-block="0">x</div>')
    expect(createUnitDom(root, lute).listUnits()).toBeUndefined()
  })
})

describe('createUnitDom html, serialize and roundTrip', () => {
  it('strips wrap hints from the html of a block and gives innerHTML for a cell', () => {
    const { dom, root } = open(MIXED)
    const paragraph = root.querySelector('p') as HTMLElement
    paragraph.innerHTML = 'pa<span class="vmde-wrap-hint"></span>ra'
    expect(dom.html('paragraph', paragraph)).toBe('<p data-block="0">para</p>')
    const cell = root.querySelector('td') as HTMLElement
    expect(dom.html('cell', cell)).toBe('1')
  })

  it('serializes a block, a cell and a list item through the lute passed in', () => {
    const { dom, root } = open(MIXED)
    expect(
      dom.serialize('paragraph', [root.querySelector('p') as HTMLElement]),
    ).toBe('para')
    expect(
      dom.serialize('cell', [root.querySelector('td') as HTMLElement]),
    ).toBe('1')
    expect(
      dom.serialize('list-item', [root.querySelector('li') as HTMLElement]),
    ).toBe('- one')
  })

  it('round-trips a block and a cell source', () => {
    const { dom } = open(MIXED)
    expect(dom.roundTrip('paragraph', 'para')).toBe('para')
    expect(dom.roundTrip('cell', 'x')).toBe('x')
  })

  it('serializes a list once and splits it into one source per item', () => {
    const { dom, root } = open(MIXED)
    const items = Array.from(
      root.querySelectorAll<HTMLElement>(':scope > ul > li, :scope > ol > li'),
    )
    expect(dom.serializeList(items)).toEqual([
      '- one',
      '- two\n  - nested',
      '1. x',
      '2. y',
    ])
  })

  it('gives undefined when the split count differs from the DOM', () => {
    const root = rootOf(
      '<ul data-block="0"><li data-marker="-">a</li><li data-marker="-">b</li></ul>',
    )
    const stub: UnitLute = {
      VditorIRDOM2Md: () => '- a\n',
      Md2VditorIRDOM: () => '',
    }
    const items = Array.from(root.querySelectorAll('li'))
    expect(createUnitDom(root, stub).serializeList(items)).toBeUndefined()
  })
})

describe('createUnitDom mapping', () => {
  it('marks a paragraph dirty on drain', () => {
    const { root, dom, model, dirty } = open(MIXED)
    text(root, 'p').data = 'changed'
    dom.drain()
    expect(dirty).toHaveBeenCalledWith(
      model.unitOf(root.querySelector('p') as HTMLElement),
    )
  })

  it('marks a heading dirty when its text node changes', () => {
    const { root, dom, model, dirty } = open(MIXED)
    const heading = root.querySelector('h1') as HTMLElement
    ;(heading.lastChild as Text).data = 'Changed'
    dom.drain()
    expect(dirty).toHaveBeenCalledWith(model.unitOf(heading))
  })

  it('marks the cell dirty for an edit inside a cell', () => {
    const { root, dom, model, dirty, structure } = open(MIXED)
    const cell = root.querySelector('td') as HTMLElement
    expect(model.unitOf(cell)?.kind).toBe('cell')
    text(root, 'td').data = '9'
    dom.drain()
    // Only that cell is marked: not the row, the table or any other unit.
    expect(dirty).toHaveBeenCalledTimes(1)
    expect(dirty).toHaveBeenCalledWith(model.unitOf(cell))
    expect(structure).not.toHaveBeenCalled()
  })

  it('marks the table structure for a row added to the tbody', () => {
    const { root, dom, model, structure } = open(MIXED)
    const tbody = root.querySelector('tbody') as HTMLElement
    tbody.appendChild((tbody.firstElementChild as HTMLElement).cloneNode(true))
    dom.drain()
    expect(structure).toHaveBeenCalledWith(
      model.unitOf(root.querySelector('table') as HTMLElement),
    )
  })

  it('marks the table structure for an align record on a cell', () => {
    const { root, dom, model, structure, dirty } = open(MIXED)
    ;(root.querySelector('th') as HTMLElement).setAttribute('align', 'center')
    dom.drain()
    expect(structure).toHaveBeenCalledWith(
      model.unitOf(root.querySelector('table') as HTMLElement),
    )
    expect(dirty).not.toHaveBeenCalled()
  })

  it('marks the top-level item dirty for an edit in the item or its nested list', () => {
    const { root, dom, model, dirty } = open(MIXED)
    const second = root.querySelectorAll<HTMLElement>(':scope > ul > li')[1]
    text(root, 'li ul li').data = 'deeper'
    dom.drain()
    expect(dirty).toHaveBeenCalledWith(model.unitOf(second))
  })

  it('marks the list structure through an item unit for a child added to a top-level list', () => {
    const { root, dom, structure, model } = open(MIXED)
    const list = root.querySelector(':scope > ul') as HTMLElement
    list.appendChild((list.firstElementChild as HTMLElement).cloneNode(true))
    dom.drain()
    expect(structure).toHaveBeenCalledTimes(1)
    const scope = structure.mock.calls[0][0] as { kind?: string }
    expect(scope.kind).toBe('list-item')
    expect(model.units).toContain(scope)
  })

  it('marks the root structure for a child-list record on the root', () => {
    const { root, dom, structure } = open(MIXED)
    const added = document.createElement('p')
    added.setAttribute('data-block', '0')
    root.appendChild(added)
    dom.drain()
    expect(structure).toHaveBeenCalledWith('root')
  })

  it('marks the root structure for a record in a block that has no unit', () => {
    const { root, dom, structure } = open(MIXED)
    const stray = document.createElement('div')
    stray.className = 'me-diff-marker'
    root.appendChild(stray)
    dom.drain()
    structure.mockClear()
    stray.setAttribute('data-x', '1')
    dom.drain()
    expect(structure).toHaveBeenCalledWith('root')
  })

  it('dirties the html-group unit for an edit in its second member', () => {
    const { root, dom, model, dirty } = open(
      '<details>\n<summary>s</summary>\n\nbody\n\n</details>\n',
    )
    const group = model.units[0]
    expect(group.kind).toBe('html-group')
    text(root, 'p').data = 'edited'
    dom.drain()
    expect(dirty).toHaveBeenCalledWith(group)
  })

  it('marks the root structure when a trailing, gap or leading attribute moves on a root child', () => {
    const { root, dom, structure } = open(MIXED)
    const paragraph = root.querySelector('p') as HTMLElement
    for (const name of [
      'data-vmde-trailing',
      'data-vmde-gap',
      'data-vmde-leading',
    ]) {
      structure.mockClear()
      paragraph.setAttribute(name, '')
      dom.drain()
      expect(structure, name).toHaveBeenCalledWith('root')
    }
  })
})

describe('createUnitDom ignored records', () => {
  it('ignores aria-*, fold, indent, class, style and root attribute records', () => {
    const { root, dom, dirty, structure } = open(MIXED)
    const paragraph = root.querySelector('p') as HTMLElement
    paragraph.setAttribute('aria-label', 'x')
    paragraph.setAttribute('data-vmde-foldable', '1')
    paragraph.setAttribute('data-vmde-list-foldable', '1')
    paragraph.setAttribute('data-vmde-indent', '1')
    paragraph.setAttribute('data-vmde-indent-root', '1')
    paragraph.setAttribute('class', 'y')
    paragraph.style.color = 'red'
    root.setAttribute('contenteditable', 'false')
    root.setAttribute('data-anything', '1')
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
    expect(structure).not.toHaveBeenCalled()
  })

  it('ignores an id written on a heading (the outline anchor is view state)', () => {
    const { root, dom, dirty, structure } = open(MIXED)
    ;(root.querySelector('h1') as HTMLElement).id = 'vditorAnchor-0'
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
    expect(structure).not.toHaveBeenCalled()
  })

  it('ignores records inside [data-render] and child lists that only add or remove [data-render] nodes', () => {
    const { root, dom, dirty, structure } = open(MIXED)
    const preview = root.querySelector('[data-render]') as HTMLElement
    preview.appendChild(document.createElement('span'))
    preview.setAttribute('data-x', '1')
    const paragraph = root.querySelector('p') as HTMLElement
    const rendered = document.createElement('span')
    rendered.setAttribute('data-render', '1')
    paragraph.appendChild(rendered)
    rendered.remove()
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
    expect(structure).not.toHaveBeenCalled()
  })

  it('ignores a child-list record with a mix of [data-render] and other nodes only for the other node', () => {
    const { root, dom, dirty } = open(MIXED)
    const paragraph = root.querySelector('p') as HTMLElement
    const rendered = document.createElement('span')
    rendered.setAttribute('data-render', '1')
    paragraph.append(rendered, document.createTextNode('x'))
    dom.drain()
    expect(dirty).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paragraph' }),
    )
  })

  it('ignores a quiet write but applies a record queued before it', () => {
    const { root, dom, model, dirty } = open(MIXED)
    const paragraph = root.querySelector('p') as HTMLElement
    const heading = root.querySelector('h1') as HTMLElement
    ;(heading.lastChild as Text).data = 'genuine'
    writeQuietly(() => {
      ;(paragraph.firstChild as Text).data = 'quiet'
    })
    dom.drain()
    expect(dirty).toHaveBeenCalledTimes(1)
    expect(dirty).toHaveBeenCalledWith(model.unitOf(heading))
  })

  it('ignores the own records of a wrap hint write', () => {
    const { root, dom, dirty, structure } = open(MIXED)
    insertWrapHint(text(root, 'p'), 2)
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
    expect(structure).not.toHaveBeenCalled()
  })
})

describe('createUnitDom drain and detach', () => {
  it('drain processes the queue at once and an empty drain is harmless', () => {
    const { root, dom, dirty } = open(MIXED)
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
    text(root, 'p').data = 'now'
    dom.drain()
    expect(dirty).toHaveBeenCalledTimes(1)
    dom.drain()
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('makes no Lute call in the observer callback', async () => {
    const root = rootOf(lute.Md2VditorIRDOM(MIXED))
    let calls = 0
    const counted: UnitLute = {
      VditorIRDOM2Md: (html) => {
        calls += 1
        return lute.VditorIRDOM2Md(html)
      },
      Md2VditorIRDOM: (markdown) => {
        calls += 1
        return lute.Md2VditorIRDOM(markdown)
      },
    }
    const dom = createUnitDom(root, counted)
    const model = createTextModel(dom, scanMovableBlocks)
    model.build(MIXED)
    dom.attach(model)
    attached.push(dom)
    calls = 0
    const cell = root.querySelector('td') as HTMLElement
    ;(cell.firstChild as Text).data = 'edited'
    root
      .querySelector('tbody')
      ?.appendChild(root.querySelector('tbody tr')!.cloneNode(true))
    await Promise.resolve()
    expect(model.hasDirty()).toBe(true)
    expect(calls).toBe(0)
  })

  it('delivers the records through the observer callback without a drain', async () => {
    const { root, dirty } = open(MIXED)
    text(root, 'p').data = 'async'
    await Promise.resolve()
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('detach stops the observer and drops what is queued', async () => {
    const { root, dom, dirty } = open(MIXED)
    dom.detach()
    text(root, 'p').data = 'after detach'
    dom.drain()
    await Promise.resolve()
    expect(dirty).not.toHaveBeenCalled()
  })

  it('stops tracking quiet writes after detach', () => {
    const { root, dom, dirty } = open(MIXED)
    dom.detach()
    const heading = root.querySelector('h1') as HTMLElement
    ;(heading.lastChild as Text).data = 'plain'
    writeQuietly(() => undefined)
    dom.drain()
    expect(dirty).not.toHaveBeenCalled()
  })
})

describe('createUnitDom onBatch (Task 733 / 005-A)', () => {
  it('reports the edited cell unit once per batch', () => {
    const onBatch = vi.fn()
    const { root, dom, model } = open(MIXED, { onBatch })
    text(root, 'td').data = '9'
    ;(root.querySelector('td') as HTMLElement).append(' more')
    dom.drain()
    expect(onBatch).toHaveBeenCalledTimes(1)
    const [changed, structure] = onBatch.mock.calls[0]
    expect([...changed]).toEqual([
      model.unitOf(root.querySelector('td') as HTMLElement),
    ])
    expect(structure.size).toBe(0)
  })

  it('reports the table in structure for an attribute record on td[align]', () => {
    const onBatch = vi.fn()
    const { root, dom, model } = open(MIXED, { onBatch })
    ;(root.querySelector('td') as HTMLElement).setAttribute('align', 'right')
    dom.drain()
    expect(onBatch).toHaveBeenCalledTimes(1)
    const [changed, structure] = onBatch.mock.calls[0]
    expect(changed.size).toBe(0)
    expect([...structure]).toEqual([
      model.unitOf(root.querySelector('table') as HTMLElement),
    ])
  })

  it("reports 'root' for a root structure change", () => {
    const onBatch = vi.fn()
    const { root, dom } = open(MIXED, { onBatch })
    root.appendChild(document.createElement('p'))
    dom.drain()
    expect([...onBatch.mock.calls[0][1]]).toContain('root')
  })

  // Task 733 / 012-1: the feed scopes a block spin, but the model and the history capture still need
  // the root notice: the root stage relists the top level, and the capture copies the top-level units.
  it('keeps the root notice for the block spin of a top-level paragraph', () => {
    const onBatch = vi.fn()
    const { root, dom, structure } = open(MIXED, { onBatch })
    const old = root.querySelector(':scope > p') as HTMLElement
    old.outerHTML = lute.Md2VditorIRDOM('para2\n')
    dom.drain()
    expect(structure).toHaveBeenCalledWith('root')
    expect(onBatch).toHaveBeenCalledTimes(1)
    expect(onBatch.mock.calls[0][1].has('root')).toBe(true)
  })

  it('keeps the root notice for the block spin of a top-level code block', () => {
    const onBatch = vi.fn()
    const { root, dom, structure } = open(MIXED, { onBatch })
    const old = root.querySelector(
      ':scope > [data-type="code-block"]',
    ) as HTMLElement
    old.outerHTML = lute.Md2VditorIRDOM('```js\nxy\n```\n')
    dom.drain()
    expect(structure).toHaveBeenCalledWith('root')
    expect(onBatch.mock.calls[0][1].has('root')).toBe(true)
  })

  it('reports nothing for a quiet write and for an ignored attribute', () => {
    const onBatch = vi.fn()
    const { root, dom } = open(MIXED, { onBatch })
    writeQuietly(() => {
      text(root, 'p').data = 'quiet'
    })
    ;(root.querySelector('p') as HTMLElement).setAttribute('aria-label', 'x')
    dom.drain()
    expect(onBatch).not.toHaveBeenCalled()
  })
})

// Task 733 / 010-T: `render` writes new blocks from Markdown sources through the live Lute and the
// post-render steps of `setValue`, on the new elements only (shared rules 3.7, SR-2).
describe('createUnitDom render (Task 733 / 010)', () => {
  it('renders each block kind of the table-heavy fixture as a whole render does', () => {
    const markdown = tableHeavyMarkdown(1)
    const { dom, model } = open(markdown)
    const seen = new Set<string>()
    for (const unit of [...model.units]) {
      if (seen.has(unit.kind)) continue
      seen.add(unit.kind)
      const kind = unit.kind as MovableKind
      const expected = unit.members.map((member) => dom.html(kind, member))
      const source = model.text.slice(unit.start, unit.end)
      const rendered = dom.render([{ kind, source }], unit.members)
      expect(rendered, kind).toBeDefined()
      expect(
        rendered?.map((host) => host.kind),
        kind,
      ).toEqual([kind])
      const members = rendered?.[0].members ?? []
      expect(
        members.map((member) => dom.html(kind, member)),
        kind,
      ).toEqual(expected)
      for (const member of members) expect(member.isConnected, kind).toBe(true)
      for (const old of unit.members) expect(old.isConnected, kind).toBe(false)
    }
    expect([...seen]).toEqual([
      'front-matter',
      'heading',
      'paragraph',
      'list-item',
      'fence',
      'table',
    ])
  })

  it('calls the Lute once per source with the source only, never the whole document', () => {
    const root = rootOf(lute.Md2VditorIRDOM(MIXED))
    const inputs: string[] = []
    const counted: UnitLute = {
      VditorIRDOM2Md: (html) => lute.VditorIRDOM2Md(html),
      Md2VditorIRDOM: (markdown) => {
        inputs.push(markdown)
        return lute.Md2VditorIRDOM(markdown)
      },
    }
    const dom = createUnitDom(root, counted)
    const model = createTextModel(dom, scanMovableBlocks)
    model.build(MIXED)
    dom.attach(model)
    attached.push(dom)
    const paragraph = model.units.find((unit) => unit.kind === 'paragraph')!
    inputs.length = 0
    dom.render([{ kind: 'paragraph', source: 'new para' }], paragraph.members)
    expect(inputs).toEqual(['new para'])
  })

  it('gives the SR-2 fixture the same DOM as the full render and runs no handler', () => {
    const spy = vi.fn()
    ;(window as unknown as { __sr2Spy: () => void }).__sr2Spy = spy
    const source = [
      '<script>window.__sr2Spy()</script>',
      '',
      '<img src="x" onerror="window.__sr2Spy()">',
      '',
      '[a](javascript:window.__sr2Spy()) [b](data:text/html,<script>window.__sr2Spy()</script>)',
      '',
      '<svg><script>window.__sr2Spy()</script><circle onload="window.__sr2Spy()"/></svg>',
    ].join('\n')
    const full = rootOf(lute.Md2VditorIRDOM(source))
    const { root, dom, model } = open('placeholder\n')
    const placeholder = model.units[0]
    const kinds = scanMovableBlocks(source).map((block) => block.kind)
    expect(kinds).toEqual(['html', 'html', 'paragraph', 'paragraph'])
    const sources = scanMovableBlocks(source).map((block) => ({
      kind: block.kind,
      source: source.slice(block.start, block.end),
    }))
    const rendered = dom.render(sources, placeholder.members)
    expect(rendered?.map((host) => host.kind)).toEqual(kinds)
    expect(root.innerHTML).toBe(full.innerHTML)
    expect(spy).not.toHaveBeenCalled()
    delete (window as unknown as { __sr2Spy?: unknown }).__sr2Spy
  })

  it('writes nothing when a rendered element has another kind than its source', () => {
    const { root, dom, model } = open(MIXED)
    const before = root.innerHTML
    const paragraph = model.units.find((unit) => unit.kind === 'paragraph')!
    const rendered = dom.render(
      [{ kind: 'paragraph', source: '[r]: https://example.com' }],
      paragraph.members,
    )
    expect(rendered).toBeDefined()
    expect(rendered?.map((host) => host.kind)).not.toEqual(['paragraph'])
    expect(paragraph.members[0].isConnected).toBe(true)
    expect(root.innerHTML).toBe(before)
  })

  it('replaces one table row for a row source and keeps the other rows', () => {
    const markdown = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n'
    const { root, dom } = open(markdown)
    const rows = Array.from(root.querySelectorAll('tbody > tr'))
    const rendered = dom.render(
      [{ kind: 'table', source: '| a | b |\n| - | - |\n| 3 | X |' }],
      [rows[1] as HTMLElement],
    )
    const after = Array.from(root.querySelectorAll('tbody > tr'))
    expect(after).toHaveLength(3)
    expect(after[0]).toBe(rows[0])
    expect(after[2]).toBe(rows[2])
    expect(after[1]).not.toBe(rows[1])
    expect(after[1].textContent).toContain('X')
    expect(rendered).toEqual([
      {
        kind: 'table',
        members: [after[1]],
        rows: [Array.from(after[1].children)],
      },
    ])
    expect(root.querySelectorAll('table')).toHaveLength(1)
  })

  it('lets the observer see the replacement (the history capture records it)', () => {
    const onBatch = vi.fn()
    const { dom, model } = open(MIXED, { onBatch })
    const paragraph = model.units.find((unit) => unit.kind === 'paragraph')!
    dom.render([{ kind: 'paragraph', source: 'seen' }], paragraph.members)
    dom.drain()
    expect(onBatch).toHaveBeenCalledTimes(1)
    expect(onBatch.mock.calls[0][1].has('root')).toBe(true)
  })
})

describe('createUnitDom render list identity (010-R F4)', () => {
  it('refuses an item of another marker inside an existing list', () => {
    const { root, dom } = open('- a\n- b\n- c\n')
    const before = root.innerHTML
    const item = root.querySelectorAll('li')[1] as HTMLElement
    const rendered = dom.render([{ kind: 'list-item', source: '* b' }], [item])
    expect(rendered?.map((host) => host.kind)).not.toEqual(['list-item'])
    expect(root.innerHTML).toBe(before)
  })

  it('refuses an ordered item of another delimiter', () => {
    const { root, dom } = open('1. a\n2. b\n')
    const before = root.innerHTML
    const item = root.querySelectorAll('li')[1] as HTMLElement
    const rendered = dom.render([{ kind: 'list-item', source: '2) b' }], [item])
    expect(rendered?.map((host) => host.kind)).not.toEqual(['list-item'])
    expect(root.innerHTML).toBe(before)
  })

  it('refuses a new first number of an ordered list', () => {
    const { root, dom } = open('1. a\n2. b\n')
    const before = root.innerHTML
    const item = root.querySelectorAll('li')[0] as HTMLElement
    const rendered = dom.render([{ kind: 'list-item', source: '3. a' }], [item])
    expect(rendered?.map((host) => host.kind)).not.toEqual(['list-item'])
    expect(root.innerHTML).toBe(before)
  })

  it('still places an item of the same style inside the list', () => {
    const { root, dom } = open('- a\n- b\n- c\n')
    const list = root.querySelector('ul')
    const item = root.querySelectorAll('li')[1] as HTMLElement
    const rendered = dom.render([{ kind: 'list-item', source: '- B' }], [item])
    expect(rendered?.map((host) => host.kind)).toEqual(['list-item'])
    expect(root.querySelector('ul')).toBe(list)
    expect(root.querySelectorAll('li')[1].textContent).toContain('B')
  })
})

describe('createUnitDom render deletions in lists (010-R pass 2, N1)', () => {
  it('refuses deleting the first item of an ordered list and writes nothing', () => {
    const { root, dom } = open('para\n\n1. a\n2. b\n3. c\n')
    const before = root.innerHTML
    const first = root.querySelectorAll('li')[0] as HTMLElement
    const rendered = dom.render([], [first])
    expect(rendered?.length).not.toBe(0)
    expect(root.innerHTML).toBe(before)
  })

  it('deletes a later item of an ordered list in place', () => {
    const { root, dom } = open('para\n\n1. a\n2. b\n3. c\n')
    const list = root.querySelector('ol')
    const second = root.querySelectorAll('li')[1] as HTMLElement
    expect(dom.render([], [second])).toEqual([])
    expect(root.querySelector('ol')).toBe(list)
    expect(root.querySelectorAll('li')).toHaveLength(2)
  })
})

// ---- Task 733 / 012-11: listUnits reads no table row ----
//
// `listUnits` runs on every root-stage sync; reading every row of every table made it cost the size
// of the tables. The table stays one entry (`tableUnit`); its rows are not read while listing.
describe('createUnitDom listUnits skips table bodies (012-11)', () => {
  const bodyRows = Array.from(
    { length: 2000 },
    (_, k) => `| r${k + 1} | v${k + 1} |`,
  )
  const DOC = `# Title\n\npara\n\n| a | b |\n| - | - |\n${bodyRows.join('\n')}\n\n- one\n- two\n\nafter\n`

  /** The prototype that owns `name` on `element`'s chain (jsdom puts the mixins on Element). */
  const ownerOf = (element: Element, name: string): object => {
    let proto: object | null = Object.getPrototypeOf(element)
    while (proto && !Object.getOwnPropertyDescriptor(proto, name))
      proto = Object.getPrototypeOf(proto)
    if (!proto) throw new Error(`no ${name}`)
    return proto
  }

  it('lists the table as one entry and reads none of its rows', () => {
    const root = rootOf(lute.Md2VditorIRDOM(DOC))
    const table = root.querySelector('table') as HTMLElement
    expect(table.querySelectorAll('tr')).toHaveLength(2001)
    const dom = createUnitDom(root, lute)
    const inTable = (node: unknown): boolean =>
      node instanceof Node && (node === table || table.contains(node))
    const reads: string[] = []
    const queryAll = vi.spyOn(Element.prototype, 'querySelectorAll')
    const query = vi.spyOn(Element.prototype, 'querySelector')
    const childrenOwner = ownerOf(table, 'children')
    const children = Object.getOwnPropertyDescriptor(
      childrenOwner,
      'children',
    ) as PropertyDescriptor
    Object.defineProperty(childrenOwner, 'children', {
      ...children,
      get(this: Element) {
        if (inTable(this)) reads.push(`children of ${this.localName}`)
        return children.get?.call(this)
      },
    })
    let units: ReturnType<typeof dom.listUnits>
    try {
      units = dom.listUnits()
      for (const spy of [queryAll, query])
        for (const receiver of spy.mock.contexts)
          if (inTable(receiver))
            reads.push(`query on ${(receiver as Element).localName}`)
    } finally {
      Object.defineProperty(childrenOwner, 'children', children)
      queryAll.mockRestore()
      query.mockRestore()
    }
    expect(units?.map((unit) => unit.kind)).toEqual([
      'heading',
      'paragraph',
      'table',
      'list-item',
      'list-item',
      'paragraph',
    ])
    const entry = units?.find((unit) => unit.kind === 'table')
    expect(entry?.members).toEqual([table])
    expect(reads).toEqual([])
  })
})

// Task 733 / 012-12-T (D-13 design section 5.2, B-05): `onBatch` gets a third argument, the elements a
// batch inserted under a list, a table section or row, or the root. It is one reused set: a batch that
// inserts nothing passes the same, empty set object (no allocation). The document is the table-heavy
// fixture, rendered fresh per test with the production Lute patches because the cases write the DOM.
describe.each([1, 4, 16] as const)(
  'createUnitDom onBatch inserted at factor %i (Task 733 / 012-12, B-05)',
  (factor) => {
    // A live model over the factor-16 fixture takes seconds to build (several times that under a full parallel run).
    const BUILD_TIMEOUT_MS = 60_000
    type Inserted = ReadonlySet<HTMLElement> | undefined

    /** Opens the fixture with an `onBatch` that copies each call's inserted set before it is reused. */
    function openInserted() {
      const seen: { set: Inserted; members: HTMLElement[] }[] = []
      const onBatch = vi.fn((...args: unknown[]) => {
        const set = args[2] as Inserted
        seen.push({ set, members: set ? [...set] : [] })
      })
      const session = open(tableHeavyMarkdown(factor), { onBatch })
      return { ...session, seen, onBatch }
    }

    it(
      'a list item Enter reports the new item only',
      () => {
        const { root, dom, seen } = openInserted()
        const list = root.querySelector(':scope > ul') as HTMLElement
        const item = list.children[4] as HTMLElement
        const fresh = document.createElement('li')
        for (const attribute of Array.from(item.attributes))
          fresh.setAttribute(attribute.name, attribute.value)
        fresh.textContent = 'tail'
        item.after(fresh)
        ;(item.firstChild as Text).data = 'list it'
        dom.drain()
        expect(seen).toHaveLength(1)
        expect(seen[0].set).toBeDefined()
        expect(seen[0].members).toEqual([fresh])
      },
      BUILD_TIMEOUT_MS,
    )

    it(
      'a table row insert reports the new row only',
      () => {
        const { root, dom, seen } = openInserted()
        const tbody = root.querySelector(
          ':scope > table tbody',
        ) as HTMLTableSectionElement
        const row = tbody.rows[2].cloneNode(true) as HTMLTableRowElement
        tbody.rows[2].after(row)
        dom.drain()
        expect(seen).toHaveLength(1)
        expect(seen[0].set).toBeDefined()
        expect(seen[0].members).toEqual([row])
      },
      BUILD_TIMEOUT_MS,
    )

    it(
      'a block spin of a top-level paragraph reports the spun block only',
      () => {
        const { root, dom, seen } = openInserted()
        const old = root.querySelector(':scope > p') as HTMLElement
        old.outerHTML = lute.Md2VditorIRDOM('para2\n')
        const spun = root.querySelector(':scope > p') as HTMLElement
        dom.drain()
        expect(seen).toHaveLength(1)
        expect(seen[0].set).toBeDefined()
        expect(seen[0].members).toEqual([spun])
      },
      BUILD_TIMEOUT_MS,
    )

    it(
      'a batch that inserts nothing passes the same, empty set',
      () => {
        const { root, dom, seen } = openInserted()
        const tbody = root.querySelector(
          ':scope > table tbody',
        ) as HTMLTableSectionElement
        tbody.rows[2].after(tbody.rows[2].cloneNode(true))
        dom.drain()
        text(root, 'td').data = '9'
        dom.drain()
        expect(seen).toHaveLength(2)
        expect(seen[1].set).toBeDefined()
        expect(seen[1].set).toBe(seen[0].set)
        expect(seen[1].members).toEqual([])
      },
      BUILD_TIMEOUT_MS,
    )
  },
)

// ---- Task 733 / 013-T1: the DOM adapter over the WYSIWYG root (technical task 013 sections 6.2, 6.6) ----
//
// `createUnitDom(root, unitLuteOf(lute, 'wysiwyg'), { mode: 'wysiwyg' })` (013-I1) lists, serializes and
// observes Lute's WYSIWYG DOM; B-05 and the B-17 table listing repeated on `wysiwygFixture`.
describe('013 WYSIWYG unit DOM', () => {
  let wysiwyg: object
  beforeAll(() => {
    const real = createRealLute('wysiwyg')
    patchLuteTableCodePipes(real.lute)
    patchLuteGapRepair(real.lute)
    wysiwyg = real.lute
  })
  const exported = unitLuteModule as unknown as Record<string, unknown>
  /** The WYSIWYG pair of 013-I1; a clear failure while `unitLuteOf` does not exist. */
  function wysiwygPair(): UnitLute {
    const factory = exported.unitLuteOf
    if (typeof factory !== 'function')
      throw new Error('unit-lute exports no unitLuteOf (013-I1)')
    return (factory as (lute: object, mode: 'wysiwyg') => UnitLute)(
      wysiwyg,
      'wysiwyg',
    )
  }
  /** A fresh WYSIWYG root with the fixture's DOM (the fixture itself stays unmodified). */
  function wysiwygRootOf(markdown: string): HTMLElement {
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-wysiwyg'
    root.innerHTML = wysiwygFixture(markdown).root.innerHTML
    document.body.appendChild(root)
    return root
  }
  type Inserted = ReadonlySet<HTMLElement>
  function openWysiwyg(
    markdown: string,
    inserted: Inserted[] = [],
    sets: Inserted[] = [],
  ) {
    const root = wysiwygRootOf(markdown)
    const options = {
      mode: 'wysiwyg' as const,
      onBatch: (_changed: unknown, _structure: unknown, added?: Inserted) => {
        if (!added) return
        sets.push(added)
        inserted.push(new Set(added))
      },
    }
    const dom = createUnitDom(
      root,
      wysiwygPair(),
      options as Parameters<typeof createUnitDom>[2],
    )
    const model = createTextModel(dom, scanMovableBlocks)
    model.build(markdown)
    expect(model.state, String(model.offReason)).toBe('live')
    dom.attach(model)
    attached.push(dom)
    return { root, dom, model, inserted }
  }

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    const markdown = tableHeavyMarkdown(factor)

    it('builds a live model whose units are the WYSIWYG blocks, items and cells', () => {
      const { root, model } = openWysiwyg(markdown)
      expect(model.text).toBe(markdown)
      const list = root.querySelector(':scope > ul') as HTMLElement
      expect(model.unitOf(list.children[0] as HTMLElement)?.kind).toBe(
        'list-item',
      )
      const cell = root.querySelector('td') as HTMLElement
      expect(model.unitOf(cell)?.kind).toBe('cell')
    }, 60_000)

    it('B-17: lists every table as one entry without reading a row', () => {
      const root = wysiwygRootOf(markdown)
      const dom = createUnitDom(root, wysiwygPair(), {
        mode: 'wysiwyg',
      } as Parameters<typeof createUnitDom>[2])
      const { result, counts } = countBudget(root, () => dom.listUnits())
      expect(result?.filter((unit) => unit.kind === 'table')).toHaveLength(2)
      expect(counts.tableQueries).toBe(0)
      expect(counts.innerHtmlReads).toBe(0)
    }, 60_000)

    it('B-05: reports the inserted elements of a list Enter, a row insert and a block spin only', async () => {
      const inserted: Inserted[] = []
      const sets: Inserted[] = []
      const { root, dom } = openWysiwyg(markdown, inserted, sets)
      const list = root.querySelector(':scope > ul') as HTMLElement
      const item = list.children[2] as HTMLElement
      const added = item.cloneNode(true) as HTMLElement
      item.after(added)
      dom.drain()
      const body = root.querySelector('tbody') as HTMLElement
      const row = body.children[3].cloneNode(true) as HTMLElement
      body.children[3].after(row)
      dom.drain()
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      const spun = paragraph.cloneNode(true) as HTMLElement
      paragraph.replaceWith(spun)
      dom.drain()
      ;(spun.firstChild as Text).data = 'typed'
      dom.drain()
      expect(inserted.map((set) => [...set])).toEqual([
        [added],
        [row],
        [spun],
        [],
      ])
      // One reused set: a batch that inserts nothing allocates none.
      expect(new Set(sets).size).toBe(1)
    }, 60_000)
  })
})
