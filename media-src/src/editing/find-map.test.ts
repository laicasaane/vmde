// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { resolveBlockHandleUnits } from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { findMarkdownMatches } from './find-engine'
import { findMapperFor } from './find-map'
import { createFindSourceTracker } from './find-source'

// Task 196 Checkpoint 3: exact-source matches map onto real Lute IR/WYSIWYG DOM one block at a
// time. The table rows are unpadded (`|a|b|`), so Vditor's serialization differs from the exact
// bytes there, as it does on the large fixture.
const SOURCE = [
  'Intro findme and **findme bold** here',
  '',
  '- findme item',
  '  - nested findme',
  '',
  '|findme|b|',
  '|---|---|',
  '|x|findme|',
  '',
  '```txt',
  'code findme line',
  '```',
  '',
  'Emoji 😀findme tail',
  '',
].join('\n')

let lutes: Record<'ir' | 'wysiwyg', RealLute>
beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as any).vditor
})

function mount(mode: 'ir' | 'wysiwyg', source = SOURCE) {
  const real = lutes[mode]
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = real.render(source)
  document.body.append(root)
  ;(window as any).vditor = {
    vditor: { currentMode: mode, lute: real.lute, [mode]: { element: root } },
  }
  const revision = {}
  const pair = () => ({
    exact: source,
    rendered: real.serialize(root.innerHTML),
  })
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: () => ({ owner: real.lute, mode }),
    snapshotPair: pair,
    snapshotRevision: () => revision,
    resolveUnits: (target, exact, rendered) =>
      resolveBlockHandleUnits(target, exact, rendered, {
        owner: real.lute,
        mode,
        render: real.render,
        serialize: real.serialize,
      }),
  })
  const tracker = createFindSourceTracker({
    index,
    mode: () => mode,
    root: () => root,
    snapshotPair: pair,
    snapshotRevision: () => revision,
  })
  return { root, index, tracker }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  it(`${mode}: maps prose, inline, nested list, table and fenced matches to their own text`, () => {
    const { tracker, root } = mount(mode)
    const result = tracker.find('findme', {
      caseSensitive: true,
      wholeWord: false,
    })!
    expect(result.source.entry?.units?.length).toBeGreaterThan(0)
    expect(result.source.exact === SOURCE).toBe(true)
    const mapper = findMapperFor(result.source)
    const ranges = result.matches.map((match) => mapper.range(match))
    expect(ranges.every((range) => range?.toString() === 'findme')).toBe(true)
    expect(ranges.every((range) => root.contains(range!.startContainer))).toBe(
      true,
    )
    const owner = (index: number) =>
      (ranges[index]!.startContainer.parentElement as HTMLElement).closest(
        'strong, li, td, th, pre, p',
      )?.tagName
    expect(result.matches).toHaveLength(8)
    expect(owner(1)).toBe('STRONG')
    expect(owner(2)).toBe('LI')
    expect(owner(3)).toBe('LI')
    expect([owner(4), owner(5)].sort()).toEqual(['TD', 'TH'])
    expect(owner(6)).toBe('PRE')
    expect(owner(7)).toBe('P')
    expect(ranges[7]!.startContainer.textContent?.includes('😀findme')).toBe(
      true,
    )
  })

  it(`${mode}: reports matches inside normalized table syntax as unmappable`, () => {
    const { tracker } = mount(mode)
    const result = tracker.find('|---|', {
      caseSensitive: true,
      wholeWord: false,
    })!
    expect(result.matches).toHaveLength(1)
    expect(findMapperFor(result.source).range(result.matches[0])).toBeNull()
  })
}

