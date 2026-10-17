import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 649: section indentation by heading level. Every test drives the real webview entry
// (main.ts through prerender.html) with a stubbed `acquireVsCodeApi`, turns the setting on and off
// through the live `config-changed` message, and asserts MEASURED horizontal offsets, never pixels
// from a golden. Depth rule: a top-level heading's depth is its level - 1 (absolute), every other
// top-level block takes the depth of the preceding heading, blocks before the first heading are 0.
// Split View's SOURCE pane is never indented; its PREVIEW pane is.

type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'

// Surface whose top-level children carry the indentation (Split: the right-hand preview pane).
const PANE: Record<Mode, string> = {
  ir: '.vditor-ir > .vditor-reset',
  wysiwyg: '.vditor-wysiwyg > .vditor-reset',
  sv: '.vditor-preview > .vditor-reset',
  preview: '.vditor-preview > .vditor-reset',
}
const MODES: readonly Mode[] = ['ir', 'wysiwyg', 'preview', 'sv']
const STEP = 24

// [token, expected depth]. Tokens are unique words; headings are `tokH<n>`, paragraphs `tokp<name>`.
const DOC = `tokIntro paragraph before the first heading.

# tokH1

tokpH1

## tokH2

tokpH2

### tokH3

tokpH3

#### tokH4

tokpH4

##### tokH5

tokpH5

###### tokH6

tokpH6

# tokNext1

tokpNext1

### tokSkip

tokpSkip

## tokBack2

tokpBack2
`

const EXPECTED: ReadonlyArray<readonly [string, number]> = [
  ['tokIntro', 0],
  ['tokH1', 0],
  ['tokpH1', 0],
  ['tokH2', 1],
  ['tokpH2', 1],
  ['tokH3', 2],
  ['tokpH3', 2],
  ['tokH4', 3],
  ['tokpH4', 3],
  ['tokH5', 4],
  ['tokpH5', 4],
  ['tokH6', 5],
  ['tokpH6', 5],
  // A same-or-higher heading ends the deepest section: back to depth 0.
  ['tokNext1', 0],
  ['tokpNext1', 0],
  // Skipped levels keep the absolute rule: `#` then `###` is 2 steps.
  ['tokSkip', 2],
  ['tokpSkip', 2],
  ['tokBack2', 1],
  ['tokpBack2', 1],
]

function initFor(mode: Mode, content: string) {
  return {
    command: 'update',
    type: 'init',
    content,
    cdn: '/vditor',
    options: {
      showToolbar: true,
      useVscodeThemeColor: true,
      enableFullWidth: true,
      contentTheme: 'auto',
      defaultMode: mode,
    },
    theme: 'light',
    themeKind: 'light',
    wiki: { enabled: false },
  }
}
type Init = ReturnType<typeof initFor>

interface Opened {
  init: Init
}

