import { expect, test } from './coverage-fixture'
import { openRewrapHarness, placeRewrapCaret } from './rewrap-helpers'

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`manual rewrap changes only the caret paragraph in ${mode}`, async ({
    page,
  }) => {
    await openRewrapHarness(page, mode)
    await placeRewrapCaret(page, 'gamma', 2)

    await page.evaluate(() => (window as any).__rewrap.run())
    const expected = await page.evaluate(() =>
      (window as any).__rewrap.initial.replace(
        'alpha beta gamma delta epsilon',
        'alpha beta\ngamma delta\nepsilon',
      ),
    )
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(expected)

    const state = await page.evaluate(() => {
      const h = (window as any).__rewrap
      const inner = h.editor.vditor
      const active = inner[inner.currentMode].element as HTMLElement
      return {
        ...h.state(),
        sourceCaretOffset: h.cursorOffset(),
        markerLeft: document.body.textContent?.includes('VMDE_REWRAP'),
        softBreakMarkers: active.querySelectorAll('[data-vmde-soft-break="1"]')
          .length,
        proseWhiteSpace:
          inner.currentMode === 'sv'
            ? null
            : getComputedStyle(active.querySelector('p')!).whiteSpace,
      }
    })
    expect(state).toMatchObject({ syncs: 1, error: '', markerLeft: false })
    expect(state.sourceCaretOffset).toBe(13)
    expect(state.softBreakMarkers).toBe(0)
    expect(state.proseWhiteSpace).toBe(mode === 'sv' ? null : 'normal')
  })
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`document rewrap is one caret-preserving transaction in ${mode}`, async ({
    page,
  }) => {
    await openRewrapHarness(page, mode, false, true)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toContain('middle alpha beta gamma delta epsilon')
    if (mode === 'sv') {
      await page.evaluate(() => {
        const inner = (window as any).__rewrap.editor.vditor
        const source = inner.sv.element as HTMLElement
        source.textContent = (source.textContent ?? '').replace(
          'hard alpha\nhard beta gamma',
          'hard alpha  \nhard beta gamma',
        )
      })
    }
    const canonicalBefore = await page.evaluate(() =>
      (window as any).__rewrap.editor.getValue(),
    )
    expect(canonicalBefore).toContain('hard alpha  \nhard beta gamma')
    const expected = canonicalBefore
      .replace(
        'first alpha beta gamma delta epsilon',
        'first alpha beta\ngamma delta\nepsilon',
      )
      .replace(
        'middle alpha beta gamma delta epsilon',
        'middle alpha beta\ngamma delta\nepsilon',
      )
      .replace(
        '> quote alpha beta gamma delta',
        '> quote alpha beta\n> gamma delta',
      )
      .replace(
        '- list alpha beta gamma delta',
        '- list alpha beta\n  gamma delta',
      )
      .replace(
        'tail alpha beta gamma delta epsilon',
        'tail alpha beta\ngamma delta\nepsilon',
      )
    await placeRewrapCaret(
      page,
      'middle alpha beta gamma delta epsilon',
      'middle alpha beta '.length + 2,
    )
    await page.evaluate(() => {
      const inner = (window as any).__rewrap.editor.vditor
      const editor = inner[inner.currentMode].element as HTMLElement
      const scroller = editor.parentElement as HTMLElement
      scroller.style.height = '100px'
      scroller.style.overflow = 'auto'
      scroller.scrollTop = 35
      ;(window as any).__documentRewrapBefore = {
        mode: inner.currentMode,
        scroller,
        scrollTop: scroller.scrollTop,
      }
    })

    const changed = await page.evaluate(() =>
      (window as any).__rewrap.runDocument(),
    )
    expect(changed).toBe(true)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(expected)

    const state = await page.evaluate(() => {
      const harness = (window as any).__rewrap
      const inner = harness.editor.vditor
      const editor = inner[inner.currentMode].element as HTMLElement
      const before = (window as any).__documentRewrapBefore
      return {
        ...harness.state(),
        mode: inner.currentMode,
        caret: harness.cursorOffset(),
        scrollKept:
          before.scroller === editor.parentElement &&
          before.scroller.scrollTop === before.scrollTop,
        focused: editor.contains(document.activeElement),
        markerInMarkdown: harness.editor.getValue().includes('VMDE_REWRAP'),
        markerInDom: editor.textContent?.includes('VMDE_REWRAP') ?? false,
      }
    })
    expect(state).toMatchObject({
      syncs: 1,
      error: '',
      mode,
      caret: expected.indexOf('gamma delta', expected.indexOf('middle')) + 2,
      scrollKept: true,
      focused: true,
      markerInMarkdown: false,
      markerInDom: false,
    })

    expect(
      await page.evaluate(() => (window as any).__rewrap.runDocument()),
    ).toBe(false)
    expect(
      await page.evaluate(() => (window as any).__rewrap.state().syncs),
    ).toBe(1)

    await page.evaluate(() => {
      const inner = (window as any).__rewrap.editor.vditor
      ;(inner.toolbar.elements.undo.children[0] as HTMLElement).click()
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(canonicalBefore)
    await page.evaluate(() => {
      const inner = (window as any).__rewrap.editor.vditor
      ;(inner.toolbar.elements.redo.children[0] as HTMLElement).click()
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(expected)
    await page.keyboard.press('Control+z')
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(canonicalBefore)
  })
}

// Task 580 CP2-7 — Rewrap has no webview key: Alt+Q changes nothing, and the command path
// (`__rewrap.run`, the `rewrap-selection` route) still rewraps once.
test('Alt+Q is inert and the command path rewraps once', async ({ page }) => {
  await openRewrapHarness(page, 'sv')
  await placeRewrapCaret(page, 'gamma', 2)
  const initial = await page.evaluate(() =>
    (window as any).__rewrap.editor.getValue(),
  )

  await page.keyboard.press('Alt+q')
  await page.waitForTimeout(100)
  expect(
    await page.evaluate(() => (window as any).__rewrap.editor.getValue()),
  ).toBe(initial)
  expect(
    await page.evaluate(() => (window as any).__rewrap.state().syncs),
  ).toBe(0)

  await page.evaluate(() => (window as any).__rewrap.run())

  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs))
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toContain('alpha beta\ngamma delta')
})
