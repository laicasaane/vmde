import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 207 — the YAML front-matter properties table in the real VS Code webview. This also covers
// the real lazy-bundle load path (`front-matter-main.js` via loadScript) and the host clipboard
// route (`copy-property`) that the Chromium harness replaces with a direct import. Real mouse and
// keyboard input; the host clipboard and the host/disk bytes are read back, nothing is read from
// the code under test beyond DOM state.

const FIXTURES = path.join(__dirname, 'fixtures')
const GOOD = readFileSync(path.join(FIXTURES, 'front-matter-table.md'), 'utf8')
const MALFORMED = readFileSync(
  path.join(FIXTURES, 'front-matter-malformed.md'),
  'utf8',
)
const TOML = '+++\ntitle = "x"\n+++\n\n# Heading\n\nParagraph below.\n'
const SENTINEL = 'task-207-sentinel'
const TABLE = '.vmde-front-matter'

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: unknown[]) => Promise<unknown>

async function openContent(
  evaluateInVSCode: Evaluate,
  workbox: Page,
  baseDir: string,
  name: string,
  content: string,
  mode: Mode,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, content)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
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
    { message: 'front matter IR readiness' },
  )
  await waitForInitialUndoSnapshot(frame)
  if (mode !== 'ir') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: `front matter ${mode} readiness`,
    })
    await waitForInitialUndoSnapshot(frame)
  }
  return { frame, file }
}

const hostState = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', dirty: doc?.isDirty ?? false }
    },
    [file],
  ) as Promise<{ text: string; dirty: boolean }>

const readClipboard = (evaluateInVSCode: Evaluate) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode')) => vscode.env.clipboard.readText(),
    [],
  ) as Promise<string>

/** Caret, expand flags, YAML source text and Undo depth of the active edit mode. */
const webviewState = (frame: Frame, mode: Mode) =>
  frame.locator('body').evaluate((_body, editorMode) => {
    const selection = window.getSelection()
    const describe = (node: Node | null) =>
      node
        ? `${node.nodeName}:${(node.textContent ?? '').slice(0, 30)}`
        : 'none'
    const root = document.querySelector(`.vditor-${editorMode}`)
    const inner = (
      window as unknown as {
        vditor: {
          vditor: {
            currentMode: string
            undo: Record<string, { undoStack: unknown[] }>
          }
        }
      }
    ).vditor.vditor
    return {
      selection: JSON.stringify([
        describe(selection?.anchorNode ?? null),
        selection?.anchorOffset,
        describe(selection?.focusNode ?? null),
        selection?.focusOffset,
      ]),
      expanded: root?.querySelectorAll('.vditor-ir__node--expand').length ?? 0,
      yaml: root?.querySelector('code[data-type="yaml-front-matter"]')
        ?.textContent,
      undo: (globalThis as any).__vmdeUnitHistory?.holds(inner)
        ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
        : inner.undo[inner.currentMode].undoStack.length,
    }
  }, mode)

/** What the front-matter block shows right now (IR / WYSIWYG). */
const blockView = (frame: Frame, mode: Mode) =>
  frame.locator('body').evaluate((_body, editorMode) => {
    const block = document.querySelector(
      `.vditor-${editorMode} div[data-type="yaml-front-matter"]`,
    ) as HTMLElement
    const shown = (el: Element | null) =>
      !!el &&
      getComputedStyle(el).display !== 'none' &&
      el.getBoundingClientRect().height > 0
    const sel = window.getSelection()
    const a = sel?.rangeCount ? sel.anchorNode : null
    const host = a
      ? a.nodeType === 1
        ? (a as Element)
        : a.parentElement
      : null
    return {
      source: shown(block.querySelector(':scope > pre')),
      table: shown(block.querySelector(':scope > .vmde-front-matter')),
      caretInSource: !!host?.closest('code[data-type="yaml-front-matter"]'),
    }
  }, mode)

async function placeCaretInParagraph(frame: Frame, mode: Mode) {
  await frame
    .locator(`.vditor-${mode} p`)
    .filter({ hasText: 'Paragraph below.' })
    .click()
  await expect
    .poll(async () => (await webviewState(frame, mode)).selection)
    .toContain('Paragraph below.')
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
}

/** Task 725: the caret enters the front matter from the heading below it, by keyboard. */
async function enterSourceFromHeading(frame: Frame, mode: Mode, workbox: Page) {
  await frame
    .locator(`.vditor-${mode} h1`)
    .filter({ hasText: 'Heading' })
    .click()
  await workbox.keyboard.press('Home')
  await workbox.keyboard.press('ArrowUp')
}

