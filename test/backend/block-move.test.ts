import { describe, expect, it } from 'vitest'
import {
  blockActionPreparePayload,
  planBlockAction,
  planBlockMove,
  planBlockDelete,
  planBlockDuplicate,
  scanMovableBlocks,
  type BlockActionIntent,
  type BlockActionScope,
  type MovableBlock,
} from '../../src/shared/block-move'
import { tableHeavyMarkdown } from '../vscode-e2e/table-heavy-markdown'

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

describe('Task 259 owner-approved complete HTML enclosure groups', () => {
  it.each(['div', 'custom'])(
    'pairs a blank-split <%s> enclosure into one source group',
    (tag) => {
      const source = `A\n\n<${tag}>\n\nbody\n\n</${tag}>\n\nB\n`
      const groups = scanMovableBlocks(source)
      expect(groups.map((group) => group.kind)).toEqual([
        'paragraph',
        'html-group',
        'paragraph',
      ])
      expect(groups[1].memberKinds).toEqual(['html', 'paragraph', 'html'])
      expect(source.slice(groups[1].start, groups[1].end)).toBe(
        `<${tag}>\n\nbody\n\n</${tag}>`,
      )
      expect(
        planBlockAction(source, {
          kind: 'move',
          sourceStart: source.indexOf(`<${tag}>`),
          targetStart: 0,
          placement: 'before',
        }),
      ).toMatchObject({
        status: 'ok',
        markdown: `<${tag}>\n\nbody\n\n</${tag}>\n\nA\n\nB\n`,
      })
    },
  )

  it('keeps nested mixed HTML enclosures inside the outer group', () => {
    const source =
      'A\n\n<div>\n\n<details>\n\nbody\n\n</details>\n\n</div>\n\nB\n'
    const groups = scanMovableBlocks(source)
    expect(groups.map((group) => group.kind)).toEqual([
      'paragraph',
      'html-group',
      'paragraph',
    ])
    expect(groups[1].memberKinds).toEqual([
      'html',
      'html',
      'paragraph',
      'html',
      'html',
    ])
  })

  it('rejects mismatched, unclosed, or orphan closing HTML tags', () => {
    for (const source of [
      'A\n\n<div>\n\nbody\n\n</section>\n',
      'A\n\n<div>\n\nbody\n',
      'A\n\n</div>\n\nB\n',
    ])
      expect(scanMovableBlocks(source)).toEqual([])
  })
})

// Front matter owns its separator while body operations keep the same shifted offsets.
it('scans byte-zero front matter and preserves body offsets for both closing markers', () => {
  for (const eol of ['\n', '\r\n']) {
    for (const close of ['---', '...']) {
      const prefix = ['---', 'title: doc', close, '', ''].join(eol)
      const body = `A${eol}${eol}B${eol}`
      const blocks = scanMovableBlocks(prefix + body)
      expect(blocks[0]).toEqual({
        kind: 'front-matter',
        start: 0,
        end: prefix.length - 2 * eol.length,
        sectionEnd: prefix.length,
        listRun: -1,
      })
      expect(blocks.slice(1)).toEqual(
        scanMovableBlocks(body).map((block) => ({
          ...block,
          start: block.start + prefix.length,
          end: block.end + prefix.length,
          sectionEnd: block.sectionEnd + prefix.length,
        })),
      )
    }
  }
  expect(scanMovableBlocks('---\ntitle: doc\n')).toEqual([])
  expect(scanMovableBlocks(' ---\ntitle: doc\n---\n\nbody\n')[0]?.kind).toBe(
    'thematic',
  )
  expect(scanMovableBlocks('\n---\ntitle: doc\n---\n')[0]?.kind).toBe(
    'thematic',
  )
})

