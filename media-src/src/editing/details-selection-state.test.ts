// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveBlockHandleUnits,
  type BlockProjection,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { transformDetailsSelection } from './details'
import { resolveDetailsBlockRange } from './details-source'
import { readDetailsSelectionState } from './details-selection-state'
import { sourceSelectionFromDom } from './rewrap-command'

// Task 574 Checkpoint 5b: the passive Details state must never disagree with the old exact path.
// The oracle is the previous `captureTarget` + `transformDetailsSelection` flow (live text markers
// through the real mode serializer), run here only. 'unknown' is allowed: the controller resolves
// it with that same exact path once the selection settles.

type Mode = 'ir' | 'wysiwyg'
const lutes: Partial<Record<Mode, RealLute>> = {}
const luteFor = (mode: Mode): RealLute => {
  lutes[mode] ??= createRealLute(mode)
  return lutes[mode]
}

afterEach(() => document.body.replaceChildren())

function mount(mode: Mode, source: string, canonical = false) {
  const real = luteFor(mode)
  // Canonical fixtures keep exact === rendered so the block-handle resolver needs no projection
  // proof; noncanonical fixtures exercise the exact/rendered split.
  const markdown = canonical ? real.serialize(real.render(source)) : source
  const html = real.render(markdown)
  const fresh = (): HTMLElement => {
    const element = document.createElement('div')
    element.className = 'vditor-reset'
    element.innerHTML = html
    // Merged text nodes give stable point indices across fresh renders.
    element.normalize()
    return element
  }
  const root = fresh()
  document.body.append(root)
  const proof: BlockProjection = {
    owner: real.lute,
    mode,
    render: real.render,
    serialize: real.serialize,
  }
  const revision = {}
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: () => ({ owner: real.lute, mode }),
    snapshotPair: () => ({
      exact: markdown,
      rendered: real.serialize(root.innerHTML),
    }),
    snapshotRevision: () => revision,
    resolveUnits: (target, exact, rendered) =>
      resolveBlockHandleUnits(target, exact, rendered, proof),
  })
  // The marker path mutates the DOM, so each oracle case runs on its own fresh render.
  const oracle = (start: Point, end: Point): string => {
    const editor = fresh()
    document.body.append(editor)
    const range = rangeOf(editor, start, end)!
    const rendered = real.serialize(editor.innerHTML)
    const mapped = sourceSelectionFromDom({
      editor,
      range,
      serialize: real.serialize,
      canonicalMarkdown: rendered,
    })
    editor.remove()
    if (!mapped || mapped.markdown !== rendered) return 'disabled'
    const resolved = resolveDetailsBlockRange(
      rendered,
      mapped.startOffset,
      mapped.endOffset,
    )
    return resolved
      ? transformDetailsSelection({ ...resolved, resolved: true }).status
      : 'disabled'
  }
  return { root, index, oracle }
}

/** A text-node point, or (`block` set) a boundary at the start/end of a top-level block. */
interface Point {
  text: number
  offset: number
  block?: number
}

function sourceTexts(root: HTMLElement): Text[] {
  const texts: Text[] = []
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node instanceof Element &&
        ['1', '2'].includes(node.getAttribute('data-render') ?? '')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  )
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE && (node as Text).data.trim())
      texts.push(node as Text)
  }
  return texts
}

function textPoints(root: HTMLElement): Point[] {
  const points: Point[] = []
  // Block-element boundaries are what Chromium's triple-click and Shift+Down selections produce.
  for (let block = 0; block < root.children.length; block++)
    for (const offset of [0, -1]) points.push({ text: -1, offset, block })
  for (const [text, node] of sourceTexts(root).entries()) {
    const length = node.length
    // Both edges plus one interior point per text node keep the oracle sweep affordable.
    for (const offset of new Set([0, length >> 1, length]))
      if (offset >= 0 && offset <= length) points.push({ text, offset })
  }
  return points
}

function rangeOf(root: HTMLElement, start: Point, end: Point): Range | null {
  const texts = sourceTexts(root)
  const at = (point: Point): [Node, number] => {
    if (point.block === undefined) return [texts[point.text], point.offset]
    const block = root.children[point.block]
    return [block, point.offset < 0 ? block.childNodes.length : 0]
  }
  const range = document.createRange()
  range.setStart(...at(start))
  const [endNode, endOffset] = at(end)
  // Only forward, non-empty selections.
  if (range.comparePoint(endNode, endOffset) <= 0) return null
  range.setEnd(endNode, endOffset)
  return range
}

/** Native drags and Shift+Arrow produce text positions that contain text; those must map. */
function nativeTextSelection(root: HTMLElement, start: Point, end: Point) {
  const text = rangeOf(root, start, end)!
    .toString()
    .replace(/\u200b/gu, '')
  return start.block === undefined && end.block === undefined && text !== ''
}

