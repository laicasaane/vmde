// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { aboutVmdeHtml, VMDE_REPO, createToolbar } from './toolbar'
import { chevronDownIcon, chevronUpIcon } from './toolbar-icons'
import {
  EDITOR_SHORTCUTS,
  TOOLBAR_COMMAND_NAMES,
} from '../../../src/shared/editor-shortcuts'

type NamedToolbarItem = { name: string; hotkey?: string; toolbar?: unknown[] }

function toolbarToken(raw: unknown): string | undefined {
  if (raw === '|') return '|'
  if (typeof raw === 'string') return raw
  return normalizeItem(raw)?.name
}

// A raw `createToolbar()` entry is either a bare string (Vditor default, no override) or an
// object — normalize to the object shape so a walker can read `.name`/`.toolbar` uniformly.
function normalizeItem(raw: unknown): NamedToolbarItem | undefined {
  if (typeof raw === 'string') return { name: raw }
  if (
    raw &&
    typeof raw === 'object' &&
    typeof (raw as { name?: unknown }).name === 'string'
  ) {
    return raw as NamedToolbarItem
  }
  return undefined
}

// Walks the FULL toolbar tree, including nested submenus (e.g. 'more's own `toolbar` array) —
// see the regression guard test below for why a top-level-only walk missed a real bug.
function collectByName(items: unknown[], out: Map<string, NamedToolbarItem>) {
  for (const raw of items) {
    const item = normalizeItem(raw)
    if (!item) continue
    out.set(item.name, item)
    if (Array.isArray(item.toolbar)) collectByName(item.toolbar, out)
  }
}

describe('aboutVmdeHtml (About VMDE dialog)', () => {
  it('shows the version line (Vditor + pinned Lute commit link + date) and repo link', () => {
    const html = aboutVmdeHtml({
      vditorVersion: '3.11.2',
      luteCommit: '36ea9e0966025d7f4f343cdf9a611109bfb29ef6',
      luteCommittedAt: '2026-06-03',
    })
    expect(html).toContain(VMDE_REPO)
    expect(html).toContain('href="https://github.com/laicasaane/vmde"')
    expect(html).toContain('Version: Vditor v3.11.2 / ')
    expect(html).toContain(
      'https://github.com/88250/lute/commit/36ea9e0966025d7f4f343cdf9a611109bfb29ef6',
    )
    expect(html).toContain('>36ea9e0</a> (2026-06-03)')
  })

  it('falls back to a plain "Lute" label when no commit is pinned', () => {
    const html = aboutVmdeHtml({
      vditorVersion: '3.11.2',
      luteCommit: '',
      luteCommittedAt: '',
    })
    expect(html).toContain('Version: Vditor v3.11.2 / Lute</li>')
    expect(html).not.toContain('lute/commit/')
  })
})

