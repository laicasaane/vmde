import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { settle, wf } from './webview-helpers'

// Task 654 — inline raw HTML `<a href>` is shown as an underlined link in IR and WYSIWYG while the
// saved Markdown stays byte-identical. Real webview: VS Code's injected `a` colour, the content
// themes and the custom-editor pipeline are only present here, not in the Chromium harness.

const dir = path.join(tmpdir(), `vmde-html-link-${process.pid}`)
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'target.md'), '# Target\n')
const main = path.join(dir, 'main.md')
const LINK_LINES = [
  'Plain <a href="./target.md">targetlink</a> end.',
  'Other <a class="x" href="https://example.com/o?a=1&amp;b=2">otherlink</a> end.',
]
const ORIGINAL = [
  '# HTML links',
  '',
  LINK_LINES[0],
  '',
  'Md [mdlink](https://example.com/md) end.',
  '',
  'Edit paragraph here.',
  '',
  LINK_LINES[1],
  '',
].join('\n')
writeFileSync(main, ORIGINAL)

test.use({ baseDir: dir })

type Evaluate = (fn: unknown, args: [string]) => Promise<unknown>

async function setContentTheme(evaluateInVSCode: Evaluate, theme: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('theme.content', args[0], vscode.ConfigurationTarget.Global)
    },
    [theme] as [string],
  )
}

async function openMain(
  evaluateInVSCode: Evaluate,
  editorSelector: string,
  workbox: import('@playwright/test').Page,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [main] as [string],
  )
  const frame = wf(workbox)
  await frame.locator(editorSelector).first().waitFor({ timeout: 60_000 })
  // Retained: clicking the mode control right after boot is the lost-click family.
  await settle(frame, 1500)
  return frame
}

async function switchToWysiwyg(frame: ReturnType<typeof wf>) {
  await frame.locator('body').evaluate(() => {
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
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 30_000 })
}

// Rest look of the first decorated link and of the Markdown reference link in the same pane.
function measure(
  frame: ReturnType<typeof wf>,
  pane: string,
  reference: string,
) {
  return frame.locator('body').evaluate(
    (_el, args) => {
      const [paneSel, refSel] = args as [string, string]
      const root = document.querySelector(paneSel)!
      const link = root.querySelector(
        'span.vmde-html-link',
      ) as HTMLElement | null
      const ref = Array.from(root.querySelectorAll(refSel)).find((e) =>
        (e.textContent ?? '').includes('mdlink'),
      ) as HTMLElement | undefined
      const look = (el: HTMLElement) => {
        const cs = getComputedStyle(el)
        return {
          line: cs.textDecorationLine,
          style: cs.textDecorationStyle,
          offset: cs.textUnderlineOffset,
          color: cs.color,
        }
      }
      return {
        count: root.querySelectorAll('span.vmde-html-link').length,
        link: link ? look(link) : null,
        ref: ref ? look(ref) : null,
        markersHidden: link
          ? (link.previousElementSibling as HTMLElement).style.display ===
            'none'
          : false,
      }
    },
    [pane, reference] as [string, string],
  )
}

async function saveAndRead(evaluateInVSCode: Evaluate) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as unknown as [string],
  )
  return readFileSync(main, 'utf8')
}

const linkLines = (text: string) =>
  text.split('\n').filter((l) => l.includes('<a '))

