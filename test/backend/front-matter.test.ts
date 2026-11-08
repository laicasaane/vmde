import { describe, expect, it } from 'vitest'
import {
  FRONT_MATTER_NESTING_LIMIT,
  type FrontMatterParseResult,
  type FrontMatterRow,
  type FrontMatterValueView,
  parseFrontMatterProperties,
} from '../../src/shared/front-matter'

// Task 207 S1 — the pure front-matter properties model (D2 display/copy rules, D3 warnings).
// Input is the YAML text between the `---` lines; document line numbers in warnings are the
// yaml line + 1 for the opening `---`.

function rowsOf(yamlText: string): FrontMatterRow[] {
  const result = parseFrontMatterProperties(yamlText)
  if (result.status !== 'table') {
    throw new Error(`expected a table, got ${JSON.stringify(result)}`)
  }
  return result.rows
}

function rowFor(yamlText: string, key: string): FrontMatterRow {
  const row = rowsOf(yamlText).find((candidate) => candidate.key === key)
  if (!row) throw new Error(`no row ${key}`)
  return row
}

const text = (value: string): FrontMatterValueView => ({
  kind: 'text',
  text: value,
})

describe('parseFrontMatterProperties: scalars', () => {
  it('removes double and single quotes and keeps plain scalars literal', () => {
    const yamlText = [
      'title: "Hello"',
      "single: 'it''s'",
      'plain: x y',
      'num: 1.0',
      'bool: true',
      'date: 2024-01-02',
      'nul: null',
    ].join('\n')
    const rows = rowsOf(yamlText)
    expect(rows.map((row) => [row.key, row.value, row.valueCopy])).toEqual([
      ['title', text('Hello'), 'Hello'],
      ['single', text("it's"), "it's"],
      ['plain', text('x y'), 'x y'],
      ['num', text('1.0'), '1.0'],
      ['bool', text('true'), 'true'],
      ['date', text('2024-01-02'), '2024-01-02'],
      ['nul', text('null'), 'null'],
    ])
  })

  it('shows an empty value as an empty string', () => {
    const row = rowFor('empty:\nother: x', 'empty')
    expect(row.value).toEqual(text(''))
    expect(row.valueCopy).toBe('')
  })

  it('copies the displayed key and removes key quotes', () => {
    const rows = rowsOf('"quoted key": 1\n\'single key\': 2\nplain key: 3')
    expect(rows.map((row) => [row.key, row.keyCopy])).toEqual([
      ['quoted key', 'quoted key'],
      ['single key', 'single key'],
      ['plain key', 'plain key'],
    ])
  })

  it('uses the source text for a numeric or boolean plain key', () => {
    const rows = rowsOf('1.0: a\ntrue: b')
    expect(rows.map((row) => row.key)).toEqual(['1.0', 'true'])
  })

  it('uses the source text of a non-scalar key', () => {
    const row = rowsOf('? [a, b]\n: v')[0]
    expect(row.key).toBe('[a, b]')
    expect(row.keyCopy).toBe('[a, b]')
    expect(row.value).toEqual(text('v'))
  })

  it('ignores comments', () => {
    const rows = rowsOf('# leading\na: 1 # trailing\nb: two')
    expect(rows.map((row) => [row.key, row.valueCopy])).toEqual([
      ['a', '1'],
      ['b', 'two'],
    ])
  })
})

describe('parseFrontMatterProperties: block scalars', () => {
  it('keeps the line breaks of a literal block and drops trailing newlines', () => {
    const row = rowFor('lit: |\n  line1\n  line2\nnext: x', 'lit')
    expect(row.value).toEqual(text('line1\nline2'))
    expect(row.valueCopy).toBe('line1\nline2')
  })

  it('keeps the written line breaks of a folded block', () => {
    const row = rowFor('fold: >\n  a\n  b\nnext: x', 'fold')
    expect(row.value).toEqual(text('a\nb'))
    expect(row.valueCopy).toBe('a\nb')
  })

  it('removes the common indentation of a folded block and keeps deeper indentation', () => {
    const row = rowFor('fold: >-\n    a\n      b\n    c\n', 'fold')
    expect(row.value).toEqual(text('a\n  b\nc'))
  })

  it('removes the trailing newlines of a keep-chomped literal block', () => {
    const row = rowFor('keep: |+\n  z\n\n', 'keep')
    expect(row.value).toEqual(text('z'))
  })
})

