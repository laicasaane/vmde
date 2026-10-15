// Scope a MutationObserver batch down to the top-level block(s) it actually touched (task 173), and
// drop batches that are entirely OUR OWN injected decorations (task 174) — for the 3 synchronous,
// before-paint decorators (code-source.ts, callouts.ts, html-comment.ts). They used to ignore the
// MutationRecords and re-`querySelectorAll` the WHOLE editor on every keystroke; cost scaled with
// document size (#blockquotes / #code-blocks / #html-blocks), identical for prose and diagram-source
// editing. This module gives them O(changed block) instead, while staying synchronous (the no-flash
// contract — code-source.ts:14-16, callouts.ts:383-388 — forbids rAF-deferring these).
//
// PROVEN BY PROBE (media-src/src/mutation-scope.test.ts "outerHTML replace reports target = parent"):
// Vditor's per-keystroke spin (`ir/input.ts`) replaces a block via `blockElement.outerHTML = html`,
// which — per DOM spec — fires a childList record whose `target` is the block's PARENT, i.e. the
// SAME `ir.element` root the rare whole-editor rebuilds (`ir/input.ts:183`'s `isIRElement` innerHTML
// replace, `:205-231`'s link-ref-def/footnote relocation) also target. So `record.target === root`
// is NOT a reliable "this was a big structural change" signal — it fires on literally every normal
// edit too (verified empirically, not assumed). Scoping therefore keys off `addedNodes` (which top-
// level block RECEIVED the new content), never `record.target` for childList records.

import { coalescePerFrameWithRecords } from './observe-coalesce'
import { isOwnHintRecord } from './wrap-hint-mark'

const OWN_DECORATION_CLASSES = [
  'vmde-callout__preview', // callouts.ts syncPreview — IR/Preview dual-node render
  'vmde-callout__marker', // callouts.ts hideWysiwygMarker — hidden [!TYPE] marker span
  'vmde-callout__title', // callouts.ts syncWysiwygTitle — WYSIWYG title label
  'vmde-comment', // html-comment.ts — visible comment text (IR/WYSIWYG span, Preview div)
  // code-ref-decorate.ts's inline chip — deliberately NOT `data-render` (see its module doc: the
  // chip's text IS the markdown content, so Lute must still WALK it, not skip the subtree — a
  // `data-render` span would delete the ref from the saved document, measured in the task 229
  // spike). Listed here explicitly since `isOwnDecoration`'s `data-render` check can't see it.
  'vmde-code-ref-chip',
  // bare-url-decorate.ts (Task 655) — the IR/WYSIWYG span and the Preview anchor. Listing it makes a
  // childList record whose ONLY changed nodes are the span itself count as our own decoration. The
  // split text nodes a wrap creates are not own-decoration nodes, so a wrap or unwrap record still
  // reaches the other observers (scoped to its block, idempotent); the seed observer is kept out of
  // those writes by `writeQuietly` below instead.
  'vmde-bare-url',
]

// `data-render="1"` tags EVERY box we inject as a decoration/overlay, never authored markdown
// content (edit-activity.ts keep-last overlay, diagram-error/loading/note, render-cache-client,
// native-offscreen, diagram-zoom button — see memory `ghost-span-not-lute-transparent`). We do NOT
// also match Vditor's own `data-render="2"` / bare `.vditor-ir__preview` here: that shell is created
// as part of a REAL block replace (nested inside a bigger addedNode, not a standalone top-level one
// in the common case) and is ambiguous enough that over-matching risks the exact failure task 173/174
// warn against (silently dropping a genuine content change) — under-filtering only costs an extra,
// cheap, idempotent no-op walk, which is the safe direction to err in.
function isOwnDecoration(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const el = node as Element
  if (el.hasAttribute('data-render')) return true
  return OWN_DECORATION_CLASSES.some((c) => el.classList.contains(c))
}

// Task 174: a childList record whose ENTIRE added+removed set is our own decoration nodes is a
// decoration WRITE, not a content change — skip it so it doesn't re-wake the fleet. Must check every
// node (never just `record.target`): the spin's real block replace nests a decoration (e.g. the
// preview shell) INSIDE a real content node, and that record must still pass.
function isOwnDecorationOnly(rec: MutationRecord): boolean {
  // Task 640: the wrap-hint engine's writes are view state too (split Text node, hint span).
  if (isOwnHintRecord(rec)) return true
  if (rec.type !== 'childList') return false
  const nodes = [...Array.from(rec.addedNodes), ...Array.from(rec.removedNodes)]
  return nodes.length > 0 && nodes.every(isOwnDecoration)
}

