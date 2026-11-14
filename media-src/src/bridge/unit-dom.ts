import { renderImageCaptions } from 'vditor/src/ts/markdown/imageCaptionRender'
import { processCodeRender } from 'vditor/src/ts/util/processCode'
import {
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { isHelper } from '../editing/trailing-paragraph'
import { domKind } from '../nav/unit-pairing'
import { registerQuietObserver } from '../util/mutation-impact'
import { isOwnHintRecord, stripWrapHints } from '../util/wrap-hint-mark'
import { installApplyText } from './apply-text'
import type {
  ApplySource,
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
  /** Task 733 / 010: the inner Vditor editor, for the post-render steps of `render`; without one they are skipped. */
  vditor?(): unknown
}

interface RenderVditor {
  options?: { preview?: { markdown?: { imageCaption?: boolean } } }
  outline?: { render?(vditor: unknown): unknown }
}

const PREVIEW_FRESH = ".vditor-ir__preview[data-render='2']"

/** Top-level elements of an HTML string, parsed in the root's document (never inserted yet). */
function parseElements(root: HTMLElement, html: string): HTMLElement[] {
  const template = root.ownerDocument.createElement('template')
  template.innerHTML = html
  return Array.from(template.content.children) as HTMLElement[]
}

const isList = (element: Element | null | undefined): boolean =>
  element?.tagName === 'UL' || element?.tagName === 'OL'

/**
 * The list a whole render would put an item in: its tag and its marker (`-`, `*`, `+`; the `.` or `)`
 * delimiter of an ordered list). Items of different keys are different lists (010-R F4).
 */
function listKey(list: Element | null | undefined): string {
  const marker = list?.getAttribute('data-marker') ?? ''
  return `${list?.tagName}:${list?.tagName === 'OL' ? marker.slice(-1) : marker}`
}

/** An ordered list's number shell: its `start` and its first marker, which follow its first item. */
const numberShell = (list: Element): string =>
  `${list.getAttribute('start') ?? ''}|${list.getAttribute('data-marker') ?? ''}`

/** A kind that differs from `kind`: the listing of a render that wrote nothing (UnitHost.render). */
const otherKind = (kind: MovableKind): MovableKind =>
  kind === 'paragraph' ? 'html' : 'paragraph'

/** One built source: the nodes to insert and the host unit they list. */
interface Built {
  nodes: HTMLElement[]
  unit: HostUnit<HTMLElement>
}

/** The built elements of one block source, or undefined when they do not have the source's kind. */
function buildBlock(
  root: HTMLElement,
  lute: UnitLute,
  source: ApplySource,
): Built | undefined {
  const elements = parseElements(root, lute.Md2VditorIRDOM(source.source))
  if (elements.length === 0) return undefined
  if (source.kind === 'list-item') {
    const [list] = elements
    const item = list.children[0] as HTMLElement | undefined
    if (
      elements.length !== 1 ||
      !isList(list) ||
      list.children.length !== 1 ||
      item?.tagName !== 'LI'
    )
      return undefined
    return { nodes: [list], unit: { kind: 'list-item', members: [item] } }
  }
  if (source.kind === 'html-group') {
    if (elements.some((element) => !domKind(element))) return undefined
    return { nodes: elements, unit: { kind: 'html-group', members: elements } }
  }
  if (elements.length !== 1 || domKind(elements[0]) !== source.kind)
    return undefined
  return {
    nodes: elements,
    unit:
      source.kind === 'table'
        ? tableUnit(elements[0])
        : { kind: source.kind, members: elements },
  }
}

/** Swaps the rows `replace` for the body rows of the row sources (same-shape tables). */
function renderRows(
  root: HTMLElement,
  lute: UnitLute,
  sources: readonly ApplySource[],
  replace: readonly HTMLElement[],
): HostUnit<HTMLElement>[] {
  const fresh: HTMLElement[] = []
  for (const [n, source] of sources.entries()) {
    const [table] = parseElements(root, lute.Md2VditorIRDOM(source.source))
    const row = table?.querySelector('tbody > tr') as HTMLElement | null
    if (
      source.kind !== 'table' ||
      !row ||
      row.children.length !== replace[n].children.length
    )
      return sources.map((s) => ({ kind: otherKind(s.kind), members: [] }))
    fresh.push(row)
  }
  for (const [n, row] of fresh.entries()) replace[n].replaceWith(row)
  return fresh.map((row) => ({
    kind: 'table',
    members: [row],
    rows: [Array.from(row.children) as HTMLElement[]],
  }))
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

  // Task 733 / 010: the apply's planning and commit run on models built over this adapter.
  installApplyText()

  /** The post-render steps of `setValue` (vditor/src/index.ts:329-343) on the inserted elements only. */
  const afterRender = (
    inserted: readonly HTMLElement[],
    heading: boolean,
  ): void => {
    const vditor = options?.vditor?.() as RenderVditor | undefined
    if (!vditor) return
    for (const element of inserted) {
      const previews = Array.from(element.querySelectorAll(PREVIEW_FRESH))
      if (element.matches(PREVIEW_FRESH)) previews.push(element)
      for (const preview of previews)
        processCodeRender(preview as HTMLElement, vditor as never)
      renderImageCaptions(
        element,
        'ir',
        Boolean(vditor.options?.preview?.markdown?.imageCaption),
      )
    }
    if (heading) vditor.outline?.render?.(vditor)
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: build, kind check, list placement and insert are one transaction that writes nothing on any refusal
  function render(
    sources: readonly ApplySource[],
    replace: readonly HTMLElement[],
  ): HostUnit<HTMLElement>[] | undefined {
    if (replace.length > 0 && replace.every((el) => el.tagName === 'TR'))
      return renderRows(root, lute, sources, replace)
    // A deletion has no source to differ from: one extra entry makes the listing differ (010-R N1).
    const refused = (): HostUnit<HTMLElement>[] =>
      sources.length === 0
        ? [{ kind: 'html', members: [] }]
        : sources.map((source) => ({
            kind: otherKind(source.kind),
            members: [],
          }))
    const anchor = replace[0]
    if (!anchor?.parentElement) return refused()
    const built: Built[] = []
    for (const source of sources) {
      const one = buildBlock(root, lute, source)
      if (!one) return refused()
      built.push(one)
    }
    // Inside a list only items can be placed; replaced items must all belong to that one list.
    const inList = anchor.tagName === 'LI'
    if (
      replace.some(
        (el) =>
          (el.tagName === 'LI') !== inList ||
          (inList && el.parentElement !== anchor.parentElement),
      ) ||
      (inList && sources.some((source) => source.kind !== 'list-item'))
    )
      return refused()
    if (inList) {
      const list = anchor.parentElement as HTMLElement
      // A new item of another list style, or a new first number of an ordered list, would render as
      // another list or another `start` in a whole render.
      if (built.some((one) => listKey(one.nodes[0]) !== listKey(list)))
        return refused()
      // Removing the first item of an ordered list moves its `start` to the next one, which a kept
      // list does not follow (010-R N1).
      if (
        list.tagName === 'OL' &&
        replace.includes(list.firstElementChild as HTMLElement) &&
        (built.length === 0 ||
          numberShell(built[0].nodes[0]) !== numberShell(list))
      )
        return refused()
    }
    // A new list next to a list of the same tag would render as one list in a whole render.
    if (!inList) {
      const firstNew = built[0]?.nodes[0]
      const lastNew = built[built.length - 1]?.nodes.at(-1)
      const after = replace[replace.length - 1].nextElementSibling
      if (
        (isList(firstNew) &&
          listKey(anchor.previousElementSibling) === listKey(firstNew)) ||
        (isList(lastNew) && listKey(after) === listKey(lastNew))
      )
        return refused()
    }
    const nodes: HTMLElement[] = []
    for (const one of built) {
      if (inList) {
        nodes.push(one.unit.members[0])
        continue
      }
      // Consecutive new items of one list type go into one list, as a whole render gives.
      const previous = nodes[nodes.length - 1]
      if (
        one.unit.kind === 'list-item' &&
        previous &&
        isList(previous) &&
        listKey(previous) === listKey(one.nodes[0])
      ) {
        previous.append(one.unit.members[0])
        continue
      }
      nodes.push(...one.nodes)
    }
    anchor.before(...nodes)
    const lists = new Set<HTMLElement>()
    for (const el of replace) {
      if (inList && el.parentElement) lists.add(el.parentElement)
      el.remove()
    }
    for (const list of lists) if (list.children.length === 0) list.remove()
    const heading =
      sources.some((source) => source.kind === 'heading') ||
      replace.some((el) => domKind(el) === 'heading')
    afterRender(nodes, heading)
    return built.map((one) => one.unit)
  }

  return {
    render,
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
