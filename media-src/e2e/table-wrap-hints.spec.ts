// Task 640 S2d - wrap hints in table cells (acceptance item 1, tables), in the real webview entry in
// IR, WYSIWYG and Preview. Table cells join the wrap-hint engine:
//  - Task 639 measures min-content on a clone that carries the priority-1 hints, so a path column
//    can shrink without breaking inside a word;
//  - priority-2/3 hints are planned against the applied widths (automatic, or a Task 219 manual
//    width) and only inside pieces that are still wider than the cell's content width;
//  - a Task 219 drag end and a double-click auto-fit plan the cells again.
// Expected offsets come from the contract (tasks/done/640-long-word-wrap-break-priority.md, Part 1
// revision sections 3 and 4) worked out by hand per token; which of them are planned is decided in
// the page from measured piece widths (the same tier gating as the contract), so the cases hold in
// any font. The fixture is fixtures/wrap-hints-tables.md.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'
import {
  getValue,
  type Mode,
  openEditor,
  postHistory,
  toPreview,
} from './wrap-hints-helpers'

const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures/wrap-hints-tables.md'),
  'utf8',
)
const PATH =
  '../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs'

type Surface = Mode | 'preview'
const SURFACE: Record<Surface, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  preview: '.vditor-preview .vditor-reset',
}

/** A long token of the fixture: where it is and the positions each priority tier can offer. */
interface Token {
  table: number
  row: number
  col: number
  text: string
  p1: number[]
  p2: number[]
  p3: number[]
}

// Table order in the fixture: 0 Owner table, 1 short table, 2 identifier/CJK table, 3 build path/link.
const OWNER: Token = {
  table: 0,
  row: 1,
  col: 0,
  text: PATH,
  // ../ | EncosyTower. | Tests. | EditorMode/ | EncosyTower. | PageFlows/ | PageFlowTestDoubles.cs
  // (74 is dropped by the final-piece rule, N = 3).
  p1: [3, 15, 21, 32, 44, 54],
  p2: [],
  p3: [9, 27, 38, 48, 58, 62, 66],
}
const CAMEL: Token = {
  table: 2,
  row: 1,
  col: 0,
  text: 'GetTableListViewModelFactoryProvider',
  p1: [],
  p2: [],
  p3: [3, 8, 12, 16, 21, 28],
}
const DIGIT: Token = {
  table: 3,
  row: 1,
  col: 0,
  text: 'Shaders/URP17Compat/LitPass2D.hlsl',
  p1: [8, 20, 30],
  p2: [11, 13, 27, 28],
  p3: [23],
}
const LINK: Token = { ...OWNER, table: 3, col: 1 }

/**
 * In-page reader (window.__th): hint offsets and rendered breaks of one token, piece widths, the
 * cell's line width, and the tier-gated expectation for the current line width.
 */
