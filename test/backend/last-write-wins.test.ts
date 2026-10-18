import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lastWriteWinsFor } from '../../src/platform/last-write-wins'
import { debug } from '../../src/platform/host-log'
import { createExtHostMemento } from './ext-host-memento'

vi.mock('../../src/platform/host-log', () => ({ debug: vi.fn() }))

// Task 657 (Acceptance 1 and 3 at the unit level): the stored value after rapid writes is the last
// one written, whether a stale storage value replaces the memento's local object between a write's
// `update` and its flush, or arrives after the last acknowledgement (the cross-process broadcast).
describe('lastWriteWinsFor', () => {
  const stores: object[] = []
  const track = <T extends object>(store: T): T => {
    stores.push(store)
    return store
  }
  const fake = () => track(createExtHostMemento())
  type Fake = ReturnType<typeof createExtHostMemento>

  // One verification tick of the helper, then the memento round trips of any repair.
  const tick = async (memento: Fake, ms = 250) => {
    await vi.advanceTimersByTimeAsync(ms)
    await memento.drain()
  }

  const writeDrained = async (
    memento: Fake,
    writes: ReturnType<typeof lastWriteWinsFor>,
    key: string,
    value: unknown,
  ) => {
    const done = writes.write(key, value)
    await memento.drain()
    await done
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(debug).mockClear()
  })

  afterEach(() => {
    for (const store of stores.splice(0))
      lastWriteWinsFor(store as never).dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('L1 model control: a stale broadcast after the acknowledgements reverts the local value and a re-flush stores it', async () => {
    const memento = fake()
    for (const value of [true, false, true]) {
      void memento.update('k', value)
      await memento.drain()
    }
    memento.deliverStaleEcho(1)
    expect(memento.get('k')).toBe(false)
    void memento.update('other', 1)
    await memento.drain()
    expect(memento.mainValue.k).toBe(false)
  })

  it('keeps the last write when a stale echo lands between a later update and its flush', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    const first = writes.write('k', true)
    await memento.drain()
    const second = writes.write('k', false)
    await memento.settle()
    memento.flush()
    memento.main()
    const third = writes.write('k', true)
    await memento.settle()
    memento.deliverEcho()
    await memento.drain()
    await Promise.all([first, second, third])
    expect(memento.mainValue.k).toBe(true)
    expect(memento.get('k')).toBe(true)
  })

  it('L2 a late stale echo with no further write is read as the last value at once and repaired on the next tick', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    for (const value of [true, false, true])
      await writeDrained(memento, writes, 'k', value)
    memento.deliverStaleEcho(1)
    expect(memento.get('k')).toBe(false)
    expect(writes.get('k')).toBe(true)
    const before = memento.calls.length
    await tick(memento)
    expect(memento.get('k')).toBe(true)
    expect(writes.get('k')).toBe(true)
    expect(memento.mainValue.k).toBe(true)
    expect(memento.calls.length - before).toBe(1)
  })

  it('L3 a stale copy re-flushed by a write to another key is repaired on the next tick', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    for (const value of [true, false, true])
      await writeDrained(memento, writes, 'k', value)
    memento.deliverStaleEcho(1)
    await writeDrained(memento, writes, 'other', 'x')
    expect(memento.mainValue.k).toBe(false)
    await tick(memento)
    expect(memento.mainValue.k).toBe(true)
    expect(memento.mainValue.other).toBe('x')
  })

  it('L4 repairs a stale echo at 1250 ms of quiet; after 1500 ms of quiet the timer is gone and the store value is read', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    for (const value of [true, false, true])
      await writeDrained(memento, writes, 'k', value)
    for (let step = 0; step < 5; step++) await tick(memento)
    memento.deliverStaleEcho(1)
    await tick(memento)
    expect(memento.get('k')).toBe(true)
    expect(memento.mainValue.k).toBe(true)
    for (let step = 0; step < 6; step++) await tick(memento)
    expect(vi.getTimerCount()).toBe(0)
    const before = memento.calls.length
    memento.deliverStaleEcho(1)
    await tick(memento, 2000)
    expect(memento.calls.length).toBe(before)
    expect(writes.get('k')).toBe(false)
  })

  it('L5 accepts a value another writer made that this window never wrote', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    await writeDrained(memento, writes, 'width', 300)
    memento.injectEcho({ width: 777 })
    memento.deliverEcho()
    const before = memento.calls.length
    await tick(memento)
    expect(memento.calls.length).toBe(before)
    expect(writes.get('width')).toBe(777)
    expect(debug).toHaveBeenCalledWith('state changed elsewhere', 'width')
  })

  it('L6 repairs back to the absent base value of a first write', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    await writeDrained(memento, writes, 'k', true)
    memento.injectEcho({})
    memento.deliverEcho()
    expect(memento.get('k')).toBeUndefined()
    await tick(memento)
    expect(memento.get('k')).toBe(true)
    expect(memento.mainValue.k).toBe(true)
  })

  it('L7 stops after the repair limit, drops the intent, logs, and the write has resolved', async () => {
    const values: Record<string, unknown> = {}
    const update = vi.fn(async (key: string, value: unknown) => {
      // A store that always falls back to the older written value.
      values[key] = value === 'b' ? 'a' : value
    })
    const store = track({ get: (key: string) => values[key], update })
    const writes = lastWriteWinsFor(store)
    await writes.write('k', 'a')
    await writes.write('k', 'b')
    for (let step = 0; step < 6; step++) await vi.advanceTimersByTimeAsync(250)
    const repairs = update.mock.calls.filter((call) => call[1] === 'b').length
    expect(repairs).toBe(1 + 3)
    expect(debug).toHaveBeenCalledWith('state write not confirmed', 'k')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('L8 repairs every drifted key in one tick, so the repairs go out in one memento flush', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    await writeDrained(memento, writes, 'a', 1)
    await writeDrained(memento, writes, 'b', 2)
    await writeDrained(memento, writes, 'a', 3)
    await writeDrained(memento, writes, 'b', 4)
    memento.deliverStaleEcho(1) // { a: 1, b: 2 }
    const before = memento.calls.length
    await vi.advanceTimersByTimeAsync(250)
    expect(memento.calls.length - before).toBe(2)
    memento.flush()
    memento.main()
    expect(memento.mainValue).toEqual({ a: 3, b: 4 })
    await memento.drain()
  })

  it('L9 write resolves at the acknowledgement while the window is open; dispose stops the repairs', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    await writeDrained(memento, writes, 'k', true)
    await writeDrained(memento, writes, 'k', false)
    expect(vi.getTimerCount()).toBe(1)
    memento.deliverStaleEcho(0)
    const before = memento.calls.length
    writes.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await tick(memento, 5000)
    expect(memento.calls.length).toBe(before)
  })

  it('after dispose, write and get pass straight to the store: no intent and no timer', async () => {
    const values: Record<string, unknown> = {}
    const update = vi.fn(async (key: string, value: unknown) => {
      values[key] = value
    })
    const writes = lastWriteWinsFor(
      track({ get: (key: string) => values[key], update }),
    )
    writes.dispose()
    await writes.write('k', true)
    expect(update).toHaveBeenCalledWith('k', true)
    expect(vi.getTimerCount()).toBe(0)
    values.k = false // an outside change is read as is, not hidden by an intent
    expect(writes.get('k')).toBe(false)
  })

  it('drops the intent and rethrows when update throws synchronously', async () => {
    const values: Record<string, unknown> = { k: 'stored' }
    const writes = lastWriteWinsFor(
      track({
        get: (key: string) => values[key],
        update: () => {
          throw new Error('sync boom')
        },
      }),
    )
    await expect(writes.write('k', true)).rejects.toThrow('sync boom')
    expect(writes.get('k')).toBe('stored')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('one key whose repair throws does not stop the others or the idle cleanup', async () => {
    const values: Record<string, unknown> = {}
    let failA = false
    const update = vi.fn((key: string, value: unknown) => {
      if (key === 'a' && failA) throw new Error('sync boom')
      values[key] = value
      return Promise.resolve()
    })
    const writes = lastWriteWinsFor(
      track({ get: (key: string) => values[key], update }),
    )
    await writes.write('a', 1)
    await writes.write('b', 2)
    values.a = undefined // both drift back to the base value
    values.b = undefined
    failA = true
    await vi.advanceTimersByTimeAsync(250)
    expect(values.b).toBe(2)
    expect(debug).toHaveBeenCalledWith(
      'state repair failed',
      'a',
      expect.any(Error),
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not repair when nothing was lost: three writes make three updates', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    for (const value of [true, false, true])
      await writeDrained(memento, writes, 'k', value)
    await tick(memento, 2000)
    expect(memento.calls.map((call) => call.value)).toEqual([true, false, true])
    expect(memento.mainValue.k).toBe(true)
  })

  it('lets the newer write own the value when it arrives before the earlier acknowledgement', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    const older = writes.write('k', 'a')
    const newer = writes.write('k', 'b')
    await memento.drain()
    await Promise.all([older, newer])
    expect(memento.mainValue.k).toBe('b')
    expect(memento.get('k')).toBe('b')
    expect(memento.calls).toHaveLength(2)
  })

  it('does not let one key repair or wait for another', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    const a = writes.write('a', 1)
    const b = writes.write('b', 2)
    await memento.drain()
    await Promise.all([a, b])
    expect(memento.mainValue).toEqual({ a: 1, b: 2 })
  })

  it('calls update at once and does not wait for an earlier unacknowledged update', async () => {
    const values: Record<string, unknown> = {}
    const update = vi.fn((key: string, value: unknown) => {
      values[key] = value
      return new Promise<void>(() => undefined) // never acknowledged
    })
    const writes = lastWriteWinsFor(
      track({ get: (key: string) => values[key], update }),
    )
    void writes.write('k', true)
    expect(update).toHaveBeenCalledTimes(1)
    void writes.write('k', false)
    expect(update).toHaveBeenCalledTimes(2)
    expect(values.k).toBe(false)
    expect(writes.get('k')).toBe(false)
  })

  it('writes and confirms undefined (a clear)', async () => {
    const memento = fake()
    const writes = lastWriteWinsFor(memento)
    await writeDrained(memento, writes, 'k', true)
    await writeDrained(memento, writes, 'k', undefined)
    expect(memento.get('k')).toBeUndefined()
    expect(writes.get('k')).toBeUndefined()
    expect(memento.mainValue).not.toHaveProperty('k')
    expect(memento.calls.map((call) => call.value)).toEqual([true, undefined])
  })

  it('treats a structurally equal stored object as confirmed', async () => {
    // A storage echo hands back a parsed copy of what was written; that is not a lost write.
    const values: Record<string, unknown> = {}
    const update = vi.fn(async (key: string, value: unknown) => {
      values[key] = JSON.parse(JSON.stringify(value))
    })
    const writes = lastWriteWinsFor(
      track({ get: (key: string) => values[key], update }),
    )
    await writes.write('k', { mode: 'ir', nested: { a: [1, 2] } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('rejects when update rejects', async () => {
    const writes = lastWriteWinsFor(
      track({
        get: () => undefined,
        update: () => Promise.reject(new Error('disk full')),
      }),
    )
    await expect(writes.write('k', true)).rejects.toThrow('disk full')
  })

  it('shares one helper per store object', () => {
    const a = fake()
    const b = fake()
    expect(lastWriteWinsFor(a)).toBe(lastWriteWinsFor(a))
    expect(lastWriteWinsFor(a)).not.toBe(lastWriteWinsFor(b))
  })
})
