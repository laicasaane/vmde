// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  blockModeElement,
  getCursorSourceLine,
  getCursorSourceOffset,
  getTableSourceOffset,
  offsetToLine,
} from './source-map'
import {
  provideUnitFeed,
  type LiveUnit,
  type UnitFeed,
  type UnitLines,
} from './unit-changes'

describe('offsetToLine', () => {
  it('returns 0 for an offset on the first line', () => {
    expect(offsetToLine('hello world', 5)).toBe(0)
  })
  it('counts newlines before the offset', () => {
    //            0          1            2
    const md = 'first\nsecond\nthird\n'
    expect(offsetToLine(md, 0)).toBe(0) // start of "first"
    expect(offsetToLine(md, 6)).toBe(1) // start of "second"
    expect(offsetToLine(md, 13)).toBe(2) // start of "third"
  })
  it('an offset at a newline char belongs to the line it ends', () => {
    // offset 5 is the '\n' after "first" → still line 0
    expect(offsetToLine('first\nsecond', 5)).toBe(0)
  })
  it('clamps a negative offset to line 0', () => {
    expect(offsetToLine('a\nb', -1)).toBe(0)
  })
  it('handles an offset past the end (last line)', () => {
    const md = 'a\nb\nc'
    expect(offsetToLine(md, 999)).toBe(2)
  })
})

describe('getTableSourceOffset', () => {
  // exact mapping: count pipes per row in the markdown source.
  const md = [
    'Intro paragraph.',
    '',
    '| H1 | H2 |',
    '| - | - |',
    '| a | b |',
    '',
  ].join('\n')

  it('maps the header cell (row 0, col 0) to just after its leading pipe', () => {
    // line 2 "| H1 | H2 |", first pipe at col 0 → cell content starts at col 1
    const off = getTableSourceOffset(md, { tableIndex: 0, row: 0, col: 0 })
    // absolute offset of line 2 start = len("Intro paragraph.\n\n") = 18
    expect(off).toBe(18 + 1)
  })
  it('maps the second column of the body row (skips the separator row)', () => {
    // DOM body row 1 → source row index 2 (header row 0, separator row skipped):
    // line "| a | b |". Contract: land just after the column's opening pipe
    // (col 1 = after the 2nd pipe), which sits inside the cell — exactly what
    // reveal-in-source needs.
    const off = getTableSourceOffset(md, { tableIndex: 0, row: 1, col: 1 })
    const line4Start = md.indexOf('| a | b |')
    const afterSecondPipe = '| a | b |'.indexOf('|', '| a '.length) + 1
    expect(off).toBe(line4Start + afterSecondPipe)
  })
  it('returns null when the table index is out of range', () => {
    expect(
      getTableSourceOffset(md, { tableIndex: 5, row: 0, col: 0 }),
    ).toBeNull()
  })
})

// Task 292: the gap cursor is a BLOCK-DOM feature. sv has no block chain — one wrapper div for the
// whole document — so anything boundary-based has to be handed null there, or it treats that wrapper
// as a single atomic block and splices paragraphs into the source at its edges.
describe('blockModeElement', () => {
  // No jsdom in this file's environment (it is a string/offset module otherwise) — and none is
  // needed: blockModeElement only ever looks at `currentMode` and hands back whatever element it
  // finds, so a marker object stands in for the editable.
  const el = { tagName: 'PRE' } as unknown as HTMLElement
  const fake = (mode: string) => ({
    vditor: { currentMode: mode, [mode]: { element: el } },
  })

  it('returns the editable in ir and wysiwyg', () => {
    expect(blockModeElement(fake('ir'))).toBe(el)
    expect(blockModeElement(fake('wysiwyg'))).toBe(el)
  })

  it('returns null in sv, even though an element exists there', () => {
    expect(blockModeElement(fake('sv'))).toBeNull()
  })

  it('returns null when there is no editor at all', () => {
    expect(blockModeElement(undefined)).toBeNull()
    expect(blockModeElement({})).toBeNull()
  })
})

