// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createBlockAnchor, resolveBlockAnchor } from './block-anchor'

function blocks(markup: string): HTMLElement[] {
  document.body.innerHTML = `<main>${markup}</main>`
  return Array.from(document.querySelector('main')!.children) as HTMLElement[]
}

describe('block anchors', () => {
  it('reanchors the same block by content after blocks are inserted above it', () => {
    const before = blocks(`
      <h1 data-block="0">Guide</h1>
      <p data-block="0">Alpha</p>
      <p data-block="0">Remember me</p>
    `)
    const anchor = createBlockAnchor(before[2], before)
    const after = blocks(`
      <h1 data-block="0">Guide</h1>
      <p data-block="0">Inserted</p>
      <p data-block="0">Alpha</p>
      <p data-block="0">Remember me</p>
    `)

    expect(resolveBlockAnchor(anchor, after)).toBe(after[3])
  })

  it('uses the heading path to disambiguate duplicate block content', () => {
    const before = blocks(`
      <h1 data-block="0">First</h1><p data-block="0">Same</p>
      <h1 data-block="0">Second</h1><p data-block="0">Same</p>
    `)
    const anchor = createBlockAnchor(before[3], before)
    const after = blocks(`
      <h1 data-block="0">Inserted</h1><p data-block="0">Same</p>
      <h1 data-block="0">First</h1><p data-block="0">Same</p>
      <h1 data-block="0">Second</h1><p data-block="0">Same</p>
    `)

    expect(resolveBlockAnchor(anchor, after)).toBe(after[5])
  })

  it('falls back to the bounded original index when content no longer matches', () => {
    const before = blocks(
      '<h1 data-block="0">Title</h1><p data-block="0">Old</p>',
    )
    const anchor = createBlockAnchor(before[1], before)
    const after = blocks(
      '<h1 data-block="0">Title</h1><p data-block="0">Rewritten</p>',
    )

    expect(resolveBlockAnchor(anchor, after)).toBe(after[1])
  })
})

describe('block anchor text (Task 733, 007)', () => {
  it('ignores transient markers and does not clone a table block', () => {
    const table = blocks(
      '<table data-block="0"><tbody><tr><td>one<span class="vditor-ir__marker">|</span></td><td>two<span class="vmde-find-overlay">found</span></td></tr></tbody></table>',
    )
    const plain = blocks(
      '<table data-block="0"><tbody><tr><td>one</td><td>two</td></tr></tbody></table>',
    )
    const first = table[0]
    let clones = 0
    const clone = first.cloneNode
    first.cloneNode = function (this: Node, deep?: boolean) {
      clones++
      return clone.call(this, deep)
    } as typeof first.cloneNode
    const marked = createBlockAnchor(first, table).hash
    expect(clones).toBe(0)
    expect(marked).toBe(createBlockAnchor(plain[0], plain).hash)
  })
})
