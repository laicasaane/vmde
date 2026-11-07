import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, wf } from './webview-helpers'

// Task 705 — every mermaid error and warning appears IN PLACE, at its block, in IR, WYSIWYG, the sv
// (Split) preview pane and the full Preview pane. Acceptance items: "Every error and warning shows in
// place at its mermaid block, in IR, WYSIWYG, sv preview and Preview" (case A), "warning survives a
// theme flip and a mode switch back" (case B, paths P6/P8), "a state diagram with unregistered loaders
// shows an error, a flowchart that falls back shows the fallback warning" (case C), "no blank block".
const FIXTURE = path.join(__dirname, 'fixtures', 'mermaid-report.md')
const EMPTY = path.join(__dirname, 'fixtures', 'mermaid-report-empty.md')

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'
type Evaluate = Parameters<typeof docText>[0]

// Fixture order: flowchart, straight class, fan-out class, state, broken.
const FLOW = 0
const STRAIGHT = 1
const FAN = 2
const STATE = 3
const BROKEN = 4

interface BlockInfo {
  svg: boolean
  processed: boolean
  error: string | null
  tokens: string[]
  warningInside: boolean
}

// Each pane has its own scope; blocks are the rendered `.language-mermaid` targets, never the
// editable marker <code>.
const SCOPE: Record<'ir' | 'wysiwyg' | 'sv' | 'preview', string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
  sv: '.vditor-preview',
  preview: '.vditor-preview',
}

async function openDoc(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  file: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // Retained: a mode click right after boot is the lost-click family.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 2000)))
  return frame
}

