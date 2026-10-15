// Task 640 S2b — wrap hints for inline code, in the real webview entry (main.ts) in IR, WYSIWYG and
// Preview. Expected hint positions come from the Owner contract (tasks/640-long-word-wrap-break-
// priority.md, "Part 1 revision" section 3 and 4) applied by hand to the Owner path, never from the
// implementation:
//   ../ | EncosyTower. | Tests. | EditorMode/ | EncosyTower. | PageFlows/ | PageFlowTestDoubles. | cs
//   offsets of the priority-1 breaks: 3 15 21 32 44 54 74; the break before `cs` (74) is dropped by
//   the final-piece rule (N = 3); priority-3 breaks inside the last piece: 58 62 66.
// The width regimes are set in glyph advances of the page's own monospace code font (measured from
// a probe code), so they hold on any machine's font:
//   WIDE    82 advances: the whole path (76) fits, no hint;
//   MID     40 advances: the widest priority-1 piece (22, `PageFlowTestDoubles.cs`) fits;
//   NARROW  16 advances: that piece does not fit, every priority-3 piece does.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures/wrap-hints.md'),
  'utf8',
)
const PATH =
  '../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs'
const P1 = [3, 15, 21, 32, 44, 54]
const P1_AND_P3 = [3, 15, 21, 32, 44, 54, 58, 62, 66]

type Mode = 'ir' | 'wysiwyg'
type Surface = Mode | 'preview'
const SURFACE: Record<Surface, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  preview: '.vditor-preview .vditor-reset',
}
// The code that holds the Owner path inside each container.
const PATH_CODE: Record<'paragraph' | 'list' | 'cell', string> = {
  paragraph: 'p code',
  list: 'li code',
  cell: 'td code',
}

async function open(page: Page, mode: Mode, width = 1280) {
  const init = {
    command: 'update',
    type: 'init',
    content: FIXTURE,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: mode },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript((message) => {
    const win = window as any
    win.__posted = []
    win.__copied = []
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        win.__posted.push(posted)
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
    const setData = DataTransfer.prototype.setData
    DataTransfer.prototype.setData = function (type: string, value: string) {
      win.__copied.push([type, String(value)])
      return setData.call(this, type, value)
    }
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    (target) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === target
      )
    },
    mode,
    { timeout: 20_000 },
  )
  await page.waitForFunction(
    () => {
      const inner = (window as any).vditor.vditor
      return inner.undo[inner.currentMode].undoStack.length >= 1
    },
    undefined,
    { timeout: 20_000 },
  )
}

async function toPreview(page: Page) {
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.preview.element.style.display = 'block'
    v[v.currentMode].element.parentElement.style.display = 'none'
    v.preview.render(v)
  })
  await page.locator('.vditor-preview code').first().waitFor()
}

/** The advance of one glyph of the page's code font, from the probe code. */
const advance = (page: Page, surface: Surface) =>
  page.evaluate((selector) => {
    const code = [...document.querySelectorAll(`${selector} code`)].find(
      (c) =>
        c.textContent?.includes('aaaaaaaaaa') && c.textContent.length <= 11,
    )!
    const range = document.createRange()
    range.selectNodeContents(code)
    return range.getBoundingClientRect().width / 10
  }, SURFACE[surface])

/** The width of the line box of the container's first code that holds the Owner path. */
const lineWidth = (
  page: Page,
  surface: Surface,
  container: keyof typeof PATH_CODE,
) =>
  page.evaluate(
    ([selector, codeSelector]) => {
      const code = [
        ...document.querySelectorAll(`${selector} ${codeSelector}`),
      ].find((c) =>
        c.textContent?.includes('PageFlowTestDoubles'),
      ) as HTMLElement
      const host = code.closest('p, li, td') as HTMLElement
      const style = getComputedStyle(host)
      return (
        host.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      )
    },
    [SURFACE[surface], PATH_CODE[container]] as const,
  )

