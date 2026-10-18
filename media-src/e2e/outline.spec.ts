import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// E2e for the outline cluster (tasks 07/08/13): the outline panel renders its
// heading items on the configured side, clicking one flashes the target
// heading, and the highlight/width CSS hooks behave.

async function gotoOutline(page: Page) {
  await page.goto('/outline.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

const VIEWPORT_CLASS = 'vmde-outline-item--in-viewport'

async function viewportProjection(page: Page) {
  return page.evaluate((viewportClass) => {
    const v = (window as any).vditor.vditor
    const surface =
      v.preview.element.style.display === 'block'
        ? v.preview.previewElement
        : v[v.currentMode].element
    const root = v.preview.element.contains(surface)
      ? surface.parentElement
      : surface
    const rootRect = root.getBoundingClientRect()
    const headings = Array.from(
      surface.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'),
    )
    const surfaceEnd =
      surface === root
        ? rootRect.top + surface.scrollHeight - root.scrollTop
        : surface.getBoundingClientRect().top + surface.scrollHeight
    const expected = headings
      .filter((heading, index) => {
        const start = heading.getBoundingClientRect().top
        const end =
          headings[index + 1]?.getBoundingClientRect().top ?? surfaceEnd
        return end > rootRect.top + 4 && start < rootRect.bottom - 4
      })
      .map((heading) => heading.id)
    const actual = Array.from(
      document.querySelectorAll<HTMLElement>(
        `.vditor-outline li > span.${viewportClass}`,
      ),
    ).map((item) => item.dataset.targetId!)
    return {
      mode: v.currentMode as string,
      rootClass: root.className as string,
      expected,
      actual,
    }
  }, VIEWPORT_CLASS)
}

async function expectProjectionMatchesGeometry(page: Page) {
  await expect
    .poll(async () => {
      const projection = await viewportProjection(page)
      return (
        JSON.stringify(projection.actual) ===
        JSON.stringify(projection.expected)
      )
    })
    .toBe(true)
}

test('preamble before the first rendered heading has no outline owner', async ({
  page,
}) => {
  await gotoOutline(page)

  await expect
    .poll(() => viewportProjection(page))
    .toMatchObject({
      mode: 'ir',
      rootClass: 'vditor-reset',
      expected: [],
      actual: [],
    })
  const projection = await viewportProjection(page)
  expect(projection.actual).toEqual(projection.expected)
})

test('scrolling keeps long section ownership, spans a boundary, then transfers it', async ({
  page,
}) => {
  await gotoOutline(page)
  await expectProjectionMatchesGeometry(page)
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  const ids = await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    const root = v.ir.element as HTMLElement
    const headings = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')
    root.scrollTop = headings[3].offsetTop + 100
    return { owner: headings[3].id, next: headings[4].id }
  })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = (window as any).vditor.vditor.ir.element as HTMLElement
        const heading =
          root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[3]
        return (
          heading.getBoundingClientRect().bottom <
          root.getBoundingClientRect().top + 4
        )
      }),
    )
    .toBe(true)
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).actual).toContain(ids.owner)

  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    const root = v.ir.element as HTMLElement
    const next = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[4]
    const rootRect = root.getBoundingClientRect()
    root.scrollTop += next.getBoundingClientRect().top - (rootRect.top + 50)
  })
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).actual).toEqual([ids.owner, ids.next])

  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const next = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[4]
    root.scrollTop +=
      next.getBoundingClientRect().top - (root.getBoundingClientRect().top - 1)
  })
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).actual).toEqual([ids.next])
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})

test('outline rebuild replaces rows while retaining the matching viewport projection', async ({
  page,
}) => {
  await gotoOutline(page)
  await expectProjectionMatchesGeometry(page)
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      '.vditor-outline [data-target-id]',
    )!
    row.dataset.preRebuild = '1'
    const editor = (window as any).vditor
    editor.setValue(`${editor.getValue()}\n\n## Added viewport heading\n`)
  })

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelectorAll('.vditor-outline li > span[data-target-id]')
            .length,
      ),
    )
    .toBe(6)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('.vditor-outline [data-pre-rebuild]') === null,
      ),
    )
    .toBe(true)
  await expectProjectionMatchesGeometry(page)
})

