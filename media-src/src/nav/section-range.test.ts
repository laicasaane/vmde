// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  headingPathForIndex,
  sectionRangeForHeading,
  headingLabel,
  textWithout,
  topLevelBlocks,
} from './section-range'
import * as sectionEngine from './section-range'

function surface(markup: string): HTMLElement {
  const root = document.createElement('pre')
  root.innerHTML = markup
  return root
}

describe('hierarchical heading sections', () => {
  it('owns blocks until the next heading at the same or higher level', () => {
    const root = surface(
      '<p data-block="0">preamble</p>' +
        '<h1 data-block="0">Chapter</h1>' +
        '<p data-block="0">intro</p>' +
        '<h2 data-block="0">Child</h2>' +
        '<p data-block="0">detail</p>' +
        '<h3 data-block="0">Grandchild</h3>' +
        '<p data-block="0">deep</p>' +
        '<h2 data-block="0">Sibling</h2>' +
        '<p data-block="0">next</p>' +
        '<h1 data-block="0">Next chapter</h1>',
    )
    const blocks = topLevelBlocks(root)

    expect(sectionRangeForHeading(blocks, 3)).toEqual({
      start: 3,
      end: 7,
      level: 2,
    })
    expect(sectionRangeForHeading(blocks, 1)).toEqual({
      start: 1,
      end: 9,
      level: 1,
    })
  })

  it('rejects nested data-block nodes and non-heading start blocks', () => {
    const root = surface(
      '<blockquote data-block="0"><p data-block="0">nested</p></blockquote>' +
        '<p data-block="0">plain</p>',
    )
    const blocks = topLevelBlocks(root)

    expect(blocks).toHaveLength(2)
    expect(sectionRangeForHeading(blocks, 1)).toBeNull()
  })

  it('derives the ancestor breadcrumb path from document order', () => {
    const root = surface(
      '<h1 data-block="0">Architecture</h1>' +
        '<h3 data-block="0">Rendering</h3>' +
        '<p data-block="0">body</p>' +
        '<h2 data-block="0">Cache</h2>' +
        '<h4 data-block="0">Memory</h4>',
    )
    const blocks = topLevelBlocks(root)

    expect(headingPathForIndex(blocks, 4).map((entry) => entry.text)).toEqual([
      'Architecture',
      'Cache',
      'Memory',
    ])
  })
})

type ShiftInput = {
  markdown: string
  startOffset: number
  endOffset: number
  caretOffset: number
  direction: -1 | 1
  section?: boolean
}

const shiftHeadings = (input: ShiftInput) =>
  (
    sectionEngine as typeof sectionEngine & {
      shiftMarkdownHeadingLevels(value: ShiftInput): unknown
    }
  ).shiftMarkdownHeadingLevels(input) as {
    status: 'ok' | 'clamped' | 'not-heading'
    markdown?: string
    caretOffset?: number
    shifted?: number
    scope?: 'single' | 'section'
  }

