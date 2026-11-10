import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  type Frame,
  readGeometry,
  type TableGeometry,
} from './helpers/front-matter-geometry'
import {
  ExtensionId,
  MarkdownEditorViewType,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 723 — the front-matter properties table is compact and fits its content, and two settings
// change its font. Real VS Code webview, real configuration pipeline, geometry read with
// getBoundingClientRect (CSS pixels). Contract (Owner decision D1):
//  - row height = the text line box for the table's font size and family + 4 px padding above and
//    below, within 1 px (the one shared 1 px border between rows is inside that tolerance);
//  - name column = longest property name + copy button + a 4 px gap (+ 8 px left padding and the
//    button's 4 px inset from the cell edge), tolerance 2 px; value column fills the rest; in IR and
//    WYSIWYG the left padding is 24 px, because the name cell holds the Task 728 drag handle;
//  - `vmde.editor.frontMatterFontSize` / `vmde.editor.frontMatterFontFamily` apply live, to the
//    table only; copy buttons keep working and the saved Markdown is unchanged.
// Single-line rows only are compared for height: in the narrow Split View pane a long value wraps.

const DOC = `---
created: 2026-10-30
family_id: 1793376508
family_name: rebrand
state: sealed
sealed: 2026-11-08
archive_note: Owner reviewed the family on 2026-11-08 (D80) and the sealed copy follows
---

# Heading

Paragraph below.
`
const THEMES = [
  'auto',
  'github-light',
  'github-dark',
  'material-dark',
  'vscode-light-2026',
  'vscode-dark-2026',
] as const
const MODES = [
  { mode: 'ir', scope: '.vditor-ir', paragraph: '.vditor-ir p' },
  { mode: 'wysiwyg', scope: '.vditor-wysiwyg', paragraph: '.vditor-wysiwyg p' },
  { mode: 'sv', scope: '.vditor-preview', paragraph: '.vditor-preview p' },
  {
    mode: 'preview',
    scope: '.vditor-preview',
    paragraph: '.vditor-preview p',
  },
] as const
type ModeDef = (typeof MODES)[number]

// Contract numbers (CSS px).
const PAD = 4 // vertical cell padding
const GAP = 4 // name text to copy button
const LEFT_PAD = 8
// Task 728: in IR and WYSIWYG the name cell holds the drag handle (4 px inset + 16 px + 4 px gap).
const EDIT_LEFT_PAD = 24
const leftPadOf = (mode: string) =>
  mode === 'ir' || mode === 'wysiwyg' ? EDIT_LEFT_PAD : LEFT_PAD
const INSET = 4 // copy button to the cell's right edge
const LINE_RATIO = 1.5 // the table's own line-height, unitless
const CUSTOM_SIZE = 20
const CUSTOM_FAMILY = '"Courier New", monospace'
const SENTINEL = 'task-723-sentinel'

type Evaluate = (fn: unknown, args: unknown[]) => Promise<unknown>
type Page = import('@playwright/test').Page

test.afterEach(async ({ evaluateInVSCode }) => {
  await setVmde(evaluateInVSCode as Evaluate, {
    'theme.content': null,
    'editor.frontMatterFontSize': null,
    'editor.frontMatterFontFamily': null,
  })
})

// `null` clears the key. The evaluator cannot carry `null` across the process boundary, so the
// settings travel as one JSON string.
async function setVmde(
  evaluateInVSCode: Evaluate,
  settings: Record<string, string | null>,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const entries = JSON.parse(args[0]) as Record<string, string | null>
      const config = vscode.workspace.getConfiguration('vmde')
      for (const [key, value] of Object.entries(entries))
        await config.update(
          key,
          value === null ? undefined : value,
          vscode.ConfigurationTarget.Global,
        )
    },
    [JSON.stringify(settings)],
  )
}

async function waitForTheme(frame: Frame, theme: string) {
  await expect
    .poll(() =>
      frame.locator('body').evaluate((_body, name) => {
        if (name === 'auto')
          return !document.body.classList.contains('markdown-body')
        const link = document.querySelector<HTMLLinkElement>(`link#ct-${name}`)
        return (
          document.body.classList.contains('markdown-body') &&
          !!link &&
          !link.disabled
        )
      }, theme),
    )
    .toBe(true)
}

async function openDoc(
  evaluateInVSCode: Evaluate,
  workbox: Page,
  baseDir: string,
  name: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, DOC)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      // Sidebar, panel and auxiliary bar closed: the Split View preview pane gets room for a
      // single-line value next to the name column.
      for (const id of [
        'workbench.action.closeSidebar',
        'workbench.action.closePanel',
        'workbench.action.closeAuxiliaryBar',
      ])
        await vscode.commands.executeCommand(id)
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'Task 723 IR readiness' },
  )
  await waitForInitialUndoSnapshot(frame)
  return { frame, file }
}

