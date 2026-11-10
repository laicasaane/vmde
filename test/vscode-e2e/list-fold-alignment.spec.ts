// Task 722: a list item's fold triangle must line up with the item's own marker (bullet, ordered
// number, or task checkbox). Task 569 placed the painted triangle beneath the marker and centred it
// horizontally from a CSS model of Chromium's outside marker; this spec measures the PAINTED ink of
// both in the real VS Code webview, so a model that drifts from the actual paint fails here.
//
// Method: the ink measurement in list-fold-ink.ts.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { measureItem } from './list-fold-ink'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
} from './webview-helpers'

const WRAP_TEXT = `wrap parent ${'long words keep this first item wrapping onto more lines '.repeat(8)}end`

const CONTENT = [
  '# Lists',
  '',
  // Filler keeps the first list below the pinned toolbar when it is scrolled to the centre.
  ...Array.from({ length: 12 }, (_, index) => [
    `Filler paragraph ${index + 1}.`,
    '',
  ]).flat(),
  '- bullet top',
  '  - bullet level two',
  '    - bullet level three',
  '      - bullet leaf',
  `- ${WRAP_TEXT}`,
  '  - wrap child',
  '',
  'Ordered list:',
  '',
  '1. ordered top',
  '   1. ordered level two',
  '      1. ordered level three',
  '         1. ordered leaf',
  '',
  'Task list:',
  '',
  '- [ ] task top',
  '  - [ ] task level two',
  '    - [ ] task level three',
  '      - [ ] task leaf',
  '',
].join('\n')

type Mode = 'ir' | 'wysiwyg'

const ITEMS = [
  'bullet top',
  'bullet level two',
  'bullet level three',
  'wrap parent',
  'ordered top',
  'ordered level two',
  'ordered level three',
  'task top',
  'task level two',
  'task level three',
] as const

function frameFor(workbox: import('@playwright/test').Page) {
  return workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')
}

type VmdeFrame = ReturnType<typeof frameFor>

async function switchMode(frame: VmdeFrame, mode: Mode) {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(frame, (state) => state.mode === mode, {
    message: `switch to ${mode}`,
  })
  // Close the mode menu and drop toolbar focus so neither paints over the gutter.
  await frame.locator('body').press('Escape')
  await frame
    .locator('body')
    .evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

async function setVmdeConfig(
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  key: string,
  value: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === '<default>' ? undefined : args[1],
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value],
  )
}

const THEMES = ['auto', 'github-light', 'material-dark', 'vscode-dark-2026']
const FONT_SIZES = ['<default>', '20']

for (const theme of THEMES) {
  test(`list fold triangle lines up with its marker (${theme})`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const docPath = path.join(baseDir, 'list-fold-alignment.md')
    writeFileSync(docPath, CONTENT)
    const rows: Record<string, unknown>[] = []
    try {
      await setVmdeConfig(evaluateInVSCode, 'theme.content', theme)
      await setVmdeConfig(evaluateInVSCode, 'editor.defaultMode', 'ir')
      for (const fontSize of FONT_SIZES) {
        await setVmdeConfig(evaluateInVSCode, 'editor.fontSize', fontSize)
        await evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) => {
            await vscode.commands.executeCommand(
              'workbench.action.closeAllEditors',
            )
            await vscode.extensions.getExtension(args[1])?.activate()
            await vscode.commands.executeCommand(
              'vscode.openWith',
              vscode.Uri.file(args[0]),
              args[2],
            )
          },
          [docPath, ExtensionId, MarkdownEditorViewType],
        )
        const frame = frameFor(workbox)
        await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
        await waitForE2EReadiness(
          frame,
          (state) => state.routerReady && state.mode === 'ir',
          { message: 'list-fold-alignment readiness' },
        )
        await frame.locator('body').evaluate(() => document.fonts.ready)
        for (const mode of ['ir', 'wysiwyg'] as const) {
          if (mode === 'wysiwyg') await switchMode(frame, mode)
          for (const needle of ITEMS) {
            const m = await measureItem(workbox, frame, mode, needle)
            const row = {
              theme,
              fontSize,
              mode,
              item: needle,
              computedFont: m.geometry.fontSize,
              lineHeight: m.geometry.lineHeight,
              marker: m.marker,
              arrow: m.arrow,
              textLine: m.geometry.textLine,
              checkbox: m.geometry.checkbox,
              glyphBox: m.geometry.glyph,
              itemLeft: m.geometry.left,
              itemTop: m.geometry.top,
              dxCenter: m.arrow.cx - m.marker.cx,
              dyCenter: m.arrow.cy - m.marker.cy,
              gap: m.arrow.top - m.marker.bottom,
            }
            rows.push(row)
            console.log(`TASK722 ${JSON.stringify(row)}`)
          }
        }
      }
    } finally {
      await setVmdeConfig(evaluateInVSCode, 'theme.content', '<default>')
      await setVmdeConfig(evaluateInVSCode, 'editor.fontSize', '<default>')
      await setVmdeConfig(evaluateInVSCode, 'editor.defaultMode', '<default>')
    }
    expect(rows.length).toBe(FONT_SIZES.length * 2 * ITEMS.length)
    // Task 569 contract: the painted triangle sits beneath its marker, centred on it.
    const offCentre = rows
      .filter((row) => Math.abs(row.dxCenter as number) > 1)
      .map(
        (row) =>
          `${row.fontSize} ${row.mode} ${row.item}: dx ${(row.dxCenter as number).toFixed(1)}`,
      )
    expect(offCentre).toEqual([])
  })
}
