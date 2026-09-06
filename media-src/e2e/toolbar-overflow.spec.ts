import { expect, test } from './coverage-fixture'

test('moves overflowed items into more and restores their authored order', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  await page.setViewportSize({ width: 360, height: 700 })
  await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
  // Row one and row two have independent budgets: a narrow width may move every inline-formatting
  // group while the structural row still has a different surviving set.
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0, { timeout: 5_000 })
  const narrow = await page.evaluate(() => {
    const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
    const more = toolbar.querySelector(
      '.vmde-toolbar-more > .vditor-hint',
    ) as HTMLElement
    return {
      hasOverflow: Boolean(more.querySelector('[data-vmde-overflow="true"]')),
      rowCount: toolbar.querySelectorAll(':scope > .vmde-toolbar-row').length,
      overflowTabbable: [...more.querySelectorAll('button')].some(
        (button) => button.tabIndex === 0,
      ),
      moreExpanded: toolbar
        .querySelector('.vmde-toolbar-more > button')
        ?.getAttribute('aria-expanded'),
    }
  })
  expect(narrow.hasOverflow).toBe(true)
  expect(narrow.rowCount).toBe(2)
  expect(narrow.overflowTabbable).toBe(true)
  expect(narrow.moreExpanded).toBe('false')

  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  const order = await page
    .locator('.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item')
    .evaluateAll((items) =>
      items
        .map((item) =>
          item.querySelector(':scope > [data-type]')?.getAttribute('data-type'),
        )
        .filter(Boolean),
    )
  expect(order.indexOf('headings')).toBeLessThan(order.indexOf('bold'))
  expect(order.indexOf('bold')).toBeLessThan(order.indexOf('emoji'))
})

test('keeps Emoji, Undo, and Redo as direct primary controls at supported widths', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  for (const width of [1400, 800, 360, 180]) {
    await page.setViewportSize({ width, height: 700 })
    const primary = () =>
      page.locator('.vditor-toolbar').evaluate((toolbar) => {
        const bounds = (button: HTMLElement) => {
          const rect = button.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
        }
        const result = ['emoji', 'undo', 'redo'].map((name) => {
          const button = toolbar.querySelector<HTMLElement>(
            `:scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${name}"]`,
          )
          return {
            name,
            direct: Boolean(button),
            inMore: Boolean(
              toolbar.querySelector(
                `.vmde-toolbar-more .vditor-toolbar__item[data-vmde-overflow="true"] [data-type="${name}"]`,
              ),
            ),
            bounds: button ? bounds(button) : null,
          }
        })
        const toolbarRect = toolbar.getBoundingClientRect()
        return { result, toolbarRect }
      })
    await expect.poll(primary).toMatchObject({
      result: [
        { name: 'emoji', direct: true, inMore: false },
        { name: 'undo', direct: true, inMore: false },
        { name: 'redo', direct: true, inMore: false },
      ],
    })
    const { result, toolbarRect } = await primary()
    for (const control of result) {
      expect(control.bounds).not.toBeNull()
      expect(control.bounds!.left).toBeGreaterThanOrEqual(toolbarRect.left)
      expect(control.bounds!.right).toBeLessThanOrEqual(toolbarRect.right)
    }
  }
})

