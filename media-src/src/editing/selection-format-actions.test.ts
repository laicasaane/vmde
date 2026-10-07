// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'

const { processIrToolbar, processWysToolbar, inner } = vi.hoisted(() => ({
  processIrToolbar: vi.fn(),
  processWysToolbar: vi.fn(),
  inner: { currentMode: 'ir' },
}))
vi.mock('vditor/src/ts/ir/process', () => ({
  processToolbar: processIrToolbar,
}))
vi.mock('vditor/src/ts/wysiwyg/toolbarEvent', () => ({
  toolbarEvent: processWysToolbar,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => inner }))
vi.mock('../chrome/toolbar-scroll-guard', () => ({
  findScroller: (editor: HTMLElement) => editor,
}))

import { formatIsActive, runSelectionFormat } from './selection-format-actions'

afterEach(() => {
  document.body.replaceChildren()
  processIrToolbar.mockClear()
  processWysToolbar.mockClear()
  inner.currentMode = 'ir'
})

it('dispatches a hidden-toolbar IR format through Vditor and detects active marks', () => {
  const editor = document.createElement('pre')
  editor.setAttribute('contenteditable', 'true')
  // IR marks a bold span with `data-type="strong"` (the shared rule's IR test), not a <strong> tag.
  const strong = document.createElement('span')
  strong.setAttribute('data-type', 'strong')
  const text = document.createTextNode('alpha')
  strong.append(text)
  editor.append(strong)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  expect(formatIsActive('bold', range, editor, 'ir')).toBe(true)
  expect(formatIsActive('italic', range, editor, 'ir')).toBe(false)

  expect(runSelectionFormat('bold', { editor, mode: 'ir', range })).toBe(true)
  const [owner, button, prefix, suffix] = processIrToolbar.mock.calls[0]
  expect(owner).toBe(inner)
  expect(button.dataset.type).toBe('bold')
  expect(button.classList.contains('vditor-menu--current')).toBe(true)
  expect([prefix, suffix]).toEqual(['**', '**'])
})

it('dispatches WYSIWYG formatting without a visible toolbar button', () => {
  inner.currentMode = 'wysiwyg'
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  const text = document.createTextNode('beta')
  editor.append(text)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 4)

  expect(runSelectionFormat('italic', { editor, mode: 'wysiwyg', range })).toBe(
    true,
  )
  const [owner, button, event] = processWysToolbar.mock.calls[0]
  expect(owner).toBe(inner)
  expect(button.dataset.type).toBe('italic')
  expect(event).toBeInstanceOf(MouseEvent)
})

it('applies the WYSIWYG rule (a STRONG tag) and reports inactive when blocked', () => {
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  const strong = document.createElement('strong')
  const text = document.createTextNode('beta')
  strong.append(text)
  editor.append(strong)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 1)
  range.collapse(true)
  expect(formatIsActive('bold', range, editor, 'wysiwyg')).toBe(true)
  expect(formatIsActive('italic', range, editor, 'wysiwyg')).toBe(false)
  // The same range read as IR has no data-type="strong" ancestor.
  expect(formatIsActive('bold', range, editor, 'ir')).toBe(false)
  editor.setAttribute('contenteditable', 'false')
  expect(formatIsActive('bold', range, editor, 'wysiwyg')).toBe(false)
})
