import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

// SPIKE (diagnostic, not a regression) — decides whether the "lockstep dual-drive" undo
// coupling (option #2) is even possible. Three unknowns, all VS-Code-runtime behaviours:
//   Q1 TARGETING  — does executeCommand('undo') from the host revert OUR custom editor's
//                   TextDocument at all?
//   Q2 COALESCING — does ONE undo revert ONE applyEdit, or several merged into one stop?
//   Q3 COUNT      — how many undos to reach !isDirty vs the number of applyEdits (3)?
// Lockstep needs Q1=yes AND a 1:1 edit↔undo-step relationship (Q2 = one-at-a-time, Q3 = 3).
// If VS Code coalesces our applyEdits (Q2/Q3 < 3) we cannot align the two stacks → #2 dies.
const FIXTURE = path.join(__dirname, 'fixtures', 'undo-dirty.md')

test('SPIKE: applyEdit coalescing + undo targeting for lockstep (#2)', async ({
  evaluateInVSCode,
}) => {
  const result = (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const uri = args[0]
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
      await new Promise((r) => setTimeout(r, 1500))
      const u = vscode.Uri.file(uri)
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri,
      )
      if (!doc) return { error: 'doc not found' }
      const initialText = doc.getText()
      const endPos = () => doc.lineAt(doc.lineCount - 1).range.end
      const log: Record<string, unknown> = {}
      log.initial = { dirty: doc.isDirty, version: doc.version }

      // 3 SEPARATE forward edits (simulating 3 debounced webview edits), spaced apart so
      // they are NOT in the same instant — this is the realistic typing-burst cadence.
      const applyAppend = async (s: string) => {
        const e = new vscode.WorkspaceEdit()
        e.insert(u, endPos(), s)
        await vscode.workspace.applyEdit(e)
      }
      await applyAppend('\nMARK_AAA')
      await new Promise((r) => setTimeout(r, 200))
      await applyAppend('\nMARK_BBB')
      await new Promise((r) => setTimeout(r, 200))
      await applyAppend('\nMARK_CCC')
      await new Promise((r) => setTimeout(r, 200))
      log.afterEdits = {
        dirty: doc.isDirty,
        version: doc.version,
        has: {
          A: doc.getText().includes('MARK_AAA'),
          B: doc.getText().includes('MARK_BBB'),
          C: doc.getText().includes('MARK_CCC'),
        },
      }

      // Q1 + Q2: ONE undo from the host. Did the doc change? How much reverted?
      const before = doc.getText()
      await vscode.commands.executeCommand('undo')
      await new Promise((r) => setTimeout(r, 250))
      log.afterUndo1 = {
        changedOurDoc: doc.getText() !== before, // Q1
        dirty: doc.isDirty,
        version: doc.version,
        has: {
          A: doc.getText().includes('MARK_AAA'),
          B: doc.getText().includes('MARK_BBB'),
          C: doc.getText().includes('MARK_CCC'), // Q2: only C gone = 1:1
        },
      }

      // Q3: keep undoing until clean (or cap); count steps.
      let steps = 1
      while (doc.isDirty && steps < 15) {
        const t = doc.getText()
        await vscode.commands.executeCommand('undo')
        await new Promise((r) => setTimeout(r, 150))
        if (doc.getText() === t) break // undo no longer changing anything → stuck
        steps++
      }
      log.undoToClean = {
        totalUndoSteps: steps,
        editsApplied: 3,
        dirty: doc.isDirty,
        backToInitial: doc.getText() === initialText,
        version: doc.version,
      }
      return log
    },
    [FIXTURE] as [string],
  )) as Record<string, unknown>

  // eslint-disable-next-line no-console
  console.log(`[lockstep-spike] ${JSON.stringify(result, null, 2)}`)
  expect(result).toBeTruthy()
})

test('SPIKE: real-flow Vditor + native undo align without a setValue echo', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const tmp = path.join(tmpdir(), 'vmde-lockstep-real-flow.md')
  const initial = readFileSync(FIXTURE, 'utf8')
  writeFileSync(tmp, initial)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [tmp] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'lockstep real-flow fixture readiness' },
  )
  // Vditor's initial undo snapshot is debounce-owned and not represented in the readiness ledger.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))

  const state = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === args[0],
        )
        return {
          text: document?.getText() ?? '',
          dirty: document?.isDirty ?? false,
          version: document?.version ?? -1,
        }
      },
      [tmp] as [string],
    ) as Promise<{ text: string; dirty: boolean; version: number }>

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const originalSetValue = outer.setValue.bind(outer)
    ;(window as any).__lockstepSetValueCalls = 0
    outer.setValue = (...args: unknown[]) => {
      ;(window as any).__lockstepSetValueCalls++
      return originalSetValue(...args)
    }

    const editor = outer.vditor[outer.getCurrentMode()].element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let anchor: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').includes('Edit here')) continue
      anchor = node as Text
      break
    }
    if (!anchor) throw new Error('lockstep caret anchor not found')
    const range = document.createRange()
    range.setStart(anchor, anchor.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus({ preventScroll: true })
  })

  const marker = 'LOCKSTEP_REAL_FLOW'
  await workbox.keyboard.type(marker, { delay: 35 })
  await expect.poll(async () => (await state()).text).toContain(marker)
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1200)))
  const edited = await state()

  const vditorUndo = await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const inner = outer.vditor
    const before = outer.getValue()
    inner.undo.undo(inner)
    return { before, after: outer.getValue() }
  })

  await expect
    .poll(async () => {
      const current = await state()
      return current.text === initial && current.dirty === false
    })
    .toBe(true)
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 2200)))

  const final = await state()
  const webview = await frame.locator('body').evaluate(() => ({
    value: (window as any).vditor.getValue(),
    setValueCalls: (window as any).__lockstepSetValueCalls as number,
  }))
  // eslint-disable-next-line no-console
  console.log(
    `[lockstep-real-flow] ${JSON.stringify({ edited, vditorUndo, final, webview }, null, 2)}`,
  )
  expect(vditorUndo.before).toContain(marker)
  expect(vditorUndo.after).not.toBe(initial)
  expect(final.text).toBe(initial)
  expect(final.dirty).toBe(false)
  expect(final.version).toBe(edited.version + 1)
  expect(webview.value).toBe(vditorUndo.after)
  expect(webview.setValueCalls).toBe(0)
})
