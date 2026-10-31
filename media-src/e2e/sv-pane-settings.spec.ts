import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 645: the Split View source pane settings reach the page through the real
// `applyBodyOptions` and must change only the source pane (`.vditor-sv`) and the pane gap. The
// background, size and line-height rules compete with the plain, `auto` and named-theme cascades,
// so each runs in all three states.
test.use({ viewport: { width: 1300, height: 500 } })

type State = 'plain' | 'auto' | 'named'
const STATES: State[] = ['plain', 'auto', 'named']

async function gotoPane(page: Page, query = '') {
  await page.goto(`/sv-pane.html${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.waitForSelector(
    query.includes('mode=ir') ? '.vditor-ir' : '.vditor-sv',
    {
      state: 'visible',
    },
  )
}

async function applyState(page: Page, state: State, options: object = {}) {
  await page.evaluate(
    ({ state, options }) => {
      const body = document.body
      body.removeAttribute('data-use-vscode-theme-color')
      body.classList.remove('markdown-body')
      ;(window as any).__applyBodyOptions({
        useVscodeThemeColor: state === 'auto',
        contentTheme: state === 'named' ? 'github-light' : 'auto',
        ...options,
      })
    },
    { state, options },
  )
}

const style = (page: Page, selector: string, prop: string) =>
  page.evaluate(
    ({ selector, prop }) =>
      (getComputedStyle(document.querySelector(selector) as Element) as any)[
        prop
      ] as string,
    { selector, prop },
  )

// Distance from the source pane's border box to the preview pane's border box.
const paneGap = (page: Page) =>
  page.evaluate(() => {
    const sv = document.querySelector('.vditor-sv')!.getBoundingClientRect()
    const pv = document
      .querySelector('.vditor-preview')!
      .getBoundingClientRect()
    return pv.left - sv.right
  })

for (const state of STATES) {
  test(`source font size changes only the source pane (${state})`, async ({
    page,
  }) => {
    await gotoPane(page)
    await applyState(page, state, { fontSize: '17' })
    expect(await style(page, '.vditor-sv', 'fontSize')).toBe('17px')

    await applyState(page, state, { fontSize: '17', sourceFontSize: '20px' })
    expect(await style(page, '.vditor-sv', 'fontSize')).toBe('20px')
    expect(await style(page, '.vditor-sv', 'lineHeight')).toBe('31px')
    expect(await style(page, '.vditor-preview .vditor-reset', 'fontSize')).toBe(
      '17px',
    )

    await applyState(page, state, { fontSize: '17', sourceFontSize: 'editor' })
    expect(await style(page, '.vditor-sv', 'fontSize')).toBe('17px')
  })

  test(`source heading rows scale with the source line height (${state})`, async ({
    page,
  }) => {
    await gotoPane(page)
    await applyState(page, state, { sourceFontSize: '18' })
    const row = await page.evaluate(() => {
      const h1 = document.querySelector('.vditor-sv .h1') as HTMLElement
      return parseFloat(getComputedStyle(h1).lineHeight)
    })
    // Vditor's fixed 44px heading row times 28/22 (the 18px source size's line height).
    expect(row).toBeCloseTo((44 * 28) / 22, 0)
  })

  test(`source background is measured and an empty value restores today's color (${state})`, async ({
    page,
  }) => {
    await gotoPane(page)
    await applyState(page, state)
    const original = await style(page, '.vditor-sv', 'backgroundColor')

    await applyState(page, state, { sourceBackground: '#102030' })
    expect(await style(page, '.vditor-sv', 'backgroundColor')).toBe(
      'rgb(16, 32, 48)',
    )
    // The focused pane has its own background rule.
    await page.evaluate(() =>
      (document.querySelector('.vditor-sv') as HTMLElement).focus(),
    )
    expect(await style(page, '.vditor-sv', 'backgroundColor')).toBe(
      'rgb(16, 32, 48)',
    )
    expect(
      await style(page, '.vditor-preview .vditor-reset', 'backgroundColor'),
    ).not.toBe('rgb(16, 32, 48)')

    await applyState(page, state, { sourceBackground: '' })
    await page.evaluate(() =>
      (document.querySelector('.vditor-sv') as HTMLElement).blur(),
    )
    expect(await style(page, '.vditor-sv', 'backgroundColor')).toBe(original)
  })
}

test('the pane gap defaults to 0 and the setting changes the measured distance', async ({
  page,
}) => {
  await gotoPane(page)
  await applyState(page, 'plain')
  expect(await paneGap(page)).toBe(0)
  await applyState(page, 'plain', { splitGap: 24 })
  expect(await paneGap(page)).toBe(24)
  await applyState(page, 'plain', { splitGap: 0 })
  expect(await paneGap(page)).toBe(0)
})

test('the pane gap keeps the 1px divider on the preview edge', async ({
  page,
}) => {
  await gotoPane(page)
  await applyState(page, 'plain', { splitGap: 24 })
  expect(await style(page, '.vditor-preview', 'borderLeftWidth')).toBe('1px')
})

test('invalid values keep the defaults', async ({ page }) => {
  await gotoPane(page)
  await applyState(page, 'plain')
  const font = await style(page, '.vditor-sv', 'fontSize')
  const lineHeight = await style(page, '.vditor-sv', 'lineHeight')
  const background = await style(page, '.vditor-sv', 'backgroundColor')
  await applyState(page, 'plain', {
    sourceFontSize: 'huge',
    sourceBackground: 'red;}',
    splitGap: 500,
  })
  expect(await style(page, '.vditor-sv', 'fontSize')).toBe(font)
  expect(await style(page, '.vditor-sv', 'lineHeight')).toBe(lineHeight)
  expect(await style(page, '.vditor-sv', 'backgroundColor')).toBe(background)
  expect(await paneGap(page)).toBe(0)
})

test('Instant Rendering is unchanged by the source pane settings', async ({
  page,
}) => {
  await gotoPane(page, '?mode=ir')
  await applyState(page, 'plain')
  const read = () =>
    page.evaluate(() => {
      const ir = document.querySelector(
        '.vditor-ir .vditor-reset',
      ) as HTMLElement
      const cs = getComputedStyle(ir)
      return [cs.fontSize, cs.lineHeight, cs.backgroundColor, cs.marginLeft]
    })
  const before = await read()
  await applyState(page, 'plain', {
    sourceFontSize: '24',
    sourceBackground: '#102030',
    splitGap: 40,
  })
  expect(await read()).toEqual(before)
})
