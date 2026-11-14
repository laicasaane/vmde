import { scanMovableBlocks } from '../../../src/shared/block-move'
import { isHelper } from '../editing/trailing-paragraph'
import { domKind } from '../nav/unit-pairing'
import { registerQuietObserver } from '../util/mutation-impact'
import { isOwnHintRecord, stripWrapHints } from '../util/wrap-hint-mark'
import type {
  HostUnit,
  TextModel,
  Unit,
  UnitHost,
  UnitKind,
} from './text-model'
import {
  type ColumnAlign,
  roundTripBlock,
  roundTripCell,
  serializeBlockHtml,
  serializeCellHtml,
  serializeListItemHtml,
  type UnitLute,
} from './unit-lute'

// Task 733: the DOM side of the text model. `createUnitDom` lists the IR root's top-level elements as
// host units, serializes them through the live Lute, and keeps the model's dirty flags current with
// one MutationObserver (shared rules 2.4, 3.1, 3.4).

/** The observer half of the adapter; the model is attached once it is built. */
export interface UnitDomControl {
  /** Start observing the root and mark units of `model` dirty from now on. */
  attach(model: TextModel<HTMLElement>): void
  /** Process the queued records now (before a publication reads the model). */
  drain(): void
  /** Stop observing and drop what is queued. */
  detach(): void
}

const VIEW_ONLY_ATTRIBUTES = [
  'data-vmde-trailing',
  'data-vmde-gap',
  'data-vmde-leading',
] as const

// Attributes that never reach the Markdown: presentation, fold and indent state, and the outline's
// heading anchor `id` (shared rules 3.4).
const IGNORED_ATTRIBUTES = new Set([
  'class',
  'style',
  'id',
  'data-vmde-foldable',
  'data-vmde-list-foldable',
  'data-vmde-indent',
  'data-vmde-indent-root',
])

export const isViewOnlyChild = (element: HTMLElement): boolean =>
  VIEW_ONLY_ATTRIBUTES.some((name) => element.hasAttribute(name)) ||
  element.classList.contains('me-diff-marker') ||
  isHelper(element)

const isIgnoredAttribute = (name: string): boolean =>
  IGNORED_ATTRIBUTES.has(name) || name.startsWith('aria-')

function alignOf(cell: Element | undefined): ColumnAlign {
  const value = cell?.getAttribute('align')
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : 'default'
}

function tableUnit(block: HTMLElement): HostUnit<HTMLElement> {
  const table =
    block.tagName === 'TABLE'
      ? block
      : (block.querySelector(':scope > table') as HTMLElement)
  const rows = Array.from(
    table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr'),
  ).map((tr) => Array.from(tr.children) as HTMLElement[])
  return {
    kind: 'table',
    members: [block],
    rows,
    align: (rows[0] ?? []).map(alignOf),
  }
}

/** List items as host units, or undefined when the list holds anything but `li`. */
function listItemUnits(list: HTMLElement): HostUnit<HTMLElement>[] | undefined {
  const items: HostUnit<HTMLElement>[] = []
  for (const child of Array.from(list.children)) {
    if (child.tagName !== 'LI') return undefined
    items.push({ kind: 'list-item', members: [child as HTMLElement] })
  }
  return items
}

/** A root node that is neither an element nor harmless (a comment, whitespace) is a foreign write. */
const isForeignNode = (node: Node): boolean =>
  node.nodeType !== Node.COMMENT_NODE &&
  !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())

/** The units of one top-level element: none for a view-only one, undefined when it has no unit shape. */
function unitsOfElement(
  element: HTMLElement,
): HostUnit<HTMLElement>[] | undefined {
  if (isViewOnlyChild(element)) return []
  if (!element.hasAttribute('data-block')) return undefined
  if (element.tagName === 'UL' || element.tagName === 'OL')
    return listItemUnits(element)
  const kind = domKind(element)
  if (!kind) return undefined
  return [kind === 'table' ? tableUnit(element) : { kind, members: [element] }]
}

function listUnitsOf(root: HTMLElement): HostUnit<HTMLElement>[] | undefined {
  const units: HostUnit<HTMLElement>[] = []
  for (const node of Array.from(root.childNodes)) {
    if (!(node instanceof HTMLElement)) {
      if (isForeignNode(node)) return undefined
      continue
    }
    const own = unitsOfElement(node)
    if (!own) return undefined
    units.push(...own)
  }
  return units
}