/** Resize the viewport until the container's line box is `wanted` px wide (+- 1.5 px). */
async function fitWidth(
  page: Page,
  surface: Surface,
  container: keyof typeof PATH_CODE,
  wanted: number,
) {
  let viewport = 1000
  for (let i = 0; i < 4; i += 1) {
    await page.setViewportSize({
      width: Math.max(100, Math.round(viewport)),
      height: 900,
    })
    const width = await lineWidth(page, surface, container)
    if (Math.abs(width - wanted) <= 1.5) return
    viewport += wanted - width
  }
  const final = await lineWidth(page, surface, container)
  expect(Math.abs(final - wanted)).toBeLessThanOrEqual(3)
}

/** Hint offsets (in the code's text) of the code holding the Owner path in a container. */
const hintOffsets = (
  page: Page,
  surface: Surface,
  container: keyof typeof PATH_CODE,
) =>
  page.evaluate(
    ([selector, codeSelector]) => {
      const code = [
        ...document.querySelectorAll(`${selector} ${codeSelector}`),
      ].find((c) => c.textContent?.includes('PageFlowTestDoubles'))!
      // WYSIWYG code starts with a zero-width space: offsets count from the path itself.
      const start = (code.textContent ?? '').indexOf('../')
      const offsets: number[] = []
      let length = 0
      for (const child of Array.from(code.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) length += (child as Text).length
        else if ((child as Element).classList.contains('vmde-wrap-hint'))
          offsets.push(length - start)
      }
      return offsets
    },
    [SURFACE[surface], PATH_CODE[container]] as const,
  )

/** Offsets in the code's text where a rendered line starts (a line break between two characters). */
const lineBreaks = (
  page: Page,
  surface: Surface,
  container: keyof typeof PATH_CODE,
) =>
  page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page reader of the rendered line starts of a code element
    ([selector, codeSelector]) => {
      const code = [
        ...document.querySelectorAll(`${selector} ${codeSelector}`),
      ].find((c) => c.textContent?.includes('PageFlowTestDoubles'))!
      const start = (code.textContent ?? '').indexOf('../')
      const breaks: number[] = []
      let offset = 0
      let top: number | null = null
      const range = document.createRange()
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        for (let i = 0; i < node.length; i += 1) {
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const rect = range.getClientRects()[0]
          if (rect) {
            // A break before the word itself (offset 0, after WYSIWYG's leading zero-width space) is
            // not a break inside it.
            if (
              top !== null &&
              Math.round(rect.top) > top + 2 &&
              offset > start
            )
              breaks.push(offset - start)
            if (top === null || Math.round(rect.top) > top + 2)
              top = Math.round(rect.top)
          }
          offset += 1
        }
      }
      return breaks
    },
    [SURFACE[surface], PATH_CODE[container]] as const,
  )

const hintCount = (page: Page, surface: Surface) =>
  page.evaluate(
    (selector) =>
      document.querySelectorAll(`${selector} .vmde-wrap-hint`).length,
    SURFACE[surface],
  )

const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

// The Undo/Redo route of VS Code's keys: the keydown reaches the webview, then the command posts this.
async function postHistory(page: Page, name: 'undo' | 'redo') {
  await page.keyboard.down('Control')
  await page.evaluate((command) => {
    window.postMessage(
      { command: 'trigger-toolbar-hotkey', name: command },
      '*',
    )
  }, name)
  await page.keyboard.up('Control')
}

