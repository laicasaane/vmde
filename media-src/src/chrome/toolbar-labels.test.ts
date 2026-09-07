import { describe, expect, it } from 'vitest'
import { createToolbar } from './toolbar'
import {
  backIcon,
  editInVsCodeIcon,
  linkIcon,
  outlineIcon,
  wikiPagesIcon,
} from './toolbar-icons'
import { translate } from '../util/lang'

function toolbarObject(name: string): Record<string, unknown> {
  const item = createToolbar({ wikiEnabled: true }).find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      candidate.name === name,
  )
  expect(item).toBeDefined()
  return item as Record<string, unknown>
}

describe('toolbar labels and icons', () => {
  it('uses explicit, readable labels for the ambiguous formatting actions', () => {
    expect(toolbarObject('line').tip).toBe('Horizontal Rule')
    // Task 505 — 'ordered-list' is now a promoted FORMAT_HOTKEYS row, so its tip is built by
    // formatTip (label + the shared table's own key), not the old bare t('numberedList') string.
    expect(toolbarObject('ordered-list').tip).toBe(
      'Numbered List (Ctrl+Shift+7)',
    )
    expect(toolbarObject('underline').tip).toBe('Underline')
  })

  it('advertises both redo shortcuts', () => {
    expect(toolbarObject('redo').tip).toBe('Redo (Shift+Ctrl/Cmd+Z)')
  })

  it('localizes the More menu labels', () => {
    const more = toolbarObject('more')
    const menu = more.toolbar as Array<Record<string, unknown>>
    expect(menu.find((item) => item.name === 'settings')?.tip).toBe('Settings')
    expect(menu.find((item) => item.name === 'info')?.tip).toBe('About Vditor')
    expect(menu.find((item) => item.name === 'about')?.tip).toBe('About VMDE')
  })

  it('falls back to English for incomplete Japanese and Korean packs', () => {
    expect(translate('settings', 'ja_JP')).toBe('Settings')
    expect(translate('aboutVditor', 'ko_KR')).toBe('About Vditor')
  })

  it('keeps every custom toolbar icon at a 16×16 viewport', () => {
    for (const icon of [
      editInVsCodeIcon,
      wikiPagesIcon,
      backIcon,
      outlineIcon,
      linkIcon,
    ]) {
      expect(icon).toMatch(/width="16"/)
      expect(icon).toMatch(/height="16"/)
    }
  })
})
