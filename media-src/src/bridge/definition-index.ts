import type {
  BackgroundJob,
  BackgroundScheduler,
  SliceBudget,
} from '../util/background-budget'
import {
  type DefinitionContext,
  isDefinitionKind,
  type LiveUnit,
  type UnitsChange,
} from '../util/unit-changes'
import {
  definitionContextOf,
  definitionLabelOf,
  type FootnoteInfo,
  footnoteOfSource,
  normalizeLabel,
  referencedLabels,
} from './definition-units'

// Task 733 / 017 (task 017 section 6.3): which definitions and footnotes exist, which units reference
// them, and the two background jobs that keep the rendering of those references current. The text is
// never stale: a dependent's rendering lags by the job's frames after a definition change.
//
// - Definitions and footnotes are indexed at creation and on each change of such a unit (O(units) only
//   when a footnote label or the footnote order changes).
// - The reference index (unit → labels, label → units) is built by the idle job
//   `definition-references`, then kept current for the changed units of each change.
// - A label set or footnote number change queues the referencing units on the frame job
//   `definition-dependents`, which re-renders one unit per work unit through `rerender`; a footnote
//   text change writes the tooltips of its references.

export interface DefinitionIndex {
  /** The referenced definitions of `source` from live elements; O(source + referenced definitions). */
  contextFor(source: string): DefinitionContext | undefined
  footnoteOf(label: string): FootnoteInfo | undefined
  /** Updates the index for a change and queues the jobs it needs. */
  onUnitsChange(change: UnitsChange): void
  dispose(): void
}

export interface DefinitionIndexDeps {
  units(): readonly LiveUnit[] | undefined
  bytesOf(el: HTMLElement): string | undefined
  /** A drained write of the unit's rendering; false when the unit is gone or dirty (R-1). */
  rerender(el: HTMLElement, context: DefinitionContext | undefined): boolean
  setFootnoteTooltip(el: HTMLElement, label: string, tooltip: string): void
  scheduler: BackgroundScheduler
}

interface Footnote {
  readonly el: HTMLElement
  readonly label: string
  readonly tooltip: string
}

interface References {
  readonly links: readonly string[]
  readonly footnotes: readonly string[]
}

const NO_REFERENCES: References = { links: [], footnotes: [] }

/** Footnotes numbered by definition order; a repeated label keeps its first number. */
function numbered(notes: readonly Footnote[]): Map<string, FootnoteInfo> {
  const info = new Map<string, FootnoteInfo>()
  for (const note of notes)
    if (!info.has(note.label))
      info.set(note.label, { number: info.size + 1, tooltip: note.tooltip })
  return info
}

function collectInto(
  out: Set<HTMLElement>,
  labels: ReadonlySet<string>,
  byLabel: ReadonlyMap<string, ReadonlySet<HTMLElement>>,
): void {
  for (const label of labels)
    for (const el of byLabel.get(label) ?? []) out.add(el)
}

function addTo(
  map: Map<string, Set<HTMLElement>>,
  label: string,
  el: HTMLElement,
): void {
  let set = map.get(label)
  if (!set) {
    set = new Set()
    map.set(label, set)
  }
  set.add(el)
}

