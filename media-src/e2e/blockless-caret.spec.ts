import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { BlocklessCaretHarness } from './blockless-caret-harness'
import { expect, test } from './coverage-fixture'

const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n'
// Pinned from the unchanged-HEAD real-VS-Code content-start toolbar reference in Task 600 S3a.
// The Owner permits only **Q**Probe or **QProbe** here; the measured route chose the former.
const EXPECTED_BOLD = DOC.replace('# Probe', '# **Q**Probe')
const OUTPUT = path.resolve(
  __dirname,
  '../../tmp/task600-checks/s3b/observations/chromium',
)

const caret = (page: Page) =>
  page.evaluate(() => (window as unknown as BlocklessCaretHarness).__caret())
const value = (page: Page) =>
  page.evaluate(() => (window as unknown as BlocklessCaretHarness).__value())

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function press(page: Page, key: string) {
  await page.keyboard.press(key)
  await frames(page)
}

async function open(page: Page, doc = 'heading') {
  await page.goto(`/blockless-caret.html?doc=${doc}`)
  await page.waitForFunction(
    () => (window as unknown as BlocklessCaretHarness).__ready,
  )
  await frames(page)
}

async function record(page: Page, extra: Record<string, unknown> = {}) {
  const result = {
    title: test.info().title,
    caret: await caret(page),
    value: await value(page),
    ...extra,
  }
  mkdirSync(OUTPUT, { recursive: true })
  const body = JSON.stringify(result, null, 2)
  writeFileSync(
    path.join(OUTPUT, `${test.info().title.replace(/[^a-z0-9-]/gi, '_')}.json`),
    body,
  )
  await test
    .info()
    .attach('task600-observation', { body, contentType: 'application/json' })
  return result
}

async function homeFromEcho(page: Page) {
  await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
  await frames(page)
  expect((await caret(page)).blockText).toContain('Echo')
  await press(page, 'Control+Home')
  return caret(page)
}

test('L1 Ctrl+Home stays at heading content start', async ({ page }) => {
  await open(page)
  await homeFromEcho(page)
  const result = await record(page)
  expect(result.caret).toMatchObject({
    isRoot: false,
    inEditor: true,
    inHeading: true,
    anchorText: 'Probe',
    anchorOffset: 0,
  })
})

test('L2 Ctrl+Home then toolbar Bold inserts inside the heading', async ({
  page,
}) => {
  await open(page)
  const afterHome = await homeFromEcho(page)
  await page.locator('.vditor-toolbar [data-type="bold"]').click()
  await frames(page)
  const afterBold = await value(page)
  await page.keyboard.type('Q')
  await frames(page)
  const result = await record(page, {
    afterHome,
    afterBold,
    expected: EXPECTED_BOLD,
    pinStatus: 'measured-real-vscode-reference',
  })
  expect.soft(afterBold).not.toMatch(/^\*\*\*\*/)
  expect(result.value).toBe(EXPECTED_BOLD)
})

test('L3 ArrowRight escapes a seeded root caret within three presses', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__seedRoot(0),
  )
  await frames(page)
  expect((await caret(page)).isRoot).toBe(true)
  const steps = []
  for (let i = 0; i < 3; i++) {
    await press(page, 'ArrowRight')
    steps.push(await caret(page))
  }
  await record(page, { steps })
  expect.soft(steps.every((step) => step.inEditor && !step.isRoot)).toBe(true)
  expect(steps.at(-1)).toMatchObject({ anchorText: 'Probe', inHeading: true })
  expect(steps.at(-1)!.anchorOffset).toBeGreaterThanOrEqual(1)
})

test('L4 ArrowLeft traverses the expanded heading marker to the previous paragraph', async ({
  page,
}) => {
  await open(page, 'paragraph-first')
  await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__placeText('Probe', 0),
  )
  await frames(page)
  expect(await caret(page)).toMatchObject({
    inHeading: true,
    anchorText: 'Probe',
    anchorOffset: 0,
  })
  const steps = []
  for (let i = 0; i < 3; i++) {
    await press(page, 'ArrowLeft')
    steps.push(await caret(page))
  }
  await record(page, { steps })
  expect.soft(steps.every((step) => step.inEditor && !step.isRoot)).toBe(true)
  expect(steps.some((step) => step.blockText?.startsWith('Alpha'))).toBe(true)
})

