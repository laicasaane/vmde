// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { splitRow } from '../../../src/shared/table-row-splice'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import {
  delimiterLine,
  roundTripBlock,
  roundTripCell,
  serializeBlockHtml,
  serializeCellHtml,
  serializeListItemHtml,
  spinCellHtml,
  spinListItemHtml,
  type ColumnAlign,
  type SpinLute,
  type UnitLute,
} from './unit-lute'

// `createRealLute` binds `render`/`serialize` before the patches, so the tests call the methods on
// `real.lute` (patched in production order: code pipes first, then gap repair; production also
// wraps live line breaks and inline HTML formatting, which these string functions do not need).
let lute: UnitLute
const trim = (text: string): string => text.replace(/\n+$/u, '')

beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

const root = (markdown: string): HTMLElement => {
  const div = document.createElement('div')
  div.innerHTML = lute.Md2VditorIRDOM(markdown)
  return div
}
const whole = (markdown: string): string =>
  trim(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(markdown)))

// Source cells of the 12 x 5 table: code spans, a code span holding `|`, an escaped pipe, a link,
// a hard break and wide characters.
const FLAVORS = [
  (r: number, c: number) => `plain ${r}-${c}`,
  (r: number, c: number) => `\`code ${r}-${c}\``,
  (r: number, c: number) => `\`a|b ${r}-${c}\``,
  (r: number, c: number) => `esc \\| ${r}-${c}`,
  (r: number, c: number) => `[link ${r}-${c}](https://example.test/${r}/${c})`,
  (r: number, c: number) => `line${r}<br>break ${c}`,
  (r: number, c: number) => `日本語 ${r}-${c}`,
  (r: number, c: number) => `**bold** ${r}-${c}`,
]
const ROWS = 12
const COLS = 5
const cellSource = (r: number, c: number): string =>
  FLAVORS[(r * COLS + c) % FLAVORS.length](r, c)
const tableMarkdown = (): string => {
  const lines: string[] = []
  for (let r = 0; r < ROWS; r++) {
    lines.push(
      `| ${Array.from({ length: COLS }, (_, c) => cellSource(r, c)).join(' | ')} |`,
    )
    if (r === 0)
      lines.push(`| ${Array.from({ length: COLS }, () => '-').join(' | ')} |`)
  }
  return lines.join('\n')
}
/** Canon of cell (r, c) in the whole-table serialization. */
const wholeCells = (): string[][] => {
  const lines = whole(tableMarkdown()).split('\n')
  return Array.from({ length: ROWS }, (_, r) =>
    splitRow(lines[r === 0 ? 0 : r + 1]),
  )
}

describe('serializeCellHtml and roundTripCell', () => {
  it('equals the cell in the whole-table serialization for all 60 cells', () => {
    const table = root(tableMarkdown()).querySelector('table') as HTMLElement
    const rows = Array.from(table.querySelectorAll('tr'))
    const canon = wholeCells()
    expect(rows).toHaveLength(ROWS)
    let checked = 0
    for (const [r, row] of rows.entries()) {
      const cells = Array.from(row.children) as HTMLElement[]
      expect(cells).toHaveLength(COLS)
      for (const [c, cell] of cells.entries()) {
        expect(serializeCellHtml(lute, cell.innerHTML), `cell ${r},${c}`).toBe(
          canon[r][c],
        )
        checked++
      }
    }
    expect(checked).toBe(60)
  })

  it('roundTripCell of each source cell span equals the cell canon', () => {
    const canon = wholeCells()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        expect(roundTripCell(lute, cellSource(r, c)), `cell ${r},${c}`).toBe(
          canon[r][c],
        )
      }
    }
  })

  it('keeps a code-span pipe in its cell with the escaped form on both sides', () => {
    expect(roundTripCell(lute, '`a|b`')).toBe('`a\\|b`')
    const cell = root('| h |\n| - |\n| `a|b` |').querySelector(
      'td',
    ) as HTMLElement
    expect(serializeCellHtml(lute, cell.innerHTML)).toBe('`a\\|b`')
  })
})

