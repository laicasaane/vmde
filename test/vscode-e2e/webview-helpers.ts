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
