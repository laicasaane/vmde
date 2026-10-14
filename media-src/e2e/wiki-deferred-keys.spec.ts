import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 636 — the host posts `init` before the wiki page scan finishes, so the keys arrive later in
// a `wiki-update`. This runs the REAL webview entry (main.ts, as shortcut-negative-harness.ts) with
// a stubbed `acquireVsCodeApi` that answers `ready` with an init that has the wiki context but no
// `pageKeys`, and posts the host's later messages as window messages. Contract: while keys are
// pending no chip is marked missing and the `[[` hint shows one "Loading pages…" row that cannot be
// inserted; a `wiki-update` marks chips (attributes only, no edit), survives a configuration
// re-init, and refills a hint that is open.

const CONTENT =
  '# Wiki\n\nSee [[Home]] and [[Missing Page]] here.\n\nTail paragraph.\n'
const KEYS = {
  command: 'wiki-update',
  pageKeys: ['home', 'other-page'],
  displayNames: ['Home', 'Other Page'],
}
const LOADING_ROW = 'Loading pages…'

async function open(
  page: Page,
  wiki: object = { enabled: true, rootLabel: 'ws' },
  expectedChips = 2,
) {
  const init = {
    command: 'update',
    type: 'init',
    content: CONTENT,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: 'ir' },
    theme: 'light',
    wiki,
    e2e: true,
  }
  await page.addInitScript((message) => {
    const win = window as any
    win.__posted = []
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        win.__posted.push(posted)
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    (expected) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === 'ir' &&
        document.querySelectorAll('.vditor-ir .wiki-link-chip').length >=
          expected
      )
    },
    expectedChips,
    { timeout: 15_000 },
  )
}

const hostPost = (page: Page, message: object) =>
  page.evaluate((m) => window.postMessage(m, '*'), message)

const chip = (page: Page, target: string) =>
  page.locator(`.vditor-ir .wiki-link-chip[data-wiki-target="${target}"]`)

const hintRows = (page: Page) =>
  page.locator('.vditor-hint[style*="display: block"] button')

async function typeAtEnd(page: Page, text: string) {
  await page.evaluate(() => {
    const root = document.querySelector(
      '.vditor-ir .vditor-reset',
    ) as HTMLElement
    root.focus()
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  await page.keyboard.type(text, { delay: 50 })
}

const hintShown = (page: Page) =>
  page.evaluate(() => {
    return Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-hint'),
    ).some((el) => el.style.display === 'block')
  })

const editorState = (page: Page) =>
  page.evaluate(() => ({
    markdown: (window as any).vditor.getValue() as string,
    blocks: document.querySelectorAll('.vditor-ir .vditor-reset > [data-block]')
      .length,
    chips: document.querySelectorAll('.vditor-ir .wiki-link-chip').length,
  }))

test('R8 an init without keys marks no chip as missing', async ({ page }) => {
  await open(page)
  await expect(chip(page, 'Home')).toHaveCount(1)
  await expect(chip(page, 'Missing Page')).toHaveCount(1)
  expect(await page.locator('.vditor-ir [data-wiki-missing]').count()).toBe(0)
})

test('R9 a wiki-update marks the missing chip, keeps the existing one, and posts no edit', async ({
  page,
}) => {
  await open(page)
  const before = await editorState(page)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })

  await hostPost(page, KEYS)

  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'title',
    /Missing wiki page/,
  )
  await expect(chip(page, 'Home')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
  await expect(chip(page, 'Home')).toHaveAttribute('title', /Open wiki page/)
  await page.waitForTimeout(600)
  const posted = await page.evaluate(() => (window as any).__posted as any[])
  expect(posted.filter((m) => m.command === 'edit')).toEqual([])
  expect((await editorState(page)).markdown).toBe(before.markdown)
})

test('R10 a configuration re-init after a wiki-update keeps the keys', async ({
  page,
}) => {
  await open(page)
  await hostPost(page, KEYS)
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
  const epoch = await page.evaluate(
    () => (window as any).__vmdeE2EReadiness.editorEpoch as number,
  )

  await hostPost(page, {
    command: 'config-changed',
    options: { showToolbar: false, defaultMode: 'ir' },
  })
  await page.waitForFunction(
    (previous) => (window as any).__vmdeE2EReadiness.editorEpoch > previous,
    epoch,
    { timeout: 15_000 },
  )

  await expect(chip(page, 'Home')).toHaveCount(1)
  await expect(chip(page, 'Home')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
})

test('R11 the [[ hint lists the page names after a wiki-update', async ({
  page,
}) => {
  await open(page)
  await hostPost(page, KEYS)
  await typeAtEnd(page, '[[')
  await expect(hintRows(page)).toHaveCount(2)
  expect(
    (await hintRows(page).allInnerTexts()).map((t) => t.trim()).sort(),
  ).toEqual(['Home', 'Other Page'])
})

test.describe('R12 while keys are pending the [[ hint is one non-insertable loading row', () => {
  test('shows exactly one localized row', async ({ page }) => {
    await open(page)
    await typeAtEnd(page, '[[')
    await expect(hintRows(page)).toHaveCount(1)
    expect((await hintRows(page).first().innerText()).trim()).toBe(LOADING_ROW)
  })

  test('Enter inserts the normal newline and no page text', async ({
    page,
  }) => {
    await open(page)
    await typeAtEnd(page, '[[')
    await expect(hintRows(page)).toHaveCount(1)
    const before = await editorState(page)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)

    const after = await editorState(page)
    expect(after.markdown).not.toContain('Loading')
    expect(after.chips).toBe(before.chips)
    expect(after.blocks).toBe(before.blocks + 1)
    expect(await hintShown(page)).toBe(false)
  })

  test('Tab inserts nothing from the hint', async ({ page }) => {
    await open(page)
    await typeAtEnd(page, '[[')
    await expect(hintRows(page)).toHaveCount(1)
    const before = await editorState(page)

    await page.keyboard.press('Tab')
    await page.waitForTimeout(400)

    const after = await editorState(page)
    expect(after.markdown).not.toContain('Loading')
    expect(after.chips).toBe(before.chips)
  })

  test('Escape closes the hint', async ({ page }) => {
    await open(page)
    await typeAtEnd(page, '[[')
    await expect(hintRows(page)).toHaveCount(1)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    expect(await hintShown(page)).toBe(false)
  })
})