async function installReader(page: Page, surface: Surface) {
  await page.evaluate((selector) => {
    const isHint = (n: Node) =>
      n.nodeType === 1 && (n as Element).classList.contains('vmde-wrap-hint')
    interface Found {
      cell: HTMLTableCellElement
      parent: Element
      nodes: Text[]
      offsets: number[]
      start: number
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered table cell
    function find(t: {
      table: number
      row: number
      col: number
      text: string
    }): Found {
      const table = document.querySelectorAll(`${selector} table`)[
        t.table
      ] as HTMLTableElement
      const cell = table.rows[t.row].cells[t.col]
      for (const el of [cell, ...cell.querySelectorAll('*')]) {
        if (el.closest('.vditor-ir__marker')) continue
        let nodes: Text[] = []
        let offsets: number[] = []
        let length = 0
        const check = (): Found | null => {
          const text = nodes.map((n) => n.data).join('')
          return text.includes(t.text)
            ? { cell, parent: el, nodes, offsets, start: text.indexOf(t.text) }
            : null
        }
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === 3) {
            nodes.push(child as Text)
            length += (child as Text).length
          } else if (isHint(child)) offsets.push(length)
          else {
            const hit = check()
            if (hit) return hit
            nodes = []
            offsets = []
            length = 0
          }
        }
        const hit = check()
        if (hit) return hit
      }
      throw new Error(`token not found: ${t.text}`)
    }
    const locate = (
      f: Found,
      offset: number,
      atEnd: boolean,
    ): [Text, number] => {
      let rest = f.start + offset
      for (const node of f.nodes) {
        if (rest < node.length || (atEnd && rest === node.length))
          return [node, rest]
        rest -= node.length
      }
      const last = f.nodes[f.nodes.length - 1]
      return [last, last.length]
    }
    const width = (f: Found, a: number, b: number) => {
      const range = document.createRange()
      range.setStart(...locate(f, a, false))
      range.setEnd(...locate(f, b, true))
      let sum = 0
      for (const rect of Array.from(range.getClientRects())) sum += rect.width
      return sum
    }
    // The engine's line box: the cell's content width, minus an inline parent's own padding+border.
    const line = (f: Found) => {
      const cs = getComputedStyle(f.cell)
      let w =
        f.cell.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight)
      if (f.parent !== f.cell) {
        const ps = getComputedStyle(f.parent)
        w -=
          parseFloat(ps.paddingLeft) +
          parseFloat(ps.paddingRight) +
          parseFloat(ps.borderLeftWidth) +
          parseFloat(ps.borderRightWidth)
      }
      return w
    }
    type T = { table: number; row: number; col: number; text: string }
    ;(window as any).__th = {
      hints: (t: T) => {
        const f = find(t)
        return f.offsets.map((o) => o - f.start)
      },
      width: (t: T, a: number, b: number) => width(find(t), a, b),
      line: (t: T) => line(find(t)),
      cellWidth: (t: T) => find(t).cell.getBoundingClientRect().width,
      // Rendered line breaks strictly inside the token (offsets in the token).
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered table cell
      breaks: (t: T) => {
        const f = find(t)
        const range = document.createRange()
        const out: number[] = []
        let top: number | null = null
        let offset = 0
        for (const node of f.nodes) {
          for (let i = 0; i < node.length; i += 1) {
            range.setStart(node, i)
            range.setEnd(node, i + 1)
            const rect = range.getClientRects()[0]
            if (rect) {
              const tp = Math.round(rect.top)
              if (
                top !== null &&
                tp > top + 2 &&
                offset > f.start &&
                offset - f.start < t.text.length
              )
                out.push(offset - f.start)
              if (top === null || tp > top + 2) top = tp
            }
            offset += 1
          }
        }
        return out
      },
      // The contract's tier gating applied to the measured pieces at the current line width.
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered table cell
      expected: (t: T, p1: number[], p2: number[], p3: number[]) => {
        const f = find(t)
        const limit = line(f)
        if (width(f, 0, t.text.length) <= limit) return []
        let cuts: number[] = []
        for (const tier of [p1, p2, p3]) {
          const bounds = [0, ...cuts, t.text.length]
          const added: number[] = []
          for (let i = 1; i < bounds.length; i += 1)
            if (width(f, bounds[i - 1], bounds[i]) > limit)
              for (const p of tier)
                if (p > bounds[i - 1] && p < bounds[i]) added.push(p)
          cuts = [...cuts, ...added].sort((x, y) => x - y)
        }
        return cuts
      },
      // Hints anywhere in a cell (count), and the width of a handle target for dragging.
      cellHints: (table: number, row: number, col: number) =>
        (
          document.querySelectorAll(`${selector} table`)[
            table
          ] as HTMLTableElement
        ).rows[row].cells[col].querySelectorAll('.vmde-wrap-hint').length,
      tableHints: (table: number) =>
        document
          .querySelectorAll(`${selector} table`)
          [table].querySelectorAll('.vmde-wrap-hint').length,
      handle: (table: number, col: number) => {
        const tbl = document.querySelectorAll(`${selector} table`)[
          table
        ] as HTMLTableElement
        const th = tbl.rows[0].cells[col].getBoundingClientRect()
        for (const h of document.querySelectorAll(
          '.vmde-table-resize-handle',
        )) {
          const r = h.getBoundingClientRect()
          const cx = r.left + r.width / 2
          if (
            Math.abs(cx - th.right) < 10 &&
            r.top < th.bottom &&
            r.bottom > th.top
          )
            return { x: cx, y: r.top + r.height / 2 }
        }
        return null
      },
    }
  }, SURFACE[surface])
}

