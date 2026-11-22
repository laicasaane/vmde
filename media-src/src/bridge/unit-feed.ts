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
  return feedOf(session, editSync, deps, false)
}

/**
 * Task 733 / 015 (D-8): the Source feed of the same session. It describes the Source model only; the
 * IR feed (`createUnitFeed`) describes the IR and WYSIWYG models only, so neither feed's consumers see
 * the other mode's units or changes.
 */
export function createSourceUnitFeed(
  session: ModelSession,
  editSync: Pick<EditSync, 'flush'>,
  deps: UnitFeedDeps,
): UnitFeed {
  return feedOf(session, editSync, deps, true)
}

function feedOf(
  session: ModelSession,
  editSync: Pick<EditSync, 'flush'>,
  deps: UnitFeedDeps,
  source: boolean,
): UnitFeed {
  // The root a feed describes is the one it was created for; a later null keeps the last one.
  let lastRoot = deps.root()
  /** The live model is this feed's mode (O(1), no allocation); a session fake without `liveMode` serves IR. */
  const mine = (): boolean => (session.liveMode?.() === 'sv') === source
  return {
    get root() {
      lastRoot = deps.root() ?? lastRoot
      return lastRoot as HTMLElement
    },
    isLive: () => session.isLive() && mine(),
    liveUnitOf: (node) => (mine() ? session.liveUnitOf(node) : undefined),
    liveUnits: () => (mine() ? session.liveUnits() : undefined),
    onUnitsChanged: (listener) =>
      session.onUnitsChanged((change) => {
        if (mine()) listener(change)
      }),
    confirmNow() {
      // A composition owns the DOM: nothing is published.
      if (deps.isComposing()) return false
      editSync.flush()
      // Read after the flush (R-1): the flush can post, rebind or leave a unit dirty.
      return mine() && session.confirmedUnits() !== undefined
    },
    confirmedLines: () => (mine() ? session.confirmedLines() : undefined),
    // Task 733 / 036 (step D, 4.2): the account the deferred consumers charge replay work to.
    replayAccount: () => (mine() ? session.replayAccount?.() : undefined),
  }
}

/** The end-to-end counters of the feed (`window.__vmdeUnitFeedStats`): causes, whole changes, kinds and scope count of the last change only. */
interface UnitFeedStats {
  mutation: number
  sync: number
  build: number
  rebind: number
  whole: number
  lastKinds: string[]
  /** Task 733 / 012-12: how many scope elements the last change named (a count, never an element). */
  lastScopes: number
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
    lastScopes: 0,
  }
  slot.__vmdeUnitFeedStats = stats
  const off = onUnitFeed(win, (change: UnitsChange) => {
    stats[change.cause] += 1
    if (change.whole) stats.whole += 1
    // Kinds only: no element, text or offset is kept.
    stats.lastKinds = change.changed.map((unit) => unit.kind)
    stats.lastScopes = change.scopes?.length ?? 0
  })
  return () => {
    off()
    delete slot.__vmdeUnitFeedStats
  }
}
