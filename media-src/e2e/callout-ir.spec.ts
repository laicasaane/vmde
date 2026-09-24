import { test, expect } from './coverage-fixture'

// Callout dual-node in a real Vditor IR (task 106 v2): the callout is tagged `vditor-ir__node` +
// gets an injected non-editable preview; Vditor's expandMarker toggles `--expand` on caret, and our
// CSS swaps source⇄preview. Caret outside → clean render; caret inside → raw source. The markdown
// round-trips off the editable source (Lute ignores the injected preview).

test.beforeEach(async ({ page }) => {
  await page.goto('/callout-ir.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  // observeCallouts (rAF-debounced) injects the preview + tags the blockquote
  await page.waitForFunction(
    () =>
      !!(window as any)
        .__bq()
        ?.querySelector(':scope > .vmde-callout__preview'),
    undefined,
    { timeout: 10000 },
  )
})

async function setHarnessValue(
  page: import('@playwright/test').Page,
  value: string,
) {
  await page.evaluate((markdown) => (window as any).__setValue(markdown), value)
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe(value)
}

async function placeHarnessCaret(
  page: import('@playwright/test').Page,
  needle: string,
) {
  await page.evaluate((target) => (window as any).__placeCaret(target), needle)
}

async function openAuthoringHarness(page: import('@playwright/test').Page) {
  await page.goto('/callout-ir.html?authoring=1')
  await page.waitForFunction(() => (window as any).__ready === true)
}

test('pinned toolbar converts, updates, and removes a callout in IR', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await setHarnessValue(page, 'alpha body\n')
  await placeHarnessCaret(page, 'alpha body')
  await page.locator('.vditor-toolbar [data-type="callout"]').click()
  const panel = page.locator('.vmde-callout-toolbar-panel')
  await expect(panel).toBeVisible()
  await panel.locator('select').selectOption('warning')
  await panel.locator('input').fill('Heads up')
  await panel.getByRole('button', { name: 'Make Callout' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!WARNING] Heads up\n> alpha body\n')
  const warningCallout = page.locator(
    '.vditor-ir blockquote[data-callout="warning"]',
  )
  await expect(warningCallout).toContainText('Heads up')

  await placeHarnessCaret(page, 'alpha body')
  await page.locator('.vditor-toolbar [data-type="callout"]').click()
  await expect(panel.locator('select')).toHaveValue('warning')
  await expect(panel.locator('input')).toHaveValue('Heads up')
  await panel.locator('select').selectOption('tip')
  await panel.locator('input').fill('Changed')
  await expect(panel.locator('input')).toHaveValue('Changed')
  await panel.getByRole('button', { name: 'Apply' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!TIP] Changed\n> alpha body\n')

  await placeHarnessCaret(page, 'alpha body')
  await page.locator('.vditor-toolbar [data-type="callout"]').click()
  await panel.getByRole('button', { name: 'Remove Callout' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> alpha body\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!TIP] Changed\n> alpha body\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.redo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> alpha body\n')
  expect(await page.evaluate(() => (window as any).__state())).toMatchObject({
    exactPosts: 3,
  })
})

test('IR contextual controls convert a plain quote and never serialize their DOM', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await setHarnessValue(page, '> plain quote body\n')
  await placeHarnessCaret(page, 'plain quote body')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  await panel.locator('select').selectOption('important')
  await panel.locator('input').fill('Context')
  await panel.getByRole('button', { name: 'Make Callout' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!IMPORTANT] Context\n> plain quote body\n')
  expect(await page.evaluate(() => (window as any).__getValue())).not.toContain(
    'vmde-callout-controls',
  )
})

test('IR contextual authoring remains available when the pinned toolbar is hidden', async ({
  page,
}) => {
  await page.goto('/callout-ir.html?authoring=1&toolbar=0')
  await page.waitForFunction(() => (window as any).__ready === true)
  await setHarnessValue(page, '> toolbar-free quote\n')
  await placeHarnessCaret(page, 'toolbar-free quote')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Make Callout' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!NOTE]\n> toolbar-free quote\n')
})

test('the pinned Callout control disables only in the read-only full Preview', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  const preview = page.locator('.vditor-toolbar [data-type="preview"]')
  const callout = page.locator('.vditor-toolbar [data-type="callout"]')
  await preview.click()
  await expect(callout).toBeDisabled()
  await preview.click()
  await expect(callout).toBeEnabled()
})

test('WYSIWYG native popover creates a callout from a plain quote through shared actions', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await setHarnessValue(page, '> WYS plain quote\n')
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  await page.locator('.vditor-wysiwyg blockquote').click()
  await placeHarnessCaret(page, 'WYS plain quote')
  const controls = page
    .locator(
      '.vditor-wysiwyg ~ .vditor-panel .vmde-callout-controls, .vditor-panel .vmde-callout-controls',
    )
    .last()
  await expect(controls).toBeVisible()
  await controls.locator('select').selectOption('caution')
  await controls.locator('input').fill('WYS')
  await controls.getByRole('button', { name: 'Make Callout' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).__getValue()))
    .toBe('> [!CAUTION] WYS\n> WYS plain quote\n')
})

