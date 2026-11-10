import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { docText, waitForInitialUndoSnapshot, wf } from './webview-helpers'

// Task 719 — after typing, a real Ctrl+V in IR must leave the caret at the end of the pasted text,
// so the next typed key lands there. The pre-paste Undo checkpoint (taken while the typing is still
// inside the undo delay) used to arm a caret intent at the pre-paste caret; when the first frame
// ran before the boundary's own timer, the caret authority wrote that stale position back and the
// key landed at the start of the pasted text. Each case repeats on a fresh document because the
// race depends on frame-versus-timer order and was lost 12-88 % of the time per run.
//
// Task 719 Part 2b — a paste into inline code must also run Vditor's paste() to the end: its
// preview-sibling lookup read `.classList` of a null next sibling and threw a TypeError that skipped
// the wbr re-spin and the after-render callbacks. Every case collects window errors and unhandled
// rejections inside the webview and fails on any of them.
//
// Placement uses the marked selection writer (retires any live intent, like a click). The typed
// keys, the paste and the final key go through XTEST so VS Code's own clipboard bridge delivers
// the paste.

const DIR = path.join(tmpdir(), 'vmde-t719-paste-caret')
const REPEAT = 8
const TABLE_DOC =
  '# Table\n\n| Name | Value |\n| --- | --- |\n| row `alpha beta` | other |\n\nAfter table paragraph.\n'
const INLINE_CODE_DOC =
  '# Inline\n\nIntro with `code span` here.\n\nAfter paragraph.\n'
const PROSE_DOC =
  '# Prose\n\nAlpha bravo charlie delta echo.\n\nGolf hotel india juliet.\n'

interface Case {
  name: string
  doc: string
  /** Text-node needle (unique in the document) and the caret offset inside it. */
  needle: string
  offset: number
  clip: string
  /** Fragment the host document must contain once the final key `Q` has landed. */
  expected: string
}

const CASES: Case[] = [
  {
    name: 'inline code in a table body cell',
    doc: TABLE_DOC,
    needle: 'alpha beta',
    offset: 5,
    clip: 'Pastel',
    expected: '`alphaxyPastelQ beta`',
  },
  {
    name: 'inline code in a paragraph',
    doc: INLINE_CODE_DOC,
    needle: 'code span',
    offset: 4,
    clip: 'Pastel',
    expected: '`codexyPastelQ span`',
  },
  {
    name: 'plain paragraph',
    doc: PROSE_DOC,
    needle: 'Alpha bravo charlie',
    offset: 11,
    clip: 'Pastel',
    expected: 'Alpha bravoxyPastelQ charlie',
  },
  {
    name: 'multi-line paragraph clip',
    doc: PROSE_DOC,
    needle: 'Alpha bravo charlie',
    offset: 11,
    clip: 'para one\n\npara two',
    expected: 'para twoQ',
  },
]

const flatten = (text: string) => text.replace(/​/g, '')

for (const c of CASES) {
  test(`IR paste after typing lands the next key at the end of the pasted text: ${c.name}`, async ({
    workbox,
    electronApp,
    evaluateInVSCode,
  }) => {
    test.setTimeout(20 * 60_000)
    mkdirSync(DIR, { recursive: true })
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      },
      [] as [],
    )
    const xtest = await createXtestInput(electronApp as never, workbox as never)
    const frame = wf(workbox)
    const pause = (ms: number) =>
      frame
        .locator('body')
        .evaluate(
          (_el, d) => new Promise((r) => setTimeout(r, d as number)),
          ms,
        )
    const open = async (file: string) => {
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) => {
          await vscode.commands.executeCommand(
            'workbench.action.closeAllEditors',
          )
          await vscode.commands.executeCommand(
            'vscode.openWith',
            vscode.Uri.file(args[0]),
            'vmde.editor',
          )
        },
        [file] as [string],
      )
      await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
      await waitForInitialUndoSnapshot(frame)
      await pause(300)
    }

    // Warm-up: the first XTEST Ctrl chord of a session sometimes never reaches the webview.
    const warm = path.join(DIR, 'warm.md')
    writeFileSync(warm, PROSE_DOC)
    await open(warm)
    await frame.locator('.vditor-ir .vditor-reset p').first().click()
    await xtest.key('ctrl+z')
    await pause(300)

    const failures: string[] = []
    for (let i = 0; i < REPEAT; i++) {
      const file = path.join(DIR, `case-${i}.md`)
      writeFileSync(file, c.doc)
      await open(file)
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) => {
          await vscode.env.clipboard.writeText(args[0])
        },
        [c.clip] as [string],
      )
      await frame.locator('body').evaluate(() => {
        const w = window as any
        w.__vmdeErrs = []
        w.addEventListener('error', (e: ErrorEvent) =>
          w.__vmdeErrs.push(`error: ${e.message}`),
        )
        w.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) =>
          w.__vmdeErrs.push(`rejection: ${String(e.reason)}`),
        )
      })
      await frame.locator('body').evaluate((_el, t) => {
        const w = window as any
        const root: HTMLElement = w.vditor.vditor.ir.element
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = (n.textContent ?? '').indexOf(t.needle)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(n, at + t.offset)
          range.collapse(true)
          root.focus({ preventScroll: true })
          w.__vmdeWriteSelection(range)
          return
        }
        throw new Error(`needle not found: ${t.needle}`)
      }, c)
      await xtest.type('xy')
      await pause(300)
      await xtest.key('ctrl+v')
      await xtest.type('Q')
      let text = ''
      await expect
        .poll(
          async () => {
            text = flatten(await docText(evaluateInVSCode, file))
            return text.includes('Q')
          },
          { timeout: 8000 },
        )
        .toBe(true)
        .catch(() => undefined)
      const errs = await frame
        .locator('body')
        .evaluate(() => (window as any).__vmdeErrs as string[])
      if (!text.includes(c.expected) || errs.length > 0)
        failures.push(
          `run ${i}: ${JSON.stringify(text)} errors=${JSON.stringify(errs)}`,
        )
      rmSync(file, { force: true })
    }
    rmSync(warm, { force: true })
    expect(failures, `${failures.length}/${REPEAT} runs wrong`).toEqual([])
  })
}
