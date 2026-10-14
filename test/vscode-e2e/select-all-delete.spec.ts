/**
 * Task 617 S3 — whole-document Delete and type-over in the real VS Code webview, IR, with OS-level
 * XTEST keys (Ctrl+A twice, Delete, X, Ctrl+Z, Ctrl+S).
 *
 * Contract (task record): Select All's document stage followed by Delete leaves the empty
 * document `\n`; type-over `X` leaves `X\n`; one Undo restores the exact source bytes. The IR
 * `beforeinput` listener (`ir-whole-document-edit.ts`) owns only that one selection shape, so
 * everything else must stay native.
 *
 * Each test case opens its own fresh file, so a "fresh" case really runs on a one-entry undo history (the
 * state where Vditor's `recordFirstPosition` runs on the first keydown). A test case records its
 * observations and failure instead of stopping the test, so one product failure does not hide the
 * others. Large-fixture text stays out of failure output (lengths and booleans only).
 *
 * - T1 `fresh small documents`: Delete (paragraph-last, table-last, fence-last), Backspace
 *   (paragraph-last), type-over `X`
 *   (paragraph-last, fence-last) and a typed space (paragraph-last), each fresh. Acceptance 1, 2, 4, 5.
 * - T2 `large fixture`: fresh, and after Bold and its Undo (Task 621 variants). Acceptance 3.
 * - T3 `listener must not claim`: Ctrl+A inside a code block then Delete, a partial selection
 *   Delete, typing and Backspace in the Find input with a whole-document selection left behind.
 *   Each asserts the `beforeinput` event reached the window uncancelled.
 * - T4 `WYSIWYG and SV`: Select All + Delete in the other two modes (result recorded), then one
 *   Undo restores the bytes.
 * - T5 `save and reopen`: whole-document Delete, one Undo, save, reopen: disk bytes equal the source.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import { FIXTURE as LARGE } from './find-replace-fixture-helpers'
import {
  AFTER_SAVE_MS,
  type Ctx,
  closeAll,
  difference,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  expectHost,
  firstLine,
  hostState,
  type Kit,
  makeKit,
  type Mode,
  openDocument,
  openEditor,
  report,
  SMALL,
  select,
  selection,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { ExtensionId, waitForInitialUndoSnapshot } from './webview-helpers'

const TAG = 'task-617-s3'
const BLOCKS = {
  first: 'alpha **bold scope** omega',
  middle: 'left MIDDLE right',
  list: '- first item\n  - nested item',
  table: '| A | B |\n| --- | --- |\n| cell one | cell two |',
  fence: '```ts\nconst fence = true\n```',
  last: 'final paragraph',
}
const doc = (...parts: (keyof typeof BLOCKS)[]) =>
  `${parts.map((part) => BLOCKS[part]).join('\n\n')}\n`
const PARAGRAPH_LAST = doc('first', 'middle', 'list', 'table', 'fence', 'last')
const TABLE_LAST = doc('first', 'middle', 'list', 'fence', 'table')
const FENCE_LAST = doc('first', 'middle', 'list', 'table', 'fence')
// The caret goes into ` omega` of the first paragraph (as the Chromium cases do).
const SMALL_TOKEN = { token: 'omega', offset: 2 }
// A bold span of the large fixture, the same one the first-key Expand Selection spec uses.
const LARGE_TOKEN = 'Tllwmntrlw'
const WAIT_MS = 700 // between the two Ctrl+A presses and before the key under test
const LARGE_WAIT_MS = 1_200
const LARGE_TIMEOUT = 90_000

type CaseResults = Record<string, unknown>[]

// Runs one test case in its own freshly opened file; records its result, never throws.
async function runCase(
  results: CaseResults,
  kit: Kit,
  name: string,
  mode: Mode,
  content: string,
  body: (ctx: Ctx) => Promise<Record<string, unknown> | undefined>,
) {
  const result: Record<string, unknown> = { id: `${mode}:${name}` }
  let ctx: Ctx | undefined
  try {
    ctx = await openDocument(kit, `${TAG}-${results.length}.md`, content, mode)
    await evalFrame(kit, installInputRecorderInPage, 0)
    Object.assign(result, (await body(ctx)) ?? {})
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = firstLine(error)
    if (ctx)
      result.host = difference(
        (await hostState(ctx).catch(() => null))?.text ?? null,
        content,
      )
  } finally {
    if (ctx) {
      await disposeObservers(kit).catch(() => undefined)
      await closeAll(kit, ctx.file).catch(() => undefined)
    }
  }
  results.push(result)
  console.log(`[${TAG}]`, JSON.stringify(result))
}

// Records every `beforeinput` at the end of its propagation: `prevented` is true only when an
// earlier listener (the whole-document edit, Vditor, the SV edit) cancelled it.
function installInputRecorderInPage() {
  const page = window as any
  page.__s3Inputs = []
  window.addEventListener('beforeinput', (event) => {
    const input = event as InputEvent
    const target = input.target as Element | null
    page.__s3Inputs.push({
      type: input.inputType,
      data: input.data,
      prevented: input.defaultPrevented,
      target:
        target?.nodeName === 'INPUT' || target?.nodeName === 'TEXTAREA'
          ? target.nodeName
          : target?.closest?.('.vditor-reset')
            ? 'editor'
            : (target?.nodeName ?? null),
    })
  })
}

const inputsSince = (ctx: Ctx, from: number) =>
  evalFrame(
    ctx.kit,
    (_body, start: number) =>
      ((window as any).__s3Inputs as Record<string, unknown>[]).slice(start),
    from,
  )
const inputMark = (ctx: Ctx) =>
  evalFrame(ctx.kit, () => (window as any).__s3Inputs.length as number, 0)

function undoStacksInPage() {
  const inner = (window as any).vditor.vditor
  const history = inner.undo?.[inner.currentMode]
  return {
    undo: (history?.undoStack?.length ?? -1) as number,
    redo: (history?.redoStack?.length ?? -1) as number,
  }
}
const undoStacks = (ctx: Ctx) => evalFrame(ctx.kit, undoStacksInPage, 0)

// Select All's document stage in the exact form the listener owns: one Range from the editor
// root at 0 to the root at its child count.
function wholeDocumentRangeInPage() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const range = getSelection()?.rangeCount
    ? getSelection()!.getRangeAt(0)
    : null
  return Boolean(
    range &&
      range.startContainer === root &&
      range.startOffset === 0 &&
      range.endContainer === root &&
      range.endOffset === root.childNodes.length,
  )
}

const dirty = async (ctx: Ctx) => (await hostState(ctx)).dirty

// The caret in the first paragraph, Ctrl+A for the block stage, Ctrl+A for the document stage.
async function selectWholeDocument(
  ctx: Ctx,
  place: { token: string; offset: number },
  wait = WAIT_MS,
) {
  const { kit } = ctx
  await select(ctx, place.token, { collapsed: true, offset: place.offset })
  await endSelectionGesture(ctx)
  await kit.xtest.key('ctrl+a')
  await kit.workbox.waitForTimeout(wait)
  const first = await selection(ctx)
  await kit.xtest.key('ctrl+a')
  await kit.workbox.waitForTimeout(wait)
  const second = await selection(ctx)
  expect(first.whole, 'the first Ctrl+A is the block stage').toBe(false)
  expect(second.whole, 'the second Ctrl+A selects the whole document').toBe(
    true,
  )
  return { first, second }
}

// Acceptance 1 and 2: Select All twice, one key, the host holds `expected`, then one Undo
// restores the exact source and the document is clean again.
async function replaceAndUndo(
  ctx: Ctx,
  options: {
    place?: { token: string; offset: number }
    act: () => Promise<void>
    expected?: string
    wait?: number
    timeout?: number
  },
) {
  const { kit, initial } = ctx
  const wait = options.wait ?? WAIT_MS
  const timeout = options.timeout ?? 15_000
  await waitForInitialUndoSnapshot(kit.frame())
  const stacks = await undoStacks(ctx)
  const { second } = await selectWholeDocument(
    ctx,
    options.place ?? SMALL_TOKEN,
    wait,
  )
  expect(
    await evalFrame(kit, wholeDocumentRangeInPage, 0),
    'the Range is root 0 to root N',
  ).toBe(true)
  const mark = await inputMark(ctx)
  await options.act()
  if (options.expected !== undefined)
    await expectHost(ctx, options.expected, 'host after the key', timeout)
  else
    await expect
      .poll(async () => (await hostState(ctx)).text !== initial, {
        timeout,
        message: 'the source is replaced',
      })
      .toBe(true)
  const replaced = (await hostState(ctx)).text
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  await kit.xtest.key('ctrl+z')
  await expectHost(ctx, initial, 'host after one Undo', timeout)
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const afterUndo = await hostState(ctx)
  expect(afterUndo.text, 'one Undo restores the exact bytes').toBe(initial)
  expect(afterUndo.dirty, 'the document is clean after the Undo').toBe(false)
  return {
    stacksBefore: stacks,
    selectionLength: second.length,
    inputs: await inputsSince(ctx, mark),
    replacedLength: replaced?.length ?? null,
    initialLength: initial.length,
    stacksAfter: await undoStacks(ctx),
  }
}

const expectFresh = async (ctx: Ctx) => {
  await waitForInitialUndoSnapshot(ctx.kit.frame())
  const stacks = await undoStacks(ctx)
  expect(stacks, 'a fresh document has a one-entry history').toEqual({
    undo: 1,
    redo: 0,
  })
}

const extensionActive = (kit: Kit) =>
  kit.host(
    (vscode, [id]: [string]) =>
      vscode.extensions.getExtension(id)?.isActive ?? false,
    [ExtensionId],
  )

test.describe('Task 617 S3 whole-document Delete and type-over (OS-level XTEST, IR)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('T1: fresh small documents: Delete and type-over replace everything, one Undo restores the bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    expect(await extensionActive(kit)).toBe(true)
    const results: CaseResults = []
    const cases: [string, string, string, string?][] = [
      // [name, document, key, expected]; Acceptance 1/2 and the Task 616 and control items.
      [
        'delete paragraph-last (acceptance 1, 2)',
        PARAGRAPH_LAST,
        'Delete',
        '\n',
      ],
      ['delete fence-last (acceptance 4)', FENCE_LAST, 'Delete', '\n'],
      ['delete table-last (control, acceptance 5)', TABLE_LAST, 'Delete', '\n'],
      [
        'backspace paragraph-last (edge case)',
        PARAGRAPH_LAST,
        'BackSpace',
        '\n',
      ],
      ['type X paragraph-last (acceptance 1, 2)', PARAGRAPH_LAST, 'X', 'X\n'],
      ['type X fence-last (acceptance 4)', FENCE_LAST, 'X', 'X\n'],
      // The review's HIGH case: a typed space must still record an Undo step.
      [
        'type space paragraph-last (acceptance 2, review HIGH)',
        PARAGRAPH_LAST,
        ' ',
      ],
    ]
    for (const [name, content, key, expected] of cases)
      await runCase(results, kit, name, 'ir', content, async (ctx) => {
        await expectFresh(ctx)
        return replaceAndUndo(ctx, {
          expected,
          act: () =>
            key.length === 1 ? kit.xtest.type(key, 20) : kit.xtest.key(key),
        })
      })
    report('T1', results, TAG)
  })

  test('T2: large fixture, fresh and after Bold and its Undo: Delete empties the document, one Undo restores it', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const results: CaseResults = []
    const place = { token: LARGE_TOKEN, offset: 3 }
    const deleteLarge = (ctx: Ctx) =>
      replaceAndUndo(ctx, {
        place,
        act: () => kit.xtest.key('Delete'),
        expected: '\n',
        wait: LARGE_WAIT_MS,
        timeout: LARGE_TIMEOUT,
      })

    // Task 621, fresh variant (acceptance 3, edge case: the one-entry history on a large document).
    await runCase(results, kit, 'large fresh', 'ir', LARGE, async (ctx) => {
      expect(ctx.large, 'the large fixture').toBe(true)
      await expectFresh(ctx)
      return deleteLarge(ctx)
    })

    // Task 621, Bold and Undo variant: the after-Undo tail loss must not appear (acceptance 3).
    await runCase(
      results,
      kit,
      'large after Bold and Undo',
      'ir',
      LARGE,
      async (ctx) => {
        await waitForInitialUndoSnapshot(kit.frame())
        await select(ctx, LARGE_TOKEN)
        await endSelectionGesture(ctx)
        await kit.xtest.key('ctrl+b')
        await expect
          .poll(async () => (await hostState(ctx)).text !== ctx.initial, {
            timeout: LARGE_TIMEOUT,
            message: 'Bold edits the host',
          })
          .toBe(true)
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        await kit.xtest.key('ctrl+z')
        await expectHost(
          ctx,
          ctx.initial,
          'host after the Bold Undo',
          LARGE_TIMEOUT,
        )
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        const stacks = await undoStacks(ctx)
        expect(
          stacks.redo,
          'the Bold Undo leaves a redo step',
        ).toBeGreaterThanOrEqual(1)
        const outcome = await deleteLarge(ctx)
        return { stacksAfterBoldUndo: stacks, ...outcome }
      },
    )
    report('T2', results, TAG)
  })

  test('T3: the listener does not claim code block, partial selection or Find input edits', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const results: CaseResults = []

    // Ctrl+A inside a code block selects the code, so Delete removes only the code body.
    await runCase(
      results,
      kit,
      'Ctrl+A in a code block, Delete',
      'ir',
      PARAGRAPH_LAST,
      async (ctx) => {
        await waitForInitialUndoSnapshot(kit.frame())
        expect(
          await evalFrame(kit, placeInFenceInPage, 0),
          'caret in the code',
        ).toBe(true)
        await endSelectionGesture(ctx)
        await kit.xtest.key('ctrl+a')
        await kit.workbox.waitForTimeout(WAIT_MS)
        const blockStage = await selection(ctx)
        expect(
          blockStage.whole,
          'Ctrl+A in the code is not the whole document',
        ).toBe(false)
        expect(blockStage.head.trim(), 'Ctrl+A selects the code body').toBe(
          'const fence = true',
        )
        const mark = await inputMark(ctx)
        await kit.xtest.key('Delete')
        await expect
          .poll(
            async () =>
              ((await hostState(ctx)).text ?? '').includes('const fence'),
            {
              timeout: 15_000,
              message: 'the code body is deleted',
            },
          )
          .toBe(false)
        const text = (await hostState(ctx)).text ?? ''
        for (const kept of [
          BLOCKS.first,
          BLOCKS.middle,
          BLOCKS.list,
          BLOCKS.table,
          BLOCKS.last,
          '```ts',
        ])
          expect(text, `kept: ${kept.slice(0, 12)}`).toContain(kept)
        const inputs = await inputsSince(ctx, mark)
        expect(
          inputs.filter((input) => input.prevented),
          'the delete reached the editor uncancelled',
        ).toEqual([])
        expect(inputs.length, 'one delete input').toBeGreaterThanOrEqual(1)
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        await kit.xtest.key('ctrl+z')
        await expectHost(ctx, ctx.initial, 'one Undo restores the bytes')
        return { inputs }
      },
    )

    // A partial selection (two letters inside one word): the browser deletes exactly those characters.
    await runCase(
      results,
      kit,
      'partial selection Delete',
      'ir',
      PARAGRAPH_LAST,
      async (ctx) => {
        await waitForInitialUndoSnapshot(kit.frame())
        await select(ctx, 'DD')
        await endSelectionGesture(ctx)
        const mark = await inputMark(ctx)
        await kit.xtest.key('Delete')
        await expectHost(
          ctx,
          PARAGRAPH_LAST.replace('MIDDLE', 'MILE'),
          'only the selected characters are deleted',
        )
        const inputs = await inputsSince(ctx, mark)
        expect(
          inputs.filter((input) => input.prevented),
          'the delete reached the editor uncancelled',
        ).toEqual([])
        return { inputs }
      },
    )

    // Typing and Backspace in the Find input while a whole-document Range is still the live
    // selection of the editor: the Find input must edit its own text, the document stays.
    await runCase(
      results,
      kit,
      'Find input typing',
      'ir',
      PARAGRAPH_LAST,
      async (ctx) => {
        await waitForInitialUndoSnapshot(kit.frame())
        await selectWholeDocument(ctx, SMALL_TOKEN)
        await kit.xtest.key('ctrl+f')
        const find = kit.frame().locator('.vmde-find-replace [data-find]')
        await expect(find).toBeVisible({ timeout: 10_000 })
        await expect(find).toBeFocused()
        await kit.xtest.key('ctrl+a') // selects the Find input's text
        const mark = await inputMark(ctx)
        await kit.xtest.type('zq', 20)
        await expect(find).toHaveValue('zq')
        await kit.xtest.key('BackSpace')
        await expect(find).toHaveValue('z')
        const inputs = await inputsSince(ctx, mark)
        expect(
          inputs.length,
          'the Find input received edits',
        ).toBeGreaterThanOrEqual(2)
        expect(
          inputs.filter((input) => input.prevented || input.target !== 'INPUT'),
          'every edit stayed in the Find input, uncancelled',
        ).toEqual([])
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        const state = await hostState(ctx)
        expect(state.text, 'the document is untouched').toBe(ctx.initial)
        expect(state.dirty, 'the document is clean').toBe(false)
        await kit.xtest.key('Escape')
        return { inputs }
      },
    )
    report('T3', results, TAG)
  })

  test('T4: WYSIWYG and SV: Select All + Delete result recorded, one Undo restores the bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const results: CaseResults = []
    for (const mode of ['wysiwyg', 'sv'] as const)
      await runCase(
        results,
        kit,
        'Select All + Delete',
        mode,
        SMALL,
        async (ctx) => {
          await waitForInitialUndoSnapshot(kit.frame())
          const stacks = await undoStacks(ctx)
          await select(ctx, 'moveword', { collapsed: true, offset: 2 })
          await endSelectionGesture(ctx)
          const stages: unknown[] = []
          // Select All until the whole document (at most three presses), recording each stage.
          for (let press = 1; press <= 3; press++) {
            await kit.xtest.key('ctrl+a')
            await kit.workbox.waitForTimeout(WAIT_MS)
            const current = await selection(ctx)
            stages.push({ press, whole: current.whole, length: current.length })
            if (current.whole) break
          }
          const mark = await inputMark(ctx)
          await kit.xtest.key('Delete')
          await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
          const afterDelete = await hostState(ctx)
          const inputs = await inputsSince(ctx, mark)
          await kit.xtest.key('ctrl+z')
          await expectHost(ctx, ctx.initial, 'one Undo restores the bytes')
          return {
            recorded: {
              stacks,
              stages,
              hostAfterDelete: JSON.stringify(afterDelete.text),
              dirtyAfterDelete: afterDelete.dirty,
              inputs,
            },
          }
        },
      )
    report('T4', results, TAG)
  })

  test('T5: save and reopen after a whole-document Delete and Undo: disk bytes equal the source', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const results: CaseResults = []
    await runCase(
      results,
      kit,
      'Delete, Undo, save, reopen',
      'ir',
      PARAGRAPH_LAST,
      async (ctx) => {
        await expectFresh(ctx)
        await selectWholeDocument(ctx, SMALL_TOKEN)
        await kit.xtest.key('Delete')
        await expectHost(ctx, '\n', 'host after Delete')
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        await kit.xtest.key('ctrl+z')
        await expectHost(ctx, ctx.initial, 'host after one Undo')
        await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
        const dirtyAtSave = await dirty(ctx)
        await kit.xtest.key('ctrl+s')
        await kit.workbox.waitForTimeout(AFTER_SAVE_MS)
        const saved = await hostState(ctx)
        const disk = readFileSync(ctx.file)
        expect(
          disk.equals(Buffer.from(ctx.initial)),
          'disk bytes after the save',
        ).toBe(true)
        expect(saved.dirty, 'clean after the save').toBe(false)
        // Reopen from disk.
        await closeAll(kit, ctx.file)
        await openEditor(ctx)
        const reopened = await hostState(ctx)
        expect(reopened.text, 'reopened host text').toBe(ctx.initial)
        expect(
          readFileSync(ctx.file).equals(Buffer.from(ctx.initial)),
          'disk bytes after the reopen',
        ).toBe(true)
        return {
          dirtyAtSave,
          didSaves: saved.didSaves.length,
          savedTextExact: saved.didSaves.every((text) => text === ctx.initial),
          reopenedClean: reopened.dirty === false,
        }
      },
    )
    report('T5', results, TAG)
  })
})

// The caret in the fence source (`const fence`): the block is marked expanded so its source shows,
// as the structural selection spec does.
function placeInFenceInPage(): boolean {
  const block = document.querySelector<HTMLElement>(
    '.vditor-ir [data-type="code-block"]',
  )
  const source = block?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
  if (!block || !source) return false
  block.classList.add('vditor-ir__node--expand')
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.textContent ?? '').includes('const fence')) continue
    source.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(node, 3)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).__vmdeRequestCaret?.({ node, offset: 3 })
    return true
  }
  return false
}
