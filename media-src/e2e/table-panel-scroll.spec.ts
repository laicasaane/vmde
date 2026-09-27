import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// A small, public fixture keeps the baseline scroll measurement independent of
// the large private-text guard and gives the IR root room to scroll both ways.
const SOURCE = [
  ...Array.from({ length: 18 }, (_, i) => `Before table ${i}.\n`),
  '| Left | Center | Right |\n| :--- | :---: | ---: |\n| one | two | three |\n',
  ...Array.from({ length: 30 }, (_, i) => `After table ${i}.\n`),
].join('\n')

async function geometry(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(
      '.vditor-ir > .vditor-reset',
    )!
    const cell = root.querySelector('td')!.getBoundingClientRect()
    const panel = document
      .querySelector('#fix-table-ir-wrapper .vditor-panel')!
      .getBoundingClientRect()
    const rect = (value: DOMRect) => ({
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height,
    })
    return {
      scrollTop: root.scrollTop,
      scrollLeft: root.scrollLeft,
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight,
      overflowY: getComputedStyle(root).overflowY,
      documentScrollTop: document.scrollingElement!.scrollTop,
      root: rect(root.getBoundingClientRect()),
      cell: rect(cell),
      panel: rect(panel),
      offset: { left: panel.left - cell.left, top: panel.top - cell.top },
    }
  })
}

for (const width of [1100, 520]) {
  test(`IR table panel follows a 200 px root scroll at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.evaluate((source) => {
      const editor = (window as any).vditor
      // The shared table harness defaults to Vditor's height:"auto", whose inline
      // mount style overrides main.css and lets the root grow with its content.
      // Match boot/vditor-init.ts for this spec only, including Vditor's option
      // (used by its scroll routing), so the measured scroller is the IR root.
      editor.vditor.options.height = '100%'
      editor.vditor.options.minHeight = '100%'
      editor.vditor.element.style.height = '100%'
      editor.vditor.element.style.minHeight = '100%'
      editor.setValue(source)
    }, SOURCE)
    const scrollPrecondition = await page
      .locator('.vditor-ir > .vditor-reset')
      .evaluate((root) => ({
        clientHeight: root.clientHeight,
        scrollHeight: root.scrollHeight,
        overflowY: getComputedStyle(root).overflowY,
        viewportHeight: innerHeight,
      }))
    console.log(
      'task578-table-panel-scroller',
      JSON.stringify(scrollPrecondition),
    )
    await testInfo.attach('table-panel-scroller.json', {
      body: JSON.stringify(scrollPrecondition, null, 2),
      contentType: 'application/json',
    })
    expect(scrollPrecondition.overflowY).toBe('auto')
    expect(scrollPrecondition.clientHeight).toBeGreaterThan(400)
    expect(scrollPrecondition.clientHeight).toBeLessThan(
      scrollPrecondition.viewportHeight,
    )
    expect(
      scrollPrecondition.scrollHeight - scrollPrecondition.clientHeight,
    ).toBeGreaterThan(200)
    const cell = page.locator('.vditor-ir table td').first()
    await cell.evaluate(async (element) => {
      const root = element.closest<HTMLElement>('.vditor-reset')!
      // Leave enough visible space above the cell for a measured 200 px scroll.
      root.scrollTop +=
        element.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        root.clientHeight * 0.7
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    await cell.click()
    await expect(
      page.locator('#fix-table-ir-wrapper .vditor-panel'),
    ).toBeVisible()
    const sourceBefore = await page.evaluate(
      () => (window as any).vditor.getValue() as string,
    )
    const before = await geometry(page)
    await page.screenshot({ path: testInfo.outputPath('before-scroll.png') })
    await cell.evaluate(async (element) => {
      element.closest<HTMLElement>('.vditor-reset')!.scrollTop += 200
      // Geometry must be read after the passive scroll listener and layout run.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
    const after = await geometry(page)
    const sourceUnchanged = await page.evaluate(
      (source) => (window as any).vditor.getValue() === source,
      sourceBefore,
    )
    const measurement = { width, before, after, sourceUnchanged }
    console.log('task578-table-panel-scroll', JSON.stringify(measurement))
    await testInfo.attach('table-panel-scroll.json', {
      body: JSON.stringify(measurement, null, 2),
      contentType: 'application/json',
    })
    await page.screenshot({ path: testInfo.outputPath('after-scroll.png') })
    expect(after.scrollTop - before.scrollTop).toBe(200)
    expect(after.documentScrollTop).toBe(before.documentScrollTop)
    expect(after.root.top).toBe(before.root.top)
    expect(after.cell.top - before.cell.top).toBeCloseTo(-200, 1)
    expect(after.panel.top - before.panel.top).toBeCloseTo(-200, 1)
    expect(after.offset.left).toBeCloseTo(before.offset.left, 1)
    expect(after.offset.top).toBeCloseTo(before.offset.top, 1)
    // Checkpoint 2A relay 2 measured these offsets before panel relocation, at
    // both widths. Keep the original placement as well as the scroll delta.
    expect(before.offset.left).toBeCloseTo(0, 1)
    expect(before.offset.top).toBeCloseTo(-29, 1)
    expect(sourceUnchanged).toBe(true)
    const containment = await page.evaluate(() => {
      const root = (window as any).vditor.vditor.ir.element as HTMLElement
      const wrapper = document.querySelector<HTMLElement>(
        '#fix-table-ir-wrapper',
      )!
      const clip = wrapper.parentElement!
      const panel = wrapper.firstElementChild!.getBoundingClientRect()
      const clipRect = clip.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      return {
        outsideRoot: !root.contains(wrapper),
        siblingClip: clip.parentElement === root.parentElement,
        overflow: getComputedStyle(clip).overflow,
        clipPointerEvents: getComputedStyle(clip).pointerEvents,
        panelHit: !!document
          .elementFromPoint(
            panel.left + panel.width / 2,
            panel.top + panel.height / 2,
          )
          ?.closest('#fix-table-ir-wrapper'),
        clipError: Math.max(
          Math.abs(clipRect.left - rootRect.left),
          Math.abs(clipRect.top - rootRect.top),
          Math.abs(clipRect.right - rootRect.right),
          Math.abs(clipRect.bottom - rootRect.bottom),
        ),
      }
    })
    expect(containment).toEqual({
      outsideRoot: true,
      siblingClip: true,
      overflow: 'hidden',
      clipPointerEvents: 'none',
      panelHit: true,
      clipError: 0,
    })
    const clipped = await page.evaluate(async () => {
      const root = (window as any).vditor.vditor.ir.element as HTMLElement
      const panel = document.querySelector(
        '#fix-table-ir-wrapper .vditor-panel',
      )!
      const rootTop = root.getBoundingClientRect().top
      // Put the control just above the clip edge, still inside the browser
      // viewport: hit-testing there must find chrome, not the scrolled panel.
      root.scrollTop += panel.getBoundingClientRect().bottom - rootTop + 10
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      const rect = panel.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      return {
        aboveRoot: rect.bottom < rootTop,
        pointInViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
        panelHit: !!document
          .elementFromPoint(x, y)
          ?.closest('#fix-table-ir-wrapper'),
      }
    })
    console.log(
      'task578-table-panel-clip',
      JSON.stringify({ containment, clipped }),
    )
    await testInfo.attach('table-panel-clip.json', {
      body: JSON.stringify({ containment, clipped }, null, 2),
      contentType: 'application/json',
    })
    await page.screenshot({ path: testInfo.outputPath('clipped-panel.png') })
    expect(clipped).toEqual({
      aboveRoot: true,
      pointInViewport: true,
      panelHit: false,
    })
  })
}
