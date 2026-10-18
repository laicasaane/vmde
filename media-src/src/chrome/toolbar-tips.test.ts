// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  applyToolbarTips,
  applyToolbarTipDirections,
  collapseToggleTip,
  TIP_EDGE_BAND_PX,
  tipDirection,
  tipFor,
  toolbarTipNames,
} from './toolbar-tips'
import { createToolbar } from './toolbar'
import { ROW_TIP_ATTRIBUTE } from './toolbar-row-hover'
import { EDITOR_SHORTCUTS } from '../../../src/shared/editor-shortcuts'

interface Item {
  name: string
  toolbar?: Item[]
}

function walk(items: unknown[], out: Item[] = []): Item[] {
  for (const raw of items) {
    const item = (typeof raw === 'string' ? { name: raw } : raw) as Item
    if (item.name === '|') continue
    out.push(item)
    if (item.toolbar) walk(item.toolbar, out)
  }
  return out
}

// Every name key combination in the shortcut table, e.g. "ctrl+b": a tip must never contain one.
const KEY_STRINGS = EDITOR_SHORTCUTS.flatMap((row) =>
  row.keys === 'unbound' ? [] : [...row.keys.winLinux, ...row.keys.mac],
).filter((keys) => keys.length > 1)
const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/

describe('toolbar tips: coverage (A10)', () => {
  it.each([true, false])(
    'has a non-empty description with no key for every authored item at any depth (wikiEnabled: %s)',
    (wikiEnabled) => {
      const items = walk(createToolbar({ wikiEnabled }) as unknown[])
      expect(items.length).toBeGreaterThan(40)
      for (const item of items) {
        const tip = tipFor(item.name)
        expect(tip, item.name).toBeTruthy()
        expect(tip, item.name).not.toMatch(KEY_HINT)
        for (const key of KEY_STRINGS) expect(tip, item.name).not.toContain(key)
      }
    },
  )

  it('has a different, descriptive tip for each toggle state', () => {
    const expanded = collapseToggleTip(false)
    const collapsed = collapseToggleTip(true)
    expect(expanded).toBe('Collapse the toolbar to one row of small buttons')
    expect(collapsed).toBe('Expand the toolbar to full-size buttons')
    for (const tip of [expanded, collapsed]) expect(tip).not.toMatch(KEY_HINT)
  })

  it('lists exactly the table rows the handoff names', () => {
    expect(toolbarTipNames()).toContain('math-inline-github')
    expect(toolbarTipNames()).toContain('insert-anchor')
    expect(tipFor('bold')).toBe('Make the selection bold')
    expect(tipFor('insert-anchor')).toBe('Insert an ID that links can jump to')
    expect(tipFor('preview')).toBe(
      'Switch between editing and a read-only preview',
    )
  })

  it('throws for an unknown name so a typo cannot ship an empty tooltip', () => {
    expect(() => tipFor('no-such-item')).toThrow()
  })
})

function toolbarDom() {
  document.body.innerHTML =
    '<div class="vditor-toolbar">' +
    '<div class="vditor-toolbar__item"><button class="vditor-tooltipped vditor-tooltipped__s" data-type="bold" aria-label="Bold"></button></div>' +
    '<div class="vditor-toolbar__item"><button class="vditor-tooltipped vditor-tooltipped__s" data-type="more" aria-label="More"></button>' +
    '<div class="vditor-hint">' +
    '<div><button data-type="settings">Settings</button></div>' +
    '<div class="vditor-toolbar__item"><button class="vditor-tooltipped" data-type="emoji" aria-label="Emoji"></button></div>' +
    '</div></div>' +
    '<div class="vditor-toolbar__item"><button class="vditor-tooltipped" data-type="math" aria-label="Math"></button>' +
    '<div class="vditor-hint"><div><button data-type="math-block">Math block</button></div></div></div>' +
    '<div class="vditor-toolbar__item"><button class="vditor-tooltipped" data-type="collapse-toolbar" aria-label="Collapse toolbar"></button></div>' +
    '</div>'
  return document.querySelector<HTMLElement>('.vditor-toolbar')!
}

