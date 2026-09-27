import { expect, test } from './coverage-fixture'
import {
  installHeldDragUndoProbe,
  runHeldDrag,
} from '../../test/vscode-e2e/helpers/held-drag-undo-probe'

const SOURCE =
  'Native pointer selection keeps growing across a scheduled undo snapshot.\n'
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode} snapshot repairs once without truncating a held drag`, async ({
    page,
  }) => {
    await page.goto('/selection-bubble.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.evaluate(installHeldDragUndoProbe)
    await page.evaluate(
      (source) => (window as any).vditor.setValue(source),
      SOURCE,
    )
    const body = page.locator('body')
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
      await page.evaluate(
        (target) => (window as any).__setSelectionBubbleMode(target),
        target,
      )
      if (settleSnapshot)
        await expect
          .poll(async () => {
            const state = await body.evaluate(() =>
              (window as any).__heldDragProbe.timerState(),
            )
            return state.completed > before.completed && state.pending === 0
          })
          .toBe(true)
    }
    await switchMode(mode === 'ir' ? 'wysiwyg' : 'ir', true)
    await switchMode(mode, true)
    const paragraph = page.locator(`.vditor-${mode} .vditor-reset > p`).first()
    const control = await runHeldDrag(page, body, paragraph, false)
    expect(control.selectedLength).toBeGreaterThan(20)
    expect(control.forward && control.sourceUnchanged).toBe(true)
    expect(
      control.events.filter((e: any) => e.kind === 'selection-write'),
    ).toEqual([])
    const forced = await runHeldDrag(page, body, paragraph, true)
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
    // The same mode-switch timer that caused the reported failure is not drained for this leg.
    await switchMode(mode === 'ir' ? 'wysiwyg' : 'ir', true)
    await switchMode(mode, false)
    const timer = await runHeldDrag(page, body, paragraph, false)
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
    expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
      SOURCE,
    )
    console.log(
      '[Task 578 held drag Chromium]',
      JSON.stringify({ mode, control, forced, timer }),
    )
  })
}
