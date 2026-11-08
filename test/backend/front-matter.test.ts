import { describe, expect, it } from 'vitest'
import {
  FRONT_MATTER_ALIAS_LIMIT,
  FRONT_MATTER_NESTING_LIMIT,
  FRONT_MATTER_TAG_LIMIT,
  type FrontMatterParseResult,
  type FrontMatterRow,
  type FrontMatterValueView,
  frontMatterYaml,
  parseFrontMatterProperties,
  readFrontMatterMetadata,
  startsWithFrontMatterFence,
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

// Task 709 — host-side extraction of `aliases` and `tags` from the leading front-matter block.
// Acceptance item A1 (extractor: list, scalar, missing, malformed).
describe('front-matter metadata', () => {
  describe('frontMatterYaml', () => {
    it('A1 returns the lines between LF fences', () => {
      expect(frontMatterYaml('---\na: 1\nb: 2\n---\nbody')).toBe('a: 1\nb: 2')
    })

    it('A1 accepts CRLF fences', () => {
      expect(frontMatterYaml('---\r\na: 1\r\n---\r\nbody')).toBe('a: 1')
    })

    it('A1 accepts a leading BOM', () => {
      expect(frontMatterYaml('\uFEFF---\na: 1\n---\n')).toBe('a: 1')
    })

    it('A1 accepts trailing spaces and tabs on both fences', () => {
      expect(frontMatterYaml('---  \na: 1\n---\t \nbody')).toBe('a: 1')
    })

    it('A1 gives null without an opening fence', () => {
      expect(frontMatterYaml('# Title\n---\na: 1\n---')).toBeNull()
      expect(frontMatterYaml('')).toBeNull()
    })

    it('A1 gives null when the fence is not on line 1', () => {
      expect(frontMatterYaml('\n---\na: 1\n---\n')).toBeNull()
    })

    it('A1 gives null when the block is not closed in the given text', () => {
      expect(frontMatterYaml('---\na: 1\nb: 2\n')).toBeNull()
    })

    it('A1 gives an empty string for an empty block', () => {
      expect(frontMatterYaml('---\n---\nbody')).toBe('')
    })
  })

  describe('startsWithFrontMatterFence', () => {
    it('A9 is true for an opening fence, with or without BOM, and false otherwise', () => {
      expect(startsWithFrontMatterFence('---\na: 1')).toBe(true)
      expect(startsWithFrontMatterFence('\uFEFF---\r\na: 1')).toBe(true)
      expect(startsWithFrontMatterFence('# Title\n')).toBe(false)
      expect(startsWithFrontMatterFence('--\n')).toBe(false)
    })
  })

  describe('readFrontMatterMetadata', () => {
    it('A1 reads a flow list of aliases', () => {
      expect(readFrontMatterMetadata('aliases: [A, B]')).toEqual({
        aliases: ['A', 'B'],
        tags: [],
      })
    })

    it('A1 reads a block list of aliases and tags', () => {
      expect(
        readFrontMatterMetadata(
          'aliases:\n  - One\n  - Two\ntags:\n  - x\n  - y',
        ),
      ).toEqual({ aliases: ['One', 'Two'], tags: ['x', 'y'] })
    })

    it('A1 reads a scalar as one entry, with no comma splitting', () => {
      expect(readFrontMatterMetadata('aliases: Some Alias')).toEqual({
        aliases: ['Some Alias'],
        tags: [],
      })
      expect(readFrontMatterMetadata('tags: a, b')).toEqual({
        aliases: [],
        tags: ['a, b'],
      })
    })

    it('A1 reads quoted scalars by their parsed value', () => {
      expect(readFrontMatterMetadata('aliases: "Quoted: Alias"')).toEqual({
        aliases: ['Quoted: Alias'],
        tags: [],
      })
      expect(readFrontMatterMetadata("tags: 'it''s'")).toEqual({
        aliases: [],
        tags: ["it's"],
      })
    })

    it('A1 keeps a PLAIN number as its source text', () => {
      expect(readFrontMatterMetadata('tags: 2024')).toEqual({
        aliases: [],
        tags: ['2024'],
      })
    })

    it('A1 gives no entry for a null or empty value', () => {
      expect(readFrontMatterMetadata('aliases:\ntags: [a]')).toEqual({
        aliases: [],
        tags: ['a'],
      })
      expect(readFrontMatterMetadata('aliases:\ntags: ~')).toBeNull()
    })

    it('A1 gives null when neither key gives a usable value', () => {
      expect(readFrontMatterMetadata('title: Hello')).toBeNull()
      expect(readFrontMatterMetadata('')).toBeNull()
      expect(readFrontMatterMetadata('aliases: []\ntags: []')).toBeNull()
    })

    it('A1 is case-sensitive and ignores the legacy alias and tag keys', () => {
      expect(
        readFrontMatterMetadata('Aliases: [A]\nalias: B\ntag: c'),
      ).toBeNull()
    })

    it('A1 gives null for malformed YAML without throwing', () => {
      expect(() => readFrontMatterMetadata('aliases: [A\n  b: c')).not.toThrow()
      expect(readFrontMatterMetadata('aliases: [A\n  b: c')).toBeNull()
      expect(readFrontMatterMetadata('aliases: [A]\naliases: [B]')).toBeNull()
      expect(
        readFrontMatterMetadata('aliases: "unterminated\ntags: [x]'),
      ).toBeNull()
    })

    it('A1 gives null when the top level is not a map', () => {
      expect(readFrontMatterMetadata('- aliases\n- tags')).toBeNull()
      expect(readFrontMatterMetadata('just text')).toBeNull()
    })

    it('A1 skips a map value and non-scalar items', () => {
      expect(readFrontMatterMetadata('aliases:\n  k: v\ntags: [a]')).toEqual({
        aliases: [],
        tags: ['a'],
      })
      expect(
        readFrontMatterMetadata(
          'aliases:\n  - Keep\n  - {k: v}\n  - [n, m]\n  - *ref',
        ),
      ).toEqual({ aliases: ['Keep'], tags: [] })
    })

    it('A1 trims entries, drops empty ones and strips one leading # from tags', () => {
      expect(
        readFrontMatterMetadata(
          'aliases: ["  A  ", "", "   "]\ntags: ["#x", " ##y ", "#"]',
        ),
      ).toEqual({ aliases: ['A'], tags: ['x', '#y'] })
    })

    it('A1 drops duplicates keeping the first (aliases by lookup key, tags by lower case)', () => {
      expect(
        readFrontMatterMetadata(
          'aliases: [Some Alias, some_alias, Other]\ntags: [Foo, foo, "#FOO", Bar]',
        ),
      ).toEqual({ aliases: ['Some Alias', 'Other'], tags: ['Foo', 'Bar'] })
    })

    it('A1 drops aliases that can never be written inside [[…]]', () => {
      const yamlText = [
        'aliases:',
        '  - "a[b"',
        '  - "a]b"',
        '  - "a|b"',
        '  - "a\\nb"',
        '  - "---"',
        '  - "Fine"',
      ].join('\n')
      expect(readFrontMatterMetadata(yamlText)).toEqual({
        aliases: ['Fine'],
        tags: [],
      })
    })

    it('A1 drops an alias whose lookup key is empty', () => {
      expect(readFrontMatterMetadata('aliases: ["  ", "///", "_"]')).toBeNull()
    })

    it('A1 applies the per-file limits of 64 aliases and 256 tags', () => {
      expect(FRONT_MATTER_ALIAS_LIMIT).toBe(64)
      expect(FRONT_MATTER_TAG_LIMIT).toBe(256)
      const aliases = Array.from({ length: 80 }, (_, i) => `alias ${i}`)
      const tags = Array.from({ length: 300 }, (_, i) => `tag${i}`)
      const result = readFrontMatterMetadata(
        `aliases: [${aliases.join(', ')}]\ntags: [${tags.join(', ')}]`,
      )
      expect(result?.aliases).toEqual(aliases.slice(0, 64))
      expect(result?.tags).toEqual(tags.slice(0, 256))
    })
  })
})