async function openMode(
  page: Page,
  mode: Mode,
  content = DOC,
  viewport = { width: 1100, height: 800 },
): Promise<Opened> {
  const init = initFor(mode, content)
  await page.setViewportSize(viewport)
  await page.addInitScript((i) => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => {
        ;(window as any).__posted.push(m)
        if (m?.command === 'ready') window.postMessage(i, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/prerender.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      !document.getElementById('vmde-prerender') &&
      !!document.querySelector('#app .vditor-reset'),
    undefined,
    { timeout: 20_000 },
  )
  await page.evaluate(`
    window.__ind = {
      block(paneSel, tok) {
        const root = document.querySelector(paneSel)
        if (!root) return null
        const norm = (s) => s.replace(/[\\u200b\\s]+/g, ' ')
        for (const el of root.children)
          if (norm(el.textContent || '').includes(tok)) return el
        return null
      },
      // Left edge of the surface's content box: the depth-0 position every block is measured from.
      contentLeft(paneSel) {
        const root = document.querySelector(paneSel)
        const cs = getComputedStyle(root)
        return root.getBoundingClientRect().left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)
      },
      offset(paneSel, tok) {
        const el = window.__ind.block(paneSel, tok)
        if (!el) return null
        return Math.round((el.getBoundingClientRect().left - window.__ind.contentLeft(paneSel)) * 100) / 100
      },
    }
  `)
  await page.waitForTimeout(500)
  return { init }
}

async function setIndent(
  page: Page,
  init: Init,
  on: boolean,
  size?: unknown,
): Promise<void> {
  await page.evaluate(
    ({ init, on, size }) =>
      window.postMessage(
        {
          ...init,
          command: 'config-changed',
          options: {
            ...init.options,
            sectionIndent: on,
            sectionIndentSize: size,
          },
        },
        '*',
      ),
    { init, on, size },
  )
  await page.waitForTimeout(400)
}

const offset = (page: Page, mode: Mode, tok: string): Promise<number | null> =>
  page.evaluate(([p, t]) => (window as any).__ind.offset(p, t), [
    PANE[mode],
    tok,
  ] as const)

async function offsets(
  page: Page,
  mode: Mode,
  tokens: readonly string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const t of tokens) out[t] = await offset(page, mode, t)
  return out
}

// Precondition of every test that compares "with the setting on" against "off": the setting really
// indented the block, otherwise the comparison proves nothing.
async function expectIndented(
  page: Page,
  mode: Mode,
  tok: string,
  depth: number,
): Promise<void> {
  expect(await offset(page, mode, tok)).toBe(depth * STEP)
}

const TOKENS = EXPECTED.map(([t]) => t)
const expectedOffsets = (step: number) =>
  Object.fromEntries(EXPECTED.map(([t, d]) => [t, d * step]))

const getValue = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).vditor.getValue())

const posted = (page: Page, command: string): Promise<number> =>
  page.evaluate(
    (c) => (window as any).__posted.filter((m: any) => m?.command === c).length,
    command,
  )

const countAttr = (page: Page, attr: string): Promise<number> =>
  page.evaluate((a) => document.querySelectorAll(`[${a}]`).length, attr)

// Acceptance "Offsets match depth x step in every mode with levels 1-6 and skips" and
// "Indentation ends at the next same or higher heading" (tokNext1 returns to 0 after depth 5).
for (const mode of MODES) {
  test(`${mode}: offsets equal depth x step for levels 1-6, skips and section ends`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    await setIndent(page, init, true, STEP)
    await expect(page.locator('body')).toHaveAttribute(
      'data-section-indent',
      '1',
    )
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(STEP))
  })
}

// Acceptance "Size change is proportional and live": the step changes without a reload, and an
// out-of-range or non-numeric size falls back to 24 (resolver contract).
for (const mode of MODES) {
  test(`${mode}: a live size change rescales every offset; an invalid size falls back to 24`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    await setIndent(page, init, true, STEP)
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(STEP))
    await setIndent(page, init, true, 40)
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(40))
    await setIndent(page, init, true, 3)
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(24))
    await setIndent(page, init, true, 'wide')
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(24))
  })
}

// Acceptance "Off equals today": off has no indentation attributes and today's (zero) offsets,
// and switching off again removes every attribute so the DOM equals the never-enabled DOM.
for (const mode of MODES) {
  test(`${mode}: off leaves no attributes and zero offsets, also after a toggle round trip`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const zero = expectedOffsets(0)
    expect(await offsets(page, mode, TOKENS)).toEqual(zero)
    expect(await countAttr(page, 'data-vmde-indent')).toBe(0)
    expect(await countAttr(page, 'data-vmde-indent-root')).toBe(0)

    await setIndent(page, init, true, STEP)
    // Precondition: the setting really applied (otherwise the off checks below prove nothing).
    expect(await offset(page, mode, 'tokH3')).toBe(2 * STEP)

    await setIndent(page, init, false, STEP)
    await expect(page.locator('body')).toHaveAttribute(
      'data-section-indent',
      '0',
    )
    expect(await offsets(page, mode, TOKENS)).toEqual(zero)
    expect(await countAttr(page, 'data-vmde-indent')).toBe(0)
    expect(await countAttr(page, 'data-vmde-indent-root')).toBe(0)
  })
}