it('reuses one mapper per source and fails closed for a stale source', () => {
  const { tracker, root } = mount('ir')
  const first = tracker.find('findme', {
    caseSensitive: true,
    wholeWord: false,
  })!
  const mapper = findMapperFor(first.source)
  expect(findMapperFor(first.source)).toBe(mapper)
  const staleRange = mapper.range(first.matches[0])!
  expect(staleRange.toString()).toBe('findme')

  // A rebuilt block detaches the old text nodes: the old mapper can no longer return a range.
  const paragraph = staleRange.startContainer.parentElement!.closest('p')!
  paragraph.replaceWith(paragraph.cloneNode(true))
  expect(tracker.isCurrent(first)).toBe(false)
  expect(mapper.range(first.matches[0])).toBeNull()
  const second = tracker.find('findme', {
    caseSensitive: true,
    wholeWord: false,
  })!
  expect(
    findMapperFor(second.source).range(second.matches[0])?.toString(),
  ).toBe('findme')
  expect(
    root.contains(
      findMapperFor(second.source).range(second.matches[0])!.startContainer,
    ),
  ).toBe(true)
})

it('lists only matches whose blocks are within the visible box', () => {
  const { tracker, root } = mount('ir')
  const result = tracker.find('findme', {
    caseSensitive: true,
    wholeWord: false,
  })!
  // Every element sits where its top-level block does: block N spans y = N * 1000.
  Array.from(root.children).forEach((block, index) => {
    for (const element of [block, ...block.querySelectorAll('*')])
      (element as HTMLElement).getBoundingClientRect = () =>
        new DOMRect(0, index * 1000, 100, 20)
  })
  const visible = findMapperFor(result.source).visible(
    result.matches,
    { top: 0, bottom: 500 },
    0,
  )
  expect(visible).toEqual([0, 1])
})

it('matches the pure engine count even when no match is visible', () => {
  const { tracker } = mount('wysiwyg')
  const result = tracker.find('FINDME', {
    caseSensitive: false,
    wholeWord: true,
  })!
  expect(result.matches).toEqual(
    findMarkdownMatches(SOURCE, 'FINDME', {
      caseSensitive: false,
      wholeWord: true,
    }),
  )
})

it('maps SV matches through the SV text even where it differs from the exact bytes', () => {
  const root = document.createElement('pre')
  root.className = 'vditor-sv vditor-reset'
  const rendered = SOURCE.replace('|findme|b|', '| findme | b |')
  for (const line of rendered.split('\n')) {
    const span = document.createElement('span')
    span.textContent = `${line}\n`
    root.append(span)
  }
  document.body.append(root)
  const revision = {}
  const tracker = createFindSourceTracker({
    mode: () => 'sv',
    root: () => root,
    snapshotPair: () => ({ exact: SOURCE, rendered }),
    snapshotRevision: () => revision,
  })
  const result = tracker.find('findme', {
    caseSensitive: true,
    wholeWord: false,
  })!
  const mapper = findMapperFor(result.source)
  const ranges = result.matches.map((match) => mapper.range(match))
  expect(ranges.every((range) => range?.toString() === 'findme')).toBe(true)
  expect(ranges[4]!.startContainer.textContent).toBe('| findme | b |\n')
  const delimiter = tracker.find('|---|', {
    caseSensitive: true,
    wholeWord: false,
  })!
  expect(mapper.range(delimiter.matches[0])?.toString()).toBe('|---|')
})

// The large synthetic fixture normalizes under Vditor (exact 174,517 vs rendered ~181,850 bytes),
// so the shared index's exact-source units are rejected there; Find must still map every match.
it('maps every occurrence of a cross-region token on the large fixture in IR and WYSIWYG', () => {
  const fixture = readFileSync(
    path.join(
      __dirname,
      '../../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
    ),
    'utf8',
  )
  for (const mode of ['ir', 'wysiwyg'] as const) {
    const { tracker } = mount(mode, fixture)
    const result = tracker.find('ncjw', {
      caseSensitive: true,
      wholeWord: false,
    })!
    expect(result.source.exact === fixture).toBe(true)
    expect(result.source.entry?.rendered === fixture).toBe(false)
    const mapper = findMapperFor(result.source)
    const unmapped = result.matches.filter(
      (match) => mapper.range(match)?.toString() !== 'ncjw',
    )
    expect(result.matches.length).toBeGreaterThan(20)
    expect(unmapped).toEqual([])
    document.body.replaceChildren()
  }
}, 60_000)
