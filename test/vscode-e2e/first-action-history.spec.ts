import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createSpecKeyboard } from './helpers/spec-keyboard'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

// Task 688: an action that is the first thing done after the editor opens (the undo history is
// still empty) must leave an Undo start that is the text before the action. A history base read
// after the change made the host pair the changed text with its unchanged text, so Redo applied
// nothing (or, for Paste Plain, Undo had no earlier state). Each case runs its action as soon as
// the editor reports ready, then checks Undo, Redo, the editor text and the saved bytes.

type Frame = ReturnType<typeof wf>
type Eval = Parameters<typeof docText>[0]

interface Ctx {
  frame: Frame
  workbox: import('@playwright/test').Page
  electronApp: import('playwright-core').ElectronApplication
  evaluateInVSCode: Eval
}

interface Case {
  id: string
  initial: string
  acted: string
  caret?: string
  wrapColumn?: number
  prepare?: (ctx: Ctx) => Promise<void>
  run: (ctx: Ctx) => Promise<void>
}

const command = (name: string) => async (ctx: Ctx) => {
  await ctx.evaluateInVSCode(
    async (vscode: typeof import('vscode'), a: string[]) => {
      await vscode.commands.executeCommand(a[0])
    },
    [name] as string[],
  )
}

const LONG =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma\n'

const CASES: Case[] = [
  {
    id: 'rewrap-selection',
    initial: LONG,
    acted:
      'alpha beta gamma delta\nepsilon zeta eta theta\niota kappa lambda mu nu\nxi omicron pi rho sigma\n',
    caret: 'gamma',
    wrapColumn: 24,
    run: command('vmde.rewrap'),
  },
  {
    id: 'rewrap-document',
    initial: LONG,
    acted:
      'alpha beta gamma delta\nepsilon zeta eta theta\niota kappa lambda mu nu\nxi omicron pi rho sigma\n',
    caret: 'gamma',
    wrapColumn: 24,
    run: command('vmde.rewrapDocument'),
  },
  {
    id: 'shift-heading-level',
    initial: '# A\n\n## Child\n',
    acted: '# A\n\n### Child\n',
    caret: 'Child',
    run: command('vmde.demoteHeading'),
  },
  {
    id: 'paste-plain',
    initial: 'alpha\n\nomega\n',
    acted: 'alPLAINpha\n\nomega\n',
    caret: 'alpha',
    prepare: async ({ evaluateInVSCode }) => {
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), a: string[]) => {
          await vscode.env.clipboard.writeText(a[0])
        },
        ['PLAIN'] as string[],
      )
    },
    run: command('vmde.pastePlain'),
  },
  {
    id: 'block-duplicate',
    initial: 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n',
    acted: 'alpha\n\nalpha\n\n```ts\nconst x = 1\n```\n\nomega\n',
    run: async ({ frame }) => {
      await frame
        .locator('.vditor-ir .vditor-reset > p')
        .filter({ hasText: 'alpha' })
        .hover()
      await frame.locator('.vmde-block-handle').click()
      await frame
        .locator('.vmde-block-handle-menu [data-action="duplicate"]')
        .click()
    },
  },
  {
    id: 'link-unlink',
    initial: 'See [label](https://example.com/a) end\n',
    acted: 'See label end\n',
    run: async ({ frame }) => {
      await frame
        .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
        .first()
        .click()
      const popover = frame.locator('.vmde-link-popover')
      await expect(popover).toBeVisible()
      const unlink = popover.getByRole('button', { name: 'Unlink' })
      await expect(unlink).toBeEnabled()
      await unlink.click()
    },
  },
  {
    id: 'callout-apply',
    initial: '> [!NOTE]\n> alpha body\n',
    acted: '> [!WARNING]\n> alpha body\n',
    caret: 'alpha body',
    run: async (ctx) => {
      await command('vmde.activateLinkAtCaret')(ctx)
      const panel = ctx.frame.locator('.vmde-callout-context-panel')
      await expect(panel).toBeVisible()
      await panel.locator('select').selectOption('warning')
      await panel.getByRole('button', { name: 'Apply' }).click()
    },
  },
  {
    id: 'find-replace-one',
    initial: 'one two one\n',
    acted: 'one TWO one\n',
    run: async (ctx) => {
      await command('vmde.findReplace')(ctx)
      const widget = ctx.frame.locator('.vmde-find-replace')
      await expect(widget).toBeVisible({ timeout: 10_000 })
      await widget.locator('[data-find]').fill('two')
      await widget
        .getByRole('textbox', { name: 'Replace', exact: true })
        .fill('TWO')
      await command('vmde.replaceOne')(ctx)
    },
  },
]

async function placeCaret(frame: Frame, mode: 'ir', needle: string) {
  await frame.locator('body').evaluate(
    (_body, [m, text]) => {
      const root = (window as any).vditor.vditor[m].element as HTMLElement
      root.focus()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, Math.min(index + 2, node.data.length))
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`caret target ${text} missing`)
    },
    [mode, needle] as [string, string],
  )
}

/** The length of the active mode's undo stack: 0 while Vditor has taken no snapshot yet. */
async function activeUndoLength(frame: Frame, mode: 'ir') {
  return frame
    .locator('body')
    .evaluate(
      (_body, m) =>
        (globalThis as any).__vmdeUnitHistory?.holds(
          (window as any).vditor.vditor,
        )
          ? (globalThis as any).__vmdeUnitHistory.depth(
              (window as any).vditor.vditor,
            ).undo
          : ((window as any).vditor.vditor.undo?.[m]?.undoStack?.length ?? 0),
      mode,
    )
}

const editorText = (frame: Frame) =>
  frame.locator('body').evaluate(() => (window as any).vditor.getValue())

const trimEnd = (text: string) => text.replace(/\n+$/u, '')

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of ['editor.wrapColumn', 'editor.defaultMode']) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    }
  })
})

for (const item of CASES) {
  test(`first action after open: ${item.id} undoes to the text before it and redoes it once`, async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, `first-action-${item.id}.md`)
    writeFileSync(file, item.initial)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), a: [string, string]) => {
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update(
          'editor.defaultMode',
          'ir',
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'editor.wrapColumn',
          a[1] ? Number(a[1]) : undefined,
          vscode.ConfigurationTarget.Global,
        )
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(a[0]),
          'vmde.editor',
        )
      },
      [file, item.wrapColumn ? String(item.wrapColumn) : ''] as [
        string,
        string,
      ],
    )
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { timeout: 60_000, message: `${item.id} readiness` },
    )
    const ctx: Ctx = { frame, workbox, electronApp, evaluateInVSCode }
    await item.prepare?.(ctx)
    // The case is only meaningful while the undo history is still empty.
    expect(await activeUndoLength(frame, 'ir')).toBe(0)
    if (item.caret) await placeCaret(frame, 'ir', item.caret)
    await item.run(ctx)
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .toBe(item.acted)

    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    const input = await createSpecKeyboard(electronApp, workbox)
    await input.key('ctrl+z')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 10_000 })
      .toBe(item.initial)
    await input.key('ctrl+y')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 10_000 })
      .toBe(item.acted)
    expect(trimEnd(await editorText(frame))).toBe(trimEnd(item.acted))
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    expect(readFileSync(file, 'utf8')).toBe(item.acted)
  })
}
