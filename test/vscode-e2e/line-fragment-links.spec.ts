import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

// Task 730 — a link with a `#L<line>` or `#L<a>-L<b>` fragment reaches that source line in IR,
// WYSIWYG, Split (source and preview panes) and Preview, for another Markdown file and for the same
// document. The Owner's case comes first: `[point 14](scoping-proposal.md#L674)`, a long target with
// front matter and no heading named `L674`, not open yet. Expected places come from the fixture
// text (the line's own words), never from the code under test.
//
// - Edit modes: the line is on screen and the caret sits right before the line's text (a range
//   selects from its first line to its last).
// - Split: the caret sits at the start of the line in the source pane; both panes show the line.
// - Preview: the rendered block holding the line is on screen.
// - Task 635 precedence: an HTML id named like the fragment wins over the line.
// - The jump leaves the document, its dirty state and Undo history unchanged.
const root = path.join(tmpdir(), `vmde-line-fragment-${process.pid}`)
mkdirSync(root, { recursive: true })

function section(n: number): string[] {
  return [
    `## Section ${n}`,
    '',
    `Intro for section ${n} with **bold** text and \`code\` and a [link](https://example.com).`,
    `Second line of the intro paragraph ${n}.`,
    '',
    `1. First point of section ${n}.`,
    '',
    `2. Second point of section ${n}.`,
    `   - nested bullet a${n}`,
    `   - nested bullet b${n}`,
    '',
    `3. Third point of section ${n}.`,
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    `| a${n} | b${n} |`,
    '',
    `> Quote line one for ${n}.`,
    `> Quote line two for ${n}.`,
    '',
    '```ts',
    `const section${n} = ${n}`,
    '```',
    '',
  ]
}

// A scoping proposal: front matter, sections with loose lists (blank lines between items), tables,
// quotes and code, closing with a loose numbered list whose item 14 is on line 674.
function scopingProposal(): string[] {
  const lines = ['---', 'title: Scoping proposal', 'status: draft', '---', '']
  lines.push('# Scoping proposal', '')
  for (let n = 1; lines.length < 600; n++) lines.push(...section(n))
  const closing = ['## Closing points', '']
  const items: string[] = []
  for (let i = 1; i <= 16; i++)
    items.push(
      i === 14
        ? '14. Point fourteen TARGET674 is the line the link names.'
        : `${i}. Point ${i} of the closing list.`,
      '',
    )
  const at = 2 * 13 // item 14's index within `items`
  for (let k = 0; lines.length + closing.length + at < 672; k++)
    lines.push(`Filler ${k}.`, '')
  while (lines.length + closing.length + at < 673) lines.push('')
  lines.push(...closing, ...items)
  for (let i = 0; i < 20; i++) lines.push(`Tail paragraph ${i}.`, '')
  return lines
}

const PROPOSAL = scopingProposal()
const proposal = path.join(root, 'scoping-proposal.md')
writeFileSync(proposal, PROPOSAL.join('\n'))

// The clicking document: links first, a far HTML id target, then a soft-broken paragraph whose
// second and third lines are lines 120 and 121.
const LINKS = {
  point14: { label: 'point 14', href: 'scoping-proposal.md#L674' },
  range: { label: 'rangelink', href: 'scoping-proposal.md#L674-L676' },
  self: { label: 'selflink', href: '#L120' },
  selfRange: { label: 'selfrange', href: '#L120-L121' },
  idWins: { label: 'idlink', href: '#L7' },
} as const
type LinkKey = keyof typeof LINKS

const MAIN = ['# Main', '']
for (const { label, href } of Object.values(LINKS))
  MAIN.push(`[${label}](${href})`, '')
for (let k = 0; MAIN.length < 80; k++) MAIN.push(`Main filler ${k}.`, '')
MAIN.push('<a id="L7"></a>HTMLID_TARGET text', '')
for (let k = 0; MAIN.length < 118; k++) MAIN.push(`More filler ${k}.`, '')
MAIN.push(
  'Soft break first line.',
  'SELF120 is the same-document target line.',
  'SELF121 closes the paragraph.',
  '',
)
for (let k = 0; k < 40; k++) MAIN.push(`Main tail ${k}.`, '')
const main = path.join(root, 'main.md')
writeFileSync(main, MAIN.join('\n'))

test.use({ baseDir: root })
test.afterAll(() => rmSync(root, { recursive: true, force: true }))

