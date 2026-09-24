import { describe, expect, it } from 'vitest'
import {
  blockActionPreparePayload,
  planBlockAction,
  planBlockMove,
  planBlockDelete,
  planBlockDuplicate,
  scanMovableBlocks,
} from '../../src/shared/block-move'

function startOf(markdown: string, needle: string, occurrence = 0): number {
  let from = 0
  let found = -1
  for (let index = 0; index <= occurrence; index++) {
    found = markdown.indexOf(needle, from)
    if (found < 0) throw new Error(`missing ${needle}`)
    from = found + needle.length
  }
  return found
}

describe('Task 259 exact block moves', () => {
  it.each([
    [
      'middle before first',
      'A\n\nB\n\nC\n',
      'B',
      'A',
      'before',
      'B\n\nA\n\nC\n',
    ],
    ['middle after last', 'A\n\nB\n\nC\n', 'B', 'C', 'after', 'A\n\nC\n\nB\n'],
    ['final no-newline before first', 'A\n\nB', 'B', 'A', 'before', 'B\n\nA'],
    ['first to final no-newline', 'A\n\nB', 'A', 'B', 'after', 'B\n\nA'],
    [
      'CRLF middle',
      'A\r\n\r\nB\r\n\r\nC\r\n',
      'B',
      'A',
      'before',
      'B\r\n\r\nA\r\n\r\nC\r\n',
    ],
  ] as const)(
    '%s preserves exact separators and terminal newline state',
    (_name, markdown, source, target, placement, expected) => {
      const result = planBlockMove(
        markdown,
        startOf(markdown, source),
        startOf(markdown, target),
        placement,
      )
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(result.markdown).toBe(expected)
    },
  )

  it('moves an entire fenced block without detaching its info or body', () => {
    const markdown = 'before\n\n```ts\nconst x = 1\n```\n\nafter\n'
    const result = planBlockMove(
      markdown,
      startOf(markdown, '```ts'),
      startOf(markdown, 'after'),
      'after',
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok')
      expect(result.markdown).toBe(
        'before\n\nafter\n\n```ts\nconst x = 1\n```\n',
      )
  })

  it('moves one list item with its nested children as one source chunk', () => {
    const markdown = '- parent\n  - child\n- sibling\n- third\n'
    const result = planBlockMove(
      markdown,
      startOf(markdown, '- parent'),
      startOf(markdown, '- sibling'),
      'after',
    )
    expect(result.status).toBe('ok')
    if (result.status === 'ok')
      expect(result.markdown).toBe('- sibling\n- parent\n  - child\n- third\n')
  })

  it('rejects a nested child as an independent top-level handle target', () => {
    const markdown = '- parent\n  - child\n- sibling\n'
    expect(
      planBlockMove(
        markdown,
        startOf(markdown, '  - child'),
        startOf(markdown, '- sibling'),
        'before',
      ),
    ).toMatchObject({ status: 'rejected' })
  })

  it('rejects a list item dropped beside unrelated prose until nesting rules are proven', () => {
    const markdown = '- first\n- second\n\nprose\n'
    expect(
      planBlockMove(
        markdown,
        startOf(markdown, '- first'),
        startOf(markdown, 'prose'),
        'after',
      ),
    ).toMatchObject({ status: 'rejected' })
  })

  it('treats adjacent equivalent placements as no-ops with no source edit', () => {
    const markdown = 'A\n\nB\n\nC\n'
    expect(
      planBlockMove(markdown, 0, startOf(markdown, 'B'), 'before'),
    ).toMatchObject({ status: 'noop' })
    expect(
      planBlockMove(markdown, startOf(markdown, 'B'), 0, 'after'),
    ).toMatchObject({ status: 'noop' })
  })

  it('rejects front matter and table fragments as unproven source ownership', () => {
    const markdown =
      '---\ntitle: doc\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\ntext\n'
    expect(
      planBlockMove(markdown, 0, startOf(markdown, 'text'), 'before'),
    ).toMatchObject({ status: 'rejected' })
    expect(
      planBlockMove(
        markdown,
        startOf(markdown, '| - | - |'),
        startOf(markdown, 'text'),
        'before',
      ),
    ).toMatchObject({ status: 'rejected' })
  })

  it('maps a caret inside the moved block by UTF-16 source offset', () => {
    const markdown = '😀 A\n\nB body\n'
    const source = startOf(markdown, 'B body')
    const result = planBlockMove(markdown, source, 0, 'before')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      const oldCaret = source + 3
      expect(
        result.markdown.slice(
          result.mapOffset(oldCaret) - 3,
          result.mapOffset(oldCaret) + 3,
        ),
      ).toContain('B body')
    }
  })

  it('reports one exact source identity per supported top-level block', () => {
    const markdown = '# Heading\n\npara\n\n```js\nx\n```\n\n| a |\n| - |\n'
    const blocks = scanMovableBlocks(markdown)
    expect(
      blocks.map((block) => markdown.slice(block.start, block.end)),
    ).toEqual(['# Heading', 'para', '```js\nx\n```', '| a |\n| - |'])
  })
})

