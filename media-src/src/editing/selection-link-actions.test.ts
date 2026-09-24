// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../nav/block-handle', () => ({ currentBlockProjection: vi.fn() }))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: () => ({ currentMode: 'ir' }),
}))
vi.mock('../util/source-map', () => ({
  activeModeElement: () => document.querySelector('pre'),
}))
vi.mock('./rewrap-command', () => ({
  captureRewrapSourceRange: vi.fn(),
  checkpointEditorUndo: vi.fn(),
  recordRewrapDocumentHistory: vi.fn(),
}))
vi.mock('./table-actions', () => ({
  snapshotTableUndoForRollback: vi.fn(),
  restoreTableUndoForRollback: vi.fn(),
}))

import { runSelectedLink } from './selection-link-actions'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('declines a stale exact host snapshot before touching the editor or posting Markdown', () => {
  const editor = document.createElement('pre')
  const text = document.createTextNode('alpha')
  editor.append(text)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  const outer = { getValue: () => 'alpha' } as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const insert = vi.fn()
  document.execCommand = insert
  const postExact = vi.fn()
  const setApplying = vi.fn()
  const onError = vi.fn()

  expect(
    runSelectedLink(
      'wiki',
      { outer, editor, mode: 'ir', range, exact: 'alpha', rendered: 'alpha' },
      {
        snapshotExactMarkdown: () => 'externally changed alpha',
        setApplying,
        postExact,
        onError,
      },
    ),
  ).toBe(false)
  expect(insert).not.toHaveBeenCalled()
  expect(setApplying).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})