test('SV uses the same pinned toolbar source transform', async ({ page }) => {
  await openAuthoringHarness(page)
  await setHarnessValue(page, 'SV body\n')
  await page.evaluate(() => (window as any).__switchMode('sv'))
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('sv')
  await placeHarnessCaret(page, 'SV body')
  await page.locator('.vditor-toolbar [data-type="callout"]').click()
  const panel = page.locator('.vmde-callout-toolbar-panel')
  await panel.locator('select').selectOption('note')
  await panel.getByRole('button', { name: 'Make Callout' }).click()
  const state = await page.evaluate(() => (window as any).__state())
  // Vditor canonicalizes a blockquote-at-EOF with one terminal blank when SV is entered; the shared
  // action preserves that source state exactly rather than adding another normalization.
  expect(state.lastExact).toBe('> [!NOTE]\n> SV body\n\n')
  expect(state.value).toBe('> [!NOTE]\n> SV body\n\n')
})

test('the callout blockquote is tagged + has a non-editable preview', async ({
  page,
}) => {
  const info = await page.evaluate(() => {
    const bq = (window as any).__bq() as HTMLElement
    const pv = bq.querySelector(':scope > .vmde-callout__preview')
    return {
      node: bq.classList.contains('vditor-ir__node'),
      ce: pv?.getAttribute('contenteditable'),
      title: pv?.querySelector('.vmde-callout__title')?.textContent,
    }
  })
  expect(info.node).toBe(true)
  expect(info.ce).toBe('false')
  expect(info.title).toBe('Note')
})

test('caret outside → render shown, source hidden; caret inside → source shown, render hidden', async ({
  page,
}) => {
  // default: caret not in the callout → collapsed (render shown, source hidden)
  await page.evaluate(() => (window as any).__caretOutside())
  let vis = await page.evaluate(() => {
    const bq = (window as any).__bq() as HTMLElement
    const src = bq.querySelector(':scope > p')
    const pv = bq.querySelector(':scope > .vmde-callout__preview')
    const d = (el: Element | null) =>
      el ? getComputedStyle(el).display : 'missing'
    return { src: d(src), pv: d(pv) }
  })
  expect(vis.src).toBe('none') // source hidden
  expect(vis.pv).not.toBe('none') // render shown

  // caret inside → expanded (source shown, render hidden)
  await page.evaluate(() => (window as any).__caretInside())
  vis = await page.evaluate(() => {
    const bq = (window as any).__bq() as HTMLElement
    const src = bq.querySelector(':scope > p')
    const pv = bq.querySelector(':scope > .vmde-callout__preview')
    const d = (el: Element | null) =>
      el ? getComputedStyle(el).display : 'missing'
    return { src: d(src), pv: d(pv) }
  })
  expect(vis.src).not.toBe('none') // source shown for editing
  expect(vis.pv).toBe('none') // render hidden
})

