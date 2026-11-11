// Synthetic table-heavy Markdown fixture for the edit-latency counter gates and probes (Task 733).
// Pure and deterministic: no random source, no date, no import. Blocks are separated by exactly one
// blank line and each table stands alone. It holds no reference definition, footnote, table of
// contents, indented code or raw HTML, so the live text model applies to it.

const HEADER = '| Name | Code | Link | Pipes | Mixed |'
const DELIMITER = '| --- | --- | --- | --- | --- |'

/** One body row; `row` is the 1-based row number inside its table. */
function tableRow(table: 'a' | 'b', row: number): string {
  // Column 1: wide characters (CJK and one astral character) every 15th row; 600 characters in row 7 of table A.
  let first = `Item ${table}${row}`
  if (row % 15 === 0) first = `漢字 ${table}${row} 𝒳`
  if (table === 'a' && row === 7) first = 'w'.repeat(600)
  // Column 2: inline code span in every row.
  const code = `\`code${row}\``
  // Column 3: relative .md link every third row.
  const link =
    row % 3 === 0 ? `[doc ${row}](./docs/page-${row}.md)` : `text ${row}`
  // Column 4: escaped pipe every tenth row.
  const pipes = row % 10 === 0 ? `left\\|right ${row}` : `plain ${row}`
  // Column 5: code span that contains a pipe every twentieth row.
  const mixed = row % 20 === 0 ? '`a|b`' : `v${row}`
  return `| ${first} | ${code} | ${link} | ${pipes} | ${mixed} |`
}

function table(name: 'a' | 'b', bodyRows: number): string {
  const lines = [HEADER, DELIMITER]
  for (let row = 1; row <= bodyRows; row++) lines.push(tableRow(name, row))
  return lines.join('\n')
}

export function tableHeavyMarkdown(factor: 1 | 4 | 16): string {
  const blocks: string[] = []
  blocks.push(
    [
      '---',
      'title: Table heavy fixture',
      'status: draft',
      'tags: synthetic',
      '---',
    ].join('\n'),
  )
  blocks.push('# Overview')
  blocks.push(
    'First paragraph of the synthetic document, with a few words of plain text.',
  )
  blocks.push(
    'Second paragraph, a little longer than the first one, still plain prose.',
  )
  blocks.push('## Items')
  blocks.push('Third paragraph introduces the list below.')
  const items: string[] = []
  for (let i = 1; i <= 10 * factor; i++) items.push(`- list item ${i}`)
  blocks.push(items.join('\n'))
  blocks.push('Fourth paragraph follows the list.')
  blocks.push('## Code')
  const codeLines: string[] = ['```ts']
  for (let i = 1; i <= 40; i++) codeLines.push(`const value${i} = ${i} * 2`)
  codeLines.push('```')
  blocks.push(codeLines.join('\n'))
  blocks.push('Fifth paragraph follows the code block.')
  blocks.push('## Tables')
  blocks.push('Sixth paragraph introduces the tables.')
  blocks.push(table('a', 130 * factor))
  blocks.push(table('b', 65 * factor))
  return `${blocks.join('\n\n')}\n`
}
