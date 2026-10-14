import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

test.beforeEach(async ({ page }) => {
  await page.goto('/structural-selection.html')
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.waitForTimeout(250) // let Vditor's asynchronous code render settle before exact ranges
})

const focusText = (page: Page, needle: string) =>
  page.evaluate(
    (text) =>
      (
        window as unknown as { __focusText(needle: string): boolean }
      ).__focusText(text),
    needle,
  )

const focusFenceSource = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __focusFenceSource(): Promise<boolean> }
    ).__focusFenceSource(),
  )

const selectFenceSourceStage = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __selectFenceSourceStage(): Promise<boolean> }
    ).__selectFenceSourceStage(),
  )

const selectionText = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __selectionText(): string }).__selectionText(),
  )

const markdown = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { vditor: { getValue(): string } }).vditor.getValue(),
  )

const copySelection = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __copySelection(): { plain: string; html: string }
      }
    ).__copySelection(),
  )

// Task 580 CP2-6 — Expand Selection's Windows/Linux key (VS Code's smartSelect.expand), run through
// the harness's keybinding shim. Ctrl+E no longer expands.
const EXPAND = 'Shift+Alt+ArrowRight'

const expandedTypes = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __expandedTypes(): string[] }).__expandedTypes(),
  )

test('Ctrl+A stages current block → whole document and block-copy restores Markdown', async ({
  page,
}) => {
  expect(await focusText(page, 'alpha')).toBe(true)
  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  expect(await copySelection(page)).toEqual({
    plain: 'alpha **bold scope** omega',
    html: '',
  })

  await page.keyboard.press('Control+a')
  const all = await selectionText(page)
  expect(all).toContain('alpha bold scope omega')
  expect(all).toContain('final paragraph')
})

test('a fence keeps Vditor source stage 0, then widens fence block → document', async ({
  page,
}) => {
  expect(await selectFenceSourceStage(page)).toBe(true)
  expect((await selectionText(page)).trim()).toBe('const fence = true')

  await page.keyboard.press('Control+a')
  const fenceSelection = await selectionText(page)
  expect(fenceSelection).toContain('const fence = true')
  const copied = await copySelection(page)
  expect(copied.plain).toContain('```ts')
  expect(copied.plain).toContain('const fence = true')
  expect(copied.plain).toContain('```')
  expect(copied.html).toBe('')

  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toContain('final paragraph')
})

test('Expand Selection selects marker-free inline content and type-over preserves the style', async ({
  page,
}) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('bold scope')
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('.vditor-ir .vditor-reset')
      ?.focus({ preventScroll: true })
  })
  expect(await selectionText(page)).toBe('bold scope')
  await page.keyboard.type('REPLACED')
  await expect.poll(() => markdown(page)).toContain('alpha **REPLACED** omega')
})

test('repeated Expand Selection widens inline → paragraph → document', async ({
  page,
}) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('bold scope')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('alpha')
  expect(await selectionText(page)).toContain('omega')
  expect((await copySelection(page)).plain).toBe('alpha **bold scope** omega')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('final paragraph')
})

test('table Expand Selection widens cell → table block → document', async ({
  page,
}) => {
  expect(await focusText(page, 'cell one')).toBe(true)
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toBe('cell one')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('cell two')
  expect((await copySelection(page)).plain).toContain('| cell one | cell two |')
  await page.keyboard.press(EXPAND)
  expect(await selectionText(page)).toContain('final paragraph')
})

test('Ctrl+A selects the nested list item rather than the outer list', async ({
  page,
}) => {
  expect(await focusText(page, 'nested item')).toBe(true)
  await page.keyboard.press('Control+a')
  const selected = await selectionText(page)
  expect(selected).toContain('nested item')
  expect(selected).not.toContain('first item')
})

test('Ctrl+E no longer selects anything in the editor', async ({ page }) => {
  expect(await focusText(page, 'bold scope')).toBe(true)
  await page.keyboard.press('Control+e')
  expect(await selectionText(page)).toBe('')
  expect(await markdown(page)).toContain('alpha **bold scope** omega')
})

test('Ctrl+A from a caret in the fence source selects the code first', async ({
  page,
}) => {
  expect(await focusFenceSource(page)).toBe(true)
  await page.keyboard.press('Control+a')
  expect((await selectionText(page)).trim()).toBe('const fence = true')
  await page.keyboard.press('Control+a')
  expect((await copySelection(page)).plain).toContain('```ts')
  await page.keyboard.press('Control+a')
  expect(await selectionText(page)).toContain('final paragraph')
})