// The rendering root that owns block-level structure. Vditor sets this class DIRECTLY on
// `ir.element` / `wysiwyg.element` / `previewElement` (their own constructors — vditor's
// `ir/index.ts`, `wysiwyg/index.ts`, `preview/index.ts` — verified in node_modules source), so it's
// the true block-parent even for observers bound to a WIDER container: `#app` holds the IR and
// WYSIWYG mode elements as siblings (only one visible at a time), so it must be resolved PER MUTATED
// NODE, not once when the observer is installed (same pattern as Vditor's own `hasClosestBlock`,
// which climbs to `.vditor-reset` too).
function resetRoot(node: Node): HTMLElement | null {
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement
  while (el && !el.classList.contains('vditor-reset')) el = el.parentElement
  return el
}

// The top-level block (direct child of ITS `.vditor-reset` root) containing `node` — or `node`
// itself when it's already at that level. Null when `node` sits outside any reset root, or when
// `node` IS the reset root (a whole-root mutation — the caller widens to a full walk).
function topLevelBlockOf(node: Node): HTMLElement | null {
  const root = resetRoot(node)
  if (!root || node === root) return null
  let el: HTMLElement | null =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as HTMLElement)
      : node.parentElement
  while (el?.parentElement && el.parentElement !== root) el = el.parentElement
  return el && el.parentElement === root ? el : null
}

interface MutationScope {
  /** true → the caller should fall back to a full walk of the observed root. */
  full: boolean
  /** distinct top-level blocks to re-scan (meaningful only when `!full`; empty + `!full` means the
   *  whole batch was our own decorations — task 174 — so there is NOTHING to re-scan). */
  blocks: Set<Element>
}

// Above this many distinct top-level blocks, N separate scoped walks aren't meaningfully cheaper
// than one full walk — and this is exactly where the whole-editor rebuild paths (`ir/input.ts:183`
// isIRElement replace, `:205-231` link-ref-def/footnote relocation) naturally land (they touch most/
// all of root's children at once), so this threshold is what turns "full walk" from a special case
// into an emergent property of the general algorithm — see the module doc comment.
const FULL_WALK_BLOCK_THRESHOLD = 6

/**
 * Resolve a MutationObserver batch into the set of top-level blocks it touched, dropping records
 * that are entirely our own injected decorations (task 174) and widening to a full walk whenever the
 * touched set can't be bounded cheaply (task 173's safety net — see the module doc comment for why
 * `record.target` can't be used to detect the "big" cases). An EMPTY `records` array (the observer's
 * initial mount pass) always means "do a full walk" — there is nothing to scope from yet.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: classifies mutation records into a full-walk-vs-scoped-block-set decision across the record kinds; pre-existing (task 469 baseline)
export function scopeMutations(records: MutationRecord[]): MutationScope {
  if (records.length === 0) return { full: true, blocks: new Set() }

  const blocks = new Set<Element>()
  let full = false

  const addBlockFor = (node: Node): void => {
    const blk = topLevelBlockOf(node)
    if (blk) blocks.add(blk)
    else full = true // node outside any reset root, or IS the root — over-scope, never under-scope
  }

  for (const rec of records) {
    if (full) break
    if (isOwnDecorationOnly(rec)) continue // task 174: our own write, not a content change
    if (rec.type === 'characterData') {
      // No addedNodes on a characterData record — always resolve via its target (constraint: these
      // must always pass so a type-marker rewrite like `[!TIPs]` → `[!NOTE]` still re-decorates).
      addBlockFor(rec.target)
      continue
    }
    if (rec.addedNodes.length === 0) continue // pure removal — nothing NEW to (re-)decorate
    for (const n of Array.from(rec.addedNodes)) {
      if (n.nodeType !== Node.ELEMENT_NODE) continue // ignore stray text/comment noise
      addBlockFor(n)
      if (full) break
    }
  }

  if (full || blocks.size > FULL_WALK_BLOCK_THRESHOLD)
    return { full: true, blocks }
  return { full: false, blocks }
}

export interface EditorMutationImpact {
  full: boolean
  blocks: ReadonlySet<HTMLElement>
  structural: boolean
  modeRebuild: boolean
  topLevelChanged: boolean
}

export type HelperMutationPass = 'full' | 'local' | 'skipped'

interface HelperMutationPassStats {
  callbacks: number
  records: number
  full: number
  local: number
  skipped: number
  blocks: number
}

interface MutationImpactE2EStats {
  rawCallbacks: number
  rawRecords: number
  helpers: Record<string, HelperMutationPassStats>
}

type MutationImpactWindow = Window & {
  __vmdeE2EReadiness?: unknown
  __vmdeMutationImpactStats?: MutationImpactE2EStats
}

function e2eImpactStats(): MutationImpactE2EStats | null {
  const win = window as MutationImpactWindow
  if (!win.__vmdeE2EReadiness) return null
  win.__vmdeMutationImpactStats ??= {
    rawCallbacks: 0,
    rawRecords: 0,
    helpers: {},
  }
  return win.__vmdeMutationImpactStats
}

export function recordHelperMutationPass(
  name: string,
  records: readonly MutationRecord[],
  pass: HelperMutationPass,
  blocks = 0,
): void {
  const stats = e2eImpactStats()
  if (!stats) return
  let helper = stats.helpers[name]
  if (!helper) {
    helper = {
      callbacks: 0,
      records: 0,
      full: 0,
      local: 0,
      skipped: 0,
      blocks: 0,
    }
    stats.helpers[name] = helper
  }
  helper.callbacks++
  helper.records += records.length
  helper[pass]++
  helper.blocks += blocks
}

/** E2E-only raw record counter. Outside the real harness the readiness ledger is absent, so this
 * installs no observer and adds zero production mutation work. */
