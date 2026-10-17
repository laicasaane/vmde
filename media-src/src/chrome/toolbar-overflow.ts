// Phase 5 (task 492) factored the aria-haspopup/aria-expanded pair out to toolbar-submenu-aria.ts
// so the `emoji`/`headings`/`edit-mode` triggers there can share it instead of re-deriving it.
import { planToolbarFlow } from './toolbar-flow'
import type { FlowControl, FlowPlan } from './toolbar-flow'
import { COLLAPSED_CLASS } from './toolbar-collapse'
import { toolbarRows } from './toolbar-layout'
import {
  closeSubmenuPanels,
  updateSubmenuExpanded,
} from './toolbar-submenu-aria'
import { applyToolbarTipDirections, applyToolbarTips } from './toolbar-tips'

/** Every name this module knows how to place, in the authored sequence (wiki on). `toolbar.ts` is
 *  the sole author of the row, and nothing links the two lists at compile time — an item added or
 *  renamed there would silently stop flowing. Exported so a unit test can cross-check it against
 *  `createToolbar()` and fail loudly instead. */
export const KNOWN_TOOLBAR_ITEMS: readonly string[] = [
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
  'emoji',
  'insert-before',
  'insert-after',
  'outline',
  'navigate-back',
  'wiki-pages',
  'edit-in-vscode',
  'preview',
  'edit-mode',
  'more',
  // Task 631: the trailing toggle; it is in no flow plan, so it never moves into More.
  'collapse-toolbar',
]

const OVERFLOW_MARKER = 'vmde-toolbar-overflow-divider'
const TOGGLE = 'collapse-toolbar'
const MORE = 'more'
/** Preview, Edit Mode and More always end the last used row, in this order (Task 642). */
const TAIL: readonly string[] = ['preview', 'edit-mode', MORE]
/** Added while the plan needs a second row; vscode-chrome.css tightens the row gap under it. */
export const TWO_ROWS_CLASS = 'vmde-toolbar--two-rows'

type RovingRefresh = (toolbar: HTMLElement) => void

interface ToolbarItem {
  name: string
  element: HTMLElement
  /** Index of the authored separator group the control belongs to. */
  group: number
  tooltipClasses: string[]
}

