import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 641 S2b — two pieces of post-init work leave the open-to-ready path. This runs the REAL
// webview entry (main.ts, as shortcut-negative-harness.ts), so the real section-fold install in
// `runFinishInit`, the real history wrapper and the source-patched Vditor all take part; the host's
// `init` is answered to `ready`, as in external-update-undo-base.spec.ts.
//
// 1. The list fold glyph alignment (`alignListFoldGlyph`, one forced layout per foldable list item,
//    about 0.5 s before ready on a 150 KB file) runs after the first paint and only for list items
//    near the viewport.
// 2. The history-base capture (`history-base` message, a whole-document serialization) waits for an
//    idle period, and is taken at once when the user acts first, so the first edit is still undoable
//    to the opened bytes.

type Mode = 'ir' | 'wysiwyg'

const ITEMS = 1500
// Every item owns a nested list, so every top-level item is a foldable list item.
const LARGE_LIST_DOC = `# Large list\n\n${Array.from(
  { length: ITEMS },
  (_, index) => `- item ${index} holds filler words\n  - child ${index}`,
).join('\n')}\n`

// Round-trips exactly through both editable modes (external-update-undo-base.spec.ts).
const OPENED_DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'

async function open(
  page: Page,
  mode: Mode,
  content: string,
  holdIdle = false,
): Promise<void> {
  const init = {
    command: 'update',
    type: 'init',
    content,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: mode },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.addInitScript(
    ([message, hold]) => {
      const win = window as any
      win.__posted = []
      win.acquireVsCodeApi = () => ({
        postMessage: (posted: any) => {
          win.__posted.push(posted)
          if (posted?.command === 'ready') window.postMessage(message, '*')
        },
        getState: () => undefined,
        setState: () => undefined,
      })
      // Forced layout caused by reading a foldable list item's box is what the glyph alignment
      // costs; time those reads, nothing else.
      const reads = { count: 0, ms: 0, maxMs: 0 }
      win.__foldReads = reads
      const original = Element.prototype.getBoundingClientRect
      Element.prototype.getBoundingClientRect = function (this: Element) {
        if (
          this.localName !== 'li' ||
          !this.hasAttribute('data-vmde-list-foldable')
        )
          return original.call(this)
        const start = performance.now()
        const rect = original.call(this)
        const took = performance.now() - start
        reads.count += 1
        reads.ms += took
        reads.maxMs = Math.max(reads.maxMs, took)
        return rect
      }
      if (hold) {
        // The idle scheduler holds every callback until the test releases it, so "before idle" is
        // a state the test controls instead of a race.
        const queue: (() => void)[] = []
        win.__idleQueue = queue
        win.requestIdleCallback = (run: () => void) => queue.push(run)
        win.cancelIdleCallback = () => undefined
        win.__releaseIdle = () => {
          for (const run of queue.splice(0)) run()
        }
      }
    },
    [init, holdIdle] as const,
  )
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
    { timeout: 60_000 },
  )
}

const foldReads = (page: Page) =>
  page.evaluate(
    () =>
      (window as any).__foldReads as {
        count: number
        ms: number
        maxMs: number
      },
  )

// The centre variable the alignment writes, per top-level list item index.
const glyphCenters = (page: Page, indexes: number[]) =>
  page.evaluate((wanted) => {
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.vditor-ir:not([style*="display: none"]) .vditor-reset li[data-vmde-list-foldable], .vditor-wysiwyg:not([style*="display: none"]) .vditor-reset li[data-vmde-list-foldable]',
      ),
    )
    return wanted.map(
      (index) =>
        items[index]?.style.getPropertyValue(
          '--vmde-list-fold-glyph-center-x',
        ) ?? null,
    )
  }, indexes)

test.describe('list fold glyph alignment after first paint (Task 641)', () => {
  // Acceptance: no long task from fold alignment during init. The cost was one forced layout per
  // foldable item (~1500 here); the whole open now spends at most one task's budget on them, and
  // only near-viewport items are measured at all.
  test('a large list opens without measuring every foldable item', async ({
    page,
  }) => {
    await open(page, 'ir', LARGE_LIST_DOC)
    await page.waitForTimeout(1500)

    const reads = await foldReads(page)
    expect(
      reads.ms,
      `${reads.count} foldable-item reads took ${reads.ms.toFixed(0)} ms`,
    ).toBeLessThan(50)
    expect(reads.maxMs).toBeLessThan(50)
    expect(reads.count).toBeLessThan(ITEMS / 4)
  })

  // Acceptance: the glyph position stays correct when the user scrolls (a far item is measured
  // when it comes near) and when the user folds (the folded item is measured at once).
  test('a far item is aligned when scrolled near, and folding a visible item aligns it', async ({
    page,
  }) => {
    await open(page, 'ir', LARGE_LIST_DOC)
    await page.waitForTimeout(1500)

    const [firstBefore, lastBefore] = await glyphCenters(page, [0, ITEMS - 1])
    expect(
      firstBefore,
      'a visible item is aligned after the idle period',
    ).toMatch(/^-?[\d.]+px$/)
    expect(lastBefore, 'a far item is not measured').toBe('')

    await page.evaluate((index) => {
      const items = document.querySelectorAll<HTMLElement>(
        '.vditor-reset li[data-vmde-list-foldable]',
      )
      items[index]?.scrollIntoView({ block: 'center' })
    }, ITEMS - 1)
    await expect
      .poll(async () => (await glyphCenters(page, [ITEMS - 1]))[0])
      .toMatch(/^-?[\d.]+px$/)

    // Fold the first item through its gutter arrow, as a user click.
    await page.evaluate(() => {
      document
        .querySelector('.vditor-reset li[data-vmde-list-foldable]')
        ?.scrollIntoView({ block: 'start' })
    })
    const arrow = await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>(
        '.vditor-reset li[data-vmde-list-foldable]',
      )!
      const box = item.getBoundingClientRect()
      const style = getComputedStyle(item, '::after')
      return {
        x:
          box.left +
          Number.parseFloat(style.left) +
          Number.parseFloat(style.width) / 2,
        y:
          box.top +
          Number.parseFloat(style.top) +
          Number.parseFloat(style.height) / 2,
      }
    })
    await page.mouse.click(arrow.x, arrow.y)
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('.vditor-reset li[data-vmde-list-foldable]')
            ?.hasAttribute('data-vmde-list-folded'),
        ),
      )
      .toBe(true)
    const [folded] = await glyphCenters(page, [0])
    expect(folded).toMatch(/^-?[\d.]+px$/)
    expect(
      await page.evaluate(() => {
        const item = document.querySelector(
          '.vditor-reset li[data-vmde-list-foldable]',
        )!
        return getComputedStyle(item, '::before').content
      }),
    ).toBe('"▶"')
  })
})