export function installMutationRecordProbe(
  root: HTMLElement | null | undefined,
): () => void {
  const stats = e2eImpactStats()
  if (!root || !stats) return () => undefined
  const observer = new MutationObserver((records) => {
    stats.rawCallbacks++
    stats.rawRecords += records.length
  })
  observer.observe(root, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  })
  return () => observer.disconnect()
}

interface MutationImpactOptions {
  blockThreshold?: number
}

const STRUCTURAL_SELECTOR =
  'h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, table, details, [data-type="toc-block"]'

function containsResetSurface(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const element = node as Element
  return (
    element.classList.contains('vditor-reset') ||
    element.querySelector('.vditor-reset') !== null
  )
}

/** Drop records confined to Vditor chrome. Stable #app observers receive outline/toolbar replacement
 * alongside editor mutations; explicit chrome is irrelevant, while every other non-reset record
 * remains fail-closed because cache/render triggers can legitimately sit just outside a reset root. */
function editorSurfaceMutationRecords(
  records: readonly MutationRecord[],
): MutationRecord[] {
  return records.filter((record) => {
    if (resetRoot(record.target)) return true
    if (
      [
        ...Array.from(record.addedNodes),
        ...Array.from(record.removedNodes),
      ].some((node) => resetRoot(node) !== null || containsResetSurface(node))
    )
      return true
    const target =
      record.target.nodeType === Node.ELEMENT_NODE
        ? (record.target as Element)
        : record.target.parentElement
    return !target?.closest('.vditor-outline, .vditor-toolbar')
  })
}

function hasStructuralShape(node: Node, includeDescendants = false): boolean {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return Boolean(
    element?.matches(STRUCTURAL_SELECTOR) ||
      element?.closest(STRUCTURAL_SELECTOR) ||
      (includeDescendants && element?.querySelector(STRUCTURAL_SELECTOR)),
  )
}

function elementNodes(nodes: NodeList): Element[] {
  return Array.from(nodes).filter(
    (node): node is Element => node.nodeType === Node.ELEMENT_NODE,
  )
}

function detachedBlockShape(
  node: Node,
  record?: MutationRecord,
): string | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const targetElement =
    record?.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record?.target.parentElement
  const block =
    element?.closest<HTMLElement>('[data-block="0"]') ??
    targetElement?.closest<HTMLElement>('[data-block="0"]')
  return block
    ? `${block.tagName}|${block.getAttribute('data-type') ?? ''}`
    : null
}