test('the markdown round-trips (Lute ignores the injected preview)', async ({
  page,
}) => {
  const md = await page.evaluate(() => (window as any).__getValue())
  expect(md).toContain('> [!NOTE]')
  expect(md).toContain('body text of the note')
  // the rendered title text isn't duplicated into the source
  expect(md).not.toContain('vmde-callout')
})

// Size parity: entering a callout must NOT change its box (same line count, no margin
// asymmetry). The expanded source's last block used to keep the theme's 16px paragraph
// margin (the preview zeroes its own) and the preview title carried a 4px gap the
// one-paragraph source has no equivalent of — the callout visibly grew on caret-enter.
test('the callout keeps its exact size when the caret enters (collapse⇄expand)', async ({
  page,
}) => {
  const height = () =>
    page.evaluate(
      () =>
        Math.round((window as any).__bq().getBoundingClientRect().height * 10) /
        10,
    )
  const collapsed = await height()
  await page.evaluate(() => (window as any).__caretInside())
  await page.waitForTimeout(150)
  const expanded = await height()
  expect(Math.abs(expanded - collapsed)).toBeLessThanOrEqual(1)
  // and back out — no drift
  await page.evaluate(() => (window as any).__caretOutside())
  await page.waitForTimeout(150)
  expect(Math.abs((await height()) - collapsed)).toBeLessThanOrEqual(1)
})

// Task 179 — typing inside a callout used to blank the text + eject the caret. Each keystroke runs
// SpinVditorIRDOM (rebuilds the blockquote, dropping `--expand`) → observeCallouts re-decorated it
// SYNCHRONOUSLY, collapsing the dual-node before Vditor re-expanded it: the source went display:none
// (typed text "disappeared") and the caret fell out. The fix drives expand/collapse off the live
// selection + skips the preview rebuild for the callout being typed in. This types REAL keystrokes.
test('typing inside the callout keeps the text + the caret inside (no eject, no blank)', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__focusBodyEnd())
  await page.keyboard.type(' EDITED', { delay: 30 })
  await page.waitForTimeout(250)

  const st = await page.evaluate(() => (window as any).__state())
  expect(st.srcText).toContain('body text of the note EDITED') // the text persisted…
  expect(st.caretInCallout).toBe(true) // …the caret did NOT get ejected…
  expect(st.srcVisible).toBe(true) // …the source stayed visible (not collapsed to display:none)…
  expect(st.expanded).toBe(true) // …the dual-node stayed expanded while editing…
  expect(st.editing).toBe(true) // …and is flagged as being edited.
  expect(st.value).toContain('> body text of the note EDITED') // round-trips through Lute
})

test('leaving the callout after editing re-syncs the preview to the final source', async ({
  page,
}) => {
  await page.evaluate(() => (window as any).__focusBodyEnd())
  await page.keyboard.type(' AFTER-LEAVE', { delay: 30 })
  await page.waitForTimeout(200)
  // move the caret OUT (trailing paragraph) → the callout collapses + its preview rebuilds
  await page.evaluate(() => (window as any).__caretOutside())
  await page.waitForTimeout(250)

  const r = await page.evaluate(() => {
    const bq = (window as any).__bq() as HTMLElement
    const preview = bq.querySelector(
      ':scope > .vmde-callout__preview',
    ) as HTMLElement | null
    return {
      expanded: bq.classList.contains('vditor-ir__node--expand'),
      editing: bq.hasAttribute('data-callout-editing'),
      previewText: preview?.textContent ?? null,
    }
  })
  expect(r.expanded).toBe(false) // collapsed after leaving
  expect(r.editing).toBe(false) // editing flag cleared
  expect(r.previewText).toContain('body text of the note AFTER-LEAVE') // preview shows the edit
})

