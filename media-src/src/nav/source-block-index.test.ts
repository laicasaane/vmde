// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { BlockHandleUnit } from './block-handle'
import { applyCaretInside } from '../links/caret-link'
import { clearWrapHints, insertWrapHint } from '../util/wrap-hint-mark'
import {
  createSourceBlockIndex,
  sameSourceBlockIndexKey,
  type SourceBlockIndexDeps,
} from './source-block-index'

afterEach(() => {
  document.body.replaceChildren()
  delete (window as any).__vmdeBlockHandleCacheMetrics
})

function setup(overrides: Partial<SourceBlockIndexDeps> = {}) {
  document.body.innerHTML =
    '<div class="vditor-reset"><p data-block="0">A <a href="a.md">link</a></p><p data-block="0">B</p></div>'
  const root = document.querySelector('.vditor-reset') as HTMLElement
  const state = {
    root: root as HTMLElement | null,
    projection: { owner: {} as object, mode: 'ir' as 'ir' | 'wysiwyg' },
    revision: {} as object | undefined,
    units: [] as BlockHandleUnit[] | null,
  }
  const snapshotPair = vi.fn(() => ({
    exact: 'A\n\nB\n',
    rendered: 'A\n\nB\n',
  }))
  const resolveUnits = vi.fn(() => state.units)
  const deps: SourceBlockIndexDeps = {
    getActiveRoot: () => state.root,
    projection: () => state.projection,
    snapshotPair,
    snapshotRevision: () => state.revision,
    resolveUnits,
    ...overrides,
  }
  const index = createSourceBlockIndex(deps)
  const events: Array<[string, HTMLElement | null]> = []
  index.onInvalidate((reason, invalidatedRoot) => {
    events.push([reason, invalidatedRoot])
  })
  return { root, state, snapshotPair, resolveUnits, index, events }
}

it('builds once for 30 reads of an unchanged key and memoizes derived values per entry', () => {
  const { index, snapshotPair, resolveUnits } = setup()
  const slot = Symbol('test')
  const derive = vi.fn(() => ({ derived: true }))

  const first = index.read()
  for (let i = 0; i < 29; i++) expect(index.read()).toBe(first)

  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(resolveUnits).toHaveBeenCalledOnce()
  expect(first?.exact).toBe('A\n\nB\n')
  expect(first?.memo(slot, derive)).toBe(first?.memo(slot, derive))
  expect(derive).toHaveBeenCalledOnce()
})

it('caches a rejected (null-unit) resolution under its key', () => {
  const { index, state, resolveUnits } = setup()
  state.units = null

  expect(index.read()?.units).toBeNull()
  expect(index.read()?.units).toBeNull()
  expect(resolveUnits).toHaveBeenCalledOnce()
})

it('keeps the warm entry when the caret enters and leaves a link', async () => {
  const { index, root, snapshotPair, events } = setup()
  const entry = index.read()
  applyCaretInside(root, root.querySelector('a'))
  expect(index.read()).toBe(entry)
  applyCaretInside(root, null)
  await Promise.resolve()
  expect(index.read()).toBe(entry)
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(events).toEqual([])
  index.dispose()
})

it('peek never snapshots and returns only a warm entry for the current key', () => {
  const { index, snapshotPair } = setup()

  expect(index.peek()).toBeNull()
  expect(snapshotPair).not.toHaveBeenCalled()
  const built = index.read()
  expect(index.peek()).toBe(built)
  expect(snapshotPair).toHaveBeenCalledOnce()
})

it('rebuilds after a live text edit drained before observer delivery', () => {
  const { index, root, snapshotPair, events } = setup()
  const before = index.read()
  const keyBefore = index.currentKey()

  const text = root.querySelector('p')!.firstChild as Text
  text.data = 'changed '

  expect(index.peek()).toBeNull()
  expect(sameSourceBlockIndexKey(keyBefore, index.currentKey())).toBe(false)
  expect(index.read()).not.toBe(before)
  expect(snapshotPair).toHaveBeenCalledTimes(2)
  expect(events).toContainEqual(['dom', root])
})