// Task 580 CP4-3d: Vditor takes its first undo snapshot `undoDelay` after init, and its caret
// restore goes through caret.ts (the harness installs the caret window bridge since Task 613).
// Under parallel load it landed after the Escape ladder's caret or Escape step and moved the caret
// back into the inline marker. The real-VS-Code specs wait the same way (waitForInitialUndoSnapshot).
const waitForInitialUndoSnapshot = (page: Page) =>
  page.waitForFunction(() => {
    const inner = (
      window as unknown as {
        vditor?: {
          vditor?: {
            currentMode?: string
            undo?: Record<string, { undoStack?: unknown[] } | undefined>
          }
        }
      }
    ).vditor?.vditor
    const mode = inner?.currentMode
    return mode ? (inner?.undo?.[mode]?.undoStack?.length ?? 0) >= 1 : false
  })

test('Esc collapses the inline marker, then selects its block; Esc→Tab still exits', async ({
  page,
}) => {
  await waitForInitialUndoSnapshot(page)
  expect(await focusText(page, 'bold scope')).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { __expandedTypes(): string[] }
        ).__expandedTypes(),
      ),
    )
    .toContain('strong')

  await page.keyboard.press('Escape')
  expect(
    await page.evaluate(() =>
      (window as unknown as { __expandedTypes(): string[] }).__expandedTypes(),
    ),
  ).not.toContain('strong')
  expect(await selectionText(page)).toBe('')

  await page.keyboard.press('Escape')
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  await page.keyboard.press('Tab')
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.closest('[role="toolbar"]') !== null,
      ),
    )
    .toBe(true)
})

test('triple-click normalizes a fence to marker-inclusive block copy', async ({
  page,
}) => {
  expect(await focusFenceSource(page)).toBe(true)
  await expect.poll(() => expandedTypes(page)).toContain('code-block')
  await page
    .locator(
      '.vditor-ir [data-type="code-block"] > .vditor-ir__marker--pre > code',
    )
    .click({ clickCount: 3 })
  const copied = await copySelection(page)
  expect(copied.plain).toContain('```ts')
  expect(copied.plain).toContain('const fence = true')
  expect(copied.plain).toContain('```')
})

test('triple-click paragraph type-over leaves no orphan inline markers', async ({
  page,
}) => {
  await page
    .locator('.vditor-ir p')
    .filter({ hasText: 'alpha' })
    .click({ clickCount: 3 })
  await expect.poll(() => selectionText(page)).toBe('alpha bold scope omega')
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('.vditor-ir .vditor-reset')
      ?.focus({ preventScroll: true })
  })
  expect(await selectionText(page)).toBe('alpha bold scope omega')
  await page.keyboard.type('WHOLE BLOCK')
  await expect.poll(() => markdown(page)).toContain('WHOLE BLOCK')
  const value = await markdown(page)
  expect(value).not.toContain('bold scope')
  expect(value).not.toContain('**')
})

// Task 613 — Vditor's undo snapshot runs `undoDelay` after an edit and restores the selection
// through the caret authority. A whole-document (or table block) Range has its endpoints on the
// editable root itself; the snapshot must keep that Range, not collapse it to the document start.
const undoDelay = (page: Page) =>
  page.evaluate(
    () =>
      ((window as any).vditor.vditor.options.undoDelay as number | undefined) ??
      800,
  )

const rangeEnds = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const describe = (node: Node | undefined) =>
      node === editor
        ? 'root'
        : node instanceof Element
          ? node.tagName
          : (node?.nodeName ?? 'none')
    return {
      start: describe(range?.startContainer),
      startOffset: range?.startOffset ?? -1,
      end: describe(range?.endContainer),
      endOffset: range?.endOffset ?? -1,
      children: editor.childNodes.length,
    }
  })

const tableRange = (page: Page) =>
  page.evaluate(() => {
    const table = document.querySelector('.vditor-ir table')!
    const parent = table.parentNode!
    const index = Array.prototype.indexOf.call(parent.childNodes, table)
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      start: parent === editor ? 'root' : (parent as Element).tagName,
      startOffset: index,
      end: parent === editor ? 'root' : (parent as Element).tagName,
      endOffset: index + 1,
      children: editor.childNodes.length,
    }
  })