// Task 570: position is tested against rendered rectangles, not guessed source offsets.
test('quote controls clear plain quotes and callouts at normal and narrow widths', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  for (const width of [1200, 520]) {
    await page.setViewportSize({ width, height: 800 })
    for (const mode of ['ir', 'wysiwyg'] as const) {
      for (const [markdown, needle] of [
        ['> plain quote body and more words\n', 'plain quote body'],
        ['> [!NOTE]\n> body text of the note\n', 'body text of the note'],
      ] as const) {
        await setHarnessValue(page, markdown)
        await page.evaluate((next) => (window as any).__switchMode(next), mode)
        if (mode === 'wysiwyg')
          await page.locator('.vditor-wysiwyg blockquote').click()
        await placeHarnessCaret(page, needle)
        const panel =
          mode === 'ir'
            ? page.locator('.vmde-callout-context-panel')
            : page
                .locator('.vditor-panel:visible .vmde-callout-controls')
                .last()
                .locator('..')
        await expect(panel).toBeVisible()
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        )
        const geometry = await page.evaluate((next) => {
          const root = document.querySelector<HTMLElement>(`.vditor-${next}`)!
          const quote = root
            .querySelector('blockquote')!
            .getBoundingClientRect()
          const panel =
            next === 'ir'
              ? document.querySelector('.vmde-callout-context-panel')!
              : [...document.querySelectorAll('.vditor-panel')].find(
                  (el) =>
                    getComputedStyle(el).display !== 'none' &&
                    el.querySelector('.vmde-callout-controls'),
                )!
          const control = panel.getBoundingClientRect()
          const toolbar = document
            .querySelector('.vditor-toolbar')!
            .getBoundingClientRect()
          const scroller = root
            .closest('.vditor-content')!
            .getBoundingClientRect()
          return {
            quote: {
              left: quote.left,
              right: quote.right,
              top: quote.top,
              bottom: quote.bottom,
            },
            control: {
              left: control.left,
              right: control.right,
              top: control.top,
              bottom: control.bottom,
            },
            toolbarBottom: toolbar.bottom,
            scroller: { top: scroller.top, bottom: scroller.bottom },
            viewportWidth: innerWidth,
          }
        }, mode)
        expect(geometry.control.left).toBeGreaterThanOrEqual(8)
        expect(geometry.control.right).toBeLessThanOrEqual(
          geometry.viewportWidth - 8,
        )
        expect(geometry.control.top).toBeGreaterThanOrEqual(
          Math.max(geometry.toolbarBottom, geometry.scroller.top) + 8,
        )
        expect(
          geometry.control.bottom <= geometry.quote.top - 7 ||
            geometry.control.top >= geometry.quote.bottom + 7,
          JSON.stringify({ mode, markdown, geometry }),
        ).toBe(true)
        expect(await page.evaluate(() => (window as any).__getValue())).toBe(
          markdown,
        )
      }
    }
  }
})

test('native WYSIWYG table controls avoid the toolbar and active cell', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  const markdown = '| A | B |\n| --- | --- |\n| alpha cell | beta cell |\n'
  await page.evaluate((value) => (window as any).__setValue(value), markdown)
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  const before = await page.evaluate(() => (window as any).__getValue())
  await page.locator('.vditor-wysiwyg table td').first().click()
  const panel = page.locator('.vditor-panel:visible').first()
  await expect(panel).toBeVisible()
  const geometry = await page.evaluate(() => {
    const rect = (element: Element) => element.getBoundingClientRect()
    const panel = [...document.querySelectorAll('.vditor-panel')].find(
      (element) =>
        getComputedStyle(element).display !== 'none' && rect(element).width > 0,
    )!
    const box = rect(panel)
    const cell = rect(document.querySelector('.vditor-wysiwyg table td')!)
    const toolbar = rect(document.querySelector('.vditor-toolbar')!)
    return {
      panel: {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      },
      cell: {
        left: cell.left,
        right: cell.right,
        top: cell.top,
        bottom: cell.bottom,
      },
      toolbarBottom: toolbar.bottom,
      viewportWidth: innerWidth,
    }
  })
  expect(geometry.panel.left).toBeGreaterThanOrEqual(8)
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewportWidth - 8)
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.toolbarBottom + 8)
  expect(
    geometry.panel.bottom <= geometry.cell.top ||
      geometry.panel.top >= geometry.cell.bottom,
  ).toBe(true)
  expect(await page.evaluate(() => (window as any).__getValue())).toBe(before)
})

