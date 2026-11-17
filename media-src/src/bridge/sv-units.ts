import { registerQuietObserver } from '../util/mutation-impact'
import { installModelSync } from './model-structure'
import type {
  HostUnit,
  TextModel,
  Unit,
  UnitHost,
  UnitKind,
} from './text-model'
import type { UnitDomControl } from './unit-dom'
import type { HistoryCapture, HistoryModelPort } from '../util/unit-changes'

// Task 733 / 015 (task 015 section 6.2 D-1, D-2): the unit host of Source mode. Vditor's Source DOM is
// text: each `data-block` div of the Source root holds the spin of one source chunk (`sv-chunks.ts`),
// so a unit's canon is its members' `textContent` without the trailing line breaks, and no Lute call
// is made to list, serialize or prove a unit. One MutationObserver keeps the model's dirty flags: a
// change inside a div dirties its unit, a div replaced, inserted or removed (the Source spin rewrites
// the caret block's div) is a root structure change that the model's window relisting resolves.

type Batch = NonNullable<SourceUnitDomOptions['onBatch']>

export interface SourceUnitDomOptions {
  /** Each processed batch that dirtied something: the dirty units, the structure scopes and the divs it inserted. */
  onBatch?(
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
    inserted: ReadonlySet<HTMLElement>,
  ): void
}

const TRAILING_BREAKS = /\n+$/u
const TRAILING_ZERO_WIDTH = /​(?=\n*$)/gu

/** The text of a Source block: the members' text without its trailing line breaks (those are separators). */
function sourceText(members: readonly HTMLElement[]): string {
  let text = ''
  for (const member of members) text += member.textContent ?? ''
  return text.replace(TRAILING_ZERO_WIDTH, '').replace(TRAILING_BREAKS, '')
}

/** One host unit per non-empty `data-block` div; undefined when the root holds anything else. */
function listSourceUnits(
  root: HTMLElement,
): HostUnit<HTMLElement>[] | undefined {
  const units: HostUnit<HTMLElement>[] = []
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement) || !child.hasAttribute('data-block'))
      return undefined
    // Vditor's split leaves an empty div after a block that ends the document (a table): no source.
    if ((child.textContent ?? '') === '') continue
    units.push({ kind: 'paragraph', members: [child] })
  }
  return units
}

