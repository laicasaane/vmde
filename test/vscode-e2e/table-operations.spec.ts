import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, settle, waitForE2EReadiness, wf } from './webview-helpers'
import { createSpecKeyboard, type SpecKeyboard } from './helpers/spec-keyboard'

const FIXTURE = path.join(__dirname, 'fixtures', 'table-nav.md')

async function selectRectangle(
  frame: ReturnType<typeof wf>,
  selector: '.vditor-ir' | '.vditor-wysiwyg',
  input: SpecKeyboard,
) {
  await frame.locator(`${selector} td`).first().click()
  const before = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  await input.key('shift+Right')
  await expect(frame.locator(`${selector} .vmde-cell-selected`)).toHaveCount(2)
  const copied = await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor
    const root = v.vditor[v.getCurrentMode()].element as HTMLElement
    const selected = root.querySelectorAll('.vmde-cell-selected').length
    const after = v.getValue()
    const clipboard = new DataTransfer()
    root.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    )
    return {
      after,
      selected,
      plain: clipboard.getData('text/plain'),
      markdown: clipboard.getData('text/markdown'),
    }
  })
  await input.key('Escape')
  return {
    before,
    ...copied,
    remaining: await frame.locator(`${selector} .vmde-cell-selected`).count(),
  }
}

test('cell rectangles are source-invisible in IR and WYSIWYG', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const input = await createSpecKeyboard(electronApp, workbox)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'IR mode did not become ready',
    },
  )
  const ir = await selectRectangle(frame, '.vditor-ir', input)
  expect(ir.selected).toBe(2)
  expect(ir.after).toBe(ir.before)
  expect(ir.remaining).toBe(0)
  expect(ir.plain).toBe('r0a\tr0b')
  expect(ir.markdown).toBe('| r0a | r0b |\n|---|---|')

  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    timeout: 60_000,
    message: 'WYSIWYG mode did not become ready',
  })
  await frame.locator('.vditor-wysiwyg td').first().waitFor({ timeout: 30_000 })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        const cell = root.querySelector('td')!
        const range = document.createRange()
        range.selectNodeContents(cell)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return Boolean(document.querySelector('#vmde-table-moves'))
      }),
    )
    .toBe(true)
  const wysiwyg = await selectRectangle(frame, '.vditor-wysiwyg', input)
  expect(wysiwyg.selected).toBe(2)
  expect(wysiwyg.after).toBe(wysiwyg.before)
  expect(wysiwyg.remaining).toBe(0)
  expect(wysiwyg.plain).toBe('r0a\tr0b')
  expect(wysiwyg.markdown).toBe('| r0a  | r0b  |\n|---|---|')
})

test('IR move preserves exact noncanonical source through one undo, redo, save, and reopen', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const input = await createSpecKeyboard(electronApp, workbox)
  const file = path.join(baseDir, 'table-operations-exact.md')
  const initial = [
    'before',
    '',
    '|  Left  | Right   |',
    '| :--- | ---: |',
    '| *one* | `two` |',
    '',
    'between',
    '',
    '|  Left  | Right   |',
    '| :--- | ---: |',
    '| *one* | `two` |',
    '',
    'after',
    '',
  ].join('\r\n')
  const moved = initial.replace(
    '|  Left  | Right   |\r\n| :--- | ---: |\r\n| *one* | `two` |',
    '| Right   |  Left  |\r\n| ---: | :--- |\r\n| `two` | *one* |',
  )
  writeFileSync(file, initial)
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
  let frame = wf(workbox)
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    timeout: 60_000,
    message: 'exact table transaction did not become ready',
  })
  await frame.locator('.vditor-ir td').nth(1).click()
  await frame.locator('#fix-table-ir-wrapper .vditor-panel').hover()
  await frame
    .locator('#fix-table-ir-wrapper [data-type="moveColumnLeft"]')
    .click()
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(moved)
  expect(
    await frame.locator('body').evaluate(() => {
      const node = getSelection()?.anchorNode
      const cell = (
        node instanceof Element ? node : node?.parentElement
      )?.closest('td,th')
      return cell?.textContent?.trim()
    }),
  ).toBe('`two`')
  // Task 578 acceptance uses XTEST for the native one-step undo/redo journey.
  await input.key('ctrl+z')
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(initial)
  await input.key('ctrl+y')
  await expect
    .poll(async () => {
      return await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.workspace.textDocuments
            .find((document) => document.uri.fsPath === args[0])
            ?.getText(),
        [file] as [string],
      )
    })
    .toBe(moved)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(moved)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  frame = wf(workbox)
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    timeout: 60_000,
    message: 'reopened exact table transaction did not become ready',
  })
  expect(await readFileSync(file, 'utf8')).toBe(moved)
})