test('IR quote panel tracks a wrapped quote through editor scroll without covering the caret', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  const markdown = `${Array.from({ length: 16 }, (_, i) => `before ${i}`).join('\n\n')}\n\n> ${'active quote words '.repeat(24)}\n\n${Array.from({ length: 20 }, (_, i) => `after ${i}`).join('\n\n')}\n`
  await page.evaluate((value) => (window as any).__setValue(value), markdown)
  const exactBefore = await page.evaluate(() => (window as any).__getValue())
  await page.evaluate(() =>
    document
      .querySelector('.vditor-ir blockquote')
      ?.scrollIntoView({ block: 'center' }),
  )
  await placeHarnessCaret(page, 'active quote words')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  const read = () =>
    page.evaluate(() => {
      const quote = document
        .querySelector('.vditor-ir blockquote')!
        .getBoundingClientRect()
      const panel = document
        .querySelector('.vmde-callout-context-panel')!
        .getBoundingClientRect()
      const caret = getSelection()!.getRangeAt(0).getBoundingClientRect()
      const editor = (window as any).vditor.vditor.ir.element as HTMLElement
      return {
        quoteTop: quote.top,
        quoteBottom: quote.bottom,
        panelTop: panel.top,
        panelBottom: panel.bottom,
        caretTop: caret.top,
        caretBottom: caret.bottom,
        scrollTop: editor.scrollTop,
      }
    })
  const before = await read()
  await page.evaluate(() => {
    ;((window as any).vditor.vditor.ir.element as HTMLElement).scrollTop -= 80
  })
  await expect
    .poll(async () => (await read()).scrollTop)
    .toBeLessThan(before.scrollTop)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const after = await read()
  expect(
    after.panelBottom <= after.quoteTop - 7 ||
      after.panelTop >= after.quoteBottom + 7,
  ).toBe(true)
  expect(
    after.panelBottom <= after.caretTop || after.panelTop >= after.caretBottom,
  ).toBe(true)
  expect(await page.evaluate(() => (window as any).__getValue())).toBe(
    exactBefore,
  )
})

test('native WYSIWYG panel placement settles without a style mutation loop', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  await setHarnessValue(page, '> steady quote body\n')
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await page.locator('.vditor-wysiwyg blockquote').click()
  const panel = page.locator(
    '.vditor-wysiwyg > .vditor-panel.vmde-element-panel',
  )
  await expect(panel).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const writes = await panel.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        let count = 0
        const observer = new MutationObserver((records) => {
          count += records.length
        })
        observer.observe(element, {
          attributes: true,
          attributeFilter: ['style'],
        })
        // A negative assertion needs an observation window: recurring placement writes are the bug.
        setTimeout(() => {
          observer.disconnect()
          resolve(count)
        }, 180)
      }),
  )
  expect(writes).toBe(0)
})

test('IR quote controls compact and avoid the active line in a 220px webview', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 220, height: 686 })
  const source = '> plain quote body and more words\n'
  await setHarnessValue(page, source)
  await placeHarnessCaret(page, 'plain quote body')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  const g = await page.evaluate(() => {
    const panel = document
      .querySelector('.vmde-callout-context-panel')!
      .getBoundingClientRect()
    const caret = getSelection()!.getRangeAt(0).getBoundingClientRect()
    const toolbar = document
      .querySelector('.vditor-toolbar')!
      .getBoundingClientRect()
    const scroller = document
      .querySelector('.vditor-content')!
      .getBoundingClientRect()
    return {
      panel: {
        left: panel.left,
        right: panel.right,
        top: panel.top,
        bottom: panel.bottom,
      },
      caret: { top: caret.top, bottom: caret.bottom },
      toolbarBottom: toolbar.bottom,
      scrollerBottom: scroller.bottom,
      width: innerWidth,
    }
  })
  expect(g.panel.left).toBeGreaterThanOrEqual(8)
  expect(g.panel.right).toBeLessThanOrEqual(g.width - 8)
  expect(g.panel.top).toBeGreaterThanOrEqual(g.toolbarBottom + 8)
  expect(g.panel.bottom).toBeLessThanOrEqual(g.scrollerBottom - 8)
  expect(g.panel.bottom <= g.caret.top || g.panel.top >= g.caret.bottom).toBe(
    true,
  )
  await panel.locator('select').focus()
  await expect(panel.locator('select')).toBeFocused()
  await panel.locator('select').press('Escape')
  await expect(panel).toBeHidden()
  expect(await page.evaluate(() => (window as any).__getValue())).toBe(source)
})