it('maps an unmoved caret through either EOF separator transfer', () => {
  const finalBeforeFirst = planBlockMove('A\n\nB', 3, 0, 'before')
  expect(finalBeforeFirst.status).toBe('ok')
  if (finalBeforeFirst.status === 'ok') {
    expect(finalBeforeFirst.markdown).toBe('B\n\nA')
    expect(finalBeforeFirst.mapOffset(0)).toBe(3)
  }
  const firstAfterFinal = planBlockMove('A\n\nB', 0, 3, 'after')
  expect(firstAfterFinal.status).toBe('ok')
  if (firstAfterFinal.status === 'ok') {
    expect(firstAfterFinal.markdown).toBe('B\n\nA')
    expect(firstAfterFinal.mapOffset(3)).toBe(0)
  }
})

it('moves a paragraph below a fenced code block without splitting its source', () => {
  const markdown = 'before\n\nparagraph\n\n```ts\nconst x = 1\n```\n'
  const result = planBlockMove(
    markdown,
    startOf(markdown, 'paragraph'),
    startOf(markdown, '```ts'),
    'after',
  )
  expect(result.status).toBe('ok')
  if (result.status === 'ok')
    expect(result.markdown).toBe(
      'before\n\n```ts\nconst x = 1\n```\n\nparagraph\n',
    )
})

it('uses the selected duplicate block start, not matching text, as identity', () => {
  const markdown = 'same\n\nother\n\nsame\n'
  const source = startOf(markdown, 'same', 1)
  const result = planBlockMove(
    markdown,
    source,
    startOf(markdown, 'other'),
    'before',
  )
  expect(result.status).toBe('ok')
  if (result.status === 'ok')
    expect(result.markdown).toBe('same\n\nsame\n\nother\n')
})

it('keeps one-column table header, delimiter and row together', () => {
  const markdown = 'before\n\n| a |\n| - |\n| b |\n\nafter\n'
  const blocks = scanMovableBlocks(markdown)
  expect(
    blocks.map((block) => markdown.slice(block.start, block.end)),
  ).toContain('| a |\n| - |\n| b |')
})

it('keeps a task item and its six-space nested child together', () => {
  const markdown = '- [x] parent\n      - child\n- [ ] sibling\n'
  const result = planBlockMove(
    markdown,
    0,
    startOf(markdown, '- [ ] sibling'),
    'after',
  )
  expect(result.status).toBe('ok')
  if (result.status === 'ok')
    expect(result.markdown).toBe('- [ ] sibling\n- [x] parent\n      - child\n')
})

it('declines an ordered item with an under-indented would-be child', () => {
  const markdown = '1. parent\n  - child\n2. sibling\n'
  expect(
    planBlockMove(markdown, 0, startOf(markdown, '2. sibling'), 'after'),
  ).toMatchObject({ status: 'rejected' })
})

it('keeps front matter first while moving later ordinary blocks', () => {
  const markdown = '---\ntitle: X\n---\n\nA\n\nB\n'
  const result = planBlockMove(
    markdown,
    startOf(markdown, 'B'),
    startOf(markdown, 'A'),
    'before',
  )
  expect(result.status).toBe('ok')
  if (result.status === 'ok')
    expect(result.markdown).toBe('---\ntitle: X\n---\n\nB\n\nA\n')
})

it('moves an escaped-pipe table as one exact block', () => {
  const markdown = 'before\n\n| a | b |\n| - | - |\n| x\\|y | z |\n\nafter\n'
  const result = planBlockMove(
    markdown,
    startOf(markdown, '| a | b |'),
    startOf(markdown, 'after'),
    'after',
  )
  expect(result.status).toBe('ok')
  if (result.status === 'ok')
    expect(result.markdown).toBe(
      'before\n\nafter\n\n| a | b |\n| - | - |\n| x\\|y | z |\n',
    )
})

it('rejects an unclosed fence rather than treating its body as movable paragraphs', () => {
  const markdown = 'before\n\n````ts\ninside\n```\nnext\n'
  expect(scanMovableBlocks(markdown)).toEqual([])
})