test('the final section remains active through the scrollable tail', async ({
  page,
}) => {
  await gotoOutline(page)
  const finalId = await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop = root.scrollHeight
    return Array.from(
      root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'),
    ).at(-1)!.id
  })
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).actual).toEqual([finalId])
})

test('WYSIWYG, full Preview, and SV rebind to Vditor’s rendered outline surface', async ({
  page,
}) => {
  await gotoOutline(page)
  const clickControl = (selector: string) =>
    page.evaluate((targetSelector) => {
      document
        .querySelector<HTMLElement>(targetSelector)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, selector)

  await clickControl('button[data-mode="wysiwyg"]')
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).rootClass).toBe('vditor-reset')

  await clickControl('button[data-type="preview"]')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).vditor.vditor.preview.element.style.display,
      ),
    )
    .toBe('block')
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).rootClass).toContain('vditor-preview')

  await clickControl('button[data-type="preview"]')
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).vditor.vditor.preview.element.style.display,
      ),
    )
    .toBe('none')
  await clickControl('button[data-mode="sv"]')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        mode: (window as any).vditor.vditor.currentMode,
        preview: (window as any).vditor.vditor.preview.element.style.display,
      })),
    )
    .toEqual({ mode: 'sv', preview: 'block' })
  // Vditor intentionally hides its outline on entry to SV. Reopen it explicitly so this assertion
  // exercises task 517's promised SV rendered-Preview surface while the in-editor outline is open.
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.outline.toggle(v, true, false)
  })
  await expect(page.locator('.vditor-outline')).toBeVisible()
  await expectProjectionMatchesGeometry(page)
  expect((await viewportProjection(page)).rootClass).toContain('vditor-preview')
})

test('viewport styling keeps hover distinct and keyboard focus visibly stronger', async ({
  page,
}) => {
  await gotoOutline(page)
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop = root.querySelector<HTMLElement>('h1')!.offsetTop
  })
  await expectProjectionMatchesGeometry(page)
  await page.evaluate(() => {
    const root = document.documentElement.style
    root.setProperty(
      '--vscode-list-inactiveSelectionBackground',
      'rgb(10, 20, 30)',
    )
    root.setProperty('--vscode-list-hoverBackground', 'rgb(40, 50, 60)')
    root.setProperty('--vscode-list-focusBackground', 'rgb(70, 80, 90)')
    root.setProperty('--vscode-focusBorder', 'rgb(1, 2, 3)')
  })
  const item = page.locator(`.vditor-outline .${VIEWPORT_CLASS}`).first()
  const styles = () =>
    item.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
      }
    })

  expect(await styles()).toMatchObject({
    background: 'rgb(10, 20, 30)',
    boxShadow: expect.stringContaining('rgb(1, 2, 3)'),
  })
  await item.hover()
  expect((await styles()).background).toBe('rgb(40, 50, 60)')

  await page.keyboard.press('Tab')
  await item.evaluate((element: HTMLElement) => element.focus())
  expect(await styles()).toMatchObject({
    background: 'rgb(70, 80, 90)',
    outlineColor: 'rgb(1, 2, 3)',
    outlineStyle: 'solid',
  })
})

test('outline renders heading items and opens on the configured (right) side', async ({
  page,
}) => {
  await gotoOutline(page)
  await expect(page.locator('.vditor-outline')).toHaveClass(
    /vditor-outline--right/,
  )
  const items = page.locator('.vditor-outline li span[data-target-id]')
  // one per heading in the harness document (H1/H2/H3)
  expect(await items.count()).toBeGreaterThanOrEqual(3)
})

test('clicking an outline item flashes the target heading (task 13)', async ({
  page,
}) => {
  await gotoOutline(page)
  const targetId = await page.evaluate(() => {
    const span = document.querySelector(
      '.vditor-outline li span[data-target-id]',
    ) as HTMLElement
    span.click() // bubbles to the outline container → setupOutlineFlash
    return span.getAttribute('data-target-id')
  })
  // SCROLL_SETTLE_MS is 60ms; wait past it then assert the flash class landed.
  await page.waitForTimeout(150)
  const flashed = await page.evaluate(
    (id) => document.getElementById(id!)?.classList.contains('heading-flash'),
    targetId,
  )
  expect(flashed).toBe(true)
})