interface Authored {
  items: ToolbarItem[]
  /** The authored separator before group n (n >= 1), when one exists. */
  dividerBefore: Map<number, HTMLElement>
  dividers: HTMLElement[]
  /** Every authored child in sequence order, items and dividers alike. */
  order: HTMLElement[]
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one walk groups the controls by rule and records the rule before each group
function readAuthored(layoutRows: readonly HTMLElement[]): Authored {
  const items: ToolbarItem[] = []
  const dividerBefore = new Map<number, HTMLElement>()
  const dividers: HTMLElement[] = []
  const order: HTMLElement[] = []
  let group = 0
  let seenItem = false
  for (const row of layoutRows) {
    for (const child of Array.from(row.children)) {
      if (!(child instanceof HTMLElement)) continue
      order.push(child)
      if (child.classList.contains('vditor-toolbar__divider')) {
        dividers.push(child)
        // A run of dividers is one boundary; the group number moves on after the first of the run.
        if (seenItem) {
          group++
          dividerBefore.set(group, child)
          seenItem = false
        }
        continue
      }
      if (!child.classList.contains('vditor-toolbar__item')) continue
      const button = child.querySelector(':scope > [data-type]')
      const name = button?.getAttribute('data-type')
      if (!name) continue
      seenItem = true
      const tooltipClasses =
        button?.className
          .split(/\s+/)
          .filter((className) => className.startsWith('vditor-tooltipped')) ??
        []
      items.push({ name, element: child, group, tooltipClasses })
    }
  }
  return { items, dividerBefore, dividers, order }
}

function rowWidth(item: ToolbarItem): number {
  return Math.ceil(item.element.getBoundingClientRect().width)
}

function setArrowPanel(item: ToolbarItem, moved: boolean): void {
  const panel = Array.from(item.element.children).find(
    (candidate) =>
      candidate.classList.contains('vditor-hint') ||
      candidate.classList.contains('vditor-panel'),
  )
  panel?.classList.toggle('vditor-panel--arrow', !moved)
}

function setOverflowRow(item: ToolbarItem, moved: boolean): void {
  const button = itemButton(item)
  if (!button) return
  if (moved) {
    // Inside More the name is the visible row label, so the description is the native tooltip and
    // the painted one (class-driven) is removed with every direction class, so a control never
    // shows two tooltips (Task 642).
    for (const className of Array.from(button.classList))
      if (className.startsWith('vditor-tooltipped'))
        button.classList.remove(className)
    const tip = button.getAttribute('aria-description')
    if (tip) button.title = tip
    return
  }
  button.removeAttribute('title')
  for (const className of item.tooltipClasses) button.classList.add(className)
}

function itemButton(item: ToolbarItem): HTMLElement | null {
  const button = item.element.querySelector(':scope > [data-type]')
  return button instanceof HTMLElement ? button : null
}

/** VS Code's webview occasionally leaves a reparented `<use>` blank even though its sprite symbol
 * is present. Menu rows therefore receive the symbol's concrete paths; restoring the row puts its
 * original lightweight `<use>` markup back. */
function inlineOverflowIcon(item: ToolbarItem): void {
  const svg = itemButton(item)?.querySelector(':scope > svg')
  if (!(svg instanceof SVGSVGElement) || svg.dataset.vmdeOverflowIcon) return
  const use = svg.querySelector(':scope > use')
  const reference = use?.getAttribute('href') ?? use?.getAttribute('xlink:href')
  if (!reference?.startsWith('#')) return
  const symbol = document.querySelector(reference)
  if (!(symbol instanceof SVGElement) || symbol.localName !== 'symbol') return

  svg.dataset.vmdeOverflowIcon = svg.innerHTML
  const viewBox = symbol.getAttribute('viewBox')
  if (viewBox) svg.dataset.vmdeOverflowViewBox = viewBox
  svg.setAttribute('viewBox', viewBox ?? '0 0 16 16')
  svg.innerHTML = symbol.innerHTML
}

function restoreOverflowIcon(item: ToolbarItem): void {
  const svg = itemButton(item)?.querySelector(':scope > svg')
  if (!(svg instanceof SVGSVGElement) || !svg.dataset.vmdeOverflowIcon) return
  svg.innerHTML = svg.dataset.vmdeOverflowIcon
  svg.removeAttribute('viewBox')
  delete svg.dataset.vmdeOverflowIcon
  delete svg.dataset.vmdeOverflowViewBox
}

/** Put `nodes` into `row` in order with the fewest moves: walking from the end, a node that already
 *  has the right next sibling is left alone, so an unmoved control keeps keyboard focus (Task 631:
 *  a no-op move would still blur it). Authored nodes the list leaves out are detached; nodes this
 *  module never authored are not touched. */
function arrange(
  row: HTMLElement,
  nodes: readonly HTMLElement[],
  authored: ReadonlySet<HTMLElement>,
): void {
  const wanted = new Set(nodes)
  for (const child of Array.from(row.children))
    if (
      child instanceof HTMLElement &&
      authored.has(child) &&
      !wanted.has(child)
    )
      child.remove()
  let next: HTMLElement | null = null
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node.parentElement !== row || node.nextElementSibling !== next)
      row.insertBefore(node, next)
    next = node
  }
}

/** The flow controller of one toolbar: measures once per changed input, plans with the pure planner
 *  and applies the plan with minimal DOM moves. `apply` is synchronous; the caller owns scheduling. */
interface FlowController {
  apply: () => void
  dispose: () => void
  /** Keep More open when a control inside it opens its own panel; returns its disposer. */
  bindNestedPanels: () => () => void
}