it('keeps the first byte of the following block with that block in ordinary moves', () => {
  const markdown = 'A\n\nB\n\nC\n'
  const after = planBlockMove(markdown, 0, startOf(markdown, 'B'), 'after')
  expect(after.status).toBe('ok')
  if (after.status === 'ok')
    expect(after.mapOffset(startOf(markdown, 'B'))).toBe(0)
  const before = planBlockMove(markdown, startOf(markdown, 'B'), 0, 'before')
  expect(before.status).toBe('ok')
  if (before.status === 'ok')
    expect(before.mapOffset(startOf(markdown, 'C'))).toBe(
      before.markdown.indexOf('C'),
    )
})

it('never drags a heading marker away from its body and descendants', () => {
  const markdown = '# A\n\nA body\n\n## Child\n\nchild body\n\n# B\n\nB body\n'
  expect(
    planBlockMove(
      markdown,
      startOf(markdown, '# A'),
      startOf(markdown, '# B'),
      'after',
    ),
  ).toMatchObject({ status: 'rejected' })
})

it('moves a proven lazy blockquote continuation as one exact source group', () => {
  const markdown = '> quoted start\nlazy continuation\n\nafter\n'
  expect(
    planBlockMove(markdown, 0, startOf(markdown, 'after'), 'after'),
  ).toMatchObject({
    status: 'ok',
    markdown: 'after\n\n> quoted start\nlazy continuation\n',
  })
})

it('moves a proven lazy list continuation with its owning item', () => {
  const markdown = '- first\nlazy continuation\n- second\n'
  expect(
    planBlockMove(markdown, 0, startOf(markdown, '- second'), 'after'),
  ).toMatchObject({
    status: 'ok',
    markdown: '- second\n- first\nlazy continuation\n',
  })
})

it('never treats an under-indented nested item as a paragraph move source', () => {
  const markdown = '1. parent\n  - child\n\nprose\n'
  expect(
    planBlockMove(
      markdown,
      startOf(markdown, '  - child'),
      startOf(markdown, 'prose'),
      'after',
    ),
  ).toMatchObject({ status: 'rejected' })
})

it('keeps a loose list item with an owned continuation paragraph intact', () => {
  const markdown = '- first\n\n  continuation\n- second\n'
  const blocks = scanMovableBlocks(markdown)
  expect(
    blocks.map((block) => markdown.slice(block.start, block.end)),
  ).toContain('- first\n\n  continuation')
})

it('never offers a lazy list continuation as a separate prose handle', () => {
  const markdown = '- first\nlazy continuation\n- second\n'
  expect(
    planBlockMove(
      markdown,
      startOf(markdown, 'lazy continuation'),
      startOf(markdown, '- second'),
      'after',
    ),
  ).toMatchObject({ status: 'rejected' })
  expect(scanMovableBlocks(markdown).map((block) => block.kind)).toEqual([
    'list-item',
    'list-item',
  ])
})

describe('Task 259 guarded Delete and Duplicate source actions', () => {
  it('deletes only one middle paragraph and its following separator', () => {
    const markdown = 'A\n\nB\n\nC\n'
    const result = planBlockDelete(markdown, startOf(markdown, 'B'))
    expect(result).toMatchObject({
      status: 'ok',
      markdown: 'A\n\nC\n',
      caretOffset: 3,
    })
  })

  it('deletes the final block without leaving an orphan separator', () => {
    const result = planBlockDelete('A\n\nB', 3)
    expect(result).toMatchObject({
      status: 'ok',
      markdown: 'A',
      caretOffset: 1,
    })
  })

  it('duplicates a middle paragraph with its exact separator', () => {
    const markdown = 'A\n\nB\n\nC\n'
    const result = planBlockDuplicate(markdown, startOf(markdown, 'B'))
    expect(result).toMatchObject({
      status: 'ok',
      markdown: 'A\n\nB\n\nB\n\nC\n',
      caretOffset: 6,
    })
  })

  it('duplicates a no-newline final block without adding a terminal newline', () => {
    const result = planBlockDuplicate('A\n\nB', 3)
    expect(result).toMatchObject({
      status: 'ok',
      markdown: 'A\n\nB\n\nB',
      caretOffset: 6,
    })
  })

  it('duplicates a list item with all nested descendants', () => {
    const markdown = '- parent\n  - child\n- sibling\n'
    const result = planBlockDuplicate(markdown, 0)
    expect(result).toMatchObject({
      status: 'ok',
      markdown: '- parent\n  - child\n- parent\n  - child\n- sibling\n',
    })
  })

  it('refuses heading-marker actions and stale nested-item identities', () => {
    const markdown = '# Heading\n\nbody\n'
    expect(planBlockDelete(markdown, 0)).toMatchObject({ status: 'rejected' })
    expect(planBlockDuplicate(markdown, 0)).toMatchObject({
      status: 'rejected',
    })
    const list = '- parent\n  - child\n'
    expect(planBlockDelete(list, startOf(list, '  - child'))).toMatchObject({
      status: 'rejected',
    })
  })
})

