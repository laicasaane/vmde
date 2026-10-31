import { describe, expect, it } from 'vitest'
import {
  decodeFragment,
  findIdTarget,
  idTargetsInTag,
  parseIdTargetsFromMarkdown,
  resolveFragmentTarget,
} from '../../src/shared/id-target'
import {
  idTargetValueAtSourceOffset,
  idValueRefusal,
  planIdInsertion,
} from '../../media-src/src/editing/id-insertion'

describe('idTargetsInTag', () => {
  it('reads id on any element and name only on a', () => {
    expect(idTargetsInTag('<span id="limits">')).toEqual([
      { value: 'limits', attribute: 'id' },
    ])
    expect(idTargetsInTag('<div id="faq" class="x">')).toEqual([
      { value: 'faq', attribute: 'id' },
    ])
    expect(idTargetsInTag('<h2 id="intro">')).toEqual([
      { value: 'intro', attribute: 'id' },
    ])
    expect(idTargetsInTag('<a name="legacy">')).toEqual([
      { value: 'legacy', attribute: 'name' },
    ])
    expect(idTargetsInTag('<span name="x">')).toEqual([])
    expect(idTargetsInTag('<area name="x">')).toEqual([])
  })

  it('emits id before name for a tag that carries both', () => {
    expect(idTargetsInTag('<a name="n" id="i">')).toEqual([
      { value: 'i', attribute: 'id' },
      { value: 'n', attribute: 'name' },
    ])
  })

  it('tokenizes attribute names instead of matching substrings', () => {
    expect(idTargetsInTag('<span data-id="x">')).toEqual([])
    expect(idTargetsInTag('<span aria-id="x" ID="y">')).toEqual([
      { value: 'y', attribute: 'id' },
    ])
    expect(idTargetsInTag('<span id=bare>')).toEqual([])
    expect(idTargetsInTag('<span id="">')).toEqual([])
  })

  it('keeps the first occurrence of a repeated attribute', () => {
    expect(idTargetsInTag('<a id="x" id="z">')).toEqual([
      { value: 'x', attribute: 'id' },
    ])
  })

  it('does not treat end tags, comments or autolinks as tags', () => {
    expect(idTargetsInTag('</a id="x">')).toEqual([])
    expect(idTargetsInTag('<!-- id="x" -->')).toEqual([])
    expect(idTargetsInTag('<https://example.com/?id="x">')).toEqual([])
  })
})

describe('parseIdTargetsFromMarkdown', () => {
  it('finds HTML a name targets case-insensitively in source order', () => {
    expect(
      parseIdTargetsFromMarkdown(
        '<a name="first"></a>\n<A NAME=\'second\'></A>\n',
      ),
    ).toEqual([
      { value: 'first', line: 0, attribute: 'name' },
      { value: 'second', line: 1, attribute: 'name' },
    ])
  })

  it('finds id targets on a, span, div and heading elements in source order', () => {
    expect(
      parseIdTargetsFromMarkdown(
        '<a id="one"></a>text <span id="two">x</span>\n\n<div id="three">q</div>\n\n<h2 id="four">h</h2>',
      ).map((target) => [target.value, target.line, target.attribute]),
    ).toEqual([
      ['one', 0, 'id'],
      ['two', 0, 'id'],
      ['three', 2, 'id'],
      ['four', 4, 'id'],
    ])
  })

  it('ignores target-looking source in fenced, indented, and inline code', () => {
    expect(
      parseIdTargetsFromMarkdown(
        '```html\n<a name="fenced"></a>\n<span id="fenced2"></span>\n```\n    <a name="indented"></a>\n`<a name="inline"></a>` `<span id="inline2">`\n<a name="real"></a>\n<span id="real2"></span>',
      ).map((target) => [target.value, target.line]),
    ).toEqual([
      ['real', 6],
      ['real2', 7],
    ])
  })

  it('rejects malformed, escaped, and non-target tags', () => {
    expect(
      parseIdTargetsFromMarkdown(
        '\\<a name="escaped"></a>\n<a name=bare></a>\n<span name="span-name"></span>\n<area name="area"></area>\n<a name="ok"',
      ),
    ).toEqual([])
  })

  it('counts CRLF documents by the same lines', () => {
    expect(
      parseIdTargetsFromMarkdown('one\r\n<a id="x"></a>\r\n<a name="y"></a>'),
    ).toEqual([
      { value: 'x', line: 1, attribute: 'id' },
      { value: 'y', line: 2, attribute: 'name' },
    ])
  })

  it('keeps the first duplicate target and supports decoded fragments at resolution', () => {
    const anchors = parseIdTargetsFromMarkdown(
      '<a name="café"></a>\n<a name="café"></a>',
    )
    expect(findIdTarget(anchors, decodeFragment('caf%C3%A9'))).toEqual({
      value: 'café',
      line: 0,
      attribute: 'name',
    })
    expect(findIdTarget(anchors, decodeFragment('bad%escape'))).toBeUndefined()
  })
})

