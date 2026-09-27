import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  installHeldDragUndoProbe,
  runHeldDrag,
} from './helpers/held-drag-undo-probe'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const SOURCE =
  'Native pointer selection keeps growing across a scheduled undo snapshot.\n'
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode} held drag survives forced and mode-switch Undo snapshots`, async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }, info) => {
    test.setTimeout(120_000)
    const file = path.join(baseDir, 'held-drag-undo.md')
    writeFileSync(file, SOURCE)
    await evaluateInVSCode(
      async (vscode, args: [string]) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.workspace
          .getConfiguration('vmde')
          .update('editor.defaultMode', 'ir', true)
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) => state.editorEpoch > 0 && state.mode === 'ir',
    )
    const input = await createXtestInput(electronApp, workbox)
    expect(input.client.visible).toBe(true)
    await input.activateAndFocus()
    const body = frame.locator('body')
    await body.evaluate(installHeldDragUndoProbe)
    const modeSwitches: any[] = []
    const switchMode = async (target: string, settleSnapshot: boolean) => {
      if (
        (await body.evaluate(
          () => (window as any).vditor.vditor.currentMode,
        )) === target
      )
        return
      const before = await body.evaluate(() =>
        (window as any).__heldDragProbe.timerState(),
      )
      await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
      await frame.locator(`button[data-mode="${target}"]`).click()
      if (settleSnapshot) {
        await waitForE2EReadiness(frame, (state) => state.mode === target)
        await expect
          .poll(async () => {
            const state = await body.evaluate(() =>
              (window as any).__heldDragProbe.timerState(),
            )
            return state.completed > before.completed && state.pending === 0
          })
          .toBe(true)
      } else {
        // The toolbar's E2E mode report follows a 500 ms persistence timer. Polling that report
        // can consume the 800 ms Undo window before this test even presses the pointer. Vditor
        // changes its actual mode/root synchronously in the mode-button click, so check those
        // directly and require the newly armed snapshot to remain pending. Never extend/re-arm it.
        const current = await body.evaluate(() => {
          const inner = (window as any).vditor.vditor
          return {
            ...(window as any).__heldDragProbe.timerState(),
            mode: inner.currentMode,
            rootVisible:
              inner[inner.currentMode].element.getBoundingClientRect().height >
              0,
            at: performance.now(),
          }
        })
        modeSwitches.push({ target, before, current })
        expect(current.mode).toBe(target)
        expect(current.rootVisible).toBe(true)
        expect(current.scheduled).toBeGreaterThan(before.scheduled)
        expect(current.completed).toBe(before.completed)
        expect(current.pending).toBe(1)
      }
    }
    await switchMode(mode === 'ir' ? 'wysiwyg' : 'ir', true)
    await switchMode(mode, true)
    const paragraph = frame.locator(`.vditor-${mode} .vditor-reset > p`).first()
    const results: any[] = []
    try {
      const control = await runHeldDrag(workbox, body, paragraph, false)
      results.push({ kind: 'control', ...control })
      expect(control.selectedLength).toBeGreaterThan(20)
      expect(control.forward && control.sourceUnchanged).toBe(true)
      expect(
        control.events.filter((e: any) => e.kind === 'selection-write'),
      ).toEqual([])
      const forced = await runHeldDrag(workbox, body, paragraph, true)
      results.push({ kind: 'forced', ...forced })
      expect(
        forced.events.filter((e: any) => e.kind === 'request-caret'),
      ).toHaveLength(1)
      expect(
        forced.events.filter(
          (e: any) => e.kind === 'selection-write' && e.afterInjection,
        ),
      ).toEqual([])
      expect(
        forced.events
          .filter((e: any) => e.kind === 'repair')
          .every((e: any) => e.placed && e.caretHeight > 0),
      ).toBe(true)
      expect(forced.selectedLength).toBe(control.selectedLength)
      expect(forced.forward && forced.sourceUnchanged).toBe(true)
      await switchMode(mode === 'ir' ? 'wysiwyg' : 'ir', true)
      await switchMode(mode, false)
      const timer = await runHeldDrag(workbox, body, paragraph, false)
      results.push({ kind: 'timer', ...timer })
      const timerDown = timer.events.find((e: any) => e.kind === 'pointerdown')
      expect(
        timerDown?.pending.some(
          (job: any) => job.mode === mode && job.firedAt === 0,
        ),
        'the mode-switch Undo timer must still be pending at pointerdown',
      ).toBe(true)
      expect(timer.events.some((e: any) => e.kind === 'timer' && e.held)).toBe(
        true,
      )
      expect(
        timer.events.some(
          (e: any) =>
            e.kind === 'request-caret' && e.held && e.activeTimer !== null,
        ),
      ).toBe(true)
      expect(
        timer.events.filter(
          (e: any) => e.kind === 'selection-write' && !e.immediateRepair,
        ),
      ).toEqual([])
      expect(
        timer.events.filter((e: any) => e.kind === 'request-caret' && e.held),
      ).toHaveLength(1)
      expect(
        timer.events
          .filter((e: any) => e.kind === 'repair')
          .every((e: any) => e.placed && e.caretHeight > 0),
      ).toBe(true)
      expect(timer.selectedLength).toBe(control.selectedLength)
      expect(timer.forward && timer.sourceUnchanged).toBe(true)
      expect(
        results.every((r) => r.focused && r.visibility === 'visible'),
      ).toBe(true)
      expect(await body.evaluate(() => (window as any).vditor.getValue())).toBe(
        SOURCE,
      )
      expect(await docText(evaluateInVSCode, file)).toBe(SOURCE)
      await evaluateInVSCode(async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      })
      expect(readFileSync(file, 'utf8')).toBe(SOURCE)
    } finally {
      const artifact = info.outputPath('held-drag-undo-evidence.json')
      writeFileSync(
        artifact,
        JSON.stringify({ mode, modeSwitches, results }, null, 2),
      )
      await info.attach('Task 578 held drag', {
        path: artifact,
        contentType: 'application/json',
      })
      console.log(
        '[Task 578 held drag VS Code]',
        JSON.stringify({ mode, modeSwitches, results }),
      )
    }
  })
}