test('highlight-headings attr themes headings; --me-outline-width drives panel width', async ({
  page,
}) => {
  await gotoOutline(page)
  const styles = await page.evaluate(() => {
    document.body.setAttribute('data-highlight-headings', '1')
    document.body.style.setProperty('--me-outline-width', '321px')
    const h1 = document.querySelector('.vditor-reset h1') as HTMLElement
    const outline = document.querySelector('.vditor-outline') as HTMLElement
    return {
      h1Radius: getComputedStyle(h1).borderRadius,
      h1Bg: getComputedStyle(h1).backgroundColor,
      outlineWidth: getComputedStyle(outline).width,
    }
  })
  expect(styles.h1Radius).toBe('3px') // heading-highlight rule applied
  // translucent overlay (follows the theme), not a fixed blue-grey var
  expect(styles.h1Bg).toBe('rgba(127, 127, 127, 0.13)')
  expect(styles.outlineWidth).toBe('321px') // width var applied
})

// Task 478 item 2: `.vditor-outline` width used to be a main.css override (200px) beating
// Vditor's own hardcoded 250px on load order alone; now the 200px default lives directly on
// Vditor's own rule (build.mjs patchVditorIndexCss), token-driven the same way. This is the
// case the explicit-321px test above can't cover: a fresh page where `--me-outline-width` was
// NEVER set, so the FALLBACK value in the `var(…, 200px)` expression is what's read.
test("`.vditor-outline` width defaults to 200px (not Vditor's 250px) when --me-outline-width is unset (task 478 item 2)", async ({
  page,
}) => {
  await gotoOutline(page)
  const width = await page.evaluate(() => {
    const outline = document.querySelector('.vditor-outline') as HTMLElement
    return getComputedStyle(outline).width
  })
  expect(width).toBe('200px')
})

test('--me-font-size drives the .vditor-reset base size; headings scale with it (task 43)', async ({
  page,
}) => {
  await gotoOutline(page)
  const sizes = await page.evaluate(() => {
    const reset = document.querySelector('.vditor-reset') as HTMLElement
    const h1 = document.querySelector('.vditor-reset h1') as HTMLElement
    document.body.style.setProperty('--me-font-size', '20px')
    const base20 = parseFloat(getComputedStyle(reset).fontSize)
    const h1At20 = parseFloat(getComputedStyle(h1).fontSize)
    document.body.style.setProperty('--me-font-size', '10px')
    const base10 = parseFloat(getComputedStyle(reset).fontSize)
    return { base20, base10, h1At20 }
  })
  expect(sizes.base20).toBe(20) // CSS rule follows the var
  expect(sizes.base10).toBe(10) // and updates live
  expect(sizes.h1At20).toBeGreaterThan(20) // em-relative heading scales up
})

// Task 478 item 5: `.vditor .vditor-reset { font-family: var(--vscode-editor-font-family)
// !important }` used to be a main.css override beating Vditor's own unconditional
// `.vditor-reset { font-family: "Helvetica Neue", … }` (0,1,0) on specificity alone — a
// genuine ADR-0003 violation. Now patched directly on Vditor's own base rule (build.mjs
// patchVditorIndexCss). The font-SIZE half is already proven live above; this proves the
// font-FAMILY half follows the same var and that Vditor's hardcoded stack no longer wins.
test("`.vditor-reset` font-family follows --vscode-editor-font-family, not Vditor's hardcoded stack (task 478 item 5)", async ({
  page,
}) => {
  await gotoOutline(page)
  const family = await page.evaluate(() => {
    const reset = document.querySelector('.vditor-reset') as HTMLElement
    document.documentElement.style.setProperty(
      '--vscode-editor-font-family',
      'Consolas',
    )
    return getComputedStyle(reset).fontFamily
  })
  expect(family).toBe('Consolas')
  expect(family).not.toContain('Helvetica Neue') // Vditor's hardcoded default, no longer wins
})

