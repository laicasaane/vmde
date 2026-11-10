// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { applyOutlineTitles } from './outline-keyboard'

function build(labels: string[]): HTMLElement[] {
  const ul = document.createElement('ul')
  ul.innerHTML = labels
    .map(
      (label, i) =>
        `<li><span data-target-id="h${i}"><svg class="vditor-outline__action"></svg><span>${label}</span></span></li>`,
    )
    .join('')
  return Array.from(
    ul.querySelectorAll<HTMLElement>('li > span[data-target-id]'),
  )
}

describe('applyOutlineTitles', () => {
  it('sets each entry title to its trimmed, whitespace-collapsed label', () => {
    const items = build(['Short', '  A very   long\n heading  '])
    applyOutlineTitles(items)
    expect(items.map((i) => i.getAttribute('title'))).toEqual([
      'Short',
      'A very long heading',
    ])
  })

  it('updates the title after a rebuild with changed text', () => {
    const before = build(['Old'])
    applyOutlineTitles(before)
    const after = build(['New text'])
    applyOutlineTitles(after)
    expect(after[0].getAttribute('title')).toBe('New text')
  })

  it('does not rewrite an unchanged title', () => {
    const items = build(['Stable'])
    applyOutlineTitles(items)
    const spy = vi.spyOn(items[0], 'setAttribute')
    applyOutlineTitles(items)
    expect(spy).not.toHaveBeenCalled()
  })

  it('rewrites a title only when its label changed', () => {
    const items = build(['One', 'Two'])
    applyOutlineTitles(items)
    items[1].lastElementChild!.textContent = 'Two changed'
    const spies = items.map((i) => vi.spyOn(i, 'setAttribute'))
    applyOutlineTitles(items)
    expect(spies[0]).not.toHaveBeenCalled()
    expect(spies[1]).toHaveBeenCalledWith('title', 'Two changed')
  })
})
