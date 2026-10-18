import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  readToolbarFlowProbe,
  toolbarFrameProbeScript,
} from './toolbar-frame-probe'
import { reopenVmdeFixture, type wf } from './webview-helpers'

// Task 661: the toolbar flow settles before the controls are shown, the instant-paint placeholder
// is sized per document, and the row gap holds in the real webview. One VS Code boot, three steps:
// A wiki document between the two one-row thresholds, B a resize sweep, C a document without wiki.

type Frame = ReturnType<typeof wf>

// What the layout looks like right now: the width, the rows' contents and the toolbar height. Two
// animation frames pass first so a resize in flight has been handled.
const readState = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const toolbar = document.querySelector('#app .vditor-toolbar')
            const rows = Array.from(
              toolbar?.querySelectorAll(':scope > .vmde-toolbar-row') ?? [],
            ).map((row) =>
              Array.from(row.querySelectorAll('[data-type]'))
                .filter((button) => getComputedStyle(button).display !== 'none')
                .map((button) => button.getAttribute('data-type'))
                .join(','),
            )
            resolve(
              JSON.stringify({
                width: window.innerWidth,
                rows,
                height: toolbar?.getBoundingClientRect().height,
              }),
            )
          }),
        ),
      ),
  )

// Quiescence without a fixed sleep: three identical readings in a row.
const settleLayout = async (frame: Frame) => {
  let last = ''
  let same = 0
  await expect
    .poll(
      async () => {
        const state = await readState(frame)
        same = state === last ? same + 1 : 1
        last = state
        return same >= 3
      },
      { timeout: 30_000, intervals: [50] },
    )
    .toBe(true)
  return JSON.parse(last) as { width: number; rows: string[]; height: number }
}

const measureGap = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const bandOf = (row: string) => {
      const button = document.querySelector<HTMLElement>(
        `.vmde-toolbar-row[data-vmde-toolbar-row="${row}"] > .vditor-toolbar__item > [data-type]:not([data-type="collapse-toolbar"])`,
      ) as HTMLElement
      const box = button.getBoundingClientRect()
      const style = getComputedStyle(button)
      return {
        top: box.top + Number.parseFloat(style.borderTopWidth),
        bottom: box.bottom - Number.parseFloat(style.borderBottomWidth),
        boxTop: box.top,
        boxBottom: box.bottom,
      }
    }
    const first = bandOf('1')
    const second = bandOf('2')
    return {
      gap: second.top - first.bottom,
      overlap: first.boxBottom - second.boxTop,
      ratio: window.devicePixelRatio,
    }
  })

