// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  onUnitFeed,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
  unitFeedOf,
} from './unit-changes'

// Task 733 / 005-B: the per-window feed registry. Stub feeds stand in for the model session.
function stubFeed(): UnitFeed & {
  emit(change: UnitsChange): void
  live: number
} {
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed = {
    root: document.createElement('div'),
    live: 0,
    isLive: () => true,
    liveUnitOf: () => undefined,
    liveUnits: () => [],
    onUnitsChanged(listener: (change: UnitsChange) => void) {
      listeners.add(listener)
      feed.live += 1
      return () => {
        listeners.delete(listener)
        feed.live -= 1
      }
    },
    confirmNow: () => true,
    confirmedLines: () => [],
    emit(change: UnitsChange) {
      for (const listener of Array.from(listeners)) listener(change)
    },
  }
  return feed
}

const change: UnitsChange = {
  cause: 'mutation',
  whole: false,
  changed: [],
  structural: [],
}

describe('unit feed registry', () => {
  it('provides, replaces and clears the feed of a window', () => {
    const win = document.createElement('iframe')
    document.body.append(win)
    const w = win.contentWindow as Window
    expect(unitFeedOf(w)).toBeUndefined()
    const first = stubFeed()
    provideUnitFeed(w, first)
    expect(unitFeedOf(w)).toBe(first)
    const second = stubFeed()
    provideUnitFeed(w, second)
    expect(unitFeedOf(w)).toBe(second)
    provideUnitFeed(w, undefined)
    expect(unitFeedOf(w)).toBeUndefined()
    win.remove()
  })

  it('keeps a listener across a replacement and passes the emitting feed', () => {
    const w = document.createElement('iframe')
    document.body.append(w)
    const win = w.contentWindow as Window
    const listener = vi.fn()
    const first = stubFeed()
    provideUnitFeed(win, first)
    const off = onUnitFeed(win, listener)
    first.emit(change)
    expect(listener).toHaveBeenLastCalledWith(change, first)
    const second = stubFeed()
    provideUnitFeed(win, second)
    // The replaced feed is unsubscribed; the new one is subscribed.
    expect(first.live).toBe(0)
    first.emit(change)
    expect(listener).toHaveBeenCalledTimes(1)
    second.emit(change)
    expect(listener).toHaveBeenLastCalledWith(change, second)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    second.emit(change)
    expect(listener).toHaveBeenCalledTimes(2)
    w.remove()
  })

  it('stops when the feed is cleared and resumes with the next feed; a listener added before any feed works', () => {
    const w = document.createElement('iframe')
    document.body.append(w)
    const win = w.contentWindow as Window
    const listener = vi.fn()
    onUnitFeed(win, listener)
    const first = stubFeed()
    provideUnitFeed(win, first)
    first.emit(change)
    expect(listener).toHaveBeenCalledTimes(1)
    provideUnitFeed(win, undefined)
    expect(first.live).toBe(0)
    first.emit(change)
    expect(listener).toHaveBeenCalledTimes(1)
    const next = stubFeed()
    provideUnitFeed(win, next)
    next.emit(change)
    expect(listener).toHaveBeenCalledTimes(2)
    w.remove()
  })

  it('keeps windows apart', () => {
    const a = document.createElement('iframe')
    const b = document.createElement('iframe')
    document.body.append(a, b)
    const feed = stubFeed()
    provideUnitFeed(a.contentWindow as Window, feed)
    expect(unitFeedOf(b.contentWindow as Window)).toBeUndefined()
    a.remove()
    b.remove()
  })
})
