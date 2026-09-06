import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// REGRESSION (task 61 v2, Layer 1) — undoing back to the open state must leave the tab
// CLEAN and the bytes equal to disk. Before the fix this failed with finalDirty=true &
// textMatchesDisk=false (the minimal-diff write-back minimized against the current,
// already-reflowed document instead of the clean baseline, so the reflow never unwound).
// The fix: minimize against the clean baseline + a whole-doc semantic-no-op short-circuit
// that restores the original bytes verbatim when the net edit is zero.
const FIXTURE = path.join(__dirname, 'fixtures', 'undo-dirty.md')

test('undo-to-start dirty probe', async ({ workbox, evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(() => frame.locator('.vditor-ir').first().innerText())
    .toContain('Edit here')
  // task 512: retain — rendered text is not undo-stack readiness. Removing this guard let the edit
  // begin before Vditor's initial undo snapshot existed, and 12 Ctrl+Z presses never restored the
  // opening bytes even after a 20s document-state poll.
  await frame.locator('body').evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const editor = (window as any).vditor
    const originalSetValue = editor.setValue.bind(editor)
    ;(window as any).__undoDirtySetValueCalls = 0
    ;(window as any).__undoDirtyInitialStack =
      editor.vditor.undo[editor.getCurrentMode()].undoStack.length
    editor.setValue = (...args: unknown[]) => {
      ;(window as any).__undoDirtySetValueCalls++
      return originalSetValue(...args)
    }
  })

  const docState = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === args[0],
        )
        return { isDirty: !!doc?.isDirty, text: doc?.getText() ?? '' }
      },
      [FIXTURE] as [string],
    ) as Promise<{ isDirty: boolean; text: string }>

  const initial = await docState() // == disk bytes (VS Code just loaded the file)

  // PAGE-LEVEL keyboard focus into the nested webview iframe first — `p.focus()` below is DOM-level
  // INSIDE the iframe, while `workbox.keyboard` dispatches to the top Electron window; without this
  // click the keystrokes race that focus and get dropped (the "editing should mark dirty" flake).
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })

  // caret at the end of the "Edit here" last line, type a few chars
  await frame.locator('body').evaluate(() => {
    const p = Array.from(
      document.querySelectorAll('.vditor-ir p, .vditor-ir li, .vditor-ir h1'),
    ).find((x) => x.textContent?.includes('Edit here')) as
      | HTMLElement
      | undefined
    const t = p?.lastChild as Text | null
    if (!t) return
    const r = document.createRange()
    r.setStart(t, (t.textContent ?? '').length)
    r.collapse(true)
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(r)
    p?.focus()
  })
  await workbox.keyboard.type('abcdef', { delay: 50 })
  await expect
    .poll(async () => (await docState()).isDirty, { timeout: 20_000 })
    .toBe(true)
  const afterEdit = await docState()
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const editor = (window as any).vditor
        return (
          editor.vditor.undo[editor.getCurrentMode()].undoStack.length >
          (window as any).__undoDirtyInitialStack
        )
      }),
    )
    .toBe(true)

  // The typed burst is one Vditor undo step. Task 181 couples that same transition to exactly one
  // native VS Code undo; extra speculative presses would deliberately walk into older history.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect
    .poll(
      async () => {
        const current = await docState()
        return current.text === initial.text
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  const final = await docState()

  const textMatchesDisk = final.text === initial.text
  // eslint-disable-next-line no-console
  console.log(
    `[undo-dirty] initialDirty=${initial.isDirty} afterEditDirty=${afterEdit.isDirty} ` +
      `finalDirty=${final.isDirty} textMatchesDisk=${textMatchesDisk}\n` +
      `  layer=${final.isDirty ? (textMatchesDisk ? 'L2 (version-based dirty; content matches disk)' : 'L1 (content != disk after undo)') : 'NO BUG (clean after undo)'}\n` +
      `  initial tail=${JSON.stringify(initial.text.slice(-50))}\n` +
      `  final   tail=${JSON.stringify(final.text.slice(-50))}`,
  )
  expect(afterEdit.isDirty, 'editing should mark dirty').toBe(true)
  // LAYER 1 (fixed + guarded here): after undoing back to the open state the document
  // bytes are restored to disk EXACTLY → the git diff is clean. Before the fix this was
  // false (the write-back minimized against the already-reflowed doc, so the reflow never
  // unwound). This is the clean-diff guarantee.
  expect(
    textMatchesDisk,
    'undo back to the open state must restore the disk bytes exactly (clean diff)',
  ).toBe(true)
  // LAYER 2 (task 181): the Vditor and VS Code history steps move in lockstep, so returning to
  // the saved native undo position clears the real tab-dirty state without pushing the host echo
  // back through setValue (which would rebuild the live editor DOM).
  expect(
    final.isDirty,
    "undo-to-start must clear VS Code's native dirty state",
  ).toBe(false)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__undoDirtySetValueCalls as number),
    'the aligned native undo echo must not rebuild Vditor',
  ).toBe(0)
})
