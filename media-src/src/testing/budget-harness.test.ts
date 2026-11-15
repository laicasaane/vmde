// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  type Factor,
  costClock,
  countBudget,
  countedLute,
  fakeLanes,
  irFixture,
  scaledFixture,
  wysiwygFixture,
} from './budget-harness'

const MARKDOWN = [
  'para one',
  '',
  '* a',
  '* b',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
].join('\n')

describe('irFixture', () => {
  it('mounts the Lute IR DOM under div.vditor-ir > pre.vditor-reset', () => {
    const { root } = irFixture(MARKDOWN)
    expect(root.localName).toBe('pre')
    expect(root.classList.contains('vditor-reset')).toBe(true)
    expect(root.parentElement?.classList.contains('vditor-ir')).toBe(true)
    expect(root.isConnected).toBe(true)
    expect(root.querySelector(':scope > table[data-type="table"]')).not.toBe(
      null,
    )
    expect(root.querySelector(':scope > ul > li')).not.toBe(null)
    expect(root.querySelector('[data-type="code-block"]')).not.toBe(null)
  })

  it('builds once per markdown and prepare', () => {
    const prepare = vi.fn((root: HTMLElement) =>
      root.setAttribute('data-prepared', ''),
    )
    const first = irFixture(MARKDOWN, prepare).root
    expect(irFixture(MARKDOWN, prepare).root).toBe(first)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(first.hasAttribute('data-prepared')).toBe(true)
    expect(irFixture(MARKDOWN).root).not.toBe(first)
    expect(irFixture(`${MARKDOWN}\nmore\n`).root).not.toBe(first)
  })
})

describe('wysiwygFixture (013)', () => {
  it('mounts the Lute WYSIWYG DOM under div.vditor-wysiwyg > pre.vditor-reset', () => {
    const { root } = wysiwygFixture(MARKDOWN)
    expect(root.localName).toBe('pre')
    expect(root.classList.contains('vditor-reset')).toBe(true)
    expect(root.getAttribute('contenteditable')).toBe('true')
    expect(root.parentElement?.classList.contains('vditor-wysiwyg')).toBe(true)
    expect(root.isConnected).toBe(true)
    expect(root.querySelector(':scope > table[data-block]')).not.toBe(null)
    expect(root.querySelector(':scope > ul > li')).not.toBe(null)
    expect(
      root.querySelector(
        ':scope > .vditor-wysiwyg__block[data-type="code-block"]',
      ),
    ).not.toBe(null)
    // WYSIWYG DOM: no IR markers.
    expect(root.querySelector('.vditor-ir__node, .vditor-ir__marker')).toBe(
      null,
    )
  })

  it('builds once per markdown and prepare, apart from the IR fixture', () => {
    const prepare = vi.fn((root: HTMLElement) =>
      root.setAttribute('data-prepared', ''),
    )
    const first = wysiwygFixture(MARKDOWN, prepare).root
    expect(wysiwygFixture(MARKDOWN, prepare).root).toBe(first)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(first.hasAttribute('data-prepared')).toBe(true)
    expect(wysiwygFixture(MARKDOWN).root).not.toBe(first)
    expect(wysiwygFixture(`${MARKDOWN}\nmore\n`).root).not.toBe(first)
    expect(irFixture(MARKDOWN, prepare).root).not.toBe(first)
  })
})

describe('scaledFixture', () => {
  it('has the requested shape', () => {
    const root = scaledFixture({
      tables: 2,
      rows: 3,
      listItems: 4,
      paragraphs: 5,
    })
    expect(root.parentElement?.classList.contains('vditor-ir')).toBe(true)
    expect(root.querySelectorAll(':scope > p').length).toBe(5)
    expect(root.querySelectorAll(':scope > ul > li').length).toBe(4)
    const tables = root.querySelectorAll(':scope > table')
    expect(tables.length).toBe(2)
    for (const table of tables) {
      expect(table.querySelectorAll('tbody tr').length).toBe(3)
      expect(table.querySelectorAll('tbody td').length).toBe(15)
      expect(table.querySelectorAll('thead th').length).toBe(5)
    }
  })

  it('omits the list when there are no list items', () => {
    const root = scaledFixture({
      tables: 0,
      rows: 0,
      listItems: 0,
      paragraphs: 1,
    })
    expect(root.querySelector('ul')).toBe(null)
  })
})

function smallRoot(): HTMLElement {
  return scaledFixture({ tables: 1, rows: 2, listItems: 2, paragraphs: 2 })
}