describe('Markdown heading level shift', () => {
  it('exposes the shared heading-shift engine', () => {
    expect(
      (sectionEngine as Record<string, unknown>).shiftMarkdownHeadingLevels,
    ).toBeTypeOf('function')
  })

  it('promotes and demotes one ATX heading while preserving the caret text offset', () => {
    const markdown = 'intro\n\n### Heading text\n\ntail\n'
    const caret = markdown.indexOf('text') + 2
    const promoted = shiftHeadings({
      markdown,
      startOffset: caret,
      endOffset: caret,
      caretOffset: caret,
      direction: -1,
    })
    expect(promoted).toMatchObject({
      status: 'ok',
      markdown: 'intro\n\n## Heading text\n\ntail\n',
      shifted: 1,
      scope: 'single',
    })
    expect(
      promoted.markdown?.slice(promoted.caretOffset! - 2).startsWith('text'),
    ).toBe(true)

    expect(
      shiftHeadings({
        markdown: promoted.markdown!,
        startOffset: promoted.caretOffset!,
        endOffset: promoted.caretOffset!,
        caretOffset: promoted.caretOffset!,
        direction: 1,
      }).markdown,
    ).toBe(markdown)
  })

  it('shifts a complete mixed-level subtree selected through its body', () => {
    const markdown = [
      '# Root',
      '',
      'intro',
      '',
      '## Child',
      '',
      '### Grandchild',
      '',
      '## Sibling',
      '',
      '# Next',
      '',
    ].join('\n')
    const result = shiftHeadings({
      markdown,
      startOffset: markdown.indexOf('# Root'),
      endOffset: markdown.indexOf('Sibling') + 'Sibling'.length,
      caretOffset: markdown.indexOf('Child') + 2,
      direction: 1,
    })
    expect(result).toMatchObject({
      status: 'ok',
      shifted: 4,
      scope: 'section',
    })
    expect(result.markdown).toBe(
      markdown
        .replace('# Root', '## Root')
        .replace('## Child', '### Child')
        .replace('### Grandchild', '#### Grandchild')
        .replace('## Sibling', '### Sibling'),
    )
  })

  it('refuses a whole subtree when any member would cross h1 or h6', () => {
    const markdown = '# Root\n\n###### Too deep\n\n# Next\n'
    const result = shiftHeadings({
      markdown,
      startOffset: 0,
      endOffset: markdown.indexOf('Too deep') + 3,
      caretOffset: 2,
      direction: 1,
    })
    expect(result).toEqual({ status: 'clamped' })
  })

  it.each([
    ['# Top\n', -1 as const],
    ['###### Bottom\n', 1 as const],
  ])('refuses a single clamped heading in %j', (markdown, direction) => {
    expect(
      shiftHeadings({
        markdown,
        startOffset: 2,
        endOffset: 2,
        caretOffset: 2,
        direction,
      }),
    ).toEqual({ status: 'clamped' })
  })

  it('converts setext headings to ATX on shift and keeps line endings', () => {
    const markdown = 'Title\r\n=====\r\n\r\nSub\r\n---\r\n'
    const h1 = shiftHeadings({
      markdown,
      startOffset: 2,
      endOffset: 2,
      caretOffset: 2,
      direction: 1,
    })
    expect(h1.markdown).toBe('## Title\r\n\r\nSub\r\n---\r\n')
    const subStart = h1.markdown!.indexOf('Sub')
    expect(
      shiftHeadings({
        markdown: h1.markdown!,
        startOffset: subStart,
        endOffset: subStart,
        caretOffset: subStart + 1,
        direction: 1,
      }).markdown,
    ).toBe('## Title\r\n\r\n### Sub\r\n')
  })

  it('preserves setext title indentation and whitespace bytes', () => {
    const markdown = '  Title  \n  -----\n'
    const caret = markdown.indexOf('tle') + 1
    const result = shiftHeadings({
      markdown,
      startOffset: caret,
      endOffset: caret,
      caretOffset: caret,
      direction: 1,
    })
    expect(result).toMatchObject({
      status: 'ok',
      markdown: '  ### Title  \n',
      caretOffset: caret + 4,
    })
  })

  it.each([
    '- item\n---\n',
    '> quote\n---\n',
    '    code\n---\n',
    '---\n---\n',
    '---\ntitle: value\n---\n\nbody\n',
  ])(
    'does not reinterpret another Markdown block as setext in %j',
    (markdown) => {
      expect(
        shiftHeadings({
          markdown,
          startOffset: 1,
          endOffset: 1,
          caretOffset: 1,
          direction: 1,
        }),
      ).toEqual({ status: 'not-heading' })
    },
  )

  it('ignores heading-shaped text inside fenced code', () => {
    const markdown = '```md\n## not a heading\n```\n\n## Real\n'
    const fenced = markdown.indexOf('not a heading')
    expect(
      shiftHeadings({
        markdown,
        startOffset: fenced,
        endOffset: fenced,
        caretOffset: fenced,
        direction: 1,
      }),
    ).toEqual({ status: 'not-heading' })
    const real = markdown.indexOf('## Real') + 3
    expect(
      shiftHeadings({
        markdown,
        startOffset: real,
        endOffset: real,
        caretOffset: real,
        direction: 1,
      }).markdown,
    ).toBe(markdown.replace('## Real', '### Real'))
  })

  it('does not treat a fence marker with trailing info as a closing fence', () => {
    const markdown =
      '````md\ncode\n```` still code\n## still fenced\n````\n\n## Real\n'
    const fenced = markdown.indexOf('still fenced')
    expect(
      shiftHeadings({
        markdown,
        startOffset: fenced,
        endOffset: fenced,
        caretOffset: fenced,
        direction: 1,
      }),
    ).toEqual({ status: 'not-heading' })
  })

  it.each([
    '<div>\n## not a heading\n</div>\n\n## Real\n',
    '<div>\nTitle\n---\n</div>\n\n## Real\n',
    '<!--\n## not a heading\n-->\n\n## Real\n',
    '<script>\n## not a heading\n</script>\n\n## Real\n',
    '<x-box data-kind="demo">\n## not a heading\n</x-box>\n\n## Real\n',
    '<span>\nTitle\n---\n</span>\n\n## Real\n',
    '<span>   \n## not a heading\n</span>\n\n## Real\n',
    '# Before\n<span>\n## not a heading\n</span>\n\n## Real\n',
    '***\n<span>\n## not a heading\n</span>\n\n## Real\n',
  ])('ignores heading-shaped text inside raw HTML in %j', (markdown) => {
    const hidden =
      markdown.indexOf('not a heading') >= 0
        ? markdown.indexOf('not a heading')
        : markdown.indexOf('Title')
    expect(
      shiftHeadings({
        markdown,
        startOffset: hidden,
        endOffset: hidden,
        caretOffset: hidden,
        direction: 1,
      }),
    ).toEqual({ status: 'not-heading' })
    const real = markdown.indexOf('## Real') + 3
    expect(
      shiftHeadings({
        markdown,
        startOffset: real,
        endOffset: real,
        caretOffset: real,
        direction: 1,
      }).markdown,
    ).toBe(markdown.replace('## Real', '### Real'))
  })

  it('does not let a type-7 HTML tag interrupt a paragraph', () => {
    const markdown = 'paragraph\n<span>\n## Real\n'
    const real = markdown.indexOf('## Real') + 3
    expect(
      shiftHeadings({
        markdown,
        startOffset: real,
        endOffset: real,
        caretOffset: real,
        direction: 1,
      }).markdown,
    ).toBe('paragraph\n<span>\n### Real\n')
  })

  it('stops a subtree before the next same-or-higher heading', () => {
    const markdown = '## One\n\n### Child\n\n## Two\n\n### Other\n'
    const result = shiftHeadings({
      markdown,
      startOffset: 0,
      endOffset: markdown.indexOf('Child') + 2,
      caretOffset: 3,
      direction: 1,
    })
    expect(result.markdown).toBe(
      '### One\n\n#### Child\n\n## Two\n\n### Other\n',
    )
  })
})

