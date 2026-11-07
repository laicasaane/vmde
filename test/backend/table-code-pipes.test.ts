import { describe, expect, it } from 'vitest'
import {
  escapeCellCodePipesInIrHtml,
  escapeTableCodePipes,
  patchLuteTableCodePipes,
  restoreCodeSpanPipeForm,
  splitTableRowCells,
  tableRowPipeOffsets,
} from '../../src/shared/table-code-pipes'

// Task 704, Decision D1: inside a table row, a `|` between the backticks of a code span is part of
// the code span, not a cell separator. This is the shared helper module (host and webview) for the
// parse-side escape, the code-span-aware cell split, the IR DOM escape, the write-back form
// restore and the Lute patch. Contract: tasks/704-*.md, "Part 1 handoff".

// Row I57 of the Owner's report (a 5-column table; the code span holds five bare pipes).
const I57 =
  "| I57 | Which operations the sample cycle kind supports (F11; the task text has no `EnterAt`). | `Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll`, as `StageListSingle`, because its replay re-enters through `EnterAtAsync`. | The task's set, which makes every replay fail. | [F11](../F11-sample-custom-kind.md) |"
const HEADER =
  '| Id | Question | Provisional answer and evidence | Alternative to offer | Task |'
const DELIMITER = '|---|---|---|---|---|'
const CODE_BARE = '`Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll`'
const CODE_ESCAPED =
  '`Add \\| Enter \\| EnterAt \\| Leave \\| LeaveActive \\| LeaveAll`'
const table = (...rows: string[]) => `${rows.join('\n')}\n`
const trimmed = (cells: string[]) => cells.map((c) => c.trim())

// IR DOM as Lute renders it (Md2VditorIRDOM): a code span is a span[data-type=code] node.
const code = (text: string) =>
  `<span data-type="code" class="vditor-ir__node"><span class="vditor-ir__marker">\`</span><code data-newline="1">${text}</code><span class="vditor-ir__marker">\`</span></span>`
const tableHtml = (cell: string, tag: 'td' | 'th' = 'td') =>
  tag === 'td'
    ? `<table data-block="0" data-type="table"><thead><tr><th>h</th></tr></thead><tbody><tr><td>${cell}</td></tr></tbody></table>`
    : `<table data-block="0" data-type="table"><thead><tr><th>${cell}</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>`

