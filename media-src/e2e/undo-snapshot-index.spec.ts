/**
 * Task 610 S3 — Vditor's delayed Undo snapshot is source-neutral for the shared source index, on
 * the large synthetic fixture in Chromium (IR and WYSIWYG).
 *
 * Acceptance 1 and 3: after the index is warmed BEFORE the opening checkpoint (the order that
 * triggered the rebuild in the Task 604 attribution), Vditor's own delayed `addToUndoStack` writes
 * and removes its caret marker; the next source-backed request then does 0 index builds, finds the
 * same index entry and `domRevision`, leaves the exact source byte-identical and answers within
 * the Owner budget (100 ms, measured handler-to-options in the page, excluding paint).
 * Acceptance 2 (control): a real edit after the snapshot does rebuild and returns correct options.
 * Edge case: the `characterData` record that the Undo-snapshot proof pairs with the split Text
 * tail is recorded from the engine under test, so a rejected scope would show as a build.
 */
import { createHash } from 'node:crypto'
import { expect, test } from './coverage-fixture'
import {
  FIXTURE,
  FIXTURE_SHA256,
} from '../../test/vscode-e2e/find-replace-fixture-helpers'

type Page = import('@playwright/test').Page
type Mode = 'ir' | 'wysiwyg'
type Span = { start: number; end: number; caret: number }

// Node derives the paragraph's offsets (the 208th line); the browser receives only the span.
const lines = FIXTURE.split('\n')
const nearStart = lines
  .slice(0, 207)
  .reduce((sum, line) => sum + line.length + 1, 0)