describe('applyToolbarTips', () => {
  it('sets data-vmde-tip and aria-description on top-level buttons, leaving aria-label', () => {
    const toolbar = toolbarDom()
    applyToolbarTips(toolbar)
    const bold = toolbar.querySelector<HTMLElement>('[data-type="bold"]')!
    expect(bold.dataset.vmdeTip).toBe(tipFor('bold'))
    expect(bold.getAttribute('aria-description')).toBe(tipFor('bold'))
    expect(bold.getAttribute('aria-label')).toBe('Bold')
    expect(bold.hasAttribute('title')).toBe(false)
  })

  it('sets the row hover attribute and aria-description, no title and no data-vmde-tip, on authored More and Math rows', () => {
    const toolbar = toolbarDom()
    applyToolbarTips(toolbar)
    for (const name of ['settings', 'math-block']) {
      const row = toolbar.querySelector<HTMLElement>(`[data-type="${name}"]`)!
      expect(row.getAttribute(ROW_TIP_ATTRIBUTE), name).toBe(tipFor(name))
      expect(row.getAttribute('aria-description'), name).toBe(tipFor(name))
      expect(row.hasAttribute('title'), name).toBe(false)
      expect(row.dataset.vmdeTip, name).toBeUndefined()
    }
    expect(toolbar.querySelector('[title]')).toBeNull()
  })

  it('leaves the toggle and an already overflowed control to their own passes', () => {
    const toolbar = toolbarDom()
    applyToolbarTips(toolbar)
    const toggle = toolbar.querySelector<HTMLElement>(
      '[data-type="collapse-toolbar"]',
    )!
    expect(toggle.dataset.vmdeTip).toBeUndefined()
    const overflowed = toolbar.querySelector<HTMLElement>(
      '.vditor-hint [data-type="emoji"]',
    )!
    expect(overflowed.dataset.vmdeTip).toBeUndefined()
  })
})

describe('tooltip direction (160 px edge bands)', () => {
  it('uses __se within the left band, __sw within the right band, __s elsewhere', () => {
    expect(TIP_EDGE_BAND_PX).toBe(160)
    expect(tipDirection(100, 0, 1000)).toBe('__se')
    expect(tipDirection(159, 0, 1000)).toBe('__se')
    expect(tipDirection(160, 0, 1000)).toBe('__s')
    expect(tipDirection(500, 0, 1000)).toBe('__s')
    expect(tipDirection(840, 0, 1000)).toBe('__s')
    expect(tipDirection(841, 0, 1000)).toBe('__sw')
    expect(tipDirection(990, 0, 1000)).toBe('__sw')
  })

  it('picks the nearer edge when the toolbar is narrower than two bands', () => {
    expect(tipDirection(100, 0, 250)).toBe('__se')
    expect(tipDirection(150, 0, 250)).toBe('__sw')
  })

  it('replaces the direction class on each button from its measured centre, and pins the toggle to __sw', () => {
    const toolbar = toolbarDom()
    toolbar.getBoundingClientRect = () => rect(0, 1000)
    const place = (name: string, left: number, width: number) => {
      toolbar.querySelector<HTMLElement>(
        `.vditor-toolbar__item > [data-type="${name}"]`,
      )!.getBoundingClientRect = () => rect(left, width)
    }
    place('bold', 20, 25)
    place('more', 480, 25)
    place('collapse-toolbar', 100, 17)
    applyToolbarTipDirections(toolbar)
    const cls = (name: string) =>
      toolbar.querySelector(`[data-type="${name}"]`)!.className
    expect(cls('bold')).toContain('vditor-tooltipped__se')
    expect(cls('more')).toMatch(/vditor-tooltipped__s(?!\w)/)
    expect(cls('collapse-toolbar')).toContain('vditor-tooltipped__sw')
    // A second pass with the same geometry changes nothing.
    applyToolbarTipDirections(toolbar)
    expect(cls('bold')).toBe('vditor-tooltipped vditor-tooltipped__se')
  })
})

function rect(left: number, width: number): DOMRect {
  return {
    left,
    right: left + width,
    width,
    top: 0,
    bottom: 24,
    height: 24,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect
}
