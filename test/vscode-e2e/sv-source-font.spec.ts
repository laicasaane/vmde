import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { ExtensionId, waitForE2EReadiness, wf } from './webview-helpers'

// Task 634 — `vmde.editor.sourceFontFamily` styles the Split View (SV) source panel only. The
// contract is checked through the real webview and the real configuration pipeline: a setting
// change reaches an already-open editor live (no reopen), VS Code's own `editor.fontFamily` never
// reaches the panel, and the preview pane keeps its content font. Three `!important` rules compete
// for the panel's font-family (plain, `auto` content theme, named content theme), so the live
// checks run in `auto` and in a named theme.
const FIXTURE = path.join(__dirname, 'fixtures', 'font-parity.md')

const DEFAULT_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
const CUSTOM = '"Fira Code", "Cascadia Mono", Consolas'
const EDITOR_FONT = '"Courier New", Georgia'
// Sanitisation (contract): `:;<>{}` and newlines are replaced by spaces before the value is used.
const HOSTILE =
  'Evil;} body{display:none} </style><script>window.__svFontPwn=1</script>'
// Colon and semicolon only: after sanitising it is a plain list of family names.
const COLON_VALUE = 'Evil Mono; display:none'

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const global = vscode.ConfigurationTarget.Global
    await vscode.workspace
      .getConfiguration('editor')
      .update('fontFamily', undefined, global)
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update('theme.content', undefined, global)
    await config.update('editor.sourceFontFamily', undefined, global)
  })
})

type Settings = {
  sourceFontFamily?: string | null
  editorFontFamily?: string | null
  contentTheme?: string | null
}

// `null` clears the key (back to its default); an absent key leaves it alone. The evaluator cannot
// carry `null` across the process boundary, so the settings travel as one JSON string.
async function applySettings(
  evaluateInVSCode: <A extends unknown[]>(
    fn: (vscode: typeof import('vscode'), args: A) => Promise<unknown>,
    args: A,
  ) => Promise<unknown>,
  settings: Settings,
) {
  await evaluateInVSCode(
    async (vscode, args) => {
      const s = JSON.parse((args as [string])[0]) as Settings
      const global = vscode.ConfigurationTarget.Global
      const value = (v: string | null) => (v === null ? undefined : v)
      if (s.editorFontFamily !== undefined)
        await vscode.workspace
          .getConfiguration('editor')
          .update('fontFamily', value(s.editorFontFamily), global)
      const vmde = vscode.workspace.getConfiguration('vmde')
      if (s.contentTheme !== undefined)
        await vmde.update('theme.content', value(s.contentTheme), global)
      if (s.sourceFontFamily !== undefined)
        await vmde.update(
          'editor.sourceFontFamily',
          value(s.sourceFontFamily),
          global,
        )
    },
    [JSON.stringify(settings)] as [string],
  )
}

async function openInSplitView(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Parameters<typeof applySettings>[0],
) {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri, extensionId] = args as [string, string]
      await vscode.extensions.getExtension(extensionId)?.activate()
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE, ExtensionId] as [string, string],
  )
  const frame = wf(workbox)
  await frame.locator('body').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode !== null,
    { message: 'Task 634 editor readiness', timeout: 60_000 },
  )
  const mode = await frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeE2EReadiness?: { mode: string | null }
        }
      ).__vmdeE2EReadiness?.mode,
  )
  if (mode !== 'sv') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="sv"]').click()
  }
  await frame.locator('.vditor-sv').waitFor({ timeout: 30_000 })
  await frame.locator('.vditor-preview').first().waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'Task 634 split-view readiness',
  })
  return frame
}

const readFamilies = (frame: ReturnType<typeof wf>) =>
  frame.locator('body').evaluate(() => {
    const family = (selector: string) => {
      const el = document.querySelector(selector)
      return el ? getComputedStyle(el).fontFamily : null
    }
    return {
      source: family('.vditor-sv'),
      preview: family('.vditor-preview .vditor-reset'),
      editorVar: getComputedStyle(document.documentElement)
        .getPropertyValue('--vscode-editor-font-family')
        .trim(),
      bodyVar: document.body.style
        .getPropertyValue('--me-source-font-family')
        .trim(),
    }
  })