test('showHeadingMarkers toggle hides the gutter markers WITHOUT moving the text', async ({
  page,
}) => {
  await gotoOutline(page)
  const result = await page.evaluate(() => {
    const h1 = document.querySelector(
      '.vditor-ir .vditor-reset > h1',
    ) as HTMLElement
    const reset = document.querySelector(
      '.vditor-ir .vditor-reset',
    ) as HTMLElement
    // The gutter is a FIXED --vmde-gutter (VS Code's native-preview inset, 52px) that the markers
    // are floated INTO, so hiding them only empties it — the text column must not move (task
    // 438; it used to collapse to 10px in full width). Measured in full-width mode, where the
    // padding is the gutter itself rather than the centring formula.
    document.body.setAttribute('data-full-width', '1')
    document.body.setAttribute('data-heading-markers', '1')
    const shown = getComputedStyle(h1, '::before').display
    const padOn = getComputedStyle(reset).paddingLeft
    document.body.setAttribute('data-heading-markers', '0')
    const hidden = getComputedStyle(h1, '::before').display
    const padOff = getComputedStyle(reset).paddingLeft
    return { shown, hidden, padOn, padOff }
  })
  expect(result.shown).not.toBe('none') // marker visible by default
  expect(result.hidden).toBe('none') // hidden when toggled off
  // the gutter (and with it the text origin) is IDENTICAL in both marker states
  expect(parseFloat(result.padOff)).toBe(parseFloat(result.padOn))
  expect(parseFloat(result.padOn)).toBe(52)
})

// The drag-resize handle must track the outline's visibility. Vditor's Outline.toggle()
// only flips the panel's inline display; with the outline OFF the handle would otherwise
// hang at the editor's right edge (visible grip for a hidden panel) and its straddle margins
// poked a few px past the viewport → a phantom horizontal scrollbar. outline-resize.ts mirrors
// the outline's display onto the handle.
test('the resize handle is hidden when the outline is toggled off, shown when on', async ({
  page,
}) => {
  await gotoOutline(page)
  const handle = page.locator('.outline-resize-handle')
  await expect(handle).toHaveCount(1)
  // outline starts enabled → handle visible
  await expect(handle).toBeVisible()

  // toggle the outline OFF through Vditor's own path (sets display:none on the panel)
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.outline.toggle(v, false)
  })
  await expect(handle).toBeHidden() // MutationObserver mirrored display:none

  // and back ON
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.outline.toggle(v, true)
  })
  await expect(handle).toBeVisible()
})

// Task 458 — outline panel keyboard operability. The harness document nests all 3 headings
// (H1 > H2 > H3), giving a real parent/child chain to exercise ArrowRight/Left on, not just a
// flat list.
test('outline items are role="treeitem" in a role="tree" with roving tabindex; ArrowDown moves focus', async ({
  page,
}) => {
  await gotoOutline(page)
  const items = page.locator('.vditor-outline li span[data-target-id]')
  await expect(items.first()).toHaveAttribute('role', 'treeitem')
  await expect(page.locator('.vditor-outline__content > ul')).toHaveAttribute(
    'role',
    'tree',
  )
  // Roving tabindex: exactly the first item starts tabbable.
  expect(await items.nth(0).getAttribute('tabindex')).toBe('0')
  expect(await items.nth(1).getAttribute('tabindex')).toBe('-1')

  await items.nth(0).evaluate((el: HTMLElement) => el.focus())
  await page.keyboard.press('ArrowDown')
  const secondIsActive = await items
    .nth(1)
    .evaluate((el) => el === document.activeElement)
  expect(secondIsActive).toBe(true)
  expect(await items.nth(1).getAttribute('tabindex')).toBe('0')
  expect(await items.nth(0).getAttribute('tabindex')).toBe('-1')
})

