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
  const strong = document.createElement('strong')
  const text = document.createTextNode('alpha')
  strong.append(text)
  editor.append(strong)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  expect(formatIsActive('bold', range, editor)).toBe(true)
  expect(formatIsActive('italic', range, editor)).toBe(false)

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