test('IR quote panel hides while its owner is scrolled fully out and returns with it', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  const source = `> owner quote\n\n${Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\n\n')}\n`
  await page.evaluate((value) => (window as any).__setValue(value), source)
  const exactBefore = await page.evaluate(() => (window as any).__getValue())
  await placeHarnessCaret(page, 'owner quote')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop = root.scrollHeight
  })
  await expect(panel).toBeHidden()
  await page.evaluate(() => {
    ;((window as any).vditor.vditor.ir.element as HTMLElement).scrollTop = 0
  })
  await expect(panel).toBeVisible()
  expect(await page.evaluate(() => (window as any).__getValue())).toBe(
    exactBefore,
  )
})

test('native WYSIWYG quote panel hides when its owner leaves the visible editor', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  const source = `> owner quote\n\n${Array.from({ length: 40 }, (_, i) => `filler ${i}`).join('\n\n')}\n`
  await page.evaluate((value) => (window as any).__setValue(value), source)
  await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
  await page.locator('.vditor-wysiwyg blockquote').click()
  const panel = page.locator(
    '.vditor-wysiwyg > .vditor-panel.vmde-element-panel',
  )
  await expect(panel).toBeVisible()
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    root.scrollTop = root.scrollHeight
  })
  await expect(panel).toBeHidden()
})

test('native heading, code, link, and image panels clear their rendered owners', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 800 })
  const cases = [
    ['# Heading text\n', 'h1'],
    ['```js\nconst answer = 42\n```\n', '[data-type="code-block"]'],
    ['A [link label](https://example.com) here.\n', 'a[href]'],
    [
      '![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==)\n',
      'img',
    ],
  ] as const
  for (const [markdown, selector] of cases) {
    await openAuthoringHarness(page)
    await page.evaluate((value) => (window as any).__setValue(value), markdown)
    await page.evaluate(() => (window as any).__switchMode('wysiwyg'))
    const before = await page.evaluate(() => (window as any).__getValue())
    const target = page.locator(`.vditor-wysiwyg ${selector}`).first()
    await target.click({ force: true })
    const panel = page.locator(
      '.vditor-wysiwyg > .vditor-panel.vmde-element-panel',
    )
    await expect(panel, selector).toBeVisible()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const g = await page.evaluate((ownerSelector) => {
      const target = document
        .querySelector(`.vditor-wysiwyg ${ownerSelector}`)!
        .getBoundingClientRect()
      const panel = document
        .querySelector('.vditor-wysiwyg > .vditor-panel.vmde-element-panel')!
        .getBoundingClientRect()
      const toolbar = document
        .querySelector('.vditor-toolbar')!
        .getBoundingClientRect()
      return {
        target: {
          left: target.left,
          right: target.right,
          top: target.top,
          bottom: target.bottom,
        },
        panel: {
          left: panel.left,
          right: panel.right,
          top: panel.top,
          bottom: panel.bottom,
        },
        toolbarBottom: toolbar.bottom,
        width: innerWidth,
      }
    }, selector)
    expect(g.panel.left, selector).toBeGreaterThanOrEqual(8)
    expect(g.panel.right, selector).toBeLessThanOrEqual(g.width - 8)
    expect(g.panel.top, selector).toBeGreaterThanOrEqual(g.toolbarBottom + 8)
    expect(
      g.panel.bottom <= g.target.top - 7 ||
        g.panel.top >= g.target.bottom + 7 ||
        g.panel.right <= g.target.left - 7 ||
        g.panel.left >= g.target.right + 7,
      selector,
    ).toBe(true)
    expect(await page.evaluate(() => (window as any).__getValue())).toBe(before)
  }
})