test('ArrowRight expands/descends, ArrowLeft collapses/ascends (WAI-ARIA treeview pattern)', async ({
  page,
}) => {
  await gotoOutline(page)
  const items = page.locator('.vditor-outline li span[data-target-id]')
  const [h1, h2, h3] = [items.nth(0), items.nth(1), items.nth(2)]

  await h1.evaluate((el: HTMLElement) => el.focus())
  // H1 starts expanded (Vditor's default) → ArrowRight descends straight to its child, H2.
  await expect(h1).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  expect(await h2.evaluate((el) => el === document.activeElement)).toBe(true)

  // H2 also starts expanded → ArrowRight descends to the leaf, H3 (no aria-expanded — no children).
  await page.keyboard.press('ArrowRight')
  expect(await h3.evaluate((el) => el === document.activeElement)).toBe(true)
  expect(await h3.getAttribute('aria-expanded')).toBeNull()
  // A leaf's own ArrowRight is a no-op (nothing to expand into).
  await page.keyboard.press('ArrowRight')
  expect(await h3.evaluate((el) => el === document.activeElement)).toBe(true)

  // Leaf ArrowLeft steps up to the parent (H2), not a collapse (H3 has no children to collapse).
  await page.keyboard.press('ArrowLeft')
  expect(await h2.evaluate((el) => el === document.activeElement)).toBe(true)

  // H2 is still expanded (with a child) → ArrowLeft here COLLAPSES it in place, staying on H2.
  await page.keyboard.press('ArrowLeft')
  expect(await h2.evaluate((el) => el === document.activeElement)).toBe(true)
  await expect(h2).toHaveAttribute('aria-expanded', 'false')

  // H2 is now collapsed → a second ArrowLeft steps up to ITS parent, H1.
  await page.keyboard.press('ArrowLeft')
  expect(await h1.evaluate((el) => el === document.activeElement)).toBe(true)
})

test('Enter activates the focused outline item via scrollToHeadingIndex (flash), leaving getValue() untouched', async ({
  page,
}) => {
  await gotoOutline(page)
  const items = page.locator('.vditor-outline li span[data-target-id]')
  const second = items.nth(1)
  const targetId = await second.getAttribute('data-target-id')
  const before = await page.evaluate(() => (window as any).vditor.getValue())

  await second.evaluate((el: HTMLElement) => el.focus())
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          document.getElementById(id!)?.classList.contains('heading-flash'),
        targetId,
      ),
    )
    .toBe(true)

  const after = await page.evaluate(() => (window as any).vditor.getValue())
  expect(after).toBe(before)
})

test('the resize handle is a keyboard-operable role="separator": Arrow/Home/End resize + persist', async ({
  page,
}) => {
  await gotoOutline(page)
  const handle = page.locator('.outline-resize-handle')
  await expect(handle).toHaveAttribute('role', 'separator')
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical')
  expect(await handle.evaluate((el: HTMLElement) => el.tabIndex)).toBe(0)

  // The panel's OWN computed (content-box) width — what `--me-outline-width` directly sets and
  // what every assertion below checks against.
  const widthVar = () =>
    page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.querySelector('.vditor-outline')!).width,
      ),
    )
  const persistedWidth = () =>
    page.evaluate(() => (window as any).__lastOutlineWidth)

  // The basis of every keyboard step is the content width (var or the 200px default), never a
  // border-box measurement (task 656), so the first press adds exactly 10 to the computed width.
  const startContent = await widthVar()
  await handle.evaluate((el: HTMLElement) => el.focus())
  // Harness mounts the outline on the RIGHT (outline-harness.ts) — ArrowLeft grows it (moving the
  // boundary away from the panel's own edge), matching keyboardWidthDelta's sign convention.
  await page.keyboard.press('ArrowLeft')
  const afterFirstPress = startContent + 10
  await expect.poll(widthVar).toBe(afterFirstPress)
  expect(await persistedWidth()).toBe(afterFirstPress)

  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const afterThreePresses = afterFirstPress - 20
  await expect.poll(widthVar).toBe(afterThreePresses)
  expect(await persistedWidth()).toBe(afterThreePresses)

  await page.keyboard.press('Home')
  await expect.poll(widthVar).toBe(100) // MIN_WIDTH
  expect(await persistedWidth()).toBe(100)

  const expectedMax = await page.evaluate(() =>
    Math.floor(window.innerWidth * 0.5),
  )
  await page.keyboard.press('End')
  await expect.poll(widthVar).toBe(expectedMax)
  expect(await persistedWidth()).toBe(expectedMax)
})

// Task 650 Decision 5 ("Clamp" acceptance row): the panel's SHOWN width is clamped to
// [100px, 50vw] in CSS alone; the stored `--me-outline-width` is never rewritten by display, and
// nothing is persisted (no onResize call) without a user resize.
async function shownAndStored(page: Page) {
  return page.evaluate(() => ({
    shown: parseFloat(
      getComputedStyle(document.querySelector('.vditor-outline')!).width,
    ),
    stored: document.body.style.getPropertyValue('--me-outline-width'),
    viewport: window.innerWidth,
    posted: (window as any).__lastOutlineWidth,
  }))
}

