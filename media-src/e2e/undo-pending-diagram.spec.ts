import { expect, test } from './coverage-fixture'

type Page = import('@playwright/test').Page
type Mode = 'ir' | 'wysiwyg'

// Task 623: a Mermaid preview that was still rendering when an undo snapshot was taken must be
// drawn again after Undo; a diagram that was already drawn must be restored without a new render.
// The harness is source-patched Vditor with no render cache, so the only render is Vditor's own
// asynchronous Mermaid script load. The cold cases hold that script request to keep the render
// pending for as long as the case needs.

const MERMAID_SCRIPT = '**/vditor/dist/js/mermaid/mermaid.min.js*'
const DIAGRAM_SELECTOR = (mode: Mode) =>
  `.vditor-${mode}__preview .language-mermaid`

const value = (page: Page) =>
  page.evaluate(() => (window as any).__value() as string)
const undo = (page: Page) => page.evaluate(() => (window as any).__undo())
const redo = (page: Page) => page.evaluate(() => (window as any).__redo())
const stack = (page: Page) =>
  page.evaluate(
    () => (window as any).__stack() as { undo: number; redo: number },
  )

async function open(page: Page, mode: Mode) {
  // A held script request would keep the `load` event pending, so wait for the DOM only.
  await page.goto(`/undo-boundaries.html?mode=${mode}&doc=mermaid`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as any).__ready === true)
}

// Hold every request for the Mermaid script until `release()` is called.
async function holdMermaidScript(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(MERMAID_SCRIPT, async (route) => {
    await gate
    await route.continue()
  })
  return release
}

// Edit the paragraph above the diagram with real input and wait for the edit's own undo entry
// (Vditor adds it after its 800 ms undo delay). Callers settle the history first, so the entry is
// the edit's. The caret is placed by a real click: a scripted selection is overwritten by the
// editor's stale focus range.
async function editParagraph(page: Page, mode: Mode) {
  const before = (await stack(page)).undo
  await page.locator(`.vditor-${mode} p`).first().click()
  await page.keyboard.press('Home')
  await page.keyboard.type('X')
  await expect
    .poll(() => value(page), { timeout: 3_000 })
    .toContain('XAlpha bravo delta.')
  await expect
    .poll(async () => (await stack(page)).undo, { timeout: 3_000 })
    .toBeGreaterThan(before)
}

const diagramState = (page: Page, mode: Mode) =>
  page.evaluate((selector) => {
    const target = document.querySelector(selector) as HTMLElement | null
    const svg = target?.querySelector('svg') ?? null
    return {
      exists: !!target,
      svg: !!svg,
      shapes: svg?.querySelectorAll('g.node').length ?? 0,
      width: svg?.getBoundingClientRect().width ?? 0,
      error: !!target?.querySelector(
        '.vmde-diagram-error, [aria-roledescription="error"]',
      ),
    }
  }, DIAGRAM_SELECTOR(mode))

// Mermaid's runtime exists once the script has run; count its render calls from then on.
const countRenders = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__renderCalls = 0
    const render = w.mermaid.render.bind(w.mermaid)
    w.mermaid.render = (...args: unknown[]) => {
      w.__renderCalls += 1
      return render(...args)
    }
  })
const renderCalls = (page: Page) =>
  page.evaluate(() => (window as any).__renderCalls as number)

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`${mode}: pending Mermaid render across Undo (Task 623)`, () => {
    test('a snapshot taken while the render is pending is drawn after Undo', async ({
      page,
    }) => {
      const release = await holdMermaidScript(page)
      await open(page, mode)
      // Let Vditor's own initial snapshot of the pending document land first.
      await page.waitForTimeout(900)
      const source = await value(page)
      // Precondition, not behavior: the first render has not finished.
      expect(await diagramState(page, mode)).toMatchObject({
        exists: true,
        svg: false,
      })

      await editParagraph(page, mode)
      expect(await diagramState(page, mode)).toMatchObject({ svg: false })

      // The probe: what the pending preview looked like when each snapshot started and as it was
      // written into the snapshot.
      const snapshots = (await page.evaluate(() =>
        (window as any).__snapshots(),
      )) as { live: unknown[]; snap: unknown[] }[]
      console.log(`probe[${mode}] ${JSON.stringify(snapshots)}`)
      test.info().annotations.push({
        type: 'probe',
        description: JSON.stringify(snapshots),
      })

      await undo(page)
      // Undo restores the source exactly and leaves the diagram without a drawing so far.
      expect(await value(page)).toBe(source)

      release()
      await expect
        .poll(() => diagramState(page, mode), { timeout: 10_000 })
        .toMatchObject({ svg: true, error: false })
      const drawn = await diagramState(page, mode)
      expect(drawn.shapes).toBeGreaterThanOrEqual(2)
      expect(drawn.width).toBeGreaterThan(0)
      expect(await value(page)).toBe(source)

      // Redo restores the edit and its diagram is drawn too.
      await redo(page)
      expect(await value(page)).toContain('XAlpha bravo delta.')
      await expect
        .poll(() => diagramState(page, mode), { timeout: 10_000 })
        .toMatchObject({ svg: true, error: false })
    })

    test('an already drawn diagram is restored without a new render', async ({
      page,
    }) => {
      await open(page, mode)
      await expect
        .poll(() => diagramState(page, mode), { timeout: 10_000 })
        .toMatchObject({ svg: true })
      // Let the initial snapshot of the drawn document settle, then count renders.
      await page.waitForTimeout(900)
      await countRenders(page)
      const source = await value(page)
      const markup = () =>
        page.evaluate(
          (selector) => document.querySelector(selector)?.innerHTML ?? '',
          DIAGRAM_SELECTOR(mode),
        )
      const drawnMarkup = await markup()
      expect(drawnMarkup).toContain('<svg')

      await editParagraph(page, mode)
      const edited = await value(page)
      const calls = await renderCalls(page)

      await undo(page)
      expect(await value(page)).toBe(source)
      expect(await markup()).toBe(drawnMarkup)

      await redo(page)
      expect(await value(page)).toBe(edited)
      expect(await markup()).toBe(drawnMarkup)

      // Settle: a late render would show up as a call or as changed markup.
      await page.waitForTimeout(1_500)
      expect(await renderCalls(page)).toBe(calls)
      expect(await markup()).toBe(drawnMarkup)
      expect(await value(page)).toBe(edited)
    })
  })
}