async function openTabs(evaluateInVSCode: Evaluate) {
  return evaluateInVSCode(
    async (vscode: typeof import('vscode')) =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .map((t) => {
          const input = t.input as
            | { uri?: { fsPath?: string }; viewType?: string }
            | undefined
          return { fsPath: input?.uri?.fsPath, viewType: input?.viewType }
        }),
    [] as unknown as [string],
  ) as Promise<Array<{ fsPath?: string; viewType?: string }>>
}

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('IR: HTML link looks like a Markdown link, reveals on caret, opens on Ctrl+click, edits keep the bytes', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const frame = await openMain(evaluateInVSCode, '.vditor-ir', workbox)
  const pane = '.vditor-ir .vditor-reset'

  for (const theme of ['auto', 'github-light']) {
    await setContentTheme(evaluateInVSCode, theme)
    await expect
      .poll(
        async () => (await measure(frame, pane, '.vditor-ir__link')).count,
        { timeout: 15_000 },
      )
      .toBe(2)
    // The IR underline sits on the outer span[data-type=a]; compare it with the HTML link's own.
    const state = await measure(frame, pane, '.vditor-ir__link')
    expect(state.markersHidden).toBe(true)
    expect(state.link!.line).toBe('underline')
    expect(state.link!.style).toBe('solid')
    expect(state.link!.offset).toBe('2px')
    expect(state.link!.color, theme).toBe(state.ref!.color)
  }

  // Caret entry (plain click) reveals the source.
  await frame.locator('span.vmde-html-link', { hasText: 'targetlink' }).click()
  await expect(
    frame.locator('.vditor-ir p', { hasText: 'Plain' }).first(),
  ).toContainText('<a href="./target.md">')

  // Edit a different paragraph and save: the HTML link lines stay byte-identical on disk.
  await frame
    .locator('.vditor-ir p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await workbox.keyboard.type('Q')
  await expect
    .poll(async () => (await saveAndRead(evaluateInVSCode)).includes('Q'), {
      timeout: 15_000,
    })
    .toBe(true)
  const saved = readFileSync(main, 'utf8')
  expect(linkLines(saved)).toEqual(LINK_LINES)
  expect(saved.replace('Q', '')).toBe(ORIGINAL)

  // Ctrl+click on the decorated link opens target.md as a VMDE tab.
  await expect(
    frame.locator('span.vmde-html-link', { hasText: 'targetlink' }),
  ).toHaveCount(1)
  await frame
    .locator('span.vmde-html-link', { hasText: 'targetlink' })
    .click({ modifiers: ['Control'] })
  await expect
    .poll(() => openTabs(evaluateInVSCode), { timeout: 15_000 })
    .toContainEqual({
      fsPath: path.join(dir, 'target.md'),
      viewType: 'vmde.editor',
    })
})

test('WYSIWYG: HTML link looks like a Markdown link, edits keep the bytes, Ctrl+click does not dirty the document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  await setContentTheme(evaluateInVSCode, 'auto')
  const frame = await openMain(evaluateInVSCode, '.vditor-ir', workbox)
  await switchToWysiwyg(frame)
  const pane = '.vditor-wysiwyg .vditor-reset'

  await expect
    .poll(async () => (await measure(frame, pane, 'a[href]')).count, {
      timeout: 15_000,
    })
    .toBe(2)
  const state = await measure(frame, pane, 'a[href]')
  expect(state.link!.line).toBe('underline')
  expect(state.link!.style).toBe('solid')
  expect(state.link!.offset).toBe('2px')
  expect(state.link!.color).toBe(state.ref!.color)

  // Edit elsewhere and save: the link lines keep their bytes (this document has no `&` drift in
  // the edited block, and WYSIWYG keeps untouched blocks verbatim through minimal-diff write-back).
  await frame
    .locator('.vditor-wysiwyg p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await workbox.keyboard.type('Q')
  await expect
    .poll(async () => (await saveAndRead(evaluateInVSCode)).includes('Q'), {
      timeout: 15_000,
    })
    .toBe(true)
  const saved = readFileSync(main, 'utf8')
  expect(linkLines(saved)).toEqual(LINK_LINES)

  // Ctrl+click opens the target and leaves the main document clean.
  await frame
    .locator('span.vmde-html-link', { hasText: 'targetlink' })
    .click({ modifiers: ['Control'] })
  await expect
    .poll(() => openTabs(evaluateInVSCode), { timeout: 15_000 })
    .toContainEqual({
      fsPath: path.join(dir, 'target.md'),
      viewType: 'vmde.editor',
    })
  const dirty = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? null,
    [main] as [string],
  )
  expect(dirty).toBe(false)

  // Preview output (Lute Md2HTML of the saved text) renders the same real anchor.
  await frame.locator('body').evaluate((_el, text) => {
    const html = (
      window as unknown as {
        vditor: { vditor: { lute: { Md2HTML(md: string): string } } }
      }
    ).vditor.vditor.lute.Md2HTML(text as string)
    if (!html.includes('<a href="./target.md">targetlink</a>'))
      throw new Error(`Preview anchor missing: ${html}`)
  }, saved)
})
