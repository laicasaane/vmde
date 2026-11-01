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

// A heading identity as the host sends it for route (b): offset, level, label, heading index and
// the heading count of the host text (task 668).
function identityOf(text: string, index: number) {
  const headings = scanSourceHeadings(text)
  return {
    start: headings[index].start,
    level: headings[index].level,
    label: exactOutlineLabels(text)[index],
    index,
    count: headings.length,
  }
}

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
  const [a, b] = headings.map((_heading, index) => identityOf(BEFORE, index))

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
      planOutlineMoveByIdentity(
        BEFORE,
        { ...identityOf(BEFORE, 0), start: 1 },
        b,
        'before',
      ),
    ).toBeNull()
    expect(
      planOutlineMoveByIdentity(BEFORE, a, { ...b, level: 2 }, 'after'),
    ).toBeNull()
  })

  it('acquires with publish, plans on the acquired text, then runs the same handshake', async () => {
    // The host text changed by typing published at acquisition: offsets move with it.
    const typed = `intro\n\n${BEFORE}`
    const { routes, log, posted } = setup({
      exact: typed,
      acquired: { exact: typed, rendered: typed },
    })
    const [ta, tb] = [identityOf(typed, 0), identityOf(typed, 1)]
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
    await moved.routes.requestByIdentity(
      { ...identityOf(BEFORE, 0), start: 2 },
      b,
      'before',
    )
    expect(moved.posted).toEqual([])
    expect(moved.routes.pendingCount()).toBe(0)
  })

  // Task 668: the host names a heading by offset, level and label. Typing published at acquisition
  // can shift the offsets so that an old offset names another heading of the acquired text.
  describe('labels guard against offsets that moved with published typing (task 668)', () => {
    const section = (name: string, body: string) => `# ${name}\n\n${body}\n\n`
    const INTRO = 'intro\n\n'
    const DOCUMENT = `${section('A', 'a')}${section('B', 'b')}${section('C', 'c')}# D\n\nd\n`
    const hostText = `${INTRO}${DOCUMENT}`
    // Eight typed characters shift every heading by exactly one section (eight bytes).
    const shiftedText = `intro12345678\n\n${DOCUMENT}`
    const named = identityOf

    it('refuses an identity whose label differs on the acquired text', () => {
      const wrongLabel = { ...identityOf(BEFORE, 0), label: 'Other' }
      const target = identityOf(BEFORE, 1)
      expect(
        planOutlineMoveByIdentity(BEFORE, wrongLabel, target, 'before'),
      ).toBeNull()
      expect(
        planOutlineMoveByIdentity(
          BEFORE,
          identityOf(BEFORE, 0),
          { ...identityOf(BEFORE, 1), label: 'Other' },
          'before',
        ),
      ).toBeNull()
    })

    it('posts nothing when published typing moved the named headings', async () => {
      // Host offsets of D and B on the text before the typing: on the shifted text they name C and A.
      const source = named(hostText, 3)
      const target = named(hostText, 1)
      const { routes, posted } = setup({
        acquired: { exact: shiftedText, rendered: shiftedText },
      })
      // Not awaited: a request that was posted would wait for its outcome forever.
      void routes.requestByIdentity(source, target, 'before')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(posted).toEqual([])
      expect(routes.pendingCount()).toBe(0)
    })

    it('still plans the move when the typing did not touch the named headings', async () => {
      const typedAfter = hostText.replace('# D\n\nd', '# D\n\nd12345678')
      const { routes, posted } = setup({
        acquired: { exact: typedAfter, rendered: typedAfter },
      })
      void routes.requestByIdentity(
        named(hostText, 3),
        named(hostText, 1),
        'before',
      )
      await vi.waitFor(() => expect(posted).toHaveLength(1))
      expect(posted[0]).toMatchObject({
        command: 'request-outline-section-move',
        sourceIndex: 3,
        targetIndex: 1,
        placement: 'before',
      })
    })

    it('refuses same-label headings whose index moved with published typing', async () => {
      // Four equal sections: typing exactly one section length above them makes every old offset
      // name the previous section, with the same level and the same label.
      const days = '# Day\n\nx\n\n'.repeat(4)
      const before = `intro\n\n${days}`
      const shifted = `intro${'1'.repeat(10)}\n\n${days}`
      const { routes, posted } = setup({
        acquired: { exact: shifted, rendered: shifted },
      })
      void routes.requestByIdentity(
        identityOf(before, 3),
        identityOf(before, 1),
        'before',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(posted).toEqual([])
    })

    it('refuses an identity when the heading count differs on the acquired text', async () => {
      const before = `${BEFORE}\n# C\n\ngamma\n`
      const { routes, posted } = setup({
        acquired: { exact: BEFORE, rendered: BEFORE },
      })
      void routes.requestByIdentity(
        identityOf(before, 0),
        identityOf(before, 1),
        'before',
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(posted).toEqual([])
    })

    it('lets the offset decide between two headings with the same label', async () => {
      const twins = '# A\n\nx\n\n# A\n\ny\n'
      const { routes, posted } = setup({
        acquired: { exact: twins, rendered: twins },
      })
      void routes.requestByIdentity(named(twins, 1), named(twins, 0), 'before')
      await vi.waitFor(() => expect(posted).toHaveLength(1))
      expect(posted[0]).toMatchObject({ sourceIndex: 1, targetIndex: 0 })
    })
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