test('keeps two unclipped row bands through narrow widths, zoom, and row-boundary keyboard navigation', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const geometry = () =>
    page.evaluate(() => {
      const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
      const rect = (element: Element) => {
        const box = (element as HTMLElement).getBoundingClientRect()
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        }
      }
      const rows = Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
      ).map((row) => ({
        rect: rect(row),
        controls: Array.from(
          row.querySelectorAll<HTMLElement>(
            ':scope > .vditor-toolbar__item > [data-type]',
          ),
        )
          .filter((button) => getComputedStyle(button).display !== 'none')
          .map((button) => ({ name: button.dataset.type, rect: rect(button) })),
      }))
      const more = toolbar.querySelector<HTMLElement>(
        '.vmde-toolbar-more > [data-type="more"]',
      )
      return {
        toolbar: rect(toolbar),
        pageClientWidth: document.documentElement.clientWidth,
        pageScrollWidth: document.documentElement.scrollWidth,
        rows,
        more: more ? rect(more) : null,
      }
    })

  for (const width of [1400, 800, 360, 180]) {
    await page.setViewportSize({ width, height: 700 })
    await expect
      .poll(async () => {
        const current = await geometry()
        return (
          current.more !== null &&
          current.more.right <= current.toolbar.right &&
          current.pageScrollWidth <= current.pageClientWidth
        )
      })
      .toBe(true)
    const current = await geometry()
    expect(current.rows).toHaveLength(2)
    expect(current.rows[0].rect.bottom).toBeLessThanOrEqual(
      current.rows[1].rect.top,
    )
    // The closed More panel remains a descendant and can expand the toolbar's own scrollWidth
    // despite being out of normal flow. The user-facing contract is no horizontal PAGE scroll.
    expect(current.pageScrollWidth).toBeLessThanOrEqual(current.pageClientWidth)
    expect(current.more).not.toBeNull()
    expect(current.more!.left).toBeGreaterThanOrEqual(current.toolbar.left)
    expect(current.more!.right).toBeLessThanOrEqual(current.toolbar.right)
    for (const row of current.rows) {
      for (let index = 1; index < row.controls.length; index++) {
        expect(row.controls[index - 1].rect.right).toBeLessThanOrEqual(
          row.controls[index].rect.left,
        )
      }
      expect(new Set(row.controls.map((control) => control.name)).size).toBe(
        row.controls.length,
      )
    }
  }

  await page.setViewportSize({ width: 360, height: 700 })
  await page.evaluate(() => {
    ;(document.querySelector('.vditor-toolbar') as HTMLElement).style.fontSize =
      '28px'
  })
  await expect
    .poll(async () => {
      const current = await geometry()
      return (
        current.more !== null &&
        current.more.right <= current.toolbar.right &&
        current.pageScrollWidth <= current.pageClientWidth
      )
    })
    .toBe(true)
  const zoomed = await geometry()
  expect(zoomed.rows).toHaveLength(2)
  expect(zoomed.pageScrollWidth).toBeLessThanOrEqual(zoomed.pageClientWidth)
  expect(zoomed.more!.right).toBeLessThanOrEqual(zoomed.toolbar.right)

  await page.evaluate(() => {
    ;(document.querySelector('.vditor-toolbar') as HTMLElement).style.fontSize =
      ''
  })
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.locator('[data-type="emoji"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('list')
  await page.locator('[data-type="more"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('headings')
})

// Task 504 regression: an open `more` menu is STALE once the overflow set changes — a widen
// returns items to the row, so an open menu shows a layout that no longer exists (the returned
// items vanish from it). The overflow pass must close it so the next click re-opens a menu that
// matches the row. Before this fix the panel was left open across the widen and the second click
// on `more` CLOSED it (Vditor's toggle) instead of reopening it — the toolbar-overflow.spec.ts
// (real VS Code) line-144 flake.
test('closes the more panel when overflow changes, and reopens on the next click', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 360, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0, { timeout: 5_000 })

  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')

  // first click opens the panel
  await moreButton.click()
  await expect(panel).toBeVisible()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')

  // widen → items return to the row → the open panel is stale → the overflow pass closes it
  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  await expect(panel).toBeHidden()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')

  // second click reopens the (now-consistent) menu
  await moreButton.click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-type="settings"]')).toHaveText('Settings')
})

