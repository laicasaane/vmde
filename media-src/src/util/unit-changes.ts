import type { MovableKind } from '../../../src/shared/block-move'

// Live units of the text model as other modules see them (Task 733). `editing`, `nav`, `links` and
// `chrome` read units and per-frame unit changes through the per-window feed registered here and
// never import `bridge`; `boot` provides the feed (shared rules 3.3).

type LiveUnitKind = MovableKind | 'cell'

export interface LiveUnit {
  /** The cell, the li, or the first member of a block. */
  readonly el: HTMLElement
  readonly members: readonly HTMLElement[]
  readonly kind: LiveUnitKind
  /** The top-level element that holds it: the table, the list, or `el`. */
  readonly top: HTMLElement
}

export interface UnitsChange {
  readonly cause: 'mutation' | 'sync' | 'build' | 'rebind'
  /** true: consumers run their full pass (build, rebind, a root structure change, a dropped batch). */
  readonly whole: boolean
  /** Leaf units dirtied in the batch, document order, no duplicates. */
  readonly changed: readonly LiveUnit[]
  /** Top-level tables and lists whose shape changed. */
  readonly structural: readonly HTMLElement[]
  /**
   * Task 733 (D-13): the elements consumers rescan for this change, all inside `feed.root`: the members of
   * `changed` and the elements a structural change inserted (list items, table rows, spun top-level blocks).
   * Never a whole table or list for a cell, row or item change. Document order, connected when emitted, no
   * duplicates; empty when `whole`. Absent: derive it as today (`structural` tops, then members of `changed`).
   */
  readonly scopes?: readonly HTMLElement[]
}

declare const captureBrand: unique symbol
/** The windows of units whose HTML changed between two checkpoints; opaque, held only in webview memory. */
export interface HistoryCapture {
  readonly [captureBrand]: true
}

/** What the unit history engine needs from the model session (task 004). */
export interface HistoryModelPort {
  /** The model is live in IR, not stale and not awaiting: the unit engine may record and restore. */
  ready(): boolean
  /** The unit engine may hold the history: true while the model is live or a rebuild frame is pending; false otherwise (the old engine holds it). */
  claimable(): boolean
  /** Something changed since the last capture (drains the observer; O(1) otherwise, no allocation). */
  pending(): boolean
  /** The windows of units whose HTML changed since the previous capture, with their HTML then and now; undefined when nothing changed. */
  capture(): HistoryCapture | undefined
  /** Put the capture's `before` (undo) or `after` (redo) HTML back; false when a window's anchor is gone (nothing written). */
  restore(capture: HistoryCapture, side: 'before' | 'after'): boolean
}

export interface UnitLines {
  /** First member of a top-level unit. */
  readonly el: HTMLElement
  /** 0-based line of the unit's first byte in the model text. */
  readonly startLine: number
  /** 0-based line of its last byte. */
  readonly endLine: number
}

export interface UnitFeed {
  /** The IR root the feed describes. */
  readonly root: HTMLElement
  /** The model is live in IR (O(1), no allocation). */
  isLive(): boolean
  liveUnitOf(node: Node): LiveUnit | undefined
  /** Top-level units (lists expanded to items); `undefined` when not live. */
  liveUnits(): readonly LiveUnit[] | undefined
  onUnitsChanged(listener: (change: UnitsChange) => void): () => void
  /** Publishes pending typing (no publication during a composition) and reports whether confirmed units can be read now. */
  confirmNow(): boolean
  /** Line ranges of the top-level units of the confirmed text; `undefined` when not confirmed. */
  confirmedLines(): readonly UnitLines[] | undefined
}

type FeedListener = (change: UnitsChange, feed: UnitFeed) => void

interface FeedSlot {
  feed: UnitFeed | undefined
  /** Unsubscribes the slot from `feed`. */
  off: (() => void) | undefined
  readonly listeners: Set<FeedListener>
}

const slots = new WeakMap<Window, FeedSlot>()
// Task 733 / 015 (D-8): a second slot for the Source feed, so a consumer of the IR or WYSIWYG feed never
// receives a Source change and needs no mode check of its own.
const sourceSlots = new WeakMap<Window, FeedSlot>()