test('Select All right after an edit keeps the whole document past the undo snapshot', async ({
  page,
}) => {
  expect(await focusText(page, 'final paragraph')).toBe(true)
  await page.keyboard.type('Z')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+a')
  const whole = await rangeEnds(page)
  expect(whole).toEqual({
    start: 'root',
    startOffset: 0,
    end: 'root',
    endOffset: whole.children,
    children: whole.children,
  })
  await page.waitForTimeout((await undoDelay(page)) + 200) // negative assertion: nothing moves it
  expect(await rangeEnds(page)).toEqual(whole)
})

test('the table block stage survives the undo snapshot of an edit in the table', async ({
  page,
}) => {
  expect(await focusText(page, 'cell one')).toBe(true)
  await page.keyboard.type('X')
  await page.keyboard.press('Control+a')
  const block = await tableRange(page)
  expect(await rangeEnds(page)).toEqual(block)
  await page.waitForTimeout((await undoDelay(page)) + 200) // negative assertion: nothing moves it
  expect(await rangeEnds(page)).toEqual(block)
})

const undoOnce = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __undoFindReplace(): void }).__undoFindReplace(),
  )

// Task 613 — Delete and type-over of the whole document after the snapshot has run. The opening
// snapshot settles first, so the typed edit makes the history non-initial, as in the real flow: a
// first keydown on a one-entry history runs Vditor's recordFirstPosition, which still desyncs a
// root selection (the task record's follow-up).
for (const [label, act, expected] of [
  ['Delete', (page: Page) => page.keyboard.press('Delete'), '\n'],
  ['type-over', (page: Page) => page.keyboard.type('X'), 'X\n'],
] as const) {
  test(`${label} of a whole-document selection past the undo snapshot replaces everything and one Undo restores it`, async ({
    page,
  }) => {
    const wait = (await undoDelay(page)) + 200
    await page.waitForTimeout(wait) // Vditor's opening snapshot is debounced by undoDelay too
    expect(await focusText(page, 'final paragraph')).toBe(true)
    await page.keyboard.type('Z')
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+a')
    await page.waitForTimeout(wait) // past the typed edit's snapshot, which must keep the Range
    const original = await markdown(page)
    expect(original).toContain('final pZaragraph')
    const whole = await rangeEnds(page)
    expect(whole).toMatchObject({ start: 'root', startOffset: 0, end: 'root' })
    expect(whole.endOffset).toBe(whole.children)

    await act(page)
    await expect.poll(() => markdown(page)).toBe(expected)
    await page.waitForTimeout(wait) // record the replacement as its own Undo step
    await undoOnce(page)
    await expect.poll(() => markdown(page)).toBe(original)
  })
}

// Task 617 — whole-document Delete in IR. Select All twice (block stage, then document stage) must
// select the whole rendered text; Delete must then leave the empty document `\n` (type-over `X`
// leaves `X\n`) and one Undo must restore the exact source. A fresh one-entry history runs Vditor's
// recordFirstPosition on the first keydown, whose addCaret marker insert leaves Chromium's internal
// selection short while the DOM Range still reports the whole document. A closing fence in any
// history keeps its close marker, and the large document lost a tail after an edit and its Undo in
// real VS Code (these large after-Undo cases pass in this harness; they hold the acceptance item
// for the Chromium layer). The paragraph-last (`default`) and table-last documents after an edit
// are the controls.
const openDocument = async (page: Page, doc: string) => {
  await page.goto(`/structural-selection.html?doc=${doc}`)
  await page.waitForFunction(
    () => (window as unknown as { __ready?: boolean }).__ready,
  )
  await page.waitForTimeout(250) // let Vditor's asynchronous code render settle before exact ranges
}

const undoStackLengths = (page: Page) =>
  page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    const stacks = inner.undo[inner.currentMode]
    return {
      undo: stacks.undoStack.length as number,
      redo: stacks.redoStack.length as number,
    }
  })

// The length of the whole rendered text of the editable root: `Selection.toString()` over a
// programmatic root selection, read before any key of the case (no first-keydown marker insert has
// run yet). Raw `innerText` and Range text are not comparable: they count text the selection's own
// text serialization leaves out.
const wholeRenderedTextLength = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const selection = getSelection()!
    selection.selectAllChildren(root)
    const length = selection.toString().length
    selection.removeAllRanges()
    return length
  })

const liveSelectionTextLength = (page: Page) =>
  page.evaluate(() => getSelection()?.toString().length ?? -1)

