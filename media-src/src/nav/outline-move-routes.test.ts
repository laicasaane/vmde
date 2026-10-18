import { describe, expect, it, vi } from 'vitest'
import type { WebviewMessage } from '../../../src/shared/protocol'
import { scanSourceHeadings } from '../../../src/shared/section-move'
import {
  createOutlineMoveRoutes,
  exactOutlineLabels,
  planOutlineMoveByIdentity,
} from './outline-move-routes'

// Task 630 (outline moves): both routes pull the host text with publish before they ask the host to
// plan, a prepare whose `before` differs from the owned exact text declines with a message that
// clears the host binding (and resolves the caller), and an applied move re-owns `after`.
const BEFORE = '# A\n\nalpha\n\n# B\n\nbeta\n'
const AFTER = '# B\n\nbeta\n\n# A\n\nalpha\n'

function setup(
  options: {
    exact?: string | null
    acquired?: { exact: string; rendered: string } | null
    live?: boolean
    recordable?: boolean
  } = {},
) {
  const log: string[] = []
  const posted: WebviewMessage[] = []
  let ids = 0
  const state = {
    exact: options.exact === undefined ? BEFORE : options.exact,
    acquired:
      options.acquired === undefined
        ? { exact: BEFORE, rendered: BEFORE }
        : options.acquired,
    live: options.live ?? true,
  }
  const deps = {
    acquire: vi.fn(async () => {
      log.push('acquire')
      return state.acquired
    }),
    snapshotExact: vi.fn(() => state.exact),
    editorLive: vi.fn(() => state.live),
    post: vi.fn((message: WebviewMessage) => {
      log.push(`post:${message.command}`)
      posted.push(message)
    }),
    newRequestId: vi.fn(() => `req-${++ids}`),
    applyLocal: vi.fn((after: string) => {
      log.push('applyLocal')
      return { after }
    }),
    recordApplied: vi.fn(() => {
      log.push('recordApplied')
      return options.recordable ?? true
    }),
    replaceContent: vi.fn((content: string) => {
      log.push(`replace:${content}`)
    }),
    reown: vi.fn((after: string) => {
      log.push(`reown:${after}`)
    }),
  }
  return { routes: createOutlineMoveRoutes(deps), deps, log, posted, state }
}

const request = {
  sourceIndex: 0,
  targetIndex: 1,
  placement: 'after' as const,
  rowLabels: ['A', 'B'],
}
const prepareMessage = (requestId: string, before = BEFORE) => ({
  command: 'prepare-outline-section-move' as const,
  requestId,
  uri: 'file:///doc.md',
  version: 3,
  before,
  after: AFTER,
})

describe('outline move (a): webview reorder', () => {
  it('acquires with publish before it posts the request, and posts nothing without authority', async () => {
    const { routes, log, posted, state } = setup()
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(log).toEqual(['acquire', 'post:request-outline-section-move'])
    expect(posted[0]).toEqual({
      command: 'request-outline-section-move',
      requestId: 'req-1',
      ...request,
    })
    expect(routes.pendingCount()).toBe(1)
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'req-1',
      status: 'noop',
    })
    await done

    state.acquired = null
    posted.length = 0
    await routes.requestByIndex(request) // resolves at once: no pending promise is left behind
    expect(posted).toEqual([])
    expect(routes.pendingCount()).toBe(0)
  })

  it('declines when the editor is gone after the wait', async () => {
    const { routes, posted, state } = setup()
    const done = routes.requestByIndex(request)
    state.live = false
    await done
    expect(posted).toEqual([])
  })

  it('mirrors the move locally and applies it when the owned text equals the host `before`', async () => {
    const { routes, log, posted } = setup()
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    routes.prepare(prepareMessage('req-1'))
    expect(posted[1]).toEqual({
      command: 'apply-outline-section-move',
      requestId: 'req-1',
      uri: 'file:///doc.md',
      version: 3,
      before: BEFORE,
      after: AFTER,
    })
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'req-1',
      status: 'applied',
      content: AFTER,
    })
    await done
    expect(log).toEqual([
      'acquire',
      'post:request-outline-section-move',
      'applyLocal',
      'post:apply-outline-section-move',
      'recordApplied',
      `reown:${AFTER}`,
    ])
    expect(routes.pendingCount()).toBe(0)
  })

  it('declines a `before` mismatch: clears the host binding, resolves, never sets the value', async () => {
    const { routes, deps, posted, state } = setup()
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    state.exact = 'typed meanwhile\n' // a trusted edit revoked the owned pair
    routes.prepare(prepareMessage('req-1'))
    await done // the pending promise resolved
    expect(posted[1]).toEqual({
      command: 'cancel-outline-section-move',
      requestId: 'req-1',
    })
    expect(deps.applyLocal).not.toHaveBeenCalled()
    expect(deps.replaceContent).not.toHaveBeenCalled()
    expect(deps.reown).not.toHaveBeenCalled()
    expect(routes.pendingCount()).toBe(0)
  })

  it('declines when no exact text is owned at all', async () => {
    const { routes, deps, posted, state } = setup()
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    state.exact = null
    routes.prepare(prepareMessage('req-1'))
    await done
    expect(posted[1]).toMatchObject({ command: 'cancel-outline-section-move' })
    expect(deps.applyLocal).not.toHaveBeenCalled()
  })

  it('ignores a prepare or an outcome for an unknown request', () => {
    const { routes, deps, posted } = setup()
    routes.prepare(prepareMessage('nope'))
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'nope',
      status: 'applied',
      content: AFTER,
    })
    expect(posted).toEqual([])
    expect(deps.replaceContent).not.toHaveBeenCalled()
  })

  it('a stale host outcome restores the host text and does not re-own', async () => {
    const { routes, deps, posted } = setup()
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'req-1',
      status: 'stale',
      content: 'host text\n',
    })
    await done
    expect(deps.replaceContent).toHaveBeenCalledWith('host text\n')
    expect(deps.reown).not.toHaveBeenCalled()
  })

  it('an applied move whose history cannot be recorded still lands the host text and re-owns', async () => {
    const { routes, deps, posted } = setup({ recordable: false })
    const done = routes.requestByIndex(request)
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    routes.prepare(prepareMessage('req-1'))
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'req-1',
      status: 'applied',
      content: AFTER,
    })
    await done
    expect(deps.replaceContent).toHaveBeenCalledWith(AFTER)
    expect(deps.reown).toHaveBeenCalledWith(AFTER)
  })
})

