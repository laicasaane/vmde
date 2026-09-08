import fs from 'node:fs'
import vm from 'node:vm'
import { TextDecoder, TextEncoder } from 'node:util'
import { beforeAll, describe, expect, test } from 'vitest'
import { formatTableAtSelection, type TableFormatter } from './table-format'

let formatter: TableFormatter

interface PinnedLute {
  FormatStr(origin: string, markdown: string): string
}

beforeAll(() => {
  const sandbox: Record<string, unknown> = {
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync('media-src/vendor/lute/lute.min.js', 'utf8'),
    sandbox,
    { filename: 'lute.min.js' },
  )
  const lute = (sandbox as { Lute: { New(): PinnedLute } }).Lute.New()
  formatter = { format: (markdown) => lute.FormatStr('', markdown) }
})

describe('source table formatting', () => {
  test('formats only the table at a collapsed caret and preserves CRLF surrounding bytes', () => {
    const source = [
      'before',
      '',
      '|a| longer |',
      '|:-|---:|',
      '|x\\|y|全角|',
      '',
      'after',
      '',
    ].join('\r\n')
    const result = formatTableAtSelection(
      source,
      source.indexOf('longer') + 2,
      source.indexOf('longer') + 2,
      formatter,
    )
    const formatted = [
      'before',
      '',
      '| a   | longer |',
      '| :-- | -----: |',
      '| x\\|y |   全角 |',
      '',
      'after',
      '',
    ].join('\r\n')

    expect(result).toEqual({
      markdown: formatted,
      startOffset: source.indexOf('|a|'),
      endOffset: source.indexOf('|x\\|y|全角|') + '|x\\|y|全角|'.length + 2,
      selectionStart:
        formatted.indexOf('| a   | longer |') + '| a   | lo'.length,
      selectionEnd: formatted.indexOf('| a   | longer |') + '| a   | lo'.length,
    })
  })

  test('retains a table-local selection through Lute padding without touching an identical table', () => {
    const table = '|a|b|\n|---|:--:|\n|one|two|\n'
    const source = `before\n${table}between\n${table}after\n`
    const selectionStart = source.indexOf('one') + 1
    const selectionEnd = source.indexOf('two') + 2

    const result = formatTableAtSelection(
      source,
      selectionStart,
      selectionEnd,
      formatter,
    )

    expect(result?.markdown).toBe(
      'before\n| a   |  b  |\n| --- | :-: |\n| one | two |\nbetween\n' +
        table +
        'after\n',
    )
    expect(
      result?.markdown.slice(result.selectionStart, result.selectionEnd),
    ).toBe('ne | tw')
  })

  test('does not format a spanning selection, fenced table-shaped text, or protected table', () => {
    const table = '|a|b|\n|---|---|\n|one|two|\n'
    const source = [
      '```md',
      table.trimEnd(),
      '```',
      '',
      '> |a|b|',
      '> |---|---|',
      '> |one|two|',
      '',
      table.trimEnd(),
      'tail',
    ].join('\n')
    const fake: TableFormatter = { format: (markdown) => `changed:${markdown}` }

    expect(
      formatTableAtSelection(
        source,
        source.indexOf('```') + 1,
        source.indexOf('```') + 1,
        fake,
      ),
    ).toBeNull()
    expect(
      formatTableAtSelection(
        source,
        source.indexOf('> |a') + 3,
        source.indexOf('> |a') + 3,
        fake,
      ),
    ).toBeNull()
    expect(
      formatTableAtSelection(
        source,
        source.lastIndexOf('|a|') + 1,
        source.indexOf('tail') + 1,
        fake,
      ),
    ).toBeNull()
  })
})
