import {
  onUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import type { EditSync } from './edit-sync'
import type { ModelSession } from './model-session'

// Task 733 / 005-B: the unit feed of one IR model session (shared rules 3.3). It forwards the
// session's reads and adds `confirmNow`, which publishes pending typing before the confirmed units
// are read.

export interface UnitFeedDeps {
  isComposing(): boolean
  /** The IR root, or null while it does not exist. */
  root(): HTMLElement | null
}

export function createUnitFeed(
  session: ModelSession,
  editSync: Pick<EditSync, 'flush'>,
  deps: UnitFeedDeps,
): UnitFeed {
  // The root a feed describes is the one it was created for; a later null keeps the last one.
  let lastRoot = deps.root()
  return {
    get root() {
      lastRoot = deps.root() ?? lastRoot
      return lastRoot as HTMLElement
    },
    isLive: () => session.isLive(),
    liveUnitOf: (node) => session.liveUnitOf(node),
    liveUnits: () => session.liveUnits(),
    onUnitsChanged: (listener) => session.onUnitsChanged(listener),
    confirmNow() {
      // A composition owns the DOM: nothing is published.
      if (deps.isComposing()) return false
      editSync.flush()
      // Read after the flush (R-1): the flush can post, rebind or leave a unit dirty.
      return session.confirmedUnits() !== undefined
    },
    confirmedLines: () => session.confirmedLines(),
  }
}

/** The end-to-end counters of the feed (`window.__vmdeUnitFeedStats`): causes, whole changes, kinds of the last change only. */
interface UnitFeedStats {
  mutation: number
  sync: number
  build: number
  rebind: number
  whole: number
  lastKinds: string[]
}

/** Counts every change of the window's feed; only end-to-end runs call this. Returns the removal. */
export function installUnitFeedStats(win: Window): () => void {
  const slot = win as unknown as { __vmdeUnitFeedStats?: UnitFeedStats }
  const stats: UnitFeedStats = {
    mutation: 0,
    sync: 0,
    build: 0,
    rebind: 0,
    whole: 0,
    lastKinds: [],
  }
  slot.__vmdeUnitFeedStats = stats
  const off = onUnitFeed(win, (change: UnitsChange) => {
    stats[change.cause] += 1
    if (change.whole) stats.whole += 1
    // Kinds only: no element, text or offset is kept.
    stats.lastKinds = change.changed.map((unit) => unit.kind)
  })
  return () => {
    off()
    delete slot.__vmdeUnitFeedStats
  }
}
