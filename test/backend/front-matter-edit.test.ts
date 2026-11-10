import { describe, expect, it } from 'vitest'
import {
  appendFrontMatterPlaceholder,
  editFrontMatterValue,
  type FrontMatterEntry,
  mapFrontMatterEntries,
  moveFrontMatterEntry,
  removeFrontMatterEntry,
  renameFrontMatterKey,
} from '../../src/shared/front-matter-edit'

// Task 725 step 1 — the byte-preserving edit core of the front-matter properties table. Input is
// the YAML text between the fences as `frontMatterYaml()` returns it: no line break after the last
// line. Every edit replaces one source range; these tests prove the other bytes stay identical.

const LF = '\n'
const CRLF = '\r\n'

function withEol(text: string, eol: string): string {
  return text.replace(/\n/g, eol)
}

// Every kind in one text: comments (full-line and trailing), a blank line, all quote styles,
// a list, a nested map, both block scalars, a flow collection and a multi-line plain scalar.
const BASE = [
  '# header comment',
  'title: Hello # trailing',
  "'single': 'it''s'",
  '"double": "say \\"hi\\""',
  '',
  '# between',
  'tags:',
  '  - a',
  '  - b',
  'nested:',
  '  k: v',
  '  n:',
  '    - x',
  'lit: |',
  '  line one',
  '  line two',
  'fold: >-',
  '  folded',
  'flow: [a, b]',
  'multi: plain',
  '  more',
  'last: end',
].join('\n')

function entries(yamlText: string): FrontMatterEntry[] {
  const map = mapFrontMatterEntries(yamlText)
  if (map.status !== 'entries') {
    throw new Error(`expected entries, got ${map.reason}`)
  }
  return map.entries
}

function entryOf(yamlText: string, key: string): FrontMatterEntry {
  const found = entries(yamlText).find((entry) => entry.key === key)
  if (!found) throw new Error(`no entry ${key}`)
  return found
}

function must(result: string | null): string {
  if (result === null) throw new Error('expected an edited text, got null')
  return result
}

/** Everything outside [start, end) of `before` is byte-identical in `after`. */
function expectOnlyRangeChanged(
  before: string,
  after: string,
  start: number,
  end: number,
): void {
  expect(after.startsWith(before.slice(0, start))).toBe(true)
  expect(after.endsWith(before.slice(end))).toBe(true)
}

