import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { selectEditorText } from './editor-selection'

// Task 733 / 025 (design sections 1 and 3): layout containment of each top-level IR block.
//
// - "the shipped stylesheet contains each top-level IR block": the computed `contain` of every
//   `.vditor-ir > .vditor-reset > *` is `layout`.
// - "no pixel moves": per content theme, light and dark, and for each editor state, the page matches
//   itself with today's cascade restored by one injected style (no containment, the heading level label
//   floated as before). At most 20 differing pixels per state and equal top-level block heights
//   (decision Q-188), with the caret hidden so a blink cannot count. The
//   document holds the blocks the rule could change: headings (one not foldable), a TOC block, a link
//   reference definition, footnotes, a floated image followed by two short paragraphs, lists, quotes, a
//   callout, a table and a code block. The image is an HTML block (`<img align="right">` on its own
//   line): IR renders an `<img>` inside a paragraph only as its source text, so a paragraph cannot hold
//   a float there.
//
// Tagged `@visual` like visual.spec.ts: pixel identity holds on one machine, and the default harness run
// (`--grep-invert @visual`) excludes it. The page is shortcut-negative.html (the real main.ts).

// A 4 x 4 PNG (an SVG data image is rewritten by the SVG data-image handling and loses `align`).
const FLOAT_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEUlEQVR4nGPwmvAIjhiI4wAAyFIbwcAdOK4AAAAASUVORK5CYII='

const DOC = [
  '# Title heading',
  '',
  '[toc]',
  '',
  'Para text with `inline code` and a [link](https://example.com/) here.[^1]',
  '',
  '## Second heading',
  '',
  '3. third ordered',
  '4. fourth ordered',
  '   - nested bullet',
  '',
  '> quoted line one',
  '>',
  '> quoted line two',
  '',
  '> [!NOTE]',
  '> Callout body text',
  '',
  '| a | b |',
  '| - | - |',
  '| cellA | cellB `x` |',
  '| cellC | cellD |',
  '',
  '```js',
  'let code = 1',
  'let more = 2',
  '```',
  '',
  '- [ ] task item',
  '- [x] done item',
  '',
  `<img align="right" width="48" height="48" alt="square" src="${FLOAT_IMAGE}">`,
  '',
  'Short one.',
  '',
  'Short two.',
  '',
  'See the [reference link][ref].',
  '',
  '[ref]: https://example.com/ref',
  '',
  '### Third heading',
  '',
  'Tail para with `tail code`.',
  '',
  '[^1]: The footnote text.',
  '',
  '#### Last heading',
  '',
].join('\n')

// Today's cascade, restored over the shipped one (design section 3, amendment A1).
const TODAY = [
  '.vditor-ir > .vditor-reset > * { contain: none !important; }',
  '.vditor-ir > .vditor-reset > :is(h1, h2, h3, h4, h5, h6)::before { float: left !important; position: static !important; left: auto !important; top: auto !important; }',
  '.vditor-ir > .vditor-reset > :is(h1, h2, h3, h4)::before { position: relative !important; top: 1px !important; }',
].join('\n')

type Theme = readonly [
  name: string,
  contentTheme: string,
  themeKind: 'light' | 'dark',
]

const THEMES: readonly Theme[] = [
  ['auto-light', 'auto', 'light'],
  ['auto-dark', 'auto', 'dark'],
  ['github-light', 'github-light', 'light'],
  ['github-dark', 'github-dark', 'dark'],
  ['vscode-light-2026', 'vscode-light-2026', 'light'],
  ['vscode-dark-2026', 'vscode-dark-2026', 'dark'],
  ['material-dark', 'material-dark', 'dark'],
]

// The content-theme links of the real webview (same ids and paths), added disabled; config-changed
// enables the active one.
const THEME_LINKS: readonly (readonly [file: string, id: string])[] = [
  ['github-markdown-light', 'github-light'],
  ['github-markdown-dark', 'github-dark'],
  ['material-dark', 'material-dark'],
  ['vscode-light-2026', 'vscode-light-2026'],
  ['vscode-dark-2026', 'vscode-dark-2026'],
]

