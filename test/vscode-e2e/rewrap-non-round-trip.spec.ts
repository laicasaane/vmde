// Task 606: Rewrap and heading shift on a document whose rendering
// differs from its source (the table is written without padding, so Lute rewrites it). Each action
// applies only on a proven target: the host document changes only the target's bytes, saved bytes
// equal the host, and one Undo restores the opened bytes. An unprovable target (an element-offset
// selection) declines and leaves the host document untouched.
//
// Selection link and Details/callout cases belong to Task 630 and are not here.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { rewrapMarkdownRange } from '../../media-src/src/editing/rewrap-markdown'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

const COLUMN = 30
const SOURCE = readFileSync(
  path.join(__dirname, 'fixtures', 'rewrap-non-round-trip.md'),
  'utf8',
)
const TABLE = '|a|b|\n|---|---|\n|x|y|'
const P1 =
  'Alpha one two three four five six seven eight nine ten eleven twelve.'
const P2 = 'Omega red orange yellow green blue indigo violet purple pink brown.'
const P1_START = SOURCE.indexOf(P1)

/** Every byte of `after` outside [start, end) of `before` is the byte `before` held. */
function expectOnlyWithin(
  before: string,
  after: string,
  start: number,
  end: number,
) {
  expect(after).not.toBe(before)
  expect(after.slice(0, start)).toBe(before.slice(0, start))
  expect(after.slice(after.length - (before.length - end))).toBe(
    before.slice(end),
  )
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of [
      'editor.wrapColumn',
      'editor.autoWrap',
      'editor.autoWrapDelay',
      'editor.defaultMode',
    ]) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    }
  })
})

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: Rewrap and heading shift change only the proven target; an unprovable target declines`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const file = path.join(baseDir, `rewrap-non-round-trip-${mode}.md`)
    writeFileSync(file, SOURCE)
    await evaluateInVSCode(
      async (vscode, args: [string, string, string, string]) => {
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update(
          'editor.wrapColumn',
          30,
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'editor.autoWrap',
          false,
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'editor.defaultMode',
          args[3],
          vscode.ConfigurationTarget.Global,
        )
        await vscode.extensions.getExtension(args[1])?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          args[2],
        )
      },
      [file, ExtensionId, MarkdownEditorViewType, mode] as [
        string,
        string,
        string,
        string,
      ],
    )
    const frame = wf(workbox)
    await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === mode,
      { message: `rewrap non-round-trip readiness (${mode})` },
    )
    await waitForInitialUndoSnapshot(frame)
    await frame
      .locator(`.vditor-${mode}`)
      .first()
      .click({ position: { x: 4, y: 4 } })

    const host = () => docText(evaluateInVSCode, file)
    const run = (command: string) =>
      evaluateInVSCode(async (vscode, id: string) => {
        await vscode.commands.executeCommand(id)
      }, command)
    // A proof-only command declines (and posts nothing) while the proof is not ready, for example
    // right after an Undo or a mode switch; run it again until the host takes the expected text.
    const runUntilHost = async (command: string, expected: string) => {
      for (let attempt = 1; attempt <= 8; attempt++) {
        await run(command)
        const reached = await expect
          .poll(host, { timeout: 2_500 })
          .toBe(expected)
          .then(
            () => true,
            () => false,
          )
        if (reached) {
          console.log(`[606] ${mode} ${command} attempts=${attempt}`)
          return
        }
      }
      await expect.poll(host, { timeout: 5_000 }).toBe(expected)
    }
    const rendered = () =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string)
    // The opened bytes must differ from the rendering, or no case would exercise the proof.
    expect(await host()).toBe(SOURCE)
    expect(await rendered()).not.toBe(SOURCE)

    // Places a collapsed caret inside live text and captures it the way a pointer selection is
    // captured before the command palette takes focus.
    const placeCaret = async (needle: string, offset: number) => {
      await frame.locator('body').evaluate(
        (_body, input) => {
          const inner = (window as any).vditor.vditor
          const editor = inner[inner.currentMode].element as HTMLElement
          const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const index = (node.textContent ?? '').indexOf(input.needle)
            if (index < 0) continue
            editor.focus({ preventScroll: true })
            const range = document.createRange()
            range.setStart(node, index + input.offset)
            range.collapse(true)
            const selection = getSelection()!
            selection.removeAllRanges()
            selection.addRange(range)
            document.dispatchEvent(new Event('selectionchange'))
            ;(window as any).__vmdeCaptureRewrapSelectionForTest?.()
            return
          }
          throw new Error(`${input.needle} not found`)
        },
        { needle, offset },
      )
    }
    const placeUnprovableCaret = () =>
      frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        const editor = inner[inner.currentMode].element as HTMLElement
        editor.focus({ preventScroll: true })
        const range = document.createRange()
        // An element offset includes syntax boundaries, so it can never be proven.
        range.setStart(editor, 0)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        ;(window as any).__vmdeCaptureRewrapSelectionForTest?.()
      })
    const save = async () => {
      await run('workbench.action.files.save')
      await expect.poll(() => readFileSync(file, 'utf8')).toBe(await host())
    }
    const undoToSource = async () => {
      await frame
        .locator(`.vditor-${mode}`)
        .first()
        .click({ position: { x: 4, y: 4 } })
      await workbox.keyboard.press('Control+z')
      await expect.poll(host, { timeout: 20_000 }).toBe(SOURCE)
    }

    // Selection Rewrap.
    await placeCaret('three', 2)
    const caret = SOURCE.indexOf('three') + 2
    const rewrapPlan = rewrapMarkdownRange(SOURCE, caret, caret, caret, COLUMN)
    expect(rewrapPlan.changed).toBe(true)
    await runUntilHost('vmde.rewrap', rewrapPlan.markdown)
    expectOnlyWithin(SOURCE, await host(), P1_START, P1_START + P1.length)
    expect(await host()).toContain(`\n\n${TABLE}\n\n`)
    expect((await host()).endsWith(`\n\n${P2}\n`)).toBe(true)
    await save()
    await undoToSource()
    await save()

    // Heading shift.
    await placeCaret('Sub', 1)
    await runUntilHost(
      'vmde.demoteHeading',
      SOURCE.replace('## Sub', '### Sub'),
    )
    await save()
    await undoToSource()
    await save()

    // Unprovable target: nothing is posted, so the host document and the file stay as opened. An
    // element offset is unprovable in IR only; WYSIWYG proves it as the start of the first block.
    if (mode === 'ir') {
      await placeUnprovableCaret()
      for (const command of ['vmde.rewrap']) {
        await run(command)
        // Negative-observation wait: a declined command has no completion event to poll for.
        await frame
          .locator('body')
          .evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
        expect(await host(), `${command} on an unprovable target`).toBe(SOURCE)
      }
      expect(readFileSync(file, 'utf8')).toBe(SOURCE)
    }
  })
}
