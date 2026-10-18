// Section indentation (Task 649). The depth core (blockDepths, updateBlockDepths) is pure and
// DOM-free: the controller at the end of this file describes each top-level block as an
// IndentBlock and applies the returned depths.
//
// Depth rule: a top-level heading's depth is its level - 1 (absolute, so skipped levels and a
// document whose top heading is `##` keep their level), capped at MAX_SECTION_DEPTH. Every other
// block takes the depth of the nearest preceding top-level heading; blocks before the first
// heading (intro, front matter) have depth 0.

import type { InnerVditor } from '../util/inner-vditor'
import {
  classifyEditorMutations,
  recordHelperMutationPass,
} from '../util/mutation-impact'
import { RAW_HEADING_ATTR } from './preview-raw-headings'
import { headingLevel, topLevelBlocks } from './section-range'

/** One top-level block, as the caller classifies it. */
export interface IndentBlock {
  /**
   * 1-6 for a top-level heading. Headings nested in a list, quote, callout, Details or HTML block
   * start no section, so the caller must leave `headingLevel` unset for them.
   */
  headingLevel?: number
  /**
   * Lute moves footnote and link-reference definition blocks to the document end in IR and
   * WYSIWYG; they always get depth 0 and do not change the running depth.
   */
  tail?: boolean
  /** Informational block kind (front matter, list, quote, ...); not used by the depth rule. */
  kind?: string
}

const MAX_SECTION_DEPTH = 5

function headingDepth(level: number): number {
  return Math.min(Math.max(level - 1, 0), MAX_SECTION_DEPTH)
}

/** Depth of every block; O(n). */
export function blockDepths(blocks: readonly IndentBlock[]): number[] {
  const depths = new Array<number>(blocks.length)
  let running = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.tail) {
      depths[i] = 0
      continue
    }
    if (block.headingLevel !== undefined)
      running = headingDepth(block.headingLevel)
    depths[i] = running
  }
  return depths
}

export interface DepthUpdate {
  /** Full depth list for `blocks`; entries outside [from, to) are copied from `previous`. */
  depths: number[]
  /** First recomputed index. */
  from: number
  /** End (exclusive) of the recomputed range. */
  to: number
}

/**
 * Local pass. `previous` holds depths for `blocks` that are valid outside the affected range
 * [start, end) (indices in the NEW list; an empty range marks a removal point). Recomputes from
 * `start` through `end` and then forward until the next top-level heading, whose depth depends only
 * on its own level, so the result equals blockDepths(blocks) at a cost bounded by the affected
 * blocks plus the blocks up to that heading.
 */
export function updateBlockDepths(
  blocks: readonly IndentBlock[],
  previous: readonly number[],
  start: number,
  end: number,
): DepthUpdate {
  const depths = previous.slice(0, blocks.length)
  const from = Math.max(0, Math.min(start, blocks.length))
  let running = 0
  for (let i = from - 1; i >= 0; i--) {
    if (!blocks[i].tail) {
      running = previous[i]
      break
    }
  }
  let i = from
  for (; i < blocks.length; i++) {
    const block = blocks[i]
    if (i >= end && block.headingLevel !== undefined && !block.tail) break
    if (block.tail) {
      depths[i] = 0
      continue
    }
    if (block.headingLevel !== undefined)
      running = headingDepth(block.headingLevel)
    depths[i] = running
  }
  return { depths, from, to: i }
}

// ---------------------------------------------------------------------------------------------
// Controller (Task 649 S3). Marks each top-level block of the live surfaces with
// `data-vmde-indent="N"` (absent means depth 0) so CSS can indent it. Display only: attributes on
// existing nodes, no injected node, and none of the serializers reads them. With the setting off
// the controller owns no observer and no attribute.

const INDENT_ATTR = 'data-vmde-indent'
const ROOT_ATTR = 'data-vmde-indent-root'
const TAIL_TYPES = new Set(['footnotes-block', 'link-ref-defs-block'])
// Lute's Preview HTML for footnote definitions is one top-level
// `<div class="footnotes-defs-div"><hr class="footnotes-defs-hr"><ol class="footnotes-defs-ol">`
// at the document end, wherever the definitions were written (probed against the vendored Lute,
// Task 660). The list inside is never a top-level child, and no `ol.footnotes-defs` exists.
// Link-reference definitions render nothing in Preview.
const PREVIEW_TAIL = 'div.footnotes-defs-div'
const HEADING_TAG = /^H([1-6])$/