for (const command of [
  'bold',
  'italic',
  'strike',
  'inline-code',
  'list',
  'ordered-list',
  'check',
]) {
  test(`L5 root caret refuses ${command}`, async ({ page }) => {
    await open(page)
    await page.evaluate(() =>
      (window as unknown as BlocklessCaretHarness).__seedRoot(0),
    )
    await frames(page)
    expect((await caret(page)).isRoot).toBe(true)
    const before = await value(page)
    expect(before).toBe(DOC)
    await page.locator(`.vditor-toolbar [data-type="${command}"]`).click()
    await frames(page)
    // Negative assertion window: cover Vditor's delayed input/toolbar work before asserting no edit.
    await page.waitForTimeout(350)
    const result = await record(page, {
      command,
      before,
      firstParagraphPreserved: (await value(page)).includes(
        'Alpha bravo charlie delta.',
      ),
    })
    expect(result.value).toBe(before)
  })
}

test('L6 fresh-open Bold refuses Vditor synthetic root range', async ({
  page,
}) => {
  await open(page)
  const fresh = await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__fresh(),
  )
  await record(page, { fresh })
  test.skip(
    fresh.rangeCount !== 0 || fresh.hasIrRange,
    `Fresh-selection precondition not met: ${JSON.stringify(fresh)}`,
  )
  await page.locator('.vditor-toolbar [data-type="bold"]').click()
  await frames(page)
  // Negative assertion window: a no-op must survive the deferred input pass.
  await page.waitForTimeout(350)
  const result = await record(page, { fresh })
  expect(result.value).toBe(DOC)
})

test('L7 ArrowUp leaves fence info under Vditor control', async ({ page }) => {
  await open(page, 'code')
  await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__placeText('alpha', 2),
  )
  await frames(page)
  expect((await caret(page)).anchorText).toContain('alpha')
  const steps = []
  for (let i = 0; i < 2; i++) {
    await press(page, 'ArrowUp')
    steps.push(await caret(page))
  }
  await record(page, { steps })
  expect.soft(steps.every((step) => step.inEditor && !step.isRoot)).toBe(true)
  expect(steps[1].blockText?.trim()).toBe('Alpha')
})

test('L8 held pointer at hidden heading marker stays in heading', async ({
  page,
}) => {
  await open(page)
  await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
  await frames(page)
  const heading = page.locator('.vditor-ir h1')
  await expect(heading).not.toHaveClass(/vditor-ir__node--expand/)
  const box = await heading.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + 1, box!.y + box!.height / 2)
  await page.mouse.down()
  // Required held-pointer sample: let the reveal frame run before Vditor's mouseup/click.
  await page.waitForTimeout(60)
  const held = await caret(page)
  await page.mouse.up()
  await frames(page)
  const result = await record(page, { held })
  expect(held).toMatchObject({ isRoot: false, inEditor: true, inHeading: true })
  expect(result.caret).toMatchObject({
    isRoot: false,
    inEditor: true,
    inHeading: true,
  })
})

// Task 608 — Ctrl+Home on a document whose first block is atomic (a rule, a table of contents).
// Native Ctrl+Home lands on the bare editable root there; the gap mover puts the caret in the
// boundary-0 gap instead, so typing opens a new first paragraph and the rule/TOC survive.
const shape = (page: Page) =>
  page.evaluate(() => (window as unknown as BlocklessCaretHarness).__shape())

for (const [name, first] of [
  ['HR-first', 'hr'],
  ['TOC-first', 'toc-block'],
] as const) {
  const doc = name === 'HR-first' ? 'hr-first' : 'toc-first'
  test(`M1 ${name} Ctrl+Home then typing opens a new first paragraph`, async ({
    page,
  }) => {
    await open(page, doc)
    const before = await value(page)
    expect((await shape(page)).blocks[0]).toBe(first)
    await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
    await frames(page)
    await press(page, 'Control+Home')
    const landed = await caret(page)
    const landedShape = await shape(page)
    expect(landed).toMatchObject({ isRoot: false, inEditor: true })
    expect(landedShape.blocks[0]).toBe('p')
    expect(landedShape.blocks[1]).toBe(first)
    expect(landedShape.gaps).toBe(1)
    // Landing alone is not an edit.
    expect(await value(page)).toBe(before)
    await page.keyboard.type('Z')
    await frames(page)
    await page.waitForTimeout(350)
    const after = await value(page)
    const finalShape = await shape(page)
    await record(page, { landed, landedShape, finalShape, before, after })
    // The typed text is a new paragraph BEFORE the rule/TOC, which is still there, untouched.
    expect(after.startsWith('Z\n\n')).toBe(true)
    expect(after.slice('Z\n\n'.length)).toBe(before)
    expect(finalShape.blocks.slice(0, 2)).toEqual(['p', first])
    expect(finalShape.rootText).toBe(0)
  })
}

