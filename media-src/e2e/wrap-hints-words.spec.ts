// Task 640 S2c — wrap hints for words that are not inline code (plain text, bold, link text,
// headings, list items and callouts), in the real webview entry in IR, WYSIWYG and Preview.
// Expected hint positions come from the Owner contract (tasks/640-long-word-wrap-break-priority.md,
// "Part 1 revision" sections 3 and 4) applied by hand to the Owner path:
//   ../ | EncosyTower. | Tests. | EditorMode/ | EncosyTower. | PageFlows/ | PageFlowTestDoubles.cs
//   priority-1 offsets 3 15 21 32 44 54 (74 is dropped by the final-piece rule, N = 3), and the
//   priority-3 offsets inside each priority-1 piece: 9 | 27 | 38 | 48 | 58 62 66.
// A priority-1 piece gets its priority-3 hints only when the piece alone is wider than the line.
// Piece widths are read from the page (Range rects of the path's own text), the line width from the
// container, so the regimes hold in any font:
//   WIDE    the whole path fits: no hint;
//   MID     the widest priority-1 piece fits (1.25 x its width): priority 1 only;
//   NARROW  0.8 x the width of the last priority-1 piece: priority 3 inside the pieces wider than that.
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
  path.join(__dirname, 'fixtures/wrap-hints-words.md'),
  'utf8',
)
const PATH_LENGTH = 76
const P1 = [3, 15, 21, 32, 44, 54]
// Priority-1 pieces and the priority-3 offsets that lie inside them.
const P1_BOUNDS = [0, 3, 15, 21, 32, 44, 54, PATH_LENGTH]
const P3_ALL = [9, 27, 38, 48, 58, 62, 66]

type Surface = Mode | 'preview'
type Context = 'plain' | 'bold' | 'link' | 'heading' | 'list' | 'callout'
const CONTEXTS: Context[] = [
  'plain',
  'bold',
  'link',
  'heading',
  'list',
  'callout',
]
const SURFACE: Record<Surface, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  preview: '.vditor-preview .vditor-reset',
}

