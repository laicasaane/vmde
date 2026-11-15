import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import { docText, settle, waitForE2EReadiness, wf } from './webview-helpers'

// Task 733 / 013 (D-13): the text model, the unit spin, the unit history and the unit feed serve
// WYSIWYG. Open in IR, switch to WYSIWYG, then:
//   (a) the model is live in WYSIWYG and its text equals the document;
//   (b) typing, Backspace and Enter in a paragraph, a table cell and a bullet item post deltas only, and
//       the cell and the item are spun alone;
//   (c) Undo and Redo of a cell and an item post history deltas and keep the model equal to the document;
//   (d) WYSIWYG to IR to WYSIWYG rebuilds the model each time;
//   (e) a cell key makes no whole-document or whole-table Lute call; a paragraph Backspace reads no root HTML.
// Counters, kinds and byte digests only; no timing and no document text in the log.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  fullGetValue: number
  luteDocument: number
  luteTable: number
  rootInnerHtmlRead: number
  legacyEditPosts: number
  deltaPosts: number
  historyDeltaPosts: number
  fallbackPublications: number
}

const fixture = tableHeavyMarkdown(1)
const ROOT = '.vditor-wysiwyg .vditor-reset'
const PLACES = {
  paragraph: { selector: `${ROOT} > p`, nth: 2 },
  'table cell': { selector: `${ROOT} > table td`, nth: 7 },
  'list item': { selector: `${ROOT} > ul > li`, nth: 2 },
} as const
type Place = keyof typeof PLACES

let openedFile = ''

async function openInIr(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
): Promise<Frame> {
  openedFile = path.join(baseDir, 'wysiwyg-units.md')
  writeFileSync(openedFile, fixture)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [openedFile],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the WYSIWYG units editor installed its router' },
  )
  return frame
}