describe('serializeListItemHtml', () => {
  const shellOf = (list: Element): string =>
    (list.cloneNode(false) as Element).outerHTML.replace(/<\/(ul|ol)>$/u, '')

  const itemsOf = (
    markdown: string,
  ): Array<{ canon: string; list: Element; item: Element }> => {
    const out: Array<{ canon: string; list: Element; item: Element }> = []
    for (const list of Array.from(root(markdown).children)) {
      for (const item of Array.from(list.children)) {
        out.push({
          canon: serializeListItemHtml(lute, shellOf(list), item.outerHTML),
          list,
          item,
        })
      }
    }
    return out
  }

  const tight = ['- t1', '- t2', '- t3', '- t4', '- t5', '- t6']
  const loose = ['- l1', '- l2', '- l3', '- l4', '- l5', '- l6']
  const ordered = ['3. o3', '4. o4', '5. o5', '6. o6', '7. o7', '8. o8']

  it('equals the source line for 12 tight items (a tight list of 6 and an ordered list from 3 of 6)', () => {
    const tightItems = itemsOf(tight.join('\n'))
    const orderedItems = itemsOf(ordered.join('\n'))
    expect(tightItems.map((i) => i.canon)).toEqual(tight)
    expect(orderedItems.map((i) => i.canon)).toEqual(ordered)
    expect(tightItems.length + orderedItems.length).toBe(12)
  })

  it('equals the source line for the 6 items of a loose list as well', () => {
    expect(itemsOf(loose.join('\n\n')).map((i) => i.canon)).toEqual(loose)
  })

  it('isolates an ordered item other than the first with the marker 1.', () => {
    const items = itemsOf('1. a\n2. b')
    expect(items.map((i) => i.canon)).toEqual(['1. a', '1. b'])
    expect(items[1].item.getAttribute('data-marker')).toBe('2.')
  })
})

describe('serializeBlockHtml', () => {
  it('serializes the outerHTML of a block and joins several members', () => {
    const blocks = Array.from(root('para **x**\n\n# Title #').children)
    expect(serializeBlockHtml(lute, [blocks[0].outerHTML])).toBe('para **x**')
    expect(serializeBlockHtml(lute, [blocks[1].outerHTML])).toBe('# Title')
    expect(
      serializeBlockHtml(
        lute,
        blocks.map((b) => b.outerHTML),
      ),
    ).toBe(whole('para **x**\n\n# Title #'))
  })
})

describe('roundTripBlock', () => {
  it('returns the thematic break text for `---` despite the front matter reading', () => {
    expect(roundTripBlock(lute, 'thematic', '---')).toBe('---')
    expect(roundTripBlock(lute, 'thematic', '***')).toBe('---')
  })

  it('round-trips other kinds without trailing newlines', () => {
    expect(roundTripBlock(lute, 'paragraph', 'a  *b*\n')).toBe(whole('a  *b*'))
    expect(roundTripBlock(lute, 'heading', '# T #')).toBe('# T')
  })
})

describe('delimiterLine', () => {
  it('writes the unpadded delimiter row', () => {
    const align: ColumnAlign[] = ['left', 'center', 'right', 'default']
    expect(delimiterLine(align)).toBe('| :- | :-: | -: | - |')
    expect(delimiterLine(['default'])).toBe('| - |')
  })

  it('renders with those four alignments', () => {
    const markdown = `| a | b | c | d |\n${delimiterLine(['left', 'center', 'right', 'default'])}\n| 1 | 2 | 3 | 4 |`
    const aligns = Array.from(root(markdown).querySelectorAll('th')).map((th) =>
      th.getAttribute('align'),
    )
    expect(aligns).toEqual(['left', 'center', 'right', null])
  })
})

// The unit spin returns Lute's markup string and the block spin is read back from the DOM, which
// re-serializes entities (`&quot;` to `"`); both are compared as the DOM would hold them.
const dom = (html: string): string => {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder.innerHTML
}
const spin = (l: UnitLute): SpinLute => l as unknown as SpinLute

// Task 733 / 002-T: the unit spin functions through the wrapped Lute (code pipes, then gap repair,
// as `boot/preload.ts` installs them). They do not exist yet, so these cases fail.
const listShell = (list: Element): string =>
  (list.cloneNode(false) as Element).outerHTML.replace(/<\/(ul|ol)>$/u, '')