/** In-page reader of the Owner path in one context (installed once per page as window.__wh). */
async function installReader(page: Page, surface: Surface) {
  await page.evaluate((selector) => {
    const TAIL = 'PageFlowTestDoubles.cs'
    const root = () => document.querySelector(selector) as HTMLElement
    const isHint = (n: Node) =>
      n.nodeType === 1 && (n as Element).classList.contains('vmde-wrap-hint')
    interface Found {
      el: Element
      nodes: Text[]
      offsets: number[]
      start: number
    }
    // Runs of consecutive Text/hint children of every element that hold the path.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered path
    function candidates(): Found[] {
      const found: Found[] = []
      for (const el of root().querySelectorAll('*')) {
        let nodes: Text[] = []
        let offsets: number[] = []
        let length = 0
        const flush = () => {
          const text = nodes.map((n) => n.data).join('')
          if (text.includes(TAIL) && text.includes('../'))
            found.push({ el, nodes, offsets, start: text.indexOf('../') })
          nodes = []
          offsets = []
          length = 0
        }
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === 3) {
            nodes.push(child as Text)
            length += (child as Text).length
          } else if (isHint(child)) offsets.push(length)
          else flush()
        }
        flush()
      }
      return found
    }
    const visible = (found: Found) => {
      const range = document.createRange()
      range.selectNodeContents(found.el)
      return range.getClientRects().length > 0
    }
    function pick(ctx: string): Found {
      const all = candidates().filter(
        (f) =>
          !f.el.closest(
            'code, table, .vditor-ir__marker, [data-type="img"], img',
          ),
      )
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered path
      const by = (f: Found): string => {
        const tag = f.el.tagName
        if (/^H[1-6]$/.test(tag)) return 'heading'
        if (tag === 'STRONG') return 'bold'
        if (tag === 'A' || f.el.classList.contains('vditor-ir__link'))
          return 'link'
        if (f.el.closest('blockquote')) return 'callout'
        if (f.el.closest('li') && !f.el.closest('li p, li blockquote'))
          return 'list'
        if (f.el.closest('li')) return 'list'
        return 'plain'
      }
      const hit = all.find((f) => by(f) === ctx && visible(f))
      if (!hit) throw new Error(`no visible path in context ${ctx}`)
      return hit
    }
    const locate = (
      found: Found,
      offset: number,
      atEnd: boolean,
    ): [Text, number] => {
      let rest = found.start + offset
      for (const node of found.nodes) {
        if (rest < node.length || (atEnd && rest === node.length))
          return [node, rest]
        rest -= node.length
      }
      const last = found.nodes[found.nodes.length - 1]
      return [last, last.length]
    }
    const width = (found: Found, a: number, b: number) => {
      const range = document.createRange()
      range.setStart(...locate(found, a, false))
      range.setEnd(...locate(found, b, true))
      let sum = 0
      for (const rect of Array.from(range.getClientRects())) sum += rect.width
      return sum
    }
    ;(window as any).__wh = {
      width: (ctx: string, a: number, b: number) => width(pick(ctx), a, b),
      hints: (ctx: string) => pick(ctx).offsets.map((o) => o - pick(ctx).start),
      lineWidth: (ctx: string) => {
        const f = pick(ctx)
        const box = f.el.closest(
          'p, li, h1, h2, h3, h4, h5, h6, blockquote',
        ) as HTMLElement
        const style = getComputedStyle(box)
        return (
          box.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight)
        )
      },
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page reader of the rendered path
      breaks: (ctx: string) => {
        const f = pick(ctx)
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
              const t = Math.round(rect.top)
              if (
                top !== null &&
                t > top + 2 &&
                offset > f.start &&
                offset - f.start < 76
              )
                out.push(offset - f.start)
              if (top === null || t > top + 2) top = t
            }
            offset += 1
          }
        }
        return out
      },
    }
  }, SURFACE[surface])
}

const wh = {
  width: (page: Page, ctx: Context, a: number, b: number) =>
    page.evaluate(
      ([c, x, y]) => (window as any).__wh.width(c, x, y) as number,
      [ctx, a, b] as const,
    ),
  hints: (page: Page, ctx: Context) =>
    page.evaluate((c) => (window as any).__wh.hints(c) as number[], ctx),
  lineWidth: (page: Page, ctx: Context) =>
    page.evaluate((c) => (window as any).__wh.lineWidth(c) as number, ctx),
  breaks: (page: Page, ctx: Context) =>
    page.evaluate((c) => (window as any).__wh.breaks(c) as number[], ctx),
}

/** Resize the viewport until the context's line box is `wanted` px wide (+- 2.5 px). */
async function fitWidth(page: Page, ctx: Context, wanted: number) {
  let viewport = 1000
  for (let i = 0; i < 5; i += 1) {
    await page.setViewportSize({
      width: Math.max(100, Math.round(viewport)),
      height: 900,
    })
    const width = await wh.lineWidth(page, ctx)
    if (Math.abs(width - wanted) <= 2.5) return
    viewport += wanted - width
  }
  expect(
    Math.abs((await wh.lineWidth(page, ctx)) - wanted),
    `fit ${ctx} to ${Math.round(wanted)}`,
  ).toBeLessThanOrEqual(5)
}

/** The hints the contract gives for a line `line` px wide, from the measured piece widths. */
async function expectedHints(page: Page, ctx: Context, line: number) {
  if ((await wh.width(page, ctx, 0, PATH_LENGTH)) <= line) return []
  const planned = new Set(P1)
  for (let i = 0; i + 1 < P1_BOUNDS.length; i += 1) {
    const [a, b] = [P1_BOUNDS[i], P1_BOUNDS[i + 1]]
    if ((await wh.width(page, ctx, a, b)) > line)
      for (const position of P3_ALL)
        if (position > a && position < b) planned.add(position)
  }
  return [...planned].sort((x, y) => x - y)
}