test('an oversized --me-outline-width shows at 50% of the viewport, live on resize, without rewriting or persisting (task 650 Clamp)', async ({
  page,
}) => {
  await gotoOutline(page)
  await page.evaluate(() =>
    document.body.style.setProperty('--me-outline-width', '5000px'),
  )
  let s = await shownAndStored(page)
  expect(Math.abs(s.shown - s.viewport / 2)).toBeLessThanOrEqual(1)
  expect(s.stored).toBe('5000px')
  expect(s.posted).toBeUndefined()

  // Narrowing the window re-clamps live — CSS only, nothing posted, var untouched.
  await page.setViewportSize({ width: 700, height: 600 })
  await expect
    .poll(async () => (await shownAndStored(page)).shown)
    .toBeCloseTo(350, 0)
  s = await shownAndStored(page)
  expect(s.stored).toBe('5000px')
  expect(s.posted).toBeUndefined()
})

test('an undersized --me-outline-width shows at the 100px floor (task 650 Clamp)', async ({
  page,
}) => {
  await gotoOutline(page)
  await page.evaluate(() =>
    document.body.style.setProperty('--me-outline-width', '50px'),
  )
  const s = await shownAndStored(page)
  expect(s.shown).toBe(100)
  expect(s.stored).toBe('50px')
  expect(s.posted).toBeUndefined()
})

test('keyboard resize and aria-valuenow start from the shown width when the stored var is oversized (task 650 Clamp)', async ({
  page,
}) => {
  await gotoOutline(page)
  await page.evaluate(() =>
    document.body.style.setProperty('--me-outline-width', '5000px'),
  )
  const viewport = await page.evaluate(() => window.innerWidth)
  const shown = Math.floor(viewport * 0.5)
  const handle = page.locator('.outline-resize-handle')
  await handle.evaluate((el: HTMLElement) => el.focus())
  // Right-side outline: ArrowRight shrinks. Basis is the shown (clamped) width, not 5000.
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', String(shown - 10))
  const s = await shownAndStored(page)
  expect(s.stored).toBe(`${shown - 10}px`)
  expect(s.posted).toBe(shown - 10)
})

// Task 656: drag-resize stores the content width (the value of --me-outline-width), never the
// border-box offsetWidth, and a gesture that leaves the size unchanged posts nothing.
const outlineState = (page: Page) =>
  page.evaluate(() => ({
    varPx: parseFloat(
      document.body.style.getPropertyValue('--me-outline-width'),
    ),
    shown: parseFloat(
      getComputedStyle(document.querySelector('.vditor-outline')!).width,
    ),
    posts: (window as any).__outlineWidthPosts as number[],
  }))