it('rejects front matter actions and before-target moves while allowing body moves after it', () => {
  const prefix = '---\ntitle: doc\n---\n\n'
  const markdown = `${prefix}A\n\nB\n`
  const b = markdown.indexOf('B')
  const rejected = { status: 'rejected', reason: 'stale-block' }
  expect(planBlockMove(markdown, 0, b, 'after')).toEqual(rejected)
  expect(planBlockMove(markdown, b, 0, 'before')).toEqual(rejected)
  expect(planBlockDelete(markdown, 0)).toEqual(rejected)
  expect(planBlockDuplicate(markdown, 0)).toEqual(rejected)
  expect(
    planBlockAction(markdown, {
      kind: 'move',
      sourceStart: b,
      targetStart: 0,
      placement: 'before',
    }),
  ).toEqual(rejected)
  expect(
    planBlockAction(markdown, {
      kind: 'move',
      sourceStart: b,
      targetStart: 0,
      placement: 'after',
    }),
  ).toMatchObject({ status: 'ok', markdown: `${prefix}B\n\nA\n` })
})

it('scans whole top-level math blocks including blank lines and single-line delimiters', () => {
  for (const math of ['$$\nx\n\ny\n$$', '$$x$$', '  $$\nx\n  $$']) {
    const markdown = `${math}\n\nTail\n`
    expect(
      scanMovableBlocks(markdown).map((block) => [
        block.kind,
        block.start,
        block.end,
      ]),
    ).toEqual([
      ['math', 0, math.length],
      ['paragraph', math.length + 2, markdown.length - 1],
    ])
  }
  expect(scanMovableBlocks('- $$\n  x\n  $$\n')[0]?.kind).toBe('list-item')
  expect(scanMovableBlocks('> $$\n> x\n> $$\n')[0]?.kind).toBe('quote')
})

it('keeps the front matter separator when deleting the only body block', () => {
  const prefix = '---\ntitle: doc\n---\n\n'
  expect(planBlockDelete(`${prefix}Body\n`, prefix.length)).toMatchObject({
    status: 'ok',
    markdown: prefix,
  })
})

it('uses the settled stale-block reason for heading actions targeting before front matter', () => {
  const source = '---\ntitle: doc\n---\n\n# Head\n\nBody\n'
  expect(
    planBlockAction(source, {
      kind: 'move',
      sourceStart: source.indexOf('# Head'),
      targetStart: 0,
      placement: 'before',
    }),
  ).toEqual({ status: 'rejected', reason: 'stale-block' })
})

it('moves, duplicates and deletes a complete display math block like a code fence', () => {
  const math = '$$\nx^2\n\ny^2\n$$'
  const source = `Before\n\n${math}\n\nAfter\n`
  const start = source.indexOf('$$')
  expect(
    planBlockAction(source, {
      kind: 'move',
      sourceStart: start,
      targetStart: source.indexOf('After'),
      placement: 'after',
    }),
  ).toMatchObject({ status: 'ok', markdown: `Before\n\nAfter\n\n${math}\n` })
  expect(
    planBlockAction(source, { kind: 'duplicate', sourceStart: start }),
  ).toMatchObject({
    status: 'ok',
    markdown: `Before\n\n${math}\n\n${math}\n\nAfter\n`,
  })
  expect(
    planBlockAction(source, { kind: 'delete', sourceStart: start }),
  ).toMatchObject({ status: 'ok', markdown: 'Before\n\nAfter\n' })
})