// Task 504 extension: the same stale-open rule covers the OTHER submenu triggers
// (emoji/headings/edit-mode, toolbar-submenu-aria.ts). An open panel must not survive an overflow
// change — it would travel with its item into or out of `more`. Reproduced here with emoji: its
// nested picker is opened INSIDE the more menu, then a widen returns emoji to the row; the picker
// must be closed (not carried back to the row still open).
test('closes an open edit-mode submenu when the overflow set changes', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const editModeItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(editModeItem).toHaveCount(1)

  // Edit mode is movable while Emoji remains direct; open its nested menu inside More.
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const morePanel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(morePanel).toBeVisible()
  await editModeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const nested = editModeItem.locator('.vditor-hint')
  await expect(nested).toBeVisible()

  // Widen → Edit mode returns to the row → the open panel must close.
  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  // Edit mode is back in the row; its panel must not travel open.
  const nestedInRow = page.locator(
    '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="edit-mode"]) .vditor-hint',
  )
  await expect(nestedInRow).toBeHidden()
  await expect(page.locator('[data-type="edit-mode"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.locator('[data-type="edit-mode"]').click()
  await expect(nestedInRow).toBeVisible()
  expect(await nestedInRow.evaluate((panel) => panel.style.position)).not.toBe(
    'fixed',
  )
})

test('sweeps widths monotonically and holds steady on a threshold', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const overflowCount = () =>
    page.locator('[data-vmde-overflow="true"]').count()

  // Narrowing must never put an item BACK in the row (and widening never take one away): a
  // non-monotonic step is the signature of deciding against a width measured inside the panel.
  const counts: number[] = []
  const total = await page.locator('.vditor-toolbar__item').count()
  for (const width of [1400, 1100, 900, 700, 560, 460, 380, 260, 180]) {
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(150)
    counts.push(await overflowCount())
    // `more` is the only route to everything else, so it must survive every width…
    await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
    // …and nothing may be lost on the way: every item is either in the row or in the menu.
    const inRow = await page
      .locator('.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item')
      .count()
    expect(inRow + counts[counts.length - 1]).toBe(total)
  }
  for (let i = 1; i < counts.length; i++)
    expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])

  // Holding one width produces no further moves — the hysteresis band must absorb a width that
  // lands exactly on a give-way threshold.
  await page.setViewportSize({ width: 700, height: 700 })
  await page.waitForTimeout(200)
  const settled = await overflowCount()
  await page.waitForTimeout(600)
  expect(await overflowCount()).toBe(settled)
})

test('overflowed rows are labelled once and reachable by keyboard', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 180, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]:has([data-type="headings"])',
    ),
  ).toHaveCount(1)

  // The panel is display:none until opened, so its rows only enter the a11y tree (and become
  // focusable) once `more` is triggered — from the keyboard, via the focused button.
  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')
  await moreButton.focus()
  await page.keyboard.press('Enter')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(panel).toBeVisible()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')
  await expect(moreButton).toHaveAttribute('aria-haspopup', 'menu')

  // F5's open question: the row label is CSS generated content (`::after { content: attr(aria-label) }`)
  // on a button that already carries that aria-label. aria-label wins the accessible-name computation
  // outright, so the row is announced ONCE — asserted here rather than assumed.
  //
  // Assert that on the accessible NAME, not on raw occurrences of the string: an aria snapshot prints a
  // node's name (`- button "…"`) AND its child text nodes separately, and the visible label IS a child
  // text node (the ::after). Counting the bare string therefore always reads 2 and says nothing about
  // how often the row is announced. The second assertion pins the other half of the same property —
  // visible text identical to the accessible name, i.e. WCAG 2.5.3 Label in Name.
  const headingsLabel = await page
    .locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item [data-type="headings"]',
    )
    .getAttribute('aria-label')
  const snapshot = await panel.ariaSnapshot()
  const escaped = (headingsLabel ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  expect(
    snapshot.match(new RegExp(`- button "${escaped}"`, 'g'))?.length ?? 0,
    'the row carries the label as its accessible name exactly once',
  ).toBe(1)
  expect(
    snapshot.match(new RegExp(`- text: ${escaped}`, 'g'))?.length ?? 0,
    'the visible label matches the accessible name (WCAG 2.5.3)',
  ).toBe(1)

  // Arrow keys walk the menu rows the same way they walk the row (H-subset of task 492).
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))
  await page
    .locator('.vmde-toolbar-more > .vditor-hint > * > button')
    .first()
    .focus()
  const first = await focusedType()
  await page.keyboard.press('ArrowDown')
  const second = await focusedType()
  expect(second).not.toBe(first)
  await page.keyboard.press('End')
  const last = await focusedType()
  expect(last).not.toBe(second)
  await page.keyboard.press('Home')
  expect(await focusedType()).toBe(first)
})