describe('findIdTarget', () => {
  it('prefers the first id target over an earlier name target', () => {
    const targets = parseIdTargetsFromMarkdown(
      '<a name="same"></a>\n<span id="same"></span>',
    )
    expect(findIdTarget(targets, 'same')).toEqual({
      value: 'same',
      line: 1,
      attribute: 'id',
    })
  })

  it('compares values case-sensitively', () => {
    const targets = parseIdTargetsFromMarkdown('<span id="intro"></span>')
    expect(findIdTarget(targets, 'Intro')).toBeUndefined()
  })
})

describe('decodeFragment', () => {
  it('decodes valid escapes and keeps a malformed one literal', () => {
    expect(decodeFragment('a%20b')).toBe('a b')
    expect(decodeFragment('bad%escape')).toBe('bad%escape')
  })
})

describe('resolveFragmentTarget', () => {
  it('reaches an id target by raw and by encoded fragment', () => {
    expect(
      resolveFragmentTarget('text\n<a id="café"></a>', 'caf%C3%A9', 'github'),
    ).toEqual({
      kind: 'target',
      target: { value: 'café', line: 1, attribute: 'id' },
    })
  })

  it('goes to an id target that precedes a same-name heading', () => {
    const markdown = '<a id="setup"></a>\n\n# Setup\n'
    expect(resolveFragmentTarget(markdown, 'setup', 'github')).toEqual({
      kind: 'target',
      target: { value: 'setup', line: 0, attribute: 'id' },
    })
  })

  it('goes to a heading that precedes a same-name id target', () => {
    const markdown = '# Setup\n\n<a id="setup"></a>\n'
    expect(resolveFragmentTarget(markdown, 'setup', 'github')).toEqual({
      kind: 'heading',
      index: 0,
    })
  })

  it('prefers the heading when both sit on the same line', () => {
    const markdown = '# <span id="setup"></span>Title {#setup}\n'
    expect(resolveFragmentTarget(markdown, 'setup', 'github')).toEqual({
      kind: 'heading',
      index: 0,
    })
  })

  it('lets a heading or id target beat an earlier name target', () => {
    expect(
      resolveFragmentTarget(
        '<a name="setup"></a>\n# Setup\n',
        'setup',
        'github',
      ),
    ).toEqual({ kind: 'heading', index: 0 })
    expect(
      resolveFragmentTarget(
        '<a name="x"></a>\n<span id="x"></span>\n',
        'x',
        'github',
      ),
    ).toEqual({
      kind: 'target',
      target: { value: 'x', line: 1, attribute: 'id' },
    })
  })

  it('still reaches a name target when nothing else owns the value', () => {
    expect(
      resolveFragmentTarget('x\n<a name="legacy"></a>', 'legacy', 'github'),
    ).toEqual({
      kind: 'target',
      target: { value: 'legacy', line: 1, attribute: 'name' },
    })
  })

  it('returns undefined for an empty or unknown fragment and for code-only tags', () => {
    expect(
      resolveFragmentTarget('<a id="x"></a>', '', 'github'),
    ).toBeUndefined()
    expect(
      resolveFragmentTarget('<a id="x"></a>', 'y', 'github'),
    ).toBeUndefined()
    expect(
      resolveFragmentTarget('`<span id="x">`', 'x', 'github'),
    ).toBeUndefined()
  })
})