const settle = (page: Page) => page.waitForTimeout(500)

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`${mode}: inline code wrap hints`, () => {
    test.beforeEach(async ({ page }) => {
      test.setTimeout(90_000)
      await open(page, mode)
    })

    test('Owner path: no hint when it fits, priority 1 only when enough, priority 3 only inside the too-wide piece (paragraph and list item)', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      const pad = 14
      for (const container of ['paragraph', 'list'] as const) {
        await fitWidth(page, mode, container, 82 * a + pad)
        await settle(page)
        // WIDE: acceptance "a word that fits gets no hint".
        expect(await hintOffsets(page, mode, container)).toEqual([])

        await fitWidth(page, mode, container, 40 * a + pad)
        await expect
          .poll(() => hintOffsets(page, mode, container), { timeout: 8000 })
          .toEqual(P1)
        // Acceptance: every rendered break is one of the priority-1 positions (none mid-word).
        const midBreaks = await lineBreaks(page, mode, container)
        expect(midBreaks.length).toBeGreaterThan(0)
        for (const offset of midBreaks) expect(P1).toContain(offset)

        await fitWidth(page, mode, container, 16 * a + pad)
        await expect
          .poll(() => hintOffsets(page, mode, container), { timeout: 8000 })
          .toEqual(P1_AND_P3)
        const narrowBreaks = await lineBreaks(page, mode, container)
        expect(narrowBreaks.length).toBeGreaterThan(midBreaks.length)
        for (const offset of narrowBreaks) expect(P1_AND_P3).toContain(offset)
        // The break before `cs` (74) is never planned: OD4 default N = 3.
        expect(await hintOffsets(page, mode, container)).not.toContain(74)

        // Back to WIDE: the hints go again (re-plan on a surface width change).
        await fitWidth(page, mode, container, 82 * a + pad)
        await expect
          .poll(() => hintOffsets(page, mode, container), { timeout: 8000 })
          .toEqual([])
      }
    })

    test('words that fit, the acronym word, plain text, links, fenced code and tables get no hint', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      await fitWidth(page, mode, 'paragraph', 16 * a + 14)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      await settle(page)
      const where = await page.evaluate((selector) => {
        const root = document.querySelector(selector)!
        const hints = [...root.querySelectorAll('.vmde-wrap-hint')]
        const closestText = (hint: Element) =>
          hint.closest('code')?.textContent ?? ''
        return {
          // Every hint sits in the Owner-path code of the paragraph or the list item.
          inOwnerCode: hints.every((h) =>
            closestText(h).includes('PageFlowTestDoubles'),
          ),
          // Not in: fenced code, tables (S2d), markers, data-render widgets, plain text, links.
          excluded: hints.filter((h) =>
            h.closest(
              'pre:not(.vditor-reset), table, .vditor-ir__marker, [data-render]:not(.vmde-wrap-hint), a, h1',
            ),
          ).length,
          acronym: [...root.querySelectorAll('code')]
            .filter((c) => c.textContent?.includes('HTMLParser'))
            .map((c) => c.querySelectorAll('.vmde-wrap-hint').length),
          short: [...root.querySelectorAll('code')]
            .filter((c) =>
              /^\u200B?(short\.cs|aaaaaaaaaa)$/.test(c.textContent ?? ''),
            )
            .map((c) => c.querySelectorAll('.vmde-wrap-hint').length),
          cellHints: root.querySelectorAll('td .vmde-wrap-hint').length,
        }
      }, SURFACE[mode])
      expect(where.inOwnerCode).toBe(true)
      expect(where.excluded).toBe(0)
      // OD5: no acronym splitting - `HTMLParser...` has no lowercase-to-uppercase pair, so it gets no
      // hint at any width (the browser's break-anywhere fallback applies to it).
      expect(where.acronym).toEqual([0])
      expect(where.short).toEqual([0, 0])
      expect(where.cellHints).toBe(0)
    })

    test('hints are view-only: source bytes, posts, Undo history and copied text are unchanged', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      const before = await getValue(page)
      const depth = await page.evaluate(() => {
        const inner = (window as any).vditor.vditor
        return inner.undo[inner.currentMode].undoStack.length
      })
      await fitWidth(page, mode, 'paragraph', 16 * a + 14)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      // Longer than Vditor's 800 ms undo delay plus the 250 ms edit sync.
      await page.waitForTimeout(1500)

      expect(await hintCount(page, mode)).toBeGreaterThan(0)
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
      expect(state.depth).toBe(depth)
      expect(state.snapshotHasHint).toBe(false)
      expect(state.edits).toBe(0)

      // Copy: select the code's text across the hints and copy with a real Ctrl+C.
      await page.evaluate(selectEditorText, [PATH, 0, PATH.length] as const)
      await page.evaluate(() => ((window as any).__copied.length = 0))
      await page.keyboard.press('Control+C')
      const hinted = await page.evaluate(() => (window as any).__copied.slice())
      await page.evaluate(() => {
        for (const code of document.querySelectorAll('.vmde-wrap-hint'))
          code.remove()
        for (const element of document.querySelectorAll('code'))
          element.normalize()
      })
      await page.evaluate(selectEditorText, [PATH, 0, PATH.length] as const)
      await page.evaluate(() => ((window as any).__copied.length = 0))
      await page.keyboard.press('Control+C')
      const control = await page.evaluate(() =>
        (window as any).__copied.slice(),
      )
      const plain = (copied: Array<[string, string]>) =>
        copied.find(([type]) => type === 'text/plain')?.[1]
      expect(plain(hinted)).toContain(PATH)
      expect(plain(hinted)).toBe(plain(control))
    })

    test('typing and Backspace inside hinted code give exact bytes, one Undo step restores them, hints return after the pause', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      await fitWidth(page, mode, 'paragraph', 16 * a + 14)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      const original = await getValue(page)

      // The caret goes inside the hinted code, between two priority-1 pieces (offset 15).
      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['Tests.EditorMode', 0, 0] as const)
      await page.keyboard.press('Shift')
      await page.keyboard.type('XY')
      const typed = original.replace('Tests.EditorMode', 'XYTests.EditorMode')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)

      // One typing burst is one Undo step: Undo restores the exact bytes, Redo the typed ones.
      await page.keyboard.type('XY')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      // Longer than Vditor's 800 ms undo delay, so the burst is one snapshot.
      await page.waitForTimeout(1300)
      await postHistory(page, 'undo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)
      await postHistory(page, 'redo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(typed)
      await postHistory(page, 'undo')
      await expect.poll(() => getValue(page), { timeout: 8000 }).toBe(original)

      // After the typing pause the edited code is hinted again.
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      expect(await getValue(page)).toBe(original)
    })

    test('a caret inside hinted code stays on its character when the hints are re-planned', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      const pad = 14
      await fitWidth(page, mode, 'paragraph', 16 * a + pad)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['Tests.EditorMode', 3, 0] as const)
      await page.keyboard.press('Shift')
      const caret = () =>
        page.evaluate(() => {
          const selection = getSelection()!
          const code = (selection.anchorNode as Node).parentElement!.closest(
            'code',
          )!
          const range = document.createRange()
          range.setStart(code, 0)
          range.setEnd(selection.anchorNode!, selection.anchorOffset)
          return (
            range.toString().length - (code.textContent ?? '').indexOf('../')
          )
        })
      // `Tests.EditorMode` starts at offset 15 of the path: the caret is 3 characters in.
      expect(await caret()).toBe(18)
      // Widening clears every hint (Node.normalize merges the Text nodes); narrowing plans them again.
      await fitWidth(page, mode, 'paragraph', 82 * a + pad)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual([])
      expect(await caret()).toBe(18)
      await fitWidth(page, mode, 'paragraph', 16 * a + pad)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      expect(await caret()).toBe(18)
    })

    test('Find counts a query that crosses a hint like the unhinted document', async ({
      page,
    }) => {
      const a = await advance(page, mode)
      await fitWidth(page, mode, 'paragraph', 16 * a + 14)
      await expect
        .poll(() => hintOffsets(page, mode, 'paragraph'), { timeout: 8000 })
        .toEqual(P1_AND_P3)
      await page.evaluate(() =>
        window.postMessage({ command: 'open-find-replace', mode: 'find' }, '*'),
      )
      const widget = page.locator('.vmde-find-replace')
      await expect(widget).toBeVisible()
      // `Tower.Tests` crosses the priority-1 hint at offset 15 of every hinted path.
      await widget.locator('[data-find]').fill('Tower.Tests')
      const status = widget.locator('[data-status]')
      await expect(status).toHaveText(/^1 of \d+$/)
      const withHints = await status.textContent()
      await page.evaluate(() => {
        for (const hint of document.querySelectorAll('.vmde-wrap-hint'))
          hint.remove()
        for (const element of document.querySelectorAll('code'))
          element.normalize()
      })
      await widget.locator('[data-find]').fill('Tower.Test')
      await widget.locator('[data-find]').fill('Tower.Tests')
      await expect(status).toHaveText(withHints as string)
    })
  })
}

