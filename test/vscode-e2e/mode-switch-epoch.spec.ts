import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  shippedSwitches,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

// Task 733 / 015-T2 (task 015 sections 6.2 D-5 and 6.6): the text model survives IR, Source and IR
// with its epoch. Without typing, no post follows the switches, so today the model stays off in
// Source (`offReason` `mode`) and stays off back in IR until a post asks for a `rebind`; with the kept
// epoch it is live in Source and live again in IR at once, and its text digest equals the host
// document. With typing that is not yet published at the switch, the bytes are saved and the IR
// re-entry takes the rebind path as today. Fails until 015-I1 and 015-I2 land.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface ModelStats {
  state: string
  offReason?: string
}
const modelStats = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const stats = (window as unknown as { __vmdeModelShadowStats?: ModelStats })
      .__vmdeModelShadowStats
    return { state: stats?.state ?? 'off', offReason: stats?.offReason }
  })

/** Length and hash of the live model text (the page publishes a digest, never the text). */
const modelDigest = (frame: Frame) =>
  frame.locator('body').evaluate(() =>
    (
      window as unknown as {
        __vmdeModelTextDigest?: () => { length: number; hash: number } | null
      }
    ).__vmdeModelTextDigest?.(),
  )

async function switchMode(frame: Frame, mode: 'ir' | 'sv'): Promise<void> {
  const before = await waitForE2EReadiness(frame, () => true)
  // The edit-mode buttons sit in a panel hidden until hover: dispatch the click on the button.
  await frame.locator('body').evaluate((_body, m) => {
    document
      .querySelector(`.vditor-toolbar button[data-mode="${m as string}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === mode,
    { message: `the editor reported ${mode}` },
  )
}

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<Frame> {
  writeFileSync(file, tableHeavyMarkdown(1))
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
    { message: 'the editor installed its router' },
  )
  await expect
    .poll(async () => (await modelStats(frame)).state, { timeout: 30_000 })
    .toBe('live')
  return frame
}

test.describe('mode switch keeps the model epoch', () => {
  test('IR, Source and IR keep the model live with the host text and no rebind', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const file = path.join(baseDir, 'mode-switch-epoch.md')
    const frame = await open(workbox, evaluateInVSCode, file)
    test.skip(
      !(await shippedSwitches(frame)).sourceUnits,
      'Source units ship off',
    )
    const opened = await modelDigest(frame)
    expect(opened).toBeTruthy()
    await switchMode(frame, 'sv')
    await expect
      .poll(async () => (await modelStats(frame)).state, { timeout: 10_000 })
      .toBe('live')
    expect(await modelDigest(frame)).toEqual(opened)
    await switchMode(frame, 'ir')
    // No typing, so no post follows: only a kept epoch makes the IR model live again.
    await expect
      .poll(async () => (await modelStats(frame)).state, { timeout: 10_000 })
      .toBe('live')
    expect(await modelDigest(frame)).toEqual(opened)
    expect(await docText(evaluateInVSCode, file)).toBe(tableHeavyMarkdown(1))
  })

  test('typing unpublished at the switch is saved and IR takes the rebind path', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const file = path.join(baseDir, 'mode-switch-epoch-typing.md')
    const frame = await open(workbox, evaluateInVSCode, file)
    const paragraph = frame.locator('.vditor-ir .vditor-reset > p').nth(2)
    await paragraph.click()
    await workbox.keyboard.press('End')
    await workbox.keyboard.type('qq', { delay: 50 })
    // Switch before the publication debounce ends.
    await switchMode(frame, 'sv')
    await workbox.waitForTimeout(2000)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    }, [])
    expect(await docText(evaluateInVSCode, file)).toContain('qq')
    await switchMode(frame, 'ir')
    await workbox.keyboard.type('r', { delay: 50 })
    await expect
      .poll(async () => (await modelStats(frame)).state, { timeout: 30_000 })
      .toBe('live')
  })
})
