// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ensureToolbarRows } from './toolbar-layout'

function item(name: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'vditor-toolbar__item'
  wrapper.innerHTML = `<button data-type="${name}"></button>`
  return wrapper
}

describe('ensureToolbarRows', () => {
  it('leaves an actionless toolbar empty so a hidden-toolbar setting cannot paint blank rows', () => {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'

    expect(ensureToolbarRows(toolbar)).toEqual([])
    expect(toolbar.childElementCount).toBe(0)
  })

  it('moves the existing action wrappers into two deliberate rows and stays idempotent', () => {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const headings = item('headings')
    const bold = item('bold')
    const list = item('list')
    const more = item('more')
    toolbar.append(headings, bold, list, more)

    const rows = ensureToolbarRows(toolbar)
    expect(rows.map((row) => row.dataset.vmdeToolbarRow)).toEqual(['1', '2'])
    expect(rows[0].contains(headings)).toBe(true)
    expect(rows[0].contains(bold)).toBe(true)
    expect(rows[1].contains(list)).toBe(true)
    expect(rows[1].contains(more)).toBe(true)
    expect(ensureToolbarRows(toolbar)).toEqual(rows)
  })
})