describe('createToolbar — Task 632 conventional order', () => {
  const rowOne = [
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
  // Task 631: the collapse toggle is a pure trailing append to the flat list (row one's end).
  const collapseToggle = 'collapse-toolbar'
  const rowTwo = [
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

  it('authors every control once with the exact enabled-wiki order and divider positions', () => {
    const tokens = createToolbar({ wikiEnabled: true }).map(toolbarToken)
    expect(tokens).toEqual([...rowOne, ...rowTwo, collapseToggle])

    const controls = tokens.filter((token) => token !== '|')
    expect(new Set(controls).size).toBe(35)
    expect(controls).toHaveLength(35)
  })

  it('omits wiki controls and normalizes their surrounding dividers when wiki navigation is disabled', () => {
    const tokens = createToolbar({ wikiEnabled: false }).map(toolbarToken)
    expect(tokens).toEqual([
      ...rowOne,
      ...rowTwo.slice(0, rowTwo.indexOf('navigate-back') - 1),
      ...rowTwo.slice(rowTwo.indexOf('edit-in-vscode') - 1),
      collapseToggle,
    ])

    const controls = tokens.filter((token) => token !== '|')
    expect(new Set(controls).size).toBe(33)
    expect(controls).toHaveLength(33)
  })

  it('authors the collapse toggle as a custom item with label, icon and no hotkey', () => {
    const toggle = createToolbar().find(
      (item: any) => item?.name === 'collapse-toolbar',
    ) as { tip?: string; icon?: string; hotkey?: string } | undefined

    expect(toggle?.tip).toBe('Collapse toolbar')
    expect(toggle?.hotkey).toBe('')
    expect(toggle?.icon).toBe(chevronUpIcon)
    expect(toggle?.icon).toContain('viewBox="0 0 16 16"')
    expect(toggle?.icon).toContain('width="16" height="16"')
    expect(toggle?.icon).toContain('fill="currentColor"')
    expect(chevronDownIcon).toContain('viewBox="0 0 16 16"')
    expect(chevronDownIcon).toContain('fill="currentColor"')
    expect(chevronDownIcon).not.toBe(chevronUpIcon)
  })

  it('gives Math a 16px currentColor icon while keeping its existing submenu', () => {
    const math = createToolbar().find((item: any) => item?.name === 'math') as
      | { icon?: string; toolbar?: unknown[] }
      | undefined

    expect(math?.icon).toContain('viewBox="0 0 16 16"')
    expect(math?.icon).toContain('width="16" height="16"')
    expect(math?.icon).toContain('fill="currentColor"')
    expect(math?.toolbar).toMatchObject([
      { name: 'math-inline-github', hotkey: '', tip: 'Inline math (GitHub)' },
      { name: 'math-block', hotkey: '', tip: 'Math block' },
    ])
  })
})

// Task 505 — every item a `vmde.format.*` command clicks gets `hotkey: ''` (so Vditor's own
// bubble-phase handler never sees the key — see hotKey.ts's matchHotKey) and a tip built from the
// shared shortcut table (toolbarTip). Every deliberately-unpromoted item also gets `hotkey: ''`
// (Vditor must not own a key VS Code doesn't also formally own) but no NEW tip override.
describe('createToolbar — shared shortcut table wiring (one owner per key)', () => {
  function itemsByName() {
    return new Map(
      createToolbar()
        .filter((it: any) => it && typeof it === 'object' && it.name)
        .map((it: any) => [it.name, it]),
    )
  }

  it('disables Vditor\'s own hotkey (hotkey: "") for every item a table command clicks', () => {
    const items = itemsByName()
    for (const name of TOOLBAR_COMMAND_NAMES) {
      const item = items.get(name) as { hotkey?: string } | undefined
      expect(item, name).toBeDefined()
      expect(item?.hotkey, name).toBe('')
    }
  })

  // Task 580 CP3-2 — every formatting tip is the command name only, bound or not (Policy 6).
  it('builds each formatting tip from the shared table (the command name, with no key)', () => {
    const items = itemsByName()
    const tips = Object.fromEntries(
      EDITOR_SHORTCUTS.flatMap((row) =>
        row.route !== 'host' &&
        row.route.command === 'trigger-toolbar-hotkey' &&
        row.command !== 'vmde.format.undo' &&
        row.command !== 'vmde.format.redo'
          ? [
              [
                row.route.name,
                (items.get(row.route.name) as { tip?: string }).tip,
              ],
            ]
          : [],
      ),
    )
    expect(tips).toEqual({
      bold: 'Bold',
      italic: 'Italic',
      indent: 'Indent',
      outdent: 'Outdent',
      strike: 'Strikethrough',
      headings: 'Headings',
      list: 'Bulleted List',
      'ordered-list': 'Numbered List',
      check: 'Checklist',
      quote: 'Blockquote',
      code: 'Code Block',
      'inline-code': 'Inline Code',
    })
  })

  it('disables hotkey on every deliberately-unpromoted item (link/table/line/insert-before/insert-after/emoji/undo/redo)', () => {
    const items = itemsByName()
    const noKeybind = [
      'link',
      'table',
      'line',
      'insert-before',
      'insert-after',
      'emoji',
      'undo',
      'redo',
      'callout',
    ]
    for (const name of noKeybind) {
      const item = items.get(name) as { hotkey?: string } | undefined
      expect(item, name).toBeDefined()
      expect(item?.hotkey, name).toBe('')
    }
  })

  it("does not invent a NEW tip for the no-keybinding items (falls back to Vditor's own label)", () => {
    const items = itemsByName()
    // link/table/insert-before/insert-after/emoji carry no tip override at all — the plain
    // `{ name, hotkey: '' }` shape from task 505 §5. undo/redo are NOT in this list — see the
    // next test: they carry a localized name-only tip.
    for (const name of [
      'link',
      'table',
      'insert-before',
      'insert-after',
      'emoji',
    ]) {
      const item = items.get(name) as { tip?: string } | undefined
      expect(item?.tip, name).toBeUndefined()
    }
  })

  it('labels undo/redo by name only (Task 580 CP3-2)', () => {
    const items = itemsByName()
    expect((items.get('undo') as { tip?: string }).tip).toBe('Undo')
    expect((items.get('line') as { tip?: string }).tip).toBe('Horizontal Rule')
    expect((items.get('redo') as { tip?: string }).tip).toBe('Redo')
  })

  it("promotes headings (task 505 — reclassified from 492's dropped set)", () => {
    const items = itemsByName()
    const headings = items.get('headings') as
      | { hotkey?: string; tip?: string }
      | undefined
    expect(headings?.hotkey).toBe('')
    expect(headings?.tip).toBe('Headings')
  })

  it('places the first-class Callout control immediately beside Quote', () => {
    const names = createToolbar()
      .map(normalizeItem)
      .filter((item): item is NamedToolbarItem => Boolean(item))
      .map((item) => item.name)
    const quote = names.indexOf('quote')
    expect(quote).toBeGreaterThanOrEqual(0)
    expect(names[quote + 1]).toBe('callout')
  })

  it('places Superscript immediately after Subscript, before Link', () => {
    const names = createToolbar()
      .map(normalizeItem)
      .filter((item): item is NamedToolbarItem => Boolean(item))
      .map((item) => item.name)
    const subscript = names.indexOf('subscript')
    expect(subscript).toBeGreaterThanOrEqual(0)
    expect(names[subscript + 1]).toBe('superscript')
    expect(names[subscript + 2]).toBe('|')
    expect(names[subscript + 3]).toBe('link')
  })

  it('places one Math submenu right after Code Block with GitHub inline and block actions', () => {
    const items = createToolbar() as NamedToolbarItem[]
    const names = items.map((item) => item.name)
    const code = names.indexOf('code')
    const math = items.find((item) => item.name === 'math')
    expect(math?.name).toBe('math')
    expect(names[code + 1]).toBe('math')
    expect(math?.hotkey).toBe('')
    expect(math?.toolbar).toMatchObject([
      { name: 'math-inline-github', hotkey: '', tip: 'Inline math (GitHub)' },
      { name: 'math-block', hotkey: '', tip: 'Math block' },
    ])
  })

  // Regression guard: `itemsByName()` above only walks TOP-LEVEL items — it never caught 'both'
  // (nested inside the 'more' submenu's own `toolbar` array) still carrying Vditor's native `⌘P`
  // hotkey, live and un-neutralised, shadowing VS Code's Ctrl+P (Quick Open) and rendering its
  // tooltip in Vditor's `<...>` bracket style instead of `toolbarTip`'s `(...)` style — found by
  // the user spotting the bracket-style mismatch in the real editor, not by any test. Every name
  // Vditor's own `Options.ts` assigns a default hotkey to (`media-src/node_modules/vditor/src/ts/
  // util/Options.ts`) must be neutralised (`hotkey: ''`) WHEREVER it appears in the toolbar tree,
  // nested or not — this walks the whole tree instead of trusting a fixed nesting depth.
  it('neutralises every Vditor-native hotkeyed item at ANY nesting depth, not just the top level', () => {
    // Names Options.ts gives a non-empty `hotkey` to, minus 'fullscreen' (not present in this
    // toolbar at all — createToorbar() never lists it, so there's nothing to neutralise).
    const VDITOR_NATIVE_HOTKEY_NAMES = [
      'emoji',
      'headings',
      'bold',
      'italic',
      'strike',
      'link',
      'list',
      'ordered-list',
      'check',
      'outdent',
      'indent',
      'quote',
      'line',
      'code',
      'inline-code',
      'insert-before',
      'insert-after',
      'table',
      'undo',
      'redo',
      'both',
    ]

    const all = new Map<string, { name: string; hotkey?: string }>()
    collectByName(createToolbar() as unknown[], all)

    for (const name of VDITOR_NATIVE_HOTKEY_NAMES) {
      const item = all.get(name)
      expect(
        item,
        `"${name}" should exist somewhere in the toolbar tree`,
      ).toBeDefined()
      expect(item?.hotkey, name).toBe('')
    }
  })
})

// Task 580 CP3-2 (Policy 6) — no toolbar tip names a key. An extension cannot read a user's
// remapped keys, so a shown key could be wrong. A non-empty `hotkey` would make Vditor append its
// own `<⌘X>` hint, so it counts as a key hint too.
const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/

describe('createToolbar — tooltips show names only (Task 580 CP3-2)', () => {
  it.each([true, false])(
    'no item at any depth carries a key in its tip or a Vditor hotkey (wikiEnabled: %s)',
    (wikiEnabled) => {
      const all = new Map<string, NamedToolbarItem & { tip?: string }>()
      collectByName(createToolbar({ wikiEnabled }) as unknown[], all)
      expect(all.size).toBeGreaterThan(30)
      for (const [name, item] of all) {
        expect(item.tip ?? '', name).not.toMatch(KEY_HINT)
        expect(item.hotkey ?? '', name).toBe('')
      }
    },
  )
})

// Task 608 — the Link button at a blockless IR range. Owner rule (2026-10-08, extended 2026-10-14
// to a non-collapsed range that starts at the root): refuse, so no edit reaches Vditor and no
// history entry is made. In-block ranges and the empty editor keep Vditor's insertion.
describe('createToolbar — Link at a blockless IR range (Task 608)', () => {
  const HR_FIRST =
    '<hr data-block="0"><p data-block="0">Alpha bravo</p><p data-block="0">Echo</p>'

  function setup(html: string, mode = 'ir') {
    document.body.innerHTML =
      '<div class="vditor-reset" contenteditable="true"></div>'
    const root = document.querySelector<HTMLElement>('.vditor-reset')!
    root.innerHTML = html
    const insertValue = vi.fn()
    const updateValue = vi.fn()
    const focus = vi.fn()
    const outer = {
      getCurrentMode: () => mode,
      vditor: { currentMode: mode, ir: { element: root, range: undefined } },
      focus,
      insertValue,
      updateValue,
    }
    vi.stubGlobal('vditor', outer)
    const link = createToolbar().find((item: any) => item?.name === 'link') as {
      click(): void
    }
    return {
      root,
      outer,
      insertValue,
      updateValue,
      focus,
      click: () => link.click(),
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('refuses at a collapsed root range: no insertion, no value update', () => {
    const t = setup(HR_FIRST)
    window.getSelection()!.collapse(t.root, 0)
    t.click()
    expect(t.insertValue).not.toHaveBeenCalled()
    expect(t.updateValue).not.toHaveBeenCalled()
    expect(t.root.innerHTML).toBe(HR_FIRST)
  })

  it('refuses at a collapsed root range between blocks (offset 1)', () => {
    const t = setup(HR_FIRST)
    window.getSelection()!.collapse(t.root, 1)
    t.click()
    expect(t.insertValue).not.toHaveBeenCalled()
    expect(t.updateValue).not.toHaveBeenCalled()
  })

  it('refuses a non-collapsed range that starts at the root', () => {
    const t = setup(HR_FIRST)
    const text = t.root.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(t.root, 0)
    range.setEnd(text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    t.click()
    expect(t.insertValue).not.toHaveBeenCalled()
    expect(t.updateValue).not.toHaveBeenCalled()
  })

  it('refuses when focus synthesizes a root range for a fresh editor with no live range', () => {
    const t = setup(HR_FIRST)
    window.getSelection()!.removeAllRanges()
    t.outer.focus.mockImplementation(() => {
      window.getSelection()!.collapse(t.root, 0)
    })
    t.click()
    expect(t.focus).toHaveBeenCalled()
    expect(t.insertValue).not.toHaveBeenCalled()
    expect(t.updateValue).not.toHaveBeenCalled()
  })

  it('inserts an empty link at a caret inside a block', () => {
    const t = setup(HR_FIRST)
    const text = t.root.querySelector('p')!.firstChild!
    window.getSelection()!.collapse(text, 0)
    t.click()
    expect(t.insertValue).toHaveBeenCalledWith('[]()')
    expect(t.updateValue).not.toHaveBeenCalled()
  })

  it('wraps a selection inside a block', () => {
    const t = setup(HR_FIRST)
    const text = t.root.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    t.click()
    expect(t.updateValue).toHaveBeenCalledWith('[Alpha]()')
    expect(t.insertValue).not.toHaveBeenCalled()
  })

  it('keeps Vditor insertion in the empty editor (no block to protect)', () => {
    const t = setup('')
    window.getSelection()!.collapse(t.root, 0)
    t.click()
    expect(t.insertValue).toHaveBeenCalledWith('[]()')
  })
})
