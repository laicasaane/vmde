// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { createRealLute } from '../testing/real-lute'
import { spinCellHtml, spinListItemHtml, type SpinLute } from './unit-lute'
import type { UnitSpinResult } from '../editing/unit-spin'
import * as unitLute from './unit-lute'

// Task 733 / 002-T: for every cell and top-level list item, the unit spin equals the matching part
// of the block spin (caret marker included). Counts only are reported (no document text).
let lute: SpinLute & { Md2VditorIRDOM(markdown: string): string }
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

// Q-263 (Q-212): under coverage instrumentation "cells: none differ" alone takes 532-544 s (dev and the
// candidate alike) and the full coverage run exceeded 600 s; the per-test limit leaves room for that.
const SPIN_TIMEOUT_MS = 1_500_000

const FIXTURE_DIR = 'test/vscode-e2e/fixtures'
const sources = (): Array<{ name: string; markdown: string }> => {
  const out = [{ name: 'table-heavy-1', markdown: tableHeavyMarkdown(1) }]
  for (const file of fs.readdirSync(FIXTURE_DIR).sort()) {
    if (!file.endsWith('.md')) continue
    out.push({
      name: file,
      markdown: fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'),
    })
  }
  return out
}

interface Counts {
  equal: number
  differing: number
  refused: number
}

const firstText = (el: Element): Text | undefined => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  return (walker.nextNode() as Text | null) ?? undefined
}
const markEnd = (el: Element): void => {
  const text = firstText(el)
  if (text) text.after(document.createElement('wbr'))
  else el.appendChild(document.createElement('wbr'))
}

function listShell(list: Element): string {
  return (list.cloneNode(false) as Element).outerHTML.replace(
    /<\/(ul|ol)>$/u,
    '',
  )
}

const ITEM_ATTRIBUTES = ['class', 'data-marker'] as const

/** What the hook leaves in the block: the unit rewritten in place (cell inner HTML; item inner HTML, class and marker). */
function applyUnitResult(unit: Element, html: string, isTable: boolean): void {
  if (isTable) {
    unit.innerHTML = html
    return
  }
  const holder = document.createElement('template')
  holder.innerHTML = html
  const next = holder.content.firstElementChild as Element
  unit.innerHTML = next.innerHTML
  for (const name of ITEM_ATTRIBUTES) {
    const value = next.getAttribute(name)
    if (value === null) unit.removeAttribute(name)
    else unit.setAttribute(name, value)
  }
}

/**
 * Marks unit `index` of `top`, spins both ways and classifies the outcome. Equal means the whole
 * block after the block spin (every other unit and the list shell included) is what the hook leaves:
 * the input block with only the marked unit rewritten.
 */
function classify(top: Element, index: number): keyof Counts {
  const clone = top.cloneNode(true) as HTMLElement
  const isTable = clone.tagName === 'TABLE'
  const units = isTable
    ? Array.from(clone.querySelectorAll('th,td'))
    : Array.from(clone.children)
  const unit = units[index]
  markEnd(unit)
  const blockOut = document.createElement('div')
  blockOut.innerHTML = lute.SpinVditorIRDOM(clone.outerHTML)
  const result: UnitSpinResult = isTable
    ? spinCellHtml(lute, unit.innerHTML)
    : spinListItemHtml(lute, listShell(clone), unit.outerHTML)
  if (result.kind === 'refused') return 'refused'
  applyUnitResult(unit, result.html, isTable)
  // The block spin is read back through the DOM, so the hook's block is compared as the DOM holds it.
  return blockOut.innerHTML === clone.outerHTML ? 'equal' : 'differing'
}

let memo: Measured | undefined
/** Measured once: the cell and item cases share one pass over the fixtures. */
function measure(): Measured {
  memo ??= measureOnce()
  return memo
}

interface Measured {
  cells: Counts
  items: Counts
  orderedItems: Counts
  fixtures: number
}

/** Adds the outcome of every unit of one top-level table or list to the matching counts. */
function countTop(top: Element, measured: Measured): void {
  const isTable = top.tagName === 'TABLE'
  const total = isTable
    ? top.querySelectorAll('th,td').length
    : top.children.length
  let counts = measured.items
  if (isTable) counts = measured.cells
  else if (top.tagName === 'OL') counts = measured.orderedItems
  for (let index = 0; index < total; index++) counts[classify(top, index)]++
}

function measureOnce(): Measured {
  const empty = (): Counts => ({ equal: 0, differing: 0, refused: 0 })
  const measured: Measured = {
    cells: empty(),
    items: empty(),
    orderedItems: empty(),
    fixtures: 0,
  }
  for (const { markdown } of sources()) {
    const root = document.createElement('div')
    root.innerHTML = lute.Md2VditorIRDOM(markdown)
    const tops = Array.from(root.children).filter((el) =>
      ['TABLE', 'UL', 'OL'].includes(el.tagName),
    )
    if (tops.length === 0) continue
    measured.fixtures++
    for (const top of tops) countTop(top, measured)
  }
  return measured
}