for (const [doc, key, landed] of [
  ['hr-first', 'ArrowRight', 'Alpha bravo charlie delta.'],
  ['hr-first', 'ArrowDown', 'Alpha bravo charlie delta.'],
  ['toc-first', 'ArrowRight', '# Probe'],
] as const) {
  test(`M2 ${doc}: the gap is reclaimed when ${key} leaves it and the caret lands in the next block`, async ({
    page,
  }) => {
    await open(page, doc)
    const before = await value(page)
    await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
    await frames(page)
    await press(page, 'Control+Home')
    expect((await shape(page)).gaps).toBe(1)
    await press(page, key)
    await expect.poll(async () => (await shape(page)).gaps).toBe(0)
    const result = await record(page, { key, before })
    expect((await shape(page)).blocks[0]).not.toBe('p')
    expect(await value(page)).toBe(before)
    // Contract 1 fallback: the block after the rule or TOC, never the bare root.
    expect(result.caret).toMatchObject({ isRoot: false, inEditor: true })
    expect(result.caret.blockText).toBe(landed)
  })
}

// Task 608 S2c — the other keyboard routes that can land on the bare root around a rule. Each must
// end in a block or the gap, and leave the Markdown untouched.
test('M3 ArrowLeft at the start of an HR-first document does not land on the root', async ({
  page,
}) => {
  await open(page, 'hr-first')
  const before = await value(page)
  await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__placeText('Alpha', 0),
  )
  await frames(page)
  await press(page, 'ArrowLeft')
  const result = await record(page, { before })
  expect(result.caret).toMatchObject({ isRoot: false, inEditor: true })
  expect(await value(page)).toBe(before)
})

test('M4 Ctrl+End on an HR-last document does not land on the root', async ({
  page,
}) => {
  await open(page, 'hr-last')
  const before = await value(page)
  await page.locator('.vditor-ir p').filter({ hasText: 'Alpha' }).click()
  await frames(page)
  await press(page, 'Control+End')
  const result = await record(page, { before })
  expect(result.caret).toMatchObject({ isRoot: false, inEditor: true })
  expect(await value(page)).toBe(before)
})

test('M5 PageUp to the top of an HR-first document does not land on the root', async ({
  page,
}) => {
  await open(page, 'hr-first')
  const before = await value(page)
  await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
  await frames(page)
  await press(page, 'PageUp')
  const result = await record(page, { before })
  expect(result.caret).toMatchObject({ isRoot: false, inEditor: true })
  expect(await value(page)).toBe(before)
})

test('M6 a programmatic root range in an HR-first document is not normalized', async ({
  page,
}) => {
  await open(page, 'hr-first')
  await page.evaluate(() =>
    (window as unknown as BlocklessCaretHarness).__seedRoot(0),
  )
  await frames(page)
  await page.waitForTimeout(350)
  const result = await record(page)
  expect(result.caret.isRoot).toBe(true)
  expect((await shape(page)).gaps).toBe(0)
})

