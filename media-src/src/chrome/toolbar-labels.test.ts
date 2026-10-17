import { describe, expect, it, vi } from 'vitest'
import { createToolbar } from './toolbar'
import {
  backIcon,
  editInVsCodeIcon,
  fileMediaIcon,
  hashIcon,
  headingIcon,
  infoIcon,
  linkIcon,
  outlineIcon,
  previewIcon,
  rowInsertBottomIcon,
  rowInsertTopIcon,
  settingsGearIcon,
  sigmaIcon,
  splitHorizontalIcon,
  squarePenIcon,
  squareSigmaIcon,
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
    // Task 505 — 'ordered-list' is a command row of the shared shortcut table, so its tip is built
    // by toolbarTip (the command title), not the old bare t('numberedList') string. Task 580 CP3-1
    // left the command unbound, so the tip carries no key.
    expect(toolbarObject('ordered-list').tip).toBe('Numbered List')
    expect(toolbarObject('underline').tip).toBe('Underline')
  })

  // Task 580 CP3-2: names only, with no key.
  it('labels undo and redo by name only', () => {
    expect(toolbarObject('undo').tip).toBe('Undo')
    expect(toolbarObject('redo').tip).toBe('Redo')
  })

  it('localizes the More menu labels', () => {
    const more = toolbarObject('more')
    const menu = more.toolbar as Array<Record<string, unknown>>
    expect(menu.find((item) => item.name === 'settings')?.tip).toBe('Settings')
    expect(menu.find((item) => item.name === 'insert-anchor')?.tip).toBe(
      'Insert ID',
    )
    expect(menu.find((item) => item.name === 'info')?.tip).toContain(
      '>About Vditor</span>',
    )
    expect(menu.find((item) => item.name === 'about')?.tip).toBe('About VMDE')
  })

  it('falls back to English for incomplete Japanese and Korean packs', () => {
    expect(translate('settings', 'ja_JP')).toBe('Settings')
    expect(translate('aboutVditor', 'ko_KR')).toBe('About Vditor')
  })

  it('keeps every custom toolbar icon at a 16×16 viewport', () => {
    for (const icon of [editInVsCodeIcon, backIcon, outlineIcon, linkIcon]) {
      expect(icon).toMatch(/width="16"/)
      expect(icon).toMatch(/height="16"/)
    }
  })

  // A9, A13: Codicons are 16x16 fill icons; Tabler and Lucide are 24x24 stroke icons that keep
  // their viewBox and stroke attributes (the stroke CSS rule keys off them).
  it('keeps the approved Codicons icons as currentColor fill icons', () => {
    for (const icon of [
      previewIcon,
      splitHorizontalIcon,
      fileMediaIcon,
      infoIcon,
      settingsGearIcon,
    ]) {
      expect(icon).toMatch(/^<svg /)
      expect(icon).toContain('fill="currentColor"')
      expect(icon).not.toMatch(/fill="#|stroke=/)
    }
    expect(previewIcon).toContain('viewBox="0 0 16 16"')
    expect(settingsGearIcon).toContain('viewBox="0 0 24 24"')
  })

  it('keeps the Tabler and Lucide icons as unmodified 24x24 currentColor stroke icons', () => {
    for (const icon of [
      wikiPagesIcon,
      headingIcon,
      rowInsertTopIcon,
      rowInsertBottomIcon,
      hashIcon,
      squarePenIcon,
      sigmaIcon,
      squareSigmaIcon,
    ]) {
      expect(icon).toContain('viewBox="0 0 24 24"')
      expect(icon).toContain('fill="none"')
      expect(icon).toContain('stroke="currentColor"')
      expect(icon).toContain('stroke-width="2"')
      expect(icon).toContain('stroke-linecap="round"')
      expect(icon).toContain('stroke-linejoin="round"')
      expect(icon).not.toContain('<!--')
    }
  })

  it('composes the Wiki Pages icon from the Tabler file page and letter W', () => {
    expect(wikiPagesIcon).toContain('<path d="M14 3v4a1 1 0 0 0 1 1h4" />')
    expect(wikiPagesIcon).toContain(
      '<path d="M8.5 11.5l1.25 5.5l2.25 -4l2.25 4l1.25 -5.5" />',
    )
  })

  it('wires the approved icons into the built-in overrides and the More and Math rows', () => {
    expect(toolbarObject('headings').icon).toBe(headingIcon)
    expect(toolbarObject('preview').icon).toBe(previewIcon)
    expect(toolbarObject('edit-mode').icon).toBe(squarePenIcon)
    expect(toolbarObject('insert-before').icon).toBe(rowInsertTopIcon)
    expect(toolbarObject('insert-after').icon).toBe(rowInsertBottomIcon)
    expect(toolbarObject('wiki-pages').icon).toBe(wikiPagesIcon)

    const menu = toolbarObject('more').toolbar as Array<Record<string, string>>
    const row = (name: string) => menu.find((item) => item.name === name)!
    // Custom rows carry the icon followed by the name in a label span (A11, A12).
    expect(row('settings').icon).toBe(
      `${settingsGearIcon}<span class="vmde-menu-label">Settings</span>`,
    )
    expect(row('insert-anchor').icon).toBe(
      `${hashIcon}<span class="vmde-menu-label">Insert ID</span>`,
    )
    expect(row('insert-picture').icon).toBe(
      `${fileMediaIcon}<span class="vmde-menu-label">Insert picture</span>`,
    )
    expect(row('about').icon).toBe(
      `${infoIcon}<span class="vmde-menu-label">About VMDE</span>`,
    )
    // Built-in level-2 rows write `tip` as the row HTML.
    expect(row('info').tip).toBe(
      `${infoIcon}<span class="vmde-menu-label">About Vditor</span>`,
    )
    const both = row('both').tip
    expect(
      both.startsWith(`${splitHorizontalIcon}<span class="vmde-menu-label">`),
    ).toBe(true)
    expect(both.endsWith('</span>')).toBe(true)

    const math = toolbarObject('math').toolbar as Array<Record<string, string>>
    expect(math[0].icon).toBe(
      `${sigmaIcon}<span class="vmde-menu-label">Inline math (GitHub)</span>`,
    )
    expect(math[1].icon).toBe(
      `${squareSigmaIcon}<span class="vmde-menu-label">Math block</span>`,
    )
  })

  it('shows Settings with the cog and still opens the VMDE settings (A12)', () => {
    const post = vi.fn()
    vi.stubGlobal('vscode', { postMessage: post })
    const menu = toolbarObject('more').toolbar as Array<{
      name: string
      click?: () => void
    }>
    menu.find((item) => item.name === 'settings')!.click!()
    expect(post).toHaveBeenCalledWith({ command: 'open-settings' })
    vi.unstubAllGlobals()
  })
})
