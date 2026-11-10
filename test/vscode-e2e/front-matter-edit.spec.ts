// Task 725 — edit YAML front matter in the properties table, in the real VS Code webview. IR and
// WYSIWYG: edit a value and a name, Esc cancels, a list cell as YAML, add three rows and fill them
// with Tab, a rename to an existing name (duplicate marker), remove, reorder by Alt+Up/Alt+Down and
// by drag; each action is one Undo and one Redo step, and the saved file has exactly the expected
// bytes. A CRLF file with comments and mixed quotes keeps every byte that was not edited. The
// Split View preview and Preview show the table with no edit affordance.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { setConfig } from './preview-mode-helpers'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

type Evaluate = (fn: unknown, args: unknown) => Promise<unknown>
type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type EditMode = 'ir' | 'wysiwyg'

const DOC = `---
# Document properties
title: "Hello"
author: 'Ann'
count: 3
tags:
  - a
  - b
---

# Heading

Paragraph below.
`

const SCOPE: Record<EditMode, string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await setConfig(evaluateInVSCode as Evaluate, 'editor.defaultMode', undefined)
})

async function open(
  evaluateInVSCode: Evaluate,
  workbox: Page,
  file: string,
  mode: EditMode | 'sv',
): Promise<Frame> {
  await setConfig(evaluateInVSCode, 'editor.defaultMode', mode)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
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
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    { timeout: 60_000, message: `Task 725 ${mode} readiness` },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

class Table {
  constructor(
    readonly frame: Frame,
    readonly workbox: Page,
    readonly scope: string,
    readonly host: () => Promise<string>,
  ) {}

  cell(index: number, kind: 'key' | 'value') {
    return this.frame.locator(
      `${this.scope} tr[data-vmde-fm-index="${index}"] > [data-vmde-fm-cell="${kind}"]`,
    )
  }

  editor() {
    return this.frame.locator(`${this.scope} .vmde-front-matter__editor`)
  }

  /** Caret in the body, so the table (not the YAML source) shows; Undo may leave it in the block. */
  async show() {
    await this.frame
      .locator(`${this.scope} p`)
      .filter({ hasText: 'Paragraph below.' })
      .click()
    await expect(
      this.frame.locator(
        `${this.scope} .vmde-front-matter[data-vmde-fm-editable]`,
      ),
    ).toBeVisible({ timeout: 15_000 })
  }

  /** Clicks a cell near its left edge (never on its copy button) and waits for its editor. */
  async openCell(index: number, kind: 'key' | 'value') {
    await this.cell(index, kind).click({ position: { x: 4, y: 6 } })
    await expect(
      this.cell(index, kind).locator('.vmde-front-matter__editor'),
    ).toBeFocused()
  }

  async expectHost(text: string, message: string) {
    await expect.poll(this.host, { timeout: 20_000, message }).toBe(text)
  }

  /** One Ctrl+Z gives `before` exactly, one Ctrl+Y gives `after` again. */
  async undoRedo(before: string, after: string, label: string) {
    await this.workbox.keyboard.press('Control+z')
    await this.expectHost(before, `${label}: one Undo step`)
    await this.workbox.keyboard.press('Control+y')
    await this.expectHost(after, `${label}: one Redo step`)
    await this.show()
  }

  async editable() {
    return this.frame.locator('body').evaluate((_body, scope) => {
      const root = document.querySelector(`${scope} .vmde-front-matter`)
      return {
        editable: root?.hasAttribute('data-vmde-fm-editable') ?? false,
        warningBlock: !!document.querySelector(
          `${scope} .vmde-front-matter__warning`,
        ),
        empty:
          root?.querySelectorAll('tr[data-vmde-fm-warning="empty"]').length ??
          0,
        duplicate: [
          ...(root?.querySelectorAll('tr[data-vmde-fm-warning="duplicate"]') ??
            []),
        ].map((row) => row.getAttribute('data-vmde-fm-index')),
      }
    }, this.scope)
  }
}

async function save(
  evaluateInVSCode: Evaluate,
  file: string,
  expected: string,
) {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [])
  await expect
    .poll(() => readFileSync(file, 'utf8'), {
      timeout: 20_000,
      message: 'saved bytes',
    })
    .toBe(expected)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: edit, add, fill, rename, remove and reorder; one Undo step each; exact saved bytes`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const evaluate = evaluateInVSCode as Evaluate
    const file = path.join(baseDir, `front-matter-edit-${mode}.md`)
    writeFileSync(file, DOC)
    const frame = await open(evaluate, workbox, file, mode)
    const t = new Table(frame, workbox, SCOPE[mode], () =>
      docText(evaluate, file),
    )
    await t.show()

    // A scalar value: the input opens with the decoded text selected; Enter commits.
    await t.openCell(0, 'value')
    await expect(t.editor()).toHaveValue('Hello')
    await workbox.keyboard.type('World')
    await workbox.keyboard.press('Enter')
    const t1 = DOC.replace('title: "Hello"', 'title: "World"')
    await t.expectHost(t1, 'value edit')
    await expect(t.cell(0, 'value')).toBeFocused()
    await t.undoRedo(DOC, t1, 'value edit')

    // A name (rename keeps the value bytes and quote style).
    await t.openCell(1, 'key')
    await workbox.keyboard.type('writer')
    await workbox.keyboard.press('Enter')
    const t2 = t1.replace("author: 'Ann'", "writer: 'Ann'")
    await t.expectHost(t2, 'rename')
    await t.undoRedo(t1, t2, 'rename')

    // Esc cancels: nothing reaches the document.
    await t.openCell(2, 'value')
    await workbox.keyboard.type('99')
    await workbox.keyboard.press('Escape')
    await expect(t.editor()).toHaveCount(0)
    await settle(frame, 500) // negative-assertion wait: no edit may arrive
    expect(await t.host()).toBe(t2)
    await expect(t.cell(2, 'value')).toContainText('3')

    // A list cell opens a YAML box with its source; Shift+Enter adds a line, Enter commits.
    await t.openCell(3, 'value')
    await expect(t.editor()).toHaveJSProperty('tagName', 'TEXTAREA')
    await expect(t.editor()).toHaveValue('\n  - a\n  - b')
    await t
      .editor()
      .evaluate((box: HTMLTextAreaElement) =>
        box.setSelectionRange(box.value.length, box.value.length),
      )
    await workbox.keyboard.press('Shift+Enter')
    await workbox.keyboard.type('  - c')
    await workbox.keyboard.press('Enter')
    const t4 = t2.replace('  - b\n', '  - b\n  - c\n')
    await t.expectHost(t4, 'YAML box')
    await t.undoRedo(t2, t4, 'YAML box')

    // Add three placeholder rows; each press is one step; they are editable rows with a marker.
    const add = frame.locator(`${t.scope} .vmde-front-matter__add`)
    let added = t4
    for (let row = 4; row < 7; row++) {
      await add.click()
      added = t4.replace('  - c\n', `  - c\n${': ""\n'.repeat(row - 3)}`)
      await t.expectHost(added, `add ${row - 3}`)
      await expect(
        t.cell(row, 'key').locator('.vmde-front-matter__editor'),
      ).toBeFocused()
    }
    expect(await t.editable()).toMatchObject({
      editable: true,
      warningBlock: false,
      empty: 3,
    })
    await workbox.keyboard.press('Escape')
    const twoAdded = t4.replace('  - c\n', `  - c\n${': ""\n'.repeat(2)}`)
    await t.undoRedo(twoAdded, added, 'add')

    // Fill the three rows in one go: Tab moves name → value → next name.
    await t.openCell(4, 'key')
    for (const [text, last] of [
      ['one', false],
      ['1', false],
      ['two', false],
      ['2', false],
      ['three', false],
      ['3', true],
    ] as const) {
      await workbox.keyboard.type(text)
      await workbox.keyboard.press(last ? 'Enter' : 'Tab')
    }
    const t6 = t4.replace('  - c\n', '  - c\none: "1"\ntwo: "2"\nthree: "3"\n')
    await t.expectHost(t6, 'fill in one go')
    expect(await t.editable()).toMatchObject({ empty: 0, duplicate: [] })
    await t.undoRedo(t6.replace('three: "3"', 'three: ""'), t6, 'fill')

    // A rename to an existing name is written as typed; both rows show the duplicate marker.
    await t.openCell(5, 'key')
    await workbox.keyboard.type('one')
    await workbox.keyboard.press('Enter')
    const t7 = t6.replace('two: "2"', 'one: "2"')
    await t.expectHost(t7, 'duplicate rename')
    expect(await t.editable()).toMatchObject({
      editable: true,
      warningBlock: false,
      duplicate: ['4', '5'],
    })
    await t.undoRedo(t6, t7, 'duplicate rename')

    // Remove from the row tools.
    await t.cell(2, 'value').hover()
    await t.cell(2, 'value').locator('.vmde-front-matter__remove').click()
    const t8 = t7.replace('count: 3\n', '')
    await t.expectHost(t8, 'remove')
    await t.undoRedo(t7, t8, 'remove')

    // Alt+Down and Alt+Up on the focused row.
    await t.openCell(0, 'key')
    await workbox.keyboard.press('Escape')
    await expect(t.cell(0, 'key')).toBeFocused()
    await workbox.keyboard.press('Alt+ArrowDown')
    const t9 = t8.replace(
      `title: "World"\nwriter: 'Ann'\n`,
      `writer: 'Ann'\ntitle: "World"\n`,
    )
    await t.expectHost(t9, 'Alt+Down')
    await expect(t.cell(1, 'key')).toBeFocused()
    await t.undoRedo(t8, t9, 'Alt+Down')
    await t.openCell(1, 'key')
    await workbox.keyboard.press('Escape')
    await workbox.keyboard.press('Alt+ArrowUp')
    await t.expectHost(t8, 'Alt+Up')
    await t.undoRedo(t9, t8, 'Alt+Up')

    // Drag the first row (title) below the list (after row 2).
    await t.cell(0, 'value').hover()
    const handle = t.cell(0, 'value').locator('.vmde-front-matter__handle')
    const from = await handle.boundingBox()
    const target = await frame
      .locator(`${t.scope} tr[data-vmde-fm-index="2"]`)
      .boundingBox()
    if (!from || !target) throw new Error('drag geometry')
    await workbox.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await workbox.mouse.down()
    await workbox.mouse.move(
      from.x + from.width / 2,
      target.y + target.height * 0.75,
      {
        steps: 8,
      },
    )
    await workbox.mouse.up()
    const t10 = t8
      .replace(`title: "World"\n`, '')
      .replace('  - c\n', `  - c\ntitle: "World"\n`)
    await t.expectHost(t10, 'drag')
    await t.undoRedo(t8, t10, 'drag')

    await save(evaluate, file, t10)
    expect(t10).toBe(`---
# Document properties
writer: 'Ann'
tags:
  - a
  - b
  - c
title: "World"
one: "1"
one: "2"
three: "3"
---

# Heading

Paragraph below.
`)
  })
}

test('CRLF: comments, quote styles and line breaks stay byte-exact through edits', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  const crlf = (text: string) => text.replace(/\n/g, '\r\n')
  const source = crlf(`---
# Properties for the CRLF test
title: 'Single quoted'  # trailing comment
subtitle: "Double \\"quoted\\""
plain: value
list: [x, y]
---

Paragraph below.
`)
  const file = path.join(baseDir, 'front-matter-edit-crlf.md')
  writeFileSync(file, source)
  const frame = await open(evaluate, workbox, file, 'ir')
  const t = new Table(frame, workbox, SCOPE.ir, () => docText(evaluate, file))
  await t.show()

  await t.openCell(0, 'value')
  await workbox.keyboard.type('Changed')
  await workbox.keyboard.press('Enter')
  const s1 = source.replace("'Single quoted'", "'Changed'")
  await t.expectHost(s1, 'CRLF value')

  await t.openCell(2, 'key')
  await workbox.keyboard.type('simple')
  await workbox.keyboard.press('Enter')
  const s2 = s1.replace('plain: value', 'simple: value')
  await t.expectHost(s2, 'CRLF rename')

  await frame.locator(`${t.scope} .vmde-front-matter__add`).click()
  await workbox.keyboard.type('added')
  await workbox.keyboard.press('Tab')
  await workbox.keyboard.type('yes')
  await workbox.keyboard.press('Enter')
  const s3 = s2.replace('list: [x, y]\r\n', 'list: [x, y]\r\nadded: "yes"\r\n')
  await t.expectHost(s3, 'CRLF add and fill')

  await t.cell(1, 'value').hover()
  await t.cell(1, 'value').locator('.vmde-front-matter__remove').click()
  const s4 = s3.replace('subtitle: "Double \\"quoted\\""\r\n', '')
  await t.expectHost(s4, 'CRLF remove')

  await save(evaluate, file, s4)
  expect(s4).toBe(
    crlf(`---
# Properties for the CRLF test
title: 'Changed'  # trailing comment
simple: value
list: [x, y]
added: "yes"
---

Paragraph below.
`),
  )
})

test('Split View preview and Preview show the table with no edit affordance', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const evaluate = evaluateInVSCode as Evaluate
  const file = path.join(baseDir, 'front-matter-edit-preview.md')
  writeFileSync(file, DOC)
  const affordances = (frame: Frame) =>
    frame.locator('body').evaluate(() => {
      const root = document.querySelector('.vditor-preview .vmde-front-matter')
      return {
        rows: root?.querySelectorAll('tr').length ?? 0,
        editable: root?.hasAttribute('data-vmde-fm-editable') ?? null,
        controls: root?.querySelectorAll(
          '[data-vmde-fm-cell], .vmde-front-matter__add, .vmde-front-matter__remove, .vmde-front-matter__handle, .vmde-front-matter__editor',
        ).length,
      }
    })
  const expectReadOnly = async (frame: Frame, label: string) => {
    await expect
      .poll(() => affordances(frame), { message: label, timeout: 30_000 })
      .toEqual({ rows: 4, editable: false, controls: 0 })
    await frame.locator('.vditor-preview .vmde-front-matter td').first().click()
    await settle(frame, 300) // negative-assertion wait: no editor may open
    expect(
      await frame.locator('.vditor-preview .vmde-front-matter__editor').count(),
      `${label}: a click opens no editor`,
    ).toBe(0)
  }

  const split = await open(evaluate, workbox, file, 'sv')
  await expectReadOnly(split, 'Split View preview')

  const frame = await open(evaluate, workbox, file, 'ir')
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expectReadOnly(frame, 'Preview')
  expect(await docText(evaluate, file)).toBe(DOC)
})