function slotIn(registry: WeakMap<Window, FeedSlot>, win: Window): FeedSlot {
  let slot = registry.get(win)
  if (!slot) {
    slot = { feed: undefined, off: undefined, listeners: new Set() }
    registry.set(win, slot)
  }
  return slot
}

function provideIn(
  registry: WeakMap<Window, FeedSlot>,
  win: Window,
  feed: UnitFeed | undefined,
): void {
  const slot = slotIn(registry, win)
  slot.off?.()
  slot.off = undefined
  slot.feed = feed
  if (!feed) return
  slot.off = feed.onUnitsChanged((change) => {
    // Re-read the registry: a listener added or removed during an emission takes effect next time.
    for (const listener of Array.from(slot.listeners)) listener(change, feed)
  })
}

function listenIn(
  registry: WeakMap<Window, FeedSlot>,
  win: Window,
  listener: FeedListener,
): () => void {
  const slot = slotIn(registry, win)
  slot.listeners.add(listener)
  return () => {
    slot.listeners.delete(listener)
  }
}

/** Makes `feed` the feed of `win` (`undefined` clears it); the listeners of `onUnitFeed` follow the replacement. */
export function provideUnitFeed(win: Window, feed: UnitFeed | undefined): void {
  provideIn(slots, win, feed)
}

export function unitFeedOf(win: Window): UnitFeed | undefined {
  return slots.get(win)?.feed
}

/** Subscribes to the current feed and to every feed provided later; returns the unsubscribe. */
export function onUnitFeed(win: Window, listener: FeedListener): () => void {
  return listenIn(slots, win, listener)
}

/** Task 733 / 015: `provideUnitFeed` for the Source feed (its own slot). */
export function provideSourceUnitFeed(
  win: Window,
  feed: UnitFeed | undefined,
): void {
  provideIn(sourceSlots, win, feed)
}

/**
 * Task 733 / 015: the Source feed of `win`, if one is provided.
 */
export function sourceUnitFeedOf(win: Window): UnitFeed | undefined {
  return sourceSlots.get(win)?.feed
}

/**
 * Task 733 / 015: `onUnitFeed` for the Source feed.
 */
export function onSourceUnitFeed(
  win: Window,
  listener: FeedListener,
): () => void {
  return listenIn(sourceSlots, win, listener)
}

/** Task 733 / 015 (D-1 to D-8): Source mode has its own text model, published by units; false restores
 *  today's Source path (model off in Source with reason 'mode', whole-text posts, old history engine). */
export const SOURCE_UNITS: boolean = true

/** Task 733 / 013 (D-13): the text model, unit spin, unit history and the unit feed serve WYSIWYG. false
 *  restores today's WYSIWYG path (model off with reason 'mode', hooks refuse, old history engine). */
export const WYSIWYG_UNITS: boolean = false

export type UnitMode = 'ir' | 'wysiwyg'

/** The mode the model serves for Vditor's current mode: 'ir', 'wysiwyg' when `wysiwygUnits` (default
 *  WYSIWYG_UNITS), else undefined (Source, unknown, or WYSIWYG units off). O(1), no allocation. */
export function unitModeOf(
  mode: string | null | undefined,
  wysiwygUnits: boolean = WYSIWYG_UNITS,
): UnitMode | undefined {
  if (mode === 'ir') return 'ir'
  return mode === 'wysiwyg' && wysiwygUnits ? 'wysiwyg' : undefined
}

/** Task 733 / 017 (D-13): link reference definitions, footnotes and a table of contents keep the IR model
 *  live as units of their own. false restores today's path (the model is off for such documents). */
export const DEFINITION_UNITS: boolean = true

/** The model-only kinds of task 017 (shared rules 3.3). */
export type DefinitionKind = Extract<
  MovableKind,
  'definition' | 'footnote' | 'toc'
>

/** A unit of one of the model-only kinds of task 017. O(1), no allocation. */
export function isDefinitionKind(kind: LiveUnitKind): kind is DefinitionKind {
  return kind === 'definition' || kind === 'footnote' || kind === 'toc'
}

/** Referenced definitions appended to a spin input: HTML after a sentinel paragraph, and its block count. */
export interface DefinitionContext {
  readonly html: string
  readonly blocks: number
}