async function switchMode(frame: Frame, def: ModeDef, from: string) {
  if (def.mode === 'preview') {
    if (from !== 'ir') {
      await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
      await frame.locator('button[data-mode="ir"]').click()
      await waitForE2EReadiness(frame, (state) => state.mode === 'ir')
    }
    await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  } else if (def.mode !== from) {
    if (from === 'preview')
      await frame.locator('.vditor-toolbar [data-type="preview"]').click()
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${def.mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === def.mode)
  }
  if (def.mode === 'ir' || def.mode === 'wysiwyg') {
    // Caret outside the block, so the table (not the YAML source) shows.
    await frame
      .locator(def.paragraph)
      .filter({ hasText: 'Paragraph below.' })
      .click()
    await settle(frame, 600) // caret-leave re-render settles; there is no marker to poll
  }
  await expect(
    frame.locator(`${def.scope} .vmde-front-matter`).first(),
  ).toBeVisible({ timeout: 30_000 })
}

const paragraphFont = (frame: Frame, selector: string) =>
  frame
    .locator(selector)
    .first()
    .evaluate((p) => {
      const cs = getComputedStyle(p)
      return { fontSize: cs.fontSize, fontFamily: cs.fontFamily }
    })

/** The geometry contract, for the table as read in one mode and theme. */
function expectCompactTable(
  g: TableGeometry,
  label: string,
  leftPad = LEFT_PAD,
) {
  const single = g.rows.filter((r) => r.nameLines === 1 && r.valueLines === 1)
  expect(single.length, `${label}: single-line rows`).toBeGreaterThanOrEqual(3)

  // The text line box follows the table font size (line-height 1.5).
  const line = single[0].valueLineH
  expect(line, `${label}: line box vs font size`).toBeCloseTo(
    g.fontSize * LINE_RATIO,
    0,
  )
  for (const r of single) {
    // Row = text line box + PAD above and below; tolerance 1 px (covers the shared row border).
    expect(
      Math.abs(r.rowH - (r.valueLineH + 2 * PAD)),
      `${label}: row height ${r.rowH} for line ${r.valueLineH} (${r.nameText})`,
    ).toBeLessThanOrEqual(1.05)
    expect(r.nameLineH, `${label}: name line box`).toBeCloseTo(r.valueLineH, 0)
    expect(r.cellPadding.top, `${label}: padding top`).toBe(PAD)
    expect(r.cellPadding.bottom, `${label}: padding bottom`).toBe(PAD)
    expect(r.cellPadding.left, `${label}: padding left`).toBe(leftPad)
    // The copy button sits inside the row.
    expect(r.keyButton.h, `${label}: key button height`).toBeLessThanOrEqual(
      r.rowH,
    )
    expect(
      r.valueButton.h,
      `${label}: value button height`,
    ).toBeLessThanOrEqual(r.rowH)
  }
  const heights = single.map((r) => r.rowH)
  expect(
    Math.max(...heights) - Math.min(...heights),
    `${label}: single-line rows share one height`,
  ).toBeLessThanOrEqual(1)

  // Name column = longest name + button + GAP, plus the left padding and the button inset.
  const longest = g.rows.reduce((a, b) => (b.nameTextW > a.nameTextW ? b : a))
  const expectedKeyW =
    g.maxNameTextW + longest.keyButton.w + leftPad + GAP + INSET
  expect(
    Math.abs(longest.keyCellW - expectedKeyW),
    `${label}: name column ${longest.keyCellW} vs ${expectedKeyW}`,
  ).toBeLessThanOrEqual(2)
  expect(
    Math.abs(longest.nameToButtonGap - GAP),
    `${label}: gap after the longest name`,
  ).toBeLessThanOrEqual(1.5)
  // Value column fills the rest of the table width.
  for (const r of g.rows)
    expect(
      Math.abs(r.keyCellW + r.valueCellW - g.tableW),
      `${label}: value column fills the table (${r.nameText})`,
    ).toBeLessThanOrEqual(1.5)
  expect(
    longest.valueCellW,
    `${label}: value column is the wide one`,
  ).toBeGreaterThan(longest.keyCellW)
}