test.describe('history base in idle time (Task 641)', () => {
  const baseMessages = (page: Page) =>
    page.evaluate(() =>
      ((window as any).__posted as { command?: string; content?: string }[])
        .map((message, index) => ({ ...message, index }))
        .filter((message) => message.command === 'history-base'),
    )
  const firstEditIndex = (page: Page) =>
    page.evaluate(() =>
      ((window as any).__posted as { command?: string }[]).findIndex(
        (message) => message.command === 'edit',
      ),
    )
  const historyDepth = (page: Page) =>
    page.evaluate(() => {
      const inner = (window as any).vditor.vditor
      return inner.undo[inner.currentMode].undoStack.length as number
    })
  const waitForOwnFirstEntry = (page: Page) =>
    page.waitForFunction(
      () => {
        const inner = (window as any).vditor.vditor
        return inner.undo[inner.currentMode].undoStack.length >= 1
      },
      undefined,
      { timeout: 15_000 },
    )
  // The Undo route of VS Code's keys: the keydown reaches the webview, then the host posts this.
  async function undo(page: Page) {
    await page.keyboard.down('Control')
    await page.evaluate(() => {
      window.postMessage(
        { command: 'trigger-toolbar-hotkey', name: 'undo' },
        '*',
      )
    })
    await page.keyboard.up('Control')
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    // Acceptance: the capture is deferred (not taken when Vditor records its first entry), runs
    // when the idle period comes, and the first edit is still undoable to the opened bytes.
    test(`${mode}: the base is taken in the idle period, then the first edit undoes to the opened bytes`, async ({
      page,
    }) => {
      await open(page, mode, OPENED_DOC, true)
      await waitForOwnFirstEntry(page)
      await page.waitForTimeout(300)

      expect(await baseMessages(page), 'deferred while not idle').toEqual([])
      await page.evaluate(() => (window as any).__releaseIdle())
      const bases = await baseMessages(page)
      expect(bases).toHaveLength(1)
      expect(bases[0].content).toBe(OPENED_DOC)

      await page.evaluate(selectEditorText, ['bravo', 2, 0] as const)
      await page.keyboard.type('Y')
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toContain('brYavo')
      await page.waitForTimeout(1400)
      await undo(page)
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toBe(OPENED_DOC)
      expect(await baseMessages(page), 'no second base').toHaveLength(1)
    })

    // Acceptance: the capture is forced by the first edit when it comes before the idle period,
    // and it holds the text before that edit.
    test(`${mode}: an edit before the idle period takes the base first, and Undo restores the opened bytes`, async ({
      page,
    }) => {
      await open(page, mode, OPENED_DOC, true)
      await waitForOwnFirstEntry(page)
      await page.waitForTimeout(300)
      expect(await baseMessages(page), 'deferred while not idle').toEqual([])

      await page.evaluate(selectEditorText, ['bravo', 2, 0] as const)
      await page.keyboard.type('Y')
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toContain('brYavo')

      const bases = await baseMessages(page)
      expect(bases, 'the first edit forced the capture').toHaveLength(1)
      expect(bases[0].content, 'the text before the edit').toBe(OPENED_DOC)
      await page.waitForTimeout(1400)
      const edit = await firstEditIndex(page)
      expect(edit).toBeGreaterThan(-1)
      expect(
        bases[0].index,
        'the base reaches the host before the edit',
      ).toBeLessThan(edit)

      await undo(page)
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toBe(OPENED_DOC)
      expect(await historyDepth(page)).toBeGreaterThanOrEqual(1)
      await page.evaluate(() => (window as any).__releaseIdle())
      expect(
        await baseMessages(page),
        'the idle period adds nothing',
      ).toHaveLength(1)
    })
  }

  // Acceptance: Undo pressed before the idle period still pairs the base first.
  test('Undo before the idle period takes the pending base before the transition', async ({
    page,
  }) => {
    await open(page, 'ir', OPENED_DOC, true)
    await waitForOwnFirstEntry(page)
    await page.waitForTimeout(300)
    expect(await baseMessages(page)).toEqual([])

    await undo(page)
    const bases = await baseMessages(page)
    expect(bases).toHaveLength(1)
    expect(bases[0].content).toBe(OPENED_DOC)
    expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
      OPENED_DOC,
    )
  })
})
