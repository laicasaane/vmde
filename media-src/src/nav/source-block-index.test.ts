// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { BlockHandleUnit } from './block-handle'
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