describe('spinCellHtml', () => {
  it('spins a cell with the caret marker to its inner HTML and keeps the marker', () => {
    const result = spinCellHtml(spin(lute), 'abc<wbr>')
    expect(result.kind).toBe('spun')
    if (result.kind !== 'spun') return
    expect(result.html).toContain('abc')
    expect(result.html).toContain('<wbr>')
    // The result is the content of one cell, not a table.
    expect(result.html).not.toMatch(/<\/?(table|thead|tbody|tr|th|td)\b/u)
    expect(result.html).not.toMatch(/\n$/u)
  })

  it('refuses a cell where a pipe was typed with reason shape', () => {
    expect(spinCellHtml(spin(lute), 'a|b<wbr>')).toEqual({
      kind: 'refused',
      reason: 'shape',
    })
  })

  it.each(['# x', '- x', '> x'])(
    'keeps the block marker %s typed in a cell as text',
    (marker) => {
      const result = spinCellHtml(spin(lute), `${marker}<wbr>`)
      expect(result.kind).toBe('spun')
      if (result.kind !== 'spun') return
      expect(dom(result.html)).toContain(marker.replace('>', '&gt;'))
      expect(result.html).not.toMatch(/<(h[1-6]|ul|ol|li|blockquote)\b/u)
    },
  )
})

describe('spinListItemHtml', () => {
  const shell = (markdown: string): string =>
    listShell(root(markdown).firstElementChild as Element)

  it('spins a tight item to one li', () => {
    const result = spinListItemHtml(
      spin(lute),
      shell('- a\n- b'),
      '<li data-marker="-">text<wbr></li>',
    )
    expect(result.kind).toBe('spun')
    if (result.kind !== 'spun') return
    const holder = document.createElement('div')
    holder.innerHTML = result.html
    expect(holder.children).toHaveLength(1)
    expect(holder.firstElementChild?.tagName).toBe('LI')
    expect(result.html).toContain('<wbr>')
    expect(result.html).not.toMatch(/\n$/u)
  })

  it('returns nested for an item that holds a nested list', () => {
    const list = root('- a\n  - b\n- c').firstElementChild as Element
    const item = list.firstElementChild as Element
    item.querySelector('li')?.insertAdjacentHTML('beforeend', '<wbr>')
    expect(
      spinListItemHtml(spin(lute), listShell(list), item.outerHTML),
    ).toEqual({
      kind: 'refused',
      reason: 'nested',
    })
  })

  it('keeps the loose form of a loose item or returns shape', () => {
    const list = root('- a\n\n- b').firstElementChild as Element
    const item = list.firstElementChild as Element
    expect(item.firstElementChild?.tagName).toBe('P')
    item.firstElementChild?.insertAdjacentHTML('beforeend', '<wbr>')
    const result = spinListItemHtml(spin(lute), listShell(list), item.outerHTML)
    if (result.kind === 'spun') {
      const holder = document.createElement('div')
      holder.innerHTML = result.html
      expect(holder.firstElementChild?.firstElementChild?.tagName).toBe('P')
    } else {
      expect(result).toEqual({ kind: 'refused', reason: 'shape' })
    }
  })
})

describe('refused unit spin results', () => {
  // Hot path: a refusal returns one shared constant object, so a refused call allocates nothing.
  it('returns the same object for the same refusal on two calls', () => {
    expect(spinCellHtml(spin(lute), 'a|b<wbr>')).toBe(
      spinCellHtml(spin(lute), 'a|b<wbr>'),
    )
    const nested =
      '<li data-marker="-">a<wbr><ul data-block="0"><li data-marker="-">n</li></ul></li>'
    const shell = '<ul data-tight="true" data-marker="-" data-block="0">'
    expect(spinListItemHtml(spin(lute), shell, nested)).toBe(
      spinListItemHtml(spin(lute), shell, nested),
    )
  })

  it('refuses shape when the spun list shell differs from the input shell', () => {
    // A shell Lute would rewrite (another marker) is the block spin's work.
    const result = spinListItemHtml(
      spin(lute),
      '<ul data-tight="true" data-marker="*" data-block="0" class="x">',
      '<li data-marker="*">a<wbr></li>',
    )
    expect(result).toEqual({ kind: 'refused', reason: 'shape' })
  })
})