// Acceptance "Text, dirty state, Undo, caret, selection, copy": a toggle or size change never
// changes the Markdown and never posts an `edit` to the host.
for (const mode of MODES) {
  test(`${mode}: toggling and resizing leaves the Markdown unchanged and posts no edit`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const before = await getValue(page)
    const edits = await posted(page, 'edit')
    await setIndent(page, init, true, STEP)
    expect(await offset(page, mode, 'tokH3')).toBe(2 * STEP)
    await setIndent(page, init, true, 48)
    await setIndent(page, init, false, 48)
    expect(await getValue(page)).toBe(before)
    expect(await posted(page, 'edit')).toBe(edits)
  })
}

// Acceptance "Split source pane shows NO indentation" (Owner answer): the preview pane indents,
// the source pane's heading and content lines all start at the same x as with the setting off.
test('sv: the source pane is not indented while the preview pane is', async ({
  page,
}) => {
  const { init } = await openMode(page, 'sv')
  const lineLefts = (tok: string) =>
    page.evaluate((t) => {
      const root = document.querySelector('.vditor-sv') as HTMLElement
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = (n.nodeValue ?? '').indexOf(t)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + 1)
        return Math.round(r.getBoundingClientRect().left * 100) / 100
      }
      return null
    }, tok)
  const tokens = ['tokIntro', 'tokH1', 'tokH3', 'tokpH3', 'tokH6', 'tokpSkip']
  const off: Record<string, number | null> = {}
  for (const t of tokens) off[t] = await lineLefts(t)
  await setIndent(page, init, true, STEP)
  // Precondition: the preview pane is indented.
  expect(await offset(page, 'sv', 'tokH3')).toBe(2 * STEP)
  const on: Record<string, number | null> = {}
  for (const t of tokens) on[t] = await lineLefts(t)
  expect(on).toEqual(off)
  expect(await page.locator('.vditor-sv [data-vmde-indent]').count()).toBe(0)
  expect(await page.locator('.vditor-sv[data-vmde-indent-root]').count()).toBe(
    0,
  )
})

