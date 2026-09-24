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
  'headings',
  '|',
  'bold',
  'italic',
  'strike',
  'subscript',
  'superscript',
  'underline',
  '|',
  'link',
  'list',
  'ordered-list',
  'check',
  '|',
  'outdent',
  'indent',
  '|',
  'quote',
  'callout',
  'details',
  'line',
  'code',
  'inline-code',
  '|',
  'emoji',
  '|',
  'math',
]
const ownerRowTwo = [
  'insert-before',
  'insert-after',
  '|',
  'upload',
  'table',
  '|',
  'undo',
  'redo',
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
  for (const token of [...ownerRowOne, ...rowTwo]) {
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

      expect(rows.map(rowTokens)).toEqual([ownerRowOne, expectedRowTwo])
      expect(rows.map((row) => row.dataset.vmdeToolbarRow)).toEqual(['1', '2'])
      expect(rows[0].querySelector('[data-type="insert-before"]')).toBeNull()
      expect(rows[1].querySelector('[data-type="math"]')).toBeNull()
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