describe('countBudget', () => {
  it('returns the result and zero counts for a run that touches nothing', () => {
    const root = smallRoot()
    const { result, counts } = countBudget(root, () => 42)
    expect(result).toBe(42)
    expect(Object.values(counts).every((value) => value === 0)).toBe(true)
  })

  it('counts root, document and #app queries, table queries and queried nodes', () => {
    const root = smallRoot()
    const table = root.querySelector('table') as HTMLTableElement
    const paragraph = root.querySelector('p') as HTMLElement
    const app = document.createElement('div')
    app.id = 'app'
    document.body.append(app)
    const rootElements = root.querySelectorAll('*').length
    const tableElements = table.querySelectorAll('*').length
    const { counts } = countBudget(root, () => {
      root.querySelectorAll('td')
      root.querySelector('p')
      document.getElementsByTagName('table')
      app.getElementsByClassName('x')
      table.querySelectorAll('td')
      paragraph.querySelector('b')
    })
    expect(counts.rootQueries).toBe(4)
    expect(counts.tableQueries).toBe(1)
    // The selector engine's own traversal is not a walk of the caller.
    expect(counts.nodesWalked).toBe(0)
    expect(counts.queriedNodes).toBe(
      2 * rootElements +
        document.querySelectorAll('*').length +
        0 +
        tableElements +
        0,
    )
    app.remove()
  })

  it('counts tree walker steps and child iteration', () => {
    const root = smallRoot()
    const list = root.querySelector('ul') as HTMLElement
    const { counts } = countBudget(root, () => {
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_ELEMENT)
      let steps = 0
      while (walker.nextNode()) steps++
      const items = [...list.children]
      list.childNodes.forEach(() => {
        steps++
      })
      expect(steps + items.length).toBe(6)
      let child = list.firstChild
      while (child) child = child.nextSibling
    })
    // 2 walker steps, 2 + 2 iterated children, firstChild + nextSibling (2 non-null results).
    expect(counts.nodesWalked).toBe(8)
  })

  it('counts layout reads', () => {
    const root = smallRoot()
    const cell = root.querySelector('td') as HTMLElement
    const { counts } = countBudget(root, () => {
      cell.getBoundingClientRect()
      cell.getClientRects()
      void cell.offsetWidth
      void cell.clientHeight
      void root.scrollTop
      document.createRange().getBoundingClientRect?.()
    })
    const rangeRect =
      typeof Range.prototype.getBoundingClientRect === 'function'
    expect(counts.layoutReads).toBe(rangeRect ? 6 : 5)
  })

  it('counts selection writes and live-range mutations only', () => {
    const root = smallRoot()
    const text = (root.querySelector('p') as HTMLElement).firstChild as Text
    const selection = document.getSelection() as Selection
    const { counts: pair } = countBudget(root, () => {
      const range = document.createRange()
      range.setStart(text, 1)
      selection.removeAllRanges()
      selection.addRange(range)
    })
    expect(pair.selectionWrites).toBe(2)
    const { counts: one } = countBudget(root, () => {
      selection.setBaseAndExtent(text, 0, text, 2)
    })
    expect(one.selectionWrites).toBe(1)
    const { counts: live } = countBudget(root, () => {
      selection.getRangeAt(0).setStart(text, 1)
      selection.getRangeAt(0).cloneRange().setStart(text, 0)
    })
    expect(live.selectionWrites).toBe(1)
  })

  it('counts style insertions and removals', () => {
    const root = smallRoot()
    const { counts } = countBudget(root, () => {
      const style = document.createElement('style')
      document.head.append(style)
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      const holder = document.createElement('div')
      holder.append(link)
      document.body.append(holder)
      style.remove()
      const icon = document.createElement('link')
      icon.rel = 'icon'
      document.head.append(icon)
    })
    expect(counts.styleInsertions).toBe(3)
  })

  it('counts style nodes added or removed by every counted write', () => {
    const root = smallRoot()
    const host = document.createElement('div')
    document.body.append(host)
    const detached = document.createElement('div')
    const { counts } = countBudget(root, () => {
      host.innerHTML = '<style></style><p>x</p>' // +1
      host.insertAdjacentHTML('beforeend', '<link rel="stylesheet">') // +1
      host.insertAdjacentHTML('afterbegin', '<p>no style</p>') // 0
      const style = host.querySelector('style') as Element
      host.appendChild(style) // moved: -1 +1
      host.replaceChild(document.createElement('i'), style) // -1
      ;(host.querySelector('p') as Element).outerHTML = '<style></style>' // +1
      host.removeChild(host.querySelector('link') as Element) // -1
      detached.innerHTML = '<style></style>' // detached: 0
      host.textContent = '' // -1 (the outerHTML style)
      const fragment = document.createDocumentFragment()
      fragment.append(document.createElement('style'))
      host.appendChild(fragment) // +1
      const range = document.createRange()
      range.selectNodeContents(host)
      range.deleteContents() // -1
    })
    expect(counts.styleInsertions).toBe(10)
    host.remove()
  })

  it('counts innerHTML and outerHTML reads on tables, lists, code blocks and the root', () => {
    const { root } = irFixture(MARKDOWN)
    const { counts } = countBudget(root, () => {
      void root.innerHTML
      void (root.querySelector('table') as Element).outerHTML
      void (root.querySelector('ul') as Element).innerHTML
      void (root.querySelector('[data-type="code-block"]') as Element).innerHTML
      void (root.querySelector('[data-type="code-block"] code') as Element)
        .innerHTML
      void (root.querySelector('p') as Element).innerHTML
      void (root.querySelector('li') as Element).innerHTML
    })
    expect(counts.innerHtmlReads).toBe(5)
  })

  it('counts a layout-dependent call after a DOM write as one flush', () => {
    const root = smallRoot()
    const paragraph = root.querySelector('p') as HTMLElement
    const text = paragraph.firstChild as Text
    const selection = document.getSelection() as Selection
    const { counts } = countBudget(root, () => {
      // Clean layout: reads and selection writes before any DOM write are no flush.
      void paragraph.offsetWidth
      selection.setBaseAndExtent(text, 0, text, 1)
      paragraph.appendChild(document.createElement('br'))
      // The first layout-dependent call after the write flushes and clears the dirty flag.
      void paragraph.offsetHeight
      paragraph.getBoundingClientRect()
      selection.getRangeAt(0).setStart(text, 1)
    })
    expect(counts.flushes).toBe(1)
    expect(counts.layoutReads).toBe(3)
    expect(counts.selectionWrites).toBe(2)
  })

  it('counts one flush per write and layout-dependent call pair', () => {
    const root = smallRoot()
    const list = root.querySelector('ul') as HTMLElement
    const item = list.querySelector('li') as HTMLElement
    const selection = document.getSelection() as Selection
    const { counts } = countBudget(root, () => {
      const writes: Array<() => void> = [
        () => list.insertBefore(document.createElement('li'), item),
        () => list.removeChild(list.lastElementChild as Element),
        () => list.replaceChild(document.createElement('li'), item),
        () => (list.firstElementChild as Element).remove(),
        () => {
          const range = document.createRange()
          range.selectNodeContents(list.firstElementChild as Element)
          range.insertNode(document.createElement('wbr'))
        },
        () => {
          const range = document.createRange()
          range.selectNodeContents(list.firstElementChild as Element)
          range.extractContents()
        },
        () => {
          const range = document.createRange()
          range.selectNodeContents(list)
          range.deleteContents()
        },
        () => list.insertAdjacentHTML('beforeend', '<li>a</li>'),
        () => {
          list.innerHTML = '<li>b</li><li>c</li>'
        },
        () => {
          ;(list.firstElementChild as Element).outerHTML = '<li>d</li>'
        },
        () => {
          ;(list.lastElementChild as Element).textContent = 'e'
        },
        () => {
          ;((list.lastElementChild as Element).firstChild as Text).data = 'ef'
        },
        () =>
          ((list.lastElementChild as Element).firstChild as Text).splitText(1),
      ]
      for (const write of writes) {
        write()
        write === writes[0]
          ? void list.clientWidth
          : selection.collapse(list, 0)
      }
      // A write with no later layout-dependent call is no flush.
      list.appendChild(document.createElement('li'))
    })
    expect(counts.flushes).toBe(13)
  })

  it('does not count DOM writes outside a run or by the harness itself', () => {
    const root = smallRoot()
    const paragraph = root.querySelector('p') as HTMLElement
    paragraph.appendChild(document.createElement('br'))
    const { counts } = countBudget(root, () => {
      root.querySelectorAll('td')
      void paragraph.offsetWidth
    })
    expect(counts.flushes).toBe(0)
  })

  it('refuses to nest', () => {
    const root = smallRoot()
    expect(() => countBudget(root, () => countBudget(root, () => 0))).toThrow(
      'do not nest',
    )
  })
})

