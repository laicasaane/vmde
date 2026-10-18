// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolbar } from './toolbar'
import { COLLAPSED_CLASS } from './toolbar-collapse'
import { ensureToolbarRows } from './toolbar-layout'
import {
  KNOWN_TOOLBAR_ITEMS,
  TWO_ROWS_CLASS,
  flowToolbarOnce,
  installToolbarOverflow,
} from './toolbar-overflow'
import { applyToolbarTips } from './toolbar-tips'
import { ROW_TIP_ATTRIBUTE } from './toolbar-row-hover'

const ITEM_WIDTH = 30
const TOGGLE_WIDTH = 30

// Task 642: one authored sequence, `|` marking a group boundary; the toggle is appended last.
const SEQUENCE =
  'undo redo | headings | bold italic | link insert-anchor | quote callout | upload insert-picture emoji | outline | edit-in-vscode preview edit-mode settings more'
const CONTROLS = SEQUENCE.split(' ').filter((token) => token !== '|')

/** Build a toolbar whose container reports `hostWidth`, matching the real DOM shape closely enough
 *  for the shell: `.vditor-toolbar__item` wrappers around a `[data-type]` button, `more` owning the
 *  `.vditor-hint` panel, dividers between the groups and the trailing collapse toggle. */
function buildToolbar(hostWidth: number, sequence = SEQUENCE) {
  const itemWidth = { value: ITEM_WIDTH }
  const host = document.createElement('div')
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  host.append(toolbar)
  document.body.append(host)

  const arrowItems = new Set(['emoji', 'headings'])
  const elements: Record<string, HTMLElement> = {}
  const dividers: HTMLElement[] = []
  const item = (name: string) => {
    const wrapper = document.createElement('div')
    wrapper.className = 'vditor-toolbar__item'
    const button = document.createElement('button')
    button.dataset.type = name
    button.className = 'vditor-tooltipped vditor-tooltipped__s'
    button.setAttribute('aria-label', name)
    wrapper.append(button)
    if (arrowItems.has(name)) {
      const nested = document.createElement('div')
      nested.className = 'vditor-panel vditor-panel--arrow'
      wrapper.append(nested)
    }
    Object.defineProperty(wrapper, 'getBoundingClientRect', {
      value: () => ({
        width: name === 'collapse-toolbar' ? TOGGLE_WIDTH : itemWidth.value,
      }),
    })
    elements[name] = wrapper
    return wrapper
  }
  const divider = () => {
    const el = document.createElement('div')
    el.className = 'vditor-toolbar__divider'
    el.style.margin = '0 8px'
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ width: 1 }),
    })
    dividers.push(el)
    return el
  }
  for (const token of sequence.split(' ')) {
    toolbar.append(token === '|' ? divider() : item(token))
  }
  toolbar.append(item('collapse-toolbar'))
  const morePanel = document.createElement('div')
  morePanel.className = 'vditor-hint'
  // The menu ships with authored level-2 rows; moved controls must not displace them.
  const aboutRow = document.createElement('div')
  aboutRow.innerHTML = '<button data-type="about">About VMDE</button>'
  morePanel.append(aboutRow)
  elements.more.append(morePanel)
  // Wiki-style controls are pinned by class in production; they must flow like any other control.
  elements.headings.classList.add('right')
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

  const rows = ensureToolbarRows(toolbar)
  const names = (parent: Element) =>
    Array.from(parent.children).map((child) =>
      child.classList.contains('vditor-toolbar__divider')
        ? '|'
        : (child
            .querySelector(':scope > [data-type]')
            ?.getAttribute('data-type') ?? ''),
    )
  /** Rows as token lists, then the controls held by More. */
  const layout = () => ({
    rows: rows.map(names),
    more: Array.from(
      morePanel.querySelectorAll(':scope > .vditor-toolbar__item'),
    )
      .map((child) =>
        child.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
      )
      .filter(Boolean) as string[],
  })

  return {
    host,
    toolbar,
    morePanel,
    elements,
    rows,
    layout,
    container,
    itemWidth,
    dividers,
    resize: (width: number) => {
      container.width = width
      notify()
    },
  }
}

