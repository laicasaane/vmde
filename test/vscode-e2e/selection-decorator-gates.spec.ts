import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 012-7 (gate G3): a selection change in a paragraph, by a pointer click and by arrow
// keys, makes no whole-root decorator pass and no whole-document Lute call once the open has
// settled. It reads `window.__vmdeDecoratorPasses` and `window.__vmdeEditCounters` (end-to-end
// runs only). Counters and state only; no document text is logged.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface DecoratorPasses {
  full: number
  scoped: number
}

interface ShadowStats {
  state: 'off' | 'live'
  units: number
  dirtyNow: number
}

const fixture = tableHeavyMarkdown(1)
const PARAGRAPH = '.vditor-ir .vditor-reset > p:not(:has(a))'

// A negative-assertion wait: the idle publication and its follow-up work must have run before the
// counters are read, so a counter that stays 0 proves the path did not run.
const settle = (workbox: Page) => workbox.waitForTimeout(2000)

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
})

async function openFixture(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
): Promise<Frame> {
  const file = path.join(baseDir, 'selection-decorator-gates.md')
  writeFileSync(file, fixture)
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
    { message: 'the selection-gate editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await waitForLiveModel(frame)
  await settle(workbox)
  return frame
}

/** A live model with no dirty unit is what makes the feed deliver unit changes. */
async function waitForLiveModel(frame: Frame): Promise<void> {
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const stats = (
            window as unknown as { __vmdeModelShadowStats?: ShadowStats }
          ).__vmdeModelShadowStats
          return (
            stats?.state === 'live' && stats.units > 0 && stats.dirtyNow === 0
          )
        }),
      { timeout: 90_000, message: 'the model is live with no dirty unit' },
    )
    .toBe(true)
}

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    const win = window as unknown as {
      __vmdeDecoratorPasses?: DecoratorPasses
      __vmdeEditCounters: { reset(n: number): void }
    }
    win.__vmdeDecoratorPasses = { full: 0, scoped: 0 }
    win.__vmdeEditCounters.reset(length as number)
  }, fixture.length)

/** Read the counters and print them (numbers only) before any assertion. */
async function readCounters(frame: Frame, step: string) {
  const counters = await frame.locator('body').evaluate(() => {
    const win = window as unknown as {
      __vmdeDecoratorPasses?: DecoratorPasses
      __vmdeEditCounters: { luteDocument: number; fullGetValue: number }
    }
    const passes = win.__vmdeDecoratorPasses ?? { full: 0, scoped: 0 }
    return {
      full: passes.full,
      scoped: passes.scoped,
      luteDocument: win.__vmdeEditCounters.luteDocument,
      fullGetValue: win.__vmdeEditCounters.fullGetValue,
    }
  })
  console.log(`SELECTION-GATES ${JSON.stringify({ step, counters })}`)
  return counters
}

test.describe('selection decorator gates', () => {
  test('a pointer click and arrow keys in a paragraph make no whole decorator pass', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    const paragraph = frame.locator(PARAGRAPH).nth(2)
    await paragraph.scrollIntoViewIfNeeded()
    await settle(workbox)

    await resetCounters(frame)
    await paragraph.click()
    await settle(workbox)
    const click = await readCounters(frame, 'pointer click')
    expect.soft(click.full, 'pointer click full passes').toBe(0)
    expect.soft(click.luteDocument, 'pointer click luteDocument').toBe(0)

    await resetCounters(frame)
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft'])
      await workbox.keyboard.press(key)
    await settle(workbox)
    const arrows = await readCounters(frame, 'arrow keys')
    expect.soft(arrows.full, 'arrow keys full passes').toBe(0)
    expect.soft(arrows.luteDocument, 'arrow keys luteDocument').toBe(0)
  })
})
