import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 634 S2: `--me-source-font-family` (a body variable set by the host) must style the
// Split View source panel (`.vditor-sv`) only. Three `!important` rules compete for its
// font-family, so the assertions run in all three cascade states.

const VIEWPORT = { width: 1300, height: 400 }
test.use({ viewport: VIEWPORT })

const CUSTOM = '"Fira Code", "Cascadia Mono", Consolas'
const DEFAULT_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

type State = 'plain' | 'auto' | 'named'
const STATES: State[] = ['plain', 'auto', 'named']

async function gotoSplit(page: Page) {
  await page.goto('/split-scroll.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector('.vditor-sv', { state: 'visible' })
  await page.waitForSelector('.vditor-preview', { state: 'visible' })
}

async function applyState(page: Page, state: State, family: string | null) {
  await page.evaluate(
    ({ state, family }) => {
      const body = document.body
      body.removeAttribute('data-use-vscode-theme-color')
      body.classList.remove('markdown-body')
      if (state === 'auto')
        body.setAttribute('data-use-vscode-theme-color', '1')
      if (state === 'named') body.classList.add('markdown-body')
      if (family === null) body.style.removeProperty('--me-source-font-family')
      else body.style.setProperty('--me-source-font-family', family)
    },
    { state, family },
  )
}

const computed = (page: Page, selector: string) =>
  page.evaluate(
    (sel) =>
      getComputedStyle(document.querySelector(sel) as Element).fontFamily,
    selector,
  )

for (const state of STATES) {
  test(`SV source panel uses the source font setting (${state})`, async ({
    page,
  }) => {
    await gotoSplit(page)
    await applyState(page, state, CUSTOM)
    const sv = await computed(page, '.vditor-sv')
    expect(sv.startsWith(CUSTOM)).toBe(true)
    expect(sv.endsWith('monospace')).toBe(true)
  })

  test(`preview font is unchanged by the source font setting (${state})`, async ({
    page,
  }) => {
    await gotoSplit(page)
    await applyState(page, state, null)
    const before = await computed(page, '.vditor-preview .vditor-reset')
    await applyState(page, state, CUSTOM)
    const after = await computed(page, '.vditor-preview .vditor-reset')
    expect(after).toBe(before)
    expect(after).not.toContain('Fira Code')
  })

  test(`every text-bearing SV descendant reports the SV family (${state})`, async ({
    page,
  }) => {
    await gotoSplit(page)
    await applyState(page, state, CUSTOM)
    const result = await page.evaluate(() => {
      const sv = document.querySelector('.vditor-sv') as HTMLElement
      const want = getComputedStyle(sv).fontFamily
      const walker = document.createTreeWalker(sv, NodeFilter.SHOW_TEXT)
      const bad: string[] = []
      let seen = 0
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue
        const el = n.parentElement as HTMLElement
        seen++
        const got = getComputedStyle(el).fontFamily
        if (got !== want) bad.push(`${el.tagName}.${el.className}: ${got}`)
      }
      return {
        seen,
        bad,
        tags: Array.from(sv.querySelectorAll('code, pre')).length,
      }
    })
    expect(result.seen).toBeGreaterThan(10)
    expect(result.bad).toEqual([])
  })
}

test('SV source panel has no code/pre descendants for Vditor code stack to restyle', async ({
  page,
}) => {
  await gotoSplit(page)
  // The harness document includes a fenced block; Vditor's SV renders spans only, so
  // `code:not(.hljs)` has nothing to match and the panel rule needs no descendant extension.
  const count = await page.evaluate(
    () => document.querySelectorAll('.vditor-sv code, .vditor-sv pre').length,
  )
  expect(count).toBe(0)
})

test('an empty value falls back to the default stack', async ({ page }) => {
  await gotoSplit(page)
  await applyState(page, 'plain', '')
  const sv = await computed(page, '.vditor-sv')
  expect(sv).toContain('ui-monospace')
  expect(sv).toContain('monospace')
  expect(sv).not.toContain('Fira Code')
  await applyState(page, 'plain', null)
  expect(await computed(page, '.vditor-sv')).toBe(sv)
  expect(DEFAULT_STACK).toContain('ui-monospace')
})

test('IR and WYSIWYG surfaces do not take the source font', async ({
  page,
}) => {
  await page.goto('/mode-roundtrip.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() =>
    document.body.style.setProperty(
      '--me-source-font-family',
      '"Fira Code", Consolas',
    ),
  )
  const ir = await computed(page, '.vditor-ir .vditor-reset')
  expect(ir).not.toContain('Fira Code')
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await page.waitForSelector('.vditor-wysiwyg', { state: 'visible' })
  const ww = await computed(page, '.vditor-wysiwyg .vditor-reset')
  expect(ww).not.toContain('Fira Code')
})
