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
