// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
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
  type ColumnAlign,
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
