// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  scanMovableBlocks,
  type MovableBlock,
} from '../../../src/shared/block-move'
import { createRealLute } from '../testing/real-lute'
import {
  type BlockProjection,
  canonicalMembers,
  canonicalUnit,
  detachedRoot,
  domKind,
  domUnits,
  fragmentMatches,
  pairSourceGroups,
} from './unit-pairing'

function projection(): BlockProjection {
  const real = createRealLute('ir')
  return {
    owner: real.lute,
    mode: 'ir',
    render: (markdown) => real.render(markdown),
    serialize: (html) => real.serialize(html),
  }
}

const el = (html: string): HTMLElement =>
  detachedRoot(html).firstElementChild as HTMLElement

describe('detachedRoot', () => {
  it('parses the markup into a detached div', () => {
    const root = detachedRoot('<p>a</p><hr>')
    expect(root.tagName).toBe('DIV')
    expect(root.isConnected).toBe(false)
    expect(root.children).toHaveLength(2)
  })
})

describe('domKind', () => {
  it('names the kind of each block element', () => {
    expect(domKind(el('<p>a</p>'))).toBe('paragraph')
    expect(domKind(el('<h2>a</h2>'))).toBe('heading')
    expect(domKind(el('<table><tr><td>a</td></tr></table>'))).toBe('table')
    expect(domKind(el('<hr>'))).toBe('thematic')
    expect(domKind(el('<blockquote><p>a</p></blockquote>'))).toBe('quote')
    expect(domKind(el('<div data-type="code-block"></div>'))).toBe('fence')
    expect(domKind(el('<div data-type="math-block"></div>'))).toBe('math')
  })

  it('names a list item and a table wrapper, and returns null without a kind', () => {
    const list = el('<ul><li>a</li></ul>')
    expect(domKind(list.firstElementChild as HTMLElement)).toBe('list-item')
    expect(domKind(el('<div><table></table></div>'))).toBe('table')
    expect(domKind(el('<span>a</span>'))).toBeNull()
  })
})

describe('domUnits', () => {
  it('expands lists to their items', () => {
    const units = domUnits(
      detachedRoot(
        '<p data-block="0">a</p><ul data-block="0"><li>x</li><li>y</li></ul>',
      ),
      false,
    )
    expect(units?.map((unit) => unit.tagName)).toEqual(['P', 'LI', 'LI'])
  })

  it('declines a list holding a non-item child', () => {
    expect(
      domUnits(
        detachedRoot('<ul data-block="0"><li>x</li><p>y</p></ul>'),
        false,
      ),
    ).toBeNull()
  })

  it('drops a trailing placeholder only when allowed', () => {
    const html =
      '<p data-block="0">a</p><p data-block="0" data-vmde-trailing="true">\u200b</p>'
    expect(
      domUnits(detachedRoot(html), true)?.map((unit) => unit.textContent),
    ).toEqual(['a'])
    expect(domUnits(detachedRoot(html), false)).toBeNull()
  })
})

describe('pairSourceGroups', () => {
  const block = (kind: string, memberKinds?: string[]): MovableBlock =>
    ({ kind, memberKinds }) as unknown as MovableBlock

  it('pairs source blocks with plain objects through kindOf', () => {
    const items = [{ k: 'paragraph' }, { k: 'heading' }, { k: 'thematic' }]
    const source = [block('paragraph'), block('heading'), block('thematic')]
    const pairs = pairSourceGroups(
      source,
      items,
      (item) => item.k as 'paragraph',
    )
    expect(pairs?.map((pair) => pair.members)).toEqual([
      [items[0]],
      [items[1]],
      [items[2]],
    ])
  })

  it('groups members by memberKinds', () => {
    const items = [{ k: 'list-item' }, { k: 'list-item' }]
    const pairs = pairSourceGroups(
      [block('list-item', ['list-item', 'list-item'])],
      items,
      (item) => item.k as 'list-item',
    )
    expect(pairs).toHaveLength(1)
    expect(pairs?.[0].members).toEqual(items)
  })

  it('returns null for a kind mismatch, a missing element or a surplus element', () => {
    const kindOf = (item: { k: string }) => item.k as 'paragraph'
    expect(
      pairSourceGroups([block('heading')], [{ k: 'paragraph' }], kindOf),
    ).toBeNull()
    expect(pairSourceGroups([block('paragraph')], [], kindOf)).toBeNull()
    expect(
      pairSourceGroups(
        [block('paragraph')],
        [{ k: 'paragraph' }, { k: 'paragraph' }],
        kindOf,
      ),
    ).toBeNull()
  })
})

describe('canonicalUnit and canonicalMembers', () => {
  it('serializes a block and a list item in its own list shell', () => {
    const proof = projection()
    const root = detachedRoot(proof.render('para\n\n- one\n- two\n'))
    const units = domUnits(root, false) as HTMLElement[]
    expect(canonicalUnit(units[0], proof)).toBe('para\n')
    expect(canonicalUnit(units[2], proof)).toBe('- two\n')
    expect(canonicalMembers([units[0]], proof)).toBe('para\n')
  })

  it('serializes a group of list items together and returns empty for an orphan item', () => {
    const proof = projection()
    const units = domUnits(
      detachedRoot(proof.render('- one\n- two\n')),
      false,
    ) as HTMLElement[]
    expect(canonicalMembers(units, proof)).toBe('- one\n- two\n')
    expect(canonicalUnit(el('<li>x</li>'), proof)).toBe('')
  })
})

describe('fragmentMatches', () => {
  it('accepts a fragment whose live and detached members agree with the source', () => {
    const proof = projection()
    const markdown = 'hello **x**\n'
    const members = domUnits(
      detachedRoot(proof.render(markdown)),
      false,
    ) as HTMLElement[]
    const source = scanMovableBlocks(markdown)
    const pairs = pairSourceGroups(source, members, domKind)
    expect(pairs).not.toBeNull()
    expect(
      fragmentMatches(
        (pairs as NonNullable<typeof pairs>)[0],
        members,
        members,
        markdown,
        proof,
      ),
    ).toBe(true)
  })

  it('rejects a live member that serializes differently', () => {
    const proof = projection()
    const markdown = 'hello\n'
    const members = domUnits(
      detachedRoot(proof.render(markdown)),
      false,
    ) as HTMLElement[]
    const pairs = pairSourceGroups(
      scanMovableBlocks(markdown),
      members,
      domKind,
    ) as NonNullable<ReturnType<typeof pairSourceGroups<HTMLElement>>>
    const edited = [el('<p data-block="0">other</p>')]
    expect(fragmentMatches(pairs[0], members, edited, markdown, proof)).toBe(
      false,
    )
  })
})