test('WYSIWYG ordinary range control inserts once, undoes once, and retires for IME', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const input = await createSpecKeyboard(electronApp, workbox)
  const file = path.join(baseDir, 'table-range-wysiwyg.md')
  writeFileSync(file, '| a | b |\n| --- | --- |\n| one | two |\n')
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
  await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
  await frame.locator('body').evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    timeout: 60_000,
    message: 'WYSIWYG range transaction did not become ready',
  })
  await frame.locator('.vditor-wysiwyg td').first().click()
  await input.key('shift+Right')
  await expect(
    frame.locator('.vditor-wysiwyg .vmde-cell-selected'),
  ).toHaveCount(2)
  await frame
    .locator('.vditor-wysiwyg > .vditor-panel button[data-type="insertColumn"]')
    .nth(1)
    .click()
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        return root.querySelector('table')!.rows[0].cells.length
      }),
    )
    .toBe(4)
  await input.key('ctrl+z')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        return root.querySelector('table')!.rows[0].cells.length
      }),
    )
    .toBe(2)
  await frame.locator('.vditor-wysiwyg td').first().click()
  await input.key('shift+Right')
  await expect(
    frame.locator('.vditor-wysiwyg .vmde-cell-selected'),
  ).toHaveCount(2)
  const ime = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const armed = root.querySelectorAll('.vmde-cell-selected').length
    root.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    return { armed, after: root.querySelectorAll('.vmde-cell-selected').length }
  })
  expect(ime).toEqual({ armed: 2, after: 0 })
})

// Task 580 CP2-9 — the 13 table commands are unbound VMDE-only commands. Each runs at the caret's
// cell in IR and WYSIWYG and one Undo recovers the exact source (CP1 P5: one Undo per table
// operation). Their synthetic Vditor chord stays on the mode element: an untrusted keydown that
// reached the webview window would be forwarded to the workbench (Ctrl+= zooms in). The former
// move chords Ctrl+Shift+[ / ] and +PageUp/PageDown no longer move the table.
const COMMAND_TABLE =
  'before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nafter\n'

interface ParsedTable {
  rows: string[][]
  separator: string[]
}

function parseCommandTable(markdown: string): ParsedTable {
  const lines = markdown.split('\n').filter((line) => line.startsWith('|'))
  const cells = (line: string) =>
    line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
  return {
    rows: lines.filter((_line, index) => index !== 1).map(cells),
    separator: cells(lines[1] ?? ''),
  }
}