async function regimes(page: Page, ctx: Context) {
  const pieces = await Promise.all(
    P1_BOUNDS.slice(0, -1).map((a, i) =>
      wh.width(page, ctx, a, P1_BOUNDS[i + 1]),
    ),
  )
  return {
    wide: (await wh.width(page, ctx, 0, PATH_LENGTH)) + 24,
    mid: Math.max(...pieces) * 1.25,
    narrow: pieces[pieces.length - 1] * 0.8,
  }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`${mode}: wrap hints for words that are not inline code`, () => {
    test.beforeEach(async ({ page }) => {
      test.setTimeout(120_000)
      await openEditor(page, mode, FIXTURE)
      await installReader(page, mode)
    })

    test('a long path in plain text, bold, link text, a heading, a list item and a callout wraps only at planned positions', async ({
      page,
    }) => {
      for (const ctx of CONTEXTS) {
        const target = await regimes(page, ctx)
        // WIDE: acceptance "a word that fits gets no hint". The editor column is about 800 px
        // wide, which the path in heading type does not fit, so a heading has no WIDE regime.
        if (ctx !== 'heading') {
          await fitWidth(page, ctx, target.wide)
          await page.waitForTimeout(400)
          expect(await wh.hints(page, ctx), `${ctx} wide`).toEqual([])
        }

        for (const regime of ['mid', 'narrow'] as const) {
          await fitWidth(page, ctx, target[regime])
          const line = await wh.lineWidth(page, ctx)
          const expected = await expectedHints(page, ctx, line)
          expect(
            expected.length,
            `${ctx} ${regime} expects hints`,
          ).toBeGreaterThan(0)
          await expect
            .poll(() => wh.hints(page, ctx), {
              timeout: 8000,
              message: `${ctx} ${regime}`,
            })
            .toEqual(expected)
          // Every rendered break inside the word is one of the planned positions.
          const breaks = await wh.breaks(page, ctx)
          expect(breaks.length, `${ctx} ${regime} wraps`).toBeGreaterThan(0)
          for (const offset of breaks)
            expect(expected, `${ctx} ${regime}`).toContain(offset)
          // OD4: the break before `cs` is never planned.
          expect(await wh.hints(page, ctx)).not.toContain(74)
        }
        if (ctx === 'plain') {
          // Only priority 1 at MID (every priority-1 piece fits), priority 3 appears at NARROW.
          await fitWidth(page, ctx, target.mid)
          await expect
            .poll(() => wh.hints(page, ctx), { timeout: 8000 })
            .toEqual(P1)
        }
      }
    })

    test('hidden Markdown syntax, images and tables never get a hint; words that fit are left alone', async ({
      page,
    }) => {
      const target = await regimes(page, 'plain')
      // The Owner example paragraph (prose with inline code): every word fits at this width.
      await fitWidth(page, 'plain', target.wide)
      await page.waitForTimeout(600)
      const ownerHints = () =>
        page.evaluate((selector) => {
          const owner = [...document.querySelectorAll(`${selector} p`)].find(
            (p) => p.textContent?.includes('gains'),
          )
          return owner?.querySelectorAll('.vmde-wrap-hint').length ?? -1
        }, SURFACE[mode])
      expect(await ownerHints()).toBe(0)

      await fitWidth(page, 'plain', target.narrow)
      await expect
        .poll(() => wh.hints(page, 'plain'), { timeout: 8000 })
        .not.toEqual([])
      await page.waitForTimeout(600)
      const where = await page.evaluate((selector) => {
        const surface = document.querySelector(selector)!
        const hints = [...surface.querySelectorAll('.vmde-wrap-hint')]
        const inside = (selectors: string) =>
          hints.filter((h) => h.closest(selectors)).length
        return {
          markers: inside('.vditor-ir__marker'),
          images: inside('[data-type="img"], img, figure'),
          tables: inside('table'),
          hasLongUrlMarker: [
            ...surface.querySelectorAll('.vditor-ir__marker--link'),
          ].some((m) => (m.textContent ?? '').length > 60),
          headingMarkers: surface.querySelectorAll(
            '.vditor-ir__marker--heading',
          ).length,
        }
      }, SURFACE[mode])
      expect(where.markers).toBe(0)
      expect(where.images).toBe(0)
      expect(where.tables).toBe(0)
      if (mode === 'ir') {
        // The test would be vacuous without the long URL and the `##` marker in the document.
        expect(where.hasLongUrlMarker).toBe(true)
        expect(where.headingMarkers).toBeGreaterThan(0)
      }
    })

    test('hints on plain words are view-only: bytes, posts, Undo depth and copied text are unchanged', async ({
      page,
    }) => {
      const before = await getValue(page)
      const depth = await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        return inner.undo[inner.currentMode].undoStack.length
      })
      const target = await regimes(page, 'plain')
      await fitWidth(page, 'plain', target.narrow)
      await expect
        .poll(() => wh.hints(page, 'plain'), { timeout: 8000 })
        .not.toEqual([])
      await page.waitForTimeout(1500)
      expect(await getValue(page)).toBe(before)
      const state = await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        const slot = inner.undo[inner.currentMode]
        return {
          depth: slot.undoStack.length,
          snapshotHasHint: String(slot.lastText).includes('vmde-wrap-hint'),
          edits: (window as any).__posted.filter(
            (m: any) => m.command === 'edit',
          ).length,
        }
      })
      expect(state).toEqual({ depth, snapshotHasHint: false, edits: 0 })

      const PATH =
        '../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs'
      const copy = async () => {
        await page.evaluate(selectEditorText, [PATH, 0, PATH.length] as const)
        await page.evaluate(() => ((window as any).__copied.length = 0))
        await page.keyboard.press('Control+C')
        return page.evaluate(
          () =>
            (window as any).__copied.find(
              ([t]: string[]) => t === 'text/plain',
            )?.[1] as string,
        )
      }
      const hinted = await copy()
      await page.evaluate(() => {
        for (const hint of document.querySelectorAll('.vmde-wrap-hint'))
          hint.remove()
        document
          .querySelectorAll('p, strong, a, li, h2, blockquote')
          .forEach((el) => {
            el.normalize()
          })
      })
      const control = await copy()
      expect(hinted).toContain(PATH)
      expect(hinted).toBe(control)
    })

    test('typing and Backspace inside a hinted plain word give exact bytes, one Undo restores them, hints return', async ({
      page,
    }) => {
      const target = await regimes(page, 'plain')
      await fitWidth(page, 'plain', target.narrow)
      const line = await wh.lineWidth(page, 'plain')
      const expected = await expectedHints(page, 'plain', line)
      await expect
        .poll(() => wh.hints(page, 'plain'), { timeout: 8000 })
        .toEqual(expected)
      const original = await getValue(page)

      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['Tests.EditorMode', 0, 0] as const)
      await page.keyboard.press('Shift')
      await page.keyboard.type('XY')
      const typed = original.replace('Tests.EditorMode', 'XYTests.EditorMode')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)

      await page.keyboard.type('XY')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      await page.waitForTimeout(1300)
      await postHistory(page, 'undo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)
      await postHistory(page, 'redo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      await postHistory(page, 'undo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)

      await expect
        .poll(() => wh.hints(page, 'plain'), { timeout: 8000 })
        .toEqual(expected)
    })

    test('Find counts a query that crosses a hint in plain text like the unhinted document', async ({
      page,
    }) => {
      const target = await regimes(page, 'plain')
      await fitWidth(page, 'plain', target.narrow)
      await expect
        .poll(() => wh.hints(page, 'plain'), { timeout: 8000 })
        .not.toEqual([])
      await page.evaluate(() =>
        window.postMessage({ command: 'open-find-replace', mode: 'find' }, '*'),
      )
      const widget = page.locator('.vmde-find-replace')
      await expect(widget).toBeVisible()
      await widget.locator('[data-find]').fill('Tower.Tests')
      const status = widget.locator('[data-status]')
      await expect(status).toHaveText(/^1 of \d+$/)
      const withHints = (await status.textContent()) as string
      await page.evaluate(() => {
        for (const hint of document.querySelectorAll('.vmde-wrap-hint'))
          hint.remove()
        document
          .querySelectorAll('p, strong, a, li, h2, blockquote')
          .forEach((el) => {
            el.normalize()
          })
      })
      await widget.locator('[data-find]').fill('Tower.Test')
      await widget.locator('[data-find]').fill('Tower.Tests')
      await expect(status).toHaveText(withHints)
    })
  })
}