function sweep(
  mode: Mode,
  markdown: string,
  stride = 1,
  canonical = false,
  requireUnits = true,
) {
  const { root, index, oracle } = mount(mode, markdown, canonical)
  const points = textPoints(root).filter((_, i) => i % stride === 0)
  const pairs = points.flatMap((start) =>
    points
      .filter((end) => rangeOf(root, start, end))
      .map((end): [Point, Point] => [start, end]),
  )
  // Pass 1 reads every state from one warm entry; pass 2 runs the mutating oracle.
  const entry = index.read()
  // A rejected resolver makes every state 'unknown'; parity would then be vacuous.
  if (requireUnits) expect(entry?.units).not.toBeNull()
  const states = pairs.map(([start, end]) =>
    readDetailsSelectionState(entry!, rangeOf(root, start, end)!),
  )
  const statuses = new Set<string>()
  const mismatches: string[] = []
  const unknowns: string[] = []
  for (const [position, [start, end]] of pairs.entries()) {
    const label = `${mode} ${start.text}:${start.offset}-${end.text}:${end.offset} ${JSON.stringify(rangeOf(root, start, end)!.toString())}`
    const expected = oracle(start, end)
    statuses.add(expected)
    const state = states[position]
    // Element-boundary endpoints and empty ranges defer to the exact path by design.
    if (state === 'unknown' && nativeTextSelection(root, start, end))
      unknowns.push(label)
    else if (state !== 'unknown' && state !== expected)
      mismatches.push(`${label}: state=${state} oracle=${expected}`)
  }
  index.dispose()
  return {
    cases: pairs.length,
    unknown: states.filter((state) => state === 'unknown').length,
    statuses,
    mismatches,
    unknowns,
  }
}

const PROSE = [
  'Alpha one',
  'alpha two',
  '',
  'Beta paragraph with **bold**, *em* and `code`',
  '',
  'Gamma one',
  'gamma two',
  'gamma three',
  '',
  'Epsilon hard  ',
  'break line',
  '',
  'Delta',
  '',
].join('\n')

const MIXED = [
  '# Heading one',
  '',
  'Prose before',
  '',
  '- item one',
  '- item **two**',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted line',
  '> lazy line',
  '',
  '```js',
  'const x = 1',
  'const y = 2',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '---',
  '',
  'Setext title',
  '============',
  '',
  'Tail prose',
  '',
].join('\n')

const DETAILS = [
  'Before',
  '',
  '<details>',
  '<summary>Outer</summary>',
  '',
  'Outer body',
  '',
  '<details>',
  '<summary>Inner</summary>',
  '',
  'Inner body',
  '',
  '</details>',
  '',
  '</details>',
  '',
  'Between',
  '',
  '<details>',
  '<summary>Only</summary>',
  '',
  'Immediate body',
  '',
  '</details>',
  '',
  'After',
  '',
].join('\n')

// Lute coalesces these openings, and the one-sided wrapper never closes: the block-handle
// resolver declines both documents, so every state must stay 'unknown' (no guessed offsets).
const DETAILS_UNRESOLVED = [
  'Before',
  '',
  '<details><details>',
  '<summary>Coalesced</summary>',
  '',
  'Coalesced body',
  '',
  '</details></details>',
  '',
  '<details>',
  '<summary>One-sided</summary>',
  '',
  'Orphan body',
  '',
  'After',
  '',
].join('\n')

// Each oracle case renders and serializes through GopherJS Lute; the sweeps take seconds each.
describe('readDetailsSelectionState parity with the exact marker path', {
  timeout: 120_000,
}, () => {
  for (const mode of ['ir', 'wysiwyg'] as const) {
    it(`maps every prose selection without fallback (${mode})`, () => {
      const result = sweep(mode, PROSE)
      expect(result.mismatches).toEqual([])
      expect(result.cases).toBeGreaterThan(200)
      // Ordinary prose is the large-document passive workload; a selection that contains text must
      // never need the fallback.
      expect(result.unknowns).toEqual([])
      expect([...result.statuses]).toContain('wrap')
    })

    it(`agrees on lists, quotes, fences, tables, headings and setext (${mode})`, () => {
      const result = sweep(mode, MIXED, 2, true)
      expect(result.mismatches).toEqual([])
      expect(result.unknown).toBeLessThan(result.cases)
      expect([...result.statuses].sort()).toEqual(['disabled', 'wrap'])
    })

    it(`agrees on immediate and nested Details documents (${mode})`, () => {
      const result = sweep(mode, DETAILS, 2, true)
      expect(result.mismatches).toEqual([])
      expect([...result.statuses].sort()).toEqual([
        'disabled',
        'unwrap',
        'wrap',
      ])
      // Paragraph-to-paragraph ranges across a wrapper still map; endpoints inside the
      // enclosure (one html-group unit) defer to the exact path.
      expect(result.unknown).toBeLessThan(result.cases)
    })

    it(`never guesses inside coalesced or one-sided Details (${mode})`, () => {
      const result = sweep(mode, DETAILS_UNRESOLVED, 3, true, false)
      expect(result.mismatches).toEqual([])
      expect(result.unknown).toBe(result.cases)
    })

    it(`agrees on a CRLF source with noncanonical bytes (${mode})`, () => {
      const crlf =
        `${PROSE}- item one\n- item two\n\n> quoted  line\n\n\n`.replace(
          /\n/gu,
          '\r\n',
        )
      const result = sweep(mode, crlf, 2)
      expect(result.mismatches).toEqual([])
      expect(result.unknown).toBeLessThan(result.cases)
    })
  }

  it('reports disabled outside the root and unknown when the resolver rejected the key', () => {
    const { root, index } = mount('ir', PROSE)
    const entry = index.read()!
    const outside = document.createElement('p')
    outside.textContent = 'outside'
    document.body.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    expect(readDetailsSelectionState(entry, range)).toBe('disabled')
    range.selectNodeContents(root.firstElementChild!)
    expect(readDetailsSelectionState({ ...entry, units: null }, range)).toBe(
      'unknown',
    )
  })
})
