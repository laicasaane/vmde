// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { blockMapFor, renderedPlanFor } from './find-map'
import { proveSelectionSource } from './selection-source-proof'

const NORMALIZING =
  '|a|b|\n|---|---|\n|x|y|\n\nTarget 😀 text\n\nLast paragraph\n'
let lutes: Record<'ir' | 'wysiwyg', RealLute>
const dispose: Array<() => void> = []

beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of dispose.splice(0)) cleanup()
  document.body.replaceChildren()
  delete (window as any).vditor
})

function mount(mode: 'ir' | 'wysiwyg', exact: string, input = exact) {
  const real = lutes[mode]
  const root = document.createElement('div')
  root.innerHTML = real.render(input)
  document.body.append(root)
  ;(window as any).vditor = {
    vditor: { currentMode: mode, lute: real.lute, [mode]: { element: root } },
  }
  let revision = {}
  const readPair = () => ({ exact, rendered: real.serialize(root.innerHTML) })
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: currentBlockProjection,
    snapshotPair: readPair,
    snapshotRevision: () => revision,
    resolveUnits: (element, source, rendered) =>
      resolveBlockHandleUnits(
        element,
        source,
        rendered,
        currentBlockProjection(),
      ),
  })
  dispose.push(() => index.dispose())
  const source = { index, snapshotPair: vi.fn(readPair) }
  return {
    root,
    source,
    revise: () => {
      revision = {}
    },
    prove: (range: Range) => proveSelectionSource(source, root, range),
  }
}

function textContaining(root: Node, content: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text && node.data.includes(content)) return node
  throw new Error(`Missing test text: ${content}`)
}

