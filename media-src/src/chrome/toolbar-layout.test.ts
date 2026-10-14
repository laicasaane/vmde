// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ensureToolbarRows } from './toolbar-layout'

function item(name: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'vditor-toolbar__item'
  wrapper.innerHTML = `<button data-type="${name}"></button>`
  return wrapper
}

const ownerRowOne = [
  'undo',
  'redo',
  '|',
  'headings',
  '|',
  'bold',
  'italic',
  'underline',
  'strike',
  'inline-code',
  '|',
  'subscript',
  'superscript',
  '|',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  '|',
  'outdent',
  'indent',
]
// Task 631: a pure trailing append to the flat list; it lands at the end of row one.
const collapseToggle = 'collapse-toolbar'
const ownerRowTwo = [
  'quote',
  'callout',
  'details',
  'code',
  'math',
  'table',
  'line',
  '|',
  'upload',
  'emoji',
  '|',
  'insert-before',
  'insert-after',
  '|',
  'outline',
  'preview',
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'edit-mode',
  'more',
]

function divider(): HTMLElement {
  const element = document.createElement('div')
  element.className = 'vditor-toolbar__divider'
  return element
}

function buildOwnerToolbar(wikiEnabled: boolean): HTMLElement {
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  const wikiStart = ownerRowTwo.indexOf('navigate-back')
  const editStart = ownerRowTwo.indexOf('edit-in-vscode') - 1
  const rowTwo = wikiEnabled
    ? ownerRowTwo
    : [...ownerRowTwo.slice(0, wikiStart - 1), ...ownerRowTwo.slice(editStart)]
  for (const token of [...ownerRowOne, ...rowTwo, collapseToggle]) {
    toolbar.append(token === '|' ? divider() : item(token))
  }
  return toolbar
}

function rowTokens(row: HTMLElement): string[] {
  return Array.from(row.children).map((child) =>
    child.classList.contains('vditor-toolbar__divider')
      ? '|'
      : (child
          .querySelector(':scope > [data-type]')
          ?.getAttribute('data-type') ?? ''),
  )
}

describe('ensureToolbarRows', () => {
  it('leaves an actionless toolbar empty so a hidden-toolbar setting cannot paint blank rows', () => {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'

    expect(ensureToolbarRows(toolbar)).toEqual([])
    expect(toolbar.childElementCount).toBe(0)
  })

  it.each([true, false])(
    'places the owner controls and separators in exact row order (wiki enabled: %s)',
    (wikiEnabled) => {
      const toolbar = buildOwnerToolbar(wikiEnabled)
      const rows = ensureToolbarRows(toolbar)
      const wikiStart = ownerRowTwo.indexOf('navigate-back')
      const editStart = ownerRowTwo.indexOf('edit-in-vscode') - 1
      const expectedRowTwo = wikiEnabled
        ? ownerRowTwo
        : [
            ...ownerRowTwo.slice(0, wikiStart - 1),
            ...ownerRowTwo.slice(editStart),
          ]

      expect(rows.map(rowTokens)).toEqual([
        [...ownerRowOne, collapseToggle],
        expectedRowTwo,
      ])
      expect(rows.map((row) => row.dataset.vmdeToolbarRow)).toEqual(['1', '2'])
      expect(rows[0].querySelector('[data-type="insert-before"]')).toBeNull()
      expect(rows[0].querySelector('[data-type="math"]')).toBeNull()
      expect(rows[1].querySelector('[data-type="math"]')).not.toBeNull()
      expect(rows[1].querySelector('[data-type="emoji"]')).not.toBeNull()
      expect(rows[0].querySelector('[data-type="undo"]')).not.toBeNull()
    },
  )

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
    expect(rows[0].contains(list)).toBe(true)
    expect(rows[1].contains(more)).toBe(true)
    expect(ensureToolbarRows(toolbar)).toEqual(rows)
  })
})
