import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  clickToolbarControl,
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

/** A previous case may leave its editor open; close everything so the frame locator addresses only this case's webview. */
async function closeAllEditors(
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode')) => Promise<void>,
  ) => Promise<unknown>,
): Promise<void> {
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })
}

type Mode = 'ir' | 'wysiwyg' | 'sv'

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame.locator('body').evaluate((_body, nextMode) => {
    const inner = (window as any).vditor.vditor
    if (inner.currentMode === nextMode) return
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    document
      .querySelector(`button[data-mode="${nextMode}"]`)
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  }, mode)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.vditor.currentMode),
    )
    .toBe(mode)
}

async function placeCaret(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate((_body, currentMode) => {
    const root = (window as any).vditor.vditor[currentMode]
      .element as HTMLElement
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('before '))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error(`No anchor source prose in ${currentMode}`)
    // Task 699: a raw `Selection` write is replaceable while a caret intent is alive (Task 664), so
    // a pending intent from the focus click above could move the caret back to the paragraph start
    // on a later frame. The deliberate writer marks the write as the caret the user wants.
    const range = document.createRange()
    range.setStart(text, 'before '.length)
    range.collapse(true)
    if (!(window as any).__vmdeWriteSelection?.(range))
      throw new Error('Could not establish the Insert ID fixture caret')
    ;(window as any).vditor.vditor[currentMode].range = getSelection()!
      .getRangeAt(0)
      .cloneRange()
  }, mode)
  // Read-only check over two frames: the caret is collapsed in the editor and exactly `before `
  // precedes it. Measured as text from the editor start, since snapshotting may split text nodes.
  // The selection is never rewritten here.
  for (let frameNumber = 0; frameNumber < 2; frameNumber++) {
    const prefix = await frame
      .locator('body')
      .evaluate((_body, currentMode) => {
        return new Promise<string | null>((resolve) =>
          requestAnimationFrame(() => {
            const root = (window as any).vditor.vditor[currentMode]
              .element as HTMLElement
            const selection = getSelection()
            if (!selection?.rangeCount || !selection.isCollapsed)
              return resolve(null)
            const caret = selection.getRangeAt(0)
            if (!root.contains(caret.startContainer)) return resolve(null)
            const head = document.createRange()
            head.selectNodeContents(root)
            head.setEnd(caret.startContainer, caret.startOffset)
            resolve(head.toString())
          }),
        )
      }, mode)
    expect(prefix, `caret prefix, frame ${frameNumber}`).toBe('before ')
  }
}

/**
 * Records, in the webview, what could empty the Redo stack between an Undo and the next Redo: every
 * `addToUndoStack` call (with its caller), and every message the host posts to the webview. The
 * snapshot is printed with the tag below so a failing Redo names its cause in the run log.
 */
async function installHistoryProbe(
  frame: ReturnType<typeof wf>,
): Promise<void> {
  await frame.locator('body').evaluate(() => {
    const win = window as any
    const probe = { host: [] as string[], adds: [] as string[] }
    window.addEventListener(
      'message',
      (event) =>
        probe.host.push(String(event.data?.command ?? typeof event.data)),
      true,
    )
    const undo = win.vditor.vditor.undo
    const original = undo.addToUndoStack
    undo.addToUndoStack = function (this: unknown, ...args: unknown[]) {
      probe.adds.push(
        (new Error().stack ?? '').split('\n').slice(2, 6).join(' < '),
      )
      return original.apply(this, args)
    }
    win.__historyProbe = probe
  })
}

async function logHistory(
  frame: ReturnType<typeof wf>,
  label: string,
): Promise<void> {
  const state = await frame.locator('body').evaluate(() => {
    const win = window as any
    const inner = win.vditor.vditor
    const slot = inner.undo[inner.currentMode]
    return {
      mode: inner.currentMode,
      undo: (globalThis as any).__vmdeUnitHistory?.holds(inner)
        ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
        : slot.undoStack.length,
      redo: (globalThis as any).__vmdeUnitHistory?.holds(inner)
        ? (globalThis as any).__vmdeUnitHistory.depth(inner).redo
        : slot.redoStack.length,
      hasUndo: slot.hasUndo,
      redoDisabled: Boolean(
        inner.toolbar.elements.redo?.children[0]?.classList.contains(
          'vditor-menu--disabled',
        ),
      ),
      hostMessages: win.__historyProbe?.host.slice(),
      addToUndoStack: win.__historyProbe?.adds.slice(),
    }
  })
  console.log('ID_INSERTION_HISTORY', label, JSON.stringify(state))
}

async function insertFromToolbar(
  frame: ReturnType<typeof wf>,
  name: string,
): Promise<void> {
  await clickToolbarControl(frame, 'insert-anchor')
  const dialog = frame.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill(name)
  await dialog.locator('button[type="submit"]').click()
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`Insert ID preserves source, history, save, and reopen in ${mode}`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(90_000)
    await closeAllEditors(evaluateInVSCode)
    const docPath = path.join(baseDir, `id-insertion-mode-${mode}.md`)
    const initial = 'before selected prose after\r\n'
    const name = `mode-${mode}`
    const inserted = `before <a id="${name}"></a>selected prose after\r\n`
    writeFileSync(docPath, initial)
    await evaluateInVSCode(
      async (vscode, args: [string]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [docPath] as [string],
    )
    let frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { message: `${mode} id-insertion fixture readiness` },
    )
    await switchMode(frame, mode)
    await placeCaret(frame, mode)
    await installHistoryProbe(frame)
    await insertFromToolbar(frame, name)
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
    await logHistory(frame, `${mode} inserted`)
    await frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      outer.vditor.undo.undo(outer.vditor)
    })
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(initial)
    await logHistory(frame, `${mode} undone`)
    await frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      outer.vditor.undo.redo(outer.vditor)
    })
    await logHistory(frame, `${mode} redone`)
    await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    })
    await expect.poll(() => readFileSync(docPath, 'utf8')).toBe(inserted)
    frame = await reopenVmdeFixture(
      evaluateInVSCode,
      workbox,
      docPath,
      60_000,
      '.vditor-ir, .vditor-wysiwyg, .vditor-sv',
      false,
    )
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0 && !!state.mode,
      { message: `${mode} id-insertion reopen readiness` },
    )
    const restoredMode = await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.vditor.currentMode as string)
    if (mode === 'sv') {
      await expect.poll(() => docText(evaluateInVSCode, docPath)).toBe(inserted)
      await expect
        .poll(() =>
          frame
            .locator(`.vditor-${restoredMode}`)
            .evaluate((editor) => editor.isConnected),
        )
        .toBe(true)
    } else {
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).vditor.getValue() as string),
        )
        .toBe(inserted.replace('\r\n', '\n'))
    }
  })
}

test('SV Insert anchor posts exact CRLF source without a trailing paragraph', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  await closeAllEditors(evaluateInVSCode)
  const docPath = path.join(baseDir, 'id-insertion-sv-exact.md')
  const initial = 'before selected prose after\r\n'
  const inserted = 'before <a id="sv-exact"></a>selected prose after\r\n'
  writeFileSync(docPath, initial)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'SV exact id-insertion fixture readiness' },
  )
  await switchMode(frame, 'sv')
  await placeCaret(frame, 'sv')
  await insertFromToolbar(frame, 'sv-exact')
  await expect
    .poll(() => docText(evaluateInVSCode, docPath), { timeout: 3_000 })
    .toBe(inserted)
})