it('rebuilds after link href and image src changes but not presentation attributes', () => {
  const { index, root, snapshotPair } = setup()
  index.read()
  const paragraph = root.querySelector('p') as HTMLElement

  paragraph.setAttribute('class', 'vditor-ir__node--expand')
  paragraph.setAttribute('style', 'color: red')
  paragraph.setAttribute('aria-expanded', 'true')
  paragraph.setAttribute('data-vmde-foldable', 'true')
  paragraph.setAttribute('data-vmde-list-foldable', 'true')
  index.read()
  expect(snapshotPair).toHaveBeenCalledOnce()

  root.querySelector('a')!.setAttribute('href', 'b.md')
  index.read()
  expect(snapshotPair).toHaveBeenCalledTimes(2)

  const image = document.createElement('img')
  paragraph.append(image)
  index.read()
  image.setAttribute('src', 'data:image/png;base64,AA==')
  index.read()
  expect(snapshotPair).toHaveBeenCalledTimes(4)
})

it('rebuilds when the source revision changes with identical DOM', () => {
  const { index, state, snapshotPair, events, root } = setup()
  index.read()

  state.revision = {}

  expect(index.peek()).toBeNull()
  index.read()
  expect(snapshotPair).toHaveBeenCalledTimes(2)
  expect(events).toEqual([['revision', root]])
})

it('caches under the post-snapshot key when the snapshot revokes exact authority', () => {
  const next = {}
  const holder: { state?: { revision: object | undefined } } = {}
  const snapshotPair = vi.fn(() => {
    if (holder.state) holder.state.revision = next
    return { exact: 'A\n', rendered: 'A\n' }
  })
  const { index, state } = setup({ snapshotPair })
  holder.state = state

  const built = index.read()

  expect(built?.key.revision).toBe(next)
  expect(index.read()).toBe(built)
  expect(snapshotPair).toHaveBeenCalledOnce()
})

it('fires authority invalidation for root, owner and mode changes', () => {
  const { index, state, root, events } = setup()
  index.read()

  state.projection = { owner: state.projection.owner, mode: 'wysiwyg' }
  index.currentKey()
  state.projection = { owner: {}, mode: 'wysiwyg' }
  index.currentKey()
  const other = document.createElement('div')
  document.body.append(other)
  state.root = other
  index.currentKey()

  expect(events.filter(([reason]) => reason === 'authority')).toEqual([
    ['authority', root],
    ['authority', root],
    ['authority', root],
  ])
  // Unbinding the old root also reports its DOM authority as ended.
  expect(events).toContainEqual(['dom', root])
})

it('has no key without a revision or projection and never builds then', () => {
  const { index, state, snapshotPair } = setup()
  state.revision = undefined
  expect(index.currentKey()).toBeNull()
  expect(index.read()).toBeNull()
  state.revision = {}
  state.projection = null as never
  expect(index.read()).toBeNull()
  expect(snapshotPair).not.toHaveBeenCalled()
})

it('counts builds on the opt-in metrics object only', () => {
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const { index, state } = setup()

  index.read()
  index.read()
  state.revision = {}
  index.read()

  expect(metrics.indexBuilds).toBe(2)
})

it('disconnects the observer and stops reporting after disposal', () => {
  const { index, root, events } = setup()
  index.read()

  index.dispose()
  root.querySelector('p')!.textContent = 'after dispose'

  expect(index.currentKey()).toBeNull()
  expect(index.read()).toBeNull()
  expect(events).toEqual([])
})

it('serves readWhenReady synchronously when no hold is active', () => {
  const { index, snapshotPair } = setup()
  const callback = vi.fn()

  index.readWhenReady(callback)

  expect(callback).toHaveBeenCalledOnce()
  expect(callback.mock.calls[0][0]).toBe(index.peek())
  expect(snapshotPair).toHaveBeenCalledOnce()
})

it('defers held reads until the last hold is released and builds once for every waiter', () => {
  const { index, snapshotPair } = setup()
  const releaseFirst = index.holdBuilds()
  const releaseSecond = index.holdBuilds()
  const first = vi.fn()
  const second = vi.fn()

  index.readWhenReady(first)
  index.readWhenReady(second)
  releaseFirst()
  releaseFirst()
  expect(first).not.toHaveBeenCalled()
  expect(snapshotPair).not.toHaveBeenCalled()

  releaseSecond()

  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(first).toHaveBeenCalledOnce()
  expect(second.mock.calls[0][0]).toBe(first.mock.calls[0][0])
  expect(first.mock.calls[0][0]).toBe(index.peek())
})

it('drops a canceled held read and builds nothing when no waiter remains', () => {
  const { index, snapshotPair } = setup()
  const release = index.holdBuilds()
  const callback = vi.fn()

  const cancel = index.readWhenReady(callback)
  cancel()
  release()

  expect(callback).not.toHaveBeenCalled()
  expect(snapshotPair).not.toHaveBeenCalled()
})