interface Surface {
  el: HTMLElement
  /** IR/WYSIWYG block surfaces observe the whole subtree; Preview observes its direct children. */
  edit: boolean
}

function liveSurfaces(inner: InnerVditor | undefined): Surface[] {
  const out: Surface[] = []
  for (const el of [inner?.ir?.element, inner?.wysiwyg?.element])
    if (el) out.push({ el, edit: true })
  const preview = inner?.preview?.previewElement
  if (preview) out.push({ el: preview, edit: false })
  return out
}

function readDepth(el: Element): number {
  return Number(el.getAttribute(INDENT_ATTR)) || 0
}

/** Writes only a changed value; depth 0 removes the attribute. */
function writeDepth(el: Element, depth: number): void {
  const want = depth > 0 ? String(depth) : null
  if (el.getAttribute(INDENT_ATTR) === want) return
  if (want === null) el.removeAttribute(INDENT_ATTR)
  else el.setAttribute(INDENT_ATTR, want)
}

const DETAILS_TAG = /<(\/?)details\b[^>]*>/gi

/**
 * Top-level blocks that sit between a paired `<details>` and `</details>` HTML block (Lute splits a
 * Details element into sibling blocks in IR and WYSIWYG). Pairing mirrors editing/details.ts: tags
 * are read from the HTML block's source and matched with a stack; an unmatched tag pairs nothing.
 */
function detailsBodyBlocks(blocks: readonly HTMLElement[]): Set<Element> {
  const inside = new Set<Element>()
  const open: number[] = []
  blocks.forEach((block, i) => {
    for (const closing of detailsTagKinds(block)) {
      if (!closing) {
        open.push(i)
        continue
      }
      const start = open.pop()
      if (start === undefined || start === i) continue
      for (let k = start + 1; k < i; k++) inside.add(blocks[k])
    }
  })
  return inside
}

/** For an HTML block, one entry per `<details>` tag in source order: true when it closes. */
function detailsTagKinds(block: Element): boolean[] {
  if (block.getAttribute('data-type') !== 'html-block') return []
  const source = block.querySelector('pre code')?.textContent ?? ''
  return Array.from(source.matchAll(DETAILS_TAG), (tag) => tag[1] === '/')
}

function describeEditSurface(surface: HTMLElement): {
  blocks: HTMLElement[]
  items: IndentBlock[]
} {
  const blocks = topLevelBlocks(surface)
  const inDetails = detailsBodyBlocks(blocks)
  const items = blocks.map((block): IndentBlock => {
    if (TAIL_TYPES.has(block.getAttribute('data-type') ?? ''))
      return { tail: true }
    const level = inDetails.has(block) ? null : headingLevel(block)
    return level === null ? {} : { headingLevel: level }
  })
  return { blocks, items }
}

function describePreview(surface: HTMLElement): {
  blocks: HTMLElement[]
  items: IndentBlock[]
} {
  const blocks = Array.from(surface.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  )
  const items = blocks.map((block): IndentBlock => {
    if (block.matches(PREVIEW_TAIL)) return { tail: true }
    // A raw HTML heading (marked by the Preview source mask) is a non-heading block, as in IR and
    // WYSIWYG, so it takes the running depth instead of starting a section.
    if (block.hasAttribute(RAW_HEADING_ATTR)) return {}
    const match = HEADING_TAG.exec(block.tagName)
    return match ? { headingLevel: Number(match[1]) } : {}
  })
  return { blocks, items }
}

function applyFull(blocks: readonly HTMLElement[], items: IndentBlock[]): void {
  const depths = blockDepths(items)
  for (let i = 0; i < blocks.length; i++) writeDepth(blocks[i], depths[i])
}