describe('Task 259 host prepare wire payload', () => {
  it('excludes the non-cloneable timeout from a pending binding', () => {
    const binding = {
      uri: 'file:///task-259.md',
      version: 4,
      before: 'A\n\nB\n',
      after: 'B\n\nA\n',
      timeout: () => undefined,
    }
    const payload = blockActionPreparePayload('request-1', binding, 3)
    expect(Object.keys(payload).sort()).toEqual([
      'after',
      'before',
      'caretOffset',
      'command',
      'requestId',
      'uri',
      'version',
    ])
    expect(structuredClone(payload)).toEqual(payload)
  })
})

describe('Task 259 heading handle delegates to Task 222 sections', () => {
  const markdown =
    '# Alpha\n\nalpha body\n\n## Child\n\nchild body\n\n# Beta\n\nbeta body\n'
  const beta = markdown.indexOf('# Beta')
  const child = markdown.indexOf('## Child')
  const body = markdown.indexOf('alpha body')

  it('moves an entire heading section with body and descendants', () => {
    expect(
      planBlockAction(markdown, {
        kind: 'move',
        sourceStart: 0,
        targetStart: beta,
        placement: 'after',
      }),
    ).toEqual({
      status: 'ok',
      markdown:
        '# Beta\n\nbeta body\n\n# Alpha\n\nalpha body\n\n## Child\n\nchild body\n',
      caretOffset: '# Beta\n\nbeta body\n\n'.length,
    })
  })

  it('rejects a heading dropped on a body, child, or incompatible level', () => {
    for (const targetStart of [body, child]) {
      expect(
        planBlockAction(markdown, {
          kind: 'move',
          sourceStart: 0,
          targetStart,
          placement: 'after',
        }),
      ).toMatchObject({ status: 'rejected' })
    }
  })
})

it('deletes a quote from a mixed exact source containing canonicalized fence and table', () => {
  const markdown =
    '# Heading\n\nbody\n\n- parent\n  - child\n- sibling\n\n> quote\n\n```js\nx()\n```\n\n| A | B |\n| --- | --- |\n| a | b |\n\n---\n'
  expect(
    planBlockAction(markdown, {
      kind: 'delete',
      sourceStart: markdown.indexOf('> quote'),
    }),
  ).toMatchObject({
    status: 'ok',
    markdown: markdown.replace('> quote\n\n', ''),
  })
})

describe('Task 259 complete raw HTML source ownership prototype', () => {
  it.each([
    ['type 1 script', '<script>\n# marker\n</script>'],
    ['type 2 comment', '<!--\n# marker\n-->'],
    ['type 3 processing', '<?pi\n- marker\n?>'],
    ['type 4 declaration', '<!DOCTYPE html>'],
    ['type 5 CDATA', '<![CDATA[\n> marker\n]]>'],
    ['type 6 block tag', '<div>\n# marker\n</div>'],
    ['type 7 custom tag', '<custom>\ntext\n</custom>'],
  ])(
    '%s stays one exact source unit despite Markdown markers inside',
    (_name, html) => {
      const markdown = `A\n\n${html}\n\nB\n`
      const blocks = scanMovableBlocks(markdown)
      expect(
        blocks.map((block) => markdown.slice(block.start, block.end)),
      ).toEqual(['A', html, 'B'])
      expect(blocks[1].kind).toBe('html')
    },
  )

  it('pairs details opening, body and closing siblings as one movable source group', () => {
    const source =
      'A\n\n<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n\nB\n'
    const blocks = scanMovableBlocks(source)
    expect(blocks.map((block) => source.slice(block.start, block.end))).toEqual(
      ['A', '<details>\n<summary>Sum</summary>\n\nbody\n\n</details>', 'B'],
    )
    expect(blocks[1]).toMatchObject({
      kind: 'html-group',
      memberKinds: ['html', 'paragraph', 'html'],
    })
    expect(
      planBlockAction(source, {
        kind: 'move',
        sourceStart: source.indexOf('<details>'),
        targetStart: 0,
        placement: 'before',
      }),
    ).toMatchObject({
      status: 'ok',
      markdown:
        '<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n\nA\n\nB\n',
    })
  })

  it('fails closed for an unmatched details opener or closer', () => {
    expect(scanMovableBlocks('A\n\n<details>\n\nbody\n')).toEqual([])
    expect(scanMovableBlocks('A\n\n</details>\n\nB\n')).toEqual([])
  })
})