describe('countBudget restore', () => {
  it('leaves the prototypes as they were after a normal and a failed run', () => {
    const root = smallRoot()
    const query = Element.prototype.querySelectorAll
    const inner = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'innerHTML',
    )
    const addRange = Selection.prototype.addRange
    countBudget(root, () => root.querySelectorAll('p'))
    expect(() =>
      countBudget(root, () => {
        throw new Error('run failed')
      }),
    ).toThrow('run failed')
    expect(Element.prototype.querySelectorAll).toBe(query)
    expect(
      Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML'),
    ).toEqual(inner)
    expect(Selection.prototype.addRange).toBe(addRange)
    // Nothing counts outside a run.
    const { counts } = countBudget(root, () => 0)
    root.querySelectorAll('p')
    expect(counts.rootQueries).toBe(0)
  })
})

const FACTORS: Factor[] = [1, 4, 16]

describe.each(FACTORS)('counts at factor %i', (factor) => {
  it('a table query grows with the table, a cell read does not', () => {
    const root = scaledFixture({
      tables: 1,
      rows: 10 * factor,
      listItems: 0,
      paragraphs: 0,
    })
    const table = root.querySelector('table') as HTMLElement
    const cell = root.querySelector('td') as HTMLElement
    const { counts: query } = countBudget(root, () =>
      table.querySelectorAll('td'),
    )
    expect(query.tableQueries).toBe(1)
    // thead, its row and 5 header cells, tbody, and per body row the row and 5 cells.
    expect(query.queriedNodes).toBe(8 + 60 * factor)
    const { counts: read } = countBudget(root, () => cell.getClientRects())
    expect(read.layoutReads).toBe(1)
    expect(read.queriedNodes).toBe(0)
  })
})