describe.each([
  ['LF', LF],
  ['CRLF', CRLF],
])('front-matter edit core (%s)', (_name, eol) => {
  const base = withEol(BASE, eol)
  const text = (source: string) => withEol(source, eol)

  describe('mapFrontMatterEntries', () => {
    it('maps every entry with its kind, key and value text', () => {
      const map = mapFrontMatterEntries(base)
      expect(map.status).toBe('entries')
      if (map.status !== 'entries') return
      expect(map.eol).toBe(eol)
      expect(
        map.entries.map((entry) => [entry.key, entry.kind, entry.duplicate]),
      ).toEqual([
        ['title', 'scalar', false],
        ['single', 'scalar', false],
        ['double', 'scalar', false],
        ['tags', 'block', false],
        ['nested', 'block', false],
        ['lit', 'block', false],
        ['fold', 'block', false],
        ['flow', 'block', false],
        ['multi', 'block', false],
        ['last', 'scalar', false],
      ])
      expect(map.entries.map((entry) => entry.index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ])
      expect(entryOf(base, 'title').valueText).toBe('Hello')
      expect(entryOf(base, 'single').valueText).toBe("it's")
      expect(entryOf(base, 'double').valueText).toBe('say "hi"')
      expect(entryOf(base, 'tags').valueText).toBe(text('\n  - a\n  - b'))
      expect(entryOf(base, 'lit').valueText).toBe(
        text('|\n  line one\n  line two'),
      )
      expect(entryOf(base, 'flow').valueText).toBe('[a, b]')
      expect(entryOf(base, 'multi').valueText).toBe(text('plain\n  more'))
    })

    it('gives exact key, value and line ranges', () => {
      const quotedKeys: Record<string, string> = {
        single: "'single'",
        double: '"double"',
      }
      for (const entry of entries(base)) {
        expect(base.slice(entry.keyStart, entry.keyEnd)).toBe(
          quotedKeys[entry.key] ?? entry.key,
        )
        if (entry.kind === 'block') {
          expect(base.slice(entry.valueStart, entry.valueEnd)).toBe(
            entry.valueText,
          )
        }
        // Lines of an entry start at a line start and end after a line break (or at the end).
        expect(entry.start === 0 || base[entry.start - 1] === '\n').toBe(true)
        expect(entry.end === base.length || base[entry.end - 1] === '\n').toBe(
          true,
        )
      }
      const title = entryOf(base, 'title')
      expect(base.slice(title.start, title.end)).toBe(
        `title: Hello # trailing${eol}`,
      )
      expect(base.slice(title.valueStart, title.valueEnd)).toBe('Hello')
      const last = entryOf(base, 'last')
      expect(last.end).toBe(base.length)
      expect(base.slice(last.start, last.end)).toBe('last: end')
      const tags = entryOf(base, 'tags')
      expect(base.slice(tags.start, tags.end)).toBe(
        text('tags:\n  - a\n  - b\n'),
      )
    })

    it('keeps comment and blank lines out of every entry', () => {
      const all = entries(base)
      const owned = all.map((entry) => base.slice(entry.start, entry.end))
      for (const line of ['# header comment', '# between']) {
        expect(owned.some((piece) => piece.includes(line))).toBe(false)
      }
      expect(owned.some((piece) => piece.trim() === '')).toBe(false)
    })

    it('excludes a trailing comment from a block value range', () => {
      const source = text('flow: [a, b] # note\nnext: 1')
      const flow = entryOf(source, 'flow')
      expect(source.slice(flow.valueStart, flow.valueEnd)).toBe('[a, b]')
      expect(flow.valueText).toBe('[a, b]')
      expect(source.slice(flow.start, flow.end)).toBe(
        text('flow: [a, b] # note\n'),
      )
    })

    it('treats an empty value as a scalar', () => {
      const source = text('empty:\nnext: 1')
      const empty = entryOf(source, 'empty')
      expect(empty.kind).toBe('scalar')
      expect(empty.valueText).toBe('')
      expect(empty.valueStart).toBe(empty.valueEnd)
    })

    it('flags several placeholders and duplicate keys without going unsupported', () => {
      const source = text('a: 1\n: ""\n:\n: "x" # c\na: 2\nb: 3')
      const map = entries(source)
      expect(
        map.map((entry) => [entry.key, entry.kind, entry.duplicate]),
      ).toEqual([
        ['a', 'scalar', true],
        ['', 'placeholder', false],
        ['', 'placeholder', false],
        ['', 'placeholder', false],
        ['a', 'scalar', true],
        ['b', 'scalar', false],
      ])
      expect(map[1]?.valueText).toBe('')
      expect(map[3]?.valueText).toBe('x')
      // Placeholder key range is empty and sits at the `:`.
      expect(map[1]?.keyStart).toBe(map[1]?.keyEnd)
      expect(source[map[1]?.keyStart ?? -1]).toBe(':')
    })

    it('treats a quoted empty key as a placeholder', () => {
      const [only] = entries('"": v')
      expect(only?.kind).toBe('placeholder')
      expect(only?.key).toBe('')
    })

    it('maps empty and comment-only text to no entries', () => {
      expect(mapFrontMatterEntries('')).toEqual({
        status: 'entries',
        entries: [],
        eol: '\n',
      })
      const map = mapFrontMatterEntries(text('# only\n# comments'))
      expect(map.status).toBe('entries')
      if (map.status === 'entries') expect(map.entries).toEqual([])
    })

    it('keeps anchors, tags and aliases in the value range as block values', () => {
      const source = text('a: &x 1\nb: *x\nc: !!str 2\nd: &y\n  - 1')
      expect(entries(source).map((entry) => entry.kind)).toEqual([
        'block',
        'block',
        'block',
        'block',
      ])
      expect(entryOf(source, 'a').valueText).toBe('&x 1')
      expect(entryOf(source, 'b').valueText).toBe('*x')
      expect(entryOf(source, 'c').valueText).toBe('!!str 2')
      const edited = must(editFrontMatterValue(source, 0, '&x 5'))
      expect(edited).toBe(source.replace('a: &x 1', 'a: &x 5'))
    })

    it.each([
      ['a list', '- a\n- b'],
      ['a flow map', '{a: 1}'],
      ['a scalar', 'just text'],
      ['an unterminated quote', 'x: "open\nnext: 1'],
      ['bad indentation', 'a: 1\n  b: 2'],
      ['a key without a value', 'a: b\nc'],
      ['an unterminated flow list', 'a: [1, 2'],
      ['a second document', 'a: 1\n---\nb: 2'],
      ['an explicit key', '? c\n: d'],
      ['an anchored key', '&k a: 1'],
      ['a tagged key', '!!str a: 1'],
      ['a flow key', '[a]: 1'],
    ])('reports %s as unsupported', (_label, source) => {
      const map = mapFrontMatterEntries(text(source))
      expect(map.status).toBe('unsupported')
      if (map.status === 'unsupported')
        expect(map.reason.length).toBeGreaterThan(0)
      expect(editFrontMatterValue(text(source), 0, 'x')).toBeNull()
      expect(renameFrontMatterKey(text(source), 0, 'x')).toBeNull()
      expect(removeFrontMatterEntry(text(source), 0)).toBeNull()
      expect(moveFrontMatterEntry(text(source), 0, 1)).toBeNull()
    })
  })

  describe('byte identity of untouched text', () => {
    const count = entries(base).length

    it.each(Array.from({ length: count }, (_value, index) => [index]))(
      'editFrontMatterValue changes only the value range of entry %i',
      (index) => {
        const entry = entries(base)[index]
        if (!entry) throw new Error('missing entry')
        const after = must(
          editFrontMatterValue(
            base,
            index,
            // A block value that starts on a later line is written verbatim, line break included.
            entry.kind === 'block'
              ? `${/^\r?\n/.test(entry.valueText) ? '\n  ' : ''}zzz`
              : 'changed value',
          ),
        )
        expect(after).not.toBe(base)
        expectOnlyRangeChanged(base, after, entry.valueStart, entry.valueEnd)
        // The key and the other entries survive.
        expect(entries(after).map((e) => e.key)).toEqual(
          entries(base).map((e) => e.key),
        )
      },
    )

    it.each(Array.from({ length: count }, (_value, index) => [index]))(
      'renameFrontMatterKey changes only the key range of entry %i',
      (index) => {
        const entry = entries(base)[index]
        if (!entry) throw new Error('missing entry')
        const after = must(renameFrontMatterKey(base, index, 'renamed'))
        expectOnlyRangeChanged(base, after, entry.keyStart, entry.keyEnd)
        expect(entries(after)[index]?.key).toBe('renamed')
        expect(entries(after)[index]?.valueText).toBe(entry.valueText)
      },
    )

    it.each(Array.from({ length: count }, (_value, index) => [index]))(
      'removeFrontMatterEntry deletes only the lines of entry %i',
      (index) => {
        const entry = entries(base)[index]
        if (!entry) throw new Error('missing entry')
        const after = must(removeFrontMatterEntry(base, index))
        expect(after.length).toBeLessThan(base.length)
        const remaining = entries(base)
          .filter((candidate) => candidate.index !== index)
          .map((candidate) => candidate.key)
        expect(entries(after).map((e) => e.key)).toEqual(remaining)
        expect(after).not.toContain('\r\r')
        // Comments and the blank line are untouched.
        expect(after).toContain('# header comment')
        expect(after).toContain('# between')
      },
    )
  })

  describe('editFrontMatterValue', () => {
    it('keeps a plain scalar plain and the trailing comment', () => {
      expect(must(editFrontMatterValue(base, 0, 'New title'))).toBe(
        base.replace('title: Hello # trailing', 'title: New title # trailing'),
      )
    })

    it('keeps single quotes and re-escapes the quote character', () => {
      expect(must(editFrontMatterValue(base, 1, "o'k"))).toBe(
        base.replace("'single': 'it''s'", "'single': 'o''k'"),
      )
    })

    it('keeps double quotes and re-escapes quotes and backslashes', () => {
      expect(must(editFrontMatterValue(base, 2, 'a "b" \\ c'))).toBe(
        base.replace(
          '"double": "say \\"hi\\""',
          '"double": "a \\"b\\" \\\\ c"',
        ),
      )
    })

    it('writes a line break inside a single-line scalar as a double-quoted escape', () => {
      expect(must(editFrontMatterValue(base, 9, 'a\nb'))).toBe(
        base.replace('last: end', 'last: "a\\nb"'),
      )
      expect(must(editFrontMatterValue(base, 1, 'a\nb'))).toBe(
        base.replace("'single': 'it''s'", '\'single\': "a\\nb"'),
      )
    })

    it.each([
      'true',
      'false',
      '1',
      '1.5',
      'null',
      '~',
      '#comment',
      'a: b',
      'a #b',
      '- x',
      '[x]',
      '{x: 1}',
      '*alias',
      '&anchor x',
      '!tag x',
      '| x',
      '"q"',
      "'q'",
      '@at',
      '%pct',
      ' lead',
      'trail ',
      'tab\there',
    ])(
      'quotes %j when a plain scalar would change type or meaning',
      (typed) => {
        const after = must(editFrontMatterValue(base, 9, typed))
        expect(after).toBe(
          base.replace('last: end', `last: ${JSON.stringify(typed)}`),
        )
        expect(entryOf(after, 'last').valueText).toBe(typed)
      },
    )

    it.each([
      'hello world',
      'v2.0',
      '2024-01-02',
      'a#b',
      'a:b',
      'ünï',
      'x - y',
    ])('keeps %j plain', (typed) => {
      expect(must(editFrontMatterValue(base, 9, typed))).toBe(
        base.replace('last: end', `last: ${typed}`),
      )
    })

    it('writes empty text as an empty double-quoted string', () => {
      expect(must(editFrontMatterValue(base, 9, ''))).toBe(
        base.replace('last: end', 'last: ""'),
      )
      expect(must(editFrontMatterValue(base, 1, ''))).toBe(
        base.replace("'single': 'it''s'", '\'single\': ""'),
      )
    })

    it('fills an empty value behind the colon and keeps a trailing comment', () => {
      const source = text('a:\nb: # note\nc:')
      expect(must(editFrontMatterValue(source, 0, 'x'))).toBe(
        text('a: x\nb: # note\nc:'),
      )
      expect(must(editFrontMatterValue(source, 1, 'y'))).toBe(
        text('a:\nb: y # note\nc:'),
      )
      expect(must(editFrontMatterValue(source, 2, 'z'))).toBe(
        text('a:\nb: # note\nc: z'),
      )
      expect(must(editFrontMatterValue(source, 2, ''))).toBe(
        text('a:\nb: # note\nc: ""'),
      )
    })

    it('writes a block value verbatim, with the document line breaks', () => {
      const source = text('before: 1\nlist:\n  - a\n  - b\nafter: 2')
      const next = must(
        editFrontMatterValue(source, 1, '\n  - x\n  - y\n  - z'),
      )
      expect(next).toBe(text('before: 1\nlist:\n  - x\n  - y\n  - z\nafter: 2'))
      // A bare LF typed into a CRLF document becomes CRLF.
      expect(must(editFrontMatterValue(source, 1, '\n  - q\n  - r'))).toBe(
        text('before: 1\nlist:\n  - q\n  - r\nafter: 2'),
      )
    })

    it('edits block scalars, flow collections and multi-line text as source', () => {
      expect(must(editFrontMatterValue(base, 5, '|\n  new line'))).toBe(
        base.replace(
          text('lit: |\n  line one\n  line two'),
          text('lit: |\n  new line'),
        ),
      )
      expect(must(editFrontMatterValue(base, 6, '>\n  other'))).toBe(
        base.replace(text('fold: >-\n  folded'), text('fold: >\n  other')),
      )
      expect(must(editFrontMatterValue(base, 7, '[a, b, c]'))).toBe(
        base.replace('flow: [a, b]', 'flow: [a, b, c]'),
      )
      expect(must(editFrontMatterValue(base, 8, 'single line now'))).toBe(
        base.replace(text('multi: plain\n  more'), 'multi: single line now'),
      )
    })

    it('writes a block value that no longer parses, as typed', () => {
      const source = text('a: [x]\nb: 1')
      expect(must(editFrontMatterValue(source, 0, '[x, ('))).toBe(
        text('a: [x, (\nb: 1'),
      )
    })

    it('fills the value of a placeholder', () => {
      const source = text('a: 1\n: ""\n:\nb: 2')
      expect(must(editFrontMatterValue(source, 1, 'filled'))).toBe(
        text('a: 1\n: "filled"\n:\nb: 2'),
      )
      expect(must(editFrontMatterValue(source, 2, 'later'))).toBe(
        text('a: 1\n: ""\n: later\nb: 2'),
      )
    })

    it('returns null for an out-of-range index', () => {
      for (const index of [-1, 10, 99, 1.5, Number.NaN]) {
        expect(editFrontMatterValue(base, index, 'x')).toBeNull()
      }
    })
  })

  describe('renameFrontMatterKey', () => {
    it('keeps the value bytes, the trailing comment and the key quote style', () => {
      expect(must(renameFrontMatterKey(base, 0, 'headline'))).toBe(
        base.replace('title: Hello # trailing', 'headline: Hello # trailing'),
      )
      expect(must(renameFrontMatterKey(base, 1, "x'y"))).toBe(
        base.replace("'single': 'it''s'", "'x''y': 'it''s'"),
      )
      expect(must(renameFrontMatterKey(base, 2, 'a "b"'))).toBe(
        base.replace('"double": "say \\"hi\\""', '"a \\"b\\"": "say \\"hi\\""'),
      )
    })

    it('keeps a plain key plain when it reads back and quotes it otherwise', () => {
      expect(must(renameFrontMatterKey(base, 9, 'two words'))).toBe(
        base.replace('last: end', 'two words: end'),
      )
      for (const typed of [
        'true',
        '1',
        'null',
        '~',
        '#x',
        'a: b',
        'a #b',
        '- x',
      ]) {
        const after = must(renameFrontMatterKey(base, 9, typed))
        expect(after).toBe(
          base.replace('last: end', `${JSON.stringify(typed)}: end`),
        )
        expect(entryOf(after, typed).valueText).toBe('end')
      }
    })

    it('writes empty text as an empty double-quoted key (a placeholder)', () => {
      const after = must(renameFrontMatterKey(base, 9, ''))
      expect(after).toBe(base.replace('last: end', '"": end'))
      expect(entries(after)[9]?.kind).toBe('placeholder')
    })

    it('gives a placeholder its first key in front of the colon', () => {
      const source = text('a: 1\n: ""\n:\n: "x" # c\nb: 2')
      expect(must(renameFrontMatterKey(source, 1, 'first'))).toBe(
        text('a: 1\nfirst: ""\n:\n: "x" # c\nb: 2'),
      )
      expect(must(renameFrontMatterKey(source, 2, 'second'))).toBe(
        text('a: 1\n: ""\nsecond:\n: "x" # c\nb: 2'),
      )
      expect(must(renameFrontMatterKey(source, 3, 'true'))).toBe(
        text('a: 1\n: ""\n:\n"true": "x" # c\nb: 2'),
      )
    })

    it('writes a rename to an existing key as typed and flags both entries', () => {
      const source = text('a: 1\nb: 2\nc: 3')
      const after = must(renameFrontMatterKey(source, 2, 'a'))
      expect(after).toBe(text('a: 1\nb: 2\na: 3'))
      const map = entries(after)
      expect(map.map((entry) => entry.duplicate)).toEqual([true, false, true])
      expect(map.map((entry) => entry.valueText)).toEqual(['1', '2', '3'])
    })

    it('returns null for an out-of-range index', () => {
      for (const index of [-1, 10, 99]) {
        expect(renameFrontMatterKey(base, index, 'x')).toBeNull()
      }
    })
  })

  describe('removeFrontMatterEntry', () => {
    it('removes the lines of a middle entry and leaves comments and blank lines', () => {
      const source = text('a: 1\n# keep\n\nb: 2 # gone\n\nc: 3')
      expect(must(removeFrontMatterEntry(source, 1))).toBe(
        text('a: 1\n# keep\n\n\nc: 3'),
      )
    })

    it('removes a multi-line entry in one piece', () => {
      expect(must(removeFrontMatterEntry(base, 3))).toBe(
        base.replace(text('tags:\n  - a\n  - b\n'), ''),
      )
      expect(must(removeFrontMatterEntry(base, 5))).toBe(
        base.replace(text('lit: |\n  line one\n  line two\n'), ''),
      )
    })

    it('removes the first entry', () => {
      const source = text('a: 1\nb: 2')
      expect(must(removeFrontMatterEntry(source, 0))).toBe('b: 2')
    })

    it('removes the last entry together with the line break before it', () => {
      const source = text('a: 1\nb: 2\nc: 3')
      expect(must(removeFrontMatterEntry(source, 2))).toBe(text('a: 1\nb: 2'))
      expect(must(removeFrontMatterEntry(text('a: 1'), 0))).toBe('')
    })

    it('keeps a trailing line break when the text had one', () => {
      const source = text('a: 1\nb: 2\n')
      expect(must(removeFrontMatterEntry(source, 1))).toBe(text('a: 1\n'))
    })

    it('removes one placeholder out of several', () => {
      const source = text('a: 1\n: ""\n: ""\n: ""')
      expect(must(removeFrontMatterEntry(source, 2))).toBe(
        text('a: 1\n: ""\n: ""'),
      )
    })

    it('returns null for an out-of-range index', () => {
      for (const index of [-1, 10, 99]) {
        expect(removeFrontMatterEntry(base, index)).toBeNull()
      }
    })
  })

  describe('moveFrontMatterEntry', () => {
    it('swaps two neighbouring entries and nothing else', () => {
      const source = text('a: 1\nb: 2\nc: 3\nd: 4')
      expect(must(moveFrontMatterEntry(source, 1, 1))).toBe(
        text('a: 1\nc: 3\nb: 2\nd: 4'),
      )
      expect(must(moveFrontMatterEntry(source, 2, -1))).toBe(
        text('a: 1\nc: 3\nb: 2\nd: 4'),
      )
    })

    it('leaves comment and blank lines between the entries in place', () => {
      const source = text('a: 1 # one\n\n# between\nb: 2\nc: 3')
      expect(must(moveFrontMatterEntry(source, 0, 1))).toBe(
        text('b: 2\n\n# between\na: 1 # one\nc: 3'),
      )
    })

    it('moves multi-line entries as whole line ranges', () => {
      const source = text('list:\n  - a\n  - b\nblock: |\n  x\n  y\nlast: z')
      expect(must(moveFrontMatterEntry(source, 0, 1))).toBe(
        text('block: |\n  x\n  y\nlist:\n  - a\n  - b\nlast: z'),
      )
      expect(must(moveFrontMatterEntry(source, 2, -1))).toBe(
        text('list:\n  - a\n  - b\nlast: z\nblock: |\n  x\n  y'),
      )
    })

    it('moves the last entry without a line break up and down again', () => {
      const source = text('a: 1\nb: 2')
      const up = must(moveFrontMatterEntry(source, 1, -1))
      expect(up).toBe(text('b: 2\na: 1'))
      expect(must(moveFrontMatterEntry(up, 0, 1))).toBe(source)
    })

    it('keeps the trailing line break when the text had one', () => {
      const source = text('a: 1\nb: 2\n')
      expect(must(moveFrontMatterEntry(source, 0, 1))).toBe(
        text('b: 2\na: 1\n'),
      )
    })

    it('reorders placeholders and duplicate keys', () => {
      const source = text('x: 1\n: ""\nx: 2')
      expect(must(moveFrontMatterEntry(source, 1, 1))).toBe(
        text('x: 1\nx: 2\n: ""'),
      )
    })

    it('returns null when there is no neighbour or the index is out of range', () => {
      const source = text('a: 1\nb: 2')
      expect(moveFrontMatterEntry(source, 0, -1)).toBeNull()
      expect(moveFrontMatterEntry(source, 1, 1)).toBeNull()
      expect(moveFrontMatterEntry(source, -1, 1)).toBeNull()
      expect(moveFrontMatterEntry(source, 5, -1)).toBeNull()
    })
  })

  describe('appendFrontMatterPlaceholder', () => {
    it('adds an empty-key line as the last line, behind a line break', () => {
      expect(appendFrontMatterPlaceholder(text('a: 1\nb: 2'))).toBe(
        text('a: 1\nb: 2\n: ""'),
      )
    })

    it('keeps a trailing line break when the text had one', () => {
      expect(appendFrontMatterPlaceholder(text('a: 1\n'))).toBe(
        text('a: 1\n: ""\n'),
      )
    })

    it('adds the line to empty text', () => {
      expect(appendFrontMatterPlaceholder('')).toBe(': ""')
    })

    it('adds one line per call and every line maps as a placeholder', () => {
      let next = text('a: 1 # c\n# tail comment')
      for (let count = 0; count < 3; count += 1) {
        next = appendFrontMatterPlaceholder(next)
      }
      expect(next).toBe(text('a: 1 # c\n# tail comment\n: ""\n: ""\n: ""'))
      expect(entries(next).map((entry) => entry.kind)).toEqual([
        'scalar',
        'placeholder',
        'placeholder',
        'placeholder',
      ])
    })

    it('leaves every existing byte in place', () => {
      const after = appendFrontMatterPlaceholder(base)
      expect(after.startsWith(base)).toBe(true)
      expect(after.slice(base.length)).toBe(`${eol}: ""`)
    })
  })
})

