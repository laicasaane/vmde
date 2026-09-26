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
