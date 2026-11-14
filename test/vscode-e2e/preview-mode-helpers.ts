// Task 643 — shared helpers for the real-VS-Code Preview-mode specs: sized documents, the
// Preview-first open, and readers of the open metrics and the edit/Preview panes.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vscode-test-playwright'
import { reopenVmdeFixture, type wf } from './webview-helpers'

export type Frame = ReturnType<typeof wf>
type Evaluate = Parameters<typeof reopenVmdeFixture>[0]
type Workbox = Parameters<typeof reopenVmdeFixture>[1]

export const PREVIEW_BUTTON = '.vditor-toolbar [data-type="preview"]'
export const PANE = '.vditor-preview .vditor-reset'
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit '

/** A document of about `chars` characters made of `## Section N` blocks (heading text is unique). */
export function sectionedDocument(chars: number, title = 'Sized document') {
  const parts = [`# ${title}\n\n`]
  let index = 0
  while (parts.join('').length < chars) {
    parts.push(
      `## Section ${index}\n\n${WORDS.repeat(8)}with **bold** and a [link](https://example.com/${index}).\n\n- item ${index} a\n- item ${index} b\n\n`,
    )
    index++
  }
  return { text: parts.join(''), sections: index }
}

export function writeDocument(dir: string, name: string, text: string) {
  const file = path.join(dir, name)
  writeFileSync(file, text)
  return file
}

export const setConfig = (
  evaluateInVSCode: Evaluate,
  key: string,
  value: unknown,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === 'undefined' ? undefined : JSON.parse(args[1]),
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value === undefined ? 'undefined' : JSON.stringify(value)],
  )

/** Open `file` in the VMDE editor and wait for the webview body (not for an edit view). */
export const openFile = (
  evaluateInVSCode: Evaluate,
  workbox: Workbox,
  file: string,
) =>
  reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    90_000,
    '.vditor-ir',
    false,
  )

export interface Metrics {
  initReceivedMs?: number
  surface?: string
  contentVisibleMs?: number
  completeMs?: number
  previewChunks?: number
  previewMaxChunkMs?: number
}

export const metrics = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeOpenMetrics?: Metrics })
          .__vmdeOpenMetrics ?? {},
    ) as Promise<Metrics>

/** Wait for the open's rendering work to finish (Preview: last chunk; edit: after helpers). */
export const waitComplete = async (frame: Frame, timeout = 120_000) => {
  await expect
    .poll(async () => typeof (await metrics(frame)).completeMs, {
      timeout,
      intervals: [200],
    })
    .toBe('number')
  return metrics(frame)
}

/** Letters and digits in the IR pane: Vditor renders an empty value as one blank paragraph. */
export const editTextLength = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        document
          .querySelector('.vditor-ir pre.vditor-reset')
          ?.textContent?.replace(/[^\p{L}\p{N}]/gu, '').length ?? -1,
    )

export const previewShowing = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const preview = document.querySelector<HTMLElement>('.vditor-preview')
    return !!preview && getComputedStyle(preview).display !== 'none'
  })

/** Top of the first element matching `selector` whose text contains `text`, viewport-relative. */
export const topOf = (frame: Frame, selector: string, text: string) =>
  frame.locator('body').evaluate(
    (_body, args) => {
      const el = [...document.querySelectorAll(args.selector)].find(
        (candidate) => candidate.textContent?.includes(args.text),
      )
      return el ? el.getBoundingClientRect().top : null
    },
    { selector, text },
  )

export const scrollPreviewTo = (frame: Frame, text: string) =>
  frame.locator('body').evaluate((_body, wanted) => {
    const heading = [...document.querySelectorAll('.vditor-preview h2')].find(
      (h) => h.textContent === wanted,
    ) as HTMLElement
    heading.scrollIntoView({ block: 'start' })
  }, text)

export const docState = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return {
        text: doc?.getText() ?? '',
        version: doc?.version ?? -1,
        dirty: !!doc?.isDirty,
      }
    },
    [file],
  ) as Promise<{ text: string; version: number; dirty: boolean }>

export const undoDepth = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor?: { vditor?: { currentMode: string; undo?: any } }
      }
    ).vditor?.vditor
    const slot = inner?.undo?.[inner.currentMode]
    if ((globalThis as any).__vmdeUnitHistory?.holds(inner))
      return (globalThis as any).__vmdeUnitHistory.depth(inner).undo as number
    return slot?.undoStack?.length ?? 0
  })

/** Close every editor, so the next spec in the run does not see this one's webview. */
export const closeAllEditors = (evaluateInVSCode: Evaluate) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [''],
  )