describe('escapeTableCodePipes', () => {
  // Acceptance item: a table row with a pipe in a code span keeps all its cells (display).
  it('escapes the bare pipes of the I57 code span so the row splits into 5 cells', () => {
    const out = escapeTableCodePipes(table(HEADER, DELIMITER, I57))
    expect(out).toBe(
      table(HEADER, DELIMITER, I57.replace(CODE_BARE, CODE_ESCAPED)),
    )
    const row = out.split('\n')[2]
    expect(trimmed(splitTableRowCells(row))).toHaveLength(5)
    expect(trimmed(splitTableRowCells(row))[2]).toBe(
      `${CODE_ESCAPED}, as \`StageListSingle\`, because its replay re-enters through \`EnterAtAsync\`.`,
    )
  })

  it('escapes the pipes of a double-backtick span, whose single backtick is code text', () => {
    const md = table('| a | b |', '|---|---|', '| ``x | ` | y`` | c |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b |', '|---|---|', '| ``x \\| ` \\| y`` | c |'),
    )
  })

  it('closes a span only at a backtick run of the same length', () => {
    // `` opens, a lone ` inside does not close it, the next `` closes it.
    const md = table('| a | b |', '|---|---|', '| ``a ` b|c`` | d |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b |', '|---|---|', '| ``a ` b\\|c`` | d |'),
    )
  })

  it('leaves an unclosed backtick alone: the pipes still separate cells', () => {
    const md = table('| a | b | c |', '|---|---|---|', '| `x | y | z |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('does not close a span across mismatched runs (``…` is unclosed)', () => {
    const md = table('| a | b | c |', '|---|---|---|', '| ``x | y` | z |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('keeps an already-escaped pipe in a code span (idempotent)', () => {
    const md = table('| a | b |', '|---|---|', '| `x \\| y` | c |')
    expect(escapeTableCodePipes(md)).toBe(md)
    const once = escapeTableCodePipes(table(HEADER, DELIMITER, I57))
    expect(escapeTableCodePipes(once)).toBe(once)
  })

  it('escapes only the bare pipes of a span that mixes bare and escaped ones', () => {
    const md = table('| a | b |', '|---|---|', '| `p | q \\| r` | c |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b |', '|---|---|', '| `p \\| q \\| r` | c |'),
    )
  })

  it('leaves a backslash-pipe outside code alone', () => {
    const md = table('| a | b |', '|---|---|', '| x \\| y | c |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('still treats a bare pipe outside a code span as a cell separator', () => {
    const md = table('| a | b | c |', '|---|---|---|', '| `x|y` | z | w |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b | c |', '|---|---|---|', '| `x\\|y` | z | w |'),
    )
  })

  it('does not treat a backslash inside a code span as an escape of the closing backtick', () => {
    // CommonMark: `a\` is the span "a\", so the next span `b|c` is a separate span.
    const md = table('| a | b |', '|---|---|', '| `a\\` | `b|c` |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b |', '|---|---|', '| `a\\` | `b\\|c` |'),
    )
  })

  it('treats a backslash-escaped backtick outside code as a literal, not a span opener', () => {
    const md = table('| a | b | c |', '|---|---|---|', '| \\`x | y | z` |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('returns the same string reference when the document has no pipe', () => {
    const md = '# Title\n\nA paragraph with `code` and no table.\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('returns the same string reference when the document has no backtick', () => {
    const md = table('| a | b |', '|---|---|', '| 1 | 2 |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('returns the same string reference for a table whose code spans hold no pipe', () => {
    const md = table('| a | b |', '|---|---|', '| `x` | `y` |')
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('leaves code with a pipe in an ordinary paragraph unchanged', () => {
    const md = 'A paragraph with `a|b` in code.\n\nSecond `c | d` here.\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('leaves a table-like block inside a fenced code block unchanged', () => {
    const md = '```text\n| a | b |\n|---|---|\n| `x | y` | c |\n```\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('leaves a table-like block inside a tilde fence unchanged', () => {
    const md = '~~~\n| a | b |\n|---|---|\n| `x | y` | c |\n~~~\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('leaves a table-like block inside an HTML block unchanged', () => {
    const md = '<div>\n| a | b |\n|---|---|\n| `x | y` | c |\n</div>\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('leaves a table-like block inside an indented code block unchanged', () => {
    const md =
      'Intro.\n\n    | a | b |\n    |---|---|\n    | `x | y` | c |\n\nOutro.\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('escapes the header row too', () => {
    const md = table('| `a|b` | c |', '|---|---|', '| 1 | 2 |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| `a\\|b` | c |', '|---|---|', '| 1 | 2 |'),
    )
  })

  // D1 is strict: no cell-count guard. A row that already has the header's cell count by GFM
  // (here 3 of 3) still holds one code span, so its pipes are escaped and the row has 2 cells.
  it('escapes code-span pipes on a row whose GFM cell count is already correct', () => {
    const md = table('| a | b | c |', '|---|---|---|', '| `x|y` | z |')
    expect(escapeTableCodePipes(md)).toBe(
      table('| a | b | c |', '|---|---|---|', '| `x\\|y` | z |'),
    )
  })

  it('escapes every body row of the table and stops at the first blank line', () => {
    const md = [
      '| a | b |',
      '|---|---|',
      '| `1|2` | x |',
      '| `3|4` | y |',
      '',
      '| `5|6` | not a table row |',
      '',
    ].join('\n')
    expect(escapeTableCodePipes(md)).toBe(
      [
        '| a | b |',
        '|---|---|',
        '| `1\\|2` | x |',
        '| `3\\|4` | y |',
        '',
        '| `5|6` | not a table row |',
        '',
      ].join('\n'),
    )
  })

  it('ends the table at a line without a pipe', () => {
    const md = `${table('| a | b |', '|---|---|', '| 1 | 2 |')}plain line\n\nA \`x|y\` paragraph.\n`
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('handles alignment colons, two tables and a table at the end without a newline', () => {
    const md = [
      '| a | b |',
      '|:-:|--:|',
      '| `1|2` | 3 |',
      '',
      'between',
      '',
      'c | d',
      '--|--',
      '`4|5` | 6',
    ].join('\n')
    expect(escapeTableCodePipes(md)).toBe(
      [
        '| a | b |',
        '|:-:|--:|',
        '| `1\\|2` | 3 |',
        '',
        'between',
        '',
        'c | d',
        '--|--',
        '`4\\|5` | 6',
      ].join('\n'),
    )
  })

  it('keeps CRLF line endings', () => {
    const md = '| a | b |\r\n|---|---|\r\n| `x|y` | c |\r\n'
    expect(escapeTableCodePipes(md)).toBe(
      '| a | b |\r\n|---|---|\r\n| `x\\|y` | c |\r\n',
    )
  })

  // The math escape stays as it was before this task: guarded, repairs an over-split row only.
  it('still repairs an over-split row whose math holds a pipe, and leaves a price table alone', () => {
    expect(
      escapeTableCodePipes(table('| m | n |', '| - | - |', '| $|x|$ | b |')),
    ).toBe(table('| m | n |', '| - | - |', '| $\\|x\\|$ | b |'))
    const prices = table('| a | b |', '| - | - |', '| $5 | $6 |')
    expect(escapeTableCodePipes(prices)).toBe(prices)
  })
})

// Cases carried over from the former table-pipe-escape suite (Vditor #1904, Task 60): the math
// escape and the pre-existing code-span behaviour stay as they were.
describe('escapeTableCodePipes: cases from the former table-pipe-escape suite', () => {
  it('escapes a | inside inline math in a table cell (the #1904 bug)', () => {
    const md = '| m | n |\n| - | - |\n| $|x|$ | b |\n'
    expect(escapeTableCodePipes(md)).toBe(
      '| m | n |\n| - | - |\n| $\\|x\\|$ | b |\n',
    )
  })

  it('escapes a | inside an inline code span in a table cell', () => {
    const md = '| m | n |\n| - | - |\n| `a|b` | c |\n'
    expect(escapeTableCodePipes(md)).toBe(
      '| m | n |\n| - | - |\n| `a\\|b` | c |\n',
    )
  })

  it('leaves a correctly-celled price table untouched ($ is not always math)', () => {
    const md = '| a | b |\n| - | - |\n| $5 | $6 |\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('is idempotent for math: already-escaped pipes are not double-escaped', () => {
    const md = '| m | n |\n| - | - |\n| $\\|x\\|$ | b |\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('does not touch math or code outside a table', () => {
    const md = 'A paragraph with $|x|$ and `a|b` inline.\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('does not touch a table-looking math line inside a fenced code block', () => {
    const md = '```\n| $|x|$ | b |\n```\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('repairs the header row too, and multiple math cells in a row', () => {
    const md = '| $|a|$ | $|b|$ |\n| - | - |\n| 1 | 2 |\n'
    expect(escapeTableCodePipes(md)).toBe(
      '| $\\|a\\|$ | $\\|b\\|$ |\n| - | - |\n| 1 | 2 |\n',
    )
  })

  it('handles two separate tables in one document', () => {
    const md =
      '| m | n |\n| - | - |\n| $|x|$ | b |\n\nmid\n\n| p | q |\n| - | - |\n| `a|b` | c |\n'
    expect(escapeTableCodePipes(md)).toBe(
      '| m | n |\n| - | - |\n| $\\|x\\|$ | b |\n\nmid\n\n| p | q |\n| - | - |\n| `a\\|b` | c |\n',
    )
  })

  it('leaves an unrelated table completely unchanged', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |\n| x **y** | z |\n'
    expect(escapeTableCodePipes(md)).toBe(md)
  })

  it('returns input unchanged when there is no table at all', () => {
    expect(escapeTableCodePipes('just text\nmore text\n')).toBe(
      'just text\nmore text\n',
    )
  })
})

describe('splitTableRowCells', () => {
  it('splits the I57 row into its 5 raw cells and keeps the code span whole', () => {
    const cells = splitTableRowCells(I57)
    expect(cells).toHaveLength(5)
    // Raw: the cells are not trimmed, as splitRowCells (md-scan) does not trim.
    expect(cells[0]).toBe(' I57 ')
    expect(cells[2].startsWith(` ${CODE_BARE}, as `)).toBe(true)
    expect(trimmed(cells)[4]).toBe('[F11](../F11-sample-custom-kind.md)')
  })

  it('matches splitRowCells wherever no code span holds a pipe', () => {
    expect(splitTableRowCells('| a | b \\| c | d |')).toEqual([
      ' a ',
      ' b \\| c ',
      ' d ',
    ])
    expect(splitTableRowCells('a | b | c')).toEqual(['a ', ' b ', ' c'])
    expect(splitTableRowCells('  | a | b |  ')).toEqual([' a ', ' b '])
  })

  it('keeps an escaped pipe inside a code span in its cell', () => {
    expect(splitTableRowCells('| `x \\| y` | c |')).toEqual([
      ' `x \\| y` ',
      ' c ',
    ])
  })

  it('splits a row without outer pipes around a code span with pipes', () => {
    expect(trimmed(splitTableRowCells('a | `b|c` | d'))).toEqual([
      'a',
      '`b|c`',
      'd',
    ])
  })

  it('handles a double-backtick span holding a single backtick and a pipe', () => {
    expect(trimmed(splitTableRowCells('| ``a ` | b`` | c |'))).toEqual([
      '``a ` | b``',
      'c',
    ])
  })

  it('splits at a pipe after an unclosed backtick', () => {
    expect(trimmed(splitTableRowCells('| `a | b |'))).toEqual(['`a', 'b'])
  })

  it('splits at pipes outside the span and keeps pipes of two spans in one row', () => {
    expect(trimmed(splitTableRowCells('| `a|b` | x | `c|d|e` |'))).toEqual([
      '`a|b`',
      'x',
      '`c|d|e`',
    ])
  })
})

describe('tableRowPipeOffsets', () => {
  it('lists the outer and separating pipes, not the pipes inside a code span', () => {
    //            0123456789012345 6
    const line = '| a | `b|c` | d |'
    expect(tableRowPipeOffsets(line)).toEqual([0, 4, 12, 16])
  })

  it('skips a backslash-escaped pipe outside code', () => {
    expect(tableRowPipeOffsets('| a\\|b | c |')).toEqual([0, 7, 11])
  })

  it('skips an escaped pipe inside a code span', () => {
    expect(tableRowPipeOffsets('| `a\\|b` | c |')).toEqual([0, 9, 13])
  })

  it('yields one offset per separator of the I57 row (6 pipes for 5 cells)', () => {
    const offsets = tableRowPipeOffsets(I57)
    expect(offsets).toHaveLength(6)
    expect(offsets[0]).toBe(0)
    expect(offsets.at(-1)).toBe(I57.length - 1)
    for (const at of offsets) expect(I57[at]).toBe('|')
  })

  it('returns no offset for a line without a pipe', () => {
    expect(tableRowPipeOffsets('no pipe `here`')).toEqual([])
  })
})

describe('escapeCellCodePipesInIrHtml', () => {
  it('escapes the pipes of a code span in a td', () => {
    expect(escapeCellCodePipesInIrHtml(tableHtml(code('x | y')))).toBe(
      tableHtml(code('x \\| y')),
    )
  })

  it('escapes the pipes of a code span in a th', () => {
    expect(escapeCellCodePipesInIrHtml(tableHtml(code('x | y'), 'th'))).toBe(
      tableHtml(code('x \\| y'), 'th'),
    )
  })

  it('escapes every pipe of the I57 code text and several spans in one cell', () => {
    expect(
      escapeCellCodePipesInIrHtml(
        tableHtml(`${code('Add | Enter | Leave')} and ${code('a|b')}`),
      ),
    ).toBe(tableHtml(`${code('Add \\| Enter \\| Leave')} and ${code('a\\|b')}`))
  })

  it('does not double-escape a pipe that already carries a backslash', () => {
    const html = tableHtml(code('x \\| y'))
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('escapes around a caret marker (<wbr>) without breaking the tag', () => {
    expect(escapeCellCodePipesInIrHtml(tableHtml(code('x <wbr>| y')))).toBe(
      tableHtml(code('x <wbr>\\| y')),
    )
    expect(escapeCellCodePipesInIrHtml(tableHtml(code('x |<wbr> y')))).toBe(
      tableHtml(code('x \\|<wbr> y')),
    )
  })

  it('leaves inline math in a cell untouched', () => {
    const math =
      '<span data-type="inline-node" class="vditor-ir__node"><span class="vditor-ir__marker">$</span><code data-newline="1" class="vditor-ir__marker vditor-ir__marker--pre" data-type="math-inline">a|b</code><span class="vditor-ir__preview" data-render="2"><span class="language-math">a|b</span></span><span class="vditor-ir__marker">$</span></span>'
    const html = tableHtml(`${math} ${code('c')}`)
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('leaves inline HTML markers in a cell untouched', () => {
    const inline =
      '<span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">&lt;a title="x|y"&gt;</code></span>x'
    const html = tableHtml(`${inline} ${code('c')}`)
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('leaves plain cell text with a pipe untouched', () => {
    const html = tableHtml(`a | b ${code('c')}`)
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('leaves a code span outside a table untouched', () => {
    const html = `<p data-block="0">plain ${code('a|b')} para</p>${tableHtml(code('ok'))}`
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('leaves a fenced code block that sits next to a table untouched', () => {
    const block =
      '<div class="vditor-ir__node" data-type="code-block"><pre class="vditor-ir__marker--pre"><code>| a | `b|c` |</code></pre></div>'
    const html = `${block}${tableHtml(code('x | y'))}`
    expect(escapeCellCodePipesInIrHtml(html)).toBe(
      `${block}${tableHtml(code('x \\| y'))}`,
    )
  })

  it('returns the same string reference when the markup holds no table', () => {
    const html = `<p data-block="0">${code('a|b')}</p>`
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
  })

  it('returns the same string reference for a table without a pipe or code span', () => {
    const html = tableHtml(code('x'))
    expect(escapeCellCodePipesInIrHtml(html)).toBe(html)
    const noCode = tableHtml('a | b')
    expect(escapeCellCodePipesInIrHtml(noCode)).toBe(noCode)
  })
})

describe('restoreCodeSpanPipeForm (Decision Q3)', () => {
  it('gives an unchanged span its source form: bare stays bare', () => {
    expect(restoreCodeSpanPipeForm('`a|b`', '`a\\|b`')).toBe('`a|b`')
    expect(restoreCodeSpanPipeForm('`a|b`', '`a|b`')).toBe('`a|b`')
  })

  it('gives an unchanged span its source form: escaped stays escaped', () => {
    expect(restoreCodeSpanPipeForm('`a\\|b`', '`a|b`')).toBe('`a\\|b`')
    expect(restoreCodeSpanPipeForm('`a\\|b`', '`a\\|b`')).toBe('`a\\|b`')
  })

  it('restores each of several unchanged spans separately', () => {
    expect(
      restoreCodeSpanPipeForm('`a|b` and `c\\|d`', '`a\\|b` and `c|d`'),
    ).toBe('`a|b` and `c\\|d`')
  })

  it('keeps the next text around an unchanged span', () => {
    expect(restoreCodeSpanPipeForm('x `a|b` y', 'X `a\\|b` Y')).toBe(
      'X `a|b` Y',
    )
  })

  it('writes a changed span with a bare pipe', () => {
    expect(restoreCodeSpanPipeForm('`a|b`', '`a\\|c`')).toBe('`a|c`')
    expect(restoreCodeSpanPipeForm('`a\\|b`', '`a|c`')).toBe('`a|c`')
  })

  it('writes a new span with a bare pipe', () => {
    expect(restoreCodeSpanPipeForm('plain', '`p\\|q`')).toBe('`p|q`')
    expect(restoreCodeSpanPipeForm('plain', '`p|q`')).toBe('`p|q`')
  })

  it('restores the unchanged span and bares the changed one in the same cell', () => {
    expect(restoreCodeSpanPipeForm('`a\\|b` `c\\|d`', '`a|b` `c|e`')).toBe(
      '`a\\|b` `c|e`',
    )
  })

  it('pairs repeated identical spans in order', () => {
    expect(restoreCodeSpanPipeForm('`a|b` `a\\|b`', '`a\\|b` `a|b`')).toBe(
      '`a|b` `a\\|b`',
    )
  })

  it('leaves a pipe outside a span and a backslash-pipe outside a span alone', () => {
    expect(restoreCodeSpanPipeForm('x \\| y', 'x \\| y')).toBe('x \\| y')
    expect(restoreCodeSpanPipeForm('`a|b`', 'p \\| q `a\\|b`')).toBe(
      'p \\| q `a|b`',
    )
  })

  it('returns a cell without a code span unchanged', () => {
    expect(restoreCodeSpanPipeForm('old', 'new')).toBe('new')
  })
})

describe('patchLuteTableCodePipes', () => {
  // A recording stand-in for the Lute instance: every wrapped method returns its argument.
  const makeLute = () => {
    const calls: Record<string, string[]> = {}
    const lute: Record<string, unknown> = {}
    for (const name of [
      'Md2VditorIRDOM',
      'Md2VditorDOM',
      'Md2HTML',
      'FormatStr',
      'VditorIRDOM2Md',
      'SpinVditorIRDOM',
      'VditorDOM2Md',
      'SpinVditorDOM',
      'Md2VditorSVDOM',
      'SpinVditorSVDOM',
    ]) {
      lute[name] = (...args: string[]) => {
        calls[name] = args
        return args[args.length - 1]
      }
    }
    return { lute, calls }
  }
  const md = table(HEADER, DELIMITER, I57)
  const escapedMd = escapeTableCodePipes(md)

  it('pre-escapes the markdown handed to the parse entry points', () => {
    const { lute, calls } = makeLute()
    patchLuteTableCodePipes(lute as never)
    for (const name of ['Md2VditorIRDOM', 'Md2VditorDOM', 'Md2HTML']) {
      expect((lute[name] as (s: string) => string)(md)).toBe(escapedMd)
      expect(calls[name]).toEqual([escapedMd])
    }
    // FormatStr takes (origin, markdown): the markdown is the second argument.
    expect((lute.FormatStr as (o: string, s: string) => string)('', md)).toBe(
      escapedMd,
    )
  })

  it('escapes the IR DOM handed to the IR serializer and the IR spin', () => {
    const { lute } = makeLute()
    patchLuteTableCodePipes(lute as never)
    const html = tableHtml(code('x | y'))
    const escaped = escapeCellCodePipesInIrHtml(html)
    expect(escaped).not.toBe(html)
    expect((lute.VditorIRDOM2Md as (s: string) => string)(html)).toBe(escaped)
    expect((lute.SpinVditorIRDOM as (s: string) => string)(html)).toBe(escaped)
  })

  it('never wraps the WYSIWYG serializer, the WYSIWYG spin or the Source-mode renderers', () => {
    const { lute } = makeLute()
    const before = {
      VditorDOM2Md: lute.VditorDOM2Md,
      SpinVditorDOM: lute.SpinVditorDOM,
      Md2VditorSVDOM: lute.Md2VditorSVDOM,
      SpinVditorSVDOM: lute.SpinVditorSVDOM,
    }
    patchLuteTableCodePipes(lute as never)
    for (const [name, fn] of Object.entries(before)) expect(lute[name]).toBe(fn)
  })

  it('is idempotent: a second call does not wrap the methods again', () => {
    const { lute } = makeLute()
    patchLuteTableCodePipes(lute as never)
    const wrapped = lute.Md2VditorIRDOM
    const wrappedSerializer = lute.VditorIRDOM2Md
    patchLuteTableCodePipes(lute as never)
    expect(lute.Md2VditorIRDOM).toBe(wrapped)
    expect(lute.VditorIRDOM2Md).toBe(wrappedSerializer)
    expect((lute.Md2VditorIRDOM as (s: string) => string)(md)).toBe(escapedMd)
  })
})
