import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../util/webview-log', () => ({ reportError: h.reportError }))

import { answerFlushForSave } from './save-flush'

describe('answerFlushForSave (Task 580 CP2-12 will-save flush)', () => {
  beforeEach(() => h.reportError.mockReset())

  it('runs the flush, then replies with the same request id', () => {
    const order: string[] = []
    const post = vi.fn(() => order.push('reply'))
    answerFlushForSave('save-flush-7', () => order.push('flush'), post)
    expect(order).toEqual(['flush', 'reply'])
    expect(post).toHaveBeenCalledWith({
      command: 'flush-for-save-done',
      requestId: 'save-flush-7',
    })
  })

  it('posts an edit the flush produces before the reply', () => {
    const posted: string[] = []
    answerFlushForSave(
      'r1',
      () => posted.push('edit'),
      (reply) => posted.push(reply.command),
    )
    expect(posted).toEqual(['edit', 'flush-for-save-done'])
  })

  it('replies when there is no editor yet (nothing to flush)', () => {
    const post = vi.fn()
    answerFlushForSave('r2', undefined, post)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({
      command: 'flush-for-save-done',
      requestId: 'r2',
    })
  })

  it('replies and reports the error when the flush throws', () => {
    const post = vi.fn()
    const error = new Error('serialize failed')
    expect(() =>
      answerFlushForSave(
        'r3',
        () => {
          throw error
        },
        post,
      ),
    ).not.toThrow()
    expect(h.reportError).toHaveBeenCalledWith(error, 'flush-for-save')
    expect(post).toHaveBeenCalledWith({
      command: 'flush-for-save-done',
      requestId: 'r3',
    })
  })

  it('exposes no keyboard watch: the will-save request is the only trigger', async () => {
    // Task 580 CP2-12 removed setupSaveFlushKeybind/isSaveShortcut (a remapped Save missed them).
    const mod = await import('./save-flush')
    expect(Object.keys(mod)).toEqual(['answerFlushForSave'])
  })
})
