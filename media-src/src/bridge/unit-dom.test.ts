// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import { writeQuietly } from '../util/mutation-impact'
import { insertWrapHint } from '../util/wrap-hint-mark'
import { createTextModel, type TextModel } from './text-model'
import { installModelSync } from './model-structure'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import type { UnitHost } from './text-model'
import type { UnitLute } from './unit-lute'

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
      '<p data-block="0">a</p><div data-block="0" data-type="link-ref-defs-block">[x]: https://example.test</div>',
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
