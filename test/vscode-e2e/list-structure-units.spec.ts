import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 011 (shared rules 3.8, Q-87): Enter, Delete and Backspace at list items in IR, through
// the real webview. Enter in a tight top-level item spins the split pair and the model writes the new
// item alone (no whole-list Lute call); loose lists and the Backspace lift keep the whole-list path.
// Document comparisons are booleans so fixture text stays out of failure output.

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  luteList: number
  luteDocument: number
  fallbackPublications: number
}

const ITEM =
  '.vditor-ir .vditor-reset > ul > li, .vditor-ir .vditor-reset > ol > li'

// A negative-assertion wait: the idle publication must have run before counters and text are read.
const settleForPublication = (workbox: import('@playwright/test').Page) =>
  workbox.waitForTimeout(2000)

async function openMarkdown(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
  markdown: string,
): Promise<Frame> {
  writeFileSync(file, markdown)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.routerReady &&
      snapshot.editorEpoch > 0 &&
      snapshot.mode === 'ir',
    { message: 'the list-structure editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await expect
    .poll(
      async () => (await docText(evaluateInVSCode as never, file)) === markdown,
      {
        timeout: 30_000,
      },
    )
    .toBe(true)
  return frame
}

const modelState = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeModelShadowStats?: { state: string } })
          .__vmdeModelShadowStats?.state,
    )

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, n) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(n as number)
  }, length)

const readCounters = async (frame: Frame, name: string): Promise<Counters> => {
  const counters = await frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      luteList: c.luteList,
      luteDocument: c.luteDocument,
      fallbackPublications: c.fallbackPublications,
    }
  })
  console.log(`LIST-STRUCTURE-COUNTERS ${JSON.stringify({ name, counters })}`)
  return counters
}

/** Removes the unit spin hook, so Vditor's block spin and the whole-list path run (the reference drive). */
const removeSpinHook = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    delete (window as unknown as { __vmdeSpinUnit?: unknown }).__vmdeSpinUnit
  })

/** Click item `nth` (0-based, top-level items of the first list) and press `key` (`End` or `Home`). */
async function caretInItem(
  workbox: import('@playwright/test').Page,
  frame: Frame,
  nth: number,
  key: 'End' | 'Home',
): Promise<void> {
  const item = frame.locator(ITEM).nth(nth)
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await workbox.keyboard.press(key)
}

async function typeKeys(
  workbox: import('@playwright/test').Page,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    await workbox.keyboard.press(key)
    await workbox.waitForTimeout(150)
  }
}

const ordered = (count: number): string =>
  `Intro paragraph before the list.\n\n${Array.from(
    { length: count },
    (_, k) => `${k + 1}. ordered item ${k + 1}`,
  ).join('\n')}\n\nClosing paragraph after the list.\n`

const loose = `Intro paragraph before the list.\n\n${Array.from(
  { length: 6 },
  (_, k) => `- loose item ${k + 1}`,
).join('\n\n')}\n\nClosing paragraph after the list.\n`

const tight = `Intro paragraph before the list.\n\n${Array.from(
  { length: 6 },
  (_, k) => `- tight item ${k + 1}`,
).join('\n')}\n\nClosing paragraph after the list.\n`