test.describe('preview: wrap hints for words that are not inline code', () => {
  test('the same regimes hold in Preview', async ({ page }) => {
    test.setTimeout(120_000)
    await openEditor(page, 'ir', FIXTURE)
    await toPreview(page)
    await installReader(page, 'preview')
    for (const ctx of ['plain', 'bold', 'link', 'heading', 'list'] as const) {
      const target = await regimes(page, ctx)
      if (ctx !== 'heading') {
        await fitWidth(page, ctx, target.wide)
        await page.waitForTimeout(400)
        expect(await wh.hints(page, ctx), `${ctx} wide`).toEqual([])
      }
      for (const regime of ['mid', 'narrow'] as const) {
        await fitWidth(page, ctx, target[regime])
        const expected = await expectedHints(
          page,
          ctx,
          await wh.lineWidth(page, ctx),
        )
        await expect
          .poll(() => wh.hints(page, ctx), {
            timeout: 8000,
            message: `${ctx} ${regime}`,
          })
          .toEqual(expected)
        for (const offset of await wh.breaks(page, ctx))
          expect(expected).toContain(offset)
      }
    }
  })
})

test.describe('ir: the callout preview is hinted again after callouts.ts rebuilds it', () => {
  test('an edit in the callout source rebuilds the preview, which gets its own hints', async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await openEditor(page, 'ir', FIXTURE)
    await installReader(page, 'ir')
    const target = await regimes(page, 'callout')
    await fitWidth(page, 'callout', target.narrow)
    const expectedNow = async () =>
      expectedHints(page, 'callout', await wh.lineWidth(page, 'callout'))
    const expected = await expectedNow()
    await expect
      .poll(() => wh.hints(page, 'callout'), { timeout: 8000 })
      .toEqual(expected)

    // Edit the callout's lead word (the caret enters the source half and the preview is stale)...
    await page.keyboard.press('Shift')
    await page.evaluate(selectEditorText, ['Callout', 3, 0] as const)
    await page.keyboard.press('Shift')
    await page.keyboard.type('Z')
    // The source half is hinted too while it is shown.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.querySelectorAll(
                'blockquote > p .vmde-wrap-hint, blockquote > p > * .vmde-wrap-hint',
              ).length,
          ),
        { timeout: 8000 },
      )
      .toBeGreaterThan(0)
    await page.waitForTimeout(300)
    // ...then leave: the collapsed preview is rebuilt from the source, without the source's hints.
    await page.keyboard.press('Shift')
    await page.evaluate(selectEditorText, ['Plain', 2, 0] as const)
    await page.keyboard.press('Shift')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).vditor.getValue().includes('CalZlout'),
        ),
      )
      .toBe(true)
    await expect
      .poll(() => wh.hints(page, 'callout'), { timeout: 8000 })
      .toEqual(await expectedNow())
    // The preview never carries the source's hint spans: one run of hints, the engine's own.
    const inPreview = await page.evaluate(
      () =>
        document.querySelectorAll('.vmde-callout__preview .vmde-wrap-hint')
          .length,
    )
    expect(inPreview).toBe(expected.length)
  })
})
