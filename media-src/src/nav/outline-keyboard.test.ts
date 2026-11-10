// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { outlineEntryLabel, outlineTipAt } from './outline-keyboard'

function build(labels: string[]): HTMLElement[] {
  const outline = document.createElement('div')
  outline.className = 'vditor-outline'
  outline.innerHTML = `<div class="vditor-outline__content"><ul>${labels
    .map(
      (label, i) =>
        `<li><span data-target-id="h${i}"><svg class="vditor-outline__action"></svg><span>${label}</span></span></li>`,
    )
    .join('')}</ul></div>`
  return Array.from(
    outline.querySelectorAll<HTMLElement>('li > span[data-target-id]'),
  )
}

describe('outlineEntryLabel', () => {
  it('is the trimmed, whitespace-collapsed label', () => {
    const items = build(['Short', '  A very   long\n heading  '])
    expect(items.map(outlineEntryLabel)).toEqual([
      'Short',
      'A very long heading',
    ])
  })
})

describe('outlineTipAt', () => {
  it('names the entry under the label or the chevron, and writes no title', () => {
    const [item] = build(['Heading'])
    for (const target of [item, item.querySelector('span')!, item.querySelector('svg')!]) {
      expect(outlineTipAt(target)).toEqual({ element: item, text: 'Heading' })
    }
    expect(item.hasAttribute('title')).toBe(false)
  })

  it('is null outside the outline and for an empty label', () => {
    expect(outlineTipAt(document.createElement('span'))).toBeNull()
    const [item] = build([''])
    expect(outlineTipAt(item)).toBeNull()
  })
})