for (const contentTheme of ['auto', 'github-dark']) {
  test(`split view source font: default, live custom value, editor font isolation, clear (${contentTheme})`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    await applySettings(evaluateInVSCode, {
      contentTheme,
      sourceFontFamily: null,
      editorFontFamily: null,
    })
    const frame = await openInSplitView(workbox, evaluateInVSCode)

    // Default: the panel resolves the default stack (the CSS appends a generic `monospace`).
    await expect
      .poll(
        async () =>
          (await readFamilies(frame)).source?.startsWith(DEFAULT_STACK),
        { message: 'default source family', timeout: 20_000 },
      )
      .toBe(true)
    const initial = await readFamilies(frame)
    expect(initial.source?.endsWith('monospace')).toBe(true)
    expect(initial.source?.startsWith(DEFAULT_STACK)).toBe(true)
    expect(initial.preview).toBeTruthy()
    expect(initial.preview).not.toContain('ui-monospace')

    // Custom value, applied live to the already-open editor (no reopen).
    await applySettings(evaluateInVSCode, { sourceFontFamily: CUSTOM })
    await expect
      .poll(
        async () => (await readFamilies(frame)).source?.startsWith(CUSTOM),
        {
          message: 'custom source family applied live',
          timeout: 20_000,
        },
      )
      .toBe(true)
    const custom = await readFamilies(frame)
    expect(custom.source?.endsWith('monospace')).toBe(true)
    expect(custom.bodyVar).toBe(CUSTOM)
    // The preview pane keeps its content font (control: the source panel did change above).
    expect(custom.preview).toBe(initial.preview)

    // VS Code's editor font reaches the page (positive control) but not the source panel.
    await applySettings(evaluateInVSCode, { editorFontFamily: EDITOR_FONT })
    await expect
      .poll(async () => (await readFamilies(frame)).editorVar, {
        message: 'editor.fontFamily reaches the webview',
        timeout: 20_000,
      })
      .toContain('Courier New')
    const afterEditorFont = await readFamilies(frame)
    expect(afterEditorFont.source).toBe(custom.source)
    expect(afterEditorFont.source).not.toContain('Courier New')
    expect(afterEditorFont.preview).toBe(initial.preview)

    // Clearing the setting restores the default, live.
    await applySettings(evaluateInVSCode, { sourceFontFamily: null })
    await expect
      .poll(
        async () =>
          (await readFamilies(frame)).source?.startsWith(DEFAULT_STACK),
        { message: 'cleared source family restores default', timeout: 20_000 },
      )
      .toBe(true)
    const cleared = await readFamilies(frame)
    expect(cleared.source).toBe(initial.source)
    expect(cleared.preview).toBe(initial.preview)
  })
}

test('split view source font: a hostile value leaves the page intact', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  await applySettings(evaluateInVSCode, {
    contentTheme: null,
    sourceFontFamily: null,
    editorFontFamily: null,
  })
  const frame = await openInSplitView(workbox, evaluateInVSCode)
  const before = await readFamilies(frame)

  await applySettings(evaluateInVSCode, { sourceFontFamily: HOSTILE })
  await expect
    .poll(async () => (await readFamilies(frame)).bodyVar, {
      message: 'hostile value reached the webview',
      timeout: 20_000,
    })
    .toContain('Evil')

  const after = await frame.locator('body').evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement | null
    const rect = sv?.getBoundingClientRect()
    return {
      bodyVar: document.body.style.getPropertyValue('--me-source-font-family'),
      injected: (window as unknown as { __svFontPwn?: number }).__svFontPwn,
      bodyDisplay: getComputedStyle(document.body).display,
      svDisplay: sv ? getComputedStyle(sv).display : null,
      svVisible: !!rect && rect.width > 0 && rect.height > 0,
      family: sv ? getComputedStyle(sv).fontFamily : null,
      text: sv?.textContent ?? '',
    }
  })
  expect(after.injected).toBeUndefined()
  expect(after.bodyDisplay).not.toBe('none')
  expect(after.svDisplay).not.toBe('none')
  expect(after.svVisible).toBe(true)
  // Sanitised value: none of the stripped characters survive in the variable.
  expect(after.bodyVar).not.toMatch(/[:;<>{}\r\n]/)
  // The computed family stays a non-empty, serialisable font list. It is not asserted to be
  // monospace here: markup breakers leave characters (`/`, `.`, `=`) that are not valid in an
  // unquoted family name, so the browser drops the declaration and the panel inherits.
  expect(after.family).toBeTruthy()
  expect(after.text.length).toBeGreaterThan(0)
  expect(await frame.locator('.vditor-sv').count()).toBe(1)
  expect(await frame.locator('.vditor-preview').count()).toBeGreaterThan(0)

  // A value that sanitises to valid family names (colon and semicolon become spaces) keeps the
  // panel on its monospace fallback.
  await applySettings(evaluateInVSCode, { sourceFontFamily: COLON_VALUE })
  await expect
    .poll(async () => (await readFamilies(frame)).source, {
      message: 'colon value applied',
      timeout: 20_000,
    })
    .toContain('Evil')
  const colon = await readFamilies(frame)
  expect(colon.bodyVar).not.toMatch(/[:;]/)
  expect(colon.source?.endsWith('monospace')).toBe(true)

  // Recovery: a valid value applies again on the same page, then the default returns.
  await applySettings(evaluateInVSCode, { sourceFontFamily: CUSTOM })
  await expect
    .poll(async () => (await readFamilies(frame)).source?.startsWith(CUSTOM), {
      message: 'valid value applies after the hostile one',
      timeout: 20_000,
    })
    .toBe(true)
  await applySettings(evaluateInVSCode, { sourceFontFamily: null })
  await expect
    .poll(
      async () => (await readFamilies(frame)).source?.startsWith(DEFAULT_STACK),
      { message: 'default restored', timeout: 20_000 },
    )
    .toBe(true)
  expect((await readFamilies(frame)).source).toBe(before.source)
})