/** The list's own opening tag, the shell a lone item is serialized in. */
const shellOf = (list: HTMLElement): string =>
  (list.cloneNode(false) as HTMLElement).outerHTML.replace(/<\/(ul|ol)>$/u, '')

/** Whole-list serialization: one source per item of every parent list that holds a requested item. */
function serializeLists(
  lute: UnitLute,
  items: readonly HTMLElement[],
): string[] | undefined {
  const sourcesByList = new Map<HTMLElement, string[] | undefined>()
  const out: string[] = []
  for (const item of items) {
    const list = item.parentElement as HTMLElement
    if (!sourcesByList.has(list)) {
      const markdown = lute.VditorIRDOM2Md(stripWrapHints(list.outerHTML))
      const blocks = scanMovableBlocks(markdown)
      sourcesByList.set(
        list,
        blocks.length === list.children.length
          ? blocks.map((block) =>
              markdown.slice(block.start, block.end).replace(/\n+$/u, ''),
            )
          : undefined,
      )
    }
    const sources = sourcesByList.get(list)
    if (!sources) return undefined
    out.push(sources[Array.prototype.indexOf.call(list.children, item)])
  }
  return out
}

/** Whether a child-list record only adds or removes `[data-render]` nodes (a view-only render). */
function onlyRenderNodes(record: MutationRecord): boolean {
  const { addedNodes, removedNodes } = record
  if (addedNodes.length + removedNodes.length === 0) return false
  for (let i = 0; i < addedNodes.length; i += 1) {
    const node = addedNodes[i]
    if (!(node instanceof Element && node.hasAttribute('data-render')))
      return false
  }
  for (let i = 0; i < removedNodes.length; i += 1) {
    const node = removedNodes[i]
    if (!(node instanceof Element && node.hasAttribute('data-render')))
      return false
  }
  return true
}

/** Receives what one observer batch marked (Task 733 / 005-A; shared rules 3.3). */
export interface UnitDomOptions {
  onBatch?(
    changed: ReadonlySet<Unit<HTMLElement>>,
    structure: ReadonlySet<'root' | Unit<HTMLElement>>,
  ): void
}