function initMessage() {
  return {
    command: 'update',
    type: 'init',
    content: DOC,
    cdn: '/vditor',
    options: {
      showToolbar: true,
      contentTheme: 'auto',
      defaultMode: 'ir',
      markdownToc: true,
    },
    theme: 'light',
    themeKind: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
}

async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function openEditor(page: Page): Promise<ReturnType<typeof initMessage>> {
  const init = initMessage()
  await page.setViewportSize({ width: 1100, height: 1600 })
  await page.addInitScript((message) => {
    const win = window as any
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    () =>
      ((window as any).__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
      (window as any).vditor?.getCurrentMode?.() === 'ir',
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  return init
}

async function applyTheme(
  page: Page,
  init: ReturnType<typeof initMessage>,
  [, contentTheme, themeKind]: Theme,
): Promise<void> {
  await page.evaluate((links) => {
    for (const [file, id] of links) {
      if (document.getElementById(`ct-${id}`)) continue
      const link = document.createElement('link')
      link.id = `ct-${id}`
      link.rel = 'stylesheet'
      link.href = `/markdown-themes/${file}.css`
      link.disabled = true
      document.head.appendChild(link)
    }
  }, THEME_LINKS)
  await page.evaluate(
    ({ init, contentTheme, themeKind }) =>
      window.postMessage(
        {
          ...init,
          command: 'config-changed',
          themeKind,
          theme: themeKind,
          options: { ...init.options, contentTheme },
        },
        '*',
      ),
    { init, contentTheme, themeKind },
  )
  await page.waitForTimeout(600)
  await page.evaluate(() => document.fonts.ready)
  const dark = await page.evaluate(
    () => !!document.querySelector('.vditor.vditor--dark'),
  )
  expect(dark, `${contentTheme}/${themeKind}: the .vditor--dark state`).toBe(
    themeKind === 'dark',
  )
}

async function caretAt(
  page: Page,
  needle: string,
  offset: number,
): Promise<void> {
  await page.evaluate(async () => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, 0] as const)
  // A real key after the move runs Vditor's keyup work (marker expand, panels).
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(300)
}

async function hover(
  page: Page,
  selector: string,
  text?: string,
): Promise<void> {
  await caretAt(page, 'Tail para', 2)
  const target = text
    ? page.locator(selector, { hasText: text }).first()
    : page.locator(selector).first()
  const box = await target.boundingBox()
  expect(box, `${selector} is on the page`).not.toBeNull()
  if (!box) return
  await page.mouse.move(box.x + 40, box.y + box.height / 2)
  await page.waitForTimeout(400)
}

// 025-E's eight editor states.
const STATES: readonly (readonly [string, (page: Page) => Promise<void>])[] = [
  ['caret in the tail paragraph', (page) => caretAt(page, 'Tail para', 2)],
  ['caret in the inline code', (page) => caretAt(page, 'inline code', 3)],
  ['caret in a table cell', (page) => caretAt(page, 'cellA', 2)],
  ['caret in the callout', (page) => caretAt(page, 'Callout body', 3)],
  ['caret in the code block', (page) => caretAt(page, 'let more', 2)],
  ['caret in the ordered list', (page) => caretAt(page, 'fourth ordered', 2)],
  [
    'mouse over a paragraph',
    (page) => hover(page, '.vditor-ir > .vditor-reset > p', 'Para text'),
  ],
  [
    'mouse over a heading',
    (page) => hover(page, '.vditor-ir > .vditor-reset > h2'),
  ],
]

async function setStyle(
  page: Page,
  id: string,
  css: string | null,
): Promise<void> {
  await page.evaluate(
    ([styleId, text]) => {
      document.getElementById(styleId)?.remove()
      if (text === null) return
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = text
      document.head.append(style)
    },
    [id, css] as const,
  )
  await twoFrames(page)
}

// Decision Q-188: antialiasing may differ by a few pixels (2 to 15 measured with the rule against the
// reference, no box moved), so a state may differ by at most 20 pixels at Playwright's default per-pixel
// threshold, and every top-level block must keep the reference's height (no layout shift).
const MAX_DIFF_PIXELS = 20
const PIXEL_THRESHOLD = 0.2

/** The height of every top-level IR block, in document order (two decimals). */
async function blockHeights(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir > .vditor-reset > *'),
    ).map(
      (el) =>
        `${el.tagName.toLowerCase()}: ${el.getBoundingClientRect().height.toFixed(2)}`,
    ),
  )
}

interface PixelDiff {
  count: number
  box: number[] | null
}

/** Counts the pixels that differ between two PNG screenshots of the same size, in the page. */
async function diffPixels(
  page: Page,
  a: Buffer,
  b: Buffer,
): Promise<PixelDiff> {
  return page.evaluate(
    async ([first, second, threshold]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => reject(new Error('screenshot did not decode'))
          image.src = src
        })
      const [ia, ib] = await Promise.all([load(first), load(second)])
      const w = Math.max(ia.width, ib.width)
      const h = Math.max(ia.height, ib.height)
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const context = canvas.getContext('2d') as CanvasRenderingContext2D
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, w, h).data
      }
      const da = pixels(ia)
      const db = pixels(ib)
      let count = 0
      let box: number[] | null = null
      // Playwright's screenshot comparison rule: a pixel differs when its YIQ colour distance exceeds
      // the default per-pixel threshold 0.2 (35215 is the largest possible distance).
      const yiq = (r: number, g: number, b: number) => [
        r * 0.29889531 + g * 0.58662247 + b * 0.11448223,
        r * 0.59597799 - g * 0.2741761 - b * 0.32180189,
        r * 0.21147017 - g * 0.52261711 + b * 0.31114694,
      ]
      const limit = 35215 * threshold * threshold
      for (let p = 0; p < da.length; p += 4) {
        const [y1, i1, q1] = yiq(da[p], da[p + 1], da[p + 2])
        const [y2, i2, q2] = yiq(db[p], db[p + 1], db[p + 2])
        const delta =
          0.5053 * (y1 - y2) ** 2 +
          0.299 * (i1 - i2) ** 2 +
          0.1957 * (q1 - q2) ** 2
        if (delta <= limit) continue
        count++
        const x = (p / 4) % w
        const y = Math.floor(p / 4 / w)
        box = box
          ? [
              Math.min(box[0], x),
              Math.min(box[1], y),
              Math.max(box[2], x),
              Math.max(box[3], y),
            ]
          : [x, y, x, y]
      }
      return { count, box }
    },
    [
      `data:image/png;base64,${a.toString('base64')}`,
      `data:image/png;base64,${b.toString('base64')}`,
      PIXEL_THRESHOLD,
    ] as const,
  )
}