function applyLocal(
  blocks: readonly HTMLElement[],
  items: IndentBlock[],
  start: number,
  end: number,
): void {
  const result = updateBlockDepths(items, blocks.map(readDepth), start, end)
  for (let i = result.from; i < result.to; i++)
    writeDepth(blocks[i], result.depths[i])
}

function stripSurface(surface: HTMLElement): void {
  surface.removeAttribute(ROOT_ATTR)
  for (const el of surface.querySelectorAll(`:scope > [${INDENT_ATTR}]`))
    el.removeAttribute(INDENT_ATTR)
}

export interface SectionIndentController {
  /** Start (full pass on every live surface) or stop (attributes removed once). */
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
  /** Disconnect the observers; the DOM is left as is (a re-init replaces it). */
  dispose(): void
}

let activeController: SectionIndentController | null = null

/** Live toggle entry for the config path; a no-op until a controller is installed. */
export function setSectionIndentEnabled(enabled: boolean): void {
  activeController?.setEnabled(enabled)
}

export function installSectionIndent(
  inner: InnerVditor | undefined,
  enabled: boolean,
): SectionIndentController {
  const observers = new Map<HTMLElement, MutationObserver>()
  const copyListeners = new Map<HTMLElement, () => void>()
  let on = false

  const editBatch = (surface: HTMLElement, records: MutationRecord[]) => {
    const impact = classifyEditorMutations(records)
    const wide = impact.full || impact.modeRebuild || impact.topLevelChanged
    if (!wide && impact.blocks.size === 0) {
      recordHelperMutationPass('section-indent', records, 'skipped')
      return
    }
    const { blocks, items } = describeEditSurface(surface)
    const indices = [...impact.blocks].map((block) => blocks.indexOf(block))
    if (wide || indices.some((index) => index < 0)) {
      applyFull(blocks, items)
      recordHelperMutationPass('section-indent', records, 'full', blocks.length)
      return
    }
    applyLocal(blocks, items, Math.min(...indices), Math.max(...indices) + 1)
    recordHelperMutationPass('section-indent', records, 'local', indices.length)
  }

  const previewBatch = (surface: HTMLElement, records: MutationRecord[]) => {
    const { blocks, items } = describePreview(surface)
    applyFull(blocks, items)
    recordHelperMutationPass('section-indent', records, 'full', blocks.length)
  }

  // Preview's copy handler clones the selected nodes, so their marks would travel in the clipboard
  // HTML. Take the marks off for the duration of the copy event and write them back right after.
  const stripForCopy = (surface: HTMLElement) => {
    for (const el of surface.querySelectorAll(`:scope > [${INDENT_ATTR}]`))
      el.removeAttribute(INDENT_ATTR)
    setTimeout(() => {
      if (!on || !observers.has(surface)) return
      const { blocks, items } = describePreview(surface)
      applyFull(blocks, items)
    }, 0)
  }

  const start = () => {
    for (const { el, edit } of liveSurfaces(inner)) {
      el.setAttribute(ROOT_ATTR, '')
      const { blocks, items } = edit
        ? describeEditSurface(el)
        : describePreview(el)
      applyFull(blocks, items)
      const observer = new MutationObserver((records) =>
        edit ? editBatch(el, records) : previewBatch(el, records),
      )
      observer.observe(el, { childList: true, subtree: edit })
      observers.set(el, observer)
      if (!edit) {
        const onCopy = () => stripForCopy(el)
        el.addEventListener('copy', onCopy, true)
        copyListeners.set(el, onCopy)
      }
    }
  }

  const stopObserving = () => {
    for (const observer of observers.values()) observer.disconnect()
    observers.clear()
    for (const [el, listener] of copyListeners)
      el.removeEventListener('copy', listener, true)
    copyListeners.clear()
  }

  const controller: SectionIndentController = {
    setEnabled(next) {
      if (next === on) return
      on = next
      if (next) {
        start()
        return
      }
      stopObserving()
      for (const { el } of liveSurfaces(inner)) stripSurface(el)
    },
    isEnabled: () => on,
    dispose() {
      stopObserving()
      on = false
      if (activeController === controller) activeController = null
    },
  }
  activeController = controller
  if (enabled) controller.setEnabled(true)
  return controller
}