type Evaluate = Parameters<typeof reopenVmdeFixture>[0]
type Workbox = import('@playwright/test').Page
type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'
type Surface = Mode | 'svpreview'

const visibleFrame = (workbox: Workbox) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')
type Frame = ReturnType<typeof visibleFrame>

async function enterMode(frame: Frame, mode: Mode): Promise<void> {
  await frame.locator('body').evaluate((_body, next) => {
    const inner = (window as any).vditor.vditor
    const click = (el: Element | null | undefined) =>
      el?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    const previewOpen = () =>
      inner.toolbar.elements.preview?.children[0]?.classList.contains(
        'vditor-menu--current',
      )
    if (next === 'preview') {
      if (!previewOpen()) click(inner.toolbar.elements.preview?.children[0])
      return
    }
    if (previewOpen()) click(inner.toolbar.elements.preview?.children[0])
    if (inner.currentMode === next) return
    click(inner.toolbar.elements['edit-mode']?.children[0])
    click(document.querySelector(`button[data-mode="${next}"]`))
  }, mode)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        const shown = inner.preview?.element?.style.display === 'block'
        if (inner.currentMode === 'sv') return 'sv'
        return shown ? 'preview' : inner.currentMode
      }),
    )
    .toBe(mode)
  if (mode === 'sv' || mode === 'preview') {
    // The rendered pane fills asynchronously after the switch; wait for the links in it.
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.preview.element.querySelectorAll(
                'a[href]',
              ).length,
          ),
      )
      .toBeGreaterThanOrEqual(Object.keys(LINKS).length)
  }
}

// A modifier click on the link's visible text, dispatched like id-target-navigation.spec.ts does
// (a real pointer move over a WYSIWYG link opens its panel over the link).
async function ctrlClick(
  frame: Frame,
  surface: Surface,
  key: LinkKey,
): Promise<void> {
  const { label, href } = LINKS[key]
  const result = await frame.locator('body').evaluate(
    (_body, [wantedLabel, wantedHref, where]) => {
      const inner = (window as any).vditor.vditor
      const root: HTMLElement =
        where === 'preview' || where === 'svpreview'
          ? inner.preview.element
          : inner[inner.currentMode].element
      const target =
        where === 'sv'
          ? Array.from(
              root.querySelectorAll<HTMLElement>('[data-type="link-text"]'),
            ).find((el) => el.textContent === wantedLabel)
          : where === 'ir'
            ? Array.from(root.querySelectorAll<HTMLElement>('[data-type="a"]'))
                .find(
                  (el) =>
                    el.querySelector('.vditor-ir__marker--link')
                      ?.textContent === wantedHref,
                )
                ?.querySelector<HTMLElement>('.vditor-ir__link')
            : Array.from(
                root.querySelectorAll<HTMLAnchorElement>('a[href]'),
              ).find((el) => el.getAttribute('href') === wantedHref)
      if (!target) return `link ${wantedHref} not found in ${where}`
      target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      )
      return 'clicked'
    },
    [label, href, surface] as const,
  )
  expect(result).toBe('clicked')
}

interface LineState {
  mode: string
  previewShown: boolean
  // Whether the needle's text is on screen in the edit (or Split source) pane and the preview.
  editInView: boolean | null
  previewInView: boolean | null
  // The pane text right after the caret, and the selected text.
  afterCaret: string
  selected: string
  revealErrors: string[]
}

async function lineState(frame: Frame, needle: string): Promise<LineState> {
  return frame.locator('body').evaluate((_body, text) => {
    const inner = (window as any).vditor.vditor
    const previewShown = inner.preview?.element?.style.display === 'block'
    const edit: HTMLElement | undefined = inner[inner.currentMode]?.element
    const inView = (root: HTMLElement | undefined): boolean | null => {
      if (!root) return null
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').includes(text)) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
      }
      return false
    }
    const selection = getSelection()
    let afterCaret = ''
    if (edit && selection?.rangeCount && edit.contains(selection.anchorNode)) {
      const before = document.createRange()
      before.setStart(edit, 0)
      before.setEnd(selection.anchorNode!, selection.anchorOffset)
      afterCaret = (edit.textContent ?? '').slice(
        before.toString().length,
        before.toString().length + 60,
      )
    }
    const completed = (window as any).__vmdeE2EReadiness?.completed ?? {}
    return {
      mode: inner.currentMode,
      previewShown,
      editInView: edit && edit.offsetParent !== null ? inView(edit) : null,
      previewInView: previewShown ? inView(inner.preview.element) : null,
      afterCaret,
      selected: selection?.toString().replace(/\s+/g, ' ').slice(0, 200) ?? '',
      revealErrors: Object.keys(completed).filter((key) =>
        key.startsWith('reveal-line:error'),
      ),
    }
  }, needle)
}