describe('spinCellHtml gap-repair oracle', () => {
  it('gives a cell glued to a code span the same content as inside the whole table', () => {
    const table = root('| h | k |\n| - | - |\n| a`b`c | x |\n| y | z |')
      .firstElementChild as HTMLElement
    const cell = table.querySelectorAll('td')[0]
    cell.insertAdjacentHTML('beforeend', '<wbr>')
    const input = cell.innerHTML
    // The one-cell input holds one `<tr`: it is not a whole-table call.
    expect(input.split('<tr')).toHaveLength(1)
    const blockOut = document.createElement('div')
    blockOut.innerHTML = spin(lute).SpinVditorIRDOM(table.outerHTML)
    const expected = blockOut.querySelectorAll('td')[0].innerHTML
    const result = spinCellHtml(spin(lute), input)
    expect(result.kind).toBe('spun')
    expect(result.kind === 'spun' && dom(result.html)).toBe(expected)
  })
})

/** The DOM holds no script element, no event-handler attribute and no script-bearing URL. */
function expectInert(html: string): void {
  const holder = document.createElement('div')
  holder.innerHTML = html
  expect(holder.querySelector('script')).toBeNull()
  for (const el of Array.from(holder.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      expect(attr.name.startsWith('on'), `attribute ${attr.name}`).toBe(false)
      if (['href', 'src'].includes(attr.name))
        expect(attr.value).not.toMatch(/^\s*(javascript:|data:text\/html)/iu)
    }
  }
}

describe('unit spin SR-2: hostile content', () => {
  const PAYLOAD = [
    '<script>window.__unitSpinHit()</script>',
    '<img src=x onerror="window.__unitSpinHit()">',
    '[a](javascript:window.__unitSpinHit())',
    '[b](data:text/html,<script>window.__unitSpinHit()</script>)',
    '<svg onload="window.__unitSpinHit()"><circle r="1"/></svg>',
  ].join(' ')

  it('gives the same HTML through the unit spin and the block spin and runs no handler', () => {
    const hit = vi.fn()
    ;(window as unknown as Record<string, unknown>).__unitSpinHit = hit
    try {
      // Cell.
      const table = root(`| h |\n| - |\n| ${PAYLOAD} |\n| t |`)
        .firstElementChild as HTMLElement
      const cell = table.querySelectorAll('td')[0]
      cell.insertAdjacentHTML('beforeend', '<wbr>')
      const cellInput = cell.innerHTML
      const blockCell = document.createElement('div')
      blockCell.innerHTML = spin(lute).SpinVditorIRDOM(table.outerHTML)
      const cellResult = spinCellHtml(spin(lute), cellInput)
      expect(cellResult.kind).toBe('spun')
      if (cellResult.kind === 'spun') {
        expect(dom(cellResult.html)).toBe(
          blockCell.querySelectorAll('td')[0].innerHTML,
        )
        const sink = document.createElement('div')
        document.body.appendChild(sink)
        sink.innerHTML = cellResult.html
        // jsdom runs no script, so the spy alone cannot fail: assert the result DOM is inert too.
        expectInert(cellResult.html)
        sink.remove()
      }
      // Item.
      const list = root(`- x ${PAYLOAD}\n- t`).firstElementChild as HTMLElement
      const item = list.firstElementChild as HTMLElement
      item.insertAdjacentHTML('beforeend', '<wbr>')
      const blockList = document.createElement('div')
      blockList.innerHTML = spin(lute).SpinVditorIRDOM(list.outerHTML)
      const itemResult = spinListItemHtml(
        spin(lute),
        listShell(list),
        item.outerHTML,
      )
      expect(itemResult.kind).toBe('spun')
      if (itemResult.kind === 'spun') {
        const blockItem = blockList.firstElementChild
          ?.firstElementChild as HTMLElement
        expect(dom(itemResult.html)).toBe(blockItem.outerHTML)
        const sink = document.createElement('div')
        document.body.appendChild(sink)
        sink.innerHTML = itemResult.html
        expectInert(itemResult.html)
        sink.remove()
      }
      expect(hit).not.toHaveBeenCalled()
    } finally {
      delete (window as unknown as Record<string, unknown>).__unitSpinHit
    }
  })
})