function liveMutationBlock(
  node: Node,
  record?: MutationRecord,
): HTMLElement | null {
  const direct = topLevelBlockOf(node)
  if (direct?.isConnected) return direct
  if (!record) return null
  const target = topLevelBlockOf(record.target)
  if (target?.isConnected) return target
  if (record.previousSibling?.isConnected) {
    const neighbor = record.previousSibling.nextSibling
    const previous = neighbor ? topLevelBlockOf(neighbor) : null
    if (previous?.isConnected) return previous
  }
  if (record.nextSibling?.isConnected) {
    const neighbor = record.nextSibling.previousSibling
    const next = neighbor ? topLevelBlockOf(neighbor) : null
    if (next?.isConnected) return next
  }
  return null
}

/** Resolve mutation records for helpers that need more than Task 173's decoration scope. This keeps
 * per-observer dispatch ownership intact while sharing the fail-closed decisions for connected live
 * blocks, structural edits, mode rebuilds, and broad batches. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass must conservatively combine record kind, live block resolution, structural shape, and full-fallback signals.
export function classifyEditorMutations(
  records: MutationRecord[],
  options: MutationImpactOptions = {},
): EditorMutationImpact {
  if (records.length === 0) {
    return {
      full: true,
      blocks: new Set(),
      structural: true,
      modeRebuild: false,
      topLevelChanged: true,
    }
  }
  const blocks = new Set<HTMLElement>()
  const threshold = options.blockThreshold ?? FULL_WALK_BLOCK_THRESHOLD
  let full = false
  let structural = false
  let modeRebuild = false
  let topLevelChanged = false
  const unresolvedShapes: string[] = []
  let unresolvedUnknown = false

  const addBlockFor = (node: Node, record?: MutationRecord): void => {
    const block = liveMutationBlock(node, record)
    if (block) {
      blocks.add(block)
      return
    }
    const shape = detachedBlockShape(node, record)
    if (shape) unresolvedShapes.push(shape)
    else unresolvedUnknown = true
  }

  for (const record of records) {
    if (isOwnDecorationOnly(record)) continue
    if (record.type === 'characterData') {
      addBlockFor(record.target, record)
      structural ||= hasStructuralShape(record.target)
      continue
    }
    if (record.type === 'attributes') {
      addBlockFor(record.target, record)
      structural ||= hasStructuralShape(record.target)
      continue
    }

    const added = Array.from(record.addedNodes)
    const removed = Array.from(record.removedNodes)
    if (added.some(containsResetSurface)) {
      modeRebuild = true
      structural = true
      topLevelChanged = true
      full = true
      continue
    }

    const targetRoot = resetRoot(record.target)
    const targetIsRoot = targetRoot === record.target
    const addedElements = elementNodes(record.addedNodes)
    const removedElements = elementNodes(record.removedNodes)
    const wholeRootReplacement =
      targetIsRoot &&
      removed.length > 0 &&
      addedElements.length > 0 &&
      targetRoot.children.length === addedElements.length &&
      addedElements.every(
        (element, index) => targetRoot.children[index] === element,
      )
    if (wholeRootReplacement) {
      modeRebuild = true
      structural = true
      topLevelChanged = true
      full = true
    }

    if (added.length === 0 && removed.length > 0 && targetIsRoot) {
      // No connected replacement remains to scope a top-level removal around. Wider consumers must
      // clear stale attributes/state across the surviving surface.
      structural = true
      topLevelChanged = true
      full = true
      continue
    }

    if (added.length > 0) {
      for (const node of added) {
        if (node.nodeType === Node.ELEMENT_NODE) addBlockFor(node, record)
        else addBlockFor(record.target, record)
      }
    } else if (removed.length > 0) {
      addBlockFor(record.target, record)
    }

    if (targetIsRoot) {
      const addedShape = addedElements.map(
        (element) =>
          `${element.tagName}|${element.getAttribute('data-type') ?? ''}`,
      )
      const removedShape = removedElements.map(
        (element) =>
          `${element.tagName}|${element.getAttribute('data-type') ?? ''}`,
      )
      if (
        added.length !== removed.length ||
        addedShape.join('\n') !== removedShape.join('\n')
      ) {
        structural = true
        topLevelChanged = true
      }
    }
    if (
      hasStructuralShape(record.target) ||
      addedElements.some((element) => hasStructuralShape(element, true)) ||
      removedElements.some((element) => hasStructuralShape(element, true))
    ) {
      structural = true
    }
  }

  if (unresolvedShapes.length || unresolvedUnknown) {
    const liveShapes = new Set(
      [...blocks].map(
        (block) => `${block.tagName}|${block.getAttribute('data-type') ?? ''}`,
      ),
    )
    if (
      unresolvedUnknown ||
      blocks.size !== 1 ||
      unresolvedShapes.some((shape) => !liveShapes.has(shape))
    )
      full = true
  }
  if (blocks.size > threshold) full = true
  return {
    full,
    blocks,
    structural: structural || full,
    modeRebuild,
    topLevelChanged,
  }
}

function classifyAndRecordHelperMutations(
  name: string,
  records: MutationRecord[],
): { impact: EditorMutationImpact; pass: HelperMutationPass } {
  const impact = classifyEditorMutations(records)
  const pass = impact.full ? 'full' : impact.blocks.size ? 'local' : 'skipped'
  recordHelperMutationPass(name, records, pass, impact.blocks.size)
  return { impact, pass }
}

export function classifyAndRecordEditorSurfaceMutations(
  name: string,
  records: MutationRecord[],
): { impact: EditorMutationImpact; pass: HelperMutationPass } | null {
  const relevant = records.length
    ? editorSurfaceMutationRecords(records)
    : records
  if (records.length > 0 && relevant.length === 0) {
    recordHelperMutationPass(name, records, 'skipped')
    return null
  }
  return classifyAndRecordHelperMutations(name, relevant)
}

// Observers that must not see a decorator's own DOM writes (Task 655). The large-document incremental
// IR seed (bridge/edit-sync.ts) cancels on any content mutation, but wrapping a bare URL only splits
// text nodes: the serialized Markdown is unchanged. `writeQuietly` first hands the observer the
// records already queued (genuine edits, so none is lost), runs the write, then discards the records
// the write itself produced.
interface QuietObserver {
  observer: MutationObserver
  handle: (records: MutationRecord[]) => void
}
const quietObservers = new Set<QuietObserver>()

export function registerQuietObserver(
  observer: MutationObserver,
  handle: (records: MutationRecord[]) => void,
): () => void {
  const entry = { observer, handle }
  quietObservers.add(entry)
  return () => {
    quietObservers.delete(entry)
  }
}

let quietDepth = 0

export function writeQuietly(write: () => void): void {
  // A nested call is part of the outer write: the outer hand-off already delivered the genuine
  // records, and anything queued since is the write's own.
  if (quietDepth === 0)
    for (const q of Array.from(quietObservers))
      q.handle(q.observer.takeRecords())
  quietDepth++
  try {
    write()
  } finally {
    quietDepth--
    // Also when the write throws: its partial records are still not a content edit.
    for (const q of quietObservers) q.observer.takeRecords()
  }
}

/** `root.querySelectorAll(selector)`, but ALSO matching `root` itself — a scoped top-level block can
 *  literally BE the thing a full-root walk was looking for (e.g. the block IS a `<blockquote>`, which
 *  `blockquote.querySelectorAll('blockquote')` would never find since querySelectorAll only searches
 *  descendants). Used by callouts.ts / html-comment.ts's scoped variants. */