describe('unit spin equals the block spin', () => {
  // A cell refused by the shape check falls back to the block spin, so only a differing result is
  // a defect; the refused count is reported.
  it('cells: none differ', { timeout: SPIN_TIMEOUT_MS }, () => {
    const { cells, fixtures } = measure()
    expect(fixtures).toBeGreaterThan(1)
    expect(cells.equal).toBeGreaterThan(0)
    expect(cells.differing).toBe(0)
    // Q-46: the 12 cells with a code-span pipe at the caret are refused (the block spin runs). A larger
    // count means the shape check lost the gate gain.
    expect(cells.refused).toBeLessThanOrEqual(12)
    // biome-ignore lint/suspicious/noConsole: counts only, read by the decision of 002 action 6
    console.info(
      `unit-spin cells equal=${cells.equal} differing=${cells.differing} refused=${cells.refused}`,
    )
  })

  // Item part of the decision of 002 action 6: items spin only when 0 differ and 0 are refused for
  // the cases the hook accepts. Ordered lists are reported apart: the isolated list renumbers an
  // item to `1.`, so a later item differs.
  it('bullet items: none differ', { timeout: SPIN_TIMEOUT_MS }, () => {
    const { items, orderedItems } = measure()
    // biome-ignore lint/suspicious/noConsole: counts only, read by the decision of 002 action 6
    console.info(
      `unit-spin items(bullet) equal=${items.equal} differing=${items.differing} refused=${items.refused}; items(ordered) equal=${orderedItems.equal} differing=${orderedItems.differing} refused=${orderedItems.refused}`,
    )
    expect(items.equal).toBeGreaterThan(0)
    expect(items.differing).toBe(0)
    // The refused bullet items (nested content, a changed form) measured at the time of writing.
    expect(items.refused).toBeLessThanOrEqual(12)
  })
})

// ---- Task 733 / 011-T: two-item spins equal the block spin (shared rules 3.8, Q-87 Q-E). ----

type SpinListItems = (
  lute: SpinLute,
  listShellOpenTag: string,
  itemsOuterHtml: readonly string[],
) => UnitSpinResult

/** Read at call time, so the cases above run before the function exists. */
const spinListItemsHtml: SpinListItems = (l, shell, items) =>
  (
    unitLute as unknown as { spinListItemsHtml: SpinListItems }
  ).spinListItemsHtml(l, shell, items)

/**
 * The shell the hook builds for an ordered pair: Lute's attribute order, `start` and `data-marker`
 * from the first item of the pair, no `start` for number 1. Bullet and loose lists use their own shell.
 */
function pairShell(list: Element, first: Element): string {
  if (list.tagName !== 'OL' || list.getAttribute('data-tight') !== 'true')
    return listShell(list)
  const marker = /^(\d{1,9})([.)])$/u.exec(
    first.getAttribute('data-marker') ?? '',
  )
  if (!marker) return listShell(list)
  const start = marker[1] === '1' ? '' : ` start="${marker[1]}"`
  const block = list.getAttribute('data-block')
  return `<ol data-tight="true"${start} data-marker="${marker[1]}${marker[2]}"${
    block === null ? '' : ` data-block="${block}"`
  }>`
}

/** Pair (index, index + 1) of `top`, the caret at the end of the second: two-item spin versus block spin. */
function classifyPair(top: Element, index: number): keyof Counts {
  const clone = top.cloneNode(true) as HTMLElement
  const items = Array.from(clone.children)
  const [first, second] = [items[index], items[index + 1]]
  markEnd(second)
  const blockOut = document.createElement('div')
  blockOut.innerHTML = lute.SpinVditorIRDOM(clone.outerHTML)
  const result = spinListItemsHtml(lute, pairShell(clone, first), [
    first.outerHTML,
    second.outerHTML,
  ])
  if (result.kind === 'refused') return 'refused'
  const holder = document.createElement('template')
  holder.innerHTML = result.html
  const spun = Array.from(holder.content.children)
  if (spun.length !== 2) return 'differing'
  applyUnitResult(first, spun[0].outerHTML, false)
  applyUnitResult(second, spun[1].outerHTML, false)
  return blockOut.innerHTML === clone.outerHTML ? 'equal' : 'differing'
}

/** Pair outcomes over every top-level list of the fixtures, bullet and ordered apart. */
function measurePairs(): { bullet: Counts; ordered: Counts } {
  const empty = (): Counts => ({ equal: 0, differing: 0, refused: 0 })
  const out = { bullet: empty(), ordered: empty() }
  for (const { markdown } of sources()) {
    const root = document.createElement('div')
    root.innerHTML = lute.Md2VditorIRDOM(markdown)
    for (const top of Array.from(root.children)) {
      if (top.tagName !== 'UL' && top.tagName !== 'OL') continue
      const counts = top.tagName === 'OL' ? out.ordered : out.bullet
      for (let k = 0; k + 1 < top.children.length; k++)
        counts[classifyPair(top, k)]++
    }
  }
  return out
}

describe('two-item spin equals the block spin (011)', () => {
  it('every adjacent item pair of the fixtures: none differ', {
    timeout: SPIN_TIMEOUT_MS,
  }, () => {
    const { bullet, ordered } = measurePairs()
    // biome-ignore lint/suspicious/noConsole: counts only, no document text
    console.info(
      `two-item spin bullet equal=${bullet.equal} differing=${bullet.differing} refused=${bullet.refused}; ordered equal=${ordered.equal} differing=${ordered.differing} refused=${ordered.refused}`,
    )
    expect(bullet.equal).toBeGreaterThan(0)
    expect(ordered.equal).toBeGreaterThan(0)
    expect(bullet.differing).toBe(0)
    expect(ordered.differing).toBe(0)
  })
})