describe('outline move (b): native outline tree drag', () => {
  const headings = scanSourceHeadings(BEFORE)
  const [a, b] = headings

  it('maps host identities to indices and labels on the acquired exact text', () => {
    expect(planOutlineMoveByIdentity(BEFORE, a, b, 'before')).toEqual({
      sourceIndex: 0,
      targetIndex: 1,
      placement: 'before',
      rowLabels: ['A', 'B'],
    })
    expect(exactOutlineLabels(BEFORE)).toEqual(['A', 'B'])
  })

  it('refuses an identity that is not a heading of the acquired text', () => {
    expect(
      planOutlineMoveByIdentity(BEFORE, { start: 1, level: 1 }, b, 'before'),
    ).toBeNull()
    expect(
      planOutlineMoveByIdentity(
        BEFORE,
        a,
        { start: b.start, level: 2 },
        'after',
      ),
    ).toBeNull()
  })

  it('acquires with publish, plans on the acquired text, then runs the same handshake', async () => {
    // The host text changed by typing published at acquisition: offsets move with it.
    const typed = `intro\n\n${BEFORE}`
    const { routes, log, posted } = setup({
      exact: typed,
      acquired: { exact: typed, rendered: typed },
    })
    const [ta, tb] = scanSourceHeadings(typed)
    const done = routes.requestByIdentity(ta, tb, 'before')
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual({
      command: 'request-outline-section-move',
      requestId: 'req-1',
      sourceIndex: 0,
      targetIndex: 1,
      placement: 'before',
      rowLabels: ['A', 'B'],
    })
    routes.prepare(prepareMessage('req-1', typed))
    routes.finish({
      command: 'outline-section-move-outcome',
      requestId: 'req-1',
      status: 'applied',
      content: AFTER,
    })
    await done
    expect(log.slice(0, 2)).toEqual([
      'acquire',
      'post:request-outline-section-move',
    ])
    expect(log).toContain(`reown:${AFTER}`)
  })

  it('posts nothing when authority is missing or the drag no longer names headings', async () => {
    const none = setup({ acquired: null })
    await none.routes.requestByIdentity(a, b, 'before')
    expect(none.posted).toEqual([])

    const moved = setup()
    await moved.routes.requestByIdentity({ start: 2, level: 1 }, b, 'before')
    expect(moved.posted).toEqual([])
    expect(moved.routes.pendingCount()).toBe(0)
  })

  it('declines a stale prepare like route (a)', async () => {
    const { routes, deps, posted, state } = setup()
    const done = routes.requestByIdentity(a, b, 'after')
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    state.exact = `${BEFORE}extra\n`
    routes.prepare(prepareMessage('req-1'))
    await done
    expect(posted[1]).toEqual({
      command: 'cancel-outline-section-move',
      requestId: 'req-1',
    })
    expect(deps.applyLocal).not.toHaveBeenCalled()
  })
})