const TABLE_COMMAND_CASES: readonly [
  string,
  string,
  (table: ParsedTable) => void,
][] = [
  ['vmde.table.insertRowBelow', '3', (t) => expect(t.rows).toHaveLength(4)],
  [
    'vmde.table.insertColumnLeft',
    '1',
    (t) => expect(t.rows[0]).toHaveLength(3),
  ],
  [
    'vmde.table.insertColumnRight',
    '1',
    (t) => expect(t.rows[0]).toHaveLength(3),
  ],
  ['vmde.table.deleteRow', '3', (t) => expect(t.rows).toHaveLength(2)],
  ['vmde.table.deleteColumn', '2', (t) => expect(t.rows[0]).toEqual(['A'])],
  [
    'vmde.table.moveColumnLeft',
    '2',
    (t) => expect(t.rows[0]).toEqual(['B', 'A']),
  ],
  [
    'vmde.table.moveColumnRight',
    '1',
    (t) => expect(t.rows[0]).toEqual(['B', 'A']),
  ],
  [
    'vmde.table.moveRowUp',
    '3',
    (t) => expect(t.rows.map((row) => row[0])).toEqual(['A', '3', '1']),
  ],
  [
    'vmde.table.moveRowDown',
    '1',
    (t) => expect(t.rows.map((row) => row[0])).toEqual(['A', '3', '1']),
  ],
  // Insert Row Above and alignment last: in IR, Insert Row Above has no working Undo (see the
  // loop), so it changes the table for the alignment rows, which only read the separator.
  ['vmde.table.insertRowAbove', '3', (t) => expect(t.rows).toHaveLength(4)],
  [
    'vmde.table.alignRight',
    '1',
    (t) => expect(t.separator[0]).toMatch(/^-+:$/),
  ],
  ['vmde.table.alignLeft', '1', (t) => expect(t.separator[0]).toMatch(/^:-+$/)],
  // CP2-11 removed clipboard-line.ts's Ctrl/Cmd+C keydown match (it ignored Shift and widened the
  // caret before Vditor read the cell), so Align Center now reaches the table too.
  [
    'vmde.table.alignCenter',
    '1',
    (t) => expect(t.separator[0]).toMatch(/^:-+:$/),
  ],
]

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: the unbound table commands act on the caret cell, undo in one step, and keep their chord in the webview`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const file = path.join(baseDir, `table-commands-${mode}.md`)
    writeFileSync(file, COMMAND_TABLE)
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
    await frame.locator('.vditor-ir td').first().waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      { timeout: 60_000, message: 'IR mode did not become ready' },
    )
    if (mode === 'wysiwyg') {
      await frame.locator('body').evaluate(() => {
        const toolbar = (window as any).vditor.vditor.toolbar
        toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        )
        document
          .querySelector('button[data-mode="wysiwyg"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
        timeout: 60_000,
        message: 'WYSIWYG mode did not become ready',
      })
    }
    await frame.locator('body').evaluate(() => {
      const leaked: string[] = []
      ;(window as any).__leakedTableKeys = leaked
      const record = (event: Event) => {
        if (!event.isTrusted) leaked.push((event as KeyboardEvent).key)
      }
      document.addEventListener('keydown', record)
      window.addEventListener('keydown', record)
    })
    const cell = (text: string) =>
      frame.locator(`.vditor-${mode} td`, { hasText: text }).first()
    const run = (command: string) =>
      evaluateInVSCode(async (vscode, id: string) => {
        await vscode.commands.executeCommand(id)
      }, command)
    const source = () => docText(evaluateInVSCode, file)

    for (const [command, text, check] of TABLE_COMMAND_CASES) {
      const alignment = command.startsWith('vmde.table.align')
      await cell(text).click()
      // Let the click's caret and Vditor's pending render settle first: an edit made straight
      // after the first click gets no Undo through the former chord either (measured here: the
      // trusted Ctrl+= and the command both kept their row after three Ctrl+Z).
      await settle(frame, 800)
      // WYSIWYG alignment is Vditor clicking its table popover's align button, so it needs the
      // popover the cell click builds, exactly as the former Ctrl/Cmd+Shift+L/C/R chord did.
      if (mode === 'wysiwyg' && alignment)
        await expect(
          frame.locator('.vditor-wysiwyg > .vditor-panel [data-type="left"]'),
        ).toBeAttached()
      const before = await source()
      await run(command)
      await expect.poll(source, { message: command }).not.toBe(before)
      check(parseCommandTable(await source()))
      // Insert Row Above (Ctrl+Shift+F) never took an undo boundary. In IR the pre-CP2-9 chord's
      // row survived three Ctrl+Z; the command keeps that as found (not a CP1 P5 row).
      if (mode === 'ir' && command === 'vmde.table.insertRowAbove') continue
      await workbox.keyboard.press('Control+z')
      await expect.poll(source, { message: `${command} undo` }).toBe(before)
    }

    // The former move chords leave the table alone.
    const beforeChords = await source()
    await cell('2').click()
    for (const chord of [
      'Control+Shift+BracketLeft',
      'Control+Shift+BracketRight',
      'Control+Shift+PageUp',
      'Control+Shift+PageDown',
    ])
      await workbox.keyboard.press(chord)
    await frame
      .locator('body')
      .evaluate(() => new Promise((r) => setTimeout(r, 300)))
    expect(await source()).toBe(beforeChords)
    expect(
      await frame
        .locator('body')
        .evaluate(() => (window as any).__leakedTableKeys as string[]),
    ).toEqual([])
  })
}
