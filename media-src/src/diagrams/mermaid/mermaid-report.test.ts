// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectTerminalGeometry,
  ELK_FALLBACK_MESSAGE,
  elkFallbackApplies,
  EMPTY_DRAWING_MESSAGE,
  isEmptyMermaidSvg,
  MERMAID_WARNING_TITLE,
  mayRequestElk,
  mermaidWarningHtml,
  misplacedTerminalLabelCount,
  terminalLabelsMessage,
  withTimeout,
} from './mermaid-report'

// Task 705 — pure helpers of the in-place mermaid warning report. Acceptance items covered here:
// "Detectable defects" (terminal-label check, empty drawing), "Errors" (withTimeout), "Fallbacks"
// (mayRequestElk / elkFallbackApplies / message constants), "Every warning shows in place"
// (mermaidWarningHtml markup contract). Shapes assumed by these tests (the handoff names the types
// but not their fields): EdgeEnds = { start: Point; end: Point }, TerminalGroup =
// { edgeId: string; labels: Point[] } with labels in document order (first follows the start).

type Point = { x: number; y: number }
const p = (x: number, y: number): Point => ({ x, y })

describe('misplacedTerminalLabelCount', () => {
  const edges = new Map([['e1', { start: p(0, 0), end: p(100, 0) }]])

  it('counts 0 when both labels sit nearer their own end', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(10, 0), p(90, 0)] },
      ]),
    ).toBe(0)
  })

  it('counts a start label placed nearer the end', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(90, 0), p(95, 0)] },
      ]),
    ).toBe(1)
  })

  it('counts an end label placed nearer the start', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(5, 0), p(10, 0)] },
      ]),
    ).toBe(1)
  })

  it('counts both labels when both are swapped', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(100, 0), p(0, 0)] },
      ]),
    ).toBe(2)
  })

  it('treats an equidistant label as misplaced (rule: own >= other)', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(50, 0), p(90, 0)] },
      ]),
    ).toBe(1)
  })

  it('skips an edge with a single label (the side is not in the DOM)', () => {
    expect(
      misplacedTerminalLabelCount(edges, [
        { edgeId: 'e1', labels: [p(90, 0)] },
      ]),
    ).toBe(0)
  })

  it('skips a group whose edge has no points', () => {
    expect(
      misplacedTerminalLabelCount(new Map(), [
        { edgeId: 'missing', labels: [p(90, 0), p(5, 0)] },
      ]),
    ).toBe(0)
  })

  it('sums over several edges', () => {
    const two = new Map([
      ['a', { start: p(0, 0), end: p(100, 0) }],
      ['b', { start: p(0, 50), end: p(100, 50) }],
    ])
    expect(
      misplacedTerminalLabelCount(two, [
        { edgeId: 'a', labels: [p(90, 0), p(95, 0)] },
        { edgeId: 'b', labels: [p(5, 50), p(95, 50)] },
      ]),
    ).toBe(1)
  })
})

function b64(points: Point[]): string {
  return btoa(JSON.stringify(points))
}

function svgWithEdge(opts: {
  id: string
  points: Point[]
  terminals: Array<[number, number]>
}): Element {
  const host = document.createElement('div')
  host.innerHTML =
    `<svg viewBox="0 0 200 100"><g class="edgePaths">` +
    `<path data-edge="true" data-id="${opts.id}" data-points="${b64(opts.points)}" d="M0 0"/>` +
    `</g><g class="edgeLabels"><g class="edgeLabel"><g class="label" data-id="${opts.id}"></g></g>` +
    opts.terminals
      .map(
        ([x, y]) =>
          `<g class="edgeTerminals" transform="translate(${x}, ${y})"></g>`,
      )
      .join('') +
    `</g></svg>`
  return host.querySelector('svg') as Element
}