test.describe('preview: inline code wrap hints', () => {
  test('the same regimes hold in Preview', async ({ page }) => {
    test.setTimeout(90_000)
    await open(page, 'ir')
    await toPreview(page)
    const a = await advance(page, 'preview')
    await fitWidth(page, 'preview', 'paragraph', 82 * a + 14)
    await settle(page)
    expect(await hintOffsets(page, 'preview', 'paragraph')).toEqual([])
    await fitWidth(page, 'preview', 'paragraph', 40 * a + 14)
    await expect
      .poll(() => hintOffsets(page, 'preview', 'paragraph'), { timeout: 8000 })
      .toEqual(P1)
    for (const offset of await lineBreaks(page, 'preview', 'paragraph'))
      expect(P1).toContain(offset)
    await fitWidth(page, 'preview', 'paragraph', 16 * a + 14)
    await expect
      .poll(() => hintOffsets(page, 'preview', 'paragraph'), { timeout: 8000 })
      .toEqual(P1_AND_P3)
    for (const offset of await lineBreaks(page, 'preview', 'paragraph'))
      expect(P1_AND_P3).toContain(offset)
  })
})

test.describe('ir: a hint write in a table cell is not an edit for the Task 639 layout', () => {
  test('no measurement pass and unchanged widths after a hint write; a real edit does run one', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await open(page, 'ir')
    await page.locator('.vditor-ir table').first().waitFor()
    // Let the automatic widths settle, then count the measurement hosts the layout adds to <body>.
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
      const win = window as any
      win.__measurePasses = 0
      new MutationObserver((records) => {
        win.__measurePasses += records
          .flatMap((record) => [...record.addedNodes])
          .filter(
            (node) =>
              node instanceof Element && node.hasAttribute('data-vmde-measure'),
          ).length
      }).observe(document.body, { childList: true })
    })
    const widths = () =>
      page.evaluate(() =>
        [
          ...document
            .querySelectorAll('.vditor-ir table')[0]
            .querySelectorAll('tr:first-child > *'),
        ].map((cell) => (cell as HTMLElement).getBoundingClientRect().width),
      )
    const before = await widths()
    await page.evaluate(() => {
      const code = document.querySelector('.vditor-ir td code')!
      ;(window as any).__vmdeWrapHintsE2E.insertHint(code, 15)
    })
    await page.waitForTimeout(1500)
    expect(await page.evaluate(() => (window as any).__measurePasses)).toBe(0)
    expect(await widths()).toEqual(before)

    // Control: a real edit of the cell text counts, so a zero above is not a dead counter.
    await page.evaluate(() => {
      const code = document.querySelector('.vditor-ir td code')!
      ;(code.lastChild as Text).appendData('x')
    })
    await expect
      .poll(() => page.evaluate(() => (window as any).__measurePasses), {
        timeout: 8000,
      })
      .toBeGreaterThan(0)
  })
})

test.describe('ir: observers do not see hint writes', () => {
  test('a MutationObserver created after boot is not called for a hint write, but is for a real edit', async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await open(page, 'ir')
    await page.locator('.vditor-ir p code').first().waitFor()
    await page.evaluate(() => {
      const win = window as any
      win.__observerCalls = 0
      new MutationObserver(() => {
        win.__observerCalls += 1
      }).observe(document.querySelector('.vditor-ir .vditor-reset')!, {
        childList: true,
        characterData: true,
        subtree: true,
      })
      const code = [...document.querySelectorAll('.vditor-ir p code')].find(
        (c) => c.textContent?.includes('PageFlowTestDoubles'),
      )!
      win.__vmdeWrapHintsE2E.insertHint(code, 15)
    })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as any).__observerCalls)).toBe(0)
    await page.evaluate(() => {
      const code = [...document.querySelectorAll('.vditor-ir p code')].find(
        (c) => c.textContent?.includes('PageFlowTestDoubles'),
      )!
      ;(code.lastChild as Text).appendData('x')
    })
    await expect
      .poll(() => page.evaluate(() => (window as any).__observerCalls), {
        timeout: 5000,
      })
      .toBeGreaterThan(0)
  })
})
