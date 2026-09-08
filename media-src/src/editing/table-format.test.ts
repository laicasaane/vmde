import fs from 'node:fs'
import vm from 'node:vm'
import { TextDecoder, TextEncoder } from 'node:util'
import { beforeAll, describe, expect, test } from 'vitest'
import { mapRenderedTableSelectionToSource } from './table-operations'
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
        source.indexOf('|a|') + 2,
        source.indexOf('|a|') + 2,
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

  test('rejects table-shaped text inside HTML, comments, and indented list or quote continuations', () => {
    const table = '|a|b|\n|---|---|\n|one|two|\n'
    const sources = [
      `<div>\n${table}</div>\n`,
      `<!--\n${table}-->\n`,
      `- item\n  ${table.replaceAll('\n', '\n  ').trimEnd()}\n`,
      `> quote\n  ${table.replaceAll('\n', '\n  ').trimEnd()}\n`,
    ]
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }

    for (const source of sources) {
      const caret = source.indexOf('|a|') + 2
      expect(formatTableAtSelection(source, caret, caret, formatter)).toBeNull()
    }
  })

  test('rejects continuation tables across blank lines with and without outer pipes', () => {
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const sources = [
      '- item\n\n  |a|b|\n  |---|---|\n  |one|two|\n',
      '> quote\n\n  a|b\n  ---|---\n  one|two\n',
    ]

    for (const source of sources) {
      const caret = source.indexOf('a|b') + 1
      expect(formatTableAtSelection(source, caret, caret, formatter)).toBeNull()
    }
  })

  test('does not let an HTML tag inside a fence hide a later ordinary table', () => {
    const source = [
      '```html',
      '<div>',
      '```',
      '',
      '|a|b|',
      '|---|---|',
      '|one|two|',
    ].join('\n')
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const caret = source.lastIndexOf('|a|') + 2

    expect(
      formatTableAtSelection(source, caret, caret, formatter)?.markdown,
    ).toContain('|formatted|b|')
  })

  test('keeps void and self-closing HTML blocks protected until a blank line', () => {
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const table = '|a|b|\n|---|---|\n|one|two|\n'

    for (const tag of ['<br>', '<hr>', '<img src="x"/>', '<div />']) {
      const noBlank = `${tag}\n${table}`
      const separated = `${tag}\n\n${table}`
      const caret = noBlank.indexOf('|a|') + 2

      expect(
        formatTableAtSelection(noBlank, caret, caret, formatter),
      ).toBeNull()
      expect(
        formatTableAtSelection(
          separated,
          separated.indexOf('|a|') + 2,
          separated.indexOf('|a|') + 2,
          formatter,
        )?.markdown,
      ).toContain('|formatted|b|')
    }
  })

  test('keeps raw HTML elements protected through matching close across blank lines', () => {
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const table = '|a|b|\n|---|---|\n|one|two|\n'

    for (const tag of ['script', 'style', 'pre', 'textarea']) {
      const source = `<${tag}>\n\n${table}</${tag}>\n\n${table}`
      const rawCaret = source.indexOf('|a|') + 2
      const ordinaryCaret = source.lastIndexOf('|a|') + 2

      expect(
        formatTableAtSelection(source, rawCaret, rawCaret, formatter),
      ).toBeNull()
      expect(
        formatTableAtSelection(source, ordinaryCaret, ordinaryCaret, formatter)
          ?.markdown,
      ).toContain('|formatted|b|')
    }
  })

  test('ends ordinary HTML blocks only at a blank line, including same-line closes', () => {
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const table = '|a|b|\n|---|---|\n|one|two|\n'
    const openDiv = `<div>\ncontent\n\n${table}`
    const closedNoBlank = `<div></div>\n${table}`
    const closedBlank = `<div></div>\n\n${table}`

    expect(
      formatTableAtSelection(
        openDiv,
        openDiv.indexOf('|a|') + 2,
        openDiv.indexOf('|a|') + 2,
        formatter,
      )?.markdown,
    ).toContain('|formatted|b|')
    expect(
      formatTableAtSelection(
        closedNoBlank,
        closedNoBlank.indexOf('|a|') + 2,
        closedNoBlank.indexOf('|a|') + 2,
        formatter,
      ),
    ).toBeNull()
    expect(
      formatTableAtSelection(
        closedBlank,
        closedBlank.indexOf('|a|') + 2,
        closedBlank.indexOf('|a|') + 2,
        formatter,
      )?.markdown,
    ).toContain('|formatted|b|')
  })

  test('treats fences inside HTML blocks and comments as literal before a later table', () => {
    const formatter: TableFormatter = {
      format: (markdown) => markdown.replace('a', 'formatted'),
    }
    const table = '|a|b|\n|---|---|\n|one|two|\n'
    const sources = [
      `<div>\n\`\`\`\n</div>\n\n${table}`,
      `<!--\n\`\`\`\n-->\n\n${table}`,
    ]

    for (const source of sources) {
      const caret = source.lastIndexOf('|a|') + 2
      expect(
        formatTableAtSelection(source, caret, caret, formatter)?.markdown,
      ).toContain('|formatted|b|')
    }
  })

  test('maps outer pipes and cell padding to stable logical source positions', () => {
    const source = '| a |longer|\n|---|---|\n| x |z|\n'
    const firstPipe = source.indexOf('|')
    const leadingPadding = source.indexOf(' a') + 1
    const trailingPadding = source.indexOf('a |') + 2
    const lastPipe = source.lastIndexOf('|')

    const atLeadingPipe = formatTableAtSelection(
      source,
      firstPipe,
      firstPipe,
      formatter,
    )
    const atLeadingPadding = formatTableAtSelection(
      source,
      leadingPadding,
      leadingPadding,
      formatter,
    )
    const atTrailingPadding = formatTableAtSelection(
      source,
      trailingPadding,
      trailingPadding,
      formatter,
    )
    const outerSelection = formatTableAtSelection(
      source,
      firstPipe,
      lastPipe,
      formatter,
    )

    expect(atLeadingPipe?.markdown[atLeadingPipe.selectionStart]).toBe('a')
    expect(atLeadingPadding?.selectionStart).toBe(atLeadingPipe?.selectionStart)
    expect(atTrailingPadding?.markdown[atTrailingPadding.selectionStart]).toBe(
      ' ',
    )
    expect(outerSelection?.selectionStart).toBe(atLeadingPipe?.selectionStart)
    expect(outerSelection?.selectionEnd).toBeGreaterThan(
      outerSelection?.selectionStart ?? 0,
    )
  })

  test('maps a padded SV table selection back onto the matching exact source cell', () => {
    const exact = '|a| longer |\n|:-|---:|\n|x|z|\n'
    const rendered = '| a   | longer |\n| :-- | -----: |\n| x   | z      |\n'
    const renderedCaret = rendered.indexOf('longer') + 2

    expect(
      mapRenderedTableSelectionToSource(
        rendered,
        exact,
        renderedCaret,
        renderedCaret,
      ),
    ).toEqual({
      startOffset: exact.indexOf('longer') + 2,
      endOffset: exact.indexOf('longer') + 2,
    })
  })
})