describe('textWithout (Task 733, 007)', () => {
  const MARKERS = '.vditor-ir__marker, [data-type$="marker"]'
  // The former implementation: clone the block, remove the matching subtrees, read the text.
  const viaClone = (block: HTMLElement, selector: string): string => {
    const clone = block.cloneNode(true) as HTMLElement
    for (const node of clone.querySelectorAll(selector)) node.remove()
    return clone.textContent ?? ''
  }

  it('returns the text the clone-and-remove form returned, for heading and table blocks', () => {
    document.body.innerHTML = `<main>
      <h2 data-block="0"><span class="vditor-ir__marker">## </span>Title <b>bold</b><span data-type="heading-marker">#</span></h2>
      <table data-block="0"><thead><tr><th>A<span class="vditor-ir__marker">*</span></th><th>B</th></tr></thead><tbody><tr><td>one <span data-type="x-marker"><i>hidden</i></span>two</td><td>3</td></tr></tbody></table>
      <p data-block="0">plain <!-- note -->text</p>
    </main>`
    for (const block of Array.from(
      document.querySelector('main')!.children,
    ) as HTMLElement[])
      expect(textWithout(block, MARKERS)).toBe(viaClone(block, MARKERS))
  })

  it('does not clone the block', () => {
    document.body.innerHTML =
      '<main><table data-block="0"><tbody><tr><td>x</td></tr></tbody></table></main>'
    const table = document.querySelector('table')!
    let clones = 0
    const clone = table.cloneNode
    table.cloneNode = function (this: Node, deep?: boolean) {
      clones++
      return clone.call(this, deep)
    } as typeof table.cloneNode
    textWithout(table, MARKERS)
    headingLabel(table)
    expect(clones).toBe(0)
  })
})
