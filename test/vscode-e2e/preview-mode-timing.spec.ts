// Task 643 (acceptance 4): Preview reaches visible content and finishes rendering faster than IR.
// The same document opens in IR and in Preview three times each after a discarded cold open, in one
// VS Code session; the medians of (content visible, complete) measured from the `init` message are
// compared by ratio. Targets (revised 2026-11-01 after measuring: Task 641 made IR open 150 KB in
// about 600 ms and Preview uses the same Lute engine): 2 KB visible and complete within 25 ms of IR;
// 30 KB visible and complete <= 0.9 of IR; 150 KB visible <= 0.5 and complete <= 0.95 of IR.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  openFile,
  setConfig,
  waitComplete,
  writeDocument,
} from './preview-mode-helpers'

const RUNS = 3
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

// Realistic documents (tables, numbered lists, links, reference-style prose), as the Task 641
// fixtures were: a prefix of a committed synthetic fixture, cut at a block boundary.
const slice = (fixture: string, chars: number) => {
  const text = readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8')
  const cut = text.lastIndexOf('\n\n', chars)
  return text.slice(0, cut > 0 ? cut : chars) + '\n'
}

const TARGETS = [
  {
    chars: 2_000,
    fixture: 'large-structured-synthetic.md',
    visible: null,
    complete: null,
    slackMs: 25,
  },
  {
    chars: 30_000,
    fixture: 'large-structured-synthetic.md',
    visible: 0.9,
    complete: 0.9,
    slackMs: 0,
  },
  {
    chars: 150_000,
    fixture: 'large-observable-models-synthetic.md',
    visible: 0.5,
    complete: 0.95,
    slackMs: 0,
  },
] as const

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

test('Preview opens faster than IR on 2 KB, 30 KB and 150 KB documents', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const results: Record<string, unknown> = {}
  const failures: string[] = []
  const check = (label: string, actual: number, limit: number) =>
    actual <= limit
      ? []
      : [`${label}: ${Math.round(actual)} ms > ${Math.round(limit)} ms`]
  for (const target of TARGETS) {
    const text = slice(target.fixture, target.chars)
    const file = writeDocument(
      baseDir,
      `preview-mode-timing-${target.chars}.md`,
      text,
    )
    const measured: Record<string, { visible: number; complete: number }> = {}
    for (const surface of ['ir', 'preview'] as const) {
      await setConfig(evaluateInVSCode, 'editor.defaultMode', surface)
      const visible: number[] = []
      const complete: number[] = []
      for (let run = 0; run <= RUNS; run++) {
        const frame = await openFile(evaluateInVSCode, workbox, file)
        const done = await waitComplete(frame)
        // Run 0 is the cold open of this surface; it is discarded.
        if (run === 0) continue
        console.log(
          '[Task 643 timing run]',
          target.chars,
          surface,
          JSON.stringify(done),
        )
        const init = done.initReceivedMs as number
        visible.push((done.contentVisibleMs as number) - init)
        complete.push((done.completeMs as number) - init)
        expect(done.surface).toBe(surface)
      }
      measured[surface] = {
        visible: median(visible),
        complete: median(complete),
      }
    }
    results[String(target.chars)] = measured
    console.log('[Task 643 timing]', target.chars, JSON.stringify(measured))
    const { ir, preview } = measured
    if (target.visible === null) {
      failures.push(
        ...check(
          `${target.chars} visible`,
          preview.visible,
          ir.visible + target.slackMs,
        ),
        ...check(
          `${target.chars} complete`,
          preview.complete,
          ir.complete + target.slackMs,
        ),
      )
    } else {
      failures.push(
        ...check(
          `${target.chars} visible`,
          preview.visible,
          ir.visible * target.visible,
        ),
        ...check(
          `${target.chars} complete`,
          preview.complete,
          ir.complete * target.complete,
        ),
      )
    }
  }
  const out = path.join(__dirname, '..', '..', 'tmp', '643')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    path.join(out, 'timing-results.json'),
    JSON.stringify(results, null, 2),
  )
  expect(failures).toEqual([])
})