/** The fixture holds every block kind the identity case relies on. */
async function expectFixtureBlocks(page: Page): Promise<void> {
  const facts = await page.evaluate(() => {
    const root = document.querySelector(
      '.vditor-ir > .vditor-reset',
    ) as HTMLElement
    const headings = Array.from(
      root.querySelectorAll(
        ':scope > h1, :scope > h2, :scope > h3, :scope > h4',
      ),
    )
    const last = headings[headings.length - 1]
    const image = root.querySelector('img[align="right"]')
    return {
      toc: !!root.querySelector(':scope > .vditor-toc'),
      linkRefs: !!root.querySelector(
        ':scope > [data-type="link-ref-defs-block"]',
      ),
      footnotes: !!root.querySelector(':scope > [data-type="footnotes-block"]'),
      lastHeadingFoldable: last
        ? last.hasAttribute('data-vmde-foldable')
        : null,
      imageFloat: image ? getComputedStyle(image).cssFloat : null,
    }
  })
  expect(facts, 'the fixture blocks').toEqual({
    toc: true,
    linkRefs: true,
    footnotes: true,
    lastHeadingFoldable: false,
    imageFloat: 'right',
  })
}

test('the shipped stylesheet contains each top-level IR block', {
  tag: '@visual',
}, async ({ page }) => {
  await openEditor(page)
  const contain = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir > .vditor-reset > *'),
    ).map(
      (el) => `${el.tagName.toLowerCase()}: ${getComputedStyle(el).contain}`,
    ),
  )
  expect(contain.length).toBeGreaterThan(0)
  expect(contain).toEqual(
    contain.map((entry) => `${entry.split(':')[0]}: layout`),
  )
})

for (const theme of THEMES) {
  test(`no pixel moves: ${theme[0]}`, { tag: '@visual' }, async ({ page }) => {
    test.setTimeout(180_000)
    const init = await openEditor(page)
    await applyTheme(page, init, theme)
    await expectFixtureBlocks(page)
    await setStyle(
      page,
      'vmde-025-caret',
      '* { caret-color: transparent !important; }',
    )
    const moved: Record<string, PixelDiff> = {}
    const resized: Record<string, [string[], string[]]> = {}
    for (const [state, enter] of STATES) {
      await setStyle(page, 'vmde-025-today', null)
      await enter(page)
      const shipped = await page.screenshot({ fullPage: true })
      const shippedHeights = await blockHeights(page)
      await setStyle(page, 'vmde-025-today', TODAY)
      const today = await page.screenshot({ fullPage: true })
      const todayHeights = await blockHeights(page)
      await setStyle(page, 'vmde-025-today', null)
      const diff = await diffPixels(page, shipped, today)
      if (diff.count > MAX_DIFF_PIXELS) moved[state] = diff
      if (shippedHeights.join() !== todayHeights.join())
        resized[state] = [shippedHeights, todayHeights]
    }
    expect(
      resized,
      `${theme[0]}: states whose top-level block heights differ from today's cascade`,
    ).toEqual({})
    expect(
      moved,
      `${theme[0]}: states with more than ${MAX_DIFF_PIXELS} pixels that differ from today's cascade`,
    ).toEqual({})
  })
}