test('the toolbar flow settles before it is shown, the placeholder is sized per document and the row gap holds (661)', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const dir = path.join(baseDir, 'task661-wiki')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'task661-home.md')
  writeFileSync(file, '# Home\n\nSee [[Other Page]].\n')
  writeFileSync(path.join(dir, 'Other Page.md'), '# Other\n')
  const setupWiki = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string, string]) => {
        const documentUri = vscode.Uri.file(args[0])
        if (!vscode.workspace.getWorkspaceFolder(documentUri))
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(args[1]), name: 'Task661Wiki' },
          )
        const config = vscode.workspace.getConfiguration('vmde', documentUri)
        await config.update(
          'wiki.enabled',
          args[1] !== '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
        await config.update(
          'wiki.root',
          '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
      },
      [file, dir] as [string, string],
    )
  const setWikiEnabled = (mode: 'on' | 'off' | 'clear') =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string, string]) => {
        const config = vscode.workspace.getConfiguration(
          'vmde',
          vscode.Uri.file(args[0]),
        )
        await config.update(
          'wiki.enabled',
          args[1] === 'clear' ? undefined : args[1] === 'on',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
      },
      [file, mode] as [string, string],
    )
  // The probe goes in before the first open so every webview document is sampled from its start.
  await electronApp.context().addInitScript(toolbarFrameProbeScript)
  await setupWiki()
  const closeSidebars = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeSidebar')
        await vscode.commands.executeCommand(
          'workbench.action.closeAuxiliaryBar',
        )
      },
      [file] as [string],
    )

  try {
    // Calibration open: the offset between the window width and the webview width.
    await workbox.setViewportSize({ width: 1400, height: 900 })
    let frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await closeSidebars()
    await expect(frame.locator('#app .vditor-toolbar')).toBeVisible({
      timeout: 60_000,
    })
    const calibrated = await settleLayout(frame)
    const offset = 1400 - calibrated.width
    test.info().annotations.push({
      type: '661 calibration',
      description: `window 1400, webview ${calibrated.width}, offset ${offset}`,
    })
    const at = (webviewWidth: number) =>
      workbox.setViewportSize({ width: offset + webviewWidth, height: 900 })
    const widthOf = async (webviewWidth: number) => {
      await at(webviewWidth)
      return settleLayout(frame)
    }

    await test.step('A: a wiki document between the thresholds never paints a shorter placeholder', async () => {
      await at(1185)
      frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
      // Non-asserting: which toolbar the first locator resolves to right after the reopen.
      const first = await frame.locator('body').evaluate(() => {
        const toolbars = Array.from(
          document.querySelectorAll('.vditor-toolbar'),
        )
        return {
          overlayPresent: Boolean(document.getElementById('vmde-prerender')),
          toolbarCount: toolbars.length,
          firstToolbarInOverlay: Boolean(
            toolbars[0]?.closest('#vmde-prerender'),
          ),
        }
      })
      test.info().annotations.push({
        type: '661 first read after reopen',
        description: JSON.stringify(first),
      })
      await expect(frame.locator('#vmde-prerender')).toHaveCount(0, {
        timeout: 60_000,
      })
      const state = await settleLayout(frame)
      expect(state.width).toBe(1185)
      const probe = await readToolbarFlowProbe(frame)
      test.info().annotations.push({
        type: '661 step A probe',
        description: JSON.stringify(probe),
      })
      expect(
        probe?.heightLog.some((entry) => entry.startsWith('teaser:')),
      ).toBe(true)
      for (const entry of probe?.heightLog ?? [])
        expect(
          Math.abs(Number(entry.split(':')[1]) - 61.4),
          `height entry ${entry}`,
        ).toBeLessThanOrEqual(0.25)
      expect(probe?.violations).toEqual([])
    })

    await test.step('B: a resize sweep paints no half-placed toolbar, and the gap and the Wiki Pages icon hold', async () => {
      for (const width of [1400, 1185, 900, 700, 500, 380, 700, 1400])
        await widthOf(width)
      const probe = await readToolbarFlowProbe(frame)
      test.info().annotations.push({
        type: '661 step B probe',
        description: JSON.stringify({
          frames: probe?.frames,
          liveFrames: probe?.liveFrames,
          devicePixelRatio: probe?.devicePixelRatio,
          violations: probe?.violations,
        }),
      })
      expect(probe?.liveFrames ?? 0).toBeGreaterThan(10)
      expect(probe?.violations).toEqual([])

      await widthOf(900)
      const toolbar = frame.locator('#app .vditor-toolbar')
      await expect(toolbar).toHaveClass(/vmde-toolbar--two-rows/)
      const gap = await measureGap(frame)
      test.info().annotations.push({
        type: '661 gap',
        description: JSON.stringify(gap),
      })
      expect(Math.abs(gap.gap - 2.4)).toBeLessThanOrEqual(1)
      expect(gap.overlap).toBeLessThanOrEqual(0.01)
      const icon = toolbar
        .locator(
          ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="wiki-pages"] > svg',
        )
        .first()
      await expect(icon).toHaveCount(1)
      const box = await icon.evaluate((svg) => {
        const rect = svg.getBoundingClientRect()
        return { w: rect.width, h: rect.height }
      })
      expect(box).toEqual({ w: 16, h: 16 })
    })

    await test.step('C: a document without wiki keeps the one-row placeholder at the same width', async () => {
      await setWikiEnabled('off')
      await at(1185)
      frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
      await expect(frame.locator('#vmde-prerender')).toHaveCount(0, {
        timeout: 60_000,
      })
      const state = await settleLayout(frame)
      expect(state.width).toBe(1185)
      const probe = await readToolbarFlowProbe(frame)
      test.info().annotations.push({
        type: '661 step C probe',
        description: JSON.stringify(probe),
      })
      expect(probe?.heightLog.length ?? 0).toBeGreaterThan(0)
      for (const entry of probe?.heightLog ?? [])
        expect(
          Math.abs(Number(entry.split(':')[1]) - 36),
          `height entry ${entry}`,
        ).toBeLessThanOrEqual(0.25)
      expect(probe?.violations).toEqual([])
    })
  } finally {
    await setWikiEnabled('clear')
  }
})