/** Every control appears exactly once across the rows and More: none missing, none duplicated. */
function expectEveryControlOnce(
  layout: { rows: string[][]; more: string[] },
  controls: readonly string[] = CONTROLS,
) {
  const placed = [
    ...layout.rows
      .flat()
      .filter((token) => token !== '|' && token !== 'collapse-toolbar'),
    ...layout.more,
  ]
  expect([...placed].sort()).toEqual([...controls].sort())
}

describe('installToolbarOverflow', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps one row, row two hidden, when the whole sequence fits (A2)', () => {
    const { host, toolbar, rows, layout } = buildToolbar(1000)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const state = layout()
    expect(state.rows[0].filter((t) => t !== '|')).toEqual([
      ...CONTROLS,
      'collapse-toolbar',
    ])
    expect(state.rows[1]).toEqual([])
    expect(state.more).toEqual([])
    expect(rows[1].hidden).toBe(true)
    expect(toolbar.classList.contains(TWO_ROWS_CLASS)).toBe(false)
    dispose()
    host.remove()
  })

  it('starts row two with the next control once row one is full (A2)', () => {
    // 659px of sequence and rules in 500: the first row takes the longest prefix, the rest goes down.
    const { host, toolbar, rows, layout } = buildToolbar(500 + TOGGLE_WIDTH)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const state = layout()
    expect(rows[1].hidden).toBe(false)
    expect(toolbar.classList.contains(TWO_ROWS_CLASS)).toBe(true)
    expect(state.more).toEqual([])
    const first = state.rows[0].filter(
      (t) => t !== '|' && t !== 'collapse-toolbar',
    )
    const second = state.rows[1].filter((t) => t !== '|')
    expect([...first, ...second]).toEqual(CONTROLS)
    // Tail last in the last row, in order.
    expect(second.slice(-4)).toEqual([
      'preview',
      'edit-mode',
      'settings',
      'more',
    ])
    // The toggle stays the last child of row one.
    expect(state.rows[0].at(-1)).toBe('collapse-toolbar')
    dispose()
    host.remove()
  })

  // Rule-discipline width sweep, split into slices (task 658).
  // What: the original single case built a fresh toolbar for each of 73 widths in one `it` and took
  // about 3 s under coverage (measured), approaching the 5 s default timeout under parallel load.
  // Why: the cost is jsdom style resolution per fresh toolbar, so it grows with the width count, and
  // a timeout override would hide that growth. How: the same 73 widths, fresh toolbar per width and
  // identical assertions, but run as RULE_SWEEP_SLICE_COUNT contiguous slices, each its own case
  // with its own timeout budget; the guard case below proves the slices still cover every width.
  const RULE_SWEEP_WIDTHS = Array.from({ length: 73 }, (_, i) => 130 + 7 * i)
  const RULE_SWEEP_SLICE_COUNT = 4
  const RULE_SWEEP_SLICES = Array.from(
    { length: RULE_SWEEP_SLICE_COUNT },
    (_, slice) =>
      RULE_SWEEP_WIDTHS.slice(
        Math.round((slice * RULE_SWEEP_WIDTHS.length) / RULE_SWEEP_SLICE_COUNT),
        Math.round(
          ((slice + 1) * RULE_SWEEP_WIDTHS.length) / RULE_SWEEP_SLICE_COUNT,
        ),
      ),
  )

  function expectRuleDiscipline(width: number): void {
    const { host, toolbar, layout } = buildToolbar(width)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const state = layout()
    for (const row of state.rows) {
      const tokens = row.filter((t) => t !== 'collapse-toolbar')
      if (tokens.length === 0) continue
      expect(tokens[0], `width ${width}`).not.toBe('|')
      expect(tokens.at(-1), `width ${width}`).not.toBe('|')
      tokens.forEach((token, index) => {
        if (token === '|')
          expect(tokens[index + 1], `width ${width}`).not.toBe('|')
      })
    }
    expectEveryControlOnce(state)
    dispose()
    host.remove()
  }

  it('sweeps every width from 130 to 634 in steps of 7 across the rule slices (edge case)', () => {
    expect(RULE_SWEEP_SLICES.flat()).toEqual(RULE_SWEEP_WIDTHS)
    expect(RULE_SWEEP_WIDTHS[0]).toBe(130)
    expect(RULE_SWEEP_WIDTHS.at(-1)).toBe(634)
  })

  it.each(
    RULE_SWEEP_SLICES.map((widths) => ({
      label: `${widths[0]}-${widths.at(-1)}`,
      widths,
    })),
  )(
    'never starts or ends a row with a rule, and never doubles one, widths $label (edge case)',
    ({ widths }) => {
      for (const width of widths) expectRuleDiscipline(width)
    },
  )

  it('moves the rest into More with Preview, Edit Mode and More kept last (A3)', () => {
    const { host, toolbar, layout, morePanel } = buildToolbar(
      210 + TOGGLE_WIDTH,
    )
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const state = layout()
    expect(state.more.length).toBeGreaterThan(0)
    expectEveryControlOnce(state)
    const lastRow = state.rows[1].length ? state.rows[1] : state.rows[0]
    expect(
      lastRow.filter((t) => t !== '|' && t !== 'collapse-toolbar').slice(-4),
    ).toEqual(['preview', 'edit-mode', 'settings', 'more'])
    // Moved controls sit above the menu's authored rows, split by the overflow divider.
    const order = Array.from(morePanel.children).map(
      (child) =>
        child
          .querySelector(':scope > [data-type]')
          ?.getAttribute('data-type') ?? child.className,
    )
    const divider = order.findIndex((name) =>
      name.includes('vmde-toolbar-overflow-divider'),
    )
    expect(divider).toBe(state.more.length)
    expect(order.indexOf('about')).toBeGreaterThan(divider)
    dispose()
    host.remove()
  })

  it('flows while the toolbar is collapsed: one row, tail last, rest in More (A3)', () => {
    const { host, toolbar, rows, layout, resize } = buildToolbar(1000)
    toolbar.classList.add(COLLAPSED_CLASS)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(layout().more).toEqual([])
    resize(220 + TOGGLE_WIDTH)
    const state = layout()
    expect(rows[1].hidden).toBe(true)
    expect(toolbar.classList.contains(TWO_ROWS_CLASS)).toBe(false)
    expect(state.rows[1]).toEqual([])
    expect(state.more.length).toBeGreaterThan(0)
    expect(
      state.rows[0]
        .filter((t) => t !== '|' && t !== 'collapse-toolbar')
        .slice(-4),
    ).toEqual(['preview', 'edit-mode', 'settings', 'more'])
    expectEveryControlOnce(state)
    dispose()
    host.remove()
  })

  it('re-flows after a collapse and an expand without a resize (A5)', async () => {
    const { host, toolbar, rows, layout } = buildToolbar(330)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(rows[1].hidden).toBe(false)
    toolbar.classList.add(COLLAPSED_CLASS)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rows[1].hidden).toBe(true)
    expect(layout().rows[1]).toEqual([])
    toolbar.classList.remove(COLLAPSED_CLASS)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rows[1].hidden).toBe(false)
    expectEveryControlOnce(layout())
    dispose()
    host.remove()
  })

  it('moves a submenu owner into More and restores it with its authored DOM', () => {
    const { host, toolbar, morePanel, elements } = buildToolbar(120)
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
    expect(headings.parentElement?.dataset.vmdeToolbarRow).toBe('1')
    expect(headings.querySelector('.vditor-panel--arrow')).not.toBeNull()
    expect(
      headings.querySelector('button')?.classList.contains('vditor-tooltipped'),
    ).toBe(true)
    expect(headings.querySelector('svg > use')).not.toBeNull()
    expect(refresh).toHaveBeenCalled()
    host.remove()
  })

  // A hidden tab collapses the webview to zero width — the scenario `flex-wrap: nowrap` exists for.
  // Deciding there would move everything into More and paint that on the way back.
  it('makes no layout decision while the container is collapsed to zero width', () => {
    const { host, toolbar, resize, layout } = buildToolbar(150)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const before = JSON.stringify(layout())
    expect(layout().more.length).toBeGreaterThan(0)
    resize(0)
    expect(JSON.stringify(layout())).toBe(before)
    dispose()
    host.remove()
  })

  // Widths are cached, so a font-size or zoom change has to invalidate them — and the re-measure
  // must happen from a row holding every control, since a control inside More reports its panel
  // width instead of its row width.
  it('re-measures when the font size changes, not on every resize', () => {
    const { host, toolbar, morePanel, resize, itemWidth } = buildToolbar(700)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(morePanel.querySelector('[data-type="emoji"]')).toBeNull()
    itemWidth.value = ITEM_WIDTH * 8
    toolbar.style.fontSize = '30px'
    resize(700)
    expect(morePanel.querySelector('[data-type="emoji"]')).not.toBeNull()
    dispose()
    host.remove()
  })

  it('does no DOM write when the width, state and visible set are unchanged (performance)', () => {
    const { host, toolbar, resize, rows } = buildToolbar(260)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const writes = vi.spyOn(Node.prototype, 'insertBefore')
    const removes = vi.spyOn(Element.prototype, 'remove')
    resize(260)
    resize(260)
    expect(writes).not.toHaveBeenCalled()
    expect(removes).not.toHaveBeenCalled()
    expect(rows[0].isConnected).toBe(true)
    writes.mockRestore()
    removes.mockRestore()
    dispose()
    host.remove()
  })

  it('keeps unmoved controls in place when the plan changes (focus is not lost)', () => {
    const { host, toolbar, elements, resize } = buildToolbar(1000)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const undo = elements.undo.querySelector('button') as HTMLElement
    undo.focus()
    expect(document.activeElement).toBe(undo)
    resize(330) // controls at the end move to row two; Undo stays
    expect(document.activeElement).toBe(undo)
    dispose()
    host.remove()
  })

  it('hands focus to More when the focused control moves into it (edge case)', () => {
    const { host, toolbar, elements, resize, morePanel } = buildToolbar(1000)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    ;(elements.headings.querySelector('button') as HTMLElement).focus()
    resize(60 + TOGGLE_WIDTH)
    expect(morePanel.querySelector('[data-type="headings"]')).not.toBeNull()
    expect(document.activeElement).toBe(
      elements.more.querySelector(':scope > button'),
    )
    dispose()
    host.remove()
  })

  it('describes a moved control with the row hover attribute, never a title, and drops it on return (A10)', () => {
    const { host, toolbar, elements, resize } = buildToolbar(1000)
    applyToolbarTips(toolbar)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const button = elements.headings.querySelector('button') as HTMLElement
    expect(button.dataset.vmdeTip).toBe(
      'Turn the block into a heading or paragraph',
    )
    resize(60 + TOGGLE_WIDTH)
    expect(button.getAttribute(ROW_TIP_ATTRIBUTE)).toBe(
      'Turn the block into a heading or paragraph',
    )
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.className).not.toContain('vditor-tooltipped')
    resize(1000)
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.hasAttribute(ROW_TIP_ATTRIBUTE)).toBe(false)
    expect(button.classList.contains('vditor-tooltipped')).toBe(true)
    dispose()
    host.remove()
  })

  // Owner rule: Settings never moves into More, in any state or at any width, like Preview and Edit
  // Mode. The tail alone is wider than the narrowest widths; it stays placed there.
  it.each([false, true])(
    'keeps Settings directly before More in the last row at every width (collapsed: %s)',
    (collapsed) => {
      for (let width = 0; width <= 760; width += 19) {
        const { host, toolbar, layout, rows } = buildToolbar(width || 1)
        if (collapsed) toolbar.classList.add(COLLAPSED_CLASS)
        const dispose = installToolbarOverflow(toolbar, vi.fn())
        const state = layout()
        expect(state.more, `More at ${width}`).not.toContain('settings')
        const used = state.rows.filter((row) => row.length > 0)
        const last = used
          .at(-1)
          ?.filter((t) => t !== '|' && t !== 'collapse-toolbar')
        expect(last?.slice(-4), `tail at ${width}`).toEqual([
          'preview',
          'edit-mode',
          'settings',
          'more',
        ])
        expect(
          rows.some((row) => row.querySelector('[data-type="settings"]')),
          `Settings in a row at ${width}`,
        ).toBe(true)
        dispose()
        host.remove()
      }
    },
  )

  it('moves Insert Picture and then Insert ID into More as the width narrows, in sequence order (A3)', () => {
    const entered: Record<string, number> = {}
    for (let width = 760; width >= 40; width -= 5) {
      const { host, toolbar, layout } = buildToolbar(width)
      const dispose = installToolbarOverflow(toolbar, vi.fn())
      const state = layout()
      for (const name of ['insert-picture', 'insert-anchor'])
        if (state.more.includes(name) && entered[name] === undefined)
          entered[name] = width
      const both = state.more.filter(
        (name) => name === 'insert-anchor' || name === 'insert-picture',
      )
      if (both.length === 2)
        expect(both, `order in More at ${width}`).toEqual([
          'insert-anchor',
          'insert-picture',
        ])
      dispose()
      host.remove()
    }
    expect(entered['insert-picture']).toBeGreaterThan(entered['insert-anchor'])
    expect(entered['insert-anchor']).toBeGreaterThan(0)
  })

  it('shows a moved Insert ID as a labelled row with the row hover attribute, and as a toolbar button again when it returns', () => {
    const { host, toolbar, elements, resize, layout } = buildToolbar(1000)
    applyToolbarTips(toolbar)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const button = elements['insert-anchor'].querySelector(
      'button',
    ) as HTMLElement
    expect(button.dataset.vmdeTip).toBe('Insert an ID that links can jump to')
    expect(button.classList.contains('vditor-tooltipped')).toBe(true)
    resize(60 + TOGGLE_WIDTH)
    expect(layout().more).toContain('insert-anchor')
    expect(button.getAttribute(ROW_TIP_ATTRIBUTE)).toBe(
      'Insert an ID that links can jump to',
    )
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.className).not.toContain('vditor-tooltipped')
    expect(button.getAttribute('aria-label')).toBe('insert-anchor')
    resize(1000)
    expect(layout().more).toEqual([])
    expect(button.hasAttribute(ROW_TIP_ATTRIBUTE)).toBe(false)
    expect(button.classList.contains('vditor-tooltipped')).toBe(true)
    expect(button.parentElement?.dataset.vmdeOverflow).toBeUndefined()
    dispose()
    host.remove()
  })

  it('keeps the Settings toolbar tooltip, never the row hover attribute, when everything else is in More', () => {
    const { host, toolbar, elements, layout } = buildToolbar(60 + TOGGLE_WIDTH)
    applyToolbarTips(toolbar)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const settings = elements.settings.querySelector('button') as HTMLElement
    expect(layout().more.length).toBeGreaterThan(0)
    expect(settings.dataset.vmdeTip).toBe('Open the VMDE settings')
    expect(settings.hasAttribute(ROW_TIP_ATTRIBUTE)).toBe(false)
    expect(settings.classList.contains('vditor-tooltipped')).toBe(true)
    expect(settings.closest('.vditor-hint')).toBeNull()
    dispose()
    host.remove()
  })

  it('shows a rule only between two placed groups, restoring dividers on dispose', () => {
    const { host, toolbar, dividers, layout } = buildToolbar(100 + TOGGLE_WIDTH)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const state = layout()
    const shown = dividers.filter((d) => d.isConnected)
    expect(shown.length).toBe(state.rows.flat().filter((t) => t === '|').length)
    expect(shown.length).toBeLessThan(dividers.length)
    dispose()
    expect(dividers.every((d) => d.isConnected)).toBe(true)
    host.remove()
  })

  // A mode switch can hide whole controls (Source mode hides Outdent, Indent, Outline, Insert
  // Before and After): they are left out of the plan, and showing them again re-measures.
  it('plans without a hidden control and re-plans when it is shown again (A5)', async () => {
    const { host, toolbar, elements, layout } = buildToolbar(1000)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    elements.outline.style.display = 'none'
    await new Promise((resolve) => setTimeout(resolve, 0))
    let tokens = layout().rows[0]
    // Its rule collapses with it: one rule between Emoji and Edit In VS Code, none doubled.
    expect(tokens.join(' ')).toContain(
      'upload insert-picture emoji | edit-in-vscode',
    )
    expect(tokens.slice(0, tokens.indexOf('more'))).not.toContain('outline')
    elements.outline.style.display = ''
    await new Promise((resolve) => setTimeout(resolve, 0))
    tokens = layout().rows[0]
    expect(tokens.join(' ')).toContain('emoji | outline | edit-in-vscode')
    dispose()
    host.remove()
  })

  it('closes an open More panel when the plan changes, and keeps it open when it does not', () => {
    const { host, toolbar, morePanel, resize } = buildToolbar(
      130 + TOGGLE_WIDTH,
    )
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    morePanel.style.display = 'block'
    resize(130 + TOGGLE_WIDTH)
    expect(morePanel.style.display).toBe('block')
    resize(1000)
    expect(morePanel.style.display).toBe('none')
    dispose()
    host.remove()
  })

  it('closes an open headings submenu panel when the plan changes', () => {
    const { host, toolbar, elements, resize } = buildToolbar(130 + TOGGLE_WIDTH)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    const panel = elements.headings.querySelector(
      '.vditor-panel',
    ) as HTMLElement
    panel.style.display = 'block'
    resize(1000)
    expect(panel.style.display).toBe('none')
    dispose()
    host.remove()
  })

  it('restores controls to their authored order on dispose', () => {
    const { host, toolbar, layout, rows } = buildToolbar(130 + TOGGLE_WIDTH)
    const dispose = installToolbarOverflow(toolbar, vi.fn())
    expect(layout().more.length).toBeGreaterThan(0)
    dispose()
    const state = layout()
    expect(state.more).toEqual([])
    expect(state.rows[0].filter((t) => t !== '|')).toEqual([
      ...CONTROLS,
      'collapse-toolbar',
    ])
    expect(state.rows[0].join(' ')).toBe(`${SEQUENCE} collapse-toolbar`)
    expect(rows[1].hidden).toBe(true)
    expect(toolbar.classList.contains(TWO_ROWS_CLASS)).toBe(false)
    host.remove()
  })
})

