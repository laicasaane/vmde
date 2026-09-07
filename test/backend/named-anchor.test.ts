import { describe, expect, it } from 'vitest'
import {
  findNamedAnchor,
  parseNamedAnchorsFromMarkdown,
} from '../../src/shared/named-anchor'
import {
  namedAnchorNameAtSourceOffset,
  planNamedAnchorInsertion,
} from '../../media-src/src/editing/named-anchor-insertion'

describe('parseNamedAnchorsFromMarkdown', () => {
  it('finds HTML a name targets case-insensitively in source order', () => {
    expect(
      parseNamedAnchorsFromMarkdown(
        '<a name="first"></a>\n<A NAME=\'second\'></A>\n',
      ),
    ).toEqual([
      { name: 'first', line: 0 },
      { name: 'second', line: 1 },
    ])
  })

  it('ignores anchor-looking source in fenced, indented, and inline code', () => {
    expect(
      parseNamedAnchorsFromMarkdown(
        '```html\n<a name="fenced"></a>\n```\n    <a name="indented"></a>\n`<a name="inline"></a>`\n<a name="real"></a>',
      ),
    ).toEqual([{ name: 'real', line: 5 }])
  })

  it('rejects malformed, escaped, and non-anchor tags', () => {
    expect(
      parseNamedAnchorsFromMarkdown(
        '\\<a name="escaped"></a>\n<a name=bare></a>\n<a id="id-only"></a>\n<area name="area"></area>\n<a name="ok"',
      ),
    ).toEqual([])
  })

  it('keeps the first duplicate target and supports decoded fragments at resolution', () => {
    const anchors = parseNamedAnchorsFromMarkdown(
      '<a name="café"></a>\n<a name="café"></a>',
    )
    expect(findNamedAnchor(anchors, 'caf%C3%A9')).toEqual({
      name: 'café',
      line: 0,
    })
    expect(findNamedAnchor(anchors, 'bad%escape')).toBeUndefined()
  })
})

describe('planNamedAnchorInsertion', () => {
  it('inserts at the preserved caret without replacing selected prose', () => {
    expect(
      planNamedAnchorInsertion('before selected after', 15, 'custom'),
    ).toEqual({
      markdown: 'before selected<a name="custom"></a> after',
      caret: 36,
    })
  })

  it('rejects blank, unsafe, and duplicate target names', () => {
    expect(planNamedAnchorInsertion('text', 0, '  ')).toBeNull()
    expect(planNamedAnchorInsertion('text', 0, 'bad name')).toBeNull()
    expect(
      planNamedAnchorInsertion('<a name="taken"></a>', 0, 'taken'),
    ).toBeNull()
  })
})

describe('namedAnchorNameAtSourceOffset', () => {
  it('offers inspection only for a caret on a supported named-anchor line', () => {
    const markdown =
      'before\n<a name="custom"></a> after\n`<a name="code"></a>`'
    expect(
      namedAnchorNameAtSourceOffset(
        markdown,
        markdown.indexOf('name="custom"'),
      ),
    ).toBe('custom')
    expect(
      namedAnchorNameAtSourceOffset(markdown, markdown.indexOf('</a>') + 4),
    ).toBeUndefined()
    expect(namedAnchorNameAtSourceOffset(markdown, 0)).toBeUndefined()
    expect(
      namedAnchorNameAtSourceOffset(markdown, markdown.indexOf('code')),
    ).toBeUndefined()
  })
})