test('multi-paragraph quote panels clear first and last lines', async ({
  page,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the source/mode/caret matrix shares one editor and one rectangle assertion.
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  for (const [markdown, first, last] of [
    [
      '> first paragraph has editable text\n>\n> last paragraph has editable text\n',
      'first paragraph',
      'last paragraph',
    ],
    [
      '> [!NOTE]\n> first paragraph has editable text\n>\n> last paragraph has editable text\n',
      'first paragraph',
      'last paragraph',
    ],
  ] as const) {
    await page.evaluate((value) => (window as any).__setValue(value), markdown)
    const exactBefore = await page.evaluate(() => (window as any).__getValue())
    for (const mode of ['ir', 'wysiwyg'] as const) {
      await page.evaluate((next) => (window as any).__switchMode(next), mode)
      for (const needle of [first, last]) {
        if (mode === 'wysiwyg')
          await page
            .locator('.vditor-wysiwyg blockquote p')
            .last()
            .click({ force: true })
        await placeHarnessCaret(page, needle)
        const panel =
          mode === 'ir'
            ? page.locator('.vmde-callout-context-panel')
            : page.locator('.vditor-wysiwyg > .vditor-panel.vmde-element-panel')
        await expect(panel).toBeVisible()
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        )
        const g = await page.evaluate((next) => {
          const root = document.querySelector(`.vditor-${next}`)!
          const quote = root
            .querySelector('blockquote')!
            .getBoundingClientRect()
          const panel =
            next === 'ir'
              ? document.querySelector('.vmde-callout-context-panel')!
              : document.querySelector(
                  '.vditor-wysiwyg > .vditor-panel.vmde-element-panel',
                )!
          const control = panel.getBoundingClientRect()
          const caret = getSelection()!.getRangeAt(0).getBoundingClientRect()
          return {
            quote: { top: quote.top, bottom: quote.bottom },
            panel: { top: control.top, bottom: control.bottom },
            caret: { top: caret.top, bottom: caret.bottom },
          }
        }, mode)
        expect(
          g.panel.bottom <= g.quote.top - 7 ||
            g.panel.top >= g.quote.bottom + 7,
          `${mode} ${needle}`,
        ).toBe(true)
        expect(
          g.panel.bottom <= g.caret.top || g.panel.top >= g.caret.bottom,
          `${mode} ${needle}`,
        ).toBe(true)
      }
    }
    expect(await page.evaluate(() => (window as any).__getValue())).toBe(
      exactBefore,
    )
  }
})

test('IR quote panel remeasures after editing grows the active block', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  await setHarnessValue(page, '> growth words\n')
  await placeHarnessCaret(page, 'growth words')
  const panel = page.locator('.vmde-callout-context-panel')
  await expect(panel).toBeVisible()
  const before = await page.locator('.vditor-ir blockquote').boundingBox()
  await page.keyboard.type(' continued words'.repeat(16))
  await expect
    .poll(
      async () =>
        (await page.locator('.vditor-ir blockquote').boundingBox())!.height,
    )
    .toBeGreaterThan(before!.height)
  const g = await page.evaluate(() => {
    const quote = document
      .querySelector('.vditor-ir blockquote')!
      .getBoundingClientRect()
    const panel = document
      .querySelector('.vmde-callout-context-panel')!
      .getBoundingClientRect()
    const caret = getSelection()!.getRangeAt(0).getBoundingClientRect()
    return {
      quoteBottom: quote.bottom,
      panelTop: panel.top,
      panelBottom: panel.bottom,
      caretTop: caret.top,
      caretBottom: caret.bottom,
    }
  })
  expect(
    g.panelTop >= g.quoteBottom + 7 ||
      g.panelBottom <= g.caretTop ||
      g.panelTop >= g.caretBottom,
  ).toBe(true)
  expect(await page.evaluate(() => (window as any).__getValue())).toContain(
    'continued words',
  )
})