const th = {
  hints: (page: Page, t: Token) =>
    page.evaluate((x) => (window as any).__th.hints(x) as number[], t),
  width: (page: Page, t: Token, a: number, b: number) =>
    page.evaluate(
      ([x, p, q]) => (window as any).__th.width(x, p, q) as number,
      [t, a, b] as const,
    ),
  line: (page: Page, t: Token) =>
    page.evaluate((x) => (window as any).__th.line(x) as number, t),
  cellWidth: (page: Page, t: Token) =>
    page.evaluate((x) => (window as any).__th.cellWidth(x) as number, t),
  breaks: (page: Page, t: Token) =>
    page.evaluate((x) => (window as any).__th.breaks(x) as number[], t),
  expected: (page: Page, t: Token) =>
    page.evaluate(
      (x) => (window as any).__th.expected(x, x.p1, x.p2, x.p3) as number[],
      t,
    ),
  cellHints: (page: Page, table: number, row: number, col: number) =>
    page.evaluate(
      ([a, b, c]) => (window as any).__th.cellHints(a, b, c) as number,
      [table, row, col] as const,
    ),
  tableHints: (page: Page, table: number) =>
    page.evaluate((a) => (window as any).__th.tableHints(a) as number, table),
}

/** The hints of a token settle to the contract's expectation for its current line width. */
async function expectPlanned(page: Page, t: Token, label: string) {
  await expect
    .poll(
      async () => {
        const expected = await th.expected(page, t)
        return JSON.stringify([await th.hints(page, t), expected])
      },
      { timeout: 10_000, message: label },
    )
    .toMatch(/^\[(\[[\d,]*\]),\1\]$/)
  return th.hints(page, t)
}

/** Every rendered break inside the token is one of its planned hints. */
async function expectBreaksAtHints(page: Page, t: Token, label: string) {
  const hints = await th.hints(page, t)
  for (const offset of await th.breaks(page, t))
    expect(hints, `${label}: break at ${offset}`).toContain(offset)
}

