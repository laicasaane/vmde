import { describe, expect, test } from 'vitest'
import {
  clearTableCellsAt,
  operateTableRectangleAt,
  tableRectangleMarkdownAt,
  moveTableAt,
  moveTableColumn,
  moveTableRow,
} from './table-operations'

const TABLE =
  '| H1 | H2 | H3 |\r\n| :-- | :-: | --: |\r\n| `a\\|b` | x\\|y |  |\r\n| one | two | three |\r\n'

describe('table operation planner', () => {
  test('moves a complete column and preserves raw cells, alignment, and CRLF', () => {
    expect(moveTableColumn(TABLE, 1, 'left')).toBe(
      '| H2 | H1 | H3 |\r\n| :-: | :-- | --: |\r\n| x\\|y | `a\\|b` |  |\r\n| two | one | three |\r\n',
    )
  })

  test('does not move a column beyond either table boundary', () => {
    expect(moveTableColumn(TABLE, 0, 'left')).toBeNull()
    expect(moveTableColumn(TABLE, 2, 'right')).toBeNull()
  })

  test('keeps optional outer pipes and adjacent prose bytes intact', () => {
    expect(
      moveTableColumn('left | right\n--- | :---:\none | two\n', 1, 'left'),
    ).toBe(' right|left \n :---:|--- \n two|one \n')
  })

  test('changes only the selected table when documents contain duplicates', () => {
    const source = `before\n\n${TABLE}\nafter\n\n${TABLE}`
    const result = moveTableAt(source, 1, 1, 1, 'moveColumnLeft')
    expect(result).toBe(
      `before\n\n${TABLE}\nafter\n\n| H2 | H1 | H3 |\r\n| :-: | :-- | --: |\r\n| x\\|y | \`a\\|b\` |  |\r\n| two | one | three |\r\n`,
    )
  })

  test('clears a body rectangle without damaging header or delimiter cells', () => {
    expect(clearTableCellsAt(TABLE, 0, 1, 1, 1, 2)).toBe(
      '| H1 | H2 | H3 |\r\n| :-- | :-: | --: |\r\n| `a\\|b` |||\r\n| one | two | three |\r\n',
    )
  })

  test('moves body rows without moving the header or delimiter', () => {
    expect(moveTableRow(TABLE, 3, 'up')).toBe(
      '| H1 | H2 | H3 |\r\n| :-- | :-: | --: |\r\n| one | two | three |\r\n| `a\\|b` | x\\|y |  |\r\n',
    )
  })

  test('rejects header moves, boundary moves, and ragged tables', () => {
    expect(moveTableRow(TABLE, 0, 'up')).toBeNull()
    expect(moveTableRow(TABLE, 1, 'up')).toBeNull()
    expect(moveTableRow(TABLE, 3, 'down')).toBeNull()
    expect(
      moveTableColumn('| a | b |\n| - | - |\n| only |\n', 1, 'left'),
    ).toBeNull()
  })

  test('copies a body rectangle from raw Markdown rather than rendered cell text', () => {
    expect(tableRectangleMarkdownAt(TABLE, 0, 1, 1, 0, 1)).toBe(
      '| `a\\|b` | x\\|y |\r\n|---|---|',
    )
  })

  test('inserts and deletes the full rectangle span without leaving an invalid table', () => {
    const source = `before\n\n${TABLE}after\n`
    expect(
      operateTableRectangleAt(source, 0, 1, 2, 0, 1, 'insertColumnRight'),
    ).toBe(
      'before\n\n| H1 | H2 ||| H3 |\r\n| :-- | :-: |---|---| --: |\r\n| `a\\|b` | x\\|y |||  |\r\n| one | two ||| three |\r\nafter\n',
    )
    expect(
      operateTableRectangleAt(TABLE, 0, 0, 2, 0, 2, 'deleteRows'),
    ).toBe('')
    expect(
      operateTableRectangleAt(TABLE, 0, 1, 2, 0, 2, 'deleteColumns'),
    ).toBe('')
  })
})