export function createSourceUnitDom(
  root: HTMLElement,
  options: SourceUnitDomOptions = {},
): UnitHost<HTMLElement> & UnitDomControl {
  let model: TextModel<HTMLElement> | undefined
  let observer: MutationObserver | undefined
  let unregister: (() => void) | undefined
  // Created on the first mark of a batch, so a batch that marks nothing allocates nothing (R-2).
  let batchChanged: Set<Unit<HTMLElement>> | undefined
  let batchStructure: Set<'root' | Unit<HTMLElement>> | undefined
  // The divs the current batch inserted under the root; reused across batches.
  const inserted = new Set<HTMLElement>()
  const onBatch: Batch | undefined = options.onBatch
  // A model over this host syncs through the leaf and structure stages (idempotent).
  installModelSync()

  const markDirty = (unit: Unit<HTMLElement>): void => {
    model?.markDirty(unit)
    if (!onBatch) return
    if (!batchChanged) batchChanged = new Set()
    batchChanged.add(unit)
  }

  const markRoot = (): void => {
    model?.markStructureDirty('root')
    if (!onBatch) return
    if (!batchStructure) batchStructure = new Set()
    batchStructure.add('root')
  }

  const noteInserted = (record: MutationRecord): void => {
    const { addedNodes } = record
    for (let i = 0; i < addedNodes.length; i += 1) {
      const node = addedNodes[i]
      if (node instanceof HTMLElement && node.parentElement === root)
        inserted.add(node)
    }
  }

  /** The root's child that holds `element` (a `data-block` div). */
  const topOf = (element: Element): Element => {
    let top = element
    while (top.parentElement !== root) top = top.parentElement as Element
    return top
  }

  const markRootRecord = (record: MutationRecord): void => {
    if (record.type !== 'childList') return
    if (onBatch) noteInserted(record)
    markRoot()
  }

  const mark = (record: MutationRecord): void => {
    if (!model) return
    const target = record.target
    const element = target instanceof Element ? target : target.parentElement
    if (!element || !root.contains(element)) return
    if (element === root) {
      markRootRecord(record)
      return
    }
    const unit = model.unitOf(topOf(element) as HTMLElement)
    if (unit) markDirty(unit)
    else markRoot()
  }

  const process = (records: readonly MutationRecord[]): void => {
    inserted.clear()
    for (const record of records) mark(record)
    const changed = batchChanged
    const structure = batchStructure
    if (!changed && !structure) return
    batchChanged = undefined
    batchStructure = undefined
    onBatch?.(changed ?? new Set(), structure ?? new Set(), inserted)
  }

  return {
    listUnits: () => listSourceUnits(root),
    html: (_kind: UnitKind, el: HTMLElement) => el.outerHTML,
    serialize: (_kind, members) => sourceText(members),
    // Source proof is text equality; a unit whose spin reformatted its bytes stays unproven (no Lute).
    roundTrip: () => undefined,
    serializeList: () => undefined,
    attach(next) {
      this.detach()
      model = next
      // Source proofs are text comparisons (no Lute): every unit is proven at once, O(document) at open.
      for (const unit of next.units) next.prove(unit)
      observer = new MutationObserver(process)
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
      })
      // A quiet write first hands over the genuine records queued before it.
      unregister = registerQuietObserver(observer, process)
    },
    drain() {
      if (observer) process(observer.takeRecords())
    },
    takeSpun: () => inserted,
    detach() {
      unregister?.()
      unregister = undefined
      observer?.disconnect()
      observer = undefined
      model = undefined
      batchChanged = undefined
      batchStructure = undefined
      inserted.clear()
    },
  }
}

/** Task 733 / 019 (D-7): the history port of the Source model. A window is a run of consecutive Source units
 *  (`div[data-block]` children of the Source root) whose outer HTML changed since the previous capture. */
export interface SourceHistoryCapture {
  readonly port: HistoryModelPort
  /** Called by the Source observer for each batch, before the session merges it (as `UnitCapture.onBatch`). */
  onBatch(
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
  ): void
  hold(): void
  invalidate(): void
}

/** A Source history step: the root children from `index` whose outer HTML was `before` and is `after`. */
interface SourceWindow {
  readonly index: number
  readonly before: readonly string[]
  readonly after: readonly string[]
}

interface Snap {
  el: Element
  html: string
}

/** The root children from `index` hold exactly the outer HTML `html`. */
function windowHolds(
  kids: HTMLCollection,
  index: number,
  html: readonly string[],
): boolean {
  if (index + html.length > kids.length) return false
  for (let i = 0; i < html.length; i++)
    if (kids[index + i].outerHTML !== html[i]) return false
  return true
}

const sameHtml = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((html, i) => html === b[i])

/**
 * Task 733 / 019 (D-7 of the Source design, Q-154). The capture keeps each root child with its outer HTML
 * as the previous capture left it. A capture compares the current children with that list by identity:
 * the unchanged prefix and suffix are skipped, and the children between them form the window, so a spin
 * that inserted or removed divs widens it to the divs between the unchanged neighbours. Only the window's
 * outer HTML is read: no root clone and no root `innerHTML` read. A Source unit is a div of text spans, so
 * no Lute call, preview, list or table restore is needed.
 */