// Task 608 S3 — the four toolbar actions at a blockless IR caret. Owner rule (2026-10-08, refined
// 2026-10-14): Headings and Link refuse (no edit, no history entry); Code block and Table insert a
// new top-level block at the caret's root position with the bytes the in-block control gives and
// one Undo step; a non-collapsed range that starts at the root refuses all four.
const harness = (page: Page) => ({
  history: () =>
    page.evaluate(() =>
      (window as unknown as BlocklessCaretHarness).__history(),
    ),
  selection: () =>
    page.evaluate(() =>
      (window as unknown as BlocklessCaretHarness).__selection(),
    ),
  seedRoot: (offset: number) =>
    page.evaluate(
      (at) => (window as unknown as BlocklessCaretHarness).__seedRoot(at),
      offset,
    ),
  holder: (offset: number) =>
    page.evaluate(
      (at) => (window as unknown as BlocklessCaretHarness).__holder(at),
      offset,
    ),
  chord: (action: string) =>
    page.evaluate(
      (name) => (window as unknown as BlocklessCaretHarness).__chord(name),
      action,
    ),
  undo: () =>
    page.evaluate(() => (window as unknown as BlocklessCaretHarness).__undo()),
  empty: () =>
    page.evaluate(() => (window as unknown as BlocklessCaretHarness).__empty()),
  quiesce: () =>
    page.evaluate(() =>
      (window as unknown as BlocklessCaretHarness).__quiesce(),
    ),
  baseline: () =>
    page.evaluate(() =>
      (window as unknown as BlocklessCaretHarness).__baseline(),
    ),
})

// Past Vditor's delayed input and its history checkpoint (`undoDelay`, 800 ms by default), so a
// refusal that still queued work would show as a changed value or a longer history.
const settle = (page: Page) => page.waitForTimeout(1100)

type Action = 'headings' | 'chord' | 'link' | 'code' | 'table'

async function run(page: Page, action: Action) {
  if (action === 'chord') {
    await harness(page).chord('heading-2')
  } else if (action === 'headings') {
    await page.locator('.vditor-toolbar [data-type="headings"]').click()
    await page
      .locator(
        '.vditor-toolbar__item:has([data-type="headings"]) .vditor-hint button[data-tag="h2"]',
      )
      .click()
  } else {
    await page.locator(`.vditor-toolbar [data-type="${action}"]`).click()
  }
  await frames(page)
  await settle(page)
}

async function seedAndRun(
  page: Page,
  doc: string,
  offset: number,
  action: Action,
) {
  await open(page, doc)
  await harness(page).baseline()
  await harness(page).seedRoot(offset)
  await frames(page)
  expect((await caret(page)).isRoot).toBe(true)
  // Drop a history checkpoint the seeding itself queued, so only the action can add one.
  await harness(page).quiesce()
  const before = {
    value: await value(page),
    history: await harness(page).history(),
  }
  await run(page, action)
  return {
    before,
    value: await value(page),
    history: await harness(page).history(),
  }
}

// The harness serializes through Vditor's `getValue()`, which writes the rule as `---`; the exact
// `----` source bytes are preserved only by the host's exact-source write-back (real VS Code).
const HR_FIRST_DOC =
  '---\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'
const PARAGRAPHS_DOC =
  'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'

// Acceptance 1 / contract 3-4: Headings (toolbar panel and the Format: Heading 2 chord) and Link
// refuse at a collapsed blockless caret. Task 600's own document and an HR-first document.
for (const [doc, text] of [
  ['heading', DOC],
  ['hr-first', HR_FIRST_DOC],
] as const) {
  for (const action of ['headings', 'chord', 'link'] as const) {
    test(`S1 ${doc}: root caret refuses ${action} with no edit and no history entry`, async ({
      page,
    }) => {
      const result = await seedAndRun(page, doc, 0, action)
      await record(page, { action, ...result })
      expect(result.before.value).toBe(text)
      expect(result.value).toBe(text)
      expect(result.history).toEqual(result.before.history)
    })
  }
}

// Acceptance 1 / contract 5: Code block and Table insert a top-level block at the root position.
// Expected bytes are the in-block empty-paragraph control (Vditor's own path for a caret in an
// empty block); the original document must survive around the new block, and one Undo restores it.
async function controlValue(
  page: Page,
  doc: string,
  offset: number,
  action: 'code' | 'table',
) {
  await open(page, doc)
  await harness(page).baseline()
  await harness(page).holder(offset)
  await frames(page)
  await run(page, action)
  return value(page)
}