describe('Task 259 loose and lazy container ownership prototype', () => {
  it('keeps an unindented lazy paragraph inside its list item', () => {
    const source = '- first\nlazy continuation\n- second\n'
    expect(
      scanMovableBlocks(source).map((block) =>
        source.slice(block.start, block.end),
      ),
    ).toEqual(['- first\nlazy continuation', '- second'])
  })

  it('counts a tab at the marker content column as part of its item', () => {
    const source = '- \tfirst\n\tcontinued\n- second\n'
    expect(
      scanMovableBlocks(source).map((block) =>
        source.slice(block.start, block.end),
      ),
    ).toEqual(['- \tfirst\n\tcontinued', '- second'])
  })

  it('moves a loose sibling item with its blank and nested continuation', () => {
    const source = '- first\n\n  continuation\n\n- second\n'
    const blocks = scanMovableBlocks(source)
    expect(blocks.map((block) => block.kind)).toEqual([
      'list-item',
      'list-item',
    ])
    expect(
      planBlockMove(source, 0, source.indexOf('- second'), 'after'),
    ).toMatchObject({ status: 'ok' })
  })

  it('keeps a lazy quote continuation inside the same source-owned quote', () => {
    const source = '> first\nlazy continuation\n> last\n\nB\n'
    expect(
      scanMovableBlocks(source).map((block) =>
        source.slice(block.start, block.end),
      ),
    ).toEqual(['> first\nlazy continuation\n> last', 'B'])
  })

  it('does not claim a lazy continuation after an empty list marker or blank quote line', () => {
    expect(scanMovableBlocks('- \nlazy\n')).toEqual([])
    expect(scanMovableBlocks('> \nlazy\n')).toEqual([])
  })
})

it('keeps nested details and marker-looking comment lines inside one enclosure', () => {
  const source = [
    'A',
    '',
    '<details>',
    '<summary>Outer</summary>',
    '',
    '<!--',
    '</details>',
    '-->',
    '',
    '<details>',
    '<summary>Inner</summary>',
    '',
    'inner',
    '',
    '</details>',
    '',
    'outer tail',
    '',
    '</details>',
    '',
    'B',
    '',
  ].join('\n')
  const blocks = scanMovableBlocks(source)
  expect(blocks.map((block) => block.kind)).toEqual([
    'paragraph',
    'html-group',
    'paragraph',
  ])
  expect(source.slice(blocks[1].start, blocks[1].end)).toContain(
    'outer tail\n\n</details>',
  )
  expect(
    blocks[1].memberKinds?.filter((kind) => kind === 'html').length,
  ).toBeGreaterThanOrEqual(4)
})

it('moves a CRLF HTML comment at EOF without changing authored line endings', () => {
  const source = 'A\r\n\r\n<!--\r\n- marker\r\n-->'
  const result = planBlockMove(source, source.indexOf('<!--'), 0, 'before')
  expect(result).toMatchObject({
    status: 'ok',
    markdown: '<!--\r\n- marker\r\n-->\r\n\r\nA',
  })
})

it('fails closed when a non-details HTML enclosure splits across blank-line render siblings', () => {
  expect(scanMovableBlocks('A\n\n<div>\n\nbody\n\n</div>\n\nB\n')).toEqual([])
  expect(
    scanMovableBlocks('A\n\n<custom>\n\nbody\n\n</custom>\n\nB\n'),
  ).toEqual([])
})

it('deletes or duplicates a complete paired-details source group', () => {
  const source =
    'A\n\n<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n\nB\n'
  const group = '<details>\n<summary>Sum</summary>\n\nbody\n\n</details>'
  const start = source.indexOf('<details>')
  expect(
    planBlockAction(source, { kind: 'delete', sourceStart: start }),
  ).toMatchObject({
    status: 'ok',
    markdown: 'A\n\nB\n',
  })
  expect(
    planBlockAction(source, { kind: 'duplicate', sourceStart: start }),
  ).toMatchObject({
    status: 'ok',
    markdown: `A\n\n${group}\n\n${group}\n\nB\n`,
  })
})
