// Shared helpers for the real-VS-Code spec suite. Extracted 2026-08-01 (task 483) — 187 of 190
// specs previously carried their own inline copy of these, which is why `jscpd` attributed 79% of
// the repository's duplication to this directory duplicating itself. `wf()`'s selector chain
// encodes a fact about how VS Code nests the webview's iframes; keeping it in one place means a
// nesting change is fixed once, not corrected in every spec that happens to still have a fresh copy.
//
// A handful of specs keep their own LOCAL variant instead of importing from here — that is
// deliberate, not an oversight: `caret-focused-open-probe.spec.ts` and `caret-empty-typing.spec.ts`
// use `.last()` because a donor tab can leave two vmde webview iframes in the DOM at once;
// `anchor-links.spec.ts` and `webview-message-origin-probe.spec.ts` add `:visible`;
// `prerender-first-open.spec.ts` uses `.locator(...).last().contentFrame()`. Each is solving a
// real, spec-specific timing/ambiguity problem — do not "fix" them to import this instead.

import { expect } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  ProductDisplayName,
} from '../../src/shared/product-identity'

export { ExtensionId, MarkdownEditorViewType }

export function wf(workbox: import('@playwright/test').Page) {
  return workbox
    .frameLocator('iframe.webview')
    .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`)
}

/**
 * Click a toolbar control wherever the flow placed it. Insert ID and Insert Picture are toolbar
 * buttons that move into More when the row lacks space; Settings is always a toolbar button. A
 * control on the row is clicked directly, one inside More is clicked after opening More.
 */
export async function clickToolbarControl(
  frame: ReturnType<typeof wf>,
  name: string,
): Promise<void> {
  const onRow = frame
    .locator(
      `.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${name}"]`,
    )
    .first()
  if ((await onRow.count()) > 0) {
    await onRow.click()
    return
  }
  await frame.locator('.vditor-toolbar [data-type="more"]').click()
  await frame
    .locator(`.vmde-toolbar-more > .vditor-hint [data-type="${name}"]`)
    .click()
}

type EvaluateInVSCode = (fn: unknown, args: string[]) => Promise<unknown>

export async function reopenVmdeFixture(
  evaluateInVSCode: EvaluateInVSCode,
  workbox: import('@playwright/test').Page,
  fixture: string,
  editorReadyTimeout = 60_000,
  editorSelector = '.vditor-ir',
  waitForVisibleEditor = true,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    // The shared evaluator contract carries one string argument for the open call below. Closing
    // ignores it; reuse the real fixture instead of claiming an empty tuple contains a string.
    [fixture] as [string],
  )
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [fixture, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  // Closing/reopening can leave the previous webview retained in the DOM. Resolve the active
  // outer iframe here rather than `wf()`'s broad selector, so callers never wait in a hidden tab.
  const frame = workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`)
  if (waitForVisibleEditor) {
    await frame
      .locator(editorSelector)
      .first()
      .waitFor({ timeout: editorReadyTimeout })
  } else {
    await frame.locator('body').waitFor({ timeout: editorReadyTimeout })
  }
  return frame
}

export const ev = (evaluateInVSCode: EvaluateInVSCode, fn: unknown, arg = '') =>
  evaluateInVSCode(fn, [arg] as [string])

export const settle = (frame: ReturnType<typeof wf>, ms: number) =>
  frame
    .locator('body')
    .evaluate((_el, d) => new Promise((r) => setTimeout(r, d as number)), ms)

export const docText = (evaluateInVSCode: EvaluateInVSCode, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((d) => d.uri.fsPath === args[0])
        ?.getText() ?? '',
    [file] as [string],
  ) as Promise<string>

export interface E2EReadinessSnapshot {
  routerReady: boolean
  editorEpoch: number
  modeEpoch: number
  mode: 'ir' | 'wysiwyg' | 'sv' | null
  pending: Record<string, number>
  completed: Record<string, number>
}

export async function waitForE2EReadiness(
  frame: ReturnType<typeof wf>,
  ready: (snapshot: E2EReadinessSnapshot) => boolean,
  options: { timeout?: number; message?: string } = {},
): Promise<E2EReadinessSnapshot> {
  let last: E2EReadinessSnapshot | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await frame.locator('body').evaluate(
            () =>
              (
                window as unknown as {
                  __vmdeE2EReadiness?: E2EReadinessSnapshot
                }
              ).__vmdeE2EReadiness ?? null,
          )
          return last !== null && ready(last)
        },
        { timeout: options.timeout ?? 20_000, message: options.message },
      )
      .toBe(true)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${options.message ?? 'E2E readiness wait'} failed; last=${JSON.stringify(last)}; ${reason}`,
    )
  }
  return last as E2EReadinessSnapshot
}