test('default settings: compact rows and a fitted name column in every mode and content theme', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame } = await openDoc(
    evaluate,
    workbox,
    baseDir,
    'fm-size-default.md',
  )
  let from = 'ir'
  for (const def of MODES) {
    await switchMode(frame, def, from)
    from = def.mode
    const paragraph = await paragraphFont(frame, def.paragraph)
    for (const theme of THEMES) {
      await setVmde(evaluate, { 'theme.content': theme })
      await waitForTheme(frame, theme)
      // Same mode and theme: the table follows the editor font (size and family) by default.
      const g = await readGeometry(frame, def.scope)
      const label = `${def.mode}/${theme}`
      const body = await paragraphFont(frame, def.paragraph)
      expect(`${g.fontSize}px`, `${label}: size follows the editor`).toBe(
        body.fontSize,
      )
      expect(g.fontFamily, `${label}: family follows the editor`).toBe(
        body.fontFamily,
      )
      expectCompactTable(g, label, leftPadOf(def.mode))
    }
    expect(paragraph.fontSize).toMatch(/px$/)
  }
})

test('changed size and family apply live to the table only; copy buttons work; saved bytes unchanged', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openDoc(
    evaluate,
    workbox,
    baseDir,
    'fm-size-custom.md',
  )
  const ir = MODES[0]
  await switchMode(frame, ir, 'ir')
  const before = await readGeometry(frame, ir.scope)
  const paragraphBefore = await paragraphFont(frame, ir.paragraph)
  expect(before.fontSize).not.toBe(CUSTOM_SIZE)

  // Live: no reopen. Size first, then family.
  await setVmde(evaluate, { 'editor.frontMatterFontSize': String(CUSTOM_SIZE) })
  await expect
    .poll(async () => (await readGeometry(frame, ir.scope)).fontSize)
    .toBe(CUSTOM_SIZE)
  await setVmde(evaluate, { 'editor.frontMatterFontFamily': CUSTOM_FAMILY })
  await expect
    .poll(async () => (await readGeometry(frame, ir.scope)).fontFamily)
    .toContain('Courier New')

  // Only the table changed: the paragraph keeps its size and family.
  expect(await paragraphFont(frame, ir.paragraph)).toEqual(paragraphBefore)

  let from = 'ir'
  for (const def of MODES) {
    await switchMode(frame, def, from)
    from = def.mode
    const g = await readGeometry(frame, def.scope)
    expect(g.fontSize, `${def.mode}: size`).toBe(CUSTOM_SIZE)
    expect(g.fontFamily, `${def.mode}: family`).toBe(CUSTOM_FAMILY)
    expect(g.lineHeight, `${def.mode}: line height`).toBe(
      `${CUSTOM_SIZE * LINE_RATIO}px`,
    )
    expectCompactTable(g, `${def.mode}/custom`, leftPadOf(def.mode))
  }

  // Back to the default, live, in Preview.
  await setVmde(evaluate, {
    'editor.frontMatterFontSize': null,
    'editor.frontMatterFontFamily': null,
  })
  await expect
    .poll(async () => (await readGeometry(frame, '.vditor-preview')).fontSize)
    .not.toBe(CUSTOM_SIZE)
  const restored = await readGeometry(frame, '.vditor-preview')
  expect(restored.fontFamily).not.toContain('Courier New')
  expectCompactTable(restored, 'preview/restored')

  // Copy buttons still copy, and the document bytes are untouched. Custom font again, in IR.
  await setVmde(evaluate, { 'editor.frontMatterFontSize': String(CUSTOM_SIZE) })
  await switchMode(frame, ir, 'preview')
  await expect
    .poll(async () => (await readGeometry(frame, ir.scope)).fontSize)
    .toBe(CUSTOM_SIZE)
  const copy = frame.locator(`${ir.scope} .vmde-front-matter__copy`)
  const clipboard = () =>
    evaluate(
      async (vscode: typeof import('vscode')) =>
        vscode.env.clipboard.readText(),
      [],
    ) as Promise<string>
  for (const [index, expected] of [
    [0, 'created'],
    [1, '2026-10-30'],
    [2, 'family_id'],
  ] as const) {
    await evaluate(
      async (vscode: typeof import('vscode'), args: [string]) => {
        await vscode.env.clipboard.writeText(args[0])
      },
      [SENTINEL],
    )
    await copy.nth(index).click()
    await expect.poll(clipboard, { timeout: 15_000 }).toBe(expected)
  }
  const host = (await evaluate(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', dirty: doc?.isDirty ?? false }
    },
    [file],
  )) as { text: string; dirty: boolean }
  expect(host).toEqual({ text: DOC, dirty: false })
  expect(readFileSync(file, 'utf8')).toBe(DOC)
})
