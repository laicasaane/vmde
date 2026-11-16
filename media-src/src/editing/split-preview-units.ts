import {
  type BackgroundJob,
  backgroundSchedulerOf,
  type SliceBudget,
} from '../util/background-budget'
import {
  type LiveUnit,
  onSourceUnitFeed,
  SOURCE_UNITS,
  sourceUnitFeedOf,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  morphPreviewUnits,
  previewUnitCount,
  setPreviewUnitBaseline,
} from './preview-morph'
import { renderPreviewBlocks, renderPreviewHtml } from './preview-render'

// Task 733 / 015-I3 (task 015 section 6.2 D-6): the Split pane renders the Source units that changed.
// Patch V-S4 asks `window.__vmdeRenderSplitPreview` at the top of Vditor's `Preview.render`. In Source
// with the preview pane shown and the Source model live, the hook takes the render: after Vditor's
// preview delay it renders each changed unit alone (one `Md2HTML` per unit) and replaces only that
// unit's elements (`morphPreviewUnits`). A whole change, or a pane without (or off) its unit baseline,
// renders the pane unit by unit as the background job `split-preview` (M1). A document with a link
// reference definition or a footnote keeps Vditor's whole render (a unit alone loses its definitions).

type Owner = Parameters<typeof renderPreviewBlocks>[0]
type Hook = (vditor: unknown, value?: string) => boolean

declare global {
  interface Window {
    __vmdeRenderSplitPreview?: Hook
  }
}

/** A line that starts a link reference definition (`[x]: …`) or a footnote definition (`[^x]: …`). */
const DEFINITION_LINE = /(?:^|\n) {0,3}\[\^?[^\]\n]+\]:/u

const unitText = (unit: LiveUnit): string => {
  let text = ''
  for (const member of unit.members) text += member.textContent ?? ''
  return text
}

const anyUnitDefines = (units: readonly LiveUnit[]): boolean =>
  units.some((unit) => DEFINITION_LINE.test(unitText(unit)))

const anyElementDefines = (elements: ReadonlySet<HTMLElement>): boolean => {
  for (const el of elements)
    if (DEFINITION_LINE.test(el.textContent ?? '')) return true
  return false
}

/** The index of the unit that holds `el` among `units`; -1 when none does. */
function indexOf(units: readonly LiveUnit[], el: HTMLElement): number {
  for (let i = 0; i < units.length; i++)
    if (units[i].members.includes(el)) return i
  return -1
}

/** The first and last unit index of the connected `scoped` elements; undefined when one is unmapped. */
function rangeOf(
  units: readonly LiveUnit[],
  scoped: ReadonlySet<HTMLElement>,
): { first: number; last: number } | undefined {
  let first = units.length
  let last = -1
  for (const el of scoped) {
    if (!el.isConnected) continue
    const index = indexOf(units, el)
    if (index < 0) return undefined
    if (index < first) first = index
    if (index > last) last = index
  }
  return { first, last }
}

/** Parses `html` and returns its top-level elements. */
function elementsOf(pane: HTMLElement, html: string): HTMLElement[] {
  const holder = pane.ownerDocument.createElement('template')
  holder.innerHTML = html
  return Array.from(holder.content.children) as HTMLElement[]
}

/** Renders units `range` alone into the pane by unit morph; false when the pane cannot be morphed. */
function morphRange(
  owner: Owner,
  units: readonly LiveUnit[],
  range: { first: number; last: number },
): boolean {
  const pane = owner.preview.previewElement
  const shown = previewUnitCount(pane)
  if (shown === undefined) return false
  // Units the change inserted or removed: the shown unit count differs by exactly that number.
  const removed = range.last - range.first + 1 + (shown - units.length)
  if (removed < 0) return false
  const htmls: string[] = []
  for (let i = range.first; i <= range.last; i++)
    htmls.push(renderPreviewHtml(owner.lute, unitText(units[i])))
  const before = new Set(Array.from(pane.children))
  if (!morphPreviewUnits(pane, range.first, removed, htmls)) return false
  const inserted: HTMLElement[] = []
  for (const child of Array.from(pane.children))
    if (!before.has(child)) inserted.push(child as HTMLElement)
  renderPreviewBlocks(owner, inserted)
  return true
}