export function createDefinitionIndex(
  deps: DefinitionIndexDeps,
): DefinitionIndex {
  /** label → definition element (the first definition of a label wins, as in CommonMark). */
  const definitions = new Map<string, HTMLElement>()
  /** definition element → its label. */
  const labelOf = new Map<HTMLElement, string>()
  let footnotes: Footnote[] = []
  let footnoteInfo = new Map<string, FootnoteInfo>()

  const references = new Map<HTMLElement, References>()
  const byLink = new Map<string, Set<HTMLElement>>()
  const byFootnote = new Map<string, Set<HTMLElement>>()
  let referencesComplete = false
  let referenceCursor = 0

  const pendingLinks = new Set<string>()
  const pendingFootnotes = new Set<string>()
  let dependents: HTMLElement[] = []
  let dependentCursor = 0
  let disposed = false

  const indexDefinition = (el: HTMLElement): void => {
    const label = definitionLabelOf(deps.bytesOf(el) ?? '')
    if (label === undefined) return
    labelOf.set(el, label)
    if (!definitions.has(label)) definitions.set(label, el)
  }

  const indexDefinitions = (units: readonly LiveUnit[]): void => {
    definitions.clear()
    labelOf.clear()
    const notes: Footnote[] = []
    for (const unit of units) {
      if (unit.kind === 'definition') indexDefinition(unit.el)
      else if (unit.kind === 'footnote') pushFootnote(notes, unit.el)
    }
    footnotes = notes
    footnoteInfo = numbered(notes)
  }

  const pushFootnote = (notes: Footnote[], el: HTMLElement): void => {
    const note = footnoteOfSource(deps.bytesOf(el) ?? '')
    if (note) notes.push({ el, ...note })
  }

  const forget = (el: HTMLElement): void => {
    const old = references.get(el)
    if (!old) return
    for (const label of old.links) byLink.get(label)?.delete(el)
    for (const label of old.footnotes) byFootnote.get(label)?.delete(el)
    references.delete(el)
  }

  const indexReferences = (unit: LiveUnit): void => {
    forget(unit.el)
    if (isDefinitionKind(unit.kind)) return
    const found = referencedLabels(deps.bytesOf(unit.el) ?? '') ?? NO_REFERENCES
    if (found === NO_REFERENCES) return
    references.set(unit.el, found)
    for (const label of found.links) addTo(byLink, label, unit.el)
    for (const label of found.footnotes) addTo(byFootnote, label, unit.el)
  }

  const referenceJob: BackgroundJob = {
    name: 'definition-references',
    lane: 'idle',
    step(budget: SliceBudget): boolean {
      if (disposed) return false
      // Nothing to reference yet: the build waits until a definition or footnote appears.
      if (definitions.size === 0 && footnotes.length === 0) return false
      // R-1: the unit list is read again at each step.
      const units = deps.units()
      if (!units) return false
      while (referenceCursor < units.length) {
        if (budget.spent()) return true
        indexReferences(units[referenceCursor++])
      }
      referencesComplete = true
      if (pendingLinks.size || pendingFootnotes.size)
        deps.scheduler.post(dependentJob)
      return false
    },
  }

  const collectDependents = (): void => {
    const out = new Set<HTMLElement>()
    collectInto(out, pendingLinks, byLink)
    collectInto(out, pendingFootnotes, byFootnote)
    pendingLinks.clear()
    pendingFootnotes.clear()
    for (const el of out) dependents.push(el)
  }

  const dependentJob: BackgroundJob = {
    name: 'definition-dependents',
    lane: 'frame',
    step(budget: SliceBudget): boolean {
      if (disposed) return false
      if (!referencesComplete) {
        deps.scheduler.post(referenceJob)
        return false
      }
      if (pendingLinks.size || pendingFootnotes.size) collectDependents()
      return renderDependents(budget)
    },
  }

  const renderDependents = (budget: SliceBudget): boolean => {
    while (dependentCursor < dependents.length) {
      if (budget.spent()) return true
      const el = dependents[dependentCursor++]
      // R-1: a dependent that left the document is skipped; `rerender` refuses a dirty one.
      if (el.isConnected)
        deps.rerender(el, index.contextFor(deps.bytesOf(el) ?? ''))
    }
    dependents = []
    dependentCursor = 0
    return false
  }

  const queueDependents = (): void => {
    if (pendingLinks.size === 0 && pendingFootnotes.size === 0) return
    deps.scheduler.post(referencesComplete ? dependentJob : referenceJob)
  }

  const rebuild = (): void => {
    const units = deps.units()
    if (!units) return
    indexDefinitions(units)
    references.clear()
    byLink.clear()
    byFootnote.clear()
    referencesComplete = false
    referenceCursor = 0
    deps.scheduler.post(referenceJob)
  }

  /** A footnote unit changed: its label or the order changed (renumber), or only its text (tooltips). */
  const footnoteChanged = (el: HTMLElement): void => {
    const note = footnoteOfSource(deps.bytesOf(el) ?? '')
    const old = footnotes.find((entry) => entry.el === el)
    if (old && note && old.label === note.label) {
      if (old.tooltip !== note.tooltip) retitle(el, note)
      return
    }
    renumber()
  }

  /** Only the text of a footnote changed: its references get the new tooltip. */
  const retitle = (el: HTMLElement, note: Omit<Footnote, 'el'>): void => {
    footnotes = footnotes.map((entry) =>
      entry.el === el ? { el, ...note } : entry,
    )
    footnoteInfo = numbered(footnotes)
    for (const ref of byFootnote.get(note.label) ?? [])
      deps.setFootnoteTooltip(ref, note.label, note.tooltip)
  }

  /** A footnote label or the order changed: every label whose number changed has stale references. */
  const renumber = (): void => {
    const before = footnoteInfo
    const units = deps.units()
    if (units) indexDefinitions(units)
    for (const [label, info] of footnoteInfo)
      if (before.get(label)?.number !== info.number) pendingFootnotes.add(label)
    for (const label of before.keys())
      if (!footnoteInfo.has(label)) pendingFootnotes.add(label)
  }

  const definitionChanged = (el: HTMLElement): void => {
    const label = definitionLabelOf(deps.bytesOf(el) ?? '')
    const old = labelOf.get(el)
    if (old === label) return
    if (old !== undefined) dropDefinition(el, old)
    if (label === undefined) return
    labelOf.set(el, label)
    if (!definitions.has(label)) {
      definitions.set(label, el)
      pendingLinks.add(label)
    }
  }

  const dropDefinition = (el: HTMLElement, old: string): void => {
    labelOf.delete(el)
    if (definitions.get(old) === el) {
      definitions.delete(old)
      // Another definition of the same label takes over.
      const other = [...labelOf].find(([, label]) => label === old)
      if (other) definitions.set(old, other[0])
    }
    if (!definitions.has(old)) pendingLinks.add(old)
  }

  const definitionHtml = (labels: readonly string[]): string[] | undefined => {
    let out: string[] | undefined
    for (const label of labels) {
      const el = definitions.get(label)
      if (!el) continue
      out ??= []
      out.push(el.outerHTML)
    }
    return out
  }

  const footnoteHtml = (labels: readonly string[]): string[] | undefined => {
    let out: string[] | undefined
    for (const label of labels) {
      const note = footnotes.find((entry) => entry.label === label)
      if (!note) continue
      out ??= []
      out.push(note.el.outerHTML)
    }
    return out
  }

  const index: DefinitionIndex = {
    contextFor(source) {
      const labels = referencedLabels(source)
      if (!labels) return undefined
      const defs = definitionHtml(labels.links)
      const notes = footnoteHtml(labels.footnotes)
      if (!defs && !notes) return undefined
      return definitionContextOf(defs ?? [], notes ?? [])
    },
    footnoteOf(label) {
      return footnoteInfo.get(normalizeLabel(label))
    },
    onUnitsChange(change) {
      if (disposed) return
      if (change.whole) {
        rebuild()
        return
      }
      for (const unit of change.changed) {
        if (unit.kind === 'definition') definitionChanged(unit.el)
        else if (unit.kind === 'footnote') footnoteChanged(unit.el)
        else if (referencesComplete) indexReferences(unit)
      }
      queueDependents()
    },
    dispose() {
      disposed = true
      deps.scheduler.cancel(referenceJob)
      deps.scheduler.cancel(dependentJob)
    },
  }

  const units = deps.units()
  if (units) indexDefinitions(units)
  deps.scheduler.post(referenceJob)
  return index
}
