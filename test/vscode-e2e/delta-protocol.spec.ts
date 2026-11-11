import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { splitTableRowCells } from '../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 733 (family task 007): the delta protocol through the real webview and the real VS Code
// document. Every test reads the document text through the VS Code document, never from the
// webview, and checks bytes: what an edit changes and what it leaves alone.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  fullGetValue: number
  legacyEditPosts: number
  deltaPosts: number
  fallbackPublications: number
}

const PADDED = [
  '# Padded',
  '',
  'Intro.',
  '',
  '| Name   | Value |',
  '| ------ | ----- |',
  '| alpha  | 1     |',
  '| beta   | 2     |',
  '',
  'End.',
  '',
].join('\n')
const SEPARATORS = 'First.\n\n\nSecond.\n\nThird.\n'
const REFDEF = 'See [x][r].\n\n[r]: https://example.com\n'
const TASKS = '- [ ] one\n- [ ] two\n\nAlpha.\n\nBeta.\n'
const HEAVY = tableHeavyMarkdown(1)
const SECOND_PARAGRAPH =
  'Second paragraph, a little longer than the first one, still plain prose.'

/** Writes the fixture into the test's base directory and opens it in the editor; returns the frame. */
async function open(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
  options: { live: boolean } = { live: true },
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  const frame = (await reopenVmdeFixture(
    evaluateInVSCode as never,
    workbox,
    file,
  )) as Frame
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the delta-protocol editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  if (options.live) {
    // The model builds on the animation frame after the host text arrives.
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
  }
  return { frame, file }
}

const modelState = (frame: Frame): Promise<string> =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelShadowStats?: { state: string }
        }
      ).__vmdeModelShadowStats?.state ?? 'missing',
  )

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, size) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(size as number)
  }, length)

const readCounters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      legacyEditPosts: c.legacyEditPosts,
      deltaPosts: c.deltaPosts,
      fallbackPublications: c.fallbackPublications,
    }
  })

/** A negative-assertion wait: the idle publication must have run before counters are read. */
const settle = (workbox: Page) => workbox.waitForTimeout(2000)

/** Click the element and put the caret at the end of its line. */
async function caretAtEnd(
  workbox: Page,
  frame: Frame,
  selector: string,
  nth: number,
) {
  const target = frame.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

const isDirty = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? false,
    [file],
  ) as Promise<boolean>

const runCommand = (evaluateInVSCode: Evaluate, command: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(args[0])
    },
    [command],
  )

/** Lines of `after` that are not in `before` as a prefix/suffix match: the first and last differing index. */
function differingLines(before: string, after: string): number[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const out: number[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) out.push(i)
  return out
}

test.afterEach(async ({ evaluateInVSCode }) => {
  // No state behind: unsaved edits are reverted, then the editors close.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), _args: string[]) => {
      try {
        await vscode.commands.executeCommand('workbench.action.files.revert')
      } catch {
        // No active document to revert.
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [''],
  )
})