/** Opens `markdown` twice: the drive with the hook, then the same drive with the hook removed. */
async function driveBothWays(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  markdown: string,
  enter: (frame: Frame) => Promise<void>,
  type: () => Promise<void>,
): Promise<{ hooked: string; reference: string; counters: Counters }> {
  const fileA = path.join(baseDir, 'list-structure-a.md')
  const frameA = await openMarkdown(workbox, evaluateInVSCode, fileA, markdown)
  await expect.poll(() => modelState(frameA), { timeout: 30_000 }).toBe('live')
  await resetCounters(frameA, markdown.length)
  await enter(frameA)
  await settleForPublication(workbox)
  // F-2 (011-R): the counters measure the Enter only; typing into an ordered item keeps the block
  // spin of Q-46, which is outside this task.
  const counters = await readCounters(frameA, 'hooked Enter')
  await type()
  await settleForPublication(workbox)
  const hooked = (await docText(evaluateInVSCode as never, fileA)) as string
  const fileB = path.join(baseDir, 'list-structure-b.md')
  const frameB = await openMarkdown(workbox, evaluateInVSCode, fileB, markdown)
  await removeSpinHook(frameB)
  await enter(frameB)
  await settleForPublication(workbox)
  await type()
  await settleForPublication(workbox)
  const reference = (await docText(evaluateInVSCode as never, fileB)) as string
  // Lengths only (no document text): which side differs when the comparison fails.
  console.log(
    `LIST-STRUCTURE-LENGTHS ${JSON.stringify({ source: markdown.length, hooked: hooked.length, reference: reference.length })}`,
  )
  return { hooked, reference, counters }
}