const NEAR: Span = {
  start: nearStart,
  end: nearStart + lines[207].length,
  caret: nearStart + Math.floor(lines[207].length / 2),
}
const BUDGET_MS = 100
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function boot(page: Page, mode: Mode) {
  await page.addInitScript(() => {
    ;(window as any).__vmdeBlockHandleCacheMetrics = {
      indexBuilds: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
    }
  })
  await page.goto(`/turn-into-exact.html?mode=${mode}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.mouse.move(0, 0)
}

// Load the large document with the caret in the target paragraph, then wait until it is quiet:
// Vditor's opening checkpoint has run and nothing has written to the live DOM for a run of
// frames (code highlighting and similar follow-up renders finish by then). Polls only.
async function loadAndSettle(page: Page, source: string, span: Span) {
  expect(
    await page.evaluate(
      ({ source, span }) => {
        const w = window as any
        w.__setValue(source)
        return w.__select(span)
      },
      { source, span },
    ),
  ).toBe(true)
  await expect
    .poll(() => page.evaluate(() => (window as any).__undoDepth()), {
      timeout: 60_000,
    })
    .toBeGreaterThan(0)
  let last = -1
  let stable = 0
  await expect
    .poll(
      async () => {
        const revision = await page.evaluate(() =>
          (window as any).__indexRevision(),
        )
        await frames(page)
        stable = revision === last ? stable + 1 : 0
        last = revision
        return stable
      },
      { timeout: 60_000, intervals: [0] },
    )
    .toBeGreaterThanOrEqual(20)
}

// Warm the index and start recording the marker writes; returns the state to compare against.
async function warm(page: Page) {
  return page.evaluate(() => {
    const w = window as any
    const metrics = w.__vmdeBlockHandleCacheMetrics
    const root = w.__root() as HTMLElement
    const log = {
      markerAdded: 0,
      markerRemoved: 0,
      truncated: 0,
      splitTails: 0,
      pairedTails: 0,
      textAdded: 0,
      otherAdded: 0,
    }
    const isMarker = (node: Node) =>
      node instanceof HTMLElement && node.classList.contains('vditor-wbr')
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page tally of the marker, split and pairing records; splitting it would only move the branches.
    const observer = new MutationObserver((records) => {
      const truncated = new Set<Node>()
      for (const record of records)
        if (record.type === 'characterData') {
          log.truncated++
          truncated.add(record.target)
        }
      for (const record of records) {
        log.markerRemoved += Array.from(record.removedNodes).filter(
          isMarker,
        ).length
        for (const node of Array.from(record.addedNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            log.textAdded++
            continue
          }
          if (!isMarker(node)) {
            log.otherAdded++
            continue
          }
          log.markerAdded++
          // The marker went in between the two halves of a split Text node.
          const head = record.previousSibling
          const tail = record.nextSibling
          if (
            head?.nodeType === Node.TEXT_NODE &&
            tail?.nodeType === Node.TEXT_NODE
          ) {
            log.splitTails++
            if (truncated.has(head)) log.pairedTails++
          }
        }
      }
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    w.__markerLog = log
    const remembered = w.__rememberIndex()
    return {
      remembered,
      builds: metrics.indexBuilds as number,
      revision: w.__indexRevision() as number,
      depth: w.__undoDepth() as number,
    }
  })
}

async function request(page: Page) {
  return page.evaluate(() => {
    const w = window as any
    const metrics = w.__vmdeBlockHandleCacheMetrics
    const before = metrics.indexBuilds as number
    const begin = performance.now()
    const options = w.__blockOptions()
    const ms = performance.now() - begin
    return {
      ms,
      builds: (metrics.indexBuilds as number) - before,
      optionsReturned: Boolean(options),
      currentTypeIsParagraph: options?.currentType === 'paragraph',
      h2Changed:
        options?.targets.some(
          (t: any) => t.type === 'h2' && t.status === 'changed',
        ) ?? false,
      start: options?.span.start as number | undefined,
      end: options?.span.end as number | undefined,
      // Read after the timed window: the exact source under the returned span.
      spanText: options
        ? (w.__exact() as string).slice(options.span.start, options.span.end)
        : '',
      survived: w.__indexSurvived() as boolean,
      revision: w.__indexRevision() as number,
    }
  })
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: a delayed Undo snapshot keeps the warmed index and the next request builds nothing; a real edit still rebuilds`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await boot(page, mode)
    await loadAndSettle(page, FIXTURE, NEAR)
    const warmed = await warm(page)
    expect(warmed.remembered).toBe(true)
    expect(warmed.builds).toBe(1)
    expect(sha256(await page.evaluate(() => (window as any).__exact()))).toBe(
      FIXTURE_SHA256,
    )

    // The same request before any snapshot: its time is the request's own cost, not the snapshot's.
    const baseline = await request(page)
    console.log(JSON.stringify({ mode, baseline }))
    expect(baseline.builds).toBe(0)
    // Vditor's delayed snapshot is a timer: poll the Undo stack, never sleep.
    await page.evaluate(() => (window as any).__scheduleUndoSnapshot())
    await expect
      .poll(() => page.evaluate(() => (window as any).__undoDepth()), {
        timeout: 60_000,
      })
      .toBeGreaterThan(warmed.depth)
    await frames(page)
    const log = await page.evaluate(() => (window as any).__markerLog)
    console.log(JSON.stringify({ mode, markerWrites: log }))
    // Non-vacuous: the snapshot really inserted and removed the marker, split the Text node, and
    // this engine queued the characterData record the Undo-snapshot proof pairs with the tail.
    expect(log.markerAdded).toBeGreaterThan(0)
    expect(log.markerRemoved).toBeGreaterThan(0)
    expect(log.splitTails).toBeGreaterThan(0)
    expect(log.truncated).toBeGreaterThan(0)
    expect(log.pairedTails).toBe(log.splitTails)
    // Nothing but the marker and the one split tail was added to the live DOM.
    expect(log.textAdded).toBe(log.splitTails)
    expect(log.otherAdded).toBe(0)

    // Acceptance 1 and 3: nothing was rebuilt and the first source-backed request is warm.
    const afterSnapshot = await page.evaluate(() => {
      const w = window as any
      const metrics = w.__vmdeBlockHandleCacheMetrics
      const survived = w.__indexSurvived() as boolean
      const revision = w.__indexRevision() as number
      // The first read after the snapshot: Decision 3's budget applies to this warm lookup.
      const begin = performance.now()
      const read = w.__readIndex()
      const readMs = performance.now() - begin
      return {
        builds: metrics.indexBuilds as number,
        survived,
        revision,
        returned: read.returned as boolean,
        readMs,
      }
    })
    console.log(JSON.stringify({ mode, afterSnapshot }))
    expect({ ...afterSnapshot, readMs: 0 }).toEqual({
      builds: warmed.builds,
      survived: true,
      revision: warmed.revision,
      returned: true,
      readMs: 0,
    })
    expect(afterSnapshot.readMs).toBeLessThanOrEqual(BUDGET_MS)
    const warmRequest = await request(page)
    console.log(JSON.stringify({ mode, warmRequest }))
    expect(warmRequest.optionsReturned).toBe(true)
    expect(warmRequest.currentTypeIsParagraph && warmRequest.h2Changed).toBe(
      true,
    )
    expect([warmRequest.start, warmRequest.end]).toEqual([NEAR.start, NEAR.end])
    expect(warmRequest.spanText).toBe(FIXTURE.slice(NEAR.start, NEAR.end))
    expect(warmRequest.builds).toBe(0)
    expect(warmRequest.survived).toBe(true)
    expect(warmRequest.revision).toBe(warmed.revision)
    // The whole request also serializes the document once outside the index. Its handler-to-options
    // time is logged, not asserted: it is the same with no snapshot at all (see `baseline`), so it
    // is not what the snapshot costs and it does not fit the 100 ms budget on this fixture.
    expect(sha256(await page.evaluate(() => (window as any).__exact()))).toBe(
      FIXTURE_SHA256,
    )

    // Acceptance 2 (control): a trusted keystroke is a real edit. It invalidates, the next request
    // rebuilds exactly once, and the options are correct for the edited paragraph.
    await page.keyboard.type('x')
    const edited = await request(page)
    console.log(JSON.stringify({ mode, edited }))
    expect(edited.builds).toBe(1)
    expect(edited.revision).toBeGreaterThan(warmed.revision)
    expect(edited.optionsReturned).toBe(true)
    expect(edited.currentTypeIsParagraph && edited.h2Changed).toBe(true)
    // The returned span covers the paragraph with exactly the typed character added.
    const original = FIXTURE.slice(NEAR.start, NEAR.end)
    const at = [...edited.spanText].findIndex((c, i) => c !== original[i])
    expect(edited.spanText.length).toBe(original.length + 1)
    expect(edited.spanText[at]).toBe('x')
    expect(
      `${edited.spanText.slice(0, at)}${edited.spanText.slice(at + 1)}`,
    ).toBe(original)
  })
}
