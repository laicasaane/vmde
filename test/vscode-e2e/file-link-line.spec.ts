import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 635 — a file link that names a line (`a.ts:12`, `a.ts:12:5`, `a.ts#L12`, `a.ts#L12-L15`,
// `a.ts#L12C3`) opens that file at that line instead of showing `File not found`. This spec
// drives the full round trip in a real VS Code webview: a Ctrl+click on the rendered link, the
// host's `open-link` routing, and the landing place.
//
// - A non-markdown target opens in the plain text editor with the selection at the line (and
//   column); a range selects its lines; a line past the end lands on the last line.
// - A file whose literal name carries the suffix (`lit.ts:7`) opens as that file, with no line.
// - A markdown target opens in VMDE (the editor the link was clicked in) and reveals the line.
// - A target outside the workspace is refused with a visible error and no editor change.
//
// The expected positions come from the task contract (1-based line and column in the link,
// 0-based in VS Code), never from the code under test. Outcome-based like local-link-open.spec.ts:
// the active tab, the active text editor's selection, and the error notifications.
//
// The workspace root is `dir`; `escape.ts` sits one folder above it.
const root = path.join(tmpdir(), `vmde-file-link-line-${process.pid}`)
const dir = path.join(root, 'ws')
mkdirSync(dir, { recursive: true })

// 30 lines, no trailing newline: the last line is line 30 in both the file and the document.
const A_LINES = Array.from(
  { length: 30 },
  (_, i) => `export const value${String(i + 1).padStart(2, '0')} = ${i + 1}`,
)
const B_LINES = [
  '# Alpha',
  '',
  'Paragraph three text.',
  '',
  '## Beta',
  '',
  '```ts',
  'const fenced = 1',
  '```',
  '',
  'Tail paragraph.',
]
const LIT_NAME = 'lit.ts:7'
const aTs = path.join(dir, 'a.ts')
const bMd = path.join(dir, 'b.md')
const litTs = path.join(dir, LIT_NAME)
const binDat = path.join(dir, 'bin.dat')
const escapeTs = path.join(root, 'escape.ts')
const main = path.join(dir, 'main.md')
writeFileSync(aTs, A_LINES.join('\n'))
writeFileSync(bMd, `${B_LINES.join('\n')}\n`)
writeFileSync(
  litTs,
  Array.from({ length: 10 }, (_, i) => `literal line ${i + 1}`).join('\n'),
)
// NUL bytes make VS Code refuse to open the file as text.
writeFileSync(binDat, Buffer.from([0, 1, 2, 0, 255, 0, 3, 0, 4, 0]))
writeFileSync(escapeTs, ['one', 'two', 'three'].join('\n'))

const LINKS = {
  suffix: { label: 'lk01', href: 'a.ts:12' },
  suffixColumn: { label: 'lk02', href: 'a.ts:12:5' },
  dotSlash: { label: 'lk03', href: './a.ts:12' },
  fragment: { label: 'lk04', href: 'a.ts#L12' },
  fragmentRange: { label: 'lk05', href: 'a.ts#L12-L15' },
  fragmentColumn: { label: 'lk06', href: 'a.ts#L12C3' },
  pastEnd: { label: 'lk07', href: 'a.ts:99' },
  literal: { label: 'lk08', href: LIT_NAME },
  markdownSuffix: { label: 'lk09', href: 'b.md:3' },
  markdownFragment: { label: 'lk10', href: 'b.md#L3' },
  escape: { label: 'lk11', href: '../escape.ts:2' },
  binary: { label: 'lk12', href: 'bin.dat:5' },
  markdownBlank: { label: 'lk13', href: 'b.md:2' },
  markdownFenced: { label: 'lk14', href: 'b.md:8' },
} as const
type LinkKey = keyof typeof LINKS

writeFileSync(
  main,
  [
    '# File links with line numbers',
    '',
    ...Object.values(LINKS).flatMap(({ label, href }) => [
      `[${label}](${href})`,
      '',
    ]),
  ].join('\n'),
)

test.use({ baseDir: dir })

test.afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type Evaluate = Parameters<typeof reopenVmdeFixture>[0]
type Workbox = import('@playwright/test').Page
type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'

interface Pos {
  line: number
  character: number
}
interface Selection {
  start: Pos
  end: Pos
}
interface TabInfo {
  fsPath: string
  viewType: string | undefined
}
interface Active {
  tab: TabInfo | null
  // The active text editor's selection, only when it shows the active tab's file.
  selection: Selection | null
}

// The webview that is on screen. Opening another file hides the clicking document's webview but
// VS Code keeps it in the DOM, so the plain `wf` selector could resolve to the hidden one.
const visibleFrame = (workbox: Workbox): Frame =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

async function allTabs(evaluate: Evaluate): Promise<TabInfo[]> {
  return (await evaluate(
    async (vscode: typeof import('vscode')) =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .map((t) => {
          const input = t.input as
            | { uri?: { fsPath?: string }; viewType?: string }
            | undefined
          return { fsPath: input?.uri?.fsPath, viewType: input?.viewType }
        })
        .filter((t) => !!t.fsPath),
    [] as unknown as [string],
  )) as TabInfo[]
}

async function readActive(evaluate: Evaluate): Promise<Active> {
  return (await evaluate(
    async (vscode: typeof import('vscode')) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
        | { uri?: { fsPath?: string }; viewType?: string }
        | undefined
      const fsPath = input?.uri?.fsPath
      const tab = fsPath ? { fsPath, viewType: input?.viewType } : null
      const editor = vscode.window.activeTextEditor
      const selection =
        editor && editor.document.uri.fsPath === fsPath
          ? {
              start: {
                line: editor.selection.start.line,
                character: editor.selection.start.character,
              },
              end: {
                line: editor.selection.end.line,
                character: editor.selection.end.character,
              },
            }
          : null
      return { tab, selection }
    },
    [] as unknown as [string],
  )) as Active
}