/** Switches the editor to `mode` through the edit-mode toolbar and waits for the mode report. */
async function switchMode(frame: Frame, mode: 'ir' | 'wysiwyg'): Promise<void> {
  const before = await waitForE2EReadiness(frame, () => true, {
    message: 'a readiness snapshot exists',
  })
  await frame.locator('body').evaluate((_body, target) => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector(`button[data-mode="${target as string}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === mode,
    { message: `the editor reported ${mode}` },
  )
}

/** State and served mode of the model, from the end-to-end statistics. */
const modelStats = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const s = (
      window as unknown as {
        __vmdeModelShadowStats?: { state: string; mode?: string }
      }
    ).__vmdeModelShadowStats
    return { state: s?.state ?? 'absent', mode: s?.mode ?? 'none' }
  })

/** Length and FNV-1a hash (32 bits, UTF-16 code units) of a text: the same function as the page's digest. */
function digestOf(text: string): { length: number; hash: number } {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return { length: text.length, hash: hash >>> 0 }
}

const modelDigest = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelTextDigest?: () => { length: number; hash: number } | null
        }
      ).__vmdeModelTextDigest?.() ?? null,
  )

/** The model text equals the document (digests of both, the document normalized to `\n`). */
async function expectModelEqualsDocument(
  frame: Frame,
  evaluateInVSCode: Evaluate,
  step: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const document = await docText(
          evaluateInVSCode as Parameters<typeof docText>[0],
          openedFile,
        )
        return JSON.stringify([
          await modelDigest(frame),
          digestOf(document.replace(/\r\n/gu, '\n')),
        ])
      },
      { message: `${step}: model digest equals the document`, timeout: 15_000 },
    )
    .toMatch(/^\[(\{[^}]+\}),\1\]$/u)
}

/** The model is live in WYSIWYG (served mode reported) and equals the document. */
async function expectLiveIn(
  frame: Frame,
  evaluateInVSCode: Evaluate,
  mode: 'ir' | 'wysiwyg',
  step: string,
): Promise<void> {
  await expect
    .poll(() => modelStats(frame), {
      message: `${step}: the model is live in ${mode}`,
      timeout: 15_000,
    })
    .toEqual({ state: 'live', mode })
  await expectModelEqualsDocument(frame, evaluateInVSCode, step)
}

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(length as number)
  }, fixture.length)

async function readCounters(frame: Frame, step: string): Promise<Counters> {
  const counters = await frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      luteDocument: c.luteDocument,
      luteTable: c.luteTable,
      rootInnerHtmlRead: c.rootInnerHtmlRead,
      legacyEditPosts: c.legacyEditPosts,
      deltaPosts: c.deltaPosts,
      historyDeltaPosts: c.historyDeltaPosts,
      fallbackPublications: c.fallbackPublications,
    }
  })
  console.log(`WYSIWYG-UNITS ${JSON.stringify({ step, counters })}`)
  return counters
}

const spunCount = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeUnitSpinStats?: Record<string, number> })
          .__vmdeUnitSpinStats?.spun ?? 0,
    )

/** Puts the caret at the end of the place's first text by a click on its right edge. */
async function caretAtEnd(frame: Frame, place: Place): Promise<void> {
  const { selector, nth } = PLACES[place]
  const target = frame.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error(`${place} has no bounding box`)
  await target.click({
    position: { x: Math.max(1, box.width - 2), y: box.height / 2 },
  })
}

/** Publication settles: the idle publish of the typing has run. */
const settlePublication = (frame: Frame) => settle(frame, 1500)

test.describe('WYSIWYG units', () => {
  test('(a) switched to WYSIWYG, the model is live and equals the document', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openInIr(workbox, evaluateInVSCode as Evaluate, baseDir)
    await expectLiveIn(
      frame,
      evaluateInVSCode as Evaluate,
      'ir',
      'opened in IR',
    )
    await switchMode(frame, 'wysiwyg')
    await expectLiveIn(
      frame,
      evaluateInVSCode as Evaluate,
      'wysiwyg',
      'switched to WYSIWYG',
    )
  })

  for (const place of Object.keys(PLACES) as Place[]) {
    test(`(b) typing, Backspace and Enter in a WYSIWYG ${place} post deltas only`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const frame = await openInIr(
        workbox,
        evaluateInVSCode as Evaluate,
        baseDir,
      )
      await switchMode(frame, 'wysiwyg')
      await expectLiveIn(frame, evaluateInVSCode as Evaluate, 'wysiwyg', place)
      await caretAtEnd(frame, place)
      const spunBefore = await spunCount(frame)
      await resetCounters(frame)
      for (const letter of 'abc') await workbox.keyboard.press(letter)
      await workbox.keyboard.press('Backspace')
      if (place !== 'table cell') await workbox.keyboard.press('Enter')
      await settlePublication(frame)
      const counters = await readCounters(frame, `${place} keys`)
      expect(counters.legacyEditPosts, 'whole-text posts').toBe(0)
      expect(counters.fallbackPublications, 'fallback publications').toBe(0)
      expect(counters.fullGetValue, 'whole-document getValue').toBe(0)
      expect(counters.deltaPosts, 'delta posts').toBeGreaterThanOrEqual(1)
      if (place !== 'paragraph')
        expect(await spunCount(frame), 'unit spins').toBeGreaterThan(spunBefore)
      await expectModelEqualsDocument(
        frame,
        evaluateInVSCode as Evaluate,
        place,
      )
    })
  }

  for (const place of ['table cell', 'list item'] as const) {
    test(`(c) Undo and Redo of a WYSIWYG ${place} post history deltas`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const frame = await openInIr(
        workbox,
        evaluateInVSCode as Evaluate,
        baseDir,
      )
      await switchMode(frame, 'wysiwyg')
      await expectLiveIn(frame, evaluateInVSCode as Evaluate, 'wysiwyg', place)
      await caretAtEnd(frame, place)
      for (const letter of 'ab') await workbox.keyboard.press(letter)
      await settlePublication(frame)
      await resetCounters(frame)
      await workbox.keyboard.press('Control+z')
      await settlePublication(frame)
      await expectModelEqualsDocument(
        frame,
        evaluateInVSCode as Evaluate,
        `${place} Undo`,
      )
      await workbox.keyboard.press('Control+y')
      await settlePublication(frame)
      await expectModelEqualsDocument(
        frame,
        evaluateInVSCode as Evaluate,
        `${place} Redo`,
      )
      const counters = await readCounters(frame, `${place} Undo and Redo`)
      expect(
        counters.historyDeltaPosts,
        'history delta posts',
      ).toBeGreaterThanOrEqual(2)
      expect(counters.legacyEditPosts, 'whole-text posts').toBe(0)
      expect(counters.fullGetValue, 'whole-document getValue').toBe(0)
    })
  }

  test('(d) WYSIWYG to IR to WYSIWYG rebuilds the model each time', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openInIr(workbox, evaluateInVSCode as Evaluate, baseDir)
    for (const mode of ['wysiwyg', 'ir', 'wysiwyg'] as const) {
      await switchMode(frame, mode)
      await expectLiveIn(
        frame,
        evaluateInVSCode as Evaluate,
        mode,
        `in ${mode}`,
      )
    }
  })

  test('(e) a WYSIWYG cell key makes no whole-document or whole-table Lute call; a paragraph Backspace reads no root HTML', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openInIr(workbox, evaluateInVSCode as Evaluate, baseDir)
    await switchMode(frame, 'wysiwyg')
    await expectLiveIn(frame, evaluateInVSCode as Evaluate, 'wysiwyg', 'gates')
    await caretAtEnd(frame, 'table cell')
    await resetCounters(frame)
    await workbox.keyboard.press('x')
    await settlePublication(frame)
    const cell = await readCounters(frame, 'table cell key')
    expect(cell.luteDocument, 'whole-document Lute calls').toBe(0)
    expect(cell.luteTable, 'whole-table Lute calls').toBe(0)
    await caretAtEnd(frame, 'paragraph')
    await resetCounters(frame)
    await workbox.keyboard.press('Backspace')
    await settlePublication(frame)
    const paragraph = await readCounters(frame, 'paragraph Backspace')
    expect(paragraph.rootInnerHtmlRead, 'root HTML reads').toBe(0)
    expect(paragraph.fullGetValue, 'whole-document getValue').toBe(0)
  })
})