describe('collectTerminalGeometry', () => {
  it('reads the edge ends from base64 data-points and the label anchors from translate()', () => {
    const svg = svgWithEdge({
      id: 'e1',
      points: [p(0, 0), p(50, 0), p(100, 0)],
      terminals: [
        [10, 5],
        [90.5, -4],
      ],
    })
    const { edges, groups } = collectTerminalGeometry(svg)
    expect(edges.get('e1')).toEqual({ start: p(0, 0), end: p(100, 0) })
    expect(groups).toEqual([{ edgeId: 'e1', labels: [p(10, 5), p(90.5, -4)] }])
  })

  it('returns empty collections at once when the svg has no edgeTerminals', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'
    const { edges, groups } = collectTerminalGeometry(
      host.querySelector('svg') as Element,
    )
    expect(edges.size).toBe(0)
    expect(groups).toEqual([])
  })

  it('feeds misplacedTerminalLabelCount end to end (swapped labels flagged)', () => {
    const svg = svgWithEdge({
      id: 'e1',
      points: [p(0, 0), p(100, 0)],
      terminals: [
        [95, 0],
        [90, 0],
      ],
    })
    const { edges, groups } = collectTerminalGeometry(svg)
    expect(misplacedTerminalLabelCount(edges, groups)).toBe(1)
  })

  it('ignores an edge whose data-points is not valid base64 JSON', () => {
    const host = document.createElement('div')
    host.innerHTML =
      '<svg viewBox="0 0 10 10"><path data-edge="true" data-id="bad" data-points="!!!"/>' +
      '<g class="edgeLabel"><g class="label" data-id="bad"></g></g>' +
      '<g class="edgeTerminals" transform="translate(1, 1)"></g>' +
      '<g class="edgeTerminals" transform="translate(2, 2)"></g></svg>'
    const { edges } = collectTerminalGeometry(
      host.querySelector('svg') as Element,
    )
    expect(edges.has('bad')).toBe(false)
  })
})

describe('isEmptyMermaidSvg', () => {
  const svg = (inner: string, viewBox = '0 0 100 50'): Element => {
    const host = document.createElement('div')
    host.innerHTML = `<svg${viewBox ? ` viewBox="${viewBox}"` : ''}>${inner}</svg>`
    return host.querySelector('svg') as Element
  }

  it('is false for a sized svg with a drawn shape', () => {
    expect(isEmptyMermaidSvg(svg('<g><rect width="5" height="5"/></g>'))).toBe(
      false,
    )
  })

  it('is false when the only content is text', () => {
    expect(isEmptyMermaidSvg(svg('<text>hello</text>'))).toBe(false)
  })

  it('is true for a zero-width or zero-height viewBox', () => {
    expect(isEmptyMermaidSvg(svg('<rect/>', '0 0 0 50'))).toBe(true)
    expect(isEmptyMermaidSvg(svg('<rect/>', '0 0 100 0'))).toBe(true)
  })

  it('is true when the viewBox is missing or not numeric', () => {
    expect(isEmptyMermaidSvg(svg('<rect/>', ''))).toBe(true)
    expect(isEmptyMermaidSvg(svg('<rect/>', 'a b c d'))).toBe(true)
  })

  it('is true when there is no drawable element', () => {
    expect(isEmptyMermaidSvg(svg('<g></g>'))).toBe(true)
  })

  it('does not count shapes inside defs, marker or style', () => {
    expect(
      isEmptyMermaidSvg(
        svg(
          '<defs><path d="M0 0"/></defs><marker id="m"><circle r="1"/></marker><style>.a{}</style>',
        ),
      ),
    ).toBe(true)
  })
})

describe('mayRequestElk', () => {
  it('is true when the source mentions elk as a word', () => {
    expect(
      mayRequestElk(
        '---\nconfig:\n  layout: elk\n---\nflowchart TD',
        undefined,
      ),
    ).toBe(true)
    expect(
      mayRequestElk('%%{init: {"layout":"elk"}}%%\nflowchart TD', undefined),
    ).toBe(true)
  })

  it('is true when the global layout is elk, even without the word in the source', () => {
    expect(mayRequestElk('flowchart TD\nA-->B', 'elk')).toBe(true)
  })

  it('is false for plain sources and other global layouts', () => {
    expect(mayRequestElk('flowchart TD\nA-->B', undefined)).toBe(false)
    expect(mayRequestElk('flowchart TD\nA-->B', 'dagre')).toBe(false)
  })
})

