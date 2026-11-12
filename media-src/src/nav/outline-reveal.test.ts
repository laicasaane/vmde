// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  revealSourceLine,
  spanIndexForOffset,
  unitIndexForLine,
} from './outline'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitLines,
} from '../util/unit-changes'

// Task 730 — IR/WYSIWYG source-line reveal. The block units pair each top-level block and list item
// with its source span (no live Lute here, so the units come from the unproved pairing); the line
// inside a unit is found by its readable text. Expected caret places come from the fixture text.

describe('spanIndexForOffset', () => {
  const spans = [
    { start: 0, end: 5 },
    { start: 7, end: 12 },
    { start: 20, end: 25 },
  ]
  it('returns the owning span, else the next one, else the last', () => {
    expect(spanIndexForOffset(spans, 0)).toBe(0)
    expect(spanIndexForOffset(spans, 11)).toBe(1)
    expect(spanIndexForOffset(spans, 5)).toBe(1) // separator between spans
    expect(spanIndexForOffset(spans, 13)).toBe(2)
    expect(spanIndexForOffset(spans, 99)).toBe(2)
    expect(spanIndexForOffset([], 3)).toBeNull()
  })
})

describe('revealSourceLine', () => {
  const MARKDOWN = [
    '# Title', // 0
    '', // 1
    '1. one', // 2
    '', // 3
    '2. two', // 4
    '   more', // 5
    '', // 6
    'para a', // 7
    'para b', // 8
    '', // 9
    '| A | B |', // 10
    '| --- | --- |', // 11
    '| x1 | y1 |', // 12
  ].join('\n')
  const HTML =
    '<h1 data-block="0">Title</h1>' +
    '<ol data-block="0" data-tight="false"><li><p>one</p></li><li><p>two\nmore</p></li></ol>' +
    '<p data-block="0">para a\npara b</p>' +
    '<table data-block="0"><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td>x1</td><td>y1</td></tr></tbody></table>'

  const requestCaret = vi.fn(() => true)
  let scrolled: Element[]
  let editor: HTMLElement

  beforeEach(() => {
    scrolled = []
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this)
    })
    requestCaret.mockClear()
    ;(window as any).__vmdeRequestCaret = requestCaret
    editor = document.createElement('div')
    editor.innerHTML = HTML
    document.body.append(editor)
    ;(window as any).vditor = {
      getValue: () => MARKDOWN,
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete (window as any).vditor
    delete (window as any).__vmdeRequestCaret
  })

  const reveal = (line: number, endLine?: number) =>
    revealSourceLine(
      (window as any).vditor,
      line,
      MARKDOWN.split('\n')[line],
      endLine,
      endLine === undefined ? undefined : MARKDOWN.split('\n')[endLine],
    )

  it('puts the caret at the start of a list item of a loose list and scrolls it in', () => {
    expect(reveal(4)).toBe(true)
    const item = editor.querySelectorAll('li p')[1]
    expect(requestCaret).toHaveBeenCalledWith({
      node: item.firstChild,
      offset: 0,
    })
    expect(scrolled).toEqual([item])
    expect(item.classList.contains('heading-flash')).toBe(true)
  })

  it('puts the caret at the start of the second line of a soft-broken paragraph', () => {
    expect(reveal(8)).toBe(true)
    const paragraph = editor.querySelector('p[data-block]')!
    expect(requestCaret).toHaveBeenCalledWith({
      node: paragraph.firstChild,
      offset: 'para a\n'.length,
    })
  })

  it('reaches a table row', () => {
    expect(reveal(12)).toBe(true)
    const cell = editor.querySelector('td')!
    expect(requestCaret).toHaveBeenCalledWith({
      node: cell.firstChild,
      offset: 0,
    })
    expect(scrolled).toEqual([cell.closest('tr')])
  })

  it('selects a range from the first line start to the end of the last line', () => {
    expect(reveal(2, 8)).toBe(true)
    const first = editor.querySelector('li p')!
    const paragraph = editor.querySelector('p[data-block]')!
    expect(requestCaret).toHaveBeenCalledWith({
      anchor: { node: first.firstChild, offset: 0 },
      focus: { node: paragraph.firstChild, offset: 'para a\npara b'.length },
    })
  })

  it('lands a blank line on the next block', () => {
    expect(reveal(6)).toBe(true)
    const paragraph = editor.querySelector('p[data-block]')!
    expect(requestCaret).toHaveBeenCalledWith({
      node: paragraph.firstChild,
      offset: 0,
    })
  })

  it('finds the line by its text when the host numbered it differently', () => {
    expect(revealSourceLine((window as any).vditor, 40, '7. two')).toBe(true)
    expect(requestCaret).toHaveBeenCalledWith({
      node: editor.querySelectorAll('li p')[1].firstChild,
      offset: 0,
    })
  })

  it('falls back to the block scanner when the units cannot be paired', () => {
    // A block the unit pairing does not know (no source kind) rejects the pairing.
    editor.innerHTML = '<p data-block="0">one</p><div data-block="0">two</div>'
    ;(window as any).vditor.getValue = () => 'one\n\ntwo'
    expect(revealSourceLine((window as any).vditor, 2, 'two')).toBe(true)
    expect(scrolled).toEqual([editor.children[1]])
    // A line the scanner maps past the live blocks is a miss, not some other block.
    editor.innerHTML = '<div data-block="0">one</div>'
    ;(window as any).vditor.getValue = () => 'one\n\ntwo'
    expect(revealSourceLine((window as any).vditor, 2, 'two')).toBe(false)
  })

  it('waits (false) outside IR and WYSIWYG, and when the line is not in the document', () => {
    ;(window as any).vditor.vditor.currentMode = 'sv'
    expect(reveal(4)).toBe(false)
    ;(window as any).vditor.vditor.currentMode = 'ir'
    expect(revealSourceLine((window as any).vditor, 2, 'missing words')).toBe(
      false,
    )
    expect(requestCaret).not.toHaveBeenCalled()
  })

  // Task 733 / 006: with a confirmed unit feed the host line is the model line, so the unit comes
  // from a binary search on `startLine` and only that unit is placed; getValue() is not read.
  describe('from model units', () => {
    let getValue: ReturnType<typeof vi.fn>
    let toMd: ReturnType<typeof vi.fn>
    let confirmed: boolean
    let feed: UnitFeed
    let lines: UnitLines[]
    let confirmNow: ReturnType<typeof vi.fn<() => boolean>>

    // The unit's Markdown as the live Lute would serialize it alone.
    const unitMd = (html: string) =>
      html.includes('para a')
        ? 'para a\npara b'
        : html.includes('two')
          ? '2. two\n   more'
          : html.includes('one')
            ? '1. one'
            : 'x'

    beforeEach(() => {
      const [h1, ol, p, table] = Array.from(editor.children) as HTMLElement[]
      const [li1, li2] = Array.from(ol!.children) as HTMLElement[]
      const ranges: Array<[HTMLElement, number, number]> = [
        [h1!, 0, 0],
        [li1!, 2, 2],
        [li2!, 4, 5],
        [p!, 7, 8],
        [table!, 10, 12],
      ]
      lines = ranges.map(([el, startLine, endLine]) => ({
        el,
        startLine,
        endLine,
      }))
      confirmed = true
      confirmNow = vi.fn(() => {
        confirmed = true
        return true
      })
      feed = {
        root: editor,
        isLive: () => true,
        liveUnitOf: (node) =>
          node === table
            ? undefined
            : ({
                el: node as HTMLElement,
                members: [node as HTMLElement],
                kind: node === li1 || node === li2 ? 'list-item' : 'paragraph',
                top: node as HTMLElement,
              } as LiveUnit),
        liveUnits: () => [],
        onUnitsChanged: () => () => undefined,
        confirmNow,
        confirmedLines: () => (confirmed ? lines : undefined),
      }
      provideUnitFeed(window, feed)
      getValue = vi.fn(() => MARKDOWN)
      toMd = vi.fn(unitMd)
      ;(window as any).vditor.getValue = getValue
      ;(window as any).vditor.vditor.lute = { VditorIRDOM2Md: toMd }
    })

    afterEach(() => provideUnitFeed(window, undefined))

    it('places a table row without Lute or getValue', () => {
      expect(reveal(12)).toBe(true)
      const cell = editor.querySelector('td')!
      expect(requestCaret).toHaveBeenCalledWith({
        node: cell.firstChild,
        offset: 0,
      })
      expect(scrolled).toEqual([cell.closest('tr')])
      expect(getValue).not.toHaveBeenCalled()
      expect(toMd).not.toHaveBeenCalled()
    })

    it('places the second line of a paragraph from its unit alone', () => {
      expect(reveal(8)).toBe(true)
      const paragraph = editor.querySelector('p[data-block]')!
      expect(requestCaret).toHaveBeenCalledWith({
        node: paragraph.firstChild,
        offset: 'para a\n'.length,
      })
      expect(getValue).not.toHaveBeenCalled()
    })

    it('places a continuation line of a list item and scrolls its line element', () => {
      expect(reveal(5)).toBe(true)
      const second = editor.querySelectorAll('li p')[1]!
      expect(requestCaret).toHaveBeenCalledWith({
        node: second.firstChild,
        offset: 'two\n'.length,
      })
      // The line element is the closest one, as on the existing path: `li > p` in a loose list.
      expect(scrolled).toEqual([second])
      expect(getValue).not.toHaveBeenCalled()
    })

    it('lands a blank separator line on the next unit', () => {
      expect(reveal(6)).toBe(true)
      const paragraph = editor.querySelector('p[data-block]')!
      expect(requestCaret).toHaveBeenCalledWith({
        node: paragraph.firstChild,
        offset: 0,
      })
    })

    it('selects a range between two units', () => {
      expect(reveal(7, 8)).toBe(true)
      const paragraph = editor.querySelector('p[data-block]')!
      expect(requestCaret).toHaveBeenCalledWith({
        anchor: { node: paragraph.firstChild, offset: 0 },
        focus: { node: paragraph.firstChild, offset: 'para a\npara b'.length },
      })
    })

    it('confirms once when the lines are not confirmed yet', () => {
      confirmed = false
      expect(reveal(8)).toBe(true)
      expect(confirmNow).toHaveBeenCalledTimes(1)
      expect(getValue).not.toHaveBeenCalled()
    })

    it('keeps the existing path when the confirm reports false', () => {
      confirmed = false
      confirmNow.mockImplementation(() => false)
      expect(reveal(8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
    })

    it('keeps the existing path for a foreign root or a model that is not live', () => {
      provideUnitFeed(window, { ...feed, root: document.createElement('div') })
      expect(reveal(8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
      getValue.mockClear()
      provideUnitFeed(window, { ...feed, isLive: () => false })
      expect(reveal(8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
      expect(confirmNow).not.toHaveBeenCalled()
    })

    it('keeps the existing path when Lute is missing or throws for a prose unit', () => {
      delete (window as any).vditor.vditor.lute
      expect(reveal(8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
      getValue.mockClear()
      ;(window as any).vditor.vditor.lute = {
        VditorIRDOM2Md: () => {
          throw new Error('lute failure')
        },
      }
      expect(reveal(8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
    })

    it('leaves a line past the confirmed text to the existing path', () => {
      // The rendered-text path reports "not there yet" (false) so the router retries.
      expect(reveal(40)).toBe(false)
      expect(getValue).toHaveBeenCalledTimes(1)
    })

    it('places a row of a table wrapped in a root child without Lute', () => {
      const table = editor.querySelector('table')!
      const wrapper = document.createElement('div')
      table.replaceWith(wrapper)
      wrapper.append(table)
      lines[4] = { ...lines[4]!, el: wrapper }
      expect(reveal(12)).toBe(true)
      expect(scrolled).toEqual([table.querySelector('tbody tr')])
      expect(toMd).not.toHaveBeenCalled()
      expect(getValue).not.toHaveBeenCalled()
    })

    it('keeps the existing path for a caller without line text', () => {
      expect(revealSourceLine((window as any).vditor, 8)).toBe(true)
      expect(getValue).toHaveBeenCalledTimes(1)
      expect(confirmNow).not.toHaveBeenCalled()
    })
  })
})

describe('unitIndexForLine', () => {
  const el = document.createElement('p')
  const lines = [
    { el, startLine: 2, endLine: 3 },
    { el, startLine: 5, endLine: 5 },
    { el, startLine: 8, endLine: 9 },
  ]
  it('returns the owning unit, else the next, else the last, else the first', () => {
    expect(unitIndexForLine(lines, 3)).toBe(0)
    expect(unitIndexForLine(lines, 4)).toBe(1)
    expect(unitIndexForLine(lines, 9)).toBe(2)
    expect(unitIndexForLine(lines, 40)).toBe(2)
    expect(unitIndexForLine(lines, 0)).toBe(0)
  })
})
