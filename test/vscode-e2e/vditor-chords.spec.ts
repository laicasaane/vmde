import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, settle, waitForE2EReadiness, wf } from './webview-helpers'

// Task 580 CP2-10 — Vditor's hard-coded chords in the real VS Code webview. The build patches
// Vditor so real keys no longer run them (Ctrl+Alt+1–9, Ctrl+=/-, the table chords, Ctrl+Shift+J,
// Ctrl+Shift+D and the removed WYSIWYG blockquote exits); Ctrl+= now only zooms the workbench.
// The heading, edit-mode and task actions are unbound VMDE commands that send the former chord as
// a contained untrusted keydown, which must never reach the webview window (VS Code's preload would
// forward it). The WYSIWYG Alt+Enter popover hops (V9) are a fixed exception and keep working.
// Includes the CP1 P4 gaps: IR Ctrl+Alt+5 and Heading 5, the IR task toggle, IR Ctrl+Shift+D and
// both V9 directions.

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>

const DOC = [
  '# Title',
  '',
  'Para text',
  '',
  '- [ ] task item',
  '',
  '> quoted line',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```js',
  'let code = 1',
  '```',
  '',
].join('\n')

async function openFixture(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: any,
  file: string,
  mode: Mode,
  content = DOC,
): Promise<Frame> {
  writeFileSync(file, content)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), target: string) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(target),
        'vmde.editor',
      )
    },
    file,
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { timeout: 60_000, message: 'IR mode did not become ready' },
  )
  if (mode !== 'ir') {
    await frame.locator('body').evaluate((_body, target) => {
      const toolbar = (window as any).vditor.vditor.toolbar
      toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector(`button[data-mode="${target}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      timeout: 60_000,
      message: `${mode} mode did not become ready`,
    })
  }
  // Every untrusted keydown that reaches the document or the window would be forwarded.
  await frame.locator('body').evaluate(() => {
    const leaked: string[] = []
    ;(window as any).__leakedChordKeys = leaked
    const record = (event: Event) => {
      if (!event.isTrusted) leaked.push((event as KeyboardEvent).code)
    }
    document.addEventListener('keydown', record)
    window.addEventListener('keydown', record)
  })
  // Give the webview keyboard focus; each check then places its own caret.
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 6, y: 6 } })
  await settle(frame, 500)
  return frame
}

const currentMode = (frame: Frame) =>
  frame.locator('body').evaluate(() => (window as any).vditor.getCurrentMode())
const leakedKeys = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).__leakedChordKeys as string[])
const viewValue = (frame: Frame) =>
  frame.locator('body').evaluate(() => (window as any).vditor.getValue())

/** Click the element that shows `needle` (at its center, clear of the block handle) so VMDE's
 * caret tracking sees a real user caret, and check that the caret landed in that text. */
async function caretIn(frame: Frame, needle: string) {
  const mode = await currentMode(frame)
  const surface = mode === 'sv' ? '.vditor-sv' : `.vditor-${mode} .vditor-reset`
  const target = frame
    .locator(surface)
    .getByText(needle, { exact: needle.length < 3 })
    .first()
  await expect(async () => {
    await target.click()
    await settle(frame, 200)
    // The caret's nearest block (cell, list item, code) must show the needle; highlighting and
    // markers split the text nodes themselves.
    const blockText = await frame.locator('body').evaluate(() => {
      const anchor = getSelection()?.anchorNode
      const element = anchor instanceof Element ? anchor : anchor?.parentElement
      return element?.closest('td, li, code, [data-block]')?.textContent ?? ''
    })
    expect(blockText, `caret in "${needle}"`).toContain(needle)
  }).toPass({ timeout: 15_000 })
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: real presses of the former Vditor chords leave the source alone`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    const file = path.join(baseDir, `vditor-chords-inert-${mode}.md`)
    const frame = await openFixture(workbox, evaluateInVSCode, file, mode)
    const source = () => docText(evaluateInVSCode, file)
    const before = await source()
    const view = await viewValue(frame)
    const zoom = () => workbox.evaluate(() => window.devicePixelRatio)
    const baseZoom = await zoom()

    const press = async (needle: string, chords: readonly string[]) => {
      // A code block shows its source (and, in WYSIWYG, its popover) once its preview is clicked.
      if (needle === 'let code' && mode === 'wysiwyg')
        await frame.locator(`.vditor-${mode}__preview`).first().click()
      await caretIn(frame, needle)
      for (const chord of chords) await workbox.keyboard.press(chord)
      await settle(frame, 400)
      const label = `${mode}: ${chords.join(', ')} at "${needle}"`
      expect(await source(), label).toBe(before)
      expect(await viewValue(frame), label).toBe(view)
      expect(await currentMode(frame), label).toBe(mode)
    }

    await press(
      'Para text',
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Control+Alt+Digit${n}`),
    )
    await press('task item', ['Control+Shift+KeyJ'])
    // Ctrl+= and Ctrl+- in a heading (and Ctrl+= / Ctrl+- in a table) only zoom the workbench.
    await press('Title', ['Control+Equal'])
    await expect.poll(zoom).toBeGreaterThan(baseZoom)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.zoomReset')
    })
    await expect.poll(zoom).toBe(baseZoom)
    await press('Title', ['Control+Minus'])
    await expect.poll(zoom).toBeLessThan(baseZoom)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.zoomReset')
    })
    await expect.poll(zoom).toBe(baseZoom)
    if (mode === 'wysiwyg')
      // V10 is removed (pressed before the table, whose WYSIWYG popover can cover the quote). With Find closed, Ctrl+Alt+Enter (Replace All) is not bound either.
      await press('quoted line', ['Alt+Enter', 'Control+Alt+Enter'])
    if (mode !== 'sv') {
      await press('2', [
        'Control+Equal',
        'Control+Minus',
        'Control+Shift+KeyL',
        'Control+Shift+KeyR',
      ])
      await evaluateInVSCode(async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.zoomReset')
      })
    }
    // Ctrl+Shift+D (V8 move down, WYSIWYG code popover) opens Run and Debug, which takes focus:
    // press it last.
    await press(mode === 'wysiwyg' ? 'let code' : 'Para text', [
      'Control+Shift+KeyD',
    ])
    expect(await leakedKeys(frame)).toEqual([])
  })
}

test('ir: Heading 5, the task toggle and the edit-mode commands run through the contained chord', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = path.join(baseDir, 'vditor-chords-commands.md')
  const frame = await openFixture(
    workbox,
    evaluateInVSCode,
    file,
    'ir',
    'Para text\n\n- [ ] task item\n',
  )
  const source = () => docText(evaluateInVSCode, file)
  const run = (command: string) =>
    evaluateInVSCode(async (vscode, id: string) => {
      await vscode.commands.executeCommand(id)
    }, command)

  await caretIn(frame, 'Para text')
  await run('vmde.format.heading5')
  await expect.poll(source).toMatch(/^##### Para text\n/)

  await caretIn(frame, 'task item')
  await run('vmde.toggleTaskCheckbox')
  await expect.poll(source).toMatch(/^- \[[xX]\] +task item$/m)
  await caretIn(frame, 'task item')
  await run('vmde.toggleTaskCheckbox')
  await expect.poll(source).toMatch(/^- \[ \] +task item$/m)

  for (const [command, mode] of [
    ['vmde.switchToWysiwyg', 'wysiwyg'],
    ['vmde.switchToSplitView', 'sv'],
    ['vmde.switchToInstantRendering', 'ir'],
  ] as const) {
    await run(command)
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      timeout: 60_000,
      message: `${command} did not switch to ${mode}`,
    })
  }
  expect(await source()).toMatch(/^##### Para text\n/)
  expect(await leakedKeys(frame)).toEqual([])
})

test('wysiwyg: the heading command toggles off, and Alt+Enter hops into the code language input and back (V9)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = path.join(baseDir, 'vditor-chords-wysiwyg.md')
  const frame = await openFixture(
    workbox,
    evaluateInVSCode,
    file,
    'wysiwyg',
    'Para text\n\n```js\nlet code = 1\n```\n',
  )
  const source = () => docText(evaluateInVSCode, file)
  const run = (command: string) =>
    evaluateInVSCode(async (vscode, id: string) => {
      await vscode.commands.executeCommand(id)
    }, command)

  await caretIn(frame, 'Para text')
  await run('vmde.format.heading2')
  await expect.poll(source).toMatch(/^## Para text\n/)
  await caretIn(frame, 'Para text')
  await run('vmde.format.heading2')
  await expect.poll(source).toMatch(/^Para text\n/)
  expect(await leakedKeys(frame)).toEqual([])

  const before = await source()
  await frame.locator('.vditor-wysiwyg .vditor-wysiwyg__preview').click()
  await caretIn(frame, 'let code')
  const language = frame.locator('.vditor-wysiwyg .vditor-panel .vditor-input')
  await expect(language).toBeAttached()
  await workbox.keyboard.press('Alt+Enter')
  await expect(language).toBeFocused()
  await workbox.keyboard.press('Alt+Enter')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        const anchor = getSelection()?.anchorNode
        return {
          inRoot: !!anchor && root.contains(anchor),
          inputFocused:
            document.activeElement?.classList.contains('vditor-input') === true,
        }
      }),
    )
    .toEqual({ inRoot: true, inputFocused: false })
  expect(await source()).toBe(before)
})
