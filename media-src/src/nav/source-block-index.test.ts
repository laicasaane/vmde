// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { BlockHandleUnit } from './block-handle'
import { applyCaretInside } from '../links/caret-link'
import { clearWrapHints, insertWrapHint } from '../util/wrap-hint-mark'
import { provideUnitFeed, type UnitFeed } from '../util/unit-changes'
import {
  createSourceBlockIndex,
  sameSourceBlockIndexKey,
  type SourceBlockIndexDeps,
} from './source-block-index'

afterEach(() => {
  provideUnitFeed(window, undefined)
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

// Task 700: a passive display read must not start the Task 607 acquire (its adoption advances the
// revision and forces a second build); a later acquiring read starts it once and counts no build.
it('readWhenReady with acquire false builds once and starts no acquire', () => {
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })

  let seen: unknown = 'unset'
  index.readWhenReady((entry) => (seen = entry), { acquire: false })

  expect((seen as { units: unknown }).units).toBeNull()
  expect(acquireExactAuthority).not.toHaveBeenCalled()
  expect(metrics.indexBuilds).toBe(1)
})

it('a default read on a passively cached key starts the acquire once and counts no build', () => {
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })

  const passive = index.read({ acquire: false })
  expect(acquireExactAuthority).not.toHaveBeenCalled()
  expect(index.read()).toBe(passive)
  expect(index.read()).toBe(passive)

  expect(acquireExactAuthority).toHaveBeenCalledOnce()
  expect(metrics.indexBuilds).toBe(1)
})

it('held builds with one passive and one default waiter give one build and one acquire', () => {
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })
  const release = index.holdBuilds()
  const passive = vi.fn()
  const normal = vi.fn()
  index.readWhenReady(passive, { acquire: false })
  index.readWhenReady(normal)
  release()

  expect(passive).toHaveBeenCalledOnce()
  expect(normal).toHaveBeenCalledOnce()
  expect(acquireExactAuthority).toHaveBeenCalledOnce()
  expect(metrics.indexBuilds).toBe(1)
})

it('held builds with only passive waiters start no acquire', () => {
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })
  const release = index.holdBuilds()
  index.readWhenReady(vi.fn(), { acquire: false })
  release()
  expect(acquireExactAuthority).not.toHaveBeenCalled()
})

// Task 700: consumers such as the block handle, find and the selection proof call `peek()` first.
// A peek that needs exact units must start the acquire a passive read skipped.
it('a default peek on a passively cached key starts the acquire once', () => {
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })

  const passive = index.read({ acquire: false })
  expect(index.peek()).toBe(passive)
  expect(index.peek()).toBe(passive)
  expect(index.read()).toBe(passive)

  expect(acquireExactAuthority).toHaveBeenCalledOnce()
  expect(metrics.indexBuilds).toBe(1)
})