async function readActive(evaluate: Evaluate) {
  return evaluate(
    async (vscode: typeof import('vscode')) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as
        | { uri?: { fsPath?: string }; viewType?: string }
        | undefined
      return { fsPath: input?.uri?.fsPath, viewType: input?.viewType }
    },
    [] as unknown as [string],
  ) as Promise<{ fsPath?: string; viewType?: string }>
}

// The document's text and dirty flag as VS Code holds them.
async function documentState(evaluate: Evaluate, fsPath: string) {
  return evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? null, dirty: doc?.isDirty ?? null }
    },
    [fsPath] as [string],
  ) as Promise<{ text: string | null; dirty: boolean | null }>
}

async function undoDepth(frame: Frame): Promise<number> {
  return frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    return (
      ((globalThis as any).__vmdeUnitHistory?.holds(inner)
        ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
        : inner.undo?.[inner.currentMode]?.undoStack?.length) ?? -1
    )
  })
}

// The fixture is the contract: these lines must be where the spec says they are.
function expectFixtureLines(): void {
  expect(PROPOSAL[673]).toContain('TARGET674')
  expect(PROPOSAL[675]).toBe('15. Point 15 of the closing list.')
  expect(MAIN[6]).toContain('selflink')
  expect(MAIN[119]).toContain('SELF120')
  expect(MAIN[120]).toContain('SELF121')
}

// Open every document of the test in `mode`; the setting is put back for the specs that follow.
async function withDefaultMode(
  evaluate: Evaluate,
  mode: string,
  run: () => Promise<void>,
): Promise<void> {
  await setDefaultMode(evaluate, mode)
  try {
    await run()
  } finally {
    await setDefaultMode(evaluate, 'remember')
  }
}

async function setDefaultMode(evaluate: Evaluate, mode: string) {
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          args[0],
          vscode.ConfigurationTarget.Global,
        )
    },
    [mode] as [string],
  )
}

// Open the clicking document alone (every other editor closed) in `mode`.
async function openMain(
  evaluate: Evaluate,
  workbox: Workbox,
  mode: Mode,
): Promise<Frame> {
  const frame = await reopenVmdeFixture(
    evaluate,
    workbox,
    main,
    60_000,
    '.vditor',
  )
  await waitForE2EReadiness(frame, (s) => s.routerReady && s.editorEpoch > 0, {
    message: 'line-fragment main readiness',
    timeout: 60_000,
  })
  expect(
    await evaluate(
      async (vscode: typeof import('vscode'), args: string[]) =>
        vscode.extensions.getExtension(args[0])?.isActive ?? false,
      [ExtensionId] as [string],
    ),
  ).toBe(true)
  await enterMode(frame, mode)
  return frame
}

// Open the target in the background first (the "already open" case), then return to main.
async function preopenProposal(evaluate: Evaluate, workbox: Workbox) {
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[1],
      )
    },
    [proposal, MarkdownEditorViewType] as [string, string],
  )
  await visibleFrame(workbox)
    .locator('.vditor')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(visibleFrame(workbox), (s) => s.routerReady, {
    message: 'scoping-proposal preopen readiness',
    timeout: 60_000,
  })
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[1],
      )
    },
    [main, MarkdownEditorViewType] as [string, string],
  )
}

const TARGET = 'Point fourteen TARGET674'

async function expectLanded(
  frame: Frame,
  needle: string,
  check: (state: LineState) => boolean,
  message: string,
): Promise<LineState> {
  let last: LineState | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await lineState(frame, needle)
          return check(last)
        },
        { timeout: 30_000, message },
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`${message} failed; last=${JSON.stringify(last)}; ${error}`)
  }
  expect(last!.revealErrors).toEqual([])
  return last!
}

// Edit modes: the line is on screen and the caret sits right before its text.
const caretBefore = (text: string) => (s: LineState) =>
  s.editInView === true && s.afterCaret.startsWith(text)