for (const action of ['code', 'table'] as const) {
  for (const [doc, text, offset, head, tail] of [
    ['hr-first', HR_FIRST_DOC, 0, '', HR_FIRST_DOC],
    // Edge case: offset 1 (rule, then paragraph) is the simulated corruption case.
    [
      'hr-first',
      HR_FIRST_DOC,
      1,
      '---\n\n',
      'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n',
    ],
    // Edge case: between two paragraphs adds no blank line.
    [
      'paragraphs',
      PARAGRAPHS_DOC,
      1,
      'Alpha bravo charlie delta.\n\n',
      'Echo foxtrot golf hotel.\n',
    ],
  ] as const) {
    test(`S2 ${doc} offset ${offset}: root caret inserts ${action} as the in-block control does, one Undo step`, async ({
      page,
    }) => {
      const control = await controlValue(page, doc, offset, action)
      const result = await seedAndRun(page, doc, offset, action)
      await record(page, { action, offset, control, ...result })
      expect(result.before.value).toBe(text)
      expect(result.value).toBe(control)
      expect(result.value).not.toBe(text)
      // The original blocks (and the rule) survive around the new block, in order.
      expect(result.value.startsWith(head)).toBe(true)
      expect(result.value.endsWith(tail)).toBe(true)
      expect(result.value.length).toBeGreaterThan(head.length + tail.length)
      if (doc === 'hr-first') expect(result.value).toContain('---\n')
      // The control's own blank-line count is the standard: Vditor's in-block Table insertion
      // between two paragraphs already writes one extra blank line, so no more than that.
      expect(result.value.match(/\n{3,}/g)?.length ?? 0).toBe(
        control.match(/\n{3,}/g)?.length ?? 0,
      )
      // One history entry; one Undo restores the original document.
      expect(result.history.undo).toBe(result.before.history.undo + 1)
      await harness(page).undo()
      await frames(page)
      expect(await value(page)).toBe(text)
    })
  }
}

// Decision 2 (Owner, 2026-10-14): a non-collapsed selection that starts at the root refuses all
// four actions. Ctrl+Shift+Home from the last paragraph of an HR-first document starts at the root.
for (const action of ['headings', 'link', 'code', 'table'] as const) {
  test(`S3 a selection from the document start refuses ${action}`, async ({
    page,
  }) => {
    await open(page, 'hr-first')
    await harness(page).baseline()
    await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
    await frames(page)
    await press(page, 'Control+Shift+Home')
    await harness(page).quiesce()
    const selection = await harness(page).selection()
    expect(selection).toMatchObject({ collapsed: false, startIsRoot: true })
    const before = {
      value: await value(page),
      history: await harness(page).history(),
    }
    await run(page, action)
    const result = await record(page, {
      action,
      selection,
      history: await harness(page).history(),
    })
    expect(before.value).toBe(HR_FIRST_DOC)
    expect(result.value).toBe(HR_FIRST_DOC)
    expect(await harness(page).history()).toEqual(before.history)
  })
}

// Edge case: a block inserted from the boundary-0 gap (Ctrl+Home) is an in-block insertion; the
// gap paragraph must not outlive it, and the bytes equal the control.
for (const action of ['code', 'table'] as const) {
  test(`S4 ${action} inserted from the gap: bytes equal the control and no gap paragraph is left`, async ({
    page,
  }) => {
    const control = await controlValue(page, 'hr-first', 0, action)
    await open(page, 'hr-first')
    await harness(page).baseline()
    await page.locator('.vditor-ir p').filter({ hasText: 'Echo' }).click()
    await frames(page)
    await press(page, 'Control+Home')
    expect((await shape(page)).gaps).toBe(1)
    await run(page, action)
    const finalShape = await shape(page)
    const result = await record(page, { action, control, finalShape })
    expect(result.value).toBe(control)
    expect(finalShape.gaps).toBe(0)
    expect(finalShape.rootText).toBe(0)
    await harness(page).undo()
    await frames(page)
    expect(await value(page)).toBe(HR_FIRST_DOC)
  })
}

// Edge case: the empty editor (no child node at all) keeps Vditor's own insertion path. Headings
// there is not asserted: Vditor's own handler writes nothing into a childless editor, with or
// without the guard, and the guard does not apply (no top-level block to protect).
test("S5 the empty editor keeps Vditor's code path", async ({ page }) => {
  await open(page)
  await harness(page).empty()
  await frames(page)
  expect((await value(page)).trim()).toBe('')
  await run(page, 'code')
  const result = await record(page, { action: 'code' })
  expect(result.value).toContain('```')
})