// Task 733 / 006: the caret's line from the caret's top-level model unit. The unit is serialized
// alone (caret token in a clone, the live DOM untouched); a table row needs no Lute call at all.
describe('getCursorSourceLine', () => {
  const CARET = '\u2038'
  let editor: HTMLElement
  let confirmed: boolean
  let confirmNow: ReturnType<typeof vi.fn<() => boolean>>
  let toMd: ReturnType<typeof vi.fn>
  let getValue: ReturnType<typeof vi.fn>
  let vditor: any

  function rig(md = `line one\nab${CARET}cd`, mode = 'ir') {
    document.body.innerHTML =
      '<div id="ed"><p>line one\nabcd</p><ul><li>item</li></ul>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody>' +
      '<tr><td>r1</td></tr><tr><td>r2</td></tr><tr><td>r3</td></tr></tbody></table></div>'
    editor = document.getElementById('ed') as HTMLElement
    const p = editor.querySelector('p')!
    const li = editor.querySelector('li')!
    const table = editor.querySelector('table')!
    const lines: UnitLines[] = [
      { el: p, startLine: 10, endLine: 11 },
      { el: li, startLine: 16, endLine: 16 },
      { el: table, startLine: 80, endLine: 85 },
    ]
    confirmed = true
    confirmNow = vi.fn(() => {
      confirmed = true
      return true
    })
    const liveUnitOf = (node: Node): LiveUnit | undefined => {
      const el = node instanceof HTMLElement ? node : node.parentElement
      const cell = el?.closest('td,th') as HTMLElement | null
      if (cell) {
        return {
          el: cell,
          members: [cell],
          kind: 'cell',
          top: table,
        } as LiveUnit
      }
      const item = el?.closest('li') as HTMLElement | null
      if (item) {
        return {
          el: item,
          members: [item],
          kind: 'list-item',
          top: item.parentElement!,
        } as LiveUnit
      }
      const block = el?.closest('p') as HTMLElement | null
      return block
        ? ({
            el: block,
            members: [block],
            kind: 'paragraph',
            top: block,
          } as LiveUnit)
        : undefined
    }
    const feed: UnitFeed = {
      root: editor,
      isLive: () => true,
      liveUnitOf,
      liveUnits: () => [],
      onUnitsChanged: () => () => undefined,
      confirmNow,
      confirmedLines: () => (confirmed ? lines : undefined),
    }
    provideUnitFeed(window, feed)
    toMd = vi.fn(() => md)
    getValue = vi.fn(() => '')
    vditor = {
      getValue,
      vditor: {
        currentMode: mode,
        [mode]: { element: editor },
        lute: { VditorIRDOM2Md: toMd },
      },
    }
    return { p, li, table, feed }
  }

  const caretAt = (node: Node, offset: number) =>
    window.getSelection()!.setBaseAndExtent(node, offset, node, offset)

  afterEach(() => {
    provideUnitFeed(window, undefined)
    document.body.replaceChildren()
  })

  it('maps a body row to the table start line plus its row index, without Lute', () => {
    const { table } = rig()
    caretAt(table.querySelectorAll('td')[2]!.firstChild!, 1)
    expect(getCursorSourceLine(vditor)).toEqual({ line: 84 })
    expect(toMd).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
  })

  it('maps the header row to the table start line', () => {
    const { table } = rig()
    caretAt(table.querySelector('th')!.firstChild!, 0)
    expect(getCursorSourceLine(vditor)).toEqual({ line: 80 })
  })

  it('finds the line and its text inside a paragraph unit and leaves the live DOM alone', () => {
    const { p } = rig()
    caretAt(p.firstChild!, 'line one\nab'.length)
    const before = p.innerHTML
    const observer = new MutationObserver(() => undefined)
    observer.observe(editor, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    expect(getCursorSourceLine(vditor)).toEqual({ line: 11, lineText: 'abcd' })
    expect(observer.takeRecords()).toEqual([])
    observer.disconnect()
    expect(p.innerHTML).toBe(before)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('serializes a list item inside a copy of its list shell', () => {
    const { li } = rig(`- it${CARET}em`)
    caretAt(li.firstChild!, 2)
    expect(getCursorSourceLine(vditor)).toEqual({
      line: 16,
      lineText: '- item',
    })
    expect(String(toMd.mock.calls[0]![0]).startsWith('<ul')).toBe(true)
  })

  it('never publishes typing when the lines are not confirmed and returns undefined', () => {
    const { p } = rig()
    confirmed = false
    caretAt(p.firstChild!, 'line one\nab'.length)
    expect(getCursorSourceLine(vditor)).toBeUndefined()
    expect(confirmNow).not.toHaveBeenCalled()
  })

  it('returns undefined without calling confirm for no feed, a foreign root or wysiwyg', () => {
    const { p, feed } = rig()
    caretAt(p.firstChild!, 1)
    provideUnitFeed(window, undefined)
    expect(getCursorSourceLine(vditor)).toBeUndefined()
    provideUnitFeed(window, { ...feed, root: document.createElement('div') })
    expect(getCursorSourceLine(vditor)).toBeUndefined()
    provideUnitFeed(window, feed)
    vditor.vditor.currentMode = 'wysiwyg'
    vditor.vditor.wysiwyg = { element: editor }
    expect(getCursorSourceLine(vditor)).toBeUndefined()
    expect(confirmNow).not.toHaveBeenCalled()
  })

  it('returns undefined when the unit Markdown lost the caret', () => {
    const { p } = rig('line one\nabcd')
    caretAt(p.firstChild!, 1)
    expect(getCursorSourceLine(vditor)).toBeUndefined()
  })

  it('returns undefined when the confirm or the unit lookup throws', () => {
    const { p, feed } = rig()
    caretAt(p.firstChild!, 1)
    confirmed = false
    confirmNow.mockImplementation(() => {
      throw new Error('feed failure')
    })
    expect(getCursorSourceLine(vditor)).toBeUndefined()
    confirmed = true
    provideUnitFeed(window, {
      ...feed,
      liveUnitOf: () => {
        throw new Error('feed failure')
      },
    })
    expect(getCursorSourceLine(vditor)).toBeUndefined()
  })

  it('places the caret token when the selection anchor is an element', () => {
    const { p } = rig(`line one\nabcd${CARET}`)
    caretAt(p, p.childNodes.length)
    expect(getCursorSourceLine(vditor)).toEqual({ line: 11, lineText: 'abcd' })
    expect(String(toMd.mock.calls[0]![0])).toContain(CARET)
    expect(p.textContent).toBe('line one\nabcd')
  })
})

// The IR front matter preview is a <table> that is not a Markdown table: it must not shift the
// table index of the caret's table.
describe('getCursorSourceOffset with front matter', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('maps a cell of the first Markdown table although a front matter table precedes it', () => {
    const md =
      '---\ntitle: x\n---\n\n| H |\n| - |\n| a |\n\n| H2 |\n| - |\n| b |\n'
    document.body.innerHTML =
      '<div id="ed"><div class="vmde-front-matter"><table><tr><td>title</td></tr></table></div>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table></div>'
    const editor = document.getElementById('ed') as HTMLElement
    const cell = editor
      .querySelectorAll('table')[1]!
      .querySelector('tbody td') as HTMLElement
    window
      .getSelection()!
      .setBaseAndExtent(cell.firstChild!, 0, cell.firstChild!, 0)
    const vditor = {
      getValue: () => md,
      vditor: { currentMode: 'ir', ir: { element: editor } },
    }
    expect(getCursorSourceOffset(vditor)).toBe(
      getTableSourceOffset(md, { tableIndex: 0, row: 1, col: 0 }),
    )
  })
})
