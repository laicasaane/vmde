import { expect, it } from 'vitest'
import {
  bubbleShouldShow,
  wikiTargetFromSelection,
} from './selection-bubble-state'

const valid = {
  enabled: true,
  mode: 'ir',
  preview: false,
  collapsed: false,
  editorOwned: true,
  composing: false,
  spinning: false,
  selecting: false,
}

it('shows only a stable visual-editor-owned noncollapsed selection', () => {
  expect(bubbleShouldShow(valid)).toBe(true)
  for (const patch of [
    { enabled: false },
    { mode: 'sv' },
    { preview: true },
    { collapsed: true },
    { editorOwned: false },
    { composing: true },
    { spinning: true },
    { selecting: true },
  ])
    expect(bubbleShouldShow({ ...valid, ...patch })).toBe(false)
  expect(bubbleShouldShow({ ...valid, mode: 'wysiwyg' })).toBe(true)
})

it('offers bounded wiki authoring only for exact safe selected text', () => {
  expect(wikiTargetFromSelection('My Page')).toBe('My Page')
  for (const text of [
    '',
    ' My Page',
    'My Page ',
    'A\nB',
    'A|B',
    '[[A]]',
    'A]B',
    'A\u0000B',
  ])
    expect(wikiTargetFromSelection(text)).toBeNull()
})