test('row-two navigation actions give way in the decided order', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const rowNames = () =>
    page
      .locator('.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item')
      .evaluateAll((items) =>
        items
          .map((item) =>
            item
              .querySelector(':scope > [data-type]')
              ?.getAttribute('data-type'),
          )
          .filter(Boolean),
      )

  // The second row yields navigation actions last, while More remains the one route to the groups
  // already moved out of either row.
  const survivors: string[][] = []
  for (const width of [420, 300, 220, 160]) {
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(200)
    survivors.push(await rowNames())
    await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
  }

  for (const names of survivors) expect(names).toContain('more')
  // Any navigation item still in the row implies every later one in the give-way order is too.
  for (const names of survivors) {
    if (names.includes('edit-in-vscode')) {
      expect(names).toContain('preview')
      expect(names).toContain('edit-mode')
    }
    if (names.includes('preview')) expect(names).toContain('edit-mode')
  }
  // The narrowest width sheds at least one action — otherwise this test proves nothing.
  expect(survivors[survivors.length - 1].length).toBeLessThan(
    survivors[0].length,
  )
})

test('a movable edit-mode panel opens inside More without a stray arrow', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const editModeItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(editModeItem).toHaveCount(1)

  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  await expect(page.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  // The nested panel is a .vditor-panel, which Vditor's own `.vditor-hint .vditor-hint` flyout rule
  // does NOT cover — F4. Our added rule has to place it, and the `--arrow` must be gone (Vditor
  // drops that class for genuine level-2 items).
  expect(await editModeItem.locator('.vditor-panel--arrow').count()).toBe(0)

  await editModeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const nested = editModeItem.locator('.vditor-hint')
  await expect(nested).toBeVisible()
  const box = await nested.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  // Flown out to a real on-screen position, not stacked at 0/0 or pushed off the edge.
  expect(box?.width ?? 0).toBeGreaterThan(0)
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    (viewport?.width ?? 0) + 1,
  )
})

test('a nested edit-mode hint inside More stays reachable at the viewport edge', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 180 })

  const more = page.locator('.vmde-toolbar-more')
  await more.locator('[data-type="more"]').click()
  const modeItem = more.locator(
    '.vditor-hint > .vditor-toolbar__item:has([data-type="edit-mode"])',
  )
  await expect(modeItem).toHaveCount(1)
  await modeItem.locator('[data-type="edit-mode"]').focus()
  await page.keyboard.press('Enter')
  const modePanel = modeItem.locator('.vditor-hint')
  await expect(modePanel).toBeVisible()
  const box = await modePanel.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    viewport?.width ?? 0,
  )
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    viewport?.height ?? 0,
  )

  await page.setViewportSize({ width: 1400, height: 700 })
  const topLevelMode = page.locator(
    '.vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="edit-mode"])',
  )
  await expect(topLevelMode).toHaveCount(1)
  await topLevelMode.locator('[data-type="edit-mode"]').click()
  const topLevelPanel = topLevelMode.locator(':scope > .vditor-hint')
  await expect(topLevelPanel).toBeVisible()
  expect(
    await topLevelPanel.evaluate((panel) => panel.style.position),
  ).not.toBe('fixed')
})

test('toolbar labels, redo shortcut, and custom icons stay usable', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  await expect(page.locator('[data-type="line"]')).toHaveAttribute(
    'aria-label',
    /Horizontal Rule/,
  )
  await expect(page.locator('[data-type="ordered-list"]')).toHaveAttribute(
    'aria-label',
    /Numbered List/,
  )
  await expect(page.locator('[data-type="redo"]')).toHaveAttribute(
    'aria-label',
    /Shift\+Ctrl\/Cmd\+Z/,
  )

  const customIconSizes = await page
    .locator('[data-type="edit-in-vscode"] svg')
    .evaluate((svg) => ({
      width: (svg as SVGElement).getBoundingClientRect().width,
      height: (svg as SVGElement).getBoundingClientRect().height,
    }))
  expect(customIconSizes).toEqual({ width: 16, height: 16 })

  await page.locator('[data-type="more"]').click()
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-type="settings"]')).toHaveText('Settings')
  await expect(panel.locator('[data-type="info"]')).toHaveText('About Vditor')
  await expect(panel.locator('[data-type="about"]')).toHaveText('About VMDE')
})

