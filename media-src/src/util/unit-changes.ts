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

function slotOf(win: Window): FeedSlot {
  let slot = slots.get(win)
  if (!slot) {
    slot = { feed: undefined, off: undefined, listeners: new Set() }
    slots.set(win, slot)
  }
  return slot
}

/** Makes `feed` the feed of `win` (`undefined` clears it); the listeners of `onUnitFeed` follow the replacement. */
export function provideUnitFeed(win: Window, feed: UnitFeed | undefined): void {
  const slot = slotOf(win)
  slot.off?.()
  slot.off = undefined
  slot.feed = feed
  if (!feed) return
  slot.off = feed.onUnitsChanged((change) => {
    // Re-read the registry: a listener added or removed during an emission takes effect next time.
    for (const listener of Array.from(slot.listeners)) listener(change, feed)
  })
}

export function unitFeedOf(win: Window): UnitFeed | undefined {
  return slots.get(win)?.feed
}

/** Subscribes to the current feed and to every feed provided later; returns the unsubscribe. */
export function onUnitFeed(win: Window, listener: FeedListener): () => void {
  const slot = slotOf(win)
  slot.listeners.add(listener)
  return () => {
    slot.listeners.delete(listener)
  }
}
