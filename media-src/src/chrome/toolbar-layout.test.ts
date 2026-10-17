// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ensureToolbarRows } from './toolbar-layout'

function item(name: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'vditor-toolbar__item'
  wrapper.innerHTML = `<button data-type="${name}"></button>`
  return wrapper
}

// Task 642: one authored sequence; the flow pass distributes it into rows by width.
const sequence = [
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
  '|',
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
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'preview',
  'edit-mode',
  'more',
]
// Task 631: a pure trailing append to the flat list; it lands at the end of row one.
const collapseToggle = 'collapse-toolbar'

function divider(): HTMLElement {
  const element = document.createElement('div')
  element.className = 'vditor-toolbar__divider'
  return element
}

function buildOwnerToolbar(wikiEnabled: boolean): HTMLElement {
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  const wikiStart = sequence.indexOf('navigate-back')
  const editStart = sequence.indexOf('edit-in-vscode') - 1
  const tokens = wikiEnabled
    ? sequence
    : [...sequence.slice(0, wikiStart - 1), ...sequence.slice(editStart)]
  for (const token of [...tokens, collapseToggle]) {
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
    'authors every control and divider into row one in sequence order and leaves row two empty and hidden (wiki enabled: %s)',
    (wikiEnabled) => {
      const toolbar = buildOwnerToolbar(wikiEnabled)
      const rows = ensureToolbarRows(toolbar)
      const wikiStart = sequence.indexOf('navigate-back')
      const editStart = sequence.indexOf('edit-in-vscode') - 1
      const expected = wikiEnabled
        ? sequence
        : [...sequence.slice(0, wikiStart - 1), ...sequence.slice(editStart)]

      expect(rows.map(rowTokens)).toEqual([[...expected, collapseToggle], []])
      expect(rows.map((row) => row.dataset.vmdeToolbarRow)).toEqual(['1', '2'])
      expect(rows[0].hidden).toBe(false)
      expect(rows[1].hidden).toBe(true)
      expect(rows[0].querySelector('[data-type="math"]')).not.toBeNull()
      expect(rows[0].querySelector('[data-type="more"]')).not.toBeNull()
    },
  )

  it('moves the existing action wrappers into row one and stays idempotent', () => {
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
    expect(rows[0].contains(more)).toBe(true)
    expect(rows[1].childElementCount).toBe(0)
    expect(ensureToolbarRows(toolbar)).toEqual(rows)
  })
})