const hasLargeDocumentClass = (page: Page) =>
  page.evaluate(() => document.body.classList.contains('vmde-large-doc'))

// The caret goes into the first paragraph's ` omega` node: an Undo's caret restore splits the
// `alpha ` node, so the edit's own needle is not found again after it.
const selectWholeDocument = async (page: Page) => {
  expect(await focusText(page, 'omega')).toBe(true)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+a')
  const ends = await rangeEnds(page)
  expect(ends).toMatchObject({ start: 'root', startOffset: 0, end: 'root' })
  expect(ends.endOffset).toBe(ends.children)
}

// A large document re-renders for seconds after Undo, so its polls wait longer than the default.
const softMarkdown = (page: Page, timeout?: number) =>
  expect.configure({ soft: true }).poll(() => markdown(page), { timeout })

type DeleteHistory = 'fresh' | 'after-edit-undo' | 'pending-snapshot'

// Each row names the acceptance item or edge case it proves. `fresh` rows prove the one-entry
// history item; `after-edit-undo` rows on `large` and `large-cv` prove the Task 621 item (with and
// without the large-document class); `fence-last` rows prove the Task 616 item; the `default` and
// `table-last` rows after an edit are the unchanged-result controls.
const wholeDocumentDeleteCases: ReadonlyArray<{
  doc: string
  history: DeleteHistory
  proves: string
  key?: 'Delete' | 'Backspace'
}> = [
  {
    doc: 'default',
    history: 'fresh',
    proves: 'acceptance: fresh one-entry history',
  },
  {
    doc: 'default',
    history: 'after-edit-undo',
    proves: 'control: paragraph-last unchanged',
  },
  {
    doc: 'table-last',
    history: 'after-edit-undo',
    proves: 'control: table-last unchanged',
  },
  {
    doc: 'fence-last',
    history: 'fresh',
    proves: 'acceptance: fence last, fresh history',
  },
  {
    doc: 'fence-last',
    history: 'after-edit-undo',
    proves: 'acceptance: fence last, no leftover closing fence',
  },
  {
    doc: 'fence-last',
    history: 'pending-snapshot',
    proves: 'acceptance: fence last, pending snapshot',
  },
  {
    doc: 'fence-last',
    history: 'after-edit-undo',
    key: 'Backspace',
    proves: 'edge case: Backspace takes the same whole-document route',
  },
  {
    doc: 'large',
    history: 'fresh',
    proves: 'edge case: large document without the class, fresh history',
  },
  {
    doc: 'large',
    history: 'after-edit-undo',
    proves: 'acceptance: large document without the class, after edit and Undo',
  },
  {
    doc: 'large-cv',
    history: 'fresh',
    proves: 'edge case: large document with the class, fresh history',
  },
  {
    doc: 'large-cv',
    history: 'after-edit-undo',
    proves: 'acceptance: large document with the class, after edit and Undo',
  },
]

// Opens `doc`, builds `history`, and selects the whole document with the live selection checked
// against the whole rendered text. Returns the source before any edit, the wait that settles a
// snapshot and the poll timeout (a large document re-renders for seconds).
const prepareWholeDocument = async (
  page: Page,
  doc: string,
  history: DeleteHistory,
) => {
  await openDocument(page, doc)
  if (doc.startsWith('large'))
    expect(await hasLargeDocumentClass(page)).toBe(doc === 'large-cv')
  if (doc.startsWith('large'))
    expect((await markdown(page)).length).toBeGreaterThan(100_000)
  const wait = (await undoDelay(page)) + 200
  const pollTimeout = doc.startsWith('large') ? 60_000 : 5_000
  await page.waitForTimeout(wait) // Vditor's opening snapshot is debounced by undoDelay too
  const original = await markdown(page)

  if (history === 'fresh') {
    expect(await undoStackLengths(page)).toEqual({ undo: 1, redo: 0 })
  } else {
    expect(await focusText(page, 'alpha')).toBe(true)
    await page.keyboard.type('Z')
    if (history === 'after-edit-undo') {
      await page.waitForTimeout(wait) // the edit's own snapshot
      await undoOnce(page)
      await expect
        .poll(() => markdown(page), { timeout: pollTimeout })
        .toBe(original)
    }
  }

  if (history === 'pending-snapshot')
    expect(await markdown(page)).not.toBe(original) // the edit is still unsnapshotted
  const rendered = await wholeRenderedTextLength(page)
  await selectWholeDocument(page)
  expect.soft(await liveSelectionTextLength(page)).toBe(rendered)
  return { original, wait, pollTimeout }
}