async function setMode(frame: Frame, mode: Mode) {
  await frame.locator('body').evaluate((_el, target) => {
    const v = (window as any).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector(`button[data-mode="${target}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
}

const togglePreview = (frame: Frame) =>
  frame.locator('.vditor-toolbar [data-type="preview"]').first().click()

function blocks(frame: Frame, scope: string): Promise<BlockInfo[]> {
  return frame.locator('body').evaluate((_el, sel) => {
    const root = document.querySelector(sel)
    const els = root
      ? [...root.querySelectorAll('.language-mermaid')].filter(
          (e) =>
            e.tagName !== 'CODE' &&
            !e.closest('.vditor-ir__marker--pre, .vditor-wysiwyg__pre'),
        )
      : []
    return els.map((e) => ({
      svg: !!e.querySelector('svg'),
      processed: e.getAttribute('data-processed') === 'true',
      error: e.querySelector('.vmde-diagram-error__msg')?.textContent ?? null,
      tokens: [...e.querySelectorAll('.vmde-diagram-warning')].flatMap((w) =>
        (w.getAttribute('data-vmde-warning') ?? '').split(' '),
      ),
      // the warning must sit inside ITS OWN block, not in a neighbour
      warningInside: !!e.querySelector('.vmde-diagram-warning'),
    }))
  }, scope) as Promise<BlockInfo[]>
}

async function settled(frame: Frame, scope: string, count: number) {
  await expect
    .poll(
      async () => {
        const b = await blocks(frame, scope)
        return b.length >= count && b.every((x) => x.svg || x.error !== null)
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}

async function expectCaseA(frame: Frame, scope: string, label: string) {
  await settled(frame, scope, 5)
  const b = await blocks(frame, scope)
  for (const i of [FLOW, STRAIGHT, FAN, STATE]) {
    expect.soft(b[i].svg, `${label}: block ${i} has an svg`).toBe(true)
    expect.soft(b[i].error, `${label}: block ${i} has no error`).toBeNull()
  }
  expect
    .soft(b[BROKEN].error, `${label}: broken block shows the error box`)
    .not.toBeNull()
  expect.soft(b[BROKEN].svg, `${label}: broken block has no svg`).toBe(false)
  expect
    .soft(b[STRAIGHT].tokens, `${label}: straight class diagram is warned`)
    .toContain('terminal-labels')
  expect
    .soft(b[FAN].tokens, `${label}: fan-out is not warned`)
    .not.toContain('terminal-labels')
  expect
    .soft(b[FLOW].tokens, `${label}: flowchart has no fallback warning`)
    .not.toContain('layout-fallback')
  expect
    .soft(b[STATE].tokens, `${label}: state has no fallback warning`)
    .not.toContain('layout-fallback')
}

test('A: errors and warnings appear in place in IR, WYSIWYG, sv preview and Preview', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = await openDoc(evaluateInVSCode, workbox, FIXTURE)
  const original = await docText(evaluateInVSCode, FIXTURE)

  await expectCaseA(frame, SCOPE.ir, 'IR')

  await setMode(frame, 'wysiwyg')
  await expectCaseA(frame, SCOPE.wysiwyg, 'WYSIWYG')

  await setMode(frame, 'sv')
  await expectCaseA(frame, SCOPE.sv, 'sv preview')

  await setMode(frame, 'ir')
  await togglePreview(frame)
  await expectCaseA(frame, SCOPE.preview, 'Preview')
  await togglePreview(frame)

  // Warning and error boxes are Lute-invisible: the document text is unchanged by all of this.
  expect(await docText(evaluateInVSCode, FIXTURE)).toBe(original)
})

test('B: the warning survives a theme flip and a mode switch back', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = await openDoc(evaluateInVSCode, workbox, FIXTURE)
  await expectCaseA(frame, SCOPE.ir, 'IR before flip')

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', args[0], vscode.ConfigurationTarget.Global)
    },
    ['Default Light Modern'] as [string],
  )
  // The re-theme is viewport-gated (retheme gate): scroll each block into view one at a time.
  for (let i = 0; i < 5; i++) {
    await frame.locator('body').evaluate((_el, n) => {
      const els = [
        ...document.querySelectorAll('.vditor-ir .language-mermaid'),
      ].filter(
        (e) => e.tagName !== 'CODE' && !e.closest('.vditor-ir__marker--pre'),
      )
      els[n]?.scrollIntoView({ block: 'center' })
    }, i)
    await frame
      .locator('body')
      .evaluate(() => new Promise((r) => setTimeout(r, 200))) // gate observer needs a beat per block
  }
  await expectCaseA(frame, SCOPE.ir, 'IR after flip')

  await setMode(frame, 'wysiwyg')
  await setMode(frame, 'ir')
  await expectCaseA(frame, SCOPE.ir, 'IR after mode switch back')
})

test('C: unregistered ELK loaders — state shows the error, flowchart the fallback warning, in all modes', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = await openDoc(evaluateInVSCode, workbox, EMPTY)
  // Chain the existing window.mermaid accessor (installed by the initialize wrapper): the loaded
  // mermaid object gets a no-op registerLayoutLoaders, so ELK is never registered by anyone.
  await frame.locator('body').evaluate(() => {
    const prev = Object.getOwnPropertyDescriptor(window, 'mermaid')
    let current: any = prev?.get
      ? prev.get.call(window)
      : (window as any).mermaid
    Object.defineProperty(window, 'mermaid', {
      configurable: true,
      get: () => current,
      set(v) {
        if (v) v.registerLayoutLoaders = () => undefined
        current = v
        prev?.set?.call(window, v)
      },
    })
  })

  const flow =
    '```mermaid\n---\nconfig:\n  layout: elk\n---\nflowchart TD\n  A[Start] --> B[End]\n```\n\n'
  const state =
    '```mermaid\n---\nconfig:\n  layout: elk\n---\nstateDiagram-v2\n  [*] --> A\n  A --> [*]\n```\n'
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (!doc) throw new Error('fixture document not open')
      const edit = new vscode.WorkspaceEdit()
      edit.insert(
        doc.uri,
        new vscode.Position(doc.lineCount, 0),
        `\n${args[1]}${args[2]}`,
      )
      await vscode.workspace.applyEdit(edit)
    },
    [EMPTY, flow, state] as [string, string, string],
  )

  const check = async (scope: string, label: string) => {
    await expect
      .poll(
        async () => {
          const b = await blocks(frame, scope)
          return b.length >= 2 && b.every((x) => x.svg || x.error !== null)
        },
        { timeout: 60_000 },
      )
      .toBe(true)
    const [f, s] = await blocks(frame, scope)
    expect.soft(f.svg, `${label}: flowchart still drawn`).toBe(true)
    expect
      .soft(f.tokens, `${label}: flowchart carries the fallback warning`)
      .toContain('layout-fallback')
    expect
      .soft(s.error, `${label}: state diagram shows the error`)
      .toContain('Unknown layout algorithm: elk')
  }

  await check(SCOPE.ir, 'IR')
  await setMode(frame, 'wysiwyg')
  await check(SCOPE.wysiwyg, 'WYSIWYG')
  await setMode(frame, 'sv')
  await check(SCOPE.sv, 'sv preview')
  await setMode(frame, 'ir')
  await togglePreview(frame)
  await check(SCOPE.preview, 'Preview')
  await togglePreview(frame)
})
