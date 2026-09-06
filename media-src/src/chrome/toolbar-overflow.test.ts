// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolbar } from './toolbar'
import { ensureToolbarRows } from './toolbar-layout'
import {
  KNOWN_TOOLBAR_ITEMS,
  computeOverflow,
  decideOverflowGroups,
  installToolbarOverflow,
} from './toolbar-overflow'

const clusters = [
  { name: 'emoji', width: 24 },
  { name: 'undo-redo', width: 48 },
  { name: 'outline', width: 28 },
]

describe('computeOverflow', () => {
  it('keeps every cluster at an exact fit', () => {
    expect(
      computeOverflow({
        available: 40 + 24 + 48 + 28,
        pinnedWidth: 40,
        clusters,
      }),
    ).toEqual({
      visible: ['emoji', 'undo-redo', 'outline'],
      overflowed: [],
    })
  })

  it('gives way in order while preserving the hysteresis band', () => {
    expect(
      computeOverflow({
        available: 40 + 24 + 48 + 28 - 7,
        pinnedWidth: 40,
        clusters,
      }),
    ).toEqual({
      visible: ['emoji', 'undo-redo', 'outline'],
      overflowed: [],
    })
    expect(
      computeOverflow({
        available: 40 + 24 + 48 + 28 - 8,
        pinnedWidth: 40,
        clusters,
      }),
    ).toEqual({
      visible: ['undo-redo', 'outline'],
      overflowed: ['emoji'],
    })
  })

  it('overflows every cluster when only the pinned band fits', () => {
    expect(
      computeOverflow({ available: 40, pinnedWidth: 40, clusters }),
    ).toEqual({
      visible: [],
      overflowed: ['emoji', 'undo-redo', 'outline'],
    })
  })

  it('does not make a layout decision for a hidden zero-width container', () => {
    expect(
      computeOverflow({ available: 0, pinnedWidth: 40, clusters }),
    ).toEqual({
      visible: ['emoji', 'undo-redo', 'outline'],
      overflowed: [],
    })
  })
})

describe('decideOverflowGroups', () => {
  it('keeps an asset group intact and stops once the production fit probe succeeds', () => {
    const groups = [
      ['upload', 'table'],
      ['undo', 'redo'],
    ]
    expect([
      ...decideOverflowGroups(groups, (overflowed) => overflowed.size >= 2),
    ]).toEqual(['upload', 'table'])
  })
})

const ITEM_WIDTH = 30

/** Build a toolbar whose container reports `hostWidth`, matching the real DOM shape closely enough
 *  for the shell: `.vditor-toolbar__item` wrappers around a `[data-type]` button, `more` owning the
 *  `.vditor-hint` panel, and dividers between the groups. */
