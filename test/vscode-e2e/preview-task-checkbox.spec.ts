import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = [
  '# Preview tasks',
  '',
  ...Array.from(
    { length: 24 },
    (_, n) => `Paragraph ${n}: enough content to scroll the preview pane.\n`,
  ),
  '',
  '- [ ] first real task',
  '- [ ] second real task',
  '',
  ...Array.from(
    { length: 24 },
    (_, n) => `Tail ${n}: keep the preview scrollable after the list.\n`,
  ),
  '',
].join('\n')
const FIRST = INITIAL.replace('- [ ] first real task', '- [x] first real task')
const BOTH = FIRST.replace('- [ ] second real task', '- [x] second real task')
const CHECKBOX =
  '.vditor-preview .vditor-reset li.vditor-task input[type="checkbox"]'

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args?: unknown) => Promise<unknown>

async function documentState(evaluateInVSCode: Evaluate, file: string) {
  return evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', version: doc?.version ?? -1 }
    },
    [file] as [string],
  ) as Promise<{ text: string; version: number }>
}

async function previewScroll(frame: Frame, item: number) {
  return frame.locator('body').evaluate(
    (_body, args: [string, number]) => {
      const input = document.querySelectorAll<HTMLInputElement>(args[0])[
        args[1]
      ]
      if (!input) throw new Error('preview task checkbox missing')
      input.scrollIntoView({ block: 'center' })
      let scroller: HTMLElement | null = input.parentElement
      while (scroller && scroller !== document.body) {
        const overflow = getComputedStyle(scroller).overflowY
        if (
          /auto|scroll|overlay/.test(overflow) &&
          scroller.scrollHeight > scroller.clientHeight + 4
        )
          break
        scroller = scroller.parentElement
      }
      if (!scroller || scroller === document.body)
        throw new Error('preview scroller missing')
      return {
        top: scroller.scrollTop,
        max: scroller.scrollHeight - scroller.clientHeight,
      }
    },
    [CHECKBOX, item] as [string, number],
  ) as Promise<{ top: number; max: number }>
}

async function scrollTop(frame: Frame) {
  return frame.locator('body').evaluate((_body, selector: string) => {
    const input = document.querySelector<HTMLInputElement>(selector)
    let scroller: HTMLElement | null = input?.parentElement ?? null
    while (scroller && scroller !== document.body) {
      const overflow = getComputedStyle(scroller).overflowY
      if (
        /auto|scroll|overlay/.test(overflow) &&
        scroller.scrollHeight > scroller.clientHeight + 4
      )
        return scroller.scrollTop
      scroller = scroller.parentElement
    }
    throw new Error('preview scroller missing')
  }, CHECKBOX) as Promise<number>
}

function taskMarkerStates(markdown: string): Array<[string, boolean]> {
  return Array.from(
    markdown.matchAll(/^- \[[xX ]\]\s+(first|second) real task$/gmu),
    (match) => [match[1], match[0].includes('[x]') || match[0].includes('[X]')],
  )
}

async function clickAndCheck(
  frame: Frame,
  evaluateInVSCode: Evaluate,
  file: string,
  item: number,
  expected: string,
) {
  const before = await documentState(evaluateInVSCode, file)
  const scroll = await previewScroll(frame, item)
  expect(scroll.max).toBeGreaterThan(100)
  expect(scroll.top).toBeGreaterThan(0)
  const checkbox = frame.locator(CHECKBOX).nth(item)
  await expect(checkbox).toBeEnabled()
  await checkbox.click()
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(expected)
  await expect
    .poll(async () => (await documentState(evaluateInVSCode, file)).version)
    .toBe(before.version + 1)
  await expect(checkbox).toBeEnabled()
  const liveValue = await frame
    .locator('body')
    .evaluate(() => window.vditor.getValue())
  expect(taskMarkerStates(liveValue)).toEqual(taskMarkerStates(expected))
  expect(Math.abs((await scrollTop(frame)) - scroll.top)).toBeLessThan(45)
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'preview.interactiveCheckboxes',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
})

test('Preview and SV right pane toggle one exact source marker and preserve scroll', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'preview-task-checkbox.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'preview.interactiveCheckboxes',
          true,
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )

  let frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
    },
  )
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator(CHECKBOX)).toHaveCount(2)
  await clickAndCheck(frame, evaluateInVSCode, file, 0, FIRST)
  // Return to the editable pane so one trusted Undo/Redo chord reaches the same native
  // TextDocument history as the guarded one-marker WorkspaceEdit.
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  // Focus alone does not establish the Selection Range Vditor's native Undo
  // requires when it restores a patch. Click rendered prose for a real caret.
  await frame.locator('.vditor-ir p').first().click()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(FIRST)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(FIRST)

  frame = await reopenVmdeFixture(evaluateInVSCode as any, workbox, file)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(FIRST)
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="sv"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    timeout: 60_000,
  })
  await expect(frame.locator(CHECKBOX)).toHaveCount(2)
  await clickAndCheck(frame, evaluateInVSCode, file, 1, BOTH)
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 10, y: 10 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(FIRST)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(BOTH)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(BOTH)

  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'preview.interactiveCheckboxes',
        false,
        vscode.ConfigurationTarget.Global,
      )
  })
  await expect
    .poll(async () => frame.locator(`${CHECKBOX}:disabled`).count())
    .toBe(2)
})