test('quote panels flip clear of top and bottom editor edges in both modes', async ({
  page,
}) => {
  await openAuthoringHarness(page)
  await page.setViewportSize({ width: 520, height: 800 })
  const source = `${Array.from({ length: 10 }, (_, i) => `before ${i}`).join('\n\n')}\n\n> ${'edge quote words '.repeat(18)}\n\n${Array.from({ length: 12 }, (_, i) => `after ${i}`).join('\n\n')}\n`
  await page.evaluate((value) => (window as any).__setValue(value), source)
  const exactBefore = await page.evaluate(() => (window as any).__getValue())
  for (const mode of ['ir', 'wysiwyg'] as const) {
    await page.evaluate((next) => (window as any).__switchMode(next), mode)
    await page.evaluate(
      (next) =>
        document
          .querySelector(`.vditor-${next} blockquote`)
          ?.scrollIntoView({ block: 'center' }),
      mode,
    )
    if (mode === 'wysiwyg')
      await page.locator('.vditor-wysiwyg blockquote').click({ force: true })
    await placeHarnessCaret(page, 'edge quote words')
    const panel =
      mode === 'ir'
        ? page.locator('.vmde-callout-context-panel')
        : page.locator('.vditor-wysiwyg > .vditor-panel.vmde-element-panel')
    await expect(panel).toBeVisible()
    for (const edge of ['top', 'bottom'] as const) {
      await page.evaluate(
        ({ next, edge }) => {
          const root = (window as any).vditor.vditor[next]
            .element as HTMLElement
          const quote = root
            .querySelector('blockquote')!
            .getBoundingClientRect()
          const scroller = root
            .closest('.vditor-content')!
            .getBoundingClientRect()
          root.scrollTop +=
            edge === 'top'
              ? quote.top - (scroller.top + 8)
              : quote.bottom - (scroller.bottom - 8)
        },
        { next: mode, edge },
      )
      const scrollBeforePanelMove = await page.evaluate(
        (next) =>
          ((window as any).vditor.vditor[next].element as HTMLElement)
            .scrollTop,
        mode,
      )
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      const g = await page.evaluate((next) => {
        const root = (window as any).vditor.vditor[next].element as HTMLElement
        const quote = root.querySelector('blockquote')!.getBoundingClientRect()
        const panel = (
          next === 'ir'
            ? document.querySelector('.vmde-callout-context-panel')
            : (window as any).vditor.vditor.wysiwyg.popover
        )!.getBoundingClientRect()
        const toolbar = document
          .querySelector('.vditor-toolbar')!
          .getBoundingClientRect()
        const scroller = root
          .closest('.vditor-content')!
          .getBoundingClientRect()
        return {
          quote: { top: quote.top, bottom: quote.bottom },
          panel: { top: panel.top, bottom: panel.bottom },
          toolbarBottom: toolbar.bottom,
          scrollerBottom: scroller.bottom,
          scrollTop: root.scrollTop,
          caretInQuote: root
            .querySelector('blockquote')!
            .contains(getSelection()?.anchorNode ?? null),
        }
      }, mode)
      expect(g.scrollTop, `${mode} ${edge} scroll`).toBe(scrollBeforePanelMove)
      expect(g.caretInQuote, `${mode} ${edge} caret`).toBe(true)
      expect(g.panel.top, `${mode} ${edge}`).toBeGreaterThanOrEqual(
        g.toolbarBottom + 8,
      )
      expect(g.panel.bottom, `${mode} ${edge}`).toBeLessThanOrEqual(
        g.scrollerBottom - 8,
      )
      expect(
        g.panel.bottom <= g.quote.top - 7 || g.panel.top >= g.quote.bottom + 7,
        `${mode} ${edge}`,
      ).toBe(true)
    }
  }
  expect(await page.evaluate(() => (window as any).__getValue())).toBe(
    exactBefore,
  )
})
