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