it('passes null to held waiters when the released key is not cacheable', () => {
  const { index, state, snapshotPair } = setup()
  const release = index.holdBuilds()
  const callback = vi.fn()
  index.readWhenReady(callback)
  state.revision = undefined

  release()

  expect(callback).toHaveBeenCalledWith(null)
  expect(snapshotPair).not.toHaveBeenCalled()
})

it('drops holds and waiters on disposal', () => {
  const { index, snapshotPair } = setup()
  const release = index.holdBuilds()
  const callback = vi.fn()
  index.readWhenReady(callback)

  index.dispose()
  release()
  index.holdBuilds()()
  index.readWhenReady(callback)()

  expect(callback).not.toHaveBeenCalled()
  expect(snapshotPair).not.toHaveBeenCalled()
})

// Task 607: without an owned exact source the index fails closed (no units) and starts one
// background exact-authority request per key, never one per read.
it('fails closed on a null exact and starts one background acquire per key', () => {
  const acquireExactAuthority = vi.fn()
  const { index, state, resolveUnits } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })

  expect(index.read()?.units).toBeNull()
  expect(index.read()?.units).toBeNull()
  expect(resolveUnits).not.toHaveBeenCalled()
  expect(acquireExactAuthority).toHaveBeenCalledOnce()

  state.revision = {}
  expect(index.read()?.units).toBeNull()
  expect(acquireExactAuthority).toHaveBeenCalledTimes(2)
})

// Task 607 decision 1: the display gap ends with the background acquire. An adopted reply (which
// advances the revision) is announced as a revision invalidation without another read; a reply
// that was not adopted announces nothing, so consumers stay fail closed.
it('announces an adopted background acquire as a revision invalidation', async () => {
  let settle!: (reply: { exact: string; rendered: string } | null) => void
  const { index, state, events } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })
  const root = state.root

  expect(index.read()?.units).toBeNull()
  state.revision = {}
  settle({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' })
  await Promise.resolve()
  await Promise.resolve()

  expect(events).toEqual([['revision', root]])
})

it('announces nothing when the background acquire is not adopted', async () => {
  let settle!: (reply: null) => void
  const { index, state, events } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  })

  expect(index.read()?.units).toBeNull()
  // Another revision change waits for the next read; a refused reply does not announce it.
  state.revision = {}
  settle(null)
  await Promise.resolve()
  await Promise.resolve()

  expect(events).toEqual([])
})

// Task 610: a caller that owns its own DOM-write proof marks the write source-neutral. The
// index stays generic: it only keeps the entry when the scope ran cleanly and `accept` agrees.
// Each case maps to the contract list in the task record (Part 1 handoff, contract 1).
it('keeps the entry, the key and the build count across a source-neutral scope', async () => {
  const { index, root, snapshotPair, events } = setup()
  const entry = index.read()
  const before = index.currentKey()

  const result = index.sourceNeutral(() => {
    root.querySelector('p')!.append(document.createElement('span'))
    return 'ran'
  })
  // The observer would deliver any record the scope left behind in this microtask.
  await Promise.resolve()

  expect(result).toBe('ran')
  expect(index.peek()).toBe(entry)
  expect(index.currentKey()?.domRevision).toBe(before?.domRevision)
  expect(index.read()).toBe(entry)
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(events).toEqual([])
  index.dispose()
})

it('still invalidates for an edit made before the scope and for one made after it', async () => {
  const { index, root, snapshotPair } = setup()
  const first = index.read()
  const revision = index.currentKey()!.domRevision
  ;(root.querySelector('p')!.firstChild as Text).data = 'changed '

  index.sourceNeutral(() => undefined)
  await Promise.resolve()

  expect(index.peek()).toBeNull()
  expect(index.currentKey()!.domRevision).toBeGreaterThan(revision)
  const second = index.read()
  expect(second).not.toBe(first)

  index.sourceNeutral(() => undefined)
  ;(root.querySelector('p')!.firstChild as Text).data = 'again '
  expect(index.peek()).toBeNull()
  expect(snapshotPair).toHaveBeenCalledTimes(2)
})

it('invalidates a mixed scope when accept rejects its records', async () => {
  const { index, root, events } = setup()
  index.read()
  const accept = vi.fn((records: MutationRecord[]) =>
    records.every((record) => record.type === 'childList'),
  )

  index.sourceNeutral(() => {
    const paragraph = root.querySelector('p')!
    paragraph.append(document.createElement('span'))
    ;(paragraph.firstChild as Text).data = 'real edit '
  }, accept)
  await Promise.resolve()

  expect(accept).toHaveBeenCalledOnce()
  expect(accept.mock.calls[0][0].length).toBeGreaterThan(0)
  expect(index.peek()).toBeNull()
  expect(events).toContainEqual(['dom', root])
})