const rangeFrom = (first: string, last: string) => (s: LineState) =>
  s.editInView === true &&
  s.afterCaret.startsWith(first) &&
  s.selected.startsWith(first) &&
  s.selected.includes(last)

async function editModeCases(
  evaluate: Evaluate,
  workbox: Workbox,
  mode: 'ir' | 'wysiwyg',
): Promise<void> {
  const disk = readFileSync(proposal, 'utf8')

  await test.step(`${mode}: Owner case, other file not open, line 674`, async () => {
    const frame = await openMain(evaluate, workbox, mode)
    await ctrlClick(frame, mode, 'point14')
    await expect
      .poll(() => readActive(evaluate), { timeout: 15_000 })
      .toEqual({ fsPath: proposal, viewType: MarkdownEditorViewType })
    const target = visibleFrame(workbox)
    const state = await expectLanded(
      target,
      'TARGET674',
      caretBefore(TARGET),
      'line 674',
    )
    expect(state.mode).toBe(mode)
    // Acceptance "the jump does not change the document, dirty state or Undo history".
    expect(await documentState(evaluate, proposal)).toEqual({
      text: disk,
      dirty: false,
    })
  })

  await test.step(`${mode}: other file, range #L674-L676 selects its lines`, async () => {
    const frame = await openMain(evaluate, workbox, mode)
    await ctrlClick(frame, mode, 'range')
    await expect
      .poll(async () => (await readActive(evaluate)).fsPath, {
        timeout: 15_000,
      })
      .toBe(proposal)
    await expectLanded(
      visibleFrame(workbox),
      'TARGET674',
      rangeFrom(TARGET, 'Point 15 of the closing list'),
      'range 674-676',
    )
  })

  await test.step(`${mode}: other file already open`, async () => {
    const frame = await openMain(evaluate, workbox, mode)
    await preopenProposal(evaluate, workbox)
    await waitForE2EReadiness(frame, (s) => s.routerReady, {
      message: 'main back in front',
    })
    await ctrlClick(frame, mode, 'point14')
    await expect
      .poll(async () => (await readActive(evaluate)).fsPath, {
        timeout: 15_000,
      })
      .toBe(proposal)
    await expectLanded(
      visibleFrame(workbox),
      'TARGET674',
      caretBefore(TARGET),
      'open target',
    )
  })

  await test.step(`${mode}: same document #L120 and #L120-L121`, async () => {
    const frame = await openMain(evaluate, workbox, mode)
    await waitForInitialUndoSnapshot(frame)
    const before = {
      doc: await documentState(evaluate, main),
      undo: await undoDepth(frame),
    }
    await ctrlClick(frame, mode, 'self')
    await expectLanded(
      frame,
      'SELF120',
      caretBefore('SELF120'),
      'same-document line',
    )
    await ctrlClick(frame, mode, 'selfRange')
    await expectLanded(
      frame,
      'SELF120',
      rangeFrom('SELF120', 'SELF121'),
      'same-document range',
    )
    expect(await readActive(evaluate)).toEqual({
      fsPath: main,
      viewType: MarkdownEditorViewType,
    })
    expect(await documentState(evaluate, main)).toEqual(before.doc)
    expect(before.doc.dirty).toBe(false)
    expect(await undoDepth(frame)).toBe(before.undo)
  })
}

test('IR: #L links reach the line in another file and the same document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  expectFixtureLines()
  await withDefaultMode(evaluateInVSCode, 'ir', async () => {
    await editModeCases(evaluateInVSCode, workbox, 'ir')

    // Task 635 precedence: `<a id="L7">` owns `#L7`, so the link reaches that id (line 81), not
    // line 7.
    await test.step('ir: an HTML id named like the fragment wins over the line', async () => {
      const frame = await openMain(evaluateInVSCode, workbox, 'ir')
      expect((await lineState(frame, 'HTMLID_TARGET')).editInView).toBe(false)
      await ctrlClick(frame, 'ir', 'idWins')
      await expectLanded(
        frame,
        'HTMLID_TARGET',
        (s) => s.editInView === true,
        'id target',
      )
      // Line 7 (the selflink link) scrolled off the top: the line location did not win.
      expect((await lineState(frame, 'selflink')).editInView).toBe(false)
    })
  })
})

