// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createFindSourceTracker } from './find-source'

afterEach(() => document.body.replaceChildren())

const OPTIONS = { caseSensitive: false, wholeWord: false }

function setup(mode: 'ir' | 'wysiwyg' | 'sv' = 'ir') {
  document.body.innerHTML = '<div class="vditor-reset"><p>alpha beta</p></div>'
  const root = document.querySelector('.vditor-reset') as HTMLElement
  const state = {
    mode: mode as string,
    revision: {} as object | undefined,
    exact: 'alpha  beta alpha\n',
  }
  const snapshotPair = vi.fn(() => ({
    exact: state.exact,
    rendered: 'alpha beta alpha\n',
  }))
  const index = createSourceBlockIndex({
    getActiveRoot: () => (state.mode === 'sv' ? null : root),
    projection: () =>
      state.mode === 'sv'
        ? null
        : { owner: root, mode: state.mode as 'ir' | 'wysiwyg' },
    snapshotPair,
    snapshotRevision: () => state.revision,
    resolveUnits: () => [],
  })
  const tracker = createFindSourceTracker({
    index,
    mode: () => state.mode,
    root: () => root,
    snapshotPair,
    snapshotRevision: () => state.revision,
  })
  return { root, state, snapshotPair, index, tracker }
}

it('searches the exact bytes and reuses one index build across query keystrokes and toggles', () => {
  const { tracker, snapshotPair } = setup()

  const first = tracker.find('a', OPTIONS)
  tracker.find('al', OPTIONS)
  tracker.find('alp', { caseSensitive: true, wholeWord: false })
  const last = tracker.find('alpha', { caseSensitive: false, wholeWord: true })

  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(first?.source.entry).not.toBeNull()
  expect(last?.matches.map(({ start, end }) => [start, end])).toEqual([
    [0, 5],
    [12, 17],
  ])
  expect(tracker.find('alpha', { caseSensitive: false, wholeWord: true })).toBe(
    last,
  )
})

it('rejects a result from an older revision and rebuilds once for the new one', () => {
  const { tracker, state, snapshotPair } = setup('wysiwyg')
  const before = tracker.find('beta', OPTIONS)
  expect(tracker.isCurrent(before)).toBe(true)

  state.revision = {}
  state.exact = 'beta\n'

  expect(tracker.isCurrent(before)).toBe(false)
  const after = tracker.find('beta', OPTIONS)
  expect(after?.matches.map(({ start }) => start)).toEqual([0])
  expect(tracker.isCurrent(after)).toBe(true)
  expect(snapshotPair).toHaveBeenCalledTimes(2)
})

it('rebuilds after an editor DOM change on the same revision', () => {
  const { tracker, root, snapshotPair } = setup()
  const before = tracker.find('alpha', OPTIONS)

  root.querySelector('p')!.textContent = 'changed'

  expect(tracker.isCurrent(before)).toBe(false)
  tracker.find('alpha', OPTIONS)
  expect(snapshotPair).toHaveBeenCalledTimes(2)
})

it('snapshots SV once per source revision and never reuses it across revisions', () => {
  const { tracker, state, snapshotPair } = setup('sv')

  const first = tracker.find('alpha', OPTIONS)
  tracker.find('beta', OPTIONS)
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(first?.source.entry).toBeNull()
  expect(first?.source.mode).toBe('sv')

  state.revision = {}
  expect(tracker.isCurrent(first)).toBe(false)
  tracker.find('alpha', OPTIONS)
  expect(snapshotPair).toHaveBeenCalledTimes(2)
})

it('snapshots on every request when no revision authority exists', () => {
  const { tracker, state, snapshotPair } = setup('sv')
  state.revision = undefined

  const first = tracker.find('alpha', OPTIONS)
  expect(tracker.isCurrent(first)).toBe(false)
  tracker.find('alpha', OPTIONS)

  expect(snapshotPair).toHaveBeenCalledTimes(2)
})

it('has no source without an active root or a known mode', () => {
  const { tracker, state } = setup()
  state.mode = 'preview'

  expect(tracker.source(true)).toBeNull()
  expect(tracker.find('alpha', OPTIONS)).toBeNull()
})