for (const {
  doc,
  history,
  proves,
  key = 'Delete',
} of wholeDocumentDeleteCases) {
  test(`Task 617 ${key} of the whole ${doc} document, ${history} history (${proves}) empties it and one Undo restores it`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const { original, wait, pollTimeout } = await prepareWholeDocument(
      page,
      doc,
      history,
    )
    await page.keyboard.press(key)
    await softMarkdown(page, pollTimeout).toBe('\n')
    await page.waitForTimeout(wait) // record the replacement as its own Undo step
    await undoOnce(page)
    await softMarkdown(page, pollTimeout).toBe(original)
  })
}

// Task 617 acceptance 1, 2 and 4: type-over of the whole document replaces everything with the
// typed text and one Undo restores the exact source, for a fresh history, a pending snapshot and
// after an edit and its Undo, on the paragraph-last and fence-last documents. A typed space is
// whitespace Vditor's IR input path treats specially (a raw space records no snapshot); `X ` is
// an `insertText` whose data ends in a space. The last two rows are the whole-document edit's
// type-over of the text itself; their sources are not fixed by the contract, so only "the
// original is gone, one Undo restores it" is asserted for them.
const wholeDocumentTypeOverCases: ReadonlyArray<{
  doc: string
  history: DeleteHistory
  text: string
  expected?: string
  proves: string
}> = [
  {
    doc: 'default',
    history: 'fresh',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: X replaces everything',
  },
  {
    doc: 'fence-last',
    history: 'fresh',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: X replaces everything, fence last',
  },
  {
    doc: 'default',
    history: 'pending-snapshot',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: pending snapshot',
  },
  {
    doc: 'default',
    history: 'after-edit-undo',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: after an edit and its Undo',
  },
  {
    doc: 'fence-last',
    history: 'pending-snapshot',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: fence last, pending snapshot',
  },
  {
    doc: 'fence-last',
    history: 'after-edit-undo',
    text: 'X',
    expected: 'X\n',
    proves: 'acceptance: fence last, after an edit and its Undo',
  },
  {
    doc: 'default',
    history: 'fresh',
    text: ' ',
    proves: 'acceptance 2: a typed space still records an Undo step',
  },
  {
    doc: 'default',
    history: 'fresh',
    text: 'X ',
    proves: 'acceptance 2: text ending in a space still records an Undo step',
  },
]

for (const {
  doc,
  history,
  text,
  expected,
  proves,
} of wholeDocumentTypeOverCases) {
  test(`Task 617 type-over of "${text}" on the whole ${doc} document, ${history} history (${proves}) and one Undo restores it`, async ({
    page,
  }) => {
    const { original, wait } = await prepareWholeDocument(page, doc, history)
    // `insertText` produces one insertText input event with the whole data, as a typed character does.
    if (text.length > 1) await page.keyboard.insertText(text)
    else await page.keyboard.type(text)
    if (expected !== undefined) await softMarkdown(page).toBe(expected)
    else await softMarkdown(page).not.toBe(original)
    await page.waitForTimeout(wait)
    await undoOnce(page)
    await softMarkdown(page).toBe(original)
    // The replacement was one Undo step: nothing is left to undo beyond the original.
    expect(await undoStackLengths(page)).toEqual({ undo: 1, redo: 1 })
  })
}

// Task 617 edge case: the caret stays in the document after a whole-document replacement, so the
// next typed character lands in it. The editor root may hold one empty paragraph here; that
// state is an empty document, not a defect.
for (const { doc, history, first, second, expected } of [
  {
    doc: 'fence-last',
    history: 'after-edit-undo',
    first: 'Delete',
    second: 'Q',
    expected: 'Q\n',
  },
  {
    doc: 'default',
    history: 'fresh',
    first: 'X',
    second: 'Y',
    expected: 'XY\n',
  },
] as const) {
  test(`Task 617 typing "${second}" after ${first} over the whole ${doc} document, ${history} history (edge case: the caret stays in the document) lands in it`, async ({
    page,
  }) => {
    await prepareWholeDocument(page, doc, history)
    if (first === 'Delete') await page.keyboard.press('Delete')
    else await page.keyboard.type(first)
    await page.keyboard.type(second)
    await softMarkdown(page).toBe(expected)
  })
}