test('R13 a wiki-update re-runs the open pending hint with the current query', async ({
  page,
}) => {
  await open(page)
  await typeAtEnd(page, '[[Ho')
  await expect(hintRows(page)).toHaveCount(1)
  expect((await hintRows(page).first().innerText()).trim()).toBe(LOADING_ROW)

  await hostPost(page, KEYS)

  await expect(hintRows(page)).toHaveCount(1)
  expect((await hintRows(page).first().innerText()).trim()).toBe('Home')
  expect(await hintShown(page)).toBe(true)
})

const OTHER_KEYS = {
  command: 'wiki-update',
  pageKeys: ['missing-page'],
  displayNames: ['Missing Page'],
}
const epochOf = (page: Page) =>
  page.evaluate(() => (window as any).__vmdeE2EReadiness.editorEpoch as number)

// Task 637 — a root change posts a second `wiki-update` for the new root; it replaces the sets.
test('R14 a second wiki-update with a different set flips both chip states and posts no edit', async ({
  page,
}) => {
  await open(page)
  await hostPost(page, KEYS)
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
  await expect(chip(page, 'Home')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
  const before = await editorState(page)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })

  await hostPost(page, OTHER_KEYS)

  await expect(chip(page, 'Home')).toHaveAttribute('data-wiki-missing', '1')
  await expect(chip(page, 'Home')).toHaveAttribute('title', /Missing wiki page/)
  await expect(chip(page, 'Missing Page')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'title',
    /Open wiki page/,
  )
  await page.waitForTimeout(600)
  const posted = await page.evaluate(() => (window as any).__posted as any[])
  expect(posted.filter((m) => m.command === 'edit')).toEqual([])
  expect((await editorState(page)).markdown).toBe(before.markdown)
})

// Task 637 — enabling the wiki after an open with the wiki off re-inits without keys; the chips
// stay pending until the host's `wiki-update`.
test('R15 enabling the wiki after a disabled open stays pending until a wiki-update, then styles chips and fills [[', async ({
  page,
}) => {
  await open(page, { enabled: false }, 0)
  const epoch = await epochOf(page)

  await hostPost(page, {
    command: 'config-changed',
    options: { showToolbar: true, defaultMode: 'ir', wikiEnabled: true },
  })
  await page.waitForFunction(
    (previous) => (window as any).__vmdeE2EReadiness.editorEpoch > previous,
    epoch,
    { timeout: 15_000 },
  )
  await expect(chip(page, 'Home')).toHaveCount(1)
  await expect(chip(page, 'Missing Page')).toHaveCount(1)
  expect(await page.locator('.vditor-ir [data-wiki-missing]').count()).toBe(0)
  await typeAtEnd(page, '[[')
  await expect(hintRows(page)).toHaveCount(1)
  expect((await hintRows(page).first().innerText()).trim()).toBe(LOADING_ROW)

  await hostPost(page, KEYS)

  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
  await expect(chip(page, 'Home')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
  await expect(hintRows(page)).toHaveCount(2)
  expect(
    (await hintRows(page).allInnerTexts()).map((t) => t.trim()).sort(),
  ).toEqual(['Home', 'Other Page'])
})

// Task 637 — keys from before a disable must not be reused when the wiki is enabled again.
test('R16 stale pageKeys are not reused when the wiki is re-enabled', async ({
  page,
}) => {
  await open(page)
  await hostPost(page, KEYS)
  await expect(chip(page, 'Missing Page')).toHaveAttribute(
    'data-wiki-missing',
    '1',
  )
  const options = { showToolbar: true, defaultMode: 'ir' }
  for (const wikiEnabled of [false, true]) {
    const epoch = await epochOf(page)
    await hostPost(page, {
      command: 'config-changed',
      options: { ...options, wikiEnabled },
    })
    await page.waitForFunction(
      (previous) => (window as any).__vmdeE2EReadiness.editorEpoch > previous,
      epoch,
      { timeout: 15_000 },
    )
  }
  await expect(chip(page, 'Home')).toHaveCount(1)
  await expect(chip(page, 'Missing Page')).toHaveCount(1)
  expect(await page.locator('.vditor-ir [data-wiki-missing]').count()).toBe(0)
  await typeAtEnd(page, '[[')
  await expect(hintRows(page)).toHaveCount(1)
  expect((await hintRows(page).first().innerText()).trim()).toBe(LOADING_ROW)

  await hostPost(page, OTHER_KEYS)

  await expect(chip(page, 'Home')).toHaveAttribute('data-wiki-missing', '1')
  await expect(chip(page, 'Missing Page')).not.toHaveAttribute(
    'data-wiki-missing',
    /.*/,
  )
})