async function handleCenter(page: Page) {
  const box = await page.locator('.outline-resize-handle').boundingBox()
  if (!box) throw new Error('resize handle has no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Right-side panel: dragging left grows it.
async function dragHandle(page: Page, dx: number) {
  const c = await handleCenter(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + dx, c.y, { steps: 4 })
  await page.mouse.up()
}

async function moveAwayAndBack(page: Page) {
  const c = await handleCenter(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x - 20, c.y, { steps: 3 })
  await page.mouse.move(c.x, c.y, { steps: 3 })
  await page.mouse.up()
}

async function pressWithoutMoving(page: Page) {
  const c = await handleCenter(page)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.up()
}

test('a drag stores the content width equal to --me-outline-width (task 656 Acceptance 1)', async ({
  page,
}) => {
  await gotoOutline(page)
  await dragHandle(page, -50)
  await expect.poll(async () => (await outlineState(page)).varPx).toBe(250)
  const s = await outlineState(page)
  expect(s.posts[s.posts.length - 1]).toBe(s.varPx)
  expect(s.shown).toBe(s.varPx)
})

test('ten move-and-return drags leave the stored width unchanged (task 656 Acceptance 2)', async ({
  page,
}) => {
  await gotoOutline(page)
  await dragHandle(page, -50)
  await expect.poll(async () => (await outlineState(page)).varPx).toBe(250)
  for (let i = 0; i < 10; i++) await moveAwayAndBack(page)
  const s = await outlineState(page)
  expect(s.varPx).toBe(250)
  expect(s.shown).toBe(250)
  expect(s.posts.every((w) => w === 250)).toBe(true)
})

test('ten press-and-release cycles without movement keep the width and post nothing (task 656 Acceptance 2)', async ({
  page,
}) => {
  await gotoOutline(page)
  await dragHandle(page, -50)
  await expect.poll(async () => (await outlineState(page)).varPx).toBe(250)
  for (let i = 0; i < 10; i++) await pressWithoutMoving(page)
  const s = await outlineState(page)
  expect(s.varPx).toBe(250)
  expect(s.posts.every((w) => w === 250)).toBe(true)

  // Fresh page, nothing ever dragged: no post at all.
  await gotoOutline(page)
  for (let i = 0; i < 10; i++) await pressWithoutMoving(page)
  expect((await outlineState(page)).posts).toEqual([])
})

test('an oversized stored width is not overwritten by clicks and a drag starts from the shown width (task 656 clamp interaction)', async ({
  page,
}) => {
  await gotoOutline(page)
  await page.evaluate(() =>
    document.body.style.setProperty('--me-outline-width', '5000px'),
  )
  for (let i = 0; i < 10; i++) await pressWithoutMoving(page)
  let s = await outlineState(page)
  expect(s.varPx).toBe(5000)
  expect(s.posts).toEqual([])

  const shown = Math.floor((await page.evaluate(() => window.innerWidth)) / 2)
  // Right-side panel: dragging right shrinks it by 30.
  await dragHandle(page, 30)
  await expect
    .poll(async () => (await outlineState(page)).varPx)
    .toBe(shown - 30)
  s = await outlineState(page)
  expect(s.posts[s.posts.length - 1]).toBe(shown - 30)
})

test('the initial aria-valuenow is the content width (task 656)', async ({
  page,
}) => {
  const handle = page.locator('.outline-resize-handle')
  await gotoOutline(page)
  await expect(handle).toHaveAttribute('aria-valuenow', '200')

  await gotoOutlineWith(page, 'outlineOpen=0')
  await expect(handle).toHaveAttribute('aria-valuenow', '200')

  await gotoOutlineWith(page, 'outlineVar=321')
  await expect(handle).toHaveAttribute('aria-valuenow', '321')
})

// Task 650 (open state): the harness resolves init values with the real buildVditorOptions rule
// (`?outlineOpen=1|0` = remembered value, `?defaultOpen=1` = vmde.outline.defaultOpen).
async function gotoOutlineWith(page: Page, query: string) {
  await page.goto(`/outline.html?${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
}
const outlineShown = (page: Page) =>
  page.evaluate(
    () =>
      getComputedStyle(document.querySelector('.vditor-outline')!).display !==
      'none',
  )
const outlinePosts = (page: Page) =>
  page.evaluate(() => (window as any).__outlineOpenPosts)
const clickOutlineButton = (page: Page) =>
  page.evaluate(() =>
    (
      document.querySelector(
        '.vditor-toolbar [data-type="outline"]',
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )

test('a remembered open state opens the panel although the setting is off, and a user toggle posts the new state (task 650)', async ({
  page,
}) => {
  await gotoOutlineWith(page, 'outlineOpen=1&defaultOpen=0')
  expect(await outlineShown(page)).toBe(true)
  expect(await outlinePosts(page)).toEqual([])

  await clickOutlineButton(page)
  expect(await outlineShown(page)).toBe(false)
  expect(await outlinePosts(page)).toEqual([
    { command: 'save-outline-open', open: false },
  ])
  await clickOutlineButton(page)
  expect(await outlinePosts(page)).toEqual([
    { command: 'save-outline-open', open: false },
    { command: 'save-outline-open', open: true },
  ])
})

test('a remembered closed state keeps the panel closed although the setting is on (task 650)', async ({
  page,
}) => {
  await gotoOutlineWith(page, 'outlineOpen=0&defaultOpen=1')
  expect(await outlineShown(page)).toBe(false)
})

test('a mode switch posts no open state (task 650)', async ({ page }) => {
  await gotoOutlineWith(page, 'outlineOpen=1')
  for (const mode of ['wysiwyg', 'sv', 'ir']) {
    await page.evaluate((m) => {
      document
        .querySelector<HTMLElement>(`button[data-mode="${m}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).vditor.vditor.currentMode),
      )
      .toBe(mode)
  }
  expect(await outlinePosts(page)).toEqual([])
})
