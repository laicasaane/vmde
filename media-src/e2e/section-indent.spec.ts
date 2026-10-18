import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

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

function initFor(
  mode: Mode,
  content: string,
  extra: Record<string, unknown> = {},
) {
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
      ...extra,
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
  extra: Record<string, unknown> = {},
): Promise<Opened> {
  const init = initFor(mode, content, extra)
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
    // 30 px x depth 5 = 150 px stays under the 40% cap of the narrowest pane (Split's preview pane,
    // about 415 px wide here); a larger step would be capped there by design.
    await setIndent(page, init, true, 30)
    expect(await offsets(page, mode, TOKENS)).toEqual(expectedOffsets(30))
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
      // Two columns: each cell has a floor of about 27 px (padding and border), so a ten-column table
      // cannot shrink below ~270 px and would overflow whatever the indentation does once the room
      // left in a narrow pane (250 px, or 75 px in Split's preview pane) is smaller than that floor.
      '| a | b |',
      '|---|---|',
      `| ${'longcellcontent '.repeat(10)} | 2 |`,
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
    // Wait for the table auto-fit to settle first: in Split's 125 px preview pane it widens the
    // table after load, and a baseline taken earlier is smaller than the settled one (measured:
    // the settled overflow is 146 px with the setting off AND on).
    await page.waitForTimeout(1500)
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

// Acceptance "Folding ... wide blocks keep working": a table is indented with its section like any
// other block (depth x step) and still ends inside the column at a narrow width, with no more
// overflow than today's baseline. A table nested in a quote keeps its full width (the offset
// variable does not inherit).
for (const mode of MODES) {
  test(`${mode}: tables are indented by depth x step and stay inside the column`, async ({
    page,
  }) => {
    const table = (tok: string) => `| ${tok} | b |\n|---|---|\n| 1 | 2 |\n`
    const doc = `# tokT1\n\n${table('tokTa')}\n## tokT2\n\n${table('tokTb')}\n### tokT3\n\n${table('tokTc')}\n> ${'x'.repeat(5)}\n>\n> | tokTq | b |\n> |---|---|\n> | 1 | 2 |\n`
    const { init } = await openMode(page, mode, doc, {
      width: 520,
      height: 800,
    })
    await page.waitForTimeout(1500)
    const tableBox = (tok: string) =>
      page.evaluate(
        ([pane, t]) => {
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
          const el = [...root.querySelectorAll('table')].find((e) =>
            (e.textContent || '').includes(t),
          ) as HTMLElement
          const r = el.getBoundingClientRect()
          return {
            offset: Math.round((r.left - left) * 100) / 100,
            overflow: Math.round((r.right - right) * 100) / 100,
            width: Math.round(r.width * 100) / 100,
          }
        },
        [PANE[mode], tok] as const,
      )
    const off = {
      a: await tableBox('tokTa'),
      b: await tableBox('tokTb'),
      c: await tableBox('tokTc'),
      q: await tableBox('tokTq'),
    }
    await setIndent(page, init, true, 24)
    await page.waitForTimeout(500)
    const on = {
      a: await tableBox('tokTa'),
      b: await tableBox('tokTb'),
      c: await tableBox('tokTc'),
      q: await tableBox('tokTq'),
    }
    // Sections: tokTa under `#` (0), tokTb under `##` (1), tokTc and the quote under `###` (2).
    expect(on.a.offset).toBe(0)
    expect(on.b.offset).toBe(24)
    expect(on.c.offset).toBe(48)
    for (const k of ['a', 'b', 'c'] as const)
      expect(on[k].overflow).toBeLessThanOrEqual(
        Math.max(off[k].overflow, 0) + 1,
      )
    // The table inside the indented quote moves with the quote and keeps its own width.
    expect(on.q.width).toBeCloseTo(off.q.width - 48, 0)
    expect(on.q.offset - off.q.offset).toBe(48)
    expect(await offset(page, mode, 'tokT3')).toBe(48)
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

// A long document: every section carries enough filler to scroll, so a heading can be brought
// into view at a measured scroll position. Headings pair 1:1 between source and preview.
const LONG_DOC = [
  'tokIntro paragraph before the first heading.',
  ...[1, 2, 3, 4, 5, 6].flatMap((n) => [
    `${'#'.repeat(n)} tokL${n}`,
    ...Array.from(
      { length: 14 },
      (_, i) => `\nfiller text of section ${n} line ${i}.`,
    ),
    '',
  ]),
].join('\n')

// The scrolling element that owns `pane`: the nearest ancestor that actually scrolls.
const scrollerScript = `
  window.__scroller = (paneSel) => {
    for (let e = document.querySelector(paneSel); e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY
      if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) return e
    }
    return null
  }
`

// Acceptance "outline viewport highlights ... unchanged on and off": with the same heading
// scrolled to the top of the surface, the outline entries carrying the in-viewport class are the
// same with the setting off, on, a live size change, and off again. Split (sv) is not covered:
// Vditor hides the outline there (display none, so the viewport sync never runs).
for (const mode of ['ir', 'wysiwyg', 'preview'] as const) {
  test(`${mode}: outline viewport highlights are identical with indentation off, on, resized and off again`, async ({
    page,
  }) => {
    const { init } = await openMode(
      page,
      mode,
      LONG_DOC,
      { width: 1100, height: 500 },
      { outlineOpen: true },
    )
    await page.evaluate(scrollerScript)
    await expect(page.locator('.vditor-outline li > span')).toHaveCount(6)
    const highlighted = (tok: string) =>
      page.evaluate(
        async ([pane, t]) => {
          const sc = (window as any).__scroller(pane) as HTMLElement
          const h = (window as any).__ind.block(pane, t) as HTMLElement
          sc.scrollTop +=
            h.getBoundingClientRect().top - sc.getBoundingClientRect().top
          await new Promise((r) => setTimeout(r, 400))
          return [
            ...document.querySelectorAll(
              '.vditor-outline li > span.vmde-outline-item--in-viewport',
            ),
          ].map((e) => (e.textContent ?? '').trim())
        },
        [PANE[mode], tok] as const,
      )
    const tokens = ['tokL3', 'tokL5', 'tokL1']
    const run = async () => {
      const out: string[][] = []
      for (const t of tokens) out.push(await highlighted(t))
      return out
    }
    const baseline = await run()
    // Precondition: the highlight tracks the heading in view (a hit at all, containing the target).
    baseline.forEach((names, i) => {
      expect(names.length).toBeGreaterThan(0)
      expect(names).toContain(tokens[i])
    })
    await setIndent(page, init, true, STEP)
    await expectIndented(page, mode, 'tokL3', 2)
    expect(await run()).toEqual(baseline)
    await setIndent(page, init, true, 40)
    expect(await run()).toEqual(baseline)
    await setIndent(page, init, false, 40)
    expect(await run()).toEqual(baseline)
  })
}

// Acceptance "Split scroll sync aligns headings with the source ... on and off": with a heading
// centered in the source pane, the matching preview heading sits at the preview's vertical centre
// (the existing task-48 tolerance), with the setting off and on, and a live size change keeps it.
test('sv: Split scroll sync keeps preview headings aligned with the source, indentation on and off', async ({
  page,
}) => {
  const { init } = await openMode(page, 'sv', LONG_DOC, {
    width: 1300,
    height: 500,
  })
  await page.evaluate(scrollerScript)
  const align = (tok: string) =>
    page.evaluate(
      async ([t, pane]) => {
        const src = document.querySelector('.vditor-sv') as HTMLElement
        const w = document.createTreeWalker(src, NodeFilter.SHOW_TEXT)
        let rect: DOMRect | null = null
        for (let n = w.nextNode(); n && !rect; n = w.nextNode()) {
          const i = (n.nodeValue ?? '').indexOf(t)
          if (i < 0) continue
          const r = document.createRange()
          r.setStart(n, i)
          r.setEnd(n, i + t.length)
          rect = r.getBoundingClientRect()
        }
        if (!rect) return null
        const sbox = src.getBoundingClientRect()
        src.scrollTop +=
          rect.top + rect.height / 2 - (sbox.top + sbox.height / 2)
        await new Promise((r) => setTimeout(r, 500))
        const pv = (window as any).__scroller(pane) as HTMLElement
        const heading = (window as any).__ind.block(pane, t) as HTMLElement
        const pbox = pv.getBoundingClientRect()
        const hb = heading.getBoundingClientRect()
        return {
          sourceScrolled: src.scrollTop > 0,
          previewScrolled: pv.scrollTop > 0,
          previewOffset: Math.round(
            hb.top + hb.height / 2 - (pbox.top + pbox.height / 2),
          ),
        }
      },
      [tok, PANE.sv] as const,
    )
  const tokens = ['tokL4', 'tokL6', 'tokL2']
  const measure = async () => {
    const out = []
    for (const t of tokens) out.push(await align(t))
    return out
  }
  const check = (rows: Awaited<ReturnType<typeof measure>>) =>
    rows.forEach((r, i) => {
      expect(r, tokens[i]).not.toBeNull()
      expect(r?.sourceScrolled).toBe(true)
      expect(r?.previewScrolled).toBe(true)
      expect(Math.abs(r?.previewOffset ?? 999), tokens[i]).toBeLessThan(25)
    })
  const off = await measure()
  check(off)
  await setIndent(page, init, true, STEP)
  await expectIndented(page, 'sv', 'tokL3', 2)
  const on = await measure()
  check(on)
  await setIndent(page, init, true, 40)
  check(await measure())
  await setIndent(page, init, false, 40)
  check(await measure())
})

// Acceptance "caret and selection unchanged by toggling and by a live size change": the selection
// is read as offsets into the editable surface's text (IR and WYSIWYG: the Markdown-bearing
// surface; Split: the source pane), plus the selected string. A caret, and in a fresh page a
// range, set once must read back identical after on, a size change, and off again. They are
// separate tests because a programmatic selection does not update the caret authority's last
// intent, so a range set after a caret would be replaced by that older caret on the next layout
// event for a reason unrelated to the setting.
for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  for (const kind of ['caret', 'selection'] as const) {
    test(`${mode}: ${kind} offsets survive toggling and a live size change`, async ({
      page,
    }) => {
      const { init } = await openMode(page, mode)
      const read = () =>
        page.evaluate(() => {
          const v = (window as any).vditor
          const root = v.vditor[v.getCurrentMode()].element as HTMLElement
          const s = getSelection()!
          const at = (node: Node, off: number) => {
            const r = document.createRange()
            r.selectNodeContents(root)
            r.setEnd(node, off)
            return r.toString().length
          }
          if (!s.rangeCount || !s.anchorNode || !s.focusNode) return null
          return {
            collapsed: s.isCollapsed,
            anchor: at(s.anchorNode, s.anchorOffset),
            focus: at(s.focusNode, s.focusOffset),
            text: s.toString(),
            inRoot: root.contains(s.anchorNode) && root.contains(s.focusNode),
            focused: root.contains(document.activeElement),
          }
        })
      // A caret inside a paragraph, or a range from it across the paragraph break into the next heading.
      await page.evaluate(
        selectEditorText,
        kind === 'caret'
          ? (['tokpH3', 3, 0] as const)
          : (['tokpH3', 2, 12] as const),
      )
      const off = await read()
      // Precondition: the selection really is what the case claims.
      expect(off?.inRoot).toBe(true)
      expect(off?.collapsed).toBe(kind === 'caret')
      if (kind === 'selection') expect(off?.text.length).toBeGreaterThan(0)
      await setIndent(page, init, true, STEP)
      await expectIndented(page, mode, 'tokH3', 2)
      expect(await read(), 'on').toEqual(off)
      await setIndent(page, init, true, 40)
      expect(await read(), 'resized').toEqual(off)
      await setIndent(page, init, false, 40)
      expect(await read(), 'off again').toEqual(off)
    })
  }
}

// Task 660 residual 1: a raw HTML heading in the Preview DOM is a top-level H2/H4, but in IR and
// WYSIWYG the same source is a non-heading html-block. The Preview source mask marks it so it takes
// the running depth and starts no section. Three shapes: a block, a heading inside a paragraph that
// the parser hoists, and an HTML-block continuation line. Split's preview pane shares the renderer.
for (const mode of ['preview', 'sv'] as const) {
  test(`${mode}: a raw HTML heading takes its section's depth and starts no section`, async ({
    page,
  }) => {
    const doc = [
      '# tokRH1',
      '',
      '### tokRH3',
      '',
      '<h2>tokRawBare</h2>',
      '',
      'tokRawAfterBare',
      '',
      'para <h2>tokRawInline</h2> tail',
      '',
      '<div></div>',
      '<h4>tokRawCont</h4>',
      '',
      'tokRawAfterCont',
      '',
      '## tokRH2',
      '',
      'tokpRH2',
      '',
    ].join('\n')
    const { init } = await openMode(page, mode, doc)
    // Precondition: the three raw headings are real top-level headings carrying the mark, and the
    // Markdown headings do not.
    const marked = await page.evaluate((pane) => {
      const root = document.querySelector(pane) as HTMLElement
      return [...root.children]
        .filter((e) => /^H[1-6]$/.test(e.tagName))
        .map((e) => [e.textContent, e.hasAttribute('data-vmde-raw-heading')])
    }, PANE[mode])
    expect(marked).toEqual([
      ['tokRH1', false],
      ['tokRH3', false],
      ['tokRawBare', true],
      ['tokRawInline', true],
      ['tokRawCont', true],
      ['tokRH2', false],
    ])
    await setIndent(page, init, true, STEP)
    const tokens = [
      'tokRH3',
      'tokRawBare',
      'tokRawAfterBare',
      'tokRawInline',
      'tokRawCont',
      'tokRawAfterCont',
      'tokRH2',
      'tokpRH2',
    ]
    // Depth 2 for the `###` section and everything in it, raw headings included; the next Markdown
    // `##` is depth 1 (a raw `<h2>` or `<h4>` must not have started a section).
    expect(await offsets(page, mode, tokens)).toEqual({
      tokRH3: 2 * STEP,
      tokRawBare: 2 * STEP,
      tokRawAfterBare: 2 * STEP,
      tokRawInline: 2 * STEP,
      tokRawCont: 2 * STEP,
      tokRawAfterCont: 2 * STEP,
      tokRH2: STEP,
      tokpRH2: STEP,
    })
  })
}

// Task 660 residual 3: the selector that keeps Preview's footnote list at depth 0 was only checked in
// jsdom. Here it runs on the DOM the real Lute emits, under a deep section. The list is one top-level
// `div.footnotes-defs-div` at the document end.
for (const mode of ['preview', 'sv'] as const) {
  test(`${mode}: the footnote list stays at depth 0 under a deep section`, async ({
    page,
  }) => {
    const doc = '### tokFnH\n\ntokpFn note[^1]\n\n[^1]: tokNote\n'
    const { init } = await openMode(page, mode, doc)
    await setIndent(page, init, true, STEP)
    const footnote = await page.evaluate((pane) => {
      const root = document.querySelector(pane) as HTMLElement
      const list = [...root.children].find((e) =>
        e.matches('div.footnotes-defs-div'),
      )
      return list
        ? {
            isLast: list === root.lastElementChild,
            mark: list.getAttribute('data-vmde-indent'),
            text: list.textContent,
          }
        : null
    }, PANE[mode])
    // Precondition: the structure the selector targets exists.
    expect(footnote?.isLast).toBe(true)
    expect(footnote?.text).toContain('tokNote')
    expect(footnote?.mark).toBeNull()
    expect(await offset(page, mode, 'tokNote')).toBe(0)
    // The section content before it is indented, so depth 0 here is the selector's doing.
    expect(await offset(page, mode, 'tokpFn')).toBe(2 * STEP)
  })
}

// Task 660 residual 4: a table whose columns cannot fit the room left by its indentation gives up
// only the indentation it cannot use. 520 px viewport, step 64, depth 5: the offset is capped at 40%
// of the column (166 px; 50 px in Split's 125 px preview pane). The column count puts the table's
// floor (about 27 px per cell) between `column - offset` and `column`, so it fits unindented, not
// indented, and a partial cap ends it at the column edge.
const CAP_COLUMNS: Record<Mode, number> = {
  ir: 13,
  wysiwyg: 13,
  preview: 13,
  sv: 4,
}
for (const mode of MODES) {
  test(`${mode}: a table wider than the room left keeps its floor and ends inside the column`, async ({
    page,
  }) => {
    const n = CAP_COLUMNS[mode]
    const row = (cell: (i: number) => string) =>
      `|${Array.from({ length: n }, (_, i) => ` ${cell(i)} `).join('|')}|`
    const doc = [
      '###### tokCapH',
      '',
      row((i) => `c${i}`),
      row(() => '---'),
      row((i) => `v${i}`),
      '',
    ].join('\n')
    const { init } = await openMode(page, mode, doc, {
      width: 520,
      height: 800,
    })
    await page.waitForTimeout(1500)
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
        const table = root.querySelector('table') as HTMLElement
        const r = table.getBoundingClientRect()
        return {
          column: right - left,
          offset: r.left - left,
          overflow: r.right - right,
          width: r.width,
          floor: table.style.getPropertyValue('--vmde-table-floor'),
        }
      }, PANE[mode])
    const off = await measure()
    expect(off.floor).toBe('')
    expect(off.offset).toBe(0)
    await setIndent(page, init, true, 64)
    await page.waitForTimeout(1000)
    const on = await measure()
    const uncapped = Math.min(5 * 64, 0.4 * on.column)
    // Precondition: the table does not fit indented (the cap is needed) and does fit unindented.
    expect(on.width).toBeGreaterThan(on.column - uncapped + 1)
    expect(on.width).toBeLessThanOrEqual(on.column)
    // The floor is the table's rendered width; it keeps part of its indentation and ends inside the
    // column, with no more overflow than the unindented baseline.
    expect(parseFloat(on.floor)).toBeCloseTo(on.width, 0)
    expect(on.offset).toBeGreaterThan(0)
    expect(on.offset).toBeLessThan(uncapped - 1)
    expect(on.overflow).toBeLessThanOrEqual(Math.max(off.overflow, 0) + 1)
    expect(on.offset + on.width).toBeCloseTo(on.column, 0)
    // The heading itself keeps its full indentation.
    expect(await offset(page, mode, 'tokCapH')).toBeCloseTo(uncapped, 0)
    // A live step change re-reads the floor (Task 660): at step 8 the offset is 40 px, which the
    // 352 px table fits in the 416 px column, so it drops the cap and takes the full 40 px; Split's
    // narrow pane is capped at either step.
    await setIndent(page, init, true, 8)
    await page.waitForTimeout(1000)
    const small = await measure()
    const uncappedSmall = Math.min(5 * 8, 0.4 * small.column)
    expect(small.overflow).toBeLessThanOrEqual(Math.max(off.overflow, 0) + 1)
    expect(small.offset).toBeLessThanOrEqual(uncappedSmall + 1)
    if (mode !== 'sv') {
      expect(small.floor).toBe('')
      expect(small.offset).toBeCloseTo(uncappedSmall, 0)
    }
    // Off again: no floor, no margin, as before.
    await setIndent(page, init, false, 64)
    await page.waitForTimeout(500)
    const after = await measure()
    expect(after.floor).toBe('')
    expect(after.offset).toBe(0)
  })
}