// Error notifications as the workbench shows them: toast or notification-center rows carrying
// the error icon. Read from the workbench itself, so the check does not depend on which
// extension-host API object the host code reports through.
const workbenchErrors = (workbox: Workbox): Promise<string[]> =>
  workbox.locator('.notification-list-item:has(.codicon-error)').allInnerTexts()

async function expectNoErrors(workbox: Workbox): Promise<void> {
  expect(await workbenchErrors(workbox)).toEqual([])
}

async function boot(evaluate: Evaluate, workbox: Workbox): Promise<Frame> {
  const frame = await reopenVmdeFixture(evaluate, workbox, main)
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'file-link-line IR readiness' },
  )
  expect(
    await evaluate(
      async (vscode: typeof import('vscode'), args: string[]) =>
        vscode.extensions.getExtension(args[0])?.isActive ?? false,
      [ExtensionId] as [string],
    ),
  ).toBe(true)
  return frame
}

// Switch through the toolbar edit-mode panel — the user's own path.
async function switchMode(
  frame: Frame,
  mode: Exclude<Mode, 'ir'>,
): Promise<void> {
  await frame.locator('body').evaluate((_el, target) => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector(`button[data-mode="${target}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await waitForE2EReadiness(frame, (state) => state.mode === mode, {
    message: `file-link-line ${mode} readiness`,
  })
}

// The element that carries a link's visible text, per surface. `labels` are unique and the same
// width, and the text match is anchored, so one label never selects another's link.
function linkTarget(
  frame: Frame,
  surface: 'ir' | 'wysiwyg' | 'sv' | 'preview',
  label: string,
) {
  const exact = new RegExp(`^${label}$`)
  switch (surface) {
    case 'ir':
      return frame
        .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
        .filter({ hasText: exact })
    case 'wysiwyg':
      return frame.locator('.vditor-wysiwyg a[href]').filter({ hasText: exact })
    case 'sv':
      return frame
        .locator('.vditor-sv [data-type="link-text"]')
        .filter({ hasText: exact })
    case 'preview':
      return frame.locator('.vditor-preview a[href]').filter({ hasText: exact })
  }
}

// A real pointer click with the platform modifier held (the task-62 policy: plain click edits).
async function ctrlClick(
  frame: Frame,
  surface: 'ir' | 'wysiwyg' | 'sv' | 'preview',
  key: LinkKey,
): Promise<void> {
  const target = linkTarget(frame, surface, LINKS[key].label)
  await expect(target).toHaveCount(1)
  if (surface === 'wysiwyg') {
    // A real pointer move over a WYSIWYG link opens the link panel on top of it, which then
    // intercepts the click; the dispatched click is the same event local-link-open.spec.ts uses.
    await target.dispatchEvent('click', { ctrlKey: true })
    return
  }
  await target.click({ modifiers: ['Control'] })
}

const at = (line: number, character: number): Pos => ({ line, character })
const collapsedAt = (line: number, character: number): Selection => ({
  start: at(line, character),
  end: at(line, character),
})

async function expectTextEditorAt(
  evaluate: Evaluate,
  fsPath: string,
  selection: Selection,
  tabsBefore: TabInfo[],
): Promise<void> {
  await expect
    .poll(() => readActive(evaluate), { timeout: 15_000 })
    .toEqual({ tab: { fsPath, viewType: undefined }, selection })
  const added = (await allTabs(evaluate)).filter(
    (t) => !tabsBefore.some((b) => b.fsPath === t.fsPath),
  )
  expect(added).toEqual([{ fsPath, viewType: undefined }])
}

// The top-level block that holds the caret in the on-screen webview, and its text.
async function caretBlockText(frame: Frame): Promise<string | null> {
  return frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor?: {
          vditor?: {
            currentMode?: string
            ir?: { element: HTMLElement }
            wysiwyg?: { element: HTMLElement }
          }
        }
      }
    ).vditor?.vditor
    const editor =
      inner?.currentMode === 'wysiwyg'
        ? inner.wysiwyg?.element
        : inner?.ir?.element
    const selection = getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    if (!editor || !anchor) return null
    const block = Array.from(editor.children).find((b) => b.contains(anchor))
    return block ? (block.textContent ?? '') : null
  })
}

async function openedInVmde(evaluate: Evaluate, fsPath: string) {
  await expect
    .poll(() => readActive(evaluate), { timeout: 15_000 })
    .toMatchObject({ tab: { fsPath, viewType: MarkdownEditorViewType } })
}

// Back to the clicking document with every other editor closed, so the next click opens its
// target from scratch (a target that stayed open would keep the previous selection).
async function returnToMain(
  evaluate: Evaluate,
  workbox: Workbox,
  mode: Mode,
): Promise<Frame> {
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[1],
      )
      await vscode.commands.executeCommand('workbench.action.closeOtherEditors')
    },
    [main, MarkdownEditorViewType] as [string, string],
  )
  await expect
    .poll(() => allTabs(evaluate), { timeout: 15_000 })
    .toEqual([{ fsPath: main, viewType: MarkdownEditorViewType }])
  const frame = visibleFrame(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { message: `file-link-line return to ${mode} document` },
  )
  return frame
}

const IR_TEXT_CASES: Array<{
  name: string
  key: LinkKey
  selection: Selection
}> = [
  { name: 'a.ts:12', key: 'suffix', selection: collapsedAt(11, 0) },
  { name: 'a.ts:12:5', key: 'suffixColumn', selection: collapsedAt(11, 4) },
  { name: './a.ts:12', key: 'dotSlash', selection: collapsedAt(11, 0) },
  { name: 'a.ts#L12', key: 'fragment', selection: collapsedAt(11, 0) },
  {
    name: 'a.ts#L12-L15',
    key: 'fragmentRange',
    selection: { start: at(11, 0), end: at(14, A_LINES[14].length) },
  },
  { name: 'a.ts#L12C3', key: 'fragmentColumn', selection: collapsedAt(11, 2) },
  {
    name: 'a.ts:99 (last line)',
    key: 'pastEnd',
    selection: collapsedAt(29, 0),
  },
]

// Acceptance items (tasks/635): "Every notation opens the right file at the right line and
// column" (IR), "plain file links and literal colon filenames behave per the rules", "Outside-
// workspace targets are still refused". Clicks share one document: after each landing the
// test returns to it with the other editors closed, so every case opens its target afresh.
test('IR: every notation opens its target at the right place', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  let frame = await boot(evaluateInVSCode, workbox)

  // Acceptance "right file at the right line/column": text targets.
  for (const { name, key, selection } of IR_TEXT_CASES) {
    await test.step(name, async () => {
      const tabsBefore = await allTabs(evaluateInVSCode)
      await ctrlClick(frame, 'ir', key)
      await expectTextEditorAt(evaluateInVSCode, aTs, selection, tabsBefore)
      await expectNoErrors(workbox)
      frame = await returnToMain(evaluateInVSCode, workbox, 'ir')
    })
  }

  // Acceptance "literal colon filenames are handled per the rules": the literal file wins, no line.
  await test.step('lit.ts:7 (literal file name)', async () => {
    const tabsBefore = await allTabs(evaluateInVSCode)
    await ctrlClick(frame, 'ir', 'literal')
    await expectTextEditorAt(
      evaluateInVSCode,
      litTs,
      collapsedAt(0, 0),
      tabsBefore,
    )
    await expectNoErrors(workbox)
    frame = await returnToMain(evaluateInVSCode, workbox, 'ir')
  })

  // Contract 6: a file that cannot open as text still opens, with no toast.
  await test.step('bin.dat:5 (binary file)', async () => {
    const tabsBefore = await allTabs(evaluateInVSCode)
    await ctrlClick(frame, 'ir', 'binary')
    await expect
      .poll(async () => (await readActive(evaluateInVSCode)).tab?.fsPath, {
        timeout: 15_000,
      })
      .toBe(binDat)
    const added = (await allTabs(evaluateInVSCode)).filter(
      (t) => !tabsBefore.some((b) => b.fsPath === t.fsPath),
    )
    expect(added.map((t) => t.fsPath)).toEqual([binDat])
    await expectNoErrors(workbox)
    frame = await returnToMain(evaluateInVSCode, workbox, 'ir')
  })

  // Acceptance "outside-workspace targets are still refused".
  await test.step('../escape.ts:2 (outside the workspace)', async () => {
    const tabsBefore = await allTabs(evaluateInVSCode)
    const activeBefore = await readActive(evaluateInVSCode)
    await ctrlClick(frame, 'ir', 'escape')
    // The visible refusal is the completion signal: the host reports it after the check.
    await expect
      .poll(() => workbenchErrors(workbox), { timeout: 15_000 })
      .toEqual([expect.stringContaining('outside the workspace')])
    expect(await allTabs(evaluateInVSCode)).toEqual(tabsBefore)
    expect(await readActive(evaluateInVSCode)).toEqual(activeBefore)
    // The error toast stays on screen; clear it so the later no-error checks start clean.
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('notifications.clearAll')
      },
      [] as unknown as [string],
    )
    await expect
      .poll(() => workbenchErrors(workbox), { timeout: 10_000 })
      .toEqual([])
  })

  // Acceptance "right file at the right line" for a markdown target: VMDE opens it and reveals
  // line 3. Last, because a failed reveal ends the test.
  for (const [name, key] of [
    ['b.md:3', 'markdownSuffix'],
    ['b.md#L3 (no heading named L3)', 'markdownFragment'],
  ] as const) {
    await test.step(name, async () => {
      frame = await returnToMain(evaluateInVSCode, workbox, 'ir')
      await ctrlClick(frame, 'ir', key)
      await openedInVmde(evaluateInVSCode, bMd)
      const target = visibleFrame(workbox)
      await target.locator('.vditor-ir').first().waitFor({ timeout: 30_000 })
      await expect
        .poll(() => caretBlockText(target), { timeout: 20_000 })
        .toBe(B_LINES[2])
      await expectNoErrors(workbox)
    })
  }
})

// Acceptance "in IR, WYSIWYG, SV and Preview": the mode of the clicking document. SV and its
// Preview pane share one state, so one click each in the same split view.
test('WYSIWYG, SV and Preview: a.ts:12 opens a.ts at line 12', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  let frame = await boot(evaluateInVSCode, workbox)

  await switchMode(frame, 'wysiwyg')
  await test.step('WYSIWYG', async () => {
    const tabsBefore = await allTabs(evaluateInVSCode)
    await ctrlClick(frame, 'wysiwyg', 'suffix')
    await expectTextEditorAt(
      evaluateInVSCode,
      aTs,
      collapsedAt(11, 0),
      tabsBefore,
    )
    await expectNoErrors(workbox)
    frame = await returnToMain(evaluateInVSCode, workbox, 'wysiwyg')
  })

  await switchMode(frame, 'sv')
  await expect(linkTarget(frame, 'preview', LINKS.suffix.label)).toHaveCount(1)
  for (const surface of ['sv', 'preview'] as const) {
    await test.step(surface, async () => {
      const tabsBefore = await allTabs(evaluateInVSCode)
      await ctrlClick(frame, surface, 'suffix')
      await expectTextEditorAt(
        evaluateInVSCode,
        aTs,
        collapsedAt(11, 0),
        tabsBefore,
      )
      await expectNoErrors(workbox)
      frame = await returnToMain(evaluateInVSCode, workbox, 'sv')
    })
  }
})

// Probe (recorded, not asserted; Part 1 edge case): where the reveal lands for a blank line and
// for a line inside a fenced block. `@probe` keeps it out of the default tiers; `npm run
// test:probes` runs it.
test('@probe IR: b.md reveal landing on a blank line and inside a fenced block', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  let frame = await boot(evaluateInVSCode, workbox)
  for (const [name, key, line] of [
    ['blank line', 'markdownBlank', 2],
    ['line inside a fenced block', 'markdownFenced', 8],
  ] as const) {
    frame = await returnToMain(evaluateInVSCode, workbox, 'ir')
    await ctrlClick(frame, 'ir', key)
    await openedInVmde(evaluateInVSCode, bMd)
    const target = visibleFrame(workbox)
    await target.locator('.vditor-ir').first().waitFor({ timeout: 30_000 })
    try {
      await expect
        .poll(() => caretBlockText(target), { timeout: 10_000 })
        .not.toBeNull()
    } catch {
      // No caret block is itself the observation recorded below.
    }
    const landed = await caretBlockText(target)
    test.info().annotations.push({
      type: 'reveal-landing',
      description: `b.md:${line} (${name}) -> caret block ${JSON.stringify(landed)}`,
    })
    console.log(
      `PROBE b.md:${line} (${name}) caret block = ${JSON.stringify(landed)}`,
    )
    expect(await workbenchErrors(workbox)).toEqual([])
  }
})
