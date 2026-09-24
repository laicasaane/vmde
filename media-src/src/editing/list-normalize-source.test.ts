import { describe, expect, test } from 'vitest'
import {
  findTaskListMarkers,
  normalizeOrderedListsSource,
} from './list-normalize-source'
import * as sourceListScanner from './list-normalize-source'
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

  test('does not promote indented code after a closed list into a lookback-owned child list', () => {
    const source = [
      '1. closed root',
      '',
      'outside prose closes the root',
      '',
      '    7. code-looking',
      '    3. code-looking stale',
      '',
      '9. real root',
      '3. real stale',
    ].join('\n')

    const result = normalizeOrderedListsSource(source, 0, 'all')

    expect(result?.markdown).toBe(
      source.replace('3. real stale', '10. real stale'),
    )
    expect(result?.changedRoots).toBe(1)
  })

  test('keeps a quoted ordered child under its indented list owner', () => {
    const source = [
      '1. outer',
      '   > 4. quoted child',
      '   > 9. quoted stale',
      '2. sibling',
    ].join('\n')

    const result = normalizeOrderedListsSource(
      source,
      source.indexOf('quoted stale'),
      'caret',
    )

    expect(result?.markdown).toBe(
      source.replace('> 9. quoted stale', '> 5. quoted stale'),
    )
    expect(result?.changedRoots).toBe(1)
  })

  test('maps both UTF-16 selection endpoints through marker and continuation-width edits', () => {
    const source = [
      '9. parent',
      '9. second',
      '   9. child 😀 selected',
      '   9. stale child',
    ].join('\r\n')
    const start = source.indexOf('😀')
    const end = source.indexOf('selected') + 'selected'.length

    const result = normalizeOrderedListsSource(source, start, 'all', end)

    expect(result?.markdown.slice(result.startOffset, result.endOffset)).toBe(
      '😀 selected',
    )
    expect(result?.markdown).toContain('\r\n    9. child 😀 selected')
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

describe('source task-list marker scanning', () => {
  test('returns exact marker spans for nested and separate lists, preserving checked state', () => {
    const source = [
      '- [ ] unchecked root',
      '  - [x] checked child',
      '  - [X] uppercase checked child',
      '- ordinary item',
      '- text [ ] is not a task marker',
      '',
      'A prose paragraph closes the first list.',
      '',
      '1. [ ] ordered root',
      '2. [x] ordered next',
    ].join('\r\n')
    const markers = findTaskListMarkers(source)

    expect(
      markers.map((marker) =>
        source.slice(marker.startOffset, marker.endOffset),
      ),
    ).toEqual(['[ ]', '[x]', '[X]', '[ ]', '[x]'])
    expect(markers.map((marker) => marker.checked)).toEqual([
      false,
      true,
      true,
      false,
      true,
    ])
    expect(
      markers.map((marker) => [marker.startOffset, marker.endOffset]),
    ).toEqual([
      [source.indexOf('[ ] unchecked'), source.indexOf('[ ] unchecked') + 3],
      [source.indexOf('[x] checked'), source.indexOf('[x] checked') + 3],
      [source.indexOf('[X] uppercase'), source.indexOf('[X] uppercase') + 3],
      [source.indexOf('[ ] ordered'), source.indexOf('[ ] ordered') + 3],
      [source.indexOf('[x] ordered'), source.indexOf('[x] ordered') + 3],
    ])
  })

  test('exposes root, quote, and nested list-item identity for rendered checkbox pairing', () => {
    const source = [
      '- [ ] root one',
      '  - [x] nested child',
      '- [ ] root two',
      '',
      '- ordinary list without a task',
      '- another ordinary item',
      '',
      '> [!NOTE]',
      '> - [X] quoted callout task',
    ].join('\n')
    const markers = findTaskListMarkers(source)

    expect(
      markers.map((marker) => {
        const located = marker as any
        return {
          rootIndex: located.rootIndex,
          quoteDepth: located.quoteDepth,
          containerPath: located.containerPath,
        }
      }),
    ).toEqual([
      {
        rootIndex: 0,
        quoteDepth: 0,
        containerPath: [{ listType: 'ul', itemIndex: 0 }],
      },
      {
        rootIndex: 0,
        quoteDepth: 0,
        containerPath: [
          { listType: 'ul', itemIndex: 0 },
          { listType: 'ul', itemIndex: 0 },
        ],
      },
      {
        rootIndex: 0,
        quoteDepth: 0,
        containerPath: [{ listType: 'ul', itemIndex: 1 }],
      },
      {
        rootIndex: 2,
        quoteDepth: 1,
        containerPath: [{ listType: 'ul', itemIndex: 0 }],
      },
    ])
  })

  test('finds task markers in blockquotes and callouts, including nested quoted lists', () => {
    const source = [
      '> [!NOTE]',
      '> - [ ] callout task',
      '>   - [x] nested callout task',
      '> [!TIP]',
      '> 1. [X] ordered callout task',
      '> > - [ ] nested quoted task',
    ].join('\n')
    const markers = findTaskListMarkers(source)

    expect(
      markers.map((marker) =>
        source.slice(marker.startOffset, marker.endOffset),
      ),
    ).toEqual(['[ ]', '[x]', '[X]', '[ ]'])
    expect(markers.map((marker) => marker.checked)).toEqual([
      false,
      true,
      true,
      false,
    ])
  })

  test('ignores task-looking text in fences, raw HTML, standalone indented code, and inline prose', () => {
    const fence = String.fromCharCode(96).repeat(3)
    const source = [
      `${fence}markdown`,
      '- [ ] fenced marker',
      fence,
      '',
      '<div>',
      '- [x] raw HTML marker',
      '</div>',
      '',
      '    - [ ] indented code marker',
      '',
      '- [ ]foo missing required separator',
      '- [x]bar missing required separator',
      '- prose [ ] inline lookalike',
      '- \\[ ] escaped lookalike',
      '- \\u0060[ ]\\u0060 inline-code lookalike',
      '- [ ] real task',
    ].join('\n')
    const markers = findTaskListMarkers(source)

    expect(markers).toHaveLength(1)
    expect(source.slice(markers[0]!.startOffset, markers[0]!.endOffset)).toBe(
      '[ ]',
    )
    expect(markers[0]?.checked).toBe(false)
    expect(markers[0]?.startOffset).toBe(source.lastIndexOf('[ ] real task'))
  })

  test('pairs rendered checkbox identities with exact source markers and fails closed on mismatch', () => {
    const matchTaskListControls = (sourceListScanner as any)
      .matchTaskListControls
    expect(typeof matchTaskListControls).toBe('function')
    if (typeof matchTaskListControls !== 'function') return

    const source = [
      '- [ ] root task',
      '  - [ ] nested task',
      '',
      'A paragraph separates the next source list.',
      '',
      '> [!NOTE]',
      '> - [x] callout task',
    ].join('\n')
    const markers = findTaskListMarkers(source)
    const identities = markers.map(
      ({ checked, rootIndex, quoteDepth, containerPath }) => ({
        checked,
        rootIndex,
        quoteDepth,
        containerPath,
      }),
    )

    expect(matchTaskListControls(source, identities)).toEqual(markers)
    expect(matchTaskListControls(source, identities.slice(1))).toBeNull()
    expect(
      matchTaskListControls(source, [
        { ...identities[0], checked: true },
        ...identities.slice(1),
      ]),
    ).toBeNull()
    expect(
      matchTaskListControls(source, [
        { ...identities[0], rootIndex: identities[0]!.rootIndex + 1 },
        ...identities.slice(1),
      ]),
    ).toBeNull()
    expect(
      matchTaskListControls(source, [
        { ...identities[0], containerPath: [] },
        ...identities.slice(1),
      ]),
    ).toBeNull()
    expect(
      matchTaskListControls(source, [
        { ...identities[0], quoteDepth: 2 },
        ...identities.slice(1),
      ]),
    ).toBeNull()
  })

  test('accepts an empty task item with no trailing content', () => {
    const source = '- [ ]\n- [x]'
    const markers = findTaskListMarkers(source)

    expect(
      markers.map((marker) =>
        source.slice(marker.startOffset, marker.endOffset),
      ),
    ).toEqual(['[ ]', '[x]'])
    expect(markers.map((marker) => marker.checked)).toEqual([false, true])
  })
})