describe('elkFallbackApplies', () => {
  const fallbackTypes = [
    'flowchart-v2',
    'flowchart',
    'flowchart-elk',
    'classDiagram',
    'class',
    'er',
    'requirement',
  ]

  it.each(fallbackTypes)('is true for %s requesting elk', (type) => {
    expect(elkFallbackApplies(type, 'elk')).toBe(true)
  })

  it('accepts elk.* algorithm names', () => {
    expect(elkFallbackApplies('flowchart-v2', 'elk.layered')).toBe(true)
    expect(elkFallbackApplies('classDiagram', 'elk.stress')).toBe(true)
  })

  it('is true for the flowchart-elk type without an explicit layout', () => {
    expect(elkFallbackApplies('flowchart-elk', undefined)).toBe(true)
  })

  it('is false for state diagrams (they throw, not fall back)', () => {
    expect(elkFallbackApplies('stateDiagram', 'elk')).toBe(false)
    expect(elkFallbackApplies('state', 'elk')).toBe(false)
  })

  it('is false when the requested layout is not elk', () => {
    expect(elkFallbackApplies('flowchart-v2', undefined)).toBe(false)
    expect(elkFallbackApplies('flowchart-v2', 'dagre')).toBe(false)
  })
})

describe('mermaidWarningHtml', () => {
  it('returns an empty string without warnings', () => {
    expect(mermaidWarningHtml([])).toBe('')
  })

  it('builds the Lute-invisible, non-blocking markup with one token and one message', () => {
    const html = mermaidWarningHtml([
      { kind: 'terminal-labels', message: terminalLabelsMessage(1) },
    ])
    expect(html).toContain('class="vmde-diagram-warning"')
    expect(html).toContain('data-render="1"')
    expect(html).toContain('role="note"')
    expect(html).toContain('data-vmde-warning="terminal-labels"')
    expect(html).toContain(
      `<div class="vmde-diagram-warning__title">${MERMAID_WARNING_TITLE}</div>`,
    )
    expect(html).toContain(
      '<p class="vmde-diagram-warning__msg">1 relation end label sits closer to the other end of its line.</p>',
    )
  })

  it('writes a space-separated token list and one <p> per warning', () => {
    const html = mermaidWarningHtml([
      { kind: 'layout-fallback', message: ELK_FALLBACK_MESSAGE },
      { kind: 'terminal-labels', message: terminalLabelsMessage(2) },
    ])
    expect(html).toContain(
      'data-vmde-warning="layout-fallback terminal-labels"',
    )
    expect(html.match(/<p class="vmde-diagram-warning__msg">/g)).toHaveLength(2)
    expect(html.match(/class="vmde-diagram-warning"/g)).toHaveLength(1)
  })

  it('escapes &, < and > in messages', () => {
    const html = mermaidWarningHtml([
      { kind: 'empty-drawing', message: 'a <b> & c' },
    ])
    expect(html).toContain('a &lt;b&gt; &amp; c')
    expect(html).not.toContain('<b>')
  })

  it('uses the exact message constants', () => {
    expect(MERMAID_WARNING_TITLE).toBe('Mermaid warning')
    expect(ELK_FALLBACK_MESSAGE).toBe(
      'ELK layout is not available. Drawn with dagre instead.',
    )
    expect(EMPTY_DRAWING_MESSAGE).toBe('Mermaid produced an empty drawing.')
  })

  it('words the terminal-label message in singular and plural', () => {
    expect(terminalLabelsMessage(1)).toBe(
      '1 relation end label sits closer to the other end of its line.',
    )
    expect(terminalLabelsMessage(3)).toBe(
      '3 relation end labels sit closer to the other end of their lines.',
    )
  })
})

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers())

  it('resolves with the promise value and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const result = withTimeout(Promise.resolve('ok'), 30_000, 'late')
    await expect(result).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with the message when the promise does not settle in time', async () => {
    vi.useFakeTimers()
    const result = withTimeout(
      new Promise<string>(() => undefined),
      30_000,
      'too slow',
    )
    const settled = expect(result).rejects.toThrow('too slow')
    await vi.advanceTimersByTimeAsync(29_999)
    await vi.advanceTimersByTimeAsync(2)
    await settled
  })

  it('passes a rejection of the promise through unchanged', async () => {
    vi.useFakeTimers()
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 30_000, 'late'),
    ).rejects.toThrow('boom')
  })
})