async function armCopy(evaluateInVSCode: Evaluate) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [SENTINEL],
  )
}

async function expectClipboard(evaluateInVSCode: Evaluate, expected: string) {
  await expect
    .poll(() => readClipboard(evaluateInVSCode), {
      timeout: 15_000,
      intervals: [100, 250, 500],
    })
    .toBe(expected)
}

async function waitForTable(frame: Frame, scope: string) {
  await expect(frame.locator(`${scope} ${TABLE}`).first()).toBeVisible({
    timeout: 30_000,
  })
}

const rowTexts = (frame: Frame, scope: string) =>
  frame
    .locator(`${scope} ${TABLE}`)
    .first()
    .evaluate((table) =>
      [...table.querySelectorAll('tr.vmde-front-matter__row')].map(
        (row) =>
          `${row.querySelector('th .vmde-front-matter__content')?.textContent}=${
            row.querySelector('td .vmde-front-matter__content')?.textContent
          }`,
      ),
    )

test('IR: table, caret entry, copy buttons that keep the caret, and unchanged saved bytes', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-ir.md',
    GOOD,
    'ir',
  )
  await waitForTable(frame, '.vditor-ir')
  expect(await rowTexts(frame, '.vditor-ir')).toEqual([
    'title=Hello',
    'tags=ab',
    'author=name' + 'Ann',
    'summary=line one\nline two',
  ])
  expect(
    await frame.locator('.vditor-ir .vmde-front-matter__chip').count(),
  ).toBe(2)
  expect(
    await frame.locator('.vditor-ir .vmde-front-matter__inner').count(),
  ).toBe(1)
  expect(await blockView(frame, 'ir')).toMatchObject({
    source: false,
    table: true,
  })

  // Copy buttons with the caret elsewhere: nothing moves (D1), the host clipboard gets the text.
  await placeCaretInParagraph(frame, 'ir')
  const before = {
    web: await webviewState(frame, 'ir'),
    host: await hostState(evaluate, file),
  }
  expect(before.host.dirty).toBe(false)
  const copyButtons = frame.locator('.vditor-ir .vmde-front-matter__copy')
  const cases: [number, string][] = [
    [0, 'title'], // key cell of row 1
    [1, 'Hello'], // value cell of row 1
    [3, '[a, b]'], // list value
    [5, 'name: Ann'], // map value
  ]
  for (const [index, expected] of cases) {
    await armCopy(evaluate)
    await copyButtons.nth(index).click()
    await expectClipboard(evaluate, expected)
  }
  // The checkmark shows right after a click and restores.
  await copyButtons.nth(1).click()
  await expect(copyButtons.nth(1)).toHaveAttribute('data-copied', '')
  await expect(copyButtons.nth(1)).not.toHaveAttribute('data-copied', '', {
    timeout: 5_000,
  })
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)))
  const after = {
    web: await webviewState(frame, 'ir'),
    host: await hostState(evaluate, file),
  }
  expect(after.web.expanded, 'no block expanded').toBe(0)
  expect(after.web.selection, 'caret unchanged').toBe(before.web.selection)
  expect(after.web.undo, 'Undo depth unchanged').toBe(before.web.undo)
  expect(after.host).toEqual(before.host)

  // Caret entry shows the YAML source; leaving shows the table again. Task 725: a click on a cell
  // opens its cell editor, so the caret enters from the next block (ArrowUp from the heading).
  await enterSourceFromHeading(frame, 'ir', workbox)
  await expect
    .poll(() => blockView(frame, 'ir'))
    .toEqual({ source: true, table: false, caretInSource: true })
  await placeCaretInParagraph(frame, 'ir')
  await expect
    .poll(() => blockView(frame, 'ir'))
    .toMatchObject({ source: false, table: true })

  // An edit elsewhere leaves the front-matter bytes on disk untouched.
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Paragraph below.' })
    .click()
  await workbox.keyboard.press('End')
  await workbox.keyboard.type('X')
  // Lute drops the blank line after the closing `---` on every edit, with or without a table (the
  // empty-front-matter control shows the same), so the pre-existing write-back is pinned as it is:
  // the front-matter block itself is byte-identical, the body changed only by the typed character.
  const frontMatter = GOOD.slice(0, GOOD.indexOf('---\n\n') + 4)
  const expectedDisk = `${frontMatter}# Heading\n\nParagraph below.X\n`
  await expect
    .poll(async () => (await hostState(evaluate, file)).text, {
      timeout: 15_000,
    })
    .toBe(expectedDisk)
  await evaluate(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [])
  await expect
    .poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 })
    .toBe(expectedDisk)
})