// Task 492 Phase 5: aria-haspopup/aria-expanded + menu semantics for the toolbar's other three
// submenu triggers (emoji/headings/edit-mode) — the H-subset above only covers `more`.
test('emoji/headings/edit-mode triggers advertise their popup and expose menu semantics', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })

  for (const name of ['emoji', 'headings', 'edit-mode']) {
    const button = page.locator(`[data-type="${name}"]`)
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  }

  // headings: a plain vditor-hint panel, rows are direct <button>s.
  await page.locator('[data-type="headings"]').click()
  await expect(page.locator('[data-type="headings"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const headingsPanel = page.locator(
    '.vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(headingsPanel).toHaveAttribute('role', 'menu')
  await expect(headingsPanel.locator('[data-tag="h1"]')).toHaveAttribute(
    'role',
    'menuitem',
  )
  // Headings.ts (unlike Emoji's toggleSubMenu) has no "second click closes it" branch — it only
  // closes via hidePanel(subToolbar) when a DIFFERENT subToolbar panel opens, or a row is picked.
  // Verify aria-expanded still mirrors that close path rather than assuming a toggle that isn't
  // there: opening `emoji` closes `headings` behind it (Headings.ts:51 / Emoji's own
  // hidePanel(subToolbar,hint,popover) call).
  await page.locator('[data-type="emoji"]').click()
  await expect(page.locator('[data-type="headings"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  // emoji: role=menu goes on the nested .vditor-emojis grid, not the outer arrow panel (the
  // tail tip/link beside it is not a menu row).
  await expect(page.locator('[data-type="emoji"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const emojiItem = page.locator(
    '.vditor-toolbar__item:has(> [data-type="emoji"])',
  )
  await expect(emojiItem.locator('.vditor-emojis')).toHaveAttribute(
    'role',
    'menu',
  )
  await expect(emojiItem.locator('.vditor-panel')).not.toHaveAttribute(
    'role',
    'menu',
  )
  const emojiButtons = emojiItem.locator('.vditor-emojis > button')
  await expect(emojiButtons.first()).toHaveAttribute('role', 'menuitem')

  // emoji DOES use toggleSubMenu (Emoji.ts), so a second click on its own trigger closes it —
  // asserted as the contrasting case to headings above.
  await page.locator('[data-type="emoji"]').click()
  await expect(page.locator('[data-type="emoji"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.locator('[data-type="emoji"]').click()

  // Arrow/Home/End walk the emoji grid the same way they walk `more`'s rows (down/right ≡ +1).
  const focusedKey = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-key'))
  await emojiButtons.first().focus()
  const first = await focusedKey()
  await page.keyboard.press('ArrowDown')
  expect(await focusedKey()).not.toBe(first)
  await page.keyboard.press('End')
  const last = await focusedKey()
  await page.keyboard.press('Home')
  expect(await focusedKey()).toBe(first)
  expect(last).not.toBe(first)
})

// Task 492 Phase 5, Part B: `upload` is now a real <button> (MenuItem.ts's div exception dropped
// via the build-time patch, esbuild-shared.mjs patchUploadTagName) with the `<input type=file>`
// moved to a hidden sibling (patchUploadHiddenInput) instead of nested inside it.
test('upload is a semantic button that still opens a file picker, and disabled state still blocks it', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  const uploadButton = page.locator('[data-type="upload"]')
  await expect(uploadButton).toHaveJSProperty('tagName', 'BUTTON')
  // The file input must NOT be a descendant of the button (that would be invalid nesting and,
  // via input.click()'s bubbling synthetic click, an infinite re-entrant loop into this same
  // listener — see patchUploadHiddenInput's comment in esbuild-shared.mjs).
  await expect(uploadButton.locator('input[type="file"]')).toHaveCount(0)
  const hiddenInput = page.locator(
    '.vditor-toolbar__item:has(> [data-type="upload"]) > input[type="file"]',
  )
  await expect(hiddenInput).toHaveCount(1)
  await expect(hiddenInput).toBeHidden()
  await expect(hiddenInput).toHaveJSProperty('tabIndex', -1)

  const chooserPromise = page.waitForEvent('filechooser')
  await uploadButton.click()
  const chooser = await chooserPromise
  expect(chooser).toBeTruthy()

  // The disabled guard (Upload.ts's own CLASS_MENU_DISABLED check) must still block the click —
  // moving the input out must not have bypassed it.
  await page.evaluate(() => {
    document
      .querySelector('[data-type="upload"]')
      ?.classList.add('vditor-menu--disabled')
  })
  let secondChooserFired = false
  page.once('filechooser', () => {
    secondChooserFired = true
  })
  await uploadButton.click()
  await page.waitForTimeout(200)
  expect(secondChooserFired).toBe(false)
})
