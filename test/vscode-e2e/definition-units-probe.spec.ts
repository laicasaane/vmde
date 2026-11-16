import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { definitionHeavyMarkdown } from './definition-heavy-markdown'
import {
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 733 / 017 (task 017 section 6.8): probe rows of the definition units at factor 16. Timings are
// recorded as annotations for run 2's final probe and not asserted here; a row over 50 ms follows the
// D-13 post-run-2 policy with DEFINITION_UNITS as the guard. The ToC option is on during the probe.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: unknown[]) => Promise<unknown>

const ROWS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['definition type 80', '[data-type="link-ref-defs-block"]', '[guide]', 'x'],
  ['footnote type 80', '[data-type="footnotes-def"] p', 'The first note.', 'x'],
  ['reference paragraph type 80', '.vditor-reset > p', 'First paragraph', 'x'],
  ['heading edit with toc', '.vditor-reset > h2', 'Items', 'Z'],
]

const setToc = (evaluate: Evaluate, on: boolean) =>
  evaluate(
    async (vscode: typeof import('vscode'), args: unknown[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'markdown.toc',
          args[0] ? true : undefined,
          vscode.ConfigurationTarget.Global,
        )
    },
    [on],
  )

/** Caret at the end of the last non-empty text of the first `selector` element holding `needle`. */
async function placeCaret(frame: Frame, selector: string, needle: string) {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(
    (_body, [sel, text]) => {
      const root = document.querySelector<HTMLElement>(
        '.vditor-ir .vditor-reset',
      )
      const target = Array.from(
        root?.querySelectorAll<HTMLElement>(sel as string) ?? [],
      ).find((el) => (el.textContent ?? '').includes(text as string))
      if (!root || !target) return false
      target.scrollIntoView({ block: 'center' })
      const nodes = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      for (let n = nodes.nextNode(); n; n = nodes.nextNode())
        if ((n.textContent ?? '').trim() !== '') last = n as Text
      if (!last) return false
      const caret = document.createRange()
      caret.setStart(last, (last.textContent ?? '').replace(/\n+$/u, '').length)
      caret.collapse(true)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(caret)
      root.focus({ preventScroll: true })
      return true
    },
    [selector, needle],
  )
  expect(placed, `caret placed in ${selector}`).toBe(true)
}

test.describe('@probe definition units (task 733 / 017)', () => {
  test.afterEach(async ({ evaluateInVSCode }) => {
    await setToc(evaluateInVSCode as Evaluate, false)
  })

  test('@probe definition rows at factor 16', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const evaluate = evaluateInVSCode as Evaluate
    await setToc(evaluate, true)
    const text = definitionHeavyMarkdown(16)
    for (const [row, selector, needle, key] of ROWS) {
      const file = path.join(baseDir, `dup-${row.replace(/\W+/gu, '-')}.md`)
      writeFileSync(file, text)
      const frame = (await reopenVmdeFixture(
        evaluate as never,
        workbox,
        file,
      )) as Frame
      await waitForE2EReadiness(
        frame,
        (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
        { message: 'the definition probe editor installed its router' },
      )
      await placeCaret(frame, selector, needle)
      const times: number[] = []
      const count = row.includes('80') ? 80 : 10
      for (let i = 0; i < count; i++) {
        const start = Date.now()
        await workbox.keyboard.type(key)
        times.push(Date.now() - start)
      }
      await settle(frame, 1500)
      times.sort((a, b) => a - b)
      test.info().annotations.push({
        type: 'probe',
        description: `${row}: max ${times.at(-1)} ms, p95 ${times[Math.floor(times.length * 0.95)]} ms`,
      })
    }
  })
})