it('invalidates and rethrows when the scope throws', async () => {
  const { index, root } = setup()
  index.read()

  expect(() =>
    index.sourceNeutral(() => {
      root.querySelector('p')!.append(document.createElement('span'))
      throw new Error('scope failed')
    }),
  ).toThrow('scope failed')
  await Promise.resolve()

  expect(index.peek()).toBeNull()
})

it('lets an outer scope own the records of nested scopes and of key reads inside it', async () => {
  const { index, root, snapshotPair } = setup()
  const entry = index.read()
  const revision = index.currentKey()!.domRevision

  index.sourceNeutral(() => {
    index.sourceNeutral(() => {
      root.querySelector('p')!.append(document.createElement('span'))
    })
    // A key read inside the scope must not invalidate on the scope's own records.
    expect(index.currentKey()!.domRevision).toBe(revision)
    expect(index.peek()).toBe(entry)
  })
  await Promise.resolve()
  expect(index.peek()).toBe(entry)
  expect(snapshotPair).toHaveBeenCalledOnce()

  // A rejecting inner scope, or a throwing one that the outer scope swallows, invalidates it all.
  index.sourceNeutral(() => {
    index.sourceNeutral(
      () => root.querySelector('p')!.append(document.createElement('i')),
      () => false,
    )
  })
  expect(index.peek()).toBeNull()
  index.read()
  index.sourceNeutral(() => {
    try {
      index.sourceNeutral(() => {
        root.querySelector('p')!.append(document.createElement('b'))
        throw new Error('inner failed')
      })
    } catch {
      // The outer scope continues after the inner failure.
    }
  })
  expect(index.peek()).toBeNull()
})

it('treats an accept callback that throws as a rejection', () => {
  const { index, root } = setup()
  index.read()

  index.sourceNeutral(
    () => root.querySelector('p')!.append(document.createElement('span')),
    () => {
      throw new Error('accept failed')
    },
  )

  expect(index.peek()).toBeNull()
})

// Task 640 S2b: a wrap hint is view state. The engine's own writes (the split of a Text node, the
// hint span, their removal) must not drop the warm entry or advance `domRevision`, while a real
// edit still does, also when it shares the batch with a hint write.
it('keeps the entry and domRevision across a wrap-hint write and its removal (Task 640 go condition 1)', async () => {
  const { index, root, snapshotPair, events } = setup()
  root
    .querySelector('p')!
    .insertAdjacentHTML('beforeend', '<code>aaaa/bbbb/cccc</code>')
  await Promise.resolve()
  const entry = index.read()
  const before = index.currentKey()
  events.length = 0
  const code = root.querySelector('code')!

  insertWrapHint(code.firstChild as Text, 10)
  insertWrapHint(code.firstChild as Text, 5)
  await Promise.resolve()
  expect(index.peek()).toBe(entry)
  expect(index.currentKey()?.domRevision).toBe(before?.domRevision)

  clearWrapHints(code)
  await Promise.resolve()
  expect(index.peek()).toBe(entry)
  expect(index.read()).toBe(entry)
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(events).toEqual([])
  index.dispose()
})

it('still invalidates for a real edit that shares the batch with a wrap-hint write', async () => {
  const { index, root, snapshotPair } = setup()
  root
    .querySelector('p')!
    .insertAdjacentHTML('beforeend', '<code>aaaa/bbbb/cccc</code>')
  await Promise.resolve()
  index.read()
  const code = root.querySelector('code')!

  insertWrapHint(code.firstChild as Text, 5)
  ;(root.querySelectorAll('p')[1].firstChild as Text).data = 'B edited'
  await Promise.resolve()

  expect(index.peek()).toBeNull()
  index.read()
  expect(snapshotPair).toHaveBeenCalledTimes(2)
  index.dispose()
})

it('invalidates when the user edits the text next to a hint', async () => {
  const { index, root } = setup()
  root
    .querySelector('p')!
    .insertAdjacentHTML('beforeend', '<code>aaaa/bbbb/cccc</code>')
  await Promise.resolve()
  const code = root.querySelector('code')!
  insertWrapHint(code.firstChild as Text, 5)
  await Promise.resolve()
  index.read()
  ;(code.lastChild as Text).appendData('X')
  await Promise.resolve()
  expect(index.peek()).toBeNull()
  index.dispose()
})