test('WYSIWYG: table replaces the source until the caret enters; copy keeps the caret', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-wysiwyg.md',
    GOOD,
    'wysiwyg',
  )
  // Switching to WYSIWYG leaves the caret at the document start, inside the front matter, so the
  // YAML source shows (D1). No table exists until the caret has left the block.
  await expect(
    frame.locator('.vditor-wysiwyg div[data-type="yaml-front-matter"]'),
  ).toBeAttached({ timeout: 30_000 })
  await placeCaretInParagraph(frame, 'wysiwyg')
  await waitForTable(frame, '.vditor-wysiwyg')
  expect((await rowTexts(frame, '.vditor-wysiwyg'))[0]).toBe('title=Hello')
  expect(await blockView(frame, 'wysiwyg')).toMatchObject({
    source: false,
    table: true,
  })

  const before = {
    web: await webviewState(frame, 'wysiwyg'),
    host: await hostState(evaluate, file),
  }
  await armCopy(evaluate)
  await frame.locator('.vditor-wysiwyg .vmde-front-matter__copy').nth(1).click()
  await expectClipboard(evaluate, 'Hello')
  expect((await webviewState(frame, 'wysiwyg')).selection).toBe(
    before.web.selection,
  )
  expect(await hostState(evaluate, file)).toEqual(before.host)
  expect(await blockView(frame, 'wysiwyg')).toMatchObject({
    source: false,
    table: true,
  })

  await enterSourceFromHeading(frame, 'wysiwyg', workbox)
  await expect
    .poll(() => blockView(frame, 'wysiwyg'))
    .toEqual({ source: true, table: false, caretInSource: true })
  await placeCaretInParagraph(frame, 'wysiwyg')
  await expect
    .poll(() => blockView(frame, 'wysiwyg'))
    .toMatchObject({ source: false, table: true })
})

test('Split preview: the preview pane shows the table and its copy buttons copy', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-split.md',
    GOOD,
    'sv',
  )
  await waitForTable(frame, '.vditor-preview')
  expect((await rowTexts(frame, '.vditor-preview'))[0]).toBe('title=Hello')
  // The YAML code block of the preview pane is hidden behind the table.
  await expect(
    frame.locator('.vditor-preview pre.vditor-yml-front-matter'),
  ).toBeHidden()
  await armCopy(evaluate)
  await frame.locator('.vditor-preview .vmde-front-matter__copy').nth(3).click()
  await expectClipboard(evaluate, '[a, b]')
  const host = await hostState(evaluate, file)
  expect(host).toEqual({ text: GOOD, dirty: false })
})

test('Preview: the full Preview shows the table', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-preview.md',
    GOOD,
    'ir',
  )
  await waitForTable(frame, '.vditor-ir')
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await waitForTable(frame, '.vditor-preview')
  expect(await rowTexts(frame, '.vditor-preview')).toEqual([
    'title=Hello',
    'tags=ab',
    'author=name' + 'Ann',
    'summary=line one\nline two',
  ])
  await armCopy(evaluate)
  await frame.locator('.vditor-preview .vmde-front-matter__copy').nth(1).click()
  await expectClipboard(evaluate, 'Hello')
})

test('Malformed YAML keeps the code block and shows the exact warning', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-bad.md',
    MALFORMED,
    'ir',
  )
  const warning = frame.locator('.vditor-ir .vmde-front-matter__warning')
  await expect(warning).toBeVisible({ timeout: 30_000 })
  await expect(warning).toHaveText(
    // Task 725 D2: duplicate keys are editable rows now; this fixture stays malformed for any reason.
    'Front matter could not be parsed: Nested mappings are not allowed in compact mappings (line 2, column 4)',
  )
  expect(await frame.locator(`.vditor-ir ${TABLE}`).count()).toBe(0)
  expect(await blockView(frame, 'ir')).toMatchObject({
    source: true,
    table: false,
  })
  expect((await hostState(evaluate, file)).text).toBe(MALFORMED)
})

test('TOML front matter keeps its paragraph and gets the warning inside it', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { frame, file } = await openContent(
    evaluate,
    workbox,
    baseDir,
    'fm-toml.md',
    TOML,
    'ir',
  )
  const warning = frame.locator(
    '.vditor-ir p .vmde-front-matter__warning--toml',
  )
  await expect(warning).toBeVisible({ timeout: 30_000 })
  await expect(warning).toHaveText(
    'Front matter could not be parsed: TOML front matter is not supported',
  )
  expect(await frame.locator(`.vditor-ir ${TABLE}`).count()).toBe(0)
  const host = await hostState(evaluate, file)
  expect(host).toEqual({ text: TOML, dirty: false })
})
