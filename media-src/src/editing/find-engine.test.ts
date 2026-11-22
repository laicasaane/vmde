import { describe, expect, it } from 'vitest'
import { blockIndexForSourceLine, offsetToLine } from '../util/source-map'
import {
  findMarkdownMatches,
  type MarkdownFindOptions,
  replaceAllMarkdownMatches,
  replaceMarkdownMatch,
} from './find-engine'

// The pre-rework engine (Task 196, 2026-08-31), kept verbatim as the oracle: the rework only
// removes its per-offset slicing and per-match whole-document rescans, never its results.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a verbatim copy of the old engine is the oracle; restructuring it would weaken the comparison.
function referenceMatches(
  markdown: string,
  query: string,
  options: MarkdownFindOptions,
) {
  const fold = (value: string) =>
    value.toLocaleLowerCase().replaceAll('\u0307', '')
  const word = /[\p{L}\p{N}\p{M}_]/u
  const whole = (start: number, end: number) => {
    const beforeStart =
      start > 1 &&
      /[\uDC00-\uDFFF]/.test(markdown[start - 1] ?? '') &&
      /[\uD800-\uDBFF]/.test(markdown[start - 2] ?? '')
        ? start - 2
        : start - 1
    const before =
      start > 0
        ? String.fromCodePoint(markdown.codePointAt(beforeStart)!)
        : undefined
    const after =
      end < markdown.length
        ? String.fromCodePoint(markdown.codePointAt(end)!)
        : undefined
    return !(
      (before !== undefined && word.test(before)) ||
      (after !== undefined && word.test(after))
    )
  }
  if (!query) return []
  const needle = options.caseSensitive ? query : fold(query)
  const matches: Array<{
    start: number
    end: number
    line: number
    blockIndex: number | null
  }> = []
  let from = 0
  while (from <= markdown.length - query.length) {
    let start = -1
    for (let index = from; index <= markdown.length - query.length; index++) {
      const candidate = markdown.slice(index, index + query.length)
      if ((options.caseSensitive ? candidate : fold(candidate)) === needle) {
        start = index
        break
      }
    }
    if (start < 0) break
    const end = start + query.length
    if (!options.wholeWord || whole(start, end)) {
      const line = offsetToLine(markdown, start)
      matches.push({
        start,
        end,
        line,
        blockIndex: blockIndexForSourceLine(markdown, line),
      })
    }
    from = Math.max(end, start + 1)
  }
  return matches
}

const ALPHABET = [
  'a',
  'A',
  'i',
  'I',
  'İ',
  'ı',
  '̇',
  'σ',
  'ς',
  'Σ',
  'ß',
  'K',
  'k',
  '😀',
  '𐐀',
  '𐐨',
  ' ',
  '\n',
  '\n\n',
  '|',
  '```\n',
  '- ',
  '# ',
  'é',
  'é',
]