// Acceptance "Folding, hoisting, ... handles, fold glyphs": the heading marker, the fold glyph
// and the block handle follow the block box, so their position RELATIVE to the block is the same
// with the setting on and off (IR and WYSIWYG).
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: heading marker, fold glyph and block handle keep their place relative to the block`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const rel = () =>
      page.evaluate(
        ([pane, tok]) => {
          const h = (window as any).__ind.block(pane, tok) as HTMLElement
          const hb = h.getBoundingClientRect()
          const marker = h.querySelector(
            '.vditor-ir__marker--heading, .vditor-wysiwyg__marker--heading',
          ) as HTMLElement | null
          const glyph = getComputedStyle(h, '::after')
          return {
            foldable: h.hasAttribute('data-vmde-foldable'),
            marker: marker
              ? Math.round(
                  (marker.getBoundingClientRect().left - hb.left) * 100,
                ) / 100
              : null,
            glyphLeft: glyph.left,
            glyphWidth: glyph.width,
          }
        },
        [PANE[mode], 'tokH3'] as const,
      )
    const handleGap = async () => {
      await page.locator(`${PANE[mode]} > :has-text("tokpH3")`).first().hover()
      return page.evaluate(
        ([pane, tok]) => {
          const b = (window as any).__ind.block(pane, tok) as HTMLElement
          const handle = document.querySelector('.vmde-block-handle')
          return handle
            ? Math.round(
                (b.getBoundingClientRect().left -
                  handle.getBoundingClientRect().right) *
                  100,
              ) / 100
            : null
        },
        [PANE[mode], 'tokpH3'] as const,
      )
    }
    const relOff = await rel()
    const gapOff = await handleGap()
    await setIndent(page, init, true, STEP)
    await expectIndented(page, mode, 'tokH3', 2)
    expect(await rel()).toEqual(relOff)
    expect(await handleGap()).toBe(gapOff)
    expect(gapOff).not.toBeNull()
  })

  test(`${mode}: the fold gutter of an indented heading folds its section and keeps depths on unfold`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    await setIndent(page, init, true, STEP)
    expect(await offset(page, mode, 'tokH3')).toBe(2 * STEP)
    const glyph = await page.evaluate(
      ([pane, tok]) => {
        const h = (window as any).__ind.block(pane, tok) as HTMLElement
        const box = h.getBoundingClientRect()
        const icon = getComputedStyle(h, '::after')
        return {
          x: box.left + parseFloat(icon.left) + parseFloat(icon.width) / 2,
          y: box.top + parseFloat(icon.top) + parseFloat(icon.height) / 2,
        }
      },
      [PANE[mode], 'tokH3'] as const,
    )
    await page.mouse.click(glyph.x, glyph.y)
    await expect(page.locator(`${PANE[mode]} [data-vmde-folded]`)).toHaveCount(
      1,
    )
    // Folded: tokpH3 and the deeper sections are hidden, the next sibling stays at depth 0.
    expect(await offset(page, mode, 'tokNext1')).toBe(0)
    await page.mouse.click(glyph.x, glyph.y)
    await expect(page.locator(`${PANE[mode]} [data-vmde-folded]`)).toHaveCount(
      0,
    )
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(STEP))
  })

  // Acceptance "hoisting keeps absolute depth" (Owner answer 3a).
  test(`${mode}: a hoisted section keeps its absolute depth`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    await setIndent(page, init, true, STEP)
    expect(await offset(page, mode, 'tokH3')).toBe(2 * STEP)
    await page
      .locator(`${PANE[mode]} > :is(h3)`)
      .first()
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Hoist section' }).click()
    await expect(
      page.getByRole('navigation', { name: 'Hoisted section' }),
    ).toBeVisible()
    // Measured from the surface's content edge, so hiding the earlier blocks cannot shift it.
    expect(
      await offsets(page, mode, ['tokH3', 'tokpH3', 'tokH4', 'tokH6']),
    ).toEqual({
      tokH3: 2 * STEP,
      tokpH3: 2 * STEP,
      tokH4: 3 * STEP,
      tokH6: 5 * STEP,
    })
  })
}

// Acceptance "Change bars": a live toggle re-renders the bars; they keep their x position and
// stay aligned vertically with the changed block (IR and WYSIWYG).
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: change bars keep their x and follow the block after a live toggle`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const line = DOC.split('\n').findIndex((l) => l.includes('tokpH3'))
    await page.evaluate(
      (l) =>
        window.postMessage(
          {
            command: 'diff-info',
            changes: [{ startLine: l, endLine: l + 1, type: 'modified' }],
          },
          '*',
        ),
      line,
    )
    await page.waitForTimeout(300)
    const bar = () =>
      page.evaluate(
        ([pane, tok]) => {
          const bars = [...document.querySelectorAll('.me-diff-marker')]
          const b = (window as any).__ind.block(pane, tok) as HTMLElement
          const br = b.getBoundingClientRect()
          const m = bars[0]?.getBoundingClientRect()
          return {
            count: bars.length,
            x: m ? Math.round(m.left * 100) / 100 : null,
            alignedTop: m ? Math.abs(m.top - br.top) <= 2 : false,
          }
        },
        [PANE[mode], 'tokpH3'] as const,
      )
    const before = await bar()
    expect(before.count).toBe(1)
    await setIndent(page, init, true, STEP)
    await expectIndented(page, mode, 'tokpH3', 2)
    const after = await bar()
    expect(after.count).toBe(1)
    expect(after.x).toBe(before.x)
    expect(after.alignedTop).toBe(true)
  })
}

