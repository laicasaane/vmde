// Task 643 (acceptance 2 and 5): a document over the streaming threshold opens in Preview with
// content before the whole document is rendered, and no long task above the real-VS-Code limit
// while it streams. The far diagram is rendered only when it is scrolled near.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PANE,
  PREVIEW_BUTTON,
  editTextLength,
  metrics,
  openFile,
  setConfig,
  waitComplete,
} from './preview-mode-helpers'

const LONG_TASK_LIMIT_MS = 150
const FIRST_CONTENT_LIMIT_MS = 1_000

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

test('an 800 KB document streams into Preview in bounded steps and renders far diagrams on demand', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(420_000)
  const sections = 1200
  const parts = ['# Streamed Preview fixture\n\n']
  for (let i = 0; i < sections; i++) {
    parts.push(`## Section ${i}\n\n${'lorem ipsum '.repeat(55)}\n\n`)
    if (i === 1100) parts.push('```mermaid\ngraph LR; far-->diagram\n```\n\n')
  }
  const text = parts.join('')
  expect(text.length).toBeGreaterThan(700_000)
  const file = path.join(baseDir, 'preview-mode-stream.md')
  writeFileSync(file, text)

  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, file)
  const done = await waitComplete(frame, 240_000)

  expect(done.previewChunks).toBeGreaterThan(10)
  expect(done.contentVisibleMs as number).toBeLessThan(
    done.completeMs as number,
  )
  const firstContent =
    (done.contentVisibleMs as number) - (done.initReceivedMs as number)
  console.log(
    '[Task 643 stream]',
    JSON.stringify({ ...done, firstContentAfterInitMs: firstContent }),
  )
  expect(firstContent).toBeLessThanOrEqual(FIRST_CONTENT_LIMIT_MS)
  // No edit view was built for an 800 KB document.
  expect(await editTextLength(frame)).toBe(0)

  const observed = await frame.locator('body').evaluate(
    () =>
      new Promise<{ tasks: Array<[number, number]>; frames: unknown[] }>(
        (resolve) => {
          const tasks: Array<[number, number]> = []
          const frames: unknown[] = []
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              tasks.push([entry.startTime, entry.duration])
          })
          observer.observe({ type: 'longtask', buffered: true })
          // Diagnostics only: which scripts and how much forced layout the slow frames held.
          let frameObserver: PerformanceObserver | undefined
          try {
            frameObserver = new PerformanceObserver((list) => {
              for (const entry of list.getEntries() as any[])
                if (entry.duration > 100)
                  frames.push({
                    start: Math.round(entry.startTime),
                    duration: Math.round(entry.duration),
                    blocking: Math.round(entry.blockingDuration),
                    styleAndLayoutMs: Math.round(
                      entry.startTime +
                        entry.duration -
                        entry.styleAndLayoutStart,
                    ),
                    scripts: (entry.scripts ?? []).map((script: any) => [
                      script.invoker,
                      script.sourceFunctionName,
                      Math.round(script.duration),
                      Math.round(script.forcedStyleAndLayoutDuration),
                    ]),
                  })
            })
            frameObserver.observe({
              type: 'long-animation-frame',
              buffered: true,
            })
          } catch {
            /* long-animation-frame unsupported */
          }
          setTimeout(() => {
            observer.disconnect()
            frameObserver?.disconnect()
            resolve({ tasks, frames })
          }, 300)
        },
      ),
  )
  const longTasks = observed.tasks
  console.log('[Task 643 stream slow frames]', JSON.stringify(observed.frames))
  const during = longTasks.filter(
    ([start]) =>
      start >= (done.contentVisibleMs as number) &&
      start <= (done.completeMs as number),
  )
  console.log('[Task 643 stream long tasks]', JSON.stringify(during))
  expect(
    Math.max(0, ...during.map(([, duration]) => duration)),
    JSON.stringify(during),
  ).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS)

  // Acceptance 5: the far mermaid block is held back until it is scrolled near.
  const block = frame.locator(`${PANE} .language-mermaid`)
  await expect(block).toHaveAttribute('data-vmde-preview-pending', 'true')
  expect(await block.locator('svg').count()).toBe(0)
  await block.scrollIntoViewIfNeeded()
  await expect(block).not.toHaveAttribute('data-vmde-preview-pending', 'true')
  await expect(block.locator('svg')).toHaveCount(1, { timeout: 60_000 })
  expect((await metrics(frame)).completeMs).toBe(done.completeMs)

  // Leaving Preview builds the large edit view (streamed in), which is the first time it exists.
  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() => frame.locator('.vditor-ir h2').count(), {
      timeout: 300_000,
      intervals: [2_000],
    })
    .toBe(sections)
})