export function createUnitDom(
  root: HTMLElement,
  lute: UnitLute,
  options?: UnitDomOptions,
): UnitHost<HTMLElement> & UnitDomControl {
  let model: TextModel<HTMLElement> | undefined
  // Created on the first mark of a batch, so a batch that marks nothing allocates nothing (R-2).
  let batchChanged: Set<Unit<HTMLElement>> | undefined
  let batchStructure: Set<'root' | Unit<HTMLElement>> | undefined

  const markDirty = (unit: Unit<HTMLElement>): void => {
    model?.markDirty(unit)
    if (!options?.onBatch) return
    if (!batchChanged) batchChanged = new Set()
    batchChanged.add(unit)
  }

  const markStructure = (scope: 'root' | Unit<HTMLElement>): void => {
    model?.markStructureDirty(scope)
    if (!options?.onBatch) return
    if (!batchStructure) batchStructure = new Set()
    batchStructure.add(scope)
  }
  let observer: MutationObserver | undefined
  let unregister: (() => void) | undefined

  /** The top-level child of the root that holds `element`, or undefined for the root itself. */
  const topLevelOf = (element: Element): HTMLElement | undefined => {
    let current: Element | null = element
    while (current && current.parentElement !== root)
      current = current.parentElement
    return (current as HTMLElement | null) ?? undefined
  }

  /** A top-level list item unit for any item of `list` (the scope of a list structure change). */
  const itemUnitOf = (
    list: HTMLElement,
    removed: NodeList,
  ): Unit<HTMLElement> | undefined => {
    for (const child of Array.from(list.children)) {
      const unit = model?.unitOf(child as HTMLElement)
      if (unit) return unit
    }
    for (const node of Array.from(removed)) {
      const unit = node instanceof HTMLElement ? model?.unitOf(node) : undefined
      if (unit) return unit
    }
    return undefined
  }

  const markBlock = (block: HTMLElement | undefined): void => {
    const unit = block ? model?.unitOf(block) : undefined
    // A block without a unit is a view-only or foreign element: the root structure decides.
    if (unit) markDirty(unit)
    else markStructure('root')
  }

  const markTableStructure = (block: HTMLElement | undefined): void => {
    const unit = block ? model?.unitOf(block) : undefined
    if (unit) markStructure(unit)
    else markStructure('root')
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the record to scope mapping of shared rules 3.4, one branch per scope
  const mark = (record: MutationRecord): void => {
    if (!model || isOwnHintRecord(record)) return
    const target = record.target
    const element = target instanceof Element ? target : target.parentElement
    if (!element || !root.contains(element)) return
    if (record.type === 'attributes') {
      // The root's own attributes (streaming toggles contenteditable) and presentation attributes.
      if (element === root) return
      const name = record.attributeName ?? ''
      if (isIgnoredAttribute(name)) return
      if (
        element.parentElement === root &&
        (VIEW_ONLY_ATTRIBUTES as readonly string[]).includes(name)
      ) {
        markStructure('root')
        return
      }
    }
    if (element.closest('[data-render]')) return
    if (record.type === 'childList' && onlyRenderNodes(record)) return
    if (element === root) {
      markStructure('root')
      return
    }
    const cell = element.closest('td, th')
    if (cell && root.contains(cell)) {
      if (record.type === 'attributes' && record.attributeName === 'align') {
        markTableStructure(topLevelOf(cell))
        return
      }
      const unit = model.unitOf(cell as HTMLElement)
      if (unit) {
        markDirty(unit)
        return
      }
    }
    const block = topLevelOf(element)
    if (
      record.type === 'childList' &&
      (element.matches('table, thead, tbody, tr') ||
        (element === block &&
          block?.tagName === 'DIV' &&
          block.querySelector(':scope > table')))
    ) {
      markTableStructure(block)
      return
    }
    if (block && (block.tagName === 'UL' || block.tagName === 'OL')) {
      if (element === block) {
        // A child-list record on the list itself: the list run changed.
        const item = itemUnitOf(block, record.removedNodes)
        if (item) markStructure(item)
        else markStructure('root')
        return
      }
      let item: Element = element
      while (item.parentElement !== block) item = item.parentElement as Element
      const unit = model.unitOf(item as HTMLElement)
      if (unit) markDirty(unit)
      else markStructure('root')
      return
    }
    markBlock(block)
  }

  const process = (records: readonly MutationRecord[]): void => {
    for (const record of records) mark(record)
    const changed = batchChanged
    const structure = batchStructure
    if (!changed && !structure) return
    batchChanged = undefined
    batchStructure = undefined
    options?.onBatch?.(changed ?? new Set(), structure ?? new Set())
  }

  return {
    listUnits: () => listUnitsOf(root),
    html: (kind: UnitKind, el: HTMLElement) =>
      stripWrapHints(kind === 'cell' ? el.innerHTML : el.outerHTML),
    serialize(kind, members) {
      if (kind === 'cell')
        return serializeCellHtml(lute, stripWrapHints(members[0].innerHTML))
      if (kind === 'list-item') {
        const item = members[0]
        return serializeListItemHtml(
          lute,
          shellOf(item.parentElement as HTMLElement),
          stripWrapHints(item.outerHTML),
        )
      }
      return serializeBlockHtml(
        lute,
        members.map((member) => stripWrapHints(member.outerHTML)),
      )
    },
    roundTrip: (kind, source) =>
      kind === 'cell'
        ? roundTripCell(lute, source)
        : roundTripBlock(
            lute,
            kind as Exclude<UnitKind, 'cell' | 'row'>,
            source,
          ),
    serializeList: (items) => serializeLists(lute, items),
    attach(next) {
      this.detach()
      model = next
      observer = new MutationObserver(process)
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
      // A quiet write first hands over the genuine records queued before it.
      unregister = registerQuietObserver(observer, process)
    },
    drain() {
      if (observer) process(observer.takeRecords())
    },
    detach() {
      unregister?.()
      unregister = undefined
      observer?.disconnect()
      observer = undefined
      model = undefined
      batchChanged = undefined
      batchStructure = undefined
    },
  }
}
