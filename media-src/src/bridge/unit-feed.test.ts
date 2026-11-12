// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { provideUnitFeed, type UnitsChange } from '../util/unit-changes'
import type { ModelSession } from './model-session'
import { createUnitFeed, installUnitFeedStats } from './unit-feed'

// Task 733 / 005-B: the feed over a stub session; `confirmNow` reads the session after the flush (R-1).
function stubSession(confirmed: () => readonly unknown[] | undefined) {
  const listeners = new Set<(change: UnitsChange) => void>()
  const session = {
    isLive: vi.fn(() => true),
    liveUnitOf: vi.fn(() => undefined),
    liveUnits: vi.fn(() => []),
    confirmedLines: vi.fn(() => []),
    confirmedUnits: vi.fn(confirmed),
    onUnitsChanged(listener: (change: UnitsChange) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return {
    session: session as unknown as ModelSession,
    raw: session,
    emit(change: UnitsChange) {
      for (const listener of Array.from(listeners)) listener(change)
    },
  }
}

const root = document.createElement('div')

describe('createUnitFeed', () => {
  it('confirmNow is false during a composition and does not flush', () => {
    const { session, raw } = stubSession(() => [])
    const flush = vi.fn()
    const feed = createUnitFeed(
      session,
      { flush },
      { isComposing: () => true, root: () => root },
    )
    expect(feed.confirmNow()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    expect(raw.confirmedUnits).not.toHaveBeenCalled()
  })

  it('confirmNow flushes and reads the confirmed units after the flush', () => {
    let dirty = true
    const { session } = stubSession(() => (dirty ? undefined : []))
    const flush = vi.fn(() => {
      dirty = false
    })
    const feed = createUnitFeed(
      session,
      { flush },
      { isComposing: () => false, root: () => root },
    )
    // The state before the flush was dirty; the answer reflects the state after it.
    expect(feed.confirmNow()).toBe(true)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('confirmNow is false when the flush leaves a dirty unit', () => {
    const { session } = stubSession(() => undefined)
    const feed = createUnitFeed(
      session,
      { flush: vi.fn() },
      { isComposing: () => false, root: () => root },
    )
    expect(feed.confirmNow()).toBe(false)
  })

  it('delegates the reads and the subscription to the session and exposes the root', () => {
    const stub = stubSession(() => [])
    const feed = createUnitFeed(
      stub.session,
      { flush: vi.fn() },
      { isComposing: () => false, root: () => root },
    )
    expect(feed.root).toBe(root)
    expect(feed.isLive()).toBe(true)
    feed.liveUnits()
    feed.confirmedLines()
    feed.liveUnitOf(root)
    expect(stub.raw.liveUnits).toHaveBeenCalled()
    expect(stub.raw.confirmedLines).toHaveBeenCalled()
    expect(stub.raw.liveUnitOf).toHaveBeenCalledWith(root)
    const listener = vi.fn()
    const off = feed.onUnitsChanged(listener)
    const change: UnitsChange = {
      cause: 'sync',
      whole: false,
      changed: [],
      structural: [],
    }
    stub.emit(change)
    expect(listener).toHaveBeenCalledWith(change)
    off()
    stub.emit(change)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('installUnitFeedStats', () => {
  it('counts causes and whole changes and keeps only the kinds of the last change', () => {
    const win = document.createElement('iframe')
    document.body.append(win)
    const w = win.contentWindow as Window & {
      __vmdeUnitFeedStats?: Record<string, unknown>
    }
    const stub = stubSession(() => [])
    const feed = createUnitFeed(
      stub.session,
      { flush: vi.fn() },
      { isComposing: () => false, root: () => root },
    )
    const stop = installUnitFeedStats(w)

    provideUnitFeed(w, feed)
    const cell = document.createElement('td')
    stub.emit({ cause: 'build', whole: true, changed: [], structural: [] })
    stub.emit({
      cause: 'mutation',
      whole: false,
      changed: [{ el: cell, members: [cell], kind: 'cell', top: cell }],
      structural: [],
    })
    expect(w.__vmdeUnitFeedStats).toEqual({
      mutation: 1,
      sync: 0,
      build: 1,
      rebind: 0,
      whole: 1,
      lastKinds: ['cell'],
    })
    stop()
    expect(w.__vmdeUnitFeedStats).toBeUndefined()
    win.remove()
  })
})
