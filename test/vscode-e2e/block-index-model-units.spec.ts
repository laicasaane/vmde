import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  planBlockDuplicate,
  planBlockMove,
  scanMovableBlocks,
} from '../../src/shared/block-move'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 005: the source-block index takes its units from the confirmed text model. Hover shows
// the block handle with no whole-document Lute call, and block actions still write the bytes the
// host planner computes (every action re-proves its units, so model offsets never reach one). The
// stats and counters hold numbers and state names only, never document text.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface ShadowStats {
  state: 'off' | 'live'
  units: number
  opaque: number
  dirtyNow: number
  compared: number
}

const fixture = tableHeavyMarkdown(1)
const FIRST_PARAGRAPH = '.vditor-ir .vditor-reset > p'
const created: string[] = []

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
  for (const file of created.splice(0)) rmSync(file, { force: true })
})

async function openDocument(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  created.push(file)
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
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the block-index spec editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return { frame, file }
}

const readStats = (frame: Frame): Promise<ShadowStats | null> =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeModelShadowStats?: ShadowStats })
          .__vmdeModelShadowStats ?? null,
    )

/** C7: a live model with no dirty unit is what lets the index serve model units. */
async function waitForLiveModel(frame: Frame): Promise<ShadowStats> {
  await expect
    .poll(
      async () => {
        const stats = await readStats(frame)
        return (
          stats?.state === 'live' && stats.units > 0 && stats.dirtyNow === 0
        )
      },
      { timeout: 90_000, message: 'the model is live with no dirty unit' },
    )
    .toBe(true)
  return (await readStats(frame)) as ShadowStats
}

/** Install the opt-in metrics object and zero both counter families. */
const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    const w = window as unknown as {
      __vmdeEditCounters: { reset(length: number): void }
      __vmdeBlockHandleCacheMetrics?: Record<string, number>
    }
    w.__vmdeBlockHandleCacheMetrics = {
      indexBuilds: 0,
      blockHandleSnapshotCalls: 0,
    }
    w.__vmdeEditCounters.reset(length as number)
  }, fixture.length)

const readCounters = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __vmdeEditCounters: { luteDocument: number }
      __vmdeBlockHandleCacheMetrics?: { blockHandleSnapshotCalls?: number }
    }
    return {
      luteDocument: w.__vmdeEditCounters.luteDocument,
      blockHandleSnapshotCalls:
        w.__vmdeBlockHandleCacheMetrics?.blockHandleSnapshotCalls ?? 0,
    }
  })

async function expectHandleOver(
  frame: Frame,
  target: ReturnType<Frame['locator']>,
) {
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
}

/** Fixture blocks as the host scan sees them: `p` is the first paragraph, `next` the block after it. */
function firstParagraphAndNext() {
  const blocks = scanMovableBlocks(fixture)
  const index = blocks.findIndex((block) => block.kind === 'paragraph')
  const next = blocks[index + 1]
  if (
    index < 0 ||
    !next ||
    next.kind === 'heading' ||
    next.kind === 'front-matter'
  )
    throw new Error('fixture has no movable paragraph pair')
  return { p: blocks[index], next }
}

async function saveAndRead(
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<string> {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [] as string[])
  await expect
    .poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 })
    .not.toBe(fixture)
  return readFileSync(file, 'utf8')
}

