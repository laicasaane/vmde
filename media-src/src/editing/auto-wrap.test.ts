import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAutoWrapController, prepareAutoWrapSource } from './auto-wrap'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(target = { generation: 1 }) {
  const current = { value: target }
  const apply = vi.fn()
  const onError = vi.fn()
  const captureTarget = vi.fn(() => current.value)
  const isTargetCurrent = vi.fn(
    (captured: typeof target) => captured === current.value,
  )
  const controller = createAutoWrapController({
    captureTarget,
    isTargetCurrent,
    apply,
    onError,
  })
  controller.updateConfig({ enabled: true, delayMs: 500, column: 80 })
  return {
    controller,
    current,
    captureTarget,
    isTargetCurrent,
    apply,
    onError,
  }
}

describe('createAutoWrapController', () => {
  it('settles the pending render right before capturing the target', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const controller = createAutoWrapController({
      settlePendingRender: () => order.push('settle'),
      captureTarget: () => {
        order.push('capture')
        return {}
      },
      isTargetCurrent: () => true,
      apply: () => undefined,
      onError: vi.fn(),
    })
    controller.updateConfig({ enabled: true, delayMs: 500, column: 80 })
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(order).toEqual(['settle', 'capture'])
  })

  it('applies once when a pending re-spin would replace the target during prepare', async () => {
    vi.useFakeTimers()
    const live = { node: {} }
    let respinPending = true
    const apply = vi.fn()
    let resolvePrepare: (ready: boolean) => void = () => undefined
    const controller = createAutoWrapController({
      settlePendingRender: () => {
        if (respinPending) live.node = {}
        respinPending = false
      },
      captureTarget: () => ({ node: live.node }),
      isTargetCurrent: (target) => target.node === live.node,
      prepare: () =>
        new Promise<boolean>((resolve) => {
          resolvePrepare = resolve
        }),
      apply,
      onError: vi.fn(),
    })
    controller.updateConfig({ enabled: true, delayMs: 500, column: 80 })
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(500)
    // The deferred re-spin, if still pending, lands during the host round trip.
    if (respinPending) {
      live.node = {}
      respinPending = false
    }
    resolvePrepare(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('uses one trailing debounce and resets it on every eligible insertText', async () => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    expect(captureTarget).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(499)
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    expect(captureTarget).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(499)
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(captureTarget).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('rejects an already-queued stale generation before target acquisition', async () => {
    const callbacks: Array<() => void> = []
    vi.stubGlobal('setTimeout', (callback: () => void) => {
      callbacks.push(callback)
      return callbacks.length
    })
    vi.stubGlobal('clearTimeout', () => undefined)
    const { controller, captureTarget, apply } = setup()

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    callbacks[0]()
    expect(captureTarget).not.toHaveBeenCalled()

    callbacks[1]()
    await Promise.resolve()
    expect(captureTarget).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it.each([
    'insertFromPaste',
    'insertFromDrop',
    'deleteContentBackward',
    'insertParagraph',
    'historyUndo',
    'historyRedo',
    'formatBold',
  ])('does not schedule %s', async (inputType) => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()

    controller.handleInput({ inputType, isComposing: false })
    await vi.runAllTimersAsync()
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('cancels a pending prose wrap when a non-text input intervenes', async () => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    controller.handleInput({ inputType: 'historyUndo', isComposing: false })

    await vi.runAllTimersAsync()
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('defers all work during composition and schedules once on compositionend', async () => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()

    controller.handleCompositionStart()
    controller.handleInput({ inputType: 'insertText', isComposing: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    controller.handleCompositionEnd()
    await vi.advanceTimersByTimeAsync(500)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('cancels on disable and delay changes; later input uses the new delay', async () => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()
    controller.handleInput({ inputType: 'insertText', isComposing: false })

    controller.updateConfig({ enabled: true, delayMs: 750, column: 80 })
    await vi.advanceTimersByTimeAsync(500)
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(749)
    expect(apply).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(apply).toHaveBeenCalledTimes(1)

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    controller.updateConfig({ enabled: false, delayMs: 750, column: 80 })
    await vi.runAllTimersAsync()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('drops a stale target and creates no apply work', async () => {
    vi.useFakeTimers()
    const { controller, isTargetCurrent, apply } = setup()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    isTargetCurrent.mockReturnValue(false)

    await vi.advanceTimersByTimeAsync(500)
    expect(apply).not.toHaveBeenCalled()
  })

  it('suppresses recursive scheduling from its own apply callback', async () => {
    vi.useFakeTimers()
    const { controller, apply } = setup()
    apply.mockImplementation(() => {
      controller.handleInput({ inputType: 'insertText', isComposing: false })
    })

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(1000)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('cancel and dispose clear pending work, and dispose is permanent', async () => {
    vi.useFakeTimers()
    const { controller, captureTarget, apply } = setup()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    controller.cancel()
    await vi.runAllTimersAsync()
    expect(captureTarget).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    controller.dispose()
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.runAllTimersAsync()
    expect(apply).not.toHaveBeenCalled()
  })

  it('reports apply failures without leaving recursion suppression armed', async () => {
    vi.useFakeTimers()
    const { controller, apply, onError } = setup()
    apply.mockRejectedValueOnce(new Error('format failed'))
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'format failed' }),
    )

    controller.handleInput({ inputType: 'insertText', isComposing: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('keeps independent editor controllers independent', async () => {
    vi.useFakeTimers()
    const first = setup({ generation: 1 })
    const second = setup({ generation: 2 })
    first.controller.handleInput({
      inputType: 'insertText',
      isComposing: false,
    })
    second.controller.handleInput({
      inputType: 'insertText',
      isComposing: false,
    })
    first.controller.cancel()

    await vi.advanceTimersByTimeAsync(500)
    expect(first.apply).not.toHaveBeenCalled()
    expect(second.apply).toHaveBeenCalledTimes(1)
  })
})

it('announces a pending automatic attempt until it settles, including a restarted quiet timer', async () => {
  vi.useFakeTimers()
  const pendingChanged = vi.fn()
  const apply = vi.fn()
  const controller = createAutoWrapController({
    captureTarget: () => ({}),
    isTargetCurrent: () => true,
    apply,
    onError: vi.fn(),
    pendingChanged,
  })
  controller.updateConfig({ enabled: true, delayMs: 300, column: 30 })
  controller.handleInput({ inputType: 'insertText', isComposing: false })
  expect(pendingChanged.mock.calls).toEqual([[true]])
  await vi.advanceTimersByTimeAsync(220)
  controller.handleInput({ inputType: 'insertText', isComposing: false })
  expect(pendingChanged.mock.calls).toEqual([[true]])
  await vi.advanceTimersByTimeAsync(300)
  expect(apply).toHaveBeenCalledOnce()
  expect(pendingChanged.mock.calls).toEqual([[true], [false]])
})

it.each([
  'cancel',
  'no target',
  'apply error',
  'capture error',
  'current error',
] as const)(
  'releases pending typing when the automatic attempt ends by %s',
  async (reason) => {
    vi.useFakeTimers()
    const pendingChanged = vi.fn()
    const onError = vi.fn()
    const controller = createAutoWrapController({
      captureTarget: () => {
        if (reason === 'capture error') throw new Error('capture failed')
        return reason === 'no target' ? null : {}
      },
      isTargetCurrent: () => {
        if (reason === 'current error') throw new Error('current failed')
        return true
      },
      apply: () => {
        if (reason === 'apply error') throw new Error('apply failed')
      },
      onError,
      pendingChanged,
    })
    controller.updateConfig({ enabled: true, delayMs: 300, column: 30 })
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    if (reason === 'cancel') controller.cancel()
    await vi.advanceTimersByTimeAsync(300)
    expect(pendingChanged.mock.calls).toEqual([[true], [false]])
    expect(onError).toHaveBeenCalledTimes(reason.endsWith('error') ? 1 : 0)
  },
)

// Task 686: after a Source pass the first IR key can come before edit-sync holds exact authority.
// The firing publishes the typing and acquires the host text first (`prepare`), then wraps.
describe('prepare before the automatic wrap (Task 686)', () => {
  function withPrepare(prepare: (target: object) => Promise<boolean>) {
    const target = { generation: 1 }
    const current = { value: target }
    const apply = vi.fn()
    const controller = createAutoWrapController({
      captureTarget: () => current.value,
      isTargetCurrent: (captured: typeof target) => captured === current.value,
      prepare,
      apply,
      onError: vi.fn(),
    } as Parameters<typeof createAutoWrapController<typeof target>>[0])
    controller.updateConfig({ enabled: true, delayMs: 300, column: 30 })
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    return { current, apply, controller }
  }

  it('applies only after prepare resolves true', async () => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const prepare = vi.fn(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    const { apply } = withPrepare(prepare)
    await vi.advanceTimersByTimeAsync(300)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('declines without applying when prepare resolves false', async () => {
    vi.useFakeTimers()
    const { apply } = withPrepare(async () => false)
    await vi.advanceTimersByTimeAsync(300)
    expect(apply).not.toHaveBeenCalled()
  })

  it('declines when composition starts during prepare', async () => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const { apply, controller } = withPrepare(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    await vi.advanceTimersByTimeAsync(300)
    controller.handleCompositionStart()
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('declines when auto-wrap is disabled during prepare', async () => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const { apply, controller } = withPrepare(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    await vi.advanceTimersByTimeAsync(300)
    controller.updateConfig({ enabled: false, delayMs: 300, column: 30 })
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('schedules a new attempt for typing seen while prepare is pending', async () => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const prepare = vi
      .fn<(target: object) => Promise<boolean>>()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (release = resolve)),
      )
      .mockResolvedValue(true)
    const { apply, controller } = withPrepare(prepare)
    await vi.advanceTimersByTimeAsync(300)
    expect(prepare).toHaveBeenCalledTimes(1)
    controller.handleInput({ inputType: 'insertText', isComposing: false })
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(300)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('declines when the target is no longer current after prepare', async () => {
    vi.useFakeTimers()
    let release!: (value: boolean) => void
    const { apply, current } = withPrepare(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    )
    await vi.advanceTimersByTimeAsync(300)
    current.value = { generation: 2 }
    release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('prepareAutoWrapSource (Task 686)', () => {
  const pair = { exact: 'a', rendered: 'a' }

  it('acquires authority with publish when no exact text is held, then resolves true', async () => {
    const acquire = vi.fn(async () => pair)
    const ready = await prepareAutoWrapSource({
      sourceMode: () => false,
      hasExact: () => false,
      acquire,
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(ready).toBe(true)
  })

  it('resolves false when the host reply is null', async () => {
    const ready = await prepareAutoWrapSource({
      sourceMode: () => false,
      hasExact: () => false,
      acquire: async () => null,
    })
    expect(ready).toBe(false)
  })

  it('retries once after a null reply and wraps on the second reply', async () => {
    const acquire = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pair)
    const ready = await prepareAutoWrapSource({
      sourceMode: () => false,
      hasExact: () => false,
      acquire,
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(ready).toBe(true)
  })

  it('declines after two null replies, with exactly two requests', async () => {
    const acquire = vi.fn(async () => null)
    const ready = await prepareAutoWrapSource({
      sourceMode: () => false,
      hasExact: () => false,
      acquire,
    })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(ready).toBe(false)
  })

  it('makes no request when an exact text is already held', async () => {
    const acquire = vi.fn(async () => pair)
    const ready = await prepareAutoWrapSource({
      sourceMode: () => false,
      hasExact: () => true,
      acquire,
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(ready).toBe(true)
  })

  it('makes no request in Source mode', async () => {
    const acquire = vi.fn(async () => pair)
    const ready = await prepareAutoWrapSource({
      sourceMode: () => true,
      hasExact: () => false,
      acquire,
    })
    expect(acquire).not.toHaveBeenCalled()
    expect(ready).toBe(true)
  })
})