function seeded(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

describe('Task 196 find engine', () => {
  it('matches the pre-rework engine on randomized Unicode, Markdown and case-folding inputs', () => {
    const random = seeded(196)
    const pick = () => ALPHABET[Math.floor(random() * ALPHABET.length)]
    for (let sample = 0; sample < 400; sample++) {
      const markdown = Array.from({ length: 60 }, pick).join('')
      const query = Array.from(
        { length: 1 + Math.floor(random() * 3) },
        pick,
      ).join('')
      for (const caseSensitive of [false, true])
        for (const wholeWord of [false, true]) {
          const options = { caseSensitive, wholeWord }
          expect(findMarkdownMatches(markdown, query, options)).toEqual(
            referenceMatches(markdown, query, options),
          )
        }
    }
  })

  it('keeps line and block indexes for many matches across a large document', () => {
    const block = [
      '# Heading target',
      '',
      '| target | x |',
      '|---|---|',
      '| a | target |',
      '',
      '```cs',
      'var target = 1;',
      '```',
      '',
      '- target item',
      '',
    ].join('\n')
    const markdown = block.repeat(200)
    const options = { caseSensitive: false, wholeWord: false }
    const matches = findMarkdownMatches(markdown, 'target', options)
    expect(matches).toHaveLength(1000)
    expect(matches).toEqual(referenceMatches(markdown, 'target', options))
  })

  // A stale match (a source edit landed between the widget's paint and the action, or the current
  // match was never mappable) must decline rather than corrupt an unrelated range.
  it('replaceMarkdownMatch declines a match outside the source bounds', () => {
    const markdown = 'stable text'
    expect(
      replaceMarkdownMatch(
        markdown,
        { start: 5, end: 2, line: 0, blockIndex: null },
        'X',
      ),
    ).toEqual({ changed: false, markdown, replacements: 0, caretOffset: 5 })
    expect(
      replaceMarkdownMatch(
        markdown,
        { start: 4, end: markdown.length + 1, line: 0, blockIndex: null },
        'X',
      ),
    ).toEqual({ changed: false, markdown, replacements: 0, caretOffset: 4 })
    expect(
      replaceMarkdownMatch(
        markdown,
        { start: -1, end: 3, line: 0, blockIndex: null },
        'X',
      ),
    ).toEqual({ changed: false, markdown, replacements: 0, caretOffset: 0 })
  })

  it('replaceAllMarkdownMatches is a no-op on an empty match list', () => {
    const markdown = 'nothing to replace here'
    expect(replaceAllMarkdownMatches(markdown, [], 'X')).toEqual({
      changed: false,
      markdown,
      replacements: 0,
      caretOffset: 0,
    })
  })
})

// Task 733 / 036 (fix design 2.2, step A): Replace returns the hunks it applied, in raw offsets of the
// plan source. The idle check adds normalized offsets and targets. Each fixture proves the inverse
// property in both spaces: the hunks rebuild `after` from `before`, and their old text rebuilds
// `before` from `after`. The functions below do not exist before step A, so each case fails first.
describe('036 replace hunks', () => {
  interface Hunks {
    starts: Int32Array
    ends: Int32Array
    insert: string
  }
  interface Normalized {
    incremental: boolean
    before: string
    after: string
    insert: string
    oldStarts: Int32Array
    oldEnds: Int32Array
    newStarts: Int32Array
    newEnds: Int32Array
  }
  interface HunkApi {
    replaceAllMarkdownMatches(
      markdown: string,
      matches: readonly {
        start: number
        end: number
        line: number
        blockIndex: number | null
      }[],
      replacement: string,
    ): { changed: boolean; markdown: string; hunks?: Hunks }
    replaceMarkdownMatch(
      markdown: string,
      match: {
        start: number
        end: number
        line: number
        blockIndex: number | null
      },
      replacement: string,
    ): { changed: boolean; markdown: string; hunks?: Hunks }
    normalizeReplaceHunks(
      before: string,
      after: string,
      hunks: Hunks,
    ): Normalized
  }
  const api = async (): Promise<HunkApi> =>
    (await import('./find-engine')) as unknown as HunkApi
  const eol = (text: string) => text.replace(/\r\n?/g, '\n')
  const at = (start: number, end: number) => ({
    start,
    end,
    line: 0,
    blockIndex: null,
  })
  const OPTIONS = { caseSensitive: false, wholeWord: false }

  /** Rebuilds `target` from `source` by writing `pieces(i)` over each `[from[i], to[i])`. */
  const splice = (
    source: string,
    from: Int32Array,
    to: Int32Array,
    pieces: (index: number) => string,
  ) => {
    let output = ''
    let cursor = 0
    for (let index = 0; index < from.length; index++) {
      output += source.slice(cursor, from[index]) + pieces(index)
      cursor = to[index]
    }
    return output + source.slice(cursor)
  }

  const fixtures: [string, string, ReturnType<typeof at>[] | string, string][] =
    [
      ['longer', 'a1a2a', 'a', 'XYZ'],
      ['shorter', 'alpha beta alpha', 'alpha', 'o'],
      ['empty replacement', 'x--y--z', '--', ''],
      ['case-insensitive old text', 'Alpha alpha ALPHA', 'alpha', 'b'],
      ['line break in the query', 'a\nb c a\nb', 'a\nb', 'q'],
      ['line break in the replacement', 'one two one', 'one', 'u\nv'],
      [
        'surrogate pairs',
        '\u{1F600}x\u{1F600}y\u{1F601}',
        '\u{1F600}',
        '\u{1F602}\u{1F602}',
      ],
      ['adjacent matches', 'abcd', [at(0, 1), at(1, 2), at(2, 3)], 'ZZ'],
      ['zero-width matches', 'abc', [at(0, 0), at(1, 1), at(3, 3)], '!'],
      ['CRLF document', 'a\r\nb\r\na\r\n', 'a', 'qq'],
      ['CRLF in the replacement', 'a\r\nb\r\na', 'b', 'x\r\ny'],
      ['lone CR', 'a\rb\ra', 'b', 'cc'],
    ]

  it.each(fixtures)(
    '%s: the hunks and their old text are inverse in raw and normalized offsets',
    async (_name, before, query, replacement) => {
      const { replaceAllMarkdownMatches, normalizeReplaceHunks } = await api()
      const matches =
        typeof query === 'string'
          ? findMarkdownMatches(before, query, OPTIONS)
          : query
      expect(matches.length).toBeGreaterThan(0)
      const result = replaceAllMarkdownMatches(before, matches, replacement)
      const hunks = result.hunks!
      expect(hunks.insert).toBe(replacement)
      expect(Array.from(hunks.starts)).toEqual(matches.map((m) => m.start))
      expect(Array.from(hunks.ends)).toEqual(matches.map((m) => m.end))
      // Raw: the hunks rebuild `after` from `before`.
      expect(splice(before, hunks.starts, hunks.ends, () => hunks.insert)).toBe(
        result.markdown,
      )
      const normalized = normalizeReplaceHunks(before, result.markdown, hunks)
      expect(normalized.incremental).toBe(true)
      expect(normalized.before).toBe(eol(before))
      expect(normalized.after).toBe(eol(result.markdown))
      expect(normalized.insert).toBe(eol(replacement))
      for (let index = 0; index < matches.length; index++) {
        // The expected old text of each hunk, read from the plan source at its raw offsets.
        const oldRaw = before.slice(hunks.starts[index], hunks.ends[index])
        expect(
          normalized.before.slice(
            normalized.oldStarts[index],
            normalized.oldEnds[index],
          ),
        ).toBe(eol(oldRaw))
        expect(
          normalized.after.slice(
            normalized.newStarts[index],
            normalized.newEnds[index],
          ),
        ).toBe(normalized.insert)
      }
      // Normalized: Redo direction (before to after) and Undo direction (after to before).
      expect(
        splice(
          normalized.before,
          normalized.oldStarts,
          normalized.oldEnds,
          () => normalized.insert,
        ),
      ).toBe(normalized.after)
      expect(
        splice(
          normalized.after,
          normalized.newStarts,
          normalized.newEnds,
          (index) =>
            normalized.before.slice(
              normalized.oldStarts[index],
              normalized.oldEnds[index],
            ),
        ),
      ).toBe(normalized.before)
    },
  )

  it('a hunk splitting \\r\\n in the plan source marks the hunks not incremental', async () => {
    const { replaceAllMarkdownMatches, normalizeReplaceHunks } = await api()
    const before = 'x\r\ny'
    const result = replaceAllMarkdownMatches(before, [at(1, 2)], 'Q')
    expect(
      normalizeReplaceHunks(before, result.markdown, result.hunks!).incremental,
    ).toBe(false)
  })

  it('a hunk whose insert ends inside a new \\r\\n marks the hunks not incremental', async () => {
    const { replaceAllMarkdownMatches, normalizeReplaceHunks } = await api()
    const before = 'xA\ny'
    const result = replaceAllMarkdownMatches(before, [at(1, 2)], '\r')
    expect(result.markdown).toBe('x\r\ny')
    expect(
      normalizeReplaceHunks(before, result.markdown, result.hunks!).incremental,
    ).toBe(false)
  })

  it('keeps text and offsets without \\r by reference', async () => {
    const { replaceAllMarkdownMatches, normalizeReplaceHunks } = await api()
    const before = 'alpha beta alpha'
    const result = replaceAllMarkdownMatches(
      before,
      findMarkdownMatches(before, 'alpha', OPTIONS),
      'omega',
    )
    const normalized = normalizeReplaceHunks(
      before,
      result.markdown,
      result.hunks!,
    )
    expect(normalized.before).toBe(before)
    expect(normalized.after).toBe(result.markdown)
    expect(normalized.insert).toBe(result.hunks!.insert)
    expect(normalized.oldStarts).toBe(result.hunks!.starts)
    expect(normalized.oldEnds).toBe(result.hunks!.ends)
  })

  it('Replace All allocates the hunk offsets once: both arrays view one buffer', async () => {
    const { replaceAllMarkdownMatches } = await api()
    const before = 'a b a b a'
    const { hunks } = replaceAllMarkdownMatches(
      before,
      findMarkdownMatches(before, 'a', OPTIONS),
      'c',
    )
    expect(hunks!.starts.length).toBe(3)
    expect(hunks!.ends.length).toBe(3)
    expect(hunks!.starts.buffer).toBe(hunks!.ends.buffer)
  })

  it('Replace records one hunk; a declined match records none', async () => {
    const { replaceMarkdownMatch } = await api()
    const one = replaceMarkdownMatch('a b a', at(4, 5), 'zz')
    expect(Array.from(one.hunks!.starts)).toEqual([4])
    expect(Array.from(one.hunks!.ends)).toEqual([5])
    expect(one.hunks!.insert).toBe('zz')
    expect(replaceMarkdownMatch('a b a', at(4, 9), 'zz').hunks).toBeUndefined()
  })
})