function buildToolbar(hostWidth: number) {
  const itemWidth = { value: ITEM_WIDTH }
  const host = document.createElement('div')
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  host.append(toolbar)
  document.body.append(host)

  const item = (name: string, arrow = false) => {
    const wrapper = document.createElement('div')
    wrapper.className = 'vditor-toolbar__item'
    const button = document.createElement('button')
    button.dataset.type = name
    button.className = 'vditor-tooltipped vditor-tooltipped__s'
    button.setAttribute('aria-label', name)
    wrapper.append(button)
    if (arrow) {
      const nested = document.createElement('div')
      nested.className = 'vditor-panel vditor-panel--arrow'
      wrapper.append(nested)
    }
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => ({ width: itemWidth.value }),
    })
    return wrapper
  }
  const dividers: HTMLElement[] = []
  const divider = () => {
    const el = document.createElement('div')
    el.className = 'vditor-toolbar__divider'
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ width: 0 }),
    })
    dividers.push(el)
    return el
  }
  const elements = {
    emoji: item('emoji', true),
    headings: item('headings', true),
    bold: item('bold'),
    undo: item('undo'),
    redo: item('redo'),
    editMode: item('edit-mode'),
    preview: item('preview'),
    editInVsCode: item('edit-in-vscode'),
    wikiPages: item('wiki-pages'),
    more: item('more'),
  }
  // Authored the way toolbar.ts writes the wiki items: pinned by class, not by name.
  elements.wikiPages.classList.add('right')
  const morePanel = document.createElement('div')
  morePanel.className = 'vditor-hint'
  // The menu ships with authored level-2 rows; overflowed items must not displace them.
  const settingsRow = document.createElement('div')
  settingsRow.innerHTML = '<button data-type="settings">Settings</button>'
  morePanel.append(settingsRow)
  elements.more.append(morePanel)
  toolbar.append(
    elements.emoji,
    elements.headings,
    elements.bold,
    divider(),
    elements.undo,
    elements.redo,
    divider(),
    elements.editMode,
    elements.preview,
    elements.editInVsCode,
    elements.wikiPages,
    elements.more,
  )
  const container = { width: hostWidth }
  Object.defineProperty(host, 'getBoundingClientRect', {
    value: () => ({ width: container.width }),
  })

  // Keep the observer callback so a test can re-run one layout pass at a different container width.
  let notify = () => {
    /* default before the ResizeObserver stub below captures the real callback */
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notify = callback
      }
      // Fake ResizeObserver: the test drives layout passes via `notify` directly,
      // so observe/disconnect have nothing real to do.
      observe() {
        /* no-op: see class comment above */
      }
      disconnect() {
        /* no-op: see class comment above */
      }
    },
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    /* no pending-cancel assertions in this suite — the stub only needs to
       exist so code that calls cancelAnimationFrame doesn't throw under jsdom */
  })

  const rowNames = () =>
    Array.from(toolbar.children)
      .map((child) =>
        child.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
      )
      .filter(Boolean)

  return {
    host,
    toolbar,
    morePanel,
    elements,
    rowNames,
    container,
    itemWidth,
    dividers,
    resize: (width: number) => {
      container.width = width
      notify()
    },
  }
}

