import { describe, expect, it } from 'vitest'
import { scanMovableBlocks } from '../../src/shared/block-move'
import { splitTableRowCells } from '../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../vscode-e2e/table-heavy-markdown'

const FACTORS = [1, 4, 16] as const

/** Body rows of the first table in `text` (header and delimiter rows excluded). */
function tableABodyRows(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\|\s*:?-{3,}/.test(line))
  expect(start).toBeGreaterThan(0)
  const rows: string[] = []
  for (let i = start + 1; i < lines.length && lines[i].startsWith('|'); i++) {
    rows.push(lines[i])
  }
  return rows
}

describe('tableHeavyMarkdown', () => {
  it('is deterministic', () => {
    for (const factor of FACTORS) {
      expect(tableHeavyMarkdown(factor)).toBe(tableHeavyMarkdown(factor))
    }
  })

  it('keeps factor 1 under 100,000 characters and ends with one newline', () => {
    const text = tableHeavyMarkdown(1)
    expect(text.length).toBeLessThan(100_000)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })

  it('gives table A 130 x factor body rows of 5 cells', () => {
    for (const factor of FACTORS) {
      const rows = tableABodyRows(tableHeavyMarkdown(factor))
      expect(rows).toHaveLength(130 * factor)
      for (const row of rows) expect(splitTableRowCells(row)).toHaveLength(5)
    }
  })

  it('scans a non-empty list of movable blocks', () => {
    for (const factor of FACTORS) {
      expect(
        scanMovableBlocks(tableHeavyMarkdown(factor)).length,
      ).toBeGreaterThan(0)
    }
  })

  it('has no line that starts with 4 spaces', () => {
    for (const factor of FACTORS) {
      expect(
        tableHeavyMarkdown(factor)
          .split('\n')
          .some((l) => l.startsWith('    ')),
      ).toBe(false)
    }
  })
})