export function createSourceHistoryCapture(deps: {
  model(): TextModel<HTMLElement> | undefined
  root(): HTMLElement | undefined
  drain(): void
  ready(): boolean
  claimable(): boolean
}): SourceHistoryCapture {
  /** The root children with their outer HTML at the previous capture; undefined until taken. */
  let snap: Snap[] | undefined
  let snapRoot: HTMLElement | undefined
  /** Children whose unit the observer marked since the previous capture. */
  const dirty = new Set<Element>()
  let changed = false

  /** Takes the list from the live root: O(document), at attach or after an invalidation only. */
  const take = (): void => {
    const root = deps.root()
    snapRoot = root
    dirty.clear()
    changed = false
    snap = root
      ? Array.from(root.children, (el) => ({ el, html: el.outerHTML }))
      : undefined
  }

  const current = (): Snap[] | undefined => {
    const root = deps.root()
    if (!root || !deps.model()) return undefined
    if (!snap || snapRoot !== root) take()
    return snap
  }

  const pending = (): boolean => {
    deps.drain()
    return changed
  }

  const capture = (): HistoryCapture | undefined => {
    const list = current()
    deps.drain()
    const root = snapRoot
    if (!list || !root || !changed) return undefined
    changed = false
    const kids = root.children
    let start = 0
    while (
      start < list.length &&
      start < kids.length &&
      kids[start] === list[start].el &&
      !dirty.has(kids[start])
    )
      start++
    let tail = 0
    while (
      tail < list.length - start &&
      tail < kids.length - start &&
      kids[kids.length - 1 - tail] === list[list.length - 1 - tail].el &&
      !dirty.has(kids[kids.length - 1 - tail])
    )
      tail++
    dirty.clear()
    const before = list.slice(start, list.length - tail).map((s) => s.html)
    const fresh: Snap[] = []
    for (let i = start; i < kids.length - tail; i++)
      fresh.push({ el: kids[i], html: kids[i].outerHTML })
    list.splice(start, list.length - tail - start, ...fresh)
    const after = fresh.map((s) => s.html)
    // A Text split (the engine's caret split) changes no HTML: nothing to record.
    if (sameHtml(before, after)) return undefined
    const step: SourceWindow = { index: start, before, after }
    return step as unknown as HistoryCapture
  }

  const restore = (
    captured: HistoryCapture,
    side: 'before' | 'after',
  ): boolean => {
    const step = captured as unknown as SourceWindow
    const root = deps.root()
    if (!root) return false
    deps.drain()
    const target = side === 'before' ? step.before : step.after
    const other = side === 'before' ? step.after : step.before
    const kids = root.children
    // Every check first: the anchor exists and the window holds the other side now.
    if (!windowHolds(kids, step.index, other)) return false
    const stopAt = kids[step.index + other.length] ?? null
    for (let i = 0; i < other.length; i++) kids[step.index].remove()
    // A template parses inertly: no script of the restored HTML runs.
    const template = root.ownerDocument.createElement('template')
    template.innerHTML = target.join('')
    const inserted = Array.from(template.content.children)
    root.insertBefore(template.content, stopAt)
    const list = snap
    const aligned =
      list !== undefined &&
      snapRoot === root &&
      !changed &&
      list.length === kids.length - inserted.length + other.length
    if (!aligned) take()
    else
      list.splice(
        step.index,
        other.length,
        ...inserted.map((el, i) => ({ el, html: target[i] ?? el.outerHTML })),
      )
    return true
  }

  // A model already attached: its DOM is the base of the first capture.
  if (deps.root() && deps.model()) take()

  return {
    port: {
      ready: () => deps.ready(),
      claimable: () => deps.claimable(),
      pending,
      capture,
      restore,
    },
    onBatch(changedUnits, structure) {
      if (changedUnits.size === 0 && structure.size === 0) return
      changed = true
      for (const unit of changedUnits)
        for (const el of unit.members) dirty.add(el)
    },
    hold() {
      // The same DOM is described by the next model: what is pending stays one step of the next capture.
    },
    invalidate: take,
  }
}

/** Task 733 / 019 (019-A3): the text of a Source unit's members, as the unit host serializes it. */
export const sourceUnitText = (members: readonly HTMLElement[]): string =>
  sourceText(members)