describe('installToolbarOverflow', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('measures the two rows independently while More stays in row two', () => {
    const { host, toolbar, elements } = buildToolbar(100)
    ensureToolbarRows(toolbar)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const [first, second] = Array.from(
      toolbar.querySelectorAll(':scope > .vmde-toolbar-row'),
    ) as HTMLElement[]
    expect(first.querySelector('[data-type="headings"]')).not.toBeNull()
    expect(first.querySelector('[data-type="bold"]')).not.toBeNull()
    expect(second.querySelector('[data-type="more"]')).not.toBeNull()
    expect(second.querySelector('[data-type="undo"]')).not.toBeNull()
    expect(second.querySelector('[data-type="redo"]')).not.toBeNull()
    expect(elements.headings.parentElement).toBe(first)

    dispose()
    host.remove()
  })

  it('moves a submenu owner into more and restores it with its authored DOM', () => {
    // 100px cannot even hold the pinned band, so this drives the pinned give-way branch.
    const { host, toolbar, morePanel, elements } = buildToolbar(100)

    const { headings } = elements
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<svg><symbol id="vditor-icon-emoji" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></symbol></svg>',
    )
    headings
      .querySelector('button')
      ?.insertAdjacentHTML(
        'afterbegin',
        '<svg><use href="#vditor-icon-emoji"></use></svg>',
      )
    const refresh = vi.fn()
    const dispose = installToolbarOverflow(toolbar, refresh)
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()
    expect(headings.querySelector('svg > path')).not.toBeNull()
    expect(headings.querySelector('svg > use')).toBeNull()
    expect(headings.querySelector('.vditor-panel--arrow')).toBeNull()
    expect(
      headings.querySelector('button')?.classList.contains('vditor-tooltipped'),
    ).toBe(false)

    dispose()
    expect(headings.parentElement).toBe(toolbar)
    expect(headings.querySelector('.vditor-panel--arrow')).not.toBeNull()
    expect(
      headings.querySelector('button')?.classList.contains('vditor-tooltipped'),
    ).toBe(true)
    expect(headings.querySelector('svg > use')).not.toBeNull()
    expect(refresh).toHaveBeenCalled()
    host.remove()
  })

  // Regression guard: the only DOM test used to sit below the pinned width, so it exercised the
  // pinned give-way branch alone — and a bug that emptied the cluster list (killing the ordinary
  // give-way path entirely) shipped green. This case stays above the pinned band on purpose.
  it('gives way cluster by cluster while the pinned band still fits', () => {
    // 24px is reserved ahead of More during live resize; 204px therefore exercises the same
    // ordinary cluster path as the former 180px fixture while keeping the pinned band intact.
    const { host, toolbar, morePanel, rowNames } = buildToolbar(204)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()
    expect(toolbar.querySelector('[data-type="emoji"]')).not.toBeNull()
    expect(toolbar.querySelector('[data-type="undo"]')).not.toBeNull()
    expect(toolbar.querySelector('[data-type="redo"]')).not.toBeNull()
    expect(rowNames()).toContain('emoji')
    expect(rowNames()).toContain('undo')
    expect(rowNames()).toContain('redo')

    // Overflowed rows sit above the divider; the authored Settings row keeps its place below it.
    const panelOrder = Array.from(morePanel.children).map(
      (child) =>
        child
          .querySelector(':scope > [data-type]')
          ?.getAttribute('data-type') ?? child.className,
    )
    const divider = panelOrder.findIndex((name) =>
      name.includes('vmde-toolbar-overflow-divider'),
    )
    expect(divider).toBeGreaterThan(0)
    expect(panelOrder.indexOf('headings')).toBeLessThan(divider)
    expect(panelOrder.indexOf('settings')).toBeGreaterThan(divider)

    dispose()
    expect(morePanel.querySelector('[data-type="settings"]')).not.toBeNull()
    host.remove()
  })

  // A hidden tab collapses the webview to zero width — the scenario `flex-wrap: nowrap` exists for.
  // Deciding there would move everything into `more` and paint that on the way back.
  it('makes no layout decision while the container is collapsed to zero width', () => {
    // Start from a width that HAS overflowed items, so a decision at width 0 would be visible: it
    // would hand them all back to the row and paint that wrapped frame on the way back.
    const { host, toolbar, morePanel, resize, rowNames } = buildToolbar(180)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const collapsedPanel = Array.from(morePanel.children).length
    const collapsedRow = rowNames()
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()

    resize(0)
    expect(Array.from(morePanel.children).length).toBe(collapsedPanel)
    expect(rowNames()).toEqual(collapsedRow)
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()

    dispose()
    host.remove()
  })

  // Widths are cached, so a font-size or zoom change (both of which a VS Code webview gets) has to
  // invalidate them — and the re-measure must happen from a row holding every item, since an item
  // inside `more` reports its panel width instead of its row width.
  it('re-measures when the font size changes, not on every resize', () => {
    const { host, toolbar, morePanel, resize, itemWidth } = buildToolbar(400)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="emoji"]')).toBeNull()

    // Same container width, but every item is suddenly twice as wide: without a re-measure the
    // stale cache says everything still fits.
    itemWidth.value = ITEM_WIDTH * 3
    toolbar.style.fontSize = '30px'
    resize(400)
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()

    dispose()
    host.remove()
  })

  // The wiki pair is authored with `className: 'right'` (toolbar.ts:144-172), which makes it pinned.
  // Pinned must never mean immovable: if a `.right` item could not give way, the narrowest widths
  // would push `more` — the only route to everything inside it — off the edge.
  it('lets a .right-classed item give way ahead of the named pins', () => {
    const { host, toolbar, morePanel, rowNames, elements } = buildToolbar(100)
    const wiki = elements.wikiPages
    expect(wiki.classList.contains('right')).toBe(true)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="wiki-pages"]')).not.toBeNull()
    expect(rowNames()).toContain('more')
    // It goes before edit-mode does — edit-mode is the last of the named pins.
    expect(rowNames()).toContain('edit-mode')

    dispose()
    host.remove()
  })

  // A divider is not an item: once every item on one side of it has overflowed it is a rule with
  // nothing to separate, and the row would start, end, or break twice on a stray vertical line.
  it('keeps primary-row separators stable across a narrow-width restoration', () => {
    const { host, toolbar, dividers, resize } = buildToolbar(1000)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(dividers.map((d) => d.style.display)).toEqual(['', ''])

    // This fixture's separators straddle row ownership after ensureToolbarRows; they must not be
    // rewritten while primary controls remain direct in their rows.
    resize(100)
    expect(dividers.map((d) => d.style.display)).toEqual(['', ''])

    resize(1000)
    expect(dividers.map((d) => d.style.display)).toEqual(['', ''])

    dispose()
    expect(dividers.map((d) => d.style.display)).toEqual(['', ''])
    host.remove()
  })

  // Task 504: an open more menu is STALE once the overflow set changes (items move into or out of
  // it) — e.g. a widen returns items to the row, so an open menu shows a layout that no longer
  // exists. The overflow pass must close it; before this fix the panel was left open across a widen
  // and the second toggle click closed it instead of reopening it.
  it('closes an open more panel when the overflow set changes', () => {
    const { host, toolbar, morePanel, resize } = buildToolbar(180)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()

    morePanel.style.display = 'block' // the user opened the menu
    resize(1000) // widen → emoji returns to the row → overflow set changes
    expect(morePanel.style.display).toBe('none')

    dispose()
    host.remove()
  })

  it('keeps an open more panel while the overflow set is unchanged', () => {
    const { host, toolbar, morePanel, resize } = buildToolbar(180)
    const dispose = installToolbarOverflow(toolbar, vi.fn())

    morePanel.style.display = 'block'
    resize(180) // same width → same overflow set → no write pass → panel stays open
    expect(morePanel.style.display).toBe('block')

    dispose()
    host.remove()
  })

  // Task 504 extension: the same stale-open rule now covers the other three submenu triggers
  // (emoji/headings/edit-mode, toolbar-submenu-aria.ts) — an open panel must not survive an
  // overflow change, or it would travel with its item into or out of `more`.
  it('closes an open emoji submenu panel when the overflow set changes', () => {
    const { host, toolbar, elements, morePanel, resize } = buildToolbar(180)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const headingsPanel = elements.headings.querySelector(
      '.vditor-panel',
    ) as HTMLElement
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()
    headingsPanel.style.display = 'block'
    resize(1000)
    expect(headingsPanel.style.display).toBe('none')

    dispose()
    host.remove()
  })

  it('restores items to their authored position, not to the end of the row', () => {
    const { host, toolbar, morePanel, rowNames } = buildToolbar(180)

    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()

    dispose()
    const order = rowNames()
    expect(order.indexOf('emoji')).toBeLessThan(order.indexOf('headings'))
    expect(order.indexOf('headings')).toBeLessThan(order.indexOf('bold'))
    expect(order.indexOf('bold')).toBeLessThan(order.indexOf('undo'))
    expect(order.indexOf('undo')).toBeLessThan(order.indexOf('edit-mode'))
    host.remove()
  })
})

// toolbar.ts is the sole author of the row; CLUSTER_ORDER / PINNED_ORDER are a second, hand-kept
// list of the same names. Nothing links them at compile time, and the failure is silent — an
// unlisted item simply never overflows. This is the link.
describe('give-way lists vs the authored toolbar', () => {
  const authoredNames = (wikiEnabled: boolean) =>
    createToolbar({ wikiEnabled })
      .map((item: { name?: string }) => item.name)
      .filter((name): name is string => Boolean(name) && name !== '|')

  it('covers every authored item, with and without wiki', () => {
    for (const wikiEnabled of [false, true]) {
      const missing = authoredNames(wikiEnabled).filter(
        (name) => !KNOWN_TOOLBAR_ITEMS.includes(name),
      )
      // The wiki pair is pinned by CSS class rather than by name, so it is allowed to be absent.
      expect(
        missing.filter(
          (name) => !['navigate-back', 'wiki-pages'].includes(name),
        ),
      ).toEqual([])
    }
  })

  it('lists no name the toolbar does not author', () => {
    const authored = new Set(authoredNames(true))
    expect(KNOWN_TOOLBAR_ITEMS.filter((name) => !authored.has(name))).toEqual(
      [],
    )
  })
})