describe('front-matter edit core (single-line text)', () => {
  it('uses LF when the text has no line break', () => {
    const map = mapFrontMatterEntries('a: 1')
    expect(map.status === 'entries' && map.eol).toBe('\n')
    expect(appendFrontMatterPlaceholder('a: 1')).toBe('a: 1\n: ""')
  })
})

// Task 725 UI step: a plain number, boolean or null edited in the table keeps its type when the new
// text is itself one plain scalar (the table edits `count: 3` to `4`, not to `"4"`).
describe('typed plain values', () => {
  it.each([
    ['count: 3', '4', 'count: 4'],
    ['count: 3', '4.5', 'count: 4.5'],
    ['flag: true', 'false', 'flag: false'],
    ['flag: true', 'maybe', 'flag: maybe'],
    ['none: ~', 'null', 'none: null'],
    ['empty:', '5', 'empty: 5'],
    ['count: 3 # c', '7', 'count: 7 # c'],
  ])('%s edited to %j gives %s', (source, text, expected) => {
    expect(editFrontMatterValue(source, 0, text)).toBe(expected)
  })

  it.each([
    ['count: 3', 'a: b'],
    ['count: 3', '#x'],
    ['count: 3', '[x]'],
    ['count: 3', ' lead'],
  ])('%s edited to %j is quoted (not one plain scalar)', (source, text) => {
    expect(editFrontMatterValue(source, 0, text)).toBe(
      `count: ${JSON.stringify(text)}`,
    )
  })

  it('a plain string value still quotes text that would read back as another type', () => {
    expect(editFrontMatterValue('name: Ann', 0, '4')).toBe('name: "4"')
  })
})
