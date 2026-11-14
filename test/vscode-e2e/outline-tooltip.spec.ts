import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  type docText,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 729: every Outline entry shows its full heading text on hover, because a narrow Outline
// panel cuts long entries off with an ellipsis. Task 732: the text shows in the toolbar-style hover
// box (`body > .vmde-hover-tip`), never as a native `title`. It must follow a heading edit and must
// not change the document, the dirty state or the Undo depth.

type Frame = ReturnType<typeof wf>
type HostEvaluator = Parameters<typeof docText>[0]
type Mode = 'ir' | 'wysiwyg'

const LONG = 'A very long heading that a narrow outline panel must cut off'
const FIXTURE = `# Short

## ${LONG}

Paragraph under the long heading.
`

const visibleFrame = (workbox: Page) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

interface View {
  value: string
  undoDepth: number
  shown: boolean
}

const view = (frame: Frame) =>
  frame.locator('body').evaluate((): View => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: string
          undo: Record<string, { undoStack: unknown[] }>
        }
      }
    }
    const inner = outer.vditor.vditor
    const panel = document.querySelector<HTMLElement>('.vditor-outline')
    const rect = panel?.getBoundingClientRect()
    return {
      value: outer.vditor.getValue(),
      undoDepth:
        ((globalThis as any).__vmdeUnitHistory?.holds(inner)
          ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
          : inner.undo[inner.currentMode]?.undoStack.length) ?? -1,
      shown:
        !!panel &&
        getComputedStyle(panel).display !== 'none' &&
        (rect?.width ?? 0) > 0,
    }
  })

// Host side: the open document's text and dirty flag.
const hostState = (evaluateInVSCode: HostEvaluator, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', dirty: doc?.isDirty ?? false }
    },
    [file] as [string],
  ) as Promise<{ text: string; dirty: boolean }>

const ENTRY = '.vditor-outline li span[data-target-id]'
const shownBox = (frame: Frame) =>
  frame.locator('body > .vmde-hover-tip:not([hidden])')

// Hover each Outline entry with the real pointer, in document order, and read the box it shows.
// Also asserts no entry carries a native `title`.
const titles = async (frame: Frame) => {
  const entries = frame.locator(ENTRY)
  const count = await entries.count()
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    await entries.nth(i).hover()
    await expect(shownBox(frame)).toBeVisible({ timeout: 5_000 })
    texts.push((await shownBox(frame).textContent()) ?? '')
  }
  const own = await entries.evaluateAll(
    (els) => els.filter((el) => el.hasAttribute('title')).length,
  )
  expect(own, 'no Outline entry carries a native title').toBe(0)
  // Park the pointer away from the Outline so the next read starts from a hidden box.
  await frame.locator('.vditor-toolbar').hover({ position: { x: 2, y: 2 } })
  return texts
}

const switchMode = async (frame: Frame, mode: Mode) => {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame
    .locator('.vditor-toolbar')
    .locator(`button[data-mode="${mode}"]`)
    .click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { message: `outline-tooltip ${mode} readiness` },
  )
}

test('Outline entries show their full heading text as a tooltip, in IR and WYSIWYG', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const file = path.join(baseDir, 'outline-tooltip.md')
  writeFileSync(file, FIXTURE)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = visibleFrame(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'outline-tooltip readiness' },
  )

  try {
    // Open the Outline through the toolbar and narrow it, so the long entry is really cut off.
    await frame.locator('.vditor-toolbar [data-type="outline"]').click()
    await expect
      .poll(async () => (await view(frame)).shown, { timeout: 60_000 })
      .toBe(true)
    await frame
      .locator('body')
      .evaluate(() =>
        document.documentElement.style.setProperty(
          '--me-outline-width',
          '120px',
        ),
      )
    await settle(frame, 1000)

    const before = await view(frame)
    const beforeHost = await hostState(evaluateInVSCode, file)
    expect(beforeHost.dirty).toBe(false)

    // IR: each title is the full heading text, with no Markdown markers.
    await expect
      .poll(() => titles(frame), { timeout: 30_000 })
      .toEqual(['Short', LONG])
    expect(
      await frame
        .locator('.vditor-outline')
        .evaluate((el) => el.getBoundingClientRect().width),
      'the Outline is narrower than the long heading',
    ).toBeLessThan(200)

    // The tagging pass changed neither the document, the dirty state nor the Undo depth.
    const tagged = await view(frame)
    const taggedHost = await hostState(evaluateInVSCode, file)
    expect(tagged.value).toBe(before.value)
    expect(tagged.undoDepth).toBe(before.undoDepth)
    expect(taggedHost).toEqual(beforeHost)

    // A real edit of the long heading updates its title.
    await frame
      .locator('.vditor-ir h2')
      .filter({ hasText: 'A very long heading' })
      .first()
      .click()
    await workbox.keyboard.press('End')
    await workbox.keyboard.type(' zzedit')
    await expect
      .poll(() => titles(frame), { timeout: 30_000 })
      .toEqual(['Short', `${LONG} zzedit`])
    await expect
      .poll(async () => (await hostState(evaluateInVSCode, file)).text, {
        timeout: 30_000,
      })
      .toContain(`## ${LONG} zzedit`)

    // WYSIWYG: the rebuilt Outline carries the same titles, and the switch adds nothing.
    await switchMode(frame, 'wysiwyg')
    await expect
      .poll(() => titles(frame), { timeout: 30_000 })
      .toEqual(['Short', `${LONG} zzedit`])
    const wysiwygValue = (await view(frame)).value
    await settle(frame, 1000)
    expect((await view(frame)).value).toBe(wysiwygValue)
    expect((await hostState(evaluateInVSCode, file)).text).toContain(
      `## ${LONG} zzedit`,
    )
  } finally {
    // Later specs expect the Outline closed, the default width and the IR mode.
    try {
      await frame
        .locator('body')
        .evaluate(() =>
          document.documentElement.style.removeProperty('--me-outline-width'),
        )
      if ((await view(frame)).shown)
        await frame.locator('.vditor-toolbar [data-type="outline"]').click()
      const mode = await frame.locator('body').evaluate(
        () =>
          (
            window as unknown as {
              vditor: { vditor: { currentMode: string } }
            }
          ).vditor.vditor.currentMode,
      )
      if (mode !== 'ir') await switchMode(frame, 'ir')
    } catch {
      /* no editor to restore */
    }
  }
})