describe('planIdInsertion', () => {
  it('inserts an id target at the preserved caret without replacing selected prose', () => {
    expect(planIdInsertion('before selected after', 15, 'custom')).toEqual({
      markdown: 'before selected<a id="custom"></a> after',
      caret: 34,
    })
  })

  it('rejects blank, unsafe, and duplicate target values of either form', () => {
    expect(planIdInsertion('text', 0, '  ')).toBeNull()
    expect(planIdInsertion('text', 0, 'bad name')).toBeNull()
    expect(planIdInsertion('<a name="taken"></a>', 0, 'taken')).toBeNull()
    expect(planIdInsertion('<a id="taken"></a>', 0, 'taken')).toBeNull()
    expect(planIdInsertion('<span id="taken"></span>', 0, 'taken')).toBeNull()
  })

  it('rejects a value that a heading already uses', () => {
    expect(planIdInsertion('# The Heading\n', 0, 'the-heading')).toBeNull()
    expect(planIdInsertion('## Title {#custom}\n', 0, 'custom')).toBeNull()
  })
})

describe('idValueRefusal', () => {
  it('names the reason in the order invalid, duplicate, heading', () => {
    const markdown = '# Intro\n\n<a id="taken"></a>\n<a name="legacy"></a>\n'
    expect(idValueRefusal(markdown, 'bad name', 'github')).toBe('invalid')
    expect(idValueRefusal(markdown, '1abc', 'github')).toBe('invalid')
    expect(idValueRefusal(markdown, 'taken', 'github')).toBe('duplicate')
    expect(idValueRefusal(markdown, 'legacy', 'github')).toBe('duplicate')
    expect(idValueRefusal(markdown, 'intro', 'github')).toBe('heading')
    expect(idValueRefusal(markdown, 'fresh', 'github')).toBeUndefined()
  })

  it('reports a duplicate before a heading when both use the value', () => {
    expect(
      idValueRefusal('# Same\n\n<a id="same"></a>\n', 'same', 'github'),
    ).toBe('duplicate')
  })

  it('uses the given slugify mode for heading anchors', () => {
    // U+203F is connector punctuation: GitLab keeps it in a slug, GitHub strips it.
    expect(idValueRefusal('# a\u203Fb\n', 'ab', 'github')).toBe('heading')
    expect(idValueRefusal('# a\u203Fb\n', 'ab', 'gitlab')).toBeUndefined()
  })
})

describe('idTargetValueAtSourceOffset', () => {
  it('offers inspection only for a caret on a supported ID target line', () => {
    const markdown =
      'before\n<a name="custom"></a> after\n`<a name="code"></a>`'
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('name="custom"')),
    ).toBe('custom')
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('</a>') + 4),
    ).toBeUndefined()
    expect(idTargetValueAtSourceOffset(markdown, 0)).toBeUndefined()
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('code')),
    ).toBeUndefined()
  })

  it('inspects an id target on an anchor and on another element', () => {
    const markdown = '<a id="one"></a>\n<span id="two">x</span>'
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('id="one"')),
    ).toBe('one')
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('id="two"')),
    ).toBe('two')
  })

  it('shows the id value when a tag carries both forms', () => {
    const markdown = '<a name="n" id="i"></a>'
    expect(
      idTargetValueAtSourceOffset(markdown, markdown.indexOf('name=')),
    ).toBe('i')
  })

  it('does not inspect a tag without a target or one inside a fence', () => {
    const plain = '<span class="x">text</span>'
    expect(
      idTargetValueAtSourceOffset(plain, plain.indexOf('class')),
    ).toBeUndefined()
    const fenced = '```\n<span id="x">\n```'
    expect(
      idTargetValueAtSourceOffset(fenced, fenced.indexOf('id=')),
    ).toBeUndefined()
  })
})