test('WYSIWYG: #L links reach the line in another file and the same document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  await withDefaultMode(evaluateInVSCode, 'wysiwyg', () =>
    editModeCases(evaluateInVSCode, workbox, 'wysiwyg'),
  )
})

// Split: the caret lands at the start of the source line ("14. Point fourteen …"), the source pane
// shows it, and the preview pane (driven by the split scroll sync) shows the rendered item.
test('Split: #L links from the source and preview panes reach the line in both panes', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  await withDefaultMode(evaluateInVSCode, 'sv', () =>
    splitCases(evaluateInVSCode, workbox),
  )
})

async function splitCases(evaluateInVSCode: Evaluate, workbox: Workbox) {
  const inBothPanes = (source: string) => (s: LineState) =>
    s.mode === 'sv' &&
    s.editInView === true &&
    s.previewInView === true &&
    s.afterCaret.startsWith(source)
  for (const surface of ['sv', 'svpreview'] as const) {
    await test.step(`${surface}: other file, line 674`, async () => {
      const frame = await openMain(evaluateInVSCode, workbox, 'sv')
      await ctrlClick(frame, surface, 'point14')
      await expect
        .poll(async () => (await readActive(evaluateInVSCode)).fsPath, {
          timeout: 15_000,
        })
        .toBe(proposal)
      await expectLanded(
        visibleFrame(workbox),
        'TARGET674',
        inBothPanes(PROPOSAL[673]),
        `${surface} line 674`,
      )
    })
  }
  await test.step('sv: other file, range selects its source lines', async () => {
    const frame = await openMain(evaluateInVSCode, workbox, 'sv')
    await ctrlClick(frame, 'sv', 'range')
    await expectLanded(
      visibleFrame(workbox),
      'TARGET674',
      (s) =>
        s.afterCaret.startsWith(PROPOSAL[673]) &&
        s.selected.startsWith(PROPOSAL[673]) &&
        s.selected.includes(PROPOSAL[675]),
      'sv range',
    )
  })
  await test.step('sv: same document #L120', async () => {
    const frame = await openMain(evaluateInVSCode, workbox, 'sv')
    await ctrlClick(frame, 'sv', 'self')
    await expectLanded(
      frame,
      'SELF120',
      inBothPanes(MAIN[119]),
      'sv same document',
    )
    expect((await documentState(evaluateInVSCode, main)).dirty).toBe(false)
  })
}

// Preview: a link clicked in Preview opens the target in Preview (no edit view is built) and the
// rendered block holding the line scrolls into view; a same-document link scrolls the same way.
test('Preview: #L links reach the rendered block in another file and the same document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  await withDefaultMode(evaluateInVSCode, 'preview', async () => {
    const shown = (s: LineState) => s.previewShown && s.previewInView === true
    await test.step('preview: other file not open, line 674', async () => {
      const frame = await openMain(evaluateInVSCode, workbox, 'preview')
      await ctrlClick(frame, 'preview', 'point14')
      await expect
        .poll(async () => (await readActive(evaluateInVSCode)).fsPath, {
          timeout: 15_000,
        })
        .toBe(proposal)
      await expectLanded(
        visibleFrame(workbox),
        'TARGET674',
        shown,
        'preview line 674',
      )
    })
    await test.step('preview: other file already open', async () => {
      const frame = await openMain(evaluateInVSCode, workbox, 'preview')
      await preopenProposal(evaluateInVSCode, workbox)
      await waitForE2EReadiness(frame, (s) => s.routerReady, {
        message: 'main back in front',
      })
      await enterMode(frame, 'preview')
      await ctrlClick(frame, 'preview', 'point14')
      await expect
        .poll(async () => (await readActive(evaluateInVSCode)).fsPath, {
          timeout: 15_000,
        })
        .toBe(proposal)
      await expectLanded(
        visibleFrame(workbox),
        'TARGET674',
        shown,
        'preview open target',
      )
    })
    await test.step('preview: same document #L120', async () => {
      const frame = await openMain(evaluateInVSCode, workbox, 'preview')
      expect((await lineState(frame, 'SELF120')).previewInView).toBe(false)
      await ctrlClick(frame, 'preview', 'self')
      await expectLanded(frame, 'SELF120', shown, 'preview same document')
      expect((await documentState(evaluateInVSCode, main)).dirty).toBe(false)
    })
  })
})