describe('parseFrontMatterProperties: lists', () => {
  it('shows each flow-list item as a chip and copies the exact source slice', () => {
    const row = rowFor('tags: [a, "b c"]', 'tags')
    expect(row.value).toEqual({
      kind: 'list',
      items: [text('a'), text('b c')],
    })
    expect(row.valueCopy).toBe('[a, "b c"]')
  })

  it('copies a block list as its source lines without indentation', () => {
    const row = rowFor('aliases:\n  - One\n  - Two\nnext: x', 'aliases')
    expect(row.value).toEqual({
      kind: 'list',
      items: [text('One'), text('Two')],
    })
    expect(row.valueCopy).toBe('- One\n- Two')
  })

  it('shows a map item as an inner table and a list item as nested chips', () => {
    const row = rowFor('mixed:\n  - {k: v}\n  - [x, y]', 'mixed')
    expect(row.value).toEqual({
      kind: 'list',
      items: [
        { kind: 'map', rows: [{ key: 'k', value: text('v') }] },
        { kind: 'list', items: [text('x'), text('y')] },
      ],
    })
    expect(row.valueCopy).toBe('- {k: v}\n- [x, y]')
  })

  it('shows an empty list item as an empty chip text', () => {
    const row = rowFor('items:\n  - a\n  -\n  - c', 'items')
    expect(row.value).toEqual({
      kind: 'list',
      items: [text('a'), text(''), text('c')],
    })
  })
})

describe('parseFrontMatterProperties: maps', () => {
  it('shows a nested map as inner rows and copies the map source lines', () => {
    const row = rowFor(
      'author:\n  name: Ann\n  links:\n    site: http://x\nnext: x',
      'author',
    )
    expect(row.value).toEqual({
      kind: 'map',
      rows: [
        { key: 'name', value: text('Ann') },
        {
          key: 'links',
          value: {
            kind: 'map',
            rows: [{ key: 'site', value: text('http://x') }],
          },
        },
      ],
    })
    expect(row.valueCopy).toBe('name: Ann\nlinks:\n  site: http://x')
  })

  it('copies a flow map as its exact source slice', () => {
    const row = rowFor('meta: {a: 1, b: "two"}', 'meta')
    expect(row.value).toEqual({
      kind: 'map',
      rows: [
        { key: 'a', value: text('1') },
        { key: 'b', value: text('two') },
      ],
    })
    expect(row.valueCopy).toBe('{a: 1, b: "two"}')
  })

  it('shows an alias as its source text', () => {
    const row = rowFor('base: &b\n  x: 1\nother: *b', 'other')
    expect(row.value).toEqual(text('*b'))
    expect(row.valueCopy).toBe('*b')
  })
})

describe('parseFrontMatterProperties: nesting limit', () => {
  it('exports the limit as 4', () => {
    expect(FRONT_MATTER_NESTING_LIMIT).toBe(4)
  })

  it('shows the source text of a value deeper than the limit', () => {
    const row = rowFor('deep: [[[[[x]]]]]', 'deep')
    // depth 1..4 render as lists; the 5th level is the source text.
    const level = (value: FrontMatterValueView): FrontMatterValueView => {
      if (value.kind !== 'list') throw new Error('expected a list')
      return value.items[0]
    }
    const fifth = level(level(level(row.value)))
    expect(fifth.kind).toBe('list')
    expect((fifth as { items: FrontMatterValueView[] }).items).toEqual([
      text('[x]'),
    ])
    expect(row.valueCopy).toBe('[[[[[x]]]]]')
  })
})

describe('parseFrontMatterProperties: status', () => {
  it('returns empty for empty and comment-only front matter', () => {
    for (const source of ['', '\n', '# only a comment\n', '   \n\n']) {
      expect(parseFrontMatterProperties(source)).toEqual({ status: 'empty' })
    }
  })

  it('returns a table with rows in source order', () => {
    const result: FrontMatterParseResult =
      parseFrontMatterProperties('b: 1\na: 2')
    expect(result.status).toBe('table')
    expect(rowsOf('b: 1\na: 2').map((row) => row.key)).toEqual(['b', 'a'])
  })
})

describe('parseFrontMatterProperties: warnings', () => {
  const warningOf = (source: string): string => {
    const result = parseFrontMatterProperties(source)
    if (result.status !== 'error') {
      throw new Error(`expected an error, got ${JSON.stringify(result)}`)
    }
    return result.warning
  }

  it('reports a duplicate key with the document line', () => {
    expect(warningOf('a: 1\na: 2')).toBe(
      'Front matter could not be parsed: Map keys must be unique (line 3, column 1)',
    )
  })

  it('reports a bad indent with the document line', () => {
    expect(warningOf('a: [1, 2\nb: c')).toBe(
      'Front matter could not be parsed: Flow sequence in block collection must be sufficiently indented and end with a ] (line 3, column 1)',
    )
  })

  it('reports a tab indent with the document line', () => {
    expect(warningOf('a:\n\t- x')).toBe(
      'Front matter could not be parsed: Tabs are not allowed as indentation (line 3, column 1)',
    )
  })

  it('reports an unterminated quote with the document line and column', () => {
    expect(warningOf('a: "unterminated\nb: c')).toBe(
      'Front matter could not be parsed: Missing closing "quote (line 3, column 5)',
    )
  })

  it('reports the first error only', () => {
    expect(warningOf('a: 1\na: 2\na: 3')).toBe(
      'Front matter could not be parsed: Map keys must be unique (line 3, column 1)',
    )
  })

  it('reports a top-level list or scalar', () => {
    const expected =
      'Front matter could not be parsed: expected key: value properties'
    expect(warningOf('- a\n- b')).toBe(expected)
    expect(warningOf('just text')).toBe(expected)
  })
})
