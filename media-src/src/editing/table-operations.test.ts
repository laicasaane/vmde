import { describe, expect, test } from 'vitest'
import {
  clearTableCellsAt,
  operateTableRectangleAt,
  resolveRenderedTableIndex,
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
    ).toBeNull()
    expect(
      operateTableRectangleAt(TABLE, 0, 1, 2, 0, 2, 'deleteColumns'),
    ).toBeNull()
  })

  test('ignores fenced and protected pipe text when locating a source table', () => {
    const source = [
      '```md',
      '| fake | table |',
      '| --- | --- |',
      '| x | y |',
      '```',
      '',
      '> | quoted | table |',
      '> | --- | --- |',
      '> | x | y |',
      '',
      '| left | right |',
      '| --- | --- |',
      '| one | two |',
      '',
    ].join('\n')
    expect(moveTableAt(source, 0, 1, 1, 'moveColumnLeft')).toBe(
      source.replace(
        '| left | right |\n| --- | --- |\n| one | two |',
        '| right | left |\n| --- | --- |\n| two | one |',
      ),
    )
  })

  test('keeps a longer fence closed when a shorter marker precedes table-like code', () => {
    const source = [
      '````md',
      '```',
      '| fake | table |',
      '| --- | --- |',
      '| x | y |',
      '````',
      '| left | right |',
      '| --- | --- |',
      '| one | two |',
      '',
    ].join('\n')
    expect(moveTableAt(source, 0, 1, 1, 'moveColumnLeft')).toContain(
      '| right | left |\n| --- | --- |\n| two | one |',
    )
  })

  test('requires rendered/source table ordinals and semantic rows to agree', () => {
    const source = '| left | right |\n| --- | --- |\n| one | two |\n'
    expect(resolveRenderedTableIndex(source, source, 0)).toBe(0)
    expect(
      resolveRenderedTableIndex(
        source,
        '| other | table |\n| --- | --- |\n| one | two |\n',
        0,
      ),
    ).toBeNull()
    expect(resolveRenderedTableIndex(source, source, 1)).toBeNull()
    expect(resolveRenderedTableIndex(source, source, 0, 2)).toBeNull()
  })

  test('accepts Vditor column padding while retaining the same source table identity', () => {
    const exact = '| h1 | h2 |\n| --- | --- |\n| r0a | r0b |\n'
    const rendered = '| h1  | h2  |\n| ---- | ---- |\n| r0a | r0b |\n'
    expect(resolveRenderedTableIndex(exact, rendered, 0)).toBe(0)
  })

  test('accepts a padded long rendered table with blank prose boundaries', () => {
    const body = Array.from(
      { length: 60 },
      (_, index) => `| r${index}a | r${index}b |`,
    )
    const exact = [
      '# table',
      '',
      'before',
      '',
      '| h1 | h2 |',
      '| --- | --- |',
      ...body,
      '',
      'after',
      '',
    ].join('\n')
    const rendered = [
      '# table',
      '',
      'before',
      '',
      '',
      '| h1   | h2   |',
      '| ---- | ---- |',
      ...Array.from(
        { length: 60 },
        (_, index) => `| r${index}a  | r${index}b  |`,
      ),
      '',
      'after',
      '',
    ].join('\n')
    expect(resolveRenderedTableIndex(exact, rendered, 0)).toBe(0)
  })

  test('keeps EOF line endings valid when moving rows or inserting rows', () => {
    const eof = '| h |\n| --- |\n| first |\n| last |'
    expect(moveTableRow(eof, 3, 'up')).toBe(
      '| h |\n| --- |\n| last |\n| first |',
    )
    expect(operateTableRectangleAt(eof, 0, 2, 2, 0, 0, 'insertRowBelow')).toBe(
      '| h |\n| --- |\n| first |\n| last |\n||',
    )
  })

  test('supports header-only and one-column tables without destructive delete operations', () => {
    const headerOnly = '| h |\n| --- |'
    expect(
      operateTableRectangleAt(headerOnly, 0, 0, 0, 0, 0, 'insertRowBelow'),
    ).toBe('| h |\n| --- |\n||')
    expect(
      operateTableRectangleAt(headerOnly, 0, 0, 0, 0, 0, 'deleteRows'),
    ).toBeNull()
    expect(
      operateTableRectangleAt(headerOnly, 0, 0, 0, 0, 0, 'deleteColumns'),
    ).toBeNull()
  })
})
