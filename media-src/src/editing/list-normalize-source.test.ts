import { describe, expect, test } from 'vitest'
import { normalizeOrderedListsSource } from './list-normalize-source'

describe('source ordered-list normalization', () => {
  test('renumbers only the outer list containing the caret while preserving its start and delimiter', () => {
    const source = ['before  ', '03) alpha', '08) beta', '', 'after'].join(
      '\r\n',
    )
    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('beta') + 2,
      'caret',
    )

    expect(result).toEqual({
      markdown: ['before  ', '03) alpha', '04) beta', '', 'after'].join('\r\n'),
      changedRoots: 1,
      startOffset: source.indexOf('beta') + 2,
      endOffset: source.indexOf('beta') + 2,
    })
  })

  test('renumbers ordered descendants without changing bullet text, nested ownership, or following bytes', () => {
    const source = [
      '- parent',
      '  9. nested',
      '  12. second',
      '- sibling',
      '',
      'literal 12. prose',
    ].join('\n')
    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('second'),
      'caret',
      source.indexOf('second') + 3,
    )

    expect(result?.markdown).toBe(
      [
        '- parent',
        '  9. nested',
        '  10. second',
        '- sibling',
        '',
        'literal 12. prose',
      ].join('\n'),
    )
    expect(result?.changedRoots).toBe(1)
    expect(result?.markdown.slice(result.startOffset, result.endOffset)).toBe(
      'sec',
    )
  })

  test('adjusts owned continuation and child indentation when a marker gains a digit', () => {
    const source = [
      '9. parent',
      '9. second',
      '   continuation',
      '   4. child',
      '   9. stale child',
      '      child continuation',
    ].join('\n')
    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('second'),
      'all',
    )

    expect(result?.markdown).toBe(
      [
        '9. parent',
        '10. second',
        '    continuation',
        '    4. child',
        '    5. stale child',
        '       child continuation',
      ].join('\n'),
    )
  })

  test('keeps fenced, indented-code, escaped, and ten-digit marker lookalikes byte-identical', () => {
    const source = [
      '```md',
      '1. fake',
      '9. fake',
      '```',
      '',
      '    1. code',
      '\\9. escaped',
      '1000000000. prose',
      '',
      '> 4. quote',
      '> 9. second',
    ].join('\n')
    const result = normalizeOrderedListsSource(source, 0, 'all')

    expect(result?.markdown).toBe(source.replace('> 9. second', '> 5. second'))
    expect(result?.changedRoots).toBe(1)
  })

  test('recognizes a four-space ordered child of a list but leaves standalone indented code untouched', () => {
    const source = [
      '1. parent',
      '    4. child',
      '    9. stale',
      '',
      '    1. code',
      '    9. code',
    ].join('\n')
    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('stale'),
      'caret',
    )

    expect(result?.markdown).toBe(
      source.replace('    9. stale', '    5. stale'),
    )
  })

  test('does not treat front matter, raw HTML, math, or comments as source lists', () => {
    const source = [
      '---',
      '9. front',
      '---',
      '',
      '<script>',
      '1. raw',
      '9. raw',
      '</script>',
      '',
      '$$',
      '1. math',
      '9. math',
      '$$',
      '',
      '<!--',
      '1. comment',
      '9. comment',
      '-->',
      '',
      '4. real',
      '9. stale',
    ].join('\n')
    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('real'),
      'all',
    )

    expect(result?.markdown).toBe(source.replace('9. stale', '5. stale'))
  })

  test('keeps canonical lists and a caret outside any list as true no-ops', () => {
    const source = '1. one\n2. two\n\nplain\n'

    expect(
      normalizeOrderedListsSource(source, source.indexOf('plain'), 'caret'),
    ).toBeNull()
    expect(normalizeOrderedListsSource(source, 0, 'all')).toBeNull()
  })
})