/** The whole render as a background job: one unit per unit of work, a cursor across slices. */
function wholeRenderJob(owner: Owner, win: Window) {
  let cursor = 0
  let counts: number[] = []
  const job: BackgroundJob & { restart(): void } = {
    name: 'split-preview',
    lane: 'idle',
    restart() {
      cursor = 0
    },
    step(budget: SliceBudget): boolean {
      const feed = sourceUnitFeedOf(win)
      const units = feed?.isLive() ? feed.liveUnits() : undefined
      const pane = owner.preview.previewElement
      // Read again at the start of each step (R-1): Source left, or the feed went off.
      if (!units || owner.currentMode !== 'sv' || !pane.isConnected)
        return false
      if (cursor === 0) {
        pane.replaceChildren()
        counts = []
      }
      while (cursor < units.length && !budget.spent()) {
        const elements = elementsOf(
          pane,
          renderPreviewHtml(owner.lute, unitText(units[cursor])),
        )
        pane.append(...elements)
        renderPreviewBlocks(owner, elements)
        counts.push(elements.length)
        cursor++
      }
      if (cursor < units.length) return true
      setPreviewUnitBaseline(pane, counts)
      cursor = 0
      return false
    },
  }
  return job
}

export function installSplitPreviewRoute(owner: Owner): () => void {
  const win = window
  let timer: ReturnType<typeof setTimeout> | undefined
  // Since the last render: the elements the feed named, and whether a change was whole.
  const scoped = new Set<HTMLElement>()
  let whole = false
  // Whether some unit holds a definition: computed after a whole change, kept current from the changed units.
  let definitions: boolean | undefined
  const job = wholeRenderJob(owner, win)

  const offFeed = onSourceUnitFeed(win, (change: UnitsChange) => {
    if (change.whole) {
      whole = true
      definitions = undefined
      scoped.clear()
      return
    }
    for (const el of change.scopes ?? change.changed.map((unit) => unit.el))
      scoped.add(el)
  })

  const holdsDefinitions = (feed: UnitFeed): boolean => {
    definitions ??= anyUnitDefines(feed.liveUnits() ?? [])
    if (!definitions && anyElementDefines(scoped)) definitions = true
    return definitions
  }

  const routes = (vditor: unknown, value?: string): boolean => {
    if (!SOURCE_UNITS || value !== undefined || vditor !== owner) return false
    const mode = (owner.options?.preview as { mode?: string } | undefined)?.mode
    if (owner.currentMode !== 'sv' || mode !== 'both') return false
    const feed = sourceUnitFeedOf(win)
    return !!feed?.isLive() && !holdsDefinitions(feed)
  }

  const renderWhole = (): void => {
    whole = false
    scoped.clear()
    job.restart()
    backgroundSchedulerOf(win).post(job)
  }

  const render = (): void => {
    timer = undefined
    const feed = sourceUnitFeedOf(win)
    const units = feed?.isLive() ? feed.liveUnits() : undefined
    if (!units || owner.currentMode !== 'sv') return
    // A pane without a unit baseline (the first Split render) is rendered whole.
    const baseline =
      previewUnitCount(owner.preview.previewElement) !== undefined
    const range = whole || !baseline ? undefined : rangeOf(units, scoped)
    scoped.clear()
    if (range && range.last < 0) return
    if (!range || !morphRange(owner, units, range)) renderWhole()
  }

  const hook: Hook = (vditor, value) => {
    if (!routes(vditor, value)) return false
    clearTimeout(timer)
    timer = setTimeout(render, owner.options.preview.delay ?? 0)
    return true
  }
  win.__vmdeRenderSplitPreview = hook
  return () => {
    clearTimeout(timer)
    offFeed()
    backgroundSchedulerOf(win).cancel(job)
    if (win.__vmdeRenderSplitPreview === hook)
      delete win.__vmdeRenderSplitPreview
  }
}