test.describe('delta protocol', () => {
  test('paragraph typing changes the document only by the typed text and posts deltas', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-paragraph.md',
      HEAVY,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await resetCounters(frame, HEAVY.length)
    await workbox.keyboard.type('abc', { delay: 80 })
    await settle(workbox)
    const expected = HEAVY.replace(SECOND_PARAGRAPH, `${SECOND_PARAGRAPH}abc`)
    expect(expected).not.toBe(HEAVY)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(expected)
    const counters = await readCounters(frame)
    expect(counters.deltaPosts).toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts).toBe(0)
  })

  test('cell typing keeps the padding of the table', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-padded.md',
      PADDED,
    )
    // The first body cell holds `alpha`.
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > table td', 0)
    await workbox.keyboard.type('x', { delay: 80 })
    await settle(workbox)
    const text = await docText(evaluateInVSCode as never, file)
    const changed = differingLines(PADDED, text)
    expect(changed).toEqual([6])
    expect(text.split('\n')[6]).toBe('| alphax  | 1     |')
  })

  test('blank-line separators between blocks are kept (PD-8)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-separators.md',
      SEPARATORS,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 2)
    await workbox.keyboard.type('z', { delay: 80 })
    await settle(workbox)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe('First.\n\n\nSecond.\n\nThird.z\n')
  })

  test('inserting a table row adds one line of empty cells and leaves every other line alone (PD-1)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-row-insert.md',
      HEAVY,
    )
    // Table A has 5 columns; body row 3 starts at cell 10.
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > table td', 10)
    await frame.locator('#fix-table-ir-wrapper .vditor-panel').hover()
    await frame
      .locator('#fix-table-ir-wrapper [data-type="insertRowB"]')
      .click()
    await expect
      .poll(async () => (await docText(evaluateInVSCode as never, file)).length)
      .toBeGreaterThan(HEAVY.length)
    const text = await docText(evaluateInVSCode as never, file)
    const before = HEAVY.split('\n')
    const after = text.split('\n')
    expect(after).toHaveLength(before.length + 1)
    // The new line sits right below body row 3 of table A: header + delimiter + 3 rows.
    const headerIndex = before.findIndex((line) => line.startsWith('| Name |'))
    const inserted = headerIndex + 2 + 3
    const cells = splitTableRowCells(after[inserted])
    expect(cells).toHaveLength(5)
    expect(cells.every((cell) => cell.trim() === '')).toBe(true)
    expect([...after.slice(0, inserted), ...after.slice(inserted + 1)]).toEqual(
      before,
    )
  })

  test('typing, save, Backspace and typing again returns to the saved bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-return.md',
      HEAVY,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await workbox.keyboard.type('x', { delay: 80 })
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain(`${SECOND_PARAGRAPH}x`)
    await runCommand(
      evaluateInVSCode as Evaluate,
      'workbench.action.files.save',
    )
    await expect
      .poll(() => isDirty(evaluateInVSCode as Evaluate, file))
      .toBe(false)
    const saved = readFileSync(file, 'utf8')
    await workbox.keyboard.press('Backspace')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .not.toBe(saved)
    await workbox.keyboard.type('x', { delay: 80 })
    await settle(workbox)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(saved)
    // The tab is not asserted clean here: nothing in the host clears the modified mark for forward
    // edits that restore the saved bytes (neither the whole-text path nor the delta path; the deferred
    // no-op check returns early when the bytes already match). VS Code clears the mark only when a native
    // Undo returns to the saved version: see the next test, which is guarantee 1 of the inventory.
  })

  test('typing, save, typing and Undo returns to the saved bytes and a clean tab', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-undo-clean.md',
      HEAVY,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await workbox.keyboard.type('x', { delay: 80 })
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain(`${SECOND_PARAGRAPH}x`)
    await runCommand(
      evaluateInVSCode as Evaluate,
      'workbench.action.files.save',
    )
    await expect
      .poll(() => isDirty(evaluateInVSCode as Evaluate, file))
      .toBe(false)
    const saved = readFileSync(file, 'utf8')
    // A save is no Undo boundary. Vditor records an Undo entry `undoDelay` (800 ms in IR) after the last
    // input, so `x` and `y` typed closer together share one entry and one Ctrl+Z removes both. Wait
    // past that window, as users do and as the existing Undo specs do, so `y` is its own step.
    await settle(workbox)
    await workbox.keyboard.type('y', { delay: 80 })
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .not.toBe(saved)
    await settle(workbox)
    await workbox.keyboard.press('Control+z')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(saved)
    await expect
      .poll(() => isDirty(evaluateInVSCode as Evaluate, file))
      .toBe(false)
  })

  test('a CRLF document keeps every line break after typing', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const crlf = PADDED.replace(/\n/g, '\r\n')
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-crlf.md',
      crlf,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 0)
    await workbox.keyboard.type('a', { delay: 80 })
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain('Intro.a')
    await settle(workbox)
    const text = await docText(evaluateInVSCode as never, file)
    expect(text).toContain('\r\n')
    // No line feed without its carriage return.
    expect(/(?<!\r)\n/.test(text)).toBe(false)
  })

  test('an external change during typing arrives once and the later typing lands on it', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-external.md',
      HEAVY,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await workbox.keyboard.type('a', { delay: 80 })
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain(`${SECOND_PARAGRAPH}a`)
    const lastLine = '| ext-last | 1 | 2 | 3 | 4 |'
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === args[0],
        )
        if (!doc) return
        let index = doc.lineCount - 1
        while (index > 0 && doc.lineAt(index).text === '') index--
        const edit = new vscode.WorkspaceEdit()
        edit.replace(doc.uri, doc.lineAt(index).range, args[1])
        await vscode.workspace.applyEdit(edit)
      },
      [file, lastLine],
    )
    await expect(frame.locator('.vditor-ir')).toContainText('ext-last', {
      timeout: 30_000,
    })
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await workbox.keyboard.type('b', { delay: 80 })
    await settle(workbox)
    const text = await docText(evaluateInVSCode as never, file)
    expect(text).toContain(lastLine)
    expect(text).toContain(`${SECOND_PARAGRAPH}ab`)
    await expect(workbox.locator('.notification-toast')).toHaveCount(0)
  })

  test('an astral character and its Backspace leave the fixture bytes and no lone surrogate', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-astral.md',
      HEAVY,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > p', 1)
    await workbox.keyboard.insertText('😀')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain(`${SECOND_PARAGRAPH}😀`)
    const typed = await docText(evaluateInVSCode as never, file)
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
        typed,
      ),
    ).toBe(false)
    await workbox.keyboard.press('Backspace')
    await settle(workbox)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(HEAVY)
  })

  test('a document with a reference definition keeps the whole-text path', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-refdef.md',
      REFDEF,
      { live: false },
    )
    await frame.locator('.vditor-ir .vditor-reset > p').first().click()
    await workbox.keyboard.press('Home')
    for (let i = 0; i < 3; i++) await workbox.keyboard.press('ArrowRight')
    await resetCounters(frame, REFDEF.length)
    await workbox.keyboard.type('q', { delay: 80 })
    await settle(workbox)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain('Seeq')
    const counters = await readCounters(frame)
    expect(counters.legacyEditPosts).toBeGreaterThanOrEqual(1)
    expect(counters.fallbackPublications).toBe(0)
  })

  test('exact actions: a task toggle reads no full document and a block move writes the expected text', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'delta-exact.md',
      TASKS,
    )
    await frame.locator('.vditor-ir .vditor-reset > ul > li').first().click()
    await resetCounters(frame, TASKS.length)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.toggleTaskCheckbox')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain('- [x] one')
    await settle(workbox)
    expect((await readCounters(frame)).fullGetValue).toBe(0)
    await frame.locator('.vditor-ir .vditor-reset > p').first().click()
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.moveBlockDown')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe('- [x] one\n- [ ] two\n\nBeta.\n\nAlpha.\n')
  })
})