function rangeAt(node: Node, start: number, end = start): Range {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  return range
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  describe(mode, () => {
    it('proves round-trip text endpoints, including offset zero and the last text boundary', () => {
      const exact = 'First 😀 text\n\nLast paragraph\n'
      const view = mount(mode, exact)
      const first = textContaining(view.root, 'First')
      const last = textContaining(view.root, 'Last')
      const range = rangeAt(first, 0)
      range.setEnd(last, last.length)
      const result = view.prove(range)
      expect(result).toMatchObject({
        status: 'proven',
        exact,
        rendered: exact,
        roundTrip: true,
        start: {
          exact: 0,
          unit: 0,
          unitExact: [0, exact.indexOf('\n')],
          via: 'document',
        },
        end: { exact: exact.length - 1, unit: 1, via: 'document' },
      })
      expect(view.source.snapshotPair).toHaveBeenCalledTimes(1)
      if (result.status !== 'proven') throw new Error('Expected proven range')
      expect(result.key).toBe(view.source.index.peek()!.key)
      const caret = view.prove(rangeAt(first, 'First 😀'.length))
      expect(caret).toMatchObject({ status: 'proven', start: { exact: 8 } })
      if (caret.status === 'proven') expect(caret.start).toBe(caret.end)
    })

    it('keeps exact authority after a normalized table and exposes multiple units to callers', () => {
      const view = mount(mode, NORMALIZING)
      const first = textContaining(view.root, 'Target')
      const range = rangeAt(first, 0, 6)
      const result = view.prove(range)
      expect(result).toMatchObject({
        status: 'proven',
        exact: NORMALIZING,
        roundTrip: false,
        start: {
          exact: NORMALIZING.indexOf('Target'),
          unit: 1,
          unitExact: [
            NORMALIZING.indexOf('Target'),
            NORMALIZING.indexOf('\n', NORMALIZING.indexOf('Target')),
          ],
          via: 'document',
        },
        end: { exact: NORMALIZING.indexOf('Target') + 6, unit: 1 },
      })
      if (result.status === 'proven')
        expect(result.rendered).not.toBe(result.exact)
      const last = textContaining(view.root, 'Last')
      range.setEnd(last, 4)
      expect(view.prove(range)).toMatchObject({
        status: 'proven',
        roundTrip: false,
        start: { unit: 1 },
        end: { unit: 2 },
      })
    })

    it('maps emphasized text and nested lists through their top-level member', () => {
      const exact = '**Strong** words\n\n- Outer\n  - Inner\n\nTail\n'
      const view = mount(mode, exact)
      for (const content of ['Strong', 'Outer', 'Inner']) {
        const node = textContaining(view.root, content)
        const offset = node.data.indexOf(content) + 2
        expect(view.prove(rangeAt(node, offset))).toMatchObject({
          status: 'proven',
          start: {
            exact: exact.indexOf(content) + 2,
            unit: content === 'Strong' ? 0 : 1,
          },
        })
      }
    })

    it('declines element and mid-surrogate endpoints, retaining the round-trip flag', () => {
      const view = mount(mode, NORMALIZING)
      const text = textContaining(view.root, '😀')
      const mid = text.data.indexOf('😀') + 1
      for (const range of [
        rangeAt(text, mid),
        rangeAt(view.root.querySelector('tr')!, 0),
      ])
        expect(view.prove(range)).toEqual({
          status: 'unprovable',
          roundTrip: false,
        })
      for (const offset of [mid - 1, mid + 1])
        expect(view.prove(rangeAt(text, offset)).status).toBe('proven')
    })

    it('declines a caret and left range at deleted zero-width space but keeps a right range', () => {
      const view = mount(mode, 'one\u200btwo\n')
      const node = textContaining(view.root, 'two')
      const offset = node.data.indexOf('two')
      expect(view.prove(rangeAt(node, offset))).toEqual({
        status: 'unprovable',
        roundTrip: false,
      })
      expect(view.prove(rangeAt(node, offset, offset + 1))).toMatchObject({
        status: 'proven',
        start: { exact: 4 },
        end: { exact: 5 },
      })
      expect(view.prove(rangeAt(node, 0, offset))).toEqual({
        status: 'unprovable',
        roundTrip: false,
      })
    })

    it('uses the document alignment for small CRLF and the block fallback past its diff bound', () => {
      for (const count of [3, 1100]) {
        const exact = Array.from(
          { length: count },
          (_, i) => `Paragraph ${i} target\r\n`,
        ).join('\r\n')
        const view = mount(mode, exact)
        const target = `Paragraph ${Math.floor(count / 2)} target`
        const text = textContaining(view.root, target)
        const range = rangeAt(text, target.indexOf('target'), target.length)
        const expected = exact.indexOf(target) + target.indexOf('target')
        const result = view.prove(range)
        expect(result).toMatchObject({
          status: 'proven',
          roundTrip: false,
          start: { exact: expected, via: count === 3 ? 'document' : 'block' },
          end: { exact: expected + 6, via: count === 3 ? 'document' : 'block' },
        })
        // Repeated requests exercise the private per-entry fallback memo as well.
        expect(view.prove(range)).toEqual(result)
      }
    }, 60_000)

    it('declines a range starting between CR and LF inside one soft-line paragraph', () => {
      const view = mount(mode, 'line1\r\nline2\n')
      const first = textContaining(view.root, 'line1')
      const second = textContaining(view.root, 'line2')
      const range = rangeAt(first, first.data.indexOf('line1') + 5)
      range.setEnd(second, second.data.indexOf('line2') + 2)
      expect(range.collapsed).toBe(false)
      expect(view.prove(range).status).toBe('unprovable')
    })

    it('declines an exact offset inside a surrogate pair even if alignment supplies it', () => {
      const view = mount(mode, NORMALIZING)
      const node = textContaining(view.root, '😀')
      const entry = view.source.index.read()!
      const plan = renderedPlanFor(entry)
      const insideEmoji = NORMALIZING.indexOf('😀') + 1
      vi.spyOn(plan.alignment, 'toExact').mockReturnValue(insideEmoji)
      expect(view.prove(rangeAt(node, node.data.indexOf('😀'))).status).toBe(
        'unprovable',
      )
    })

    it('rejects a snapshot mismatch or a revision change during the snapshot', () => {
      const view = mount(mode, 'Target\n')
      const range = rangeAt(textContaining(view.root, 'Target'), 2)
      const entry = view.source.index.read()!
      for (const key of ['exact', 'rendered'] as const) {
        view.source.snapshotPair.mockReturnValueOnce({
          exact: entry.exact,
          rendered: entry.rendered,
          [key]: 'Changed\n',
        })
        expect(view.prove(range)).toEqual({ status: 'unavailable' })
      }
      view.source.snapshotPair.mockImplementationOnce(() => {
        view.revise()
        return { exact: entry.exact, rendered: entry.rendered }
      })
      expect(view.prove(range)).toEqual({ status: 'unavailable' })
    })

    it('declines when exact structural pairing fails even though the text aligns', () => {
      const view = mount(mode, '# Target\n', 'Target\n')
      expect(
        view.prove(rangeAt(textContaining(view.root, 'Target'), 2)),
      ).toEqual({
        status: 'unprovable',
        roundTrip: false,
      })
    })

    it('does not mutate live DOM or insert range markers on cold or warm requests', () => {
      const view = mount(mode, NORMALIZING)
      const range = rangeAt(textContaining(view.root, 'Target'), 1, 6)
      const html = view.root.innerHTML
      const mutations = new MutationObserver(() => {
        // Synchronous proof requests are checked with takeRecords below.
      })
      mutations.observe(view.root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      const insertNode = vi.spyOn(Range.prototype, 'insertNode')
      try {
        expect(view.prove(range).status).toBe('proven')
        const entry = view.source.index.peek()!
        const plan = renderedPlanFor(entry)
        const unit = plan.units[1]!
        const map = blockMapFor(entry, unit)
        const serialize = vi.spyOn(
          lutes[mode].lute,
          mode === 'ir' ? 'VditorIRDOM2Md' : 'VditorDOM2Md',
        )
        expect(view.prove(range).status).toBe('proven')
        // The test snapshot uses the bound real serializer; another fragment call would hit this spy.
        expect(serialize).not.toHaveBeenCalled()
        expect(view.source.snapshotPair).toHaveBeenCalledTimes(2)
        expect(view.source.index.peek()).toBe(entry)
        expect(blockMapFor(entry, unit)).toBe(map)
        expect(view.root.innerHTML).toBe(html)
        expect(mutations.takeRecords()).toEqual([])
        expect(insertNode).not.toHaveBeenCalled()
      } finally {
        mutations.disconnect()
      }
    })
  })
}

it('declines IR marker text on both round-trip and normalizing documents', () => {
  for (const prefix of ['', `${NORMALIZING}\n`]) {
    const view = mount('ir', `${prefix}**Strong** words\n`)
    const marker = view.root.querySelector('.vditor-ir__marker')!
    const node = document
      .createTreeWalker(marker, NodeFilter.SHOW_TEXT)
      .nextNode()!
    expect(view.prove(rangeAt(node, 1))).toEqual({
      status: 'unprovable',
      roundTrip: prefix === '',
    })
  }
})

it('returns unavailable before snapshotting for a missing entry or wrong root', () => {
  const view = mount('ir', 'Target\n')
  const range = rangeAt(textContaining(view.root, 'Target'), 0)
  expect(
    proveSelectionSource(view.source, document.createElement('div'), range),
  ).toEqual({ status: 'unavailable' })
  vi.spyOn(view.source.index, 'peek').mockReturnValue(null)
  vi.spyOn(view.source.index, 'read').mockReturnValue(null)
  expect(view.prove(range)).toEqual({ status: 'unavailable' })
  expect(view.source.snapshotPair).not.toHaveBeenCalled()
})

it('declines detached, outside-root, unowned and trailing text', () => {
  const view = mount('ir', 'Target\n')
  const outside = document.createElement('p')
  outside.textContent = 'Outside'
  document.body.append(outside)
  for (const node of [document.createTextNode('Detached'), outside.firstChild!])
    expect(view.prove(rangeAt(node, 0))).toEqual({
      status: 'unprovable',
      roundTrip: true,
    })
  const trailing = document.createElement('p')
  trailing.setAttribute('data-block', '0')
  trailing.setAttribute('data-vmde-trailing', '')
  trailing.textContent = '\u200b'
  view.root.append(trailing)
  expect(view.prove(rangeAt(trailing.firstChild!, 0)).status).toBe('unprovable')
  const unowned = document.createElement('div')
  unowned.textContent = 'Decoration'
  view.root.append(unowned)
  expect(view.prove(rangeAt(unowned.firstChild!, 0)).status).toBe('unprovable')
})

it('declines when the block map cannot serialize the marked clone', () => {
  const view = mount('ir', NORMALIZING)
  const range = rangeAt(textContaining(view.root, 'Target'), 2)
  view.source.index.read()
  vi.spyOn(lutes.ir.lute, 'VditorIRDOM2Md').mockImplementation(() => {
    throw new Error('fragment unavailable')
  })
  expect(view.prove(range)).toEqual({ status: 'unprovable', roundTrip: false })
})

it('rejects a document alignment that lands outside the structurally paired exact block', () => {
  const view = mount('ir', NORMALIZING)
  const range = rangeAt(textContaining(view.root, 'Target'), 2)
  const entry = view.source.index.read()!
  const plan = renderedPlanFor(entry)
  for (const offset of [0, NORMALIZING.indexOf('Last')]) {
    // A bounded diff can pair repeated text across blocks. Structural ownership must veto it.
    vi.spyOn(plan.alignment, 'toExact').mockReturnValue(offset)
    expect(view.prove(range)).toEqual({
      status: 'unprovable',
      roundTrip: false,
    })
  }
})

it('declines a crafted stale text boundary whose character no longer matches exact source', () => {
  const view = mount('ir', 'Target text\n')
  const node = textContaining(view.root, 'Target')
  const interior = rangeAt(node, 2)
  expect(view.prove(interior).status).toBe('proven')
  const entry = view.source.index.peek()!
  // Hold the old snapshot and key to isolate the endpoint guard from normal revision rejection.
  vi.spyOn(view.source.index, 'peek').mockReturnValue(entry)
  vi.spyOn(view.source.index, 'currentKey').mockReturnValue(entry.key)
  view.source.snapshotPair.mockReturnValue({
    exact: entry.exact,
    rendered: entry.rendered,
  })
  node.replaceData(2, 1, 'X')
  expect(view.prove(interior).status).toBe('unprovable')
  node.replaceData(2, 1, 'r')
  node.replaceData(node.length - 1, 1, 'X')
  expect(view.prove(rangeAt(node, node.length)).status).toBe('unprovable')
})
