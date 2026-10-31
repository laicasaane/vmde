import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPendingEdit } from './pending-edit'

describe('createPendingEdit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('schedule() debounces onIdle by the configured wait', () => {
    const onIdle = vi.fn()
    const pe = createPendingEdit({ wait: 250, onIdle, onFlush: vi.fn() })
    pe.schedule()
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(249)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid schedule() calls into one onIdle', () => {
    const onIdle = vi.fn()
    const pe = createPendingEdit({ wait: 250, onIdle, onFlush: vi.fn() })
    pe.schedule()
    pe.schedule()
    pe.schedule()
    vi.advanceTimersByTime(250)
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  // Ctrl/Cmd+S (task 58): flush runs onFlush immediately and cancels the pending
  // idle, so the timer can't also fire and the save persists current content.
  it('flush() runs onFlush immediately and cancels the pending onIdle', () => {
    const onIdle = vi.fn()
    const onFlush = vi.fn()
    const pe = createPendingEdit({ wait: 250, onIdle, onFlush })
    pe.schedule()
    pe.flush()
    expect(onFlush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('flush() runs onFlush even when nothing is pending', () => {
    const onFlush = vi.fn()
    const pe = createPendingEdit({ wait: 250, onIdle: vi.fn(), onFlush })
    expect(pe.pending).toBe(false)
    pe.flush()
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('cancel() drops a scheduled idle callback without flushing', () => {
    const onIdle = vi.fn()
    const onFlush = vi.fn()
    const pe = createPendingEdit({ wait: 250, onIdle, onFlush })
    pe.schedule()

    pe.cancel()

    expect(pe.pending).toBe(false)
    vi.advanceTimersByTime(250)
    expect(onIdle).not.toHaveBeenCalled()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('reports pending state across schedule/flush', () => {
    const pe = createPendingEdit({
      wait: 250,
      onIdle: vi.fn(),
      onFlush: vi.fn(),
    })
    expect(pe.pending).toBe(false)
    pe.schedule()
    expect(pe.pending).toBe(true)
    pe.flush()
    expect(pe.pending).toBe(false)
  })
})

// Task 624: with throttled or starved timers the trailing timer can fire late, or never before the
// next key. A schedule() that finds its own timer overdue publishes then, and arms a fresh timer.
describe('createPendingEdit overdue rule (Task 624)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function make(wait = 250) {
    const clock = { t: 0 }
    const onIdle = vi.fn()
    const onFlush = vi.fn()
    const pe = createPendingEdit({
      wait,
      onIdle,
      onFlush,
      now: () => clock.t,
    })
    return { clock, onIdle, onFlush, pe }
  }

  it('runs onIdle("overdue") now when the pending timer is older than the wait, and re-arms', () => {
    const { clock, onIdle, pe } = make()
    pe.schedule()
    clock.t = 300
    pe.schedule() // the first timer has not run: it is late
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenLastCalledWith('overdue')
    expect(pe.pending).toBe(true)

    vi.advanceTimersByTime(250)
    expect(onIdle).toHaveBeenCalledTimes(2)
    expect(onIdle).toHaveBeenLastCalledWith('timer')
    expect(pe.pending).toBe(false)
  })

  it('treats a timer exactly one wait old as overdue and a younger one as normal', () => {
    const young = make()
    young.pe.schedule()
    young.clock.t = 249
    young.pe.schedule()
    expect(young.onIdle).not.toHaveBeenCalled()

    const exact = make()
    exact.pe.schedule()
    exact.clock.t = 250
    exact.pe.schedule()
    expect(exact.onIdle).toHaveBeenCalledTimes(1)
    expect(exact.onIdle).toHaveBeenLastCalledWith('overdue')
  })

  it('control: keys inside the wait only debounce and never report overdue', () => {
    const { clock, onIdle, pe } = make()
    pe.schedule()
    clock.t = 100
    pe.schedule()
    clock.t = 200
    pe.schedule()
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenCalledWith('timer')
  })

  it('does not report overdue when no timer is pending (the previous one already fired)', () => {
    const { clock, onIdle, pe } = make()
    pe.schedule()
    vi.advanceTimersByTime(250)
    expect(onIdle).toHaveBeenCalledTimes(1)
    clock.t = 5_000
    pe.schedule()
    expect(onIdle).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(onIdle).toHaveBeenCalledTimes(2)
    expect(onIdle.mock.calls.map((call) => call[0])).toEqual(['timer', 'timer'])
  })

  it('measures the next overdue check from the re-armed timer, not from the first key', () => {
    const { clock, onIdle, pe } = make()
    pe.schedule()
    clock.t = 300
    pe.schedule() // overdue, re-armed at 300
    clock.t = 500
    pe.schedule() // 200 ms after the re-arm: still normal
    expect(onIdle).toHaveBeenCalledTimes(1)
    clock.t = 800
    pe.schedule() // 300 ms after the last re-arm: overdue again
    expect(onIdle.mock.calls.map((call) => call[0])).toEqual([
      'overdue',
      'overdue',
    ])
  })

  it('flush() after an overdue post flushes once and leaves no timer to run onIdle', () => {
    const { clock, onIdle, onFlush, pe } = make()
    pe.schedule()
    clock.t = 300
    pe.schedule()
    pe.flush()
    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(pe.pending).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenLastCalledWith('overdue')
  })

  it('cancel() after an overdue post drops the re-armed timer', () => {
    const { clock, onIdle, onFlush, pe } = make()
    pe.schedule()
    clock.t = 300
    pe.schedule()
    pe.cancel()
    expect(pe.pending).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('an overdue onIdle that calls schedule() causes no second overdue and leaves one timer', () => {
    const clock = { t: 0 }
    const calls: string[] = []
    const pe = createPendingEdit({
      wait: 250,
      now: () => clock.t,
      onFlush: vi.fn(),
      onIdle: (reason) => {
        calls.push(reason)
        if (reason === 'overdue') pe.schedule()
      },
    })
    pe.schedule()
    clock.t = 300
    pe.schedule()
    expect(calls).toEqual(['overdue'])
    expect(pe.pending).toBe(true)
    vi.advanceTimersByTime(250)
    expect(calls).toEqual(['overdue', 'timer'])
    expect(pe.pending).toBe(false)
  })

  it('an overdue onIdle that calls cancel() leaves no timer to run onIdle later', () => {
    const clock = { t: 0 }
    const calls: string[] = []
    const pe = createPendingEdit({
      wait: 250,
      now: () => clock.t,
      onFlush: vi.fn(),
      onIdle: (reason) => {
        calls.push(reason)
        if (reason === 'overdue') pe.cancel()
      },
    })
    pe.schedule()
    clock.t = 300
    pe.schedule()
    expect(calls).toEqual(['overdue'])
    expect(pe.pending).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(calls).toEqual(['overdue'])
  })
})