async function waitForAutoWidth(page: Page, surface: Surface, table: number) {
  await page.waitForFunction(
    ([selector, index]) =>
      /vmde-table-auto-\d+/u.test(
        document
          .querySelectorAll(`${selector} table`)
          [index as number]?.getAttribute('class') ?? '',
      ),
    [SURFACE[surface], table] as const,
  )
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function handleAt(page: Page, table: number, col: number) {
  const point = await page.evaluate(
    ([a, b]) =>
      (window as any).__th.handle(a, b) as { x: number; y: number } | null,
    [table, col] as const,
  )
  expect(point, `resize handle ${table}/${col}`).not.toBeNull()
  return point as { x: number; y: number }
}

/** Task 219 drag of one column border; the engine plans the cells again at the end of the drag. */
async function drag(page: Page, table: number, col: number, dx: number) {
  const { x, y } = await handleAt(page, table, col)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

/** Drag until the token's line width is `wanted` px (one correction pass). */
async function dragToLine(page: Page, t: Token, wanted: number) {
  for (let pass = 0; pass < 2; pass += 1) {
    const delta = wanted - (await th.line(page, t))
    if (Math.abs(delta) <= 2) return
    await drag(page, t.table, t.col, delta)
    await page.waitForTimeout(150)
  }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`${mode}: wrap hints in table cells`, () => {
    test.beforeEach(async ({ page }) => {
      test.setTimeout(120_000)
      await openEditor(page, mode, FIXTURE)
      await installReader(page, mode)
      for (const table of [0, 2, 3]) await waitForAutoWidth(page, mode, table)
    })

    test('automatic widths: the path column breaks only at priority-1 positions and is narrower than its equal share', async ({
      page,
    }) => {
      expect(await expectPlanned(page, OWNER, 'owner')).toEqual(OWNER.p1)
      // The path column is narrower than the equal share the over-wide fallback would give it.
      const widths = await page.evaluate((selector) => {
        const table = document.querySelectorAll(
          `${selector} table`,
        )[0] as HTMLTableElement
        const cells = Array.from(table.rows[0].cells)
        return {
          first: cells[0].getBoundingClientRect().width,
          table: table.getBoundingClientRect().width,
          columns: cells.length,
        }
      }, SURFACE[mode])
      expect(widths.first).toBeLessThan(widths.table / widths.columns - 8)
      // Column 1 lines contain only priority-1 breaks.
      const breaks = await th.breaks(page, OWNER)
      expect(breaks.length).toBeGreaterThan(0)
      for (const offset of breaks) expect(OWNER.p1).toContain(offset)
      // Other cells whose content fits get no hint: the change column, and the short table.
      expect(await th.cellHints(page, 0, 1, 1)).toBe(0)
      expect(await th.tableHints(page, 1)).toBe(0)
    })

    test('automatic widths: digit path, camel-case identifier, link text and CJK/emoji follow the contract', async ({
      page,
    }) => {
      for (const [token, label] of [
        [CAMEL, 'camel'],
        [DIGIT, 'digit'],
        [LINK, 'link'],
      ] as const) {
        await expectPlanned(page, token, label)
        await expectBreaksAtHints(page, token, label)
      }
      // The link text is hinted at priority 1 like the Owner path (its URL is a hidden marker).
      expect(await th.hints(page, LINK)).toEqual(await th.expected(page, LINK))
      // CJK and emoji are one run with no ASCII separator: no hint, and the text is unchanged.
      expect(await th.cellHints(page, 2, 2, 0)).toBe(0)
    })

    test('a manual width forces lower tiers only inside pieces that are still too wide; drag end and auto-fit plan again', async ({
      page,
    }) => {
      await expectPlanned(page, OWNER, 'owner automatic')
      const pieces = await Promise.all(
        [0, 3, 15, 21, 32, 44, 54].map((a, i, all) =>
          th.width(page, OWNER, a, all[i + 1] ?? PATH.length),
        ),
      )
      const widest = Math.max(...pieces)
      await dragToLine(page, OWNER, widest * 0.6)
      const planned = await expectPlanned(page, OWNER, 'owner manual')
      // Lower tiers appeared, only inside the wide last piece (offsets 54..76), never before `cs`.
      expect(planned.length).toBeGreaterThan(OWNER.p1.length)
      for (const offset of planned) {
        expect([...OWNER.p1, ...OWNER.p3]).toContain(offset)
        if (!OWNER.p1.includes(offset)) expect(offset).toBeGreaterThan(54)
      }
      expect(planned).not.toContain(74)
      await expectBreaksAtHints(page, OWNER, 'owner manual')
      expect(
        await page.evaluate(
          (selector) =>
            document
              .querySelectorAll(`${selector} table`)[0]
              .classList.contains('vmde-table-resized'),
          SURFACE[mode],
        ),
      ).toBe(true)

      // Digit path: priority 2 inside a wide priority-1 piece, from the measured widths.
      const urp = await th.width(page, DIGIT, 8, 20)
      await dragToLine(page, DIGIT, urp * 0.8)
      const digit = await expectPlanned(page, DIGIT, 'digit manual')
      expect(digit).toEqual(expect.arrayContaining([8, 20, 30]))
      expect(digit.some((o) => DIGIT.p2.includes(o))).toBe(true)
      await expectBreaksAtHints(page, DIGIT, 'digit manual')

      // Camel-case identifier: no priority-1 or 2 position, so every priority-3 position.
      const camelWidth = await th.width(page, CAMEL, 0, CAMEL.text.length)
      await dragToLine(page, CAMEL, camelWidth * 0.5)
      expect(await expectPlanned(page, CAMEL, 'camel manual')).toEqual(CAMEL.p3)
      await expectBreaksAtHints(page, CAMEL, 'camel manual')

      // Double-click auto-fit on the Owner column: the whole path fits, so the hints go away.
      const { x, y } = await handleAt(page, 0, 0)
      await page.mouse.dblclick(x, y)
      await expect
        .poll(() => th.hints(page, OWNER), { timeout: 10_000 })
        .toEqual([])
      expect(await th.expected(page, OWNER)).toEqual([])
    })

    test('hints are view-only: bytes, posted edits, Undo depth and the snapshot are unchanged', async ({
      page,
    }) => {
      const before = await getValue(page)
      const depth = () =>
        page.evaluate(() => {
          const inner = (window as any).vditor.vditor
          return inner.undo[inner.currentMode].undoStack.length
        })
      const depthBefore = await depth()
      const pieceWidth = await th.width(page, OWNER, 54, PATH.length)
      await dragToLine(page, OWNER, pieceWidth * 0.6)
      expect(
        (await expectPlanned(page, OWNER, 'narrow')).length,
      ).toBeGreaterThan(OWNER.p1.length)
      await page.waitForTimeout(1500)
      expect(await getValue(page)).toBe(before)
      const state = await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        const slot = inner.undo[inner.currentMode]
        return {
          snapshotHasHint: String(slot.lastText).includes('vmde-wrap-hint'),
          edits: (window as any).__posted.filter(
            (m: any) => m.command === 'edit',
          ).length,
        }
      })
      expect(state).toEqual({ snapshotHasHint: false, edits: 0 })
      expect(await depth()).toBe(depthBefore)
    })

    test('typing in a hinted cell keeps exact bytes and one Undo restores them; the hints come back', async ({
      page,
    }) => {
      const original = await getValue(page)
      const pieceWidth = await th.width(page, OWNER, 54, PATH.length)
      await dragToLine(page, OWNER, pieceWidth * 0.6)
      const planned = await expectPlanned(page, OWNER, 'before typing')
      expect(planned.length).toBeGreaterThan(OWNER.p1.length)

      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['Tests.EditorMode', 0, 0] as const)
      await page.keyboard.press('Shift')
      await page.keyboard.type('XY')
      const typed = original.replace('Tests.EditorMode', 'XYTests.EditorMode')
      // Lute pads the table columns to the longest cell, so compare without the padding.
      const unpadded = (text: string) =>
        text.replace(/ +/g, ' ').replace(/-{3,}/g, '---')
      await expect
        .poll(async () => unpadded(await getValue(page)), { timeout: 8000 })
        .toBe(unpadded(typed))
      await page.waitForTimeout(1300)
      await postHistory(page, 'undo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)
      // The cell is planned again after the Undo restore (the pause and the rebuild).
      await expect
        .poll(() => th.hints(page, OWNER), { timeout: 10_000 })
        .toEqual(await th.expected(page, OWNER))
    })
  })
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: the first automatic layout already shrinks the path column`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    // Record every width rule Task 639 writes, from the first one, so the layout the table got
    // before any later re-measure is what is checked. (That the measurement clone itself carries the
    // priority-1 hints is proven in responsive-tables.test.ts: the live hint engine usually writes
    // its hints first, so this case alone cannot tell the clone hints from the live ones.)
    await page.addInitScript(() => {
      const win = window as any
      win.__autoRules = [] as string[]
      new MutationObserver(() => {
        for (const style of document.querySelectorAll('head style'))
          if ((style.textContent ?? '').includes('vmde-table-auto-'))
            win.__autoRules.push(style.textContent)
      }).observe(document, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    })
    await openEditor(page, mode, FIXTURE)
    await installReader(page, mode)
    await waitForAutoWidth(page, mode, 0)
    const first = await page.evaluate((selector) => {
      const table = document.querySelectorAll(`${selector} table`)[0]
      const name = /vmde-table-auto-\d+/u.exec(
        table.getAttribute('class') ?? '',
      )?.[0]
      const rule = ((window as any).__autoRules as string[]).find((text) =>
        text.includes(`table.${name} `),
      )
      return [
        ...(rule ?? '').matchAll(/nth-child\((\d+)\)[^}]*width: ([\d.]+)px/gu),
      ].map((m) => Number(m[2]))
    }, SURFACE[mode])
    expect(first).toHaveLength(2)
    // Without the priority-1 pieces the path's min-content (the whole path) exceeds the table and the
    // allocation falls back to equal columns; with them column 1 is clearly narrower than column 2.
    expect(first[0]).toBeLessThan(first[1] * 0.8)
  })
}

test.describe('preview: wrap hints in table cells', () => {
  test('the same priority-1 layout holds in Preview', async ({ page }) => {
    test.setTimeout(120_000)
    await openEditor(page, 'ir', FIXTURE)
    await toPreview(page)
    await installReader(page, 'preview')
    await waitForAutoWidth(page, 'preview', 0)
    expect(await expectPlanned(page, OWNER, 'preview owner')).toEqual(OWNER.p1)
    const breaks = await th.breaks(page, OWNER)
    expect(breaks.length).toBeGreaterThan(0)
    for (const offset of breaks) expect(OWNER.p1).toContain(offset)
    const widths = await page.evaluate((selector) => {
      const table = document.querySelectorAll(
        `${selector} table`,
      )[0] as HTMLTableElement
      const cells = Array.from(table.rows[0].cells)
      return {
        first: cells[0].getBoundingClientRect().width,
        table: table.getBoundingClientRect().width,
        columns: cells.length,
      }
    }, SURFACE.preview)
    expect(widths.first).toBeLessThan(widths.table / widths.columns - 8)
    for (const token of [CAMEL, DIGIT, LINK]) {
      await expectPlanned(page, token, 'preview')
      await expectBreaksAtHints(page, token, 'preview')
    }
    expect(await th.tableHints(page, 1)).toBe(0)
    expect(await th.cellHints(page, 2, 2, 0)).toBe(0)
  })
})