describe('countedLute', () => {
  it('counts conversion calls and input length inside a run only', () => {
    const lute = countedLute({
      Md2VditorIRDOM: (markdown: string) => `<p>${markdown}</p>`,
      VditorIRDOM2Md: (html: string) => html.length,
      SetSpin: (_on: boolean) => undefined,
    })
    expect(countedLute(lute)).toBe(lute)
    const root = smallRoot()
    lute.Md2VditorIRDOM('outside')
    const { result, counts } = countBudget(root, () => {
      lute.SetSpin(true)
      lute.VditorIRDOM2Md('<p>abc</p>')
      return lute.Md2VditorIRDOM('xy')
    })
    expect(result).toBe('<p>xy</p>')
    expect(counts.luteCalls).toBe(2)
    expect(counts.luteChars).toBe(12)
  })
})

describe('costClock', () => {
  it('advances by the default charge per counted operation', () => {
    const clock = costClock()
    const root = smallRoot()
    const elements = root.querySelectorAll('*').length
    const lute = countedLute({ Md2HTML: (markdown: string) => markdown })
    const cell = root.querySelector('td') as HTMLElement
    countBudget(root, () => {
      cell.getBoundingClientRect()
      lute.Md2HTML('a'.repeat(2000))
      root.querySelectorAll('td')
    })
    expect(clock.now()).toBeCloseTo(1 + 0.5 + 0.2 + (0.05 * elements) / 1000)
    clock.advance(3)
    expect(clock.now()).toBeCloseTo(4.7 + (0.05 * elements) / 1000)
  })

  it('takes custom charges, including node steps and mounted cells', () => {
    const clock = costClock({ nodeMs: 1, cellMountMs: 10, layoutReadMs: 0 })
    const root = smallRoot()
    const tbody = root.querySelector('tbody') as HTMLElement
    countBudget(root, () => {
      const walker = document.createTreeWalker(tbody, NodeFilter.SHOW_ELEMENT)
      walker.nextNode()
      const row = document.createElement('tr')
      for (let i = 0; i < 3; i++) row.append(document.createElement('td'))
      tbody.appendChild(row)
      void row.offsetWidth
    })
    // One walker step plus three mounted cells (appending cells to a detached row charges nothing).
    expect(clock.now()).toBeCloseTo(1 + 30)
  })
})

describe('fakeLanes', () => {
  it('runs the frame callbacks queued before runFrame, in order, and honors cancel', () => {
    const lanes = fakeLanes(costClock())
    const order: string[] = []
    lanes.requestAnimationFrame(() => {
      order.push('a')
      lanes.requestAnimationFrame(() => order.push('next'))
    })
    const cancelled = lanes.requestAnimationFrame(() => order.push('x'))
    lanes.requestAnimationFrame(() => order.push('b'))
    lanes.cancelAnimationFrame(cancelled)
    lanes.runFrame()
    expect(order).toEqual(['a', 'b'])
    lanes.runFrame()
    expect(order).toEqual(['a', 'b', 'next'])
    lanes.runFrame()
    expect(order).toEqual(['a', 'b', 'next'])
  })

  it('gives idle callbacks a deadline measured on the clock', () => {
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const remaining: number[] = []
    lanes.requestIdle((deadline) => {
      remaining.push(deadline.timeRemaining())
      clock.advance(3)
      remaining.push(deadline.timeRemaining())
      clock.advance(10)
      remaining.push(deadline.timeRemaining())
    })
    const cancelled = lanes.requestIdle(() => remaining.push(-1))
    lanes.cancelIdle(cancelled)
    lanes.runIdle(8)
    expect(remaining).toEqual([8, 5, 0])
    expect(lanes.now()).toBe(13)
  })

  it('reports no pending input unless the test replaces the method', () => {
    const lanes = fakeLanes(costClock())
    expect(lanes.inputPending()).toBe(false)
    lanes.inputPending = () => true
    expect(lanes.inputPending()).toBe(true)
  })
})