describe('flowToolbarOnce', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('applies one flow pass to a static copy and installs no observer', () => {
    const { host, toolbar, rows, layout } = buildToolbar(330)
    // Reuse the built DOM as the copy: the one-shot helper reads the same shape.
    flowToolbarOnce(toolbar)
    expect(rows[1].hidden).toBe(false)
    expectEveryControlOnce(layout())
    host.remove()
  })
})

const ownerControlOrder = [
  'undo',
  'redo',
  'headings',
  'bold',
  'italic',
  'underline',
  'strike',
  'inline-code',
  'subscript',
  'superscript',
  'link',
  'insert-anchor',
  'list',
  'ordered-list',
  'check',
  'outdent',
  'indent',
  'quote',
  'callout',
  'details',
  'code',
  'math',
  'table',
  'line',
  'upload',
  'insert-picture',
  'emoji',
  'insert-before',
  'insert-after',
  'outline',
  'navigate-back',
  'wiki-pages',
  'edit-in-vscode',
  'preview',
  'edit-mode',
  'settings',
  'more',
  // Task 631: the trailing toggle, in no flow plan.
  'collapse-toolbar',
]

// toolbar.ts is the sole author of the row; KNOWN_TOOLBAR_ITEMS is a second, hand-kept list of the
// same names. Nothing links them at compile time, and the failure is silent. This is the link.
describe('flow list vs the authored toolbar', () => {
  const authoredNames = (wikiEnabled: boolean) =>
    createToolbar({ wikiEnabled })
      .map((item: any) => (typeof item === 'string' ? item : item?.name))
      .filter((name): name is string => Boolean(name) && name !== '|')

  it('tracks every owner control once in the exact sequence order', () => {
    expect(KNOWN_TOOLBAR_ITEMS).toEqual(ownerControlOrder)
    expect(new Set(KNOWN_TOOLBAR_ITEMS).size).toBe(38)
  })

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