test.describe('list structure by items (IR)', () => {
  test('Enter in an unordered item adds one item line; Undo restores the fixture', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    const fixture = tableHeavyMarkdown(16)
    const file = path.join(baseDir, 'list-structure-unordered.md')
    const frame = await openMarkdown(workbox, evaluateInVSCode, file, fixture)
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
    await caretInItem(workbox, frame, 1, 'End')
    await settleForPublication(workbox)
    await resetCounters(frame, fixture.length)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(400)
    await typeKeys(workbox, ['n', 'e', 'w'])
    await settleForPublication(workbox)
    const expected = fixture.replace(
      '- list item 2\n',
      '- list item 2\n- new\n',
    )
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)) === expected,
      )
      .toBe(true)
    const counters = await readCounters(frame, 'Enter in an unordered item')
    expect(counters.luteList).toBe(0)
    expect(counters.luteDocument).toBe(0)
    expect(counters.fallbackPublications).toBe(0)
    expect(await modelState(frame)).toBe('live')

    // Undo of the Enter. Enter and the key typed after it are two Undo steps (Task 628,
    // `list-table-enter-undo.spec.ts`): the first Undo leaves the Enter state (the empty item), the
    // second returns the fixture bytes.
    await workbox.keyboard.press('Control+z')
    await settleForPublication(workbox)
    const enterState = fixture.replace('- list item 2\n', '- list item 2\n-\n')
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)) === enterState,
        { timeout: 15_000 },
      )
      .toBe(true)
    await workbox.keyboard.press('Control+z')
    await settleForPublication(workbox)
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)) === fixture,
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
  })

  test('Enter in an ordered item equals the whole-list drive', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    const markdown = ordered(20)
    const result = await driveBothWays(
      workbox,
      evaluateInVSCode,
      baseDir,
      markdown,
      async (frame) => {
        await caretInItem(workbox, frame, 4, 'End')
        await workbox.keyboard.press('Enter')
      },
      () => typeKeys(workbox, ['x']),
    )
    expect(result.hooked !== markdown).toBe(true)
    expect(result.hooked === result.reference).toBe(true)
    expect(result.counters.luteList).toBe(0)
    expect(result.counters.fallbackPublications).toBe(0)
  })

  test('Enter in a `)` ordered item keeps the delimiter and equals the whole-list drive (011-R F-1)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    const markdown = ordered(8).replace(/^(\d+)\. /gmu, '$1) ')
    const result = await driveBothWays(
      workbox,
      evaluateInVSCode,
      baseDir,
      markdown,
      async (frame) => {
        await caretInItem(workbox, frame, 2, 'End')
        await workbox.keyboard.press('Enter')
      },
      () => typeKeys(workbox, ['x']),
    )
    expect(result.hooked !== markdown).toBe(true)
    expect(/^\d+\. /mu.test(result.hooked)).toBe(false)
    expect(result.hooked === result.reference).toBe(true)
    expect(result.counters.luteList).toBe(0)
    expect(result.counters.fallbackPublications).toBe(0)
  })

  test('Delete at an item end joins the next item (Q-87 Q-A)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'list-structure-delete.md')
    const frame = await openMarkdown(workbox, evaluateInVSCode, file, tight)
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
    await caretInItem(workbox, frame, 2, 'End')
    await settleForPublication(workbox)
    await resetCounters(frame, tight.length)
    await workbox.keyboard.press('Delete')
    await settleForPublication(workbox)
    const expected = tight.replace(
      '- tight item 3\n- tight item 4\n',
      '- tight item 3tight item 4\n',
    )
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)) === expected,
      )
      .toBe(true)
    const counters = await readCounters(frame, 'Delete at an item end')
    expect(counters.luteList).toBe(0)
    expect(counters.fallbackPublications).toBe(0)
    expect(await modelState(frame)).toBe('live')
  })

  test('Backspace at an item start still lifts the item to a paragraph (regression)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'list-structure-backspace.md')
    const frame = await openMarkdown(workbox, evaluateInVSCode, file, tight)
    await caretInItem(workbox, frame, 2, 'Home')
    await workbox.keyboard.press('Backspace')
    await settleForPublication(workbox)
    const text = (await docText(evaluateInVSCode as never, file)) as string
    expect(text.includes('tight item 2tight item 3')).toBe(false)
    expect(/^tight item 3$/mu.test(text)).toBe(true)
    expect(/^- tight item 2$/mu.test(text)).toBe(true)
    expect(/^- tight item 4$/mu.test(text)).toBe(true)
  })

  test('Enter in a loose list equals the whole-list drive', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    const result = await driveBothWays(
      workbox,
      evaluateInVSCode,
      baseDir,
      loose,
      async (frame) => {
        await caretInItem(workbox, frame, 1, 'End')
        await workbox.keyboard.press('Enter')
      },
      () => typeKeys(workbox, ['x']),
    )
    expect(result.hooked !== loose).toBe(true)
    expect(result.hooked === result.reference).toBe(true)
  })

  test('Home and Enter adds an empty item before the caret item (Q-87 Q-D)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'list-structure-home-enter.md')
    const frame = await openMarkdown(workbox, evaluateInVSCode, file, tight)
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
    await caretInItem(workbox, frame, 1, 'Home')
    await settleForPublication(workbox)
    await resetCounters(frame, tight.length)
    await workbox.keyboard.press('Enter')
    await settleForPublication(workbox)
    const expected = tight.replace('- tight item 2\n', '-\n- tight item 2\n')
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)) === expected,
      )
      .toBe(true)
    const counters = await readCounters(frame, 'Home and Enter')
    expect(counters.luteList).toBe(0)
    expect(counters.fallbackPublications).toBe(0)
    expect(await modelState(frame)).toBe('live')
  })

  test('an empty new item keeps the model live until it gets text (Q-56, Q-87 Q-C)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'list-structure-empty.md')
    const frame = await openMarkdown(workbox, evaluateInVSCode, file, tight)
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
    await caretInItem(workbox, frame, 2, 'End')
    await settleForPublication(workbox)
    await resetCounters(frame, tight.length)
    await workbox.keyboard.press('Enter')
    await settleForPublication(workbox)
    const empty = tight.replace('- tight item 3\n', '- tight item 3\n-\n')
    await expect
      .poll(
        async () => (await docText(evaluateInVSCode as never, file)) === empty,
      )
      .toBe(true)
    expect(await modelState(frame)).toBe('live')
    await typeKeys(workbox, ['z'])
    await settleForPublication(workbox)
    const typed = tight.replace('- tight item 3\n', '- tight item 3\n- z\n')
    await expect
      .poll(
        async () => (await docText(evaluateInVSCode as never, file)) === typed,
      )
      .toBe(true)
    const counters = await readCounters(frame, 'empty new item')
    expect(counters.fallbackPublications).toBe(0)
    expect(await modelState(frame)).toBe('live')
  })
})