/** Wait until Vditor has taken its own first undo snapshot of the opened document (an IR editor whose
 *  history the unit engine holds has none to wait for). The editor is
 *  visible and the router ready before Vditor's asynchronous init finishes: Lute loads, `initUI`
 *  runs `setEditMode`, and that schedules the snapshot `undoDelay` (800 ms) later. Measured 0.35 to
 *  over 1.8 s after `.vditor-ir` appears. Until it lands, the undo stack is one entry short, and
 *  the snapshot's caret restore (patchUndoCaretSplitRestore) arms caret.ts's re-assert loop at the
 *  caret it finds, which overwrites any later non-gesture selection a spec writes for up to 5 s. */
export async function waitForInitialUndoSnapshot(
  frame: ReturnType<typeof wf>,
  timeout = 15_000,
): Promise<void> {
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const w = window as unknown as {
            vditor?: {
              vditor?: {
                currentMode?: string
                undo?: Record<string, { undoStack?: unknown[] } | undefined>
              }
            }
            __vmdeUnitHistory?: {
              holds(vditor: unknown): boolean
              settled(vditor: unknown): boolean
            }
          }
          const inner = w.vditor?.vditor
          const mode = inner?.currentMode
          // Task 004: while the unit engine holds the IR history, Vditor's own stack stays empty and
          // there is no snapshot to wait for (the engine takes no snapshot and arms no caret restore).
          // The unit engine is settled when the model is live and its base exists, the moment the old
          // engine took its initial snapshot.
          const unit = w.__vmdeUnitHistory
          if (inner && unit?.holds(inner)) return unit.settled(inner) ? 1 : 0
          return mode ? (inner?.undo?.[mode]?.undoStack?.length ?? 0) : 0
        }),
      { timeout, message: "Vditor's initial undo snapshot" },
    )
    .toBeGreaterThanOrEqual(1)
}

// Computed `outlineWidth` of a throwaway element with an inline `outline: <width> solid`, so a
// test can compare against the same device-pixel rounding the browser applies to the real surface.
export async function referenceOutlineWidth(
  frame: ReturnType<typeof wf>,
  width: string,
): Promise<string> {
  return frame.locator('body').evaluate((body, w) => {
    const reference = document.createElement('button')
    reference.style.outline = `${w} solid`
    body.append(reference)
    const computed = getComputedStyle(reference).outlineWidth
    reference.remove()
    return computed
  }, width)
}

/**
 * Task 697: full Preview renders heavy blocks (code, diagrams, math) only when they are near the
 * viewport, so a read of the pane sees unrendered source for everything further down. Walk the
 * pane the way a reader scrolls it, wait until no block is pending, and end scrolled to the top.
 * `pane` is the selector of the Preview content element.
 */
export async function renderAllPreviewBlocks(
  frame: ReturnType<typeof wf>,
  pane = '.vditor-preview .vditor-reset',
) {
  // The pane fills asynchronously after the switch; walking an empty pane would find nothing pending.
  await expect
    .poll(() => frame.locator(`${pane} > *`).count(), { timeout: 60_000 })
    .toBeGreaterThan(0)
  await frame.locator('body').evaluate(async (_body, selector) => {
    const paneEl = document.querySelector(selector) as HTMLElement
    const scroller = (() => {
      let el: HTMLElement | null = paneEl
      while (el) {
        const overflow = getComputedStyle(el).overflowY
        if (/auto|scroll/.test(overflow) && el.scrollHeight > el.clientHeight)
          return el
        el = el.parentElement
      }
      return document.scrollingElement as HTMLElement
    })()
    for (
      let top = 0;
      top < scroller.scrollHeight;
      top += scroller.clientHeight * 0.7
    ) {
      scroller.scrollTop = top
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    scroller.scrollTop = 0
  }, pane)
  await expect
    .poll(() => frame.locator(`${pane} [data-vmde-preview-pending]`).count(), {
      timeout: 60_000,
    })
    .toBe(0)
}

/**
 * Task 733 (004-D): the text model runs in shadow mode in end-to-end runs and counts each answer
 * that did not match its prediction. A spec that is about something else still must not make the
 * model wrong, so it ends with this call. It asserts only when the stats exist (an IR editor with a
 * model session); an editor in another mode, or one that is gone, has none and passes.
 */
export async function expectNoShadowMismatch(
  frame: ReturnType<typeof wf>,
  label = 'text model shadow',
): Promise<void> {
  const stats = await frame
    .locator('body')
    .evaluate(
      () => {
        const s = (
          window as unknown as {
            __vmdeModelShadowStats?: { mismatch: number; compared: number }
          }
        ).__vmdeModelShadowStats
        return s ? { mismatch: s.mismatch, compared: s.compared } : null
      },
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => null)
  if (stats === null) return
  console.log(`MODEL-SHADOW ${JSON.stringify({ label, ...stats })}`)
  expect(stats.mismatch, `${label}: mismatch`).toBe(0)
}