function createFlowController(
  toolbar: HTMLElement,
  refreshRoving: RovingRefresh,
): FlowController | null {
  const layoutRows = (() => {
    const rows = toolbarRows(toolbar)
    return rows.length ? rows : [toolbar]
  })()
  const authored = readAuthored(layoutRows)
  const moreItem = authored.items.find((item) => item.name === MORE)
  const morePanel = moreItem?.element.querySelector(':scope > .vditor-hint')
  const moreButton = moreItem ? itemButton(moreItem) : null
  if (!moreItem || !(morePanel instanceof HTMLElement) || !moreButton)
    return null

  moreItem.element.classList.add('vmde-toolbar-more')
  const toggle = authored.items.find((item) => item.name === TOGGLE)
  // `more` and the placed controls flow; the toggle never does (it stays the last child of row 1).
  const flowItems = authored.items.filter((item) => item.name !== TOGGLE)
  const authoredSet = new Set(authored.order)
  const homeRow = layoutRows[0]
  const secondRow = layoutRows[1]
  const marker = document.createElement('div')
  marker.className = `vditor-toolbar__divider ${OVERFLOW_MARKER}`

  const clearOverflowState = (item: ToolbarItem) => {
    restoreOverflowIcon(item)
    setArrowPanel(item, false)
    setOverflowRow(item, false)
    delete item.element.dataset.vmdeOverflow
  }

  /** Every authored node back in row 1 in its authored place. */
  const restoreAll = () => {
    for (const item of flowItems) clearOverflowState(item)
    marker.remove()
    for (const row of layoutRows.slice(1))
      for (const child of Array.from(row.children))
        if (child instanceof HTMLElement && authoredSet.has(child))
          child.remove()
    arrange(homeRow, authored.order, authoredSet)
  }

  // Cached widths only go stale when the controls change size: a state flip, a font-size or zoom
  // change, the narrow-width padding rule, or a control becoming visible. All are in the key.
  const metricsKey = () =>
    `${getComputedStyle(toolbar).fontSize}|${window.devicePixelRatio}|${window.innerWidth <= 520}|${toolbar.classList.contains(COLLAPSED_CLASS)}`
  let widths = new Map<string, number>()
  let separatorWidth = 0
  let measuredKey = ''
  let lastInputKey: string | null = null
  let lastPlanKey: string | null = null
  let disposed = false

  const visibleItems = () =>
    flowItems.filter(
      (item) => getComputedStyle(item.element).display !== 'none',
    )

  /** Measure from a row that holds everything: a control inside More reports its panel width, so
   *  measuring the live layout would poison the cache. Runs in the same pass as the plan, so the
   *  fully restored row is never painted. */
  const remeasure = (key: string) => {
    restoreAll()
    widths = new Map(flowItems.map((item) => [item.name, rowWidth(item)]))
    const divider = authored.dividers[0]
    if (divider) {
      const style = getComputedStyle(divider)
      separatorWidth = Math.ceil(
        divider.getBoundingClientRect().width +
          Number.parseFloat(style.marginLeft || '0') +
          Number.parseFloat(style.marginRight || '0'),
      )
    } else separatorWidth = 0
    measuredKey = key
    lastInputKey = null
    lastPlanKey = null
  }

  const contentWidth = (): number => {
    const container = toolbar.parentElement ?? toolbar
    const containerWidth = container.getBoundingClientRect().width
    const toolbarStyle = getComputedStyle(toolbar)
    const horizontalPadding =
      Number.parseFloat(toolbarStyle.paddingLeft) +
      Number.parseFloat(toolbarStyle.paddingRight)
    const toolbarContentWidth =
      toolbar.clientWidth > 0
        ? Math.max(0, toolbar.clientWidth - horizontalPadding)
        : containerWidth
    return Math.min(containerWidth, toolbarContentWidth)
  }

  const nodesFor = (
    names: readonly string[],
    byName: Map<string, ToolbarItem>,
  ): HTMLElement[] => {
    const nodes: HTMLElement[] = []
    let rule = false
    for (const name of names) {
      if (name === '|') {
        rule = true
        continue
      }
      const item = byName.get(name)
      if (!item) continue
      if (rule) {
        // The rule shown before a control is the authored one before that control's group.
        const divider = authored.dividerBefore.get(item.group)
        if (divider) nodes.push(divider)
        rule = false
      }
      nodes.push(item.element)
    }
    return nodes
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one write pass deliberately coordinates More, the rows, focus and accessibility refresh
  const applyPlan = (plan: FlowPlan, hidden: readonly ToolbarItem[]) => {
    const focused = document.activeElement
    const focusedOwner =
      focused instanceof HTMLElement && toolbar.contains(focused)
        ? focused.closest('.vditor-toolbar__item')
        : null
    const focusedName = focusedOwner
      ?.querySelector(':scope > [data-type]')
      ?.getAttribute('data-type')
    // The plan changed — controls moved into or out of More, so every open submenu panel is stale:
    // the More menu would list controls that already returned to a row, and an open
    // emoji/headings/edit-mode panel would travel with its control into or out of More. Close them
    // all so the next click opens a menu that matches the rows (Task 504).
    closeSubmenuPanels(toolbar)

    const byName = new Map(flowItems.map((item) => [item.name, item]))
    const inMore = new Set(plan.more)
    for (const item of flowItems) {
      if (item.element.parentElement === morePanel && !inMore.has(item.name))
        item.element.remove()
    }
    if (inMore.size > 0) {
      // Moved controls go ABOVE the menu's authored rows, separated by the divider, so Settings /
      // About keep a stable position no matter how many controls are in More.
      if (!marker.isConnected)
        morePanel.insertBefore(marker, morePanel.firstChild)
    } else if (marker.isConnected) marker.remove()
    for (const item of flowItems) {
      if (inMore.has(item.name)) {
        inlineOverflowIcon(item)
        setArrowPanel(item, true)
        setOverflowRow(item, true)
        item.element.dataset.vmdeOverflow = 'true'
        morePanel.insertBefore(item.element, marker)
      } else clearOverflowState(item)
    }
    // Hidden controls (Source mode) sit at the end of row 1 so they cannot disturb the sequence.
    const rowNodes = layoutRows.map((_, index) =>
      nodesFor(plan.rows[index] ?? [], byName),
    )
    rowNodes[0].push(...hidden.map((item) => item.element))
    if (toggle) rowNodes[0].push(toggle.element)
    layoutRows.forEach((row, index) => {
      arrange(row, rowNodes[index], authoredSet)
    })
    const two = plan.rows.length > 1
    if (secondRow) secondRow.hidden = !two
    toolbar.classList.toggle(TWO_ROWS_CLASS, two)

    refreshRoving(toolbar)
    updateSubmenuExpanded(moreButton, morePanel)
    // Focus repair: a control that moved into More hands focus to More; one that changed rows
    // keeps it. The toggle is not a flow control and is never moved, so it keeps focus untouched.
    const owner = flowItems.find((item) => item.name === focusedName)
    if (owner) {
      const target = inMore.has(owner.name) ? moreButton : itemButton(owner)
      target?.focus({ preventScroll: true })
    }
  }

  const apply = () => {
    if (disposed) return
    const available = contentWidth()
    // A hidden tab collapses the webview to zero width; deciding there would move everything into
    // More and paint that on the way back.
    if (available <= 0) return
    const visible = visibleItems()
    const key = `${metricsKey()}|${visible.map((item) => item.name).join(',')}`
    if (key !== measuredKey) remeasure(key)

    const collapsed = toolbar.classList.contains(COLLAPSED_CLASS)
    const toggleWidth = toggle
      ? toggle.element.getBoundingClientRect().width
      : 0
    const rowWidthPx = Math.max(0, available - toggleWidth)
    const inputKey = `${Math.floor(rowWidthPx)}|${key}`
    // One measurement pass per changed input: an unchanged width, state and visible set cannot
    // change the plan, so a resize observer echo of this pass's own writes ends here.
    if (inputKey === lastInputKey) return
    lastInputKey = inputKey

    const controls: FlowControl[] = visible.map((item) => ({
      name: item.name,
      group: item.group,
      width: widths.get(item.name) ?? 0,
    }))
    const rowCount = collapsed || !secondRow ? 1 : 2
    const plan = planToolbarFlow({
      controls,
      separatorWidth,
      rowWidths: Array.from({ length: rowCount }, () => rowWidthPx),
      tail: TAIL,
    })
    const planKey = JSON.stringify([plan.rows, plan.more])
    if (planKey !== lastPlanKey) {
      lastPlanKey = planKey
      const shown = new Set(visible)
      applyPlan(
        plan,
        flowItems.filter((item) => !shown.has(item)),
      )
    }
    // The right edge moved with the width even when the plan did not, so the tooltip directions
    // are refreshed on every changed input.
    applyToolbarTipDirections(toolbar)
  }

  const dispose = () => {
    disposed = true
    for (const item of flowItems) {
      if (item.element.parentElement === morePanel) item.element.remove()
    }
    restoreAll()
    // Hand the rows back exactly as authored.
    if (secondRow) secondRow.hidden = true
    toolbar.classList.remove(TWO_ROWS_CLASS)
    lastInputKey = null
    lastPlanKey = null
  }

  // Vditor closes More on ANY click that bubbles to its panel (toolbar/index.ts adds that listener to
  // the More panel). Math and Edit Mode stop their trigger's click themselves (toggleSubMenu), but
  // Headings and the Emoji picker do not, so their click would close More right after opening their
  // own panel inside it. While such a control is in More its trigger click therefore stops at the
  // trigger; the panel it just opened is kept visible by the observer in installToolbarOverflow.
  const bindNestedPanels = () => {
    const cleanups: Array<() => void> = []
    for (const item of flowItems) {
      const button = itemButton(item)
      const hasPanel = Array.from(item.element.children).some(
        (child) =>
          child.classList.contains('vditor-hint') ||
          child.classList.contains('vditor-panel'),
      )
      if (!button || !hasPanel || item === moreItem) continue
      const stop = (event: Event) => {
        if (item.element.dataset.vmdeOverflow === 'true')
          event.stopPropagation()
      }
      button.addEventListener('click', stop)
      cleanups.push(() => button.removeEventListener('click', stop))
    }
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }

  return { apply, dispose, bindNestedPanels }
}

/** One synchronous flow pass on a static copy of the toolbar (the instant-paint overlay's clone), so
 *  the copy shows the rows and More contents the live toolbar will show. No observer is installed. */
export function flowToolbarOnce(toolbar: HTMLElement): void {
  createFlowController(toolbar, () => undefined)?.apply()
}

/** Install the responsive toolbar flow. The observers watch a stable ancestor, never the rows. */
export function installToolbarOverflow(
  toolbar: HTMLElement,
  refreshRoving: RovingRefresh,
): () => void {
  const controller = createFlowController(toolbar, refreshRoving)
  // No "more" item configured on this toolbar — nothing to reparent, so hand back a no-op
  // unsubscribe rather than forcing callers to null-check.
  if (!controller)
    return () => {
      /* no-op disposer */
    }
  const morePanel = toolbar.querySelector<HTMLElement>(
    '.vmde-toolbar-more > .vditor-hint',
  )
  const moreButton = toolbar.querySelector<HTMLElement>(
    '.vmde-toolbar-more > [data-type]',
  )
  const layoutRows = toolbarRows(toolbar)

  // The descriptions must exist before the first plan: a control that moves into More turns its
  // description into a native tooltip.
  applyToolbarTips(toolbar)
  let frame = 0
  const run = () => {
    frame = 0
    controller.apply()
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(run)
  }
  // A synchronous first pass avoids painting every control in one overflowing row while waiting
  // for the next frame; the scheduled pass covers a toolbar that has no width yet.
  controller.apply()
  schedule()
  const stable = toolbar.parentElement ?? toolbar
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => controller.apply())
  resizeObserver?.observe(stable)
  // In VS Code the parent can keep its width while the retained webview changes
  // its own layout width. Observe both boxes so the flow pass runs in the
  // same resize cycle instead of briefly painting More beyond the right edge.
  if (stable !== toolbar) resizeObserver?.observe(toolbar)
  resizeObserver?.observe(document.documentElement)
  resizeObserver?.observe(document.body)
  const onResize = () => controller.apply()
  window.addEventListener('resize', onResize)
  // Vditor shows/hides top-level items by writing `display` on their wrapper when the edit mode
  // changes. Only item wrappers are watched (never the dividers this controller moves), so the
  // pass cannot retrigger itself.
  const itemVisibilityObserver = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          record.target instanceof HTMLElement &&
          record.target.classList.contains('vditor-toolbar__item'),
      )
    )
      schedule()
  })
  for (const row of layoutRows.length ? layoutRows : [toolbar])
    itemVisibilityObserver.observe(row, {
      attributes: true,
      attributeFilter: ['style'],
      subtree: true,
    })
  // Collapse and expand are class flips on the toolbar and change the control sizes; the pass
  // re-measures from a full row (the state is part of its cache key). Only a change of the collapsed
  // class schedules it: the two-rows class this pass writes must not re-trigger the pass.
  let seenCollapsed = toolbar.classList.contains(COLLAPSED_CLASS)
  const collapseObserver = new MutationObserver(() => {
    const collapsed = toolbar.classList.contains(COLLAPSED_CLASS)
    if (collapsed === seenCollapsed) return
    seenCollapsed = collapsed
    schedule()
  })
  collapseObserver.observe(toolbar, {
    attributes: true,
    attributeFilter: ['class'],
  })
  // A moved control keeps its own panel (Headings, Emoji, Math, Edit Mode) as a child of its row in
  // More. Vditor's Headings and VMDE's Emoji picker open theirs by first hiding EVERY toolbar hint
  // and panel, More's included, so the panel would open inside a hidden menu and show nothing. When
  // a nested panel opens in the same batch that hides More, More is shown again; when More alone
  // is hidden (toggled or dismissed) the nested panels are closed with it, so a later open does not
  // show a stale panel.
  const nestedPanelOpened = (record: MutationRecord) =>
    record.target instanceof HTMLElement &&
    record.target !== morePanel &&
    record.target.style.display === 'block' &&
    (record.target.classList.contains('vditor-hint') ||
      record.target.classList.contains('vditor-panel')) &&
    Boolean(record.target.closest('[data-vmde-overflow="true"]'))
  const keepMoreOpenObserver = new MutationObserver((records) => {
    if (!morePanel || morePanel.style.display === 'block') return
    if (records.some(nestedPanelOpened)) {
      morePanel.style.display = 'block'
      return
    }
    for (const panel of morePanel.querySelectorAll<HTMLElement>(
      '[data-vmde-overflow="true"] > .vditor-hint, [data-vmde-overflow="true"] > .vditor-panel',
    ))
      if (panel.style.display === 'block') panel.style.display = 'none'
  })
  if (morePanel)
    keepMoreOpenObserver.observe(morePanel, {
      attributes: true,
      attributeFilter: ['style'],
      subtree: true,
    })
  const unbindNestedPanels = controller.bindNestedPanels()
  const moreStateObserver = new MutationObserver(() => {
    if (morePanel && moreButton) updateSubmenuExpanded(moreButton, morePanel)
  })
  if (morePanel)
    moreStateObserver.observe(morePanel, {
      attributes: true,
      attributeFilter: ['style'],
    })

  return () => {
    if (frame) cancelAnimationFrame(frame)
    resizeObserver?.disconnect()
    window.removeEventListener('resize', onResize)
    moreStateObserver.disconnect()
    keepMoreOpenObserver.disconnect()
    unbindNestedPanels()
    collapseObserver.disconnect()
    itemVisibilityObserver.disconnect()
    controller.dispose()
  }
}