test.describe('block index on model units', () => {
  test('hover after open shows the handle with no whole-document Lute call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame } = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'block-index-hover.md',
      fixture,
    )
    const stats = await waitForLiveModel(frame)
    console.log(
      `BLOCK-INDEX-MODEL ${JSON.stringify({ step: 'open', state: stats.state, units: stats.units, opaque: stats.opaque, dirtyNow: stats.dirtyNow })}`,
    )
    expect(
      stats.opaque,
      'tableHeavyMarkdown(1) opens without opaque units',
    ).toBe(0)
    await resetCounters(frame)
    await expectHandleOver(frame, frame.locator(FIRST_PARAGRAPH).first())
    await expectHandleOver(
      frame,
      frame.locator('.vditor-ir .vditor-reset > ul > li').nth(2),
    )
    await expectHandleOver(
      frame,
      frame.locator('.vditor-ir .vditor-reset > table td').nth(7),
    )
    const counters = await readCounters(frame)
    console.log(
      `BLOCK-INDEX-MODEL ${JSON.stringify({ step: 'hover', counters })}`,
    )
    expect(counters.luteDocument, 'luteDocument').toBe(0)
    expect(counters.blockHandleSnapshotCalls, 'blockHandleSnapshotCalls').toBe(
      0,
    )
  })

  test('Move Block Down on a paragraph writes the planner bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'block-index-move.md',
      fixture,
    )
    await waitForLiveModel(frame)
    const { p, next } = firstParagraphAndNext()
    const planned = planBlockMove(fixture, p.start, next.start, 'after')
    if (planned.status !== 'ok')
      throw new Error('planner rejected the fixture move')
    const first = frame.locator(FIRST_PARAGRAPH).first()
    await first.click()
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.moveBlockDown')
    }, [] as string[])
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .toBe(planned.markdown)
    expect(await saveAndRead(evaluateInVSCode, file)).toBe(planned.markdown)
  })

  test('Menu action identity: Duplicate Block writes the planner bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'block-index-duplicate.md',
      fixture,
    )
    await waitForLiveModel(frame)
    const { p } = firstParagraphAndNext()
    const planned = planBlockDuplicate(fixture, p.start)
    if (planned.status !== 'ok')
      throw new Error('planner rejected the fixture duplicate')
    await expectHandleOver(frame, frame.locator(FIRST_PARAGRAPH).first())
    await frame.locator('.vmde-block-handle').click()
    // The menu action asks the host for exact authority itself when edit-sync owns none, so the
    // bytes arrive after the click, not after the hover.
    const started = Date.now()
    await frame
      .locator('.vmde-block-handle-menu [data-action="duplicate"]')
      .click()
    // Reasons and counts only: names the silent exit if the action never reaches the host.
    await settle(frame, 3000)
    console.log(
      `BLOCK-ACTION-DECLINES ${JSON.stringify(
        await frame
          .locator('body')
          .evaluate(
            () =>
              (window as unknown as { __vmdeBlockActionDeclines?: object })
                .__vmdeBlockActionDeclines ?? {},
          ),
      )}`,
    )
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 30_000 })
      .toBe(planned.markdown)
    // The first block action after open pays the block handle's own proof (task 005 decision 2).
    console.log(
      `BLOCK-INDEX-MODEL ${JSON.stringify({ step: 'first menu action', ms: Date.now() - started })}`,
    )
  })

  test('after typing and the answered publication, hover needs no whole-document Lute call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame } = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'block-index-typing.md',
      fixture,
    )
    const before = await waitForLiveModel(frame)
    const paragraph = frame.locator(FIRST_PARAGRAPH).nth(2)
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.click()
    await workbox.keyboard.press('End')
    await workbox.keyboard.press('x')
    // The publication is answered when `compared` rises by one and no unit is dirty.
    await expect
      .poll(
        async () => {
          const stats = await readStats(frame)
          return (
            stats?.state === 'live' &&
            stats.compared > before.compared &&
            stats.dirtyNow === 0
          )
        },
        { timeout: 30_000, message: 'the publication is answered' },
      )
      .toBe(true)
    await resetCounters(frame)
    await expectHandleOver(frame, frame.locator(FIRST_PARAGRAPH).nth(3))
    const counters = await readCounters(frame)
    console.log(
      `BLOCK-INDEX-MODEL ${JSON.stringify({ step: 'hover after typing', counters })}`,
    )
    expect(counters.luteDocument, 'luteDocument').toBe(0)
  })

  test('a document with a reference definition keeps the model off and hover on the existing path', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame } = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'block-index-off.md',
      '# Title\n\nalpha [a]\n\n[a]: b.md\n\nomega\n',
    )
    await expect
      .poll(async () => (await readStats(frame))?.state, {
        timeout: 30_000,
        message: 'the model is off for a reference definition',
      })
      .toBe('off')
    // Lute moves a reference definition to the document end, so the existing path's source/DOM
    // pairing may offer no handle here (also on the base revision). What this case proves is that
    // an off model leaves hover on the existing path: its snapshot pair is read.
    await resetCounters(frame)
    await frame.locator(FIRST_PARAGRAPH).first().hover()
    await expect
      .poll(async () => (await readCounters(frame)).blockHandleSnapshotCalls, {
        timeout: 20_000,
        message: 'hover builds the index through the existing snapshot pair',
      })
      .toBeGreaterThan(0)
  })
})