// Acceptance "wide blocks stay inside the column": at a narrow width a deep section's table, code
// block and diagram keep their box inside the surface content box, and the offset is capped at 40%
// of the column.
for (const mode of MODES) {
  test(`${mode}: wide table, code and diagram stay inside the column at a narrow width`, async ({
    page,
  }) => {
    const wide = [
      '# tokW1',
      '',
      '###### tokW6',
      '',
      '| a | b | c | d | e | f | g | h | i | j |',
      '|---|---|---|---|---|---|---|---|---|---|',
      `| ${'longcellcontent '.repeat(10)} | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |`,
      '',
      '```js',
      `const tokCode = "${'x'.repeat(200)}"`,
      '```',
      '',
      '```mermaid',
      'graph LR',
      '  A[tokDiagram start] --> B[A very long label that widens the diagram] --> C[End]',
      '```',
      '',
    ].join('\n')
    const { init } = await openMode(page, mode, wide, {
      width: 520,
      height: 800,
    })
    const measure = () =>
      page.evaluate((pane) => {
        const root = document.querySelector(pane) as HTMLElement
        const cs = getComputedStyle(root)
        const left =
          root.getBoundingClientRect().left +
          parseFloat(cs.paddingLeft) +
          parseFloat(cs.borderLeftWidth)
        const right =
          root.getBoundingClientRect().right -
          parseFloat(cs.paddingRight) -
          parseFloat(cs.borderRightWidth)
        const kids = [...root.children].filter((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && /TABLE|PRE|DIV/.test(e.tagName)
        })
        return {
          column: right - left,
          boxes: kids.map((e) => {
            const r = e.getBoundingClientRect()
            return {
              tag: e.tagName,
              offset: r.left - left,
              overflow: r.right - right,
            }
          }),
        }
      }, PANE[mode])
    // Today's overflow (some panes already scroll a wide table inside their own box) is the
    // baseline: indentation must not push any box further right than that.
    const off = await measure()
    await setIndent(page, init, true, 64)
    expect(await offset(page, mode, 'tokW6')).toBeGreaterThan(0) // precondition
    const on = await measure()
    expect(on.boxes.length).toBeGreaterThanOrEqual(2)
    expect(on.boxes.length).toBe(off.boxes.length)
    on.boxes.forEach((b, i) => {
      expect(
        b.overflow,
        `${b.tag} stays inside the column`,
      ).toBeLessThanOrEqual(Math.max(off.boxes[i].overflow, 0) + 1)
      expect(b.offset, `${b.tag} offset capped at 40%`).toBeLessThanOrEqual(
        on.column * 0.4 + 1,
      )
    })
  })
}

// Acceptance "copy text/plain and text/html carry no indentation". Preview copies the selection
// through a temporary element and the real clipboard; IR and WYSIWYG write markdown text/plain
// (their handlers leave text/html empty). Each payload with the setting on equals the payload
// with it off, and the HTML has no margin or indentation attribute.
test.describe('copy carries no indentation', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

  for (const mode of ['preview', 'sv'] as const) {
    test(`${mode}: Preview copy text/html and text/plain are identical on and off`, async ({
      page,
    }) => {
      const { init } = await openMode(page, mode)
      const copy = async () => {
        await page.evaluate((pane) => {
          const root = document.querySelector(pane) as HTMLElement
          const r = document.createRange()
          r.selectNodeContents(root)
          const s = getSelection()!
          s.removeAllRanges()
          s.addRange(r)
        }, PANE[mode])
        await page.keyboard.press('Control+c')
        await page.waitForTimeout(300)
        return page.evaluate(async () => {
          const out: Record<string, string> = {}
          for (const item of await navigator.clipboard.read())
            for (const t of item.types)
              out[t] = await (await item.getType(t)).text()
          return out
        })
      }
      const off = await copy()
      await setIndent(page, init, true, STEP)
      await expectIndented(page, mode, 'tokH3', 2)
      const on = await copy()
      expect(on['text/plain']).toBe(off['text/plain'])
      expect(on['text/html']).toBe(off['text/html'])
      expect(on['text/html']).not.toMatch(/margin|data-vmde-indent/)
    })
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode}: copy payload is identical on and off`, async ({ page }) => {
      const { init } = await openMode(page, mode)
      const copy = () =>
        page.evaluate((pane) => {
          const root = document.querySelector(pane) as HTMLElement
          root.focus()
          const r = document.createRange()
          r.selectNodeContents(root)
          const s = getSelection()!
          s.removeAllRanges()
          s.addRange(r)
          const dt = new DataTransfer()
          root.dispatchEvent(
            new ClipboardEvent('copy', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          )
          return {
            plain: dt.getData('text/plain'),
            html: dt.getData('text/html'),
          }
        }, PANE[mode])
      const off = await copy()
      await setIndent(page, init, true, STEP)
      await expectIndented(page, mode, 'tokH3', 2)
      const on = await copy()
      expect(on).toEqual(off)
      expect(on.html).not.toMatch(/margin|data-vmde-indent/)
    })
  }
})