// Task 666: CommonMark gives a thematic break precedence over a list item when a line can be both.
describe('Task 666 spaced thematic breaks', () => {
  it.each(['* * *', '- - -', '_ _ _'])(
    'Task 666: a spaced thematic break %s scans as a thematic block, not a list item',
    (rule) => {
      const markdown = `Before\n\n${rule}\n\nAfter\n`
      expect(scanMovableBlocks(markdown).map((block) => block.kind)).toEqual([
        'paragraph',
        'thematic',
        'paragraph',
      ])
    },
  )

  it('Task 666: a list item whose text looks like a thematic break stays a list item', () => {
    const markdown = 'Before\n\n- * * *\n\nAfter\n'
    expect(scanMovableBlocks(markdown).map((block) => block.kind)).toEqual([
      'paragraph',
      'list-item',
      'paragraph',
    ])
  })
  it('Task 666: a thematic break between list items is its own block and can be deleted alone', () => {
    const markdown = '* a\n* * *\n* b\n'
    const blocks = scanMovableBlocks(markdown)
    expect(blocks.map((block) => block.kind)).toEqual([
      'list-item',
      'thematic',
      'list-item',
    ])
    const result = planBlockAction(markdown, {
      kind: 'delete',
      sourceStart: blocks[1].start,
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.markdown).toBe('* a\n* b\n')
  })
})

// Task 733 / 011 (Q-87 Q-C): an empty list item is a bare marker line (`-`, `2.`), as Lute writes it.
// CommonMark starts an item on a bare marker, so the scanner must not take it as a lazy continuation
// of the item before it.
describe('Task 733 bare list marker', () => {
  it.each([
    ['- i1\n-\n- i2\n', ['- i1', '-', '- i2']],
    ['1. i1\n2.\n3. i2\n', ['1. i1', '2.', '3. i2']],
    ['* i1\n*\n', ['* i1', '*']],
    ['1) i1\n2)\n', ['1) i1', '2)']],
  ])('scans an empty item of %j as its own list item', (markdown, sources) => {
    const blocks = scanMovableBlocks(markdown)
    expect(
      blocks.map((block) => markdown.slice(block.start, block.end)),
    ).toEqual(sources)
    expect(blocks.map((block) => block.kind)).toEqual(
      sources.map(() => 'list-item'),
    )
  })

  it('still reads a setext underline and a thematic break as before', () => {
    expect(
      scanMovableBlocks('Title\n---\n').map((block) => block.kind),
    ).not.toContain('list-item')
    expect(
      scanMovableBlocks('para\n\n---\n').map((block) => block.kind),
    ).not.toContain('list-item')
  })
})

// Task 733 / 012-17 (B-15): with the confirmed top-level units of `markdown`, the planner scans only
// the block window of the action (the moved blocks, their neighbours and the enclosing list run) and
// yields the plan of the whole-document scan; without confirmed units it scans the whole document.
function unitsOf(blocks: readonly MovableBlock[]): BlockActionScope['units'] {
  return blocks.map(({ start, end, kind }) => ({ start, end, kind }))
}

/** Distinct whole-scan blocks of the window: source, target, their neighbours, the source's list run. */
function windowSize(
  blocks: readonly MovableBlock[],
  action: BlockActionIntent,
): number {
  const picked = new Set<number>()
  const around = (index: number) => {
    for (let near = index - 1; near <= index + 1; near++)
      if (near >= 0 && near < blocks.length) picked.add(near)
  }
  const source = blocks.findIndex((block) => block.start === action.sourceStart)
  if (source < 0) throw new Error('fixture action must name a block')
  around(source)
  if (action.kind === 'move')
    around(blocks.findIndex((block) => block.start === action.targetStart))
  const run = blocks[source].listRun
  if (run >= 0)
    blocks.forEach((block, index) => {
      if (block.listRun === run) picked.add(index)
    })
  return picked.size
}

function countedPlan(
  markdown: string,
  action: BlockActionIntent,
  units: BlockActionScope['units'],
) {
  const scanned = { before: 0, after: 0 }
  const plan = planBlockAction(markdown, action, { units, scanned })
  return { plan, scanned }
}

/** 2,000 top-level blocks: front matter, paragraphs, fences, tables, quotes and one list run. */
function largeDocument(): string {
  const blocks = ['---\ntitle: large\n---']
  for (let index = 1; index < 2000; index++) {
    if (index >= 1500 && index < 1505) blocks.push(`- item ${index}`)
    else if (index % 100 === 50) blocks.push(`\`\`\`\ncode ${index}\n\`\`\``)
    else if (index % 100 === 70) blocks.push(`| h |\n| --- |\n| ${index} |`)
    else if (index % 100 === 90) blocks.push(`> quote ${index}`)
    else blocks.push(`Paragraph ${index}.`)
  }
  return `${blocks.join('\n\n')}\n`
}

describe('Task 733 / 012-17 block action plan scope (B-15)', () => {
  const markdown = largeDocument()
  const blocks = scanMovableBlocks(markdown)
  const units = unitsOf(blocks)
  const at = (index: number) => blocks[index].start
  const move = (
    source: number,
    target: number,
    placement: 'before' | 'after',
  ): BlockActionIntent => ({
    kind: 'move',
    sourceStart: at(source),
    targetStart: at(target),
    placement,
  })

  it('builds a 2,000-block fixture', () => {
    expect(blocks).toHaveLength(2000)
    expect(blocks[1500].kind).toBe('list-item')
    expect(blocks[1504].listRun).toBe(blocks[1500].listRun)
  })

  it.each<[string, BlockActionIntent]>([
    ['Move Block Down on a paragraph', move(1000, 1001, 'after')],
    ['Move Block Up on a paragraph', move(1000, 999, 'before')],
    ['a far drag of a paragraph', move(1000, 1300, 'after')],
    ['a fenced block down', move(1050, 1051, 'after')],
    ['a table up', move(1070, 1069, 'before')],
    ['a list item within its run', move(1502, 1500, 'before')],
    ['a paragraph onto a list item (rejected)', move(1499, 1500, 'after')],
    ['the final block up', move(1999, 1998, 'before')],
    ['the first body block below front matter', move(2, 1, 'before')],
    ['a paragraph delete', { kind: 'delete', sourceStart: at(1000) }],
    ['a paragraph duplicate', { kind: 'duplicate', sourceStart: at(1000) }],
  ])(
    '%s scans the window only and plans as the whole scan',
    (_name, action) => {
      const whole = planBlockAction(markdown, action)
      const { plan, scanned } = countedPlan(markdown, action, units)
      expect(plan).toEqual(whole)
      const budget = windowSize(blocks, action) + 4
      expect(scanned.before).toBeGreaterThan(0)
      expect(scanned.before).toBeLessThanOrEqual(budget)
      expect(scanned.after).toBeLessThanOrEqual(budget)
    },
  )

  it.each<
    [string, (units: BlockActionScope['units']) => BlockActionScope['units']]
  >([
    ['no units', () => []],
    [
      'units without the source block',
      (all) => all.filter((unit) => unit.start !== at(1000)),
    ],
    [
      'units of other text (offsets shifted by one)',
      (all) =>
        all.map((unit) => ({
          ...unit,
          start: unit.start + 1,
          end: unit.end + 1,
        })),
    ],
  ])(
    'scans the whole document when the units are unconfirmed: %s',
    (_name, pick) => {
      const action = move(1000, 1001, 'after')
      const { plan, scanned } = countedPlan(markdown, action, pick(units))
      expect(plan).toEqual(planBlockAction(markdown, action))
      expect(scanned.before).toBeGreaterThanOrEqual(blocks.length)
    },
  )
})

describe.each([1, 4, 16] as const)(
  'Task 733 / 012-17 block action plan scope on tableHeavyMarkdown(%i) (B-15)',
  (factor) => {
    const markdown = tableHeavyMarkdown(factor)
    const blocks = scanMovableBlocks(markdown)
    const units = unitsOf(blocks)
    const startOfText = (text: string) => {
      const block = blocks.find((candidate) =>
        markdown.slice(candidate.start, candidate.end).startsWith(text),
      )
      if (!block) throw new Error(`missing block ${text}`)
      return block.start
    }
    const firstItem = startOfText('- list item 1')
    const cases: [string, BlockActionIntent][] = [
      [
        'the first paragraph down',
        {
          kind: 'move',
          sourceStart: startOfText('First paragraph'),
          targetStart: startOfText('Second paragraph'),
          placement: 'after',
        },
      ],
      [
        'the probe paragraph down onto the list (rejected)',
        {
          kind: 'move',
          sourceStart: startOfText('Third paragraph'),
          targetStart: firstItem,
          placement: 'after',
        },
      ],
      [
        'the paragraph before the tables down past table A',
        {
          kind: 'move',
          sourceStart: startOfText('Sixth paragraph'),
          targetStart: startOfText('| Name'),
          placement: 'after',
        },
      ],
      [
        'a list item up',
        {
          kind: 'move',
          sourceStart: startOfText('- list item 2'),
          targetStart: firstItem,
          placement: 'before',
        },
      ],
      [
        'a paragraph delete',
        { kind: 'delete', sourceStart: startOfText('Fifth paragraph') },
      ],
    ]

    it.each(cases)(
      '%s scans the window only and plans as the whole scan',
      (_name, action) => {
        const { plan, scanned } = countedPlan(markdown, action, units)
        expect(plan).toEqual(planBlockAction(markdown, action))
        const budget = windowSize(blocks, action) + 4
        expect(scanned.before).toBeGreaterThan(0)
        expect(scanned.before).toBeLessThanOrEqual(budget)
        expect(scanned.after).toBeLessThanOrEqual(budget)
      },
    )

    it('scans the same block count for a paragraph move at every factor', () => {
      const action: BlockActionIntent = {
        kind: 'move',
        sourceStart: startOfText('First paragraph'),
        targetStart: startOfText('Second paragraph'),
        placement: 'after',
      }
      const { scanned } = countedPlan(markdown, action, units)
      const reference = scanMovableBlocks(tableHeavyMarkdown(1))
      const referenceMarkdown = tableHeavyMarkdown(1)
      const referenceStart = (text: string) =>
        reference.find((block) =>
          referenceMarkdown.slice(block.start, block.end).startsWith(text),
        )!.start
      const base = countedPlan(
        referenceMarkdown,
        {
          kind: 'move',
          sourceStart: referenceStart('First paragraph'),
          targetStart: referenceStart('Second paragraph'),
          placement: 'after',
        },
        unitsOf(reference),
      ).scanned
      expect(scanned.before).toBeGreaterThan(0)
      expect(scanned).toEqual(base)
    })
  },
)

describe('Task 733 / 012-17 scoped plans equal whole-scan plans on small fixtures', () => {
  it.each([
    'A\n\nB\n\nC\n',
    'A\n\nB',
    'A\r\n\r\nB\r\n\r\nC\r\n',
    '---\nt: 1\n---\n\nA\n\nB\n',
    '- a\n  - child\n- b\n\nAfter\n\n1. one\n2. two\n',
    '# H1\n\nbody\n\n## H2\n\nx\n\n# H3\n\ny\n',
    '```js\nx\n```\n\n| a |\n| --- |\n| 1 |\n\n> q\n> r\n\n* * *\n\nEnd',
    '$$\nx\n\ny\n$$\n\nA\n',
    '<details>\n<summary>S</summary>\n\nbody\n\n</details>\n\nA\n\nB\n',
  ])('every action on %j', (markdown) => {
    const blocks = scanMovableBlocks(markdown)
    const units = unitsOf(blocks)
    const actions: BlockActionIntent[] = []
    for (const source of blocks) {
      actions.push({ kind: 'delete', sourceStart: source.start })
      actions.push({ kind: 'duplicate', sourceStart: source.start })
      for (const target of blocks)
        for (const placement of ['before', 'after'] as const)
          actions.push({
            kind: 'move',
            sourceStart: source.start,
            targetStart: target.start,
            placement,
          })
    }
    for (const action of actions)
      expect(
        planBlockAction(markdown, action, { units }),
        JSON.stringify(action),
      ).toEqual(planBlockAction(markdown, action))
  })
})