it('a passive peek starts no acquire', () => {
  const acquireExactAuthority = vi.fn()
  const { index } = setup({
    snapshotPair: () => ({ exact: null, rendered: 'A\n\nB\n' }),
    acquireExactAuthority,
  })

  const passive = index.read({ acquire: false })
  expect(index.peek({ acquire: false })).toBe(passive)

  expect(acquireExactAuthority).not.toHaveBeenCalled()
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

// Task 733 / 005: model-backed entries.
function modelSetup(
  overrides: Partial<SourceBlockIndexDeps> = {},
  modelExact = `A\n\nB\n${'x'.repeat(5000)}`,
) {
  const base = setup()
  base.index.dispose()
  const paragraphs = Array.from(
    base.root.querySelectorAll('p'),
  ) as HTMLElement[]
  const modelUnits = [
    {
      element: paragraphs[0]!,
      start: 0,
      end: 6,
      kind: 'paragraph',
      movable: true,
      members: [paragraphs[0]!],
    },
    {
      element: paragraphs[1]!,
      start: 8,
      end: 9,
      kind: 'paragraph',
      movable: true,
      members: [paragraphs[1]!],
    },
  ] as BlockHandleUnit[]
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  const model = {
    current: { exact: modelExact, units: modelUnits } as
      | { exact: string; units: BlockHandleUnit[] }
      | undefined,
  }
  const modelUnitsFn = vi.fn(() => model.current)
  const onModelUnitsChanged = vi.fn((listener: () => void) => {
    listeners.add(listener)
    return () => {
      unsubscribe()
      listeners.delete(listener)
    }
  })
  const snapshotPair = vi.fn(() => ({
    exact: modelExact as string | null,
    rendered: 'R\n',
  }))
  const resolveUnits = vi.fn(() => base.state.units)
  const index = createSourceBlockIndex({
    getActiveRoot: () => base.state.root,
    projection: () => base.state.projection,
    snapshotPair,
    snapshotRevision: () => base.state.revision,
    resolveUnits,
    modelUnits: modelUnitsFn,
    onModelUnitsChanged,
    ...overrides,
  })
  const events: Array<[string, HTMLElement | null]> = []
  index.onInvalidate((reason, root) => events.push([reason, root]))
  return {
    ...base,
    index,
    model,
    modelUnitsFn,
    modelUnits,
    listeners,
    unsubscribe,
    snapshotPair,
    resolveUnits,
    events,
    onModelUnitsChanged,
  }
}

it('builds a model entry without snapshotting, resolving or acquiring', () => {
  const acquireExactAuthority = vi.fn(() => undefined)
  const { index, snapshotPair, resolveUnits, modelUnits } = modelSetup({
    acquireExactAuthority,
  })
  const metrics: { indexBuilds?: number } = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics

  const entry = index.read()

  expect(entry?.units).toEqual(modelUnits)
  expect(snapshotPair).not.toHaveBeenCalled()
  expect(resolveUnits).not.toHaveBeenCalled()
  expect(acquireExactAuthority).not.toHaveBeenCalled()
  expect(metrics.indexBuilds).toBe(1)
  expect(index.read()).toBe(entry)
  expect(metrics.indexBuilds).toBe(1)
})

it('reads exact and rendered from one lazy snapshot pair', () => {
  const { index, snapshotPair, modelUnits } = modelSetup()
  const entry = index.read()!

  expect(entry.rendered).toBe('R\n')
  expect(entry.exact).toBe(`A\n\nB\n${'x'.repeat(5000)}`)
  expect(entry.rendered).toBe('R\n')
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(entry.units).toEqual(modelUnits)
  expect(index.peek()).toBe(entry)
})

it('converts to the existing path content when the pair exact differs, without an event or key change', () => {
  const { index, snapshotPair, resolveUnits, state, events, root } =
    modelSetup()
  snapshotPair.mockReturnValue({ exact: 'A\r\n\r\nB\r\n', rendered: 'R\n' })
  const exact: BlockHandleUnit[] = []
  state.units = exact
  const slot = Symbol('memo')
  const entry = index.read()!
  const first = entry.memo(slot, () => ({}))
  const key = index.currentKey()

  expect(entry.exact).toBe('A\r\n\r\nB\r\n')
  expect(entry.rendered).toBe('R\n')
  expect(entry.units).toBe(exact)
  expect(resolveUnits).toHaveBeenCalledWith(root, 'A\r\n\r\nB\r\n', 'R\n')
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(entry.memo(slot, () => ({}))).not.toBe(first)
  expect(sameSourceBlockIndexKey(key, index.currentKey())).toBe(true)
  expect(index.peek()).toBe(entry)
  expect(events).toEqual([])
})

it('converts to null units and acquires when the edit-sync pair has no exact', () => {
  const acquireExactAuthority = vi.fn(() => undefined)
  const { index, snapshotPair } = modelSetup({ acquireExactAuthority })
  snapshotPair.mockReturnValue({ exact: null, rendered: 'R\n' })
  const entry = index.read()!

  expect(entry.units).toHaveLength(2)
  expect(entry.exact).toBe('')
  expect(entry.units).toBeNull()
  expect(acquireExactAuthority).toHaveBeenCalledOnce()
})

it('drops a converting entry when the snapshot moves the key', () => {
  const holder: { state?: { revision: object | undefined } } = {}
  const { index, snapshotPair, state } = modelSetup()
  holder.state = state
  snapshotPair.mockImplementation(() => {
    state.revision = {}
    return { exact: 'A\n\nB\n', rendered: 'R\n' }
  })
  const entry = index.read()!

  expect(entry.rendered).toBe('R\n')
  expect(index.peek()).toBeNull()
})

it('uses the existing path when the model has no value, is absent, or the mode is not ir', () => {
  const none = modelSetup()
  none.model.current = undefined
  none.index.read()
  expect(none.snapshotPair).toHaveBeenCalledOnce()
  expect(none.resolveUnits).toHaveBeenCalledOnce()

  const wys = modelSetup()
  wys.state.projection = { owner: wys.state.projection.owner, mode: 'wysiwyg' }
  wys.index.read()
  expect(wys.modelUnitsFn).not.toHaveBeenCalled()
  expect(wys.resolveUnits).toHaveBeenCalledOnce()

  const absent = setup()
  absent.index.read()
  expect(absent.resolveUnits).toHaveBeenCalledOnce()
})

it('uses the existing path when the first model unit is detached or outside the root', () => {
  const { index, model, resolveUnits, snapshotPair } = modelSetup()
  const outside = document.createElement('p')
  document.body.append(outside)
  model.current = {
    exact: 'x',
    units: [
      {
        element: outside,
        start: 0,
        end: 1,
        kind: 'paragraph',
        movable: true,
        members: [outside],
      },
    ],
  }
  index.read()
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(resolveUnits).toHaveBeenCalledOnce()
})

it('invalidates synchronously on a model change and emits one coalesced revision event', async () => {
  const { index, listeners, events, root } = modelSetup()
  const entry = index.read()
  const before = index.currentKey()

  for (const listener of listeners) {
    listener()
    listener()
  }

  expect(index.peek()).toBeNull()
  expect(sameSourceBlockIndexKey(before, index.currentKey())).toBe(false)
  expect(events).toEqual([])
  await Promise.resolve()
  expect(events).toEqual([['revision', root]])
  expect(index.read()).not.toBe(entry)
})

it('never throws from the model change listener', async () => {
  const { index, listeners } = modelSetup()
  index.onInvalidate(() => {
    throw new Error('listener failure')
  })
  index.read()
  const [listener] = Array.from(listeners)
  expect(() => listener!()).not.toThrow()
  await Promise.resolve()
  expect(index.peek()).toBeNull()
})

it('treats a throwing modelUnits as no model', () => {
  const { index, snapshotPair } = modelSetup({
    modelUnits: () => {
      throw new Error('model failure')
    },
  })
  expect(index.read()).not.toBeNull()
  expect(snapshotPair).toHaveBeenCalledOnce()
})

it('invalidates a model entry like any entry on DOM, revision and owner changes', () => {
  const { index, root, state, events } = modelSetup()
  const first = index.read()
  ;(root.querySelector('p')!.firstChild as Text).data = 'changed '
  expect(index.peek()).toBeNull()
  const second = index.read()
  expect(second).not.toBe(first)
  state.revision = {}
  expect(index.peek()).toBeNull()
  index.read()
  state.projection = { owner: {}, mode: 'ir' }
  expect(index.peek()).toBeNull()
  expect(events.map(([reason]) => reason)).toEqual([
    'dom',
    'revision',
    'authority',
  ])
})

it('keeps a model entry across an accepted source-neutral scope', async () => {
  const { index, root, snapshotPair } = modelSetup()
  const entry = index.read()
  index.sourceNeutral(() => {
    root.querySelector('p')!.append(document.createElement('span'))
  })
  await Promise.resolve()
  expect(index.peek()).toBe(entry)
  expect(snapshotPair).not.toHaveBeenCalled()
})

it('unsubscribes from the model on dispose and ignores a later change', async () => {
  const { index, unsubscribe, listeners, events } = modelSetup()
  const [listener] = Array.from(listeners)
  index.dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(() => listener?.()).not.toThrow()
  await Promise.resolve()
  expect(events).toEqual([])
})

it('takes rendered at build for a small model text and behaves as a built entry', () => {
  const { index, snapshotPair, modelUnits } = modelSetup({}, 'A\n\nB\n')
  const entry = index.read()!

  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(entry.rendered).toBe('R\n')
  expect(entry.units).toEqual(modelUnits)
  expect(snapshotPair).toHaveBeenCalledOnce()
})

it('never starts the exact-authority acquire for a model entry, on read or peek', () => {
  const acquireExactAuthority = vi.fn(() => undefined)
  const { index } = modelSetup({ acquireExactAuthority })
  index.read()
  index.peek()
  index.read({ acquire: false })
  expect(acquireExactAuthority).not.toHaveBeenCalled()
})

// Task 733 / 006: a read uses the model units only once they are confirmed. A read never publishes
// pending typing: it is a display consumer, and a flush from it ran inside an Undo transition.
function feedSetup(
  confirm: (ctx: ReturnType<typeof modelSetup>) => boolean,
  overrides: Partial<SourceBlockIndexDeps> = {},
) {
  const ctx = modelSetup(overrides)
  ctx.model.current = undefined
  const confirmNow = vi.fn(() => confirm(ctx))
  const feed: UnitFeed = {
    root: ctx.root,
    isLive: () => true,
    liveUnitOf: () => undefined,
    liveUnits: () => [],
    onUnitsChanged: () => () => undefined,
    confirmNow,
    confirmedLines: () => undefined,
  }
  provideUnitFeed(window, feed)
  return { ...ctx, feed, confirmNow }
}

// What the session's notify does after a successful publish: units appear, listeners run.
const publishUnits = (ctx: ReturnType<typeof modelSetup>) => {
  // A long text keeps the entry lazy, as in `modelSetup`, so no snapshot is taken at build.
  ctx.model.current = {
    exact: `A\n\nB\n${'x'.repeat(5000)}`,
    units: ctx.modelUnits,
  }
  for (const listener of Array.from(ctx.listeners)) listener()
  return true
}

it('never publishes pending typing on a miss and takes the snapshot path', () => {
  const { index, snapshotPair, confirmNow } = feedSetup(publishUnits)
  index.read()

  expect(confirmNow).not.toHaveBeenCalled()
  expect(snapshotPair).toHaveBeenCalledTimes(1)
  index.dispose()
})

it('builds the model entry once the units are confirmed by their own publication', () => {
  const ctx = feedSetup(publishUnits)
  ctx.index.read()
  expect(ctx.snapshotPair).toHaveBeenCalledTimes(1)

  // The session publishes on its own debounce; its listener drops the cached entry.
  publishUnits(ctx)
  const entry = ctx.index.read()
  expect(entry?.units).toEqual(ctx.modelUnits)
  expect(ctx.snapshotPair).toHaveBeenCalledTimes(1)
  expect(ctx.confirmNow).not.toHaveBeenCalled()
  ctx.index.dispose()
})

// Task 733 (Q-61): a hover read while the units are unconfirmed takes no snapshot.
it('a deferred hover read returns an entry with no units and takes no snapshot while units are unconfirmed', () => {
  const ctx = feedSetup(publishUnits)
  const entry = ctx.index.read({ deferUnconfirmed: true })

  expect(entry).not.toBeNull()
  expect(entry?.units).toBeNull()
  expect(ctx.snapshotPair).not.toHaveBeenCalled()
  expect(ctx.confirmNow).not.toHaveBeenCalled()
  // The model's change drops the cache; the next hover read builds the real entry.
  publishUnits(ctx)
  expect(ctx.index.read({ deferUnconfirmed: true })?.units).toEqual(
    ctx.modelUnits,
  )
  expect(ctx.snapshotPair).not.toHaveBeenCalled()
  ctx.index.dispose()
})

it('a deferred hover read keeps the last entry of the root while units are unconfirmed', () => {
  const ctx = feedSetup(publishUnits)
  publishUnits(ctx)
  const built = ctx.index.read()
  // Typing makes the units unconfirmed again and invalidates the entry.
  ctx.model.current = undefined
  for (const listener of Array.from(ctx.listeners)) listener()
  expect(ctx.index.read({ deferUnconfirmed: true })).toBe(built)
  expect(ctx.snapshotPair).not.toHaveBeenCalled()
  ctx.index.dispose()
})

it('a deferred hover read outside a live feed takes the snapshot path as before', () => {
  const ctx = feedSetup(publishUnits)
  provideUnitFeed(window, { ...ctx.feed, isLive: () => false })
  ctx.index.read({ deferUnconfirmed: true })
  expect(ctx.snapshotPair).toHaveBeenCalledTimes(1)
  ctx.index.dispose()
})

it('does not confirm when the model is not live', () => {
  const ctx = feedSetup(publishUnits)
  provideUnitFeed(window, { ...ctx.feed, isLive: () => false })
  ctx.index.read()
  expect(ctx.confirmNow).not.toHaveBeenCalled()
  expect(ctx.snapshotPair).toHaveBeenCalledTimes(1)
  ctx.index.dispose()
})

it('does not confirm when the model units exist but are not usable', () => {
  const ctx = feedSetup(publishUnits)
  // Units exist, but the first one is outside the root: not an "unconfirmed" miss.
  ctx.model.current = {
    exact: 'A\n',
    units: [{ ...ctx.modelUnits[0]!, element: document.createElement('p') }],
  }
  ctx.index.read()
  expect(ctx.confirmNow).not.toHaveBeenCalled()
  ctx.index.dispose()
})

it('does not confirm for a foreign feed root, a missing feed or wysiwyg', () => {
  const foreign = feedSetup(publishUnits)
  provideUnitFeed(window, {
    ...foreign.feed,
    root: document.createElement('div'),
  })
  foreign.index.read()
  expect(foreign.confirmNow).not.toHaveBeenCalled()
  expect(foreign.snapshotPair).toHaveBeenCalledTimes(1)
  foreign.index.dispose()

  const none = feedSetup(publishUnits)
  provideUnitFeed(window, undefined)
  none.index.read()
  expect(none.confirmNow).not.toHaveBeenCalled()
  expect(none.snapshotPair).toHaveBeenCalledTimes(1)
  none.index.dispose()

  const wys = feedSetup(publishUnits)
  wys.state.projection.mode = 'wysiwyg'
  wys.index.read()
  expect(wys.confirmNow).not.toHaveBeenCalled()
  wys.index.dispose()
})

it('does not confirm inside a source-neutral scope', () => {
  const { index, confirmNow } = feedSetup(publishUnits)
  index.sourceNeutral(() => index.read())

  expect(confirmNow).not.toHaveBeenCalled()
  index.dispose()
})