export function queryIncludingSelf<E extends Element = Element>(
  root: Element,
  selector: string,
): E[] {
  const out: E[] = root.matches(selector) ? [root as unknown as E] : []
  out.push(...Array.from(root.querySelectorAll<E>(selector)))
  return out
}

/**
 * Wire up a scoped, coalesced, before-paint MutationObserver: the shared shape all 3 decorators
 * above the module header (code-source.ts, callouts.ts, html-comment.ts) each carried their own
 * copy of (task 502 — jscpd flagged it). `apply.full` re-applies over the whole `editorEl` (mount
 * pass, or when `scopeMutations` gave up and asked for a full walk); `apply.within` re-applies to
 * just one top-level block. Returns a disposer. Callers that need MORE than this (callouts.ts adds
 * a caret-leave selectionchange listener) wrap the returned disposer with their own cleanup rather
 * than this function growing an options bag for a one-off need.
 */
export function observeScopedMutations(
  editorEl: HTMLElement,
  apply: {
    full: (editorEl: HTMLElement) => void
    within: (block: Element) => void
  },
): () => void {
  const run = coalescePerFrameWithRecords((records) => {
    const scope = scopeMutations(records)
    if (scope.full) apply.full(editorEl)
    else for (const block of scope.blocks) apply.within(block)
  })
  const obs = new MutationObserver(run)
  obs.observe(editorEl, { childList: true, subtree: true, characterData: true })
  run([])
  return () => {
    obs.disconnect()
    run.cancel()
  }
}
