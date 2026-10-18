import { expect, test } from './coverage-fixture'

type Page = import('@playwright/test').Page

// Task 642: one ordered sequence (wiki on); `|` marks a group boundary. The flow pass distributes
// it into rows by width, so there is no fixed row split any more.
const OWNER_SEQUENCE = [
  'undo',
  'redo',
  '|',
  'headings',
  '|',
  'bold',
  'italic',
  'underline',
  'strike',
  'inline-code',
  '|',
  'subscript',
  'superscript',
  '|',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  '|',
  'outdent',
  'indent',
  '|',
  'quote',
  'callout',
  'details',
  'code',
  'math',
  'table',
  'line',
  '|',
  'upload',
  'emoji',
  '|',
  'insert-before',
  'insert-after',
  '|',
  'outline',
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'preview',
  'edit-mode',
  'more',
]
const TAIL = ['preview', 'edit-mode', 'more']
const TOGGLE = 'collapse-toolbar'

const sequenceFor = (wikiEnabled: boolean) => {
  if (wikiEnabled) return OWNER_SEQUENCE
  const from = OWNER_SEQUENCE.indexOf('navigate-back')
  return [
    ...OWNER_SEQUENCE.slice(0, from),
    ...OWNER_SEQUENCE.slice(OWNER_SEQUENCE.indexOf('edit-in-vscode')),
  ]
}
const controlsOf = (sequence: readonly string[]) =>
  sequence.filter((name) => name !== '|')
// Group number of each control: the count of rules before it.
const groupsOf = (sequence: readonly string[]) => {
  const groups = new Map<string, number>()
  let group = 0
  for (const name of sequence) {
    if (name === '|') group++
    else groups.set(name, group)
  }
  return groups
}

interface Layout {
  rows: string[][]
  more: string[]
}

/** The visible tokens of each row (a hidden row reads empty) and the controls held by More. */
const readLayout = (page: Page): Promise<Layout> =>
  page.locator('.vditor-toolbar').evaluate((toolbar) => {
    const token = (child: Element) =>
      child.classList.contains('vditor-toolbar__divider')
        ? '|'
        : (child
            .querySelector(':scope > [data-type]')
            ?.getAttribute('data-type') ?? '')
    const rows = Array.from(
      toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    ).map((row) =>
      getComputedStyle(row).display === 'none'
        ? []
        : Array.from(row.children)
            .filter((child) => getComputedStyle(child).display !== 'none')
            .map(token),
    )
    const more = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
      ),
    ).map((button) => button.getAttribute('data-type') ?? '')
    return { rows, more }
  })

/** The flow contract for any width: every control once, a body prefix in the rows and the rest in
 *  More in sequence order, the tail last in the last row, and a rule only between two placed
 *  controls of different groups. */
const expectFlowContract = (
  layout: Layout,
  sequence: readonly string[],
  label = '',
) => {
  const controls = controlsOf(sequence)
  const groups = groupsOf(sequence)
  const rowControls = layout.rows.map((row) =>
    row.filter((name) => name !== '|' && name !== TOGGLE),
  )
  const placed = rowControls.flat()
  expect(
    [...placed, ...layout.more].sort(),
    `${label} every control once`,
  ).toEqual([...controls].sort())
  const body = controls.filter((name) => !TAIL.includes(name))
  const placedBody = placed.filter((name) => !TAIL.includes(name))
  expect(placedBody, `${label} placed body is a prefix`).toEqual(
    body.slice(0, placedBody.length),
  )
  expect(layout.more, `${label} More holds the rest in order`).toEqual(
    body.slice(placedBody.length),
  )
  const used = rowControls.filter((row) => row.length > 0)
  expect(used.at(-1)?.slice(-3), `${label} tail ends the last row`).toEqual(
    TAIL,
  )
  for (const row of layout.rows) {
    const tokens = row.filter((name) => name !== TOGGLE)
    if (tokens.length === 0) continue
    expect(tokens[0], `${label} row starts with a control`).not.toBe('|')
    expect(tokens.at(-1), `${label} row ends with a control`).not.toBe('|')
    tokens.forEach((name, index) => {
      if (name === '|') {
        const before = tokens[index - 1]
        const after = tokens[index + 1]
        expect(groups.get(before), `${label} rule between groups`).not.toBe(
          groups.get(after),
        )
      } else if (index > 0 && tokens[index - 1] !== '|') {
        expect(groups.get(tokens[index - 1]), `${label} missing rule`).toBe(
          groups.get(name),
        )
      }
    })
  }
}

test('flows one ordered sequence: one row when wide, Math in More when narrow, restored when wide again (A1, A2, A3, A9)', async ({
  page,
}) => {
  const readControls = () =>
    page.locator('.vditor-toolbar').evaluate((toolbar) =>
      Array.from(
        toolbar.querySelectorAll<HTMLElement>(
          ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type], .vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
        ),
      )
        .map((button) => button.getAttribute('data-type') ?? '')
        .sort(),
    )

  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width: 1400, height: 700 })

    const sequence = sequenceFor(wikiEnabled)
    const expectedControls = [...controlsOf(sequence), TOGGLE].sort()

    // Wide: the whole sequence is one row, the toggle last, and row two is not shown.
    await expect
      .poll(() => readLayout(page))
      .toEqual({ rows: [[...sequence, TOGGLE], []], more: [] })
    expect(await readControls()).toEqual(expectedControls)

    const rowMath = page.locator(
      '.vmde-toolbar-row[data-vmde-toolbar-row="1"] > .vditor-toolbar__item > [data-type="math"]',
    )
    await expect(rowMath).toBeVisible()
    const rowIcon = rowMath.locator(':scope > svg')
    await expect(rowIcon).toHaveAttribute('width', '16')
    await expect(rowIcon).toHaveAttribute('height', '16')
    await expect(rowIcon.locator('path')).toHaveAttribute(
      'fill',
      'currentColor',
    )

    await page.setViewportSize({ width: 80, height: 700 })
    const mathInMore = page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type="math"]',
    )
    await expect(mathInMore).toHaveCount(1)
    await expect(page.locator('.vmde-toolbar-more')).toBeVisible()
    expectFlowContract(await readLayout(page), sequence, `wiki ${wikiEnabled}`)
    expect(await readControls()).toEqual(expectedControls)

    const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
    await moreButton.focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).not.toBeVisible()
    // Escape exits the toolbar and restores the editor focus, as defined by escape-toolbar.ts.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('.vditor-ir')),
        ),
      )
      .toBe(true)

    await page.setViewportSize({ width: 1400, height: 700 })
    await expect(
      page.locator(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
      ),
    ).toHaveCount(0)
    await expect
      .poll(() => readLayout(page))
      .toEqual({ rows: [[...sequence, TOGGLE], []], more: [] })
  }
})

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

test('keeps Preview, Edit Mode and More direct and inside the toolbar at every width, with Undo and Redo leaving last (A3)', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)

  for (const width of [1400, 800, 360, 180, 80]) {
    await page.setViewportSize({ width, height: 700 })
    const placed = () =>
      page.locator('.vditor-toolbar').evaluate((toolbar) => {
        const toolbarRect = toolbar.getBoundingClientRect()
        const result = ['undo', 'redo', 'preview', 'edit-mode', 'more'].map(
          (name) => {
            const button = toolbar.querySelector<HTMLElement>(
              `:scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${name}"]`,
            )
            const rect = button?.getBoundingClientRect()
            return {
              name,
              direct: Boolean(button),
              inside:
                rect !== undefined &&
                rect.left >= toolbarRect.left &&
                rect.right <= toolbarRect.right,
            }
          },
        )
        return result
      })
    // Below 180 px the tail alone is wider than the row: it stays placed (direct) and may extend
    // past the toolbar's edge, which is clipped, as the planner contract states.
    await expect
      .poll(async () =>
        (await placed())
          .filter((control) =>
            ['preview', 'edit-mode', 'more'].includes(control.name),
          )
          .map(({ name, direct, inside }) => ({
            name,
            direct,
            inside: width >= 180 ? inside : true,
          })),
      )
      .toEqual([
        { name: 'preview', direct: true, inside: true },
        { name: 'edit-mode', direct: true, inside: true },
        { name: 'more', direct: true, inside: true },
      ])
    if (width >= 360) {
      // Undo and Redo lead the sequence, so they are the last controls to leave.
      expect(
        (await placed()).filter((control) =>
          ['undo', 'redo'].includes(control.name),
        ),
      ).toEqual([
        { name: 'undo', direct: true, inside: true },
        { name: 'redo', direct: true, inside: true },
      ])
    }
  }
})

test('keeps unclipped row bands through narrow widths and zoom, with row-end keyboard navigation (A5)', async ({
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
    // Row two is empty and hidden while one row holds the sequence.
    if (current.rows[1].controls.length > 0)
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
  // Emoji sits at the end of the Upload/Emoji group; the next stop is Insert Before.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('insert-before')
  await page.locator('[data-type="more"]').focus()
  await page.keyboard.press('ArrowRight')
  // More ends the sequence; the toggle follows, then the roving order wraps to Undo.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('collapse-toolbar')
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.dataset.type))
    .toBe('undo')
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
test('closes an open math submenu when the plan changes (More and back to the row) (A3, edge case)', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const submenuItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="math"])',
  )
  await expect(submenuItem).toHaveCount(1)

  // Math moves into More; open its nested menu there.
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const morePanel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(morePanel).toBeVisible()
  await submenuItem.locator('[data-type="math"]').focus()
  await page.keyboard.press('Enter')
  const nested = submenuItem.locator('.vditor-hint')
  await expect(nested).toBeVisible()

  // Widen → Math returns to the row → the open panel must close.
  await page.setViewportSize({ width: 1400, height: 700 })
  await expect(
    page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).toHaveCount(0, { timeout: 5_000 })
  // Math is back in the row; its panel must not travel open.
  const nestedInRow = page.locator(
    '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="math"]) .vditor-hint',
  )
  await expect(nestedInRow).toBeHidden()
  await expect(page.locator('[data-type="math"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.locator('[data-type="math"]').click()
  await expect(nestedInRow).toBeVisible()
  expect(await nestedInRow.evaluate((panel) => panel.style.position)).not.toBe(
    'fixed',
  )
})

test('Insert anchor is keyboard-operated from More, returns focus on Cancel/Escape, and is blocked in Preview', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('before target')
    const text = outer.vditor.ir.element.querySelector('p')!.firstChild!
    const range = document.createRange()
    range.setStart(text, 'before '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    outer.vditor.ir.range = range.cloneRange()
  })
  const more = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const anchorAction = page.locator('[data-type="insert-anchor"]')
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  await expect(dialog).toBeVisible()
  await dialog.locator('input').fill('cancelled')
  await dialog.locator('[data-vmde-anchor-cancel]').click()
  await expect(dialog).toBeHidden()
  await expect(more).toBeFocused()

  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(more).toBeFocused()

  await page.locator('[data-type="preview"]').click()
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
})

test('Insert anchor inspects an existing target without exposing a rename action', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('<a name="custom"></a>')
    const marker = outer.vditor.ir.element.firstElementChild!
    const range = document.createRange()
    range.selectNodeContents(marker)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    outer.vditor.ir.range = range.cloneRange()
  })
  const more = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const anchorAction = page.locator('[data-type="insert-anchor"]')
  await more.focus()
  await page.keyboard.press('Enter')
  await anchorAction.focus()
  await page.keyboard.press('Enter')
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  const input = dialog.locator('input')
  await expect(input).toHaveValue('custom')
  await expect(input).toHaveAttribute('readonly', '')
  await expect(dialog).toContainText('Incoming links are unchanged.')
  await expect(dialog.locator('button[type="submit"]')).toHaveCount(0)
  await dialog.locator('[data-vmde-anchor-cancel]').click()
})

test('Insert anchor retains a WYSIWYG repeated-prefix caret through a More pointer journey', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    outer.setValue('prefix target prefix target prefix target')
    document.querySelector<HTMLElement>('[data-type="edit-mode"]')?.click()
    document.querySelector<HTMLElement>('button[data-mode="wysiwyg"]')?.click()
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const text = root.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'prefix target prefix '.length)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('.vditor-toolbar [data-type="more"]').click()
  await page.locator('[data-type="insert-anchor"]').click()
  const dialog = page.locator('[data-vmde-anchor-dialog]')
  await dialog.locator('input').fill('wys-repeat')
  await dialog.locator('button[type="submit"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(
      'prefix target prefix <a name="wys-repeat"></a>target prefix target\n',
    )
})

test('an overflowed Math submenu keeps keyboard navigation inside its innermost panel', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  // Math sits in the structural group of row two, which gives way after Upload and the Insert
  // pair; it is still in the row at 360 px and in More at 300 px.
  await page.setViewportSize({ width: 300, height: 700 })
  const mathItem = page.locator(
    '.vmde-toolbar-more .vditor-toolbar__item:has(> [data-type="math"])',
  )
  await expect(mathItem).toHaveCount(1)
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  await expect(page.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  await mathItem.locator('[data-type="math"]').focus()
  await page.keyboard.press('Enter')
  const action = mathItem.locator('[data-type="math-inline-github"]')
  await expect(action).toBeVisible()
  await action.focus()
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.dataset.type)
  // Arrow keys wrap between the two rows of the Math panel itself; focus never leaves it for a
  // More row.
  await page.keyboard.press('ArrowDown')
  await expect.poll(focusedType).toBe('math-block')
  await page.keyboard.press('ArrowDown')
  await expect.poll(focusedType).toBe('math-inline-github')
  await page.keyboard.press('End')
  await expect.poll(focusedType).toBe('math-block')
  await page.keyboard.press('Home')
  await expect.poll(focusedType).toBe('math-inline-github')
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
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]:has([data-type="bold"])',
    ),
  ).toHaveCount(1)
  // Undo leads the sequence, so it is the last control to leave and is still direct at 180 px.
  await expect(
    page.locator(
      '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="undo"]',
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
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item [data-type="bold"]',
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

interface Sizes {
  widths: Record<string, number>
  separator: number
}

/** A row's width: its controls plus a rule's width and margins for each `|`. */
const rowWidthOf = (row: readonly string[], sizes: Sizes) =>
  row.reduce(
    (sum, token) =>
      sum +
      (token === '|'
        ? sizes.separator
        : token === TOGGLE
          ? 0
          : sizes.widths[token]),
    0,
  )

/** Every placed row fits its capacity (unless the tail alone is wider), and a first row that has
 *  a second row after it is maximal: the unit that starts row two would not also fit in row one. */
const expectRowsFit = (
  layout: Layout,
  sizes: Sizes,
  groups: Map<string, number>,
  capacity: number,
) => {
  for (const row of layout.rows) {
    const content = row.filter((token) => token !== TOGGLE)
    if (content.length > 3)
      expect(rowWidthOf(content, sizes)).toBeLessThanOrEqual(capacity)
  }
  if (layout.rows[1].length === 0) return
  const first = layout.rows[0].filter((token) => token !== TOGGLE)
  const next = layout.rows[1][0]
  const last = first.filter((token) => token !== '|').at(-1) as string
  const joiner = groups.get(last) === groups.get(next) ? 0 : sizes.separator
  // The tail moves as one unit, so when row two starts with it the whole tail is the next unit.
  const unit = TAIL.includes(next)
    ? TAIL.reduce((sum, name) => sum + sizes.widths[name], 0)
    : sizes.widths[next]
  expect(rowWidthOf(first, sizes) + joiner + unit).toBeGreaterThan(capacity)
}

// A2, A3: at each width the rows hold the longest prefix of the sequence that fits, row two starts
// with the next control, and the rest sits in More with the tail last. Control widths are read once
// from the one-row layout, so the fit is checked against measurements, not against the planner.
test('the rows hold the longest prefix of the sequence that fits at each width (A2, A3)', async ({
  page,
}) => {
  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width: 1400, height: 700 })
    const sequence = sequenceFor(wikiEnabled)
    const groups = groupsOf(sequence)
    await expect.poll(async () => (await readLayout(page)).more.length).toBe(0)
    const sizes = await page.locator('.vditor-toolbar').evaluate((toolbar) => {
      const widths: Record<string, number> = {}
      for (const wrapper of toolbar.querySelectorAll<HTMLElement>(
        '.vmde-toolbar-row > .vditor-toolbar__item',
      )) {
        const name = wrapper
          .querySelector(':scope > [data-type]')
          ?.getAttribute('data-type')
        if (name)
          widths[name] = Math.ceil(wrapper.getBoundingClientRect().width)
      }
      const divider = toolbar.querySelector<HTMLElement>(
        '.vmde-toolbar-row > .vditor-toolbar__divider',
      ) as HTMLElement
      const style = getComputedStyle(divider)
      const separator = Math.ceil(
        divider.getBoundingClientRect().width +
          Number.parseFloat(style.marginLeft) +
          Number.parseFloat(style.marginRight),
      )
      return { widths, separator }
    })
    const survivors: Layout[] = []
    for (const width of [
      1400, 1100, 900, 700, 560, 420, 330, 260, 200, 150, 80,
    ]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(200)
      const layout = await readLayout(page)
      survivors.push(layout)
      expectFlowContract(layout, sequence, `w${width} wiki ${wikiEnabled}`)
      const capacity = await page.evaluate(() => {
        const row = document.querySelector(
          '.vmde-toolbar-row[data-vmde-toolbar-row="1"]',
        ) as HTMLElement
        const toggle = document.querySelector(
          '.vditor-toolbar [data-type="collapse-toolbar"]',
        )?.parentElement as HTMLElement
        return Math.floor(
          row.getBoundingClientRect().width -
            toggle.getBoundingClientRect().width,
        )
      })
      expectRowsFit(layout, sizes, groups, capacity)
    }
    // The widest width keeps everything in one row; the narrowest has moved most controls into More.
    expect(survivors[0].more).toEqual([])
    expect(survivors[0].rows[1]).toEqual([])
    expect(survivors.at(-1)?.more).toContain('quote')
    // Undo is the first control, so it is the last to leave.
    expect(survivors.at(-2)?.rows[0]).toContain('undo')
  }
})

test('a movable math panel opens inside More without a stray arrow', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 700 })
  const submenuItem = page.locator(
    '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item:has([data-type="math"])',
  )
  await expect(submenuItem).toHaveCount(1)

  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  await expect(page.locator('.vmde-toolbar-more > .vditor-hint')).toBeVisible()
  // The nested panel is a .vditor-panel, which Vditor's own `.vditor-hint .vditor-hint` flyout rule
  // does NOT cover — F4. Our added rule has to place it, and the `--arrow` must be gone (Vditor
  // drops that class for genuine level-2 items).
  expect(await submenuItem.locator('.vditor-panel--arrow').count()).toBe(0)

  await submenuItem.locator('[data-type="math"]').focus()
  await page.keyboard.press('Enter')
  const nested = submenuItem.locator('.vditor-hint')
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

test('a nested math hint inside More stays reachable at the viewport edge', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 80, height: 180 })

  const more = page.locator('.vmde-toolbar-more')
  await more.locator('[data-type="more"]').click()
  const submenuItem = more.locator(
    '.vditor-hint > .vditor-toolbar__item:has([data-type="math"])',
  )
  await expect(submenuItem).toHaveCount(1)
  await submenuItem.locator('[data-type="math"]').focus()
  await page.keyboard.press('Enter')
  const submenuPanel = submenuItem.locator('.vditor-hint')
  await expect(submenuPanel).toBeVisible()
  const box = await submenuPanel.boundingBox()
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
  const topLevelSubmenu = page.locator(
    '.vmde-toolbar-row > .vditor-toolbar__item:has(> [data-type="math"])',
  )
  await expect(topLevelSubmenu).toHaveCount(1)
  await topLevelSubmenu.locator('[data-type="math"]').click()
  const topLevelPanel = topLevelSubmenu.locator(':scope > .vditor-hint')
  await expect(topLevelPanel).toBeVisible()
  expect(
    await topLevelPanel.evaluate((panel) => panel.style.position),
  ).not.toBe('fixed')
})

test('toolbar labels (names only) and custom icons stay usable', async ({
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
  // Task 580 CP3-2: names only, with no key.
  await expect(page.locator('[data-type="redo"]')).toHaveAttribute(
    'aria-label',
    'Redo',
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
// Emoji is an ordinary control of the flow: in a narrow toolbar it sits in More, so the picker is
// opened from its menu row. The helper opens More first when the trigger is not in a row.
const openEmojiPicker = async (page: Page) => {
  const trigger = page.locator('[data-type="emoji"]')
  const inMore = await trigger.evaluate((el) =>
    Boolean(el.closest('.vmde-toolbar-more > .vditor-hint')),
  )
  if (inMore) {
    // The VS Code webview gives the editor the full viewport height; the harness page is only as
    // tall as its one-line document, which would clip the long More menu.
    await page.addStyleTag({ content: '#app { min-height: 100vh; }' })
    const more = page.locator('.vmde-toolbar-more > [data-type="more"]')
    if (!(await page.locator('.vmde-toolbar-more > .vditor-hint').isVisible()))
      await more.click()
  }
  await trigger.click()
}

test('emoji owns a searchable dialog while headings and edit-mode keep menu semantics', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })

  for (const name of ['headings', 'edit-mode']) {
    const button = page.locator(`[data-type="${name}"]`)
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
  }
  const emoji = page.locator('[data-type="emoji"]')
  await expect(emoji).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')

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
  await emoji.click()

  const picker = page.locator('.vmde-emoji-picker')
  await expect(picker.locator('input[type="search"]')).toBeFocused()
  await expect(picker.locator('.vmde-emoji-picker__tile')).not.toHaveCount(0)
  await picker.locator('input[type="search"]').press('ArrowDown')
  await expect(picker.locator('.vmde-emoji-picker__tile').first()).toBeFocused()
  const firstTile = picker.locator('.vmde-emoji-picker__tile').first()
  await firstTile.press('ArrowRight')
  await expect(picker.locator('.vmde-emoji-picker__tile').nth(1)).toBeFocused()
  await firstTile.press('End')
  const keyboardScroll = await picker.evaluate((panel) => {
    const results = panel.querySelector(
      '.vmde-emoji-picker__results',
    ) as HTMLElement
    const focused = document.activeElement as HTMLElement
    const resultsBox = results.getBoundingClientRect()
    const focusedBox = focused.getBoundingClientRect()
    return {
      scrolled: results.scrollTop > 0,
      visible:
        focusedBox.top >= resultsBox.top &&
        focusedBox.bottom <= resultsBox.bottom,
    }
  })
  expect(keyboardScroll).toEqual({ scrolled: true, visible: true })
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await expect(picker.locator('.vmde-emoji-picker__tile')).toHaveCount(1)
  await picker.locator('input[type="search"]').press('Escape')
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')
})

test('emoji picker owns tile hover and clear interactions without Vditor panel handlers', async ({
  page,
}) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('.vmde-emoji-picker__tile').first().hover()
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.getByRole('button', { name: 'Clear emoji search' }).click()
  await expect(picker.locator('input[type="search"]')).toHaveValue('')
  expect(pageErrors).toEqual([])
})

test('emoji picker keeps transparent tiles and promotes successful selections to recents', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  const emoji = page.locator('[data-type="emoji"]')
  await emoji.click()
  const picker = page.locator('.vmde-emoji-picker')
  await expect(
    picker.getByRole('heading', { name: 'Recently used' }),
  ).toBeVisible()
  await expect(picker.getByText('No recently used emoji yet.')).toBeVisible()
  const catalogTile = picker
    .locator('[data-emoji-grid="catalog"] .vmde-emoji-picker__tile')
    .first()
  expect(
    await catalogTile.evaluate(
      (tile) => getComputedStyle(tile).backgroundColor,
    ),
  ).toBe('rgba(0, 0, 0, 0)')
  const selectedName = await catalogTile.getAttribute('aria-label')
  await page.evaluate(() => {
    ;(window as any).vscode = {
      postMessage: () => {
        throw new Error('storage unavailable')
      },
    }
  })
  await catalogTile.click()
  await emoji.click()
  const recentTile = picker
    .locator('[data-emoji-grid="recent"] .vmde-emoji-picker__tile')
    .first()
  await expect(recentTile).toHaveAttribute('aria-label', selectedName ?? '')
  expect(
    await recentTile.evaluate((tile) => getComputedStyle(tile).backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)')
  await picker.locator('input[type="search"]').press('ArrowDown')
  await expect(recentTile).toBeFocused()
  await recentTile.press('ArrowDown')
  await expect(
    picker
      .locator('[data-emoji-grid="catalog"] .vmde-emoji-picker__tile')
      .first(),
  ).toBeFocused()
  await picker.locator('input[type="search"]').fill('no-such-recent')
  await expect(
    picker.getByText('No matching recently used emoji.'),
  ).toBeVisible()
})

test('emoji picker updates its expanded state when an overflow reflow closes its panel', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const emoji = page.locator('[data-type="emoji"]')
  const picker = page.locator('.vmde-emoji-picker')
  await emoji.click()
  await expect(emoji).toHaveAttribute('aria-expanded', 'true')
  await page.setViewportSize({ width: 80, height: 700 })
  await expect(picker).toBeHidden()
  await expect(emoji).toHaveAttribute('aria-expanded', 'false')
})

test('emoji picker scrolls its categorized grid inside a narrow toolbar without page overflow', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 280, height: 700 })
  await openEmojiPicker(page)
  const picker = page.locator('.vmde-emoji-picker')
  const geometry = await picker.evaluate((panel) => {
    const results = panel.querySelector(
      '.vmde-emoji-picker__results',
    ) as HTMLElement
    const box = panel.getBoundingClientRect()
    results.scrollTop = results.scrollHeight
    return {
      clientWidth: document.documentElement.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      panelLeft: box.left,
      panelRight: box.right,
      resultsClientHeight: results.clientHeight,
      resultsScrollHeight: results.scrollHeight,
      resultsScrollTop: results.scrollTop,
    }
  })
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.panelLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.panelRight).toBeLessThanOrEqual(geometry.clientWidth)
  expect(geometry.resultsScrollHeight).toBeGreaterThan(
    geometry.resultsClientHeight,
  )
  expect(geometry.resultsScrollTop).toBeGreaterThan(0)
})

test('emoji picker retains its narrow viewport correction after closing and reopening', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 280, height: 700 })
  const trigger = page.locator('[data-type="emoji"]')
  const picker = page.locator('.vmde-emoji-picker')
  await openEmojiPicker(page)
  await picker.locator('input[type="search"]').press('Escape')
  await expect(trigger).toBeFocused()
  await openEmojiPicker(page)
  const bounds = await picker.evaluate((panel) => {
    const box = panel.getBoundingClientRect()
    return { left: box.left, right: box.right, width: innerWidth }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
})

test('emoji picker replaces a retained editor selection with one complete Unicode sequence', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    editor.focus()
    const text = editor.firstChild
    if (!text) throw new Error('editor text missing')
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('🫩\n')
  // Emoji selection follows Vditor's debounced render path; wait for its transaction to become
  // undoable instead of racing Ctrl+Z ahead of the mode-specific undo record.
  await expect(page.locator('[data-type="undo"]')).not.toHaveClass(
    /vditor-menu--disabled/,
  )
  await page.locator('[data-type="undo"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar overflow\n')
  await page.locator('[data-type="redo"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('🫩\n')
})

test('emoji picker preserves a Tab-captured bookmark when toolbar focus loses the live range', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('overflow'))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error('editor text missing')
    const start = text.data.indexOf('overflow')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'overflow'.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
  })
  const trigger = page.locator('[data-type="emoji"]')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  for (let step = 0; step < 32; step++) {
    if (await trigger.evaluate((button) => document.activeElement === button))
      break
    await page.keyboard.press('ArrowRight')
  }
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Space')
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar 🫩\n')
})

test('emoji picker commits the pointerdown source bookmark after later focus handlers rebuild the DOM', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(() => {
    const outer = (window as any).vditor
    const editor = outer.vditor.ir.element as HTMLElement
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let text = walker.nextNode() as Text | null
    while (text && !text.data.includes('overflow'))
      text = walker.nextNode() as Text | null
    if (!text) throw new Error('toolbar overflow source text missing')
    const start = text.data.indexOf('overflow')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'overflow'.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    document
      .querySelector<HTMLElement>('[data-type="emoji"]')!
      .addEventListener(
        'pointerdown',
        () => {
          const equivalent = editor.innerHTML
          editor.replaceChildren()
          editor.insertAdjacentHTML('afterbegin', equivalent)
          const reset = document.createRange()
          reset.setStart(editor, 0)
          reset.collapse(true)
          selection.removeAllRanges()
          selection.addRange(reset)
        },
        { once: true },
      )
  })

  await page.locator('[data-type="emoji"]').click()
  const picker = page.locator('.vmde-emoji-picker')
  await picker.locator('input[type="search"]').fill('bags under eyes')
  await picker.locator('.vmde-emoji-picker__tile').click()

  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe('toolbar 🫩\n')
})

for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`emoji picker keeps an exact one-step source transaction in ${mode}`, async ({
    page,
  }) => {
    await page.goto('/toolbar-overflow.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.evaluate((currentMode) => {
      const inner = (window as any).vditor.vditor
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector<HTMLElement>(`button[data-mode="${currentMode}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).vditor.vditor.currentMode),
      )
      .toBe(mode)
    const baseline = await page.evaluate(() =>
      (window as any).vditor.getValue(),
    )
    // This harness has no edit-sync adapter, so its raw SV getValue includes Vditor's terminal
    // caret line. Real host-byte coverage uses edit-sync's SV serializer and remains one newline.
    const inserted = mode === 'sv' ? '🫩\n\n' : '🫩\n'
    await page.evaluate(() => {
      const inner = (window as any).vditor.vditor
      const editor = inner[inner.currentMode].element as HTMLElement
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(editor)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await page.locator('[data-type="emoji"]').click()
    const picker = page.locator('.vmde-emoji-picker')
    await picker.locator('input[type="search"]').fill('bags under eyes')
    await picker.locator('.vmde-emoji-picker__tile').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(inserted)
    await page.locator('[data-type="undo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(baseline)
    await page.locator('[data-type="redo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toBe(inserted)
  })
}

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

const visibleRowTokens = async (page: Page) => (await readLayout(page)).rows

const expectNoStraySeparators = (rows: string[][]) => {
  expect(rows).toHaveLength(2)
  expect(rows.some((row) => row.length > 0)).toBe(true)
  for (const row of rows) {
    const tokens = row.filter((name) => name !== TOGGLE)
    if (tokens.length === 0) continue
    expect(tokens[0]).not.toBe('|')
    expect(tokens[tokens.length - 1]).not.toBe('|')
    for (let index = 1; index < tokens.length; index++)
      expect(tokens[index - 1] === '|' && tokens[index] === '|').toBe(false)
  }
}

const switchMode = async (
  page: import('@playwright/test').Page,
  mode: string,
) => {
  await page.evaluate((target) => {
    document.querySelector<HTMLElement>('[data-type="edit-mode"]')?.click()
    document
      .querySelector<HTMLElement>(`button[data-mode="${target}"]`)
      ?.click()
  }, mode)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe(mode)
}

test('Source mode and wiki-off flow hold no leading, trailing or doubled separators (A5)', async ({
  page,
}) => {
  // Vditor hides Outdent, Indent, Outline, Insert Before and Insert After in Source mode. A hidden
  // group leaves the plan, and its rules collapse with it.
  const hidden = new Set([
    'outdent',
    'indent',
    'outline',
    'insert-before',
    'insert-after',
  ])
  const svSequence = (wikiEnabled: boolean) => {
    const tokens: string[] = []
    for (const name of sequenceFor(wikiEnabled)) {
      if (hidden.has(name)) continue
      if (name === '|' && (tokens.at(-1) === '|' || tokens.length === 0))
        continue
      tokens.push(name)
    }
    return tokens
  }

  for (const wikiEnabled of [true, false]) {
    await page.goto(
      `/toolbar-overflow.html?wiki=${wikiEnabled ? 'enabled' : 'disabled'}`,
    )
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width: 1400, height: 700 })

    // Switching mode leaves the plan unchanged in width terms; the rules must still follow the
    // newly hidden controls.
    await switchMode(page, 'sv')
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([[...svSequence(wikiEnabled), TOGGLE], []])

    for (const width of [1000, 560, 500, 420, 360, 300, 240, 180, 80]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(250)
      expectNoStraySeparators(await visibleRowTokens(page))
    }
    await page.setViewportSize({ width: 1400, height: 700 })
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([[...svSequence(wikiEnabled), TOGGLE], []])

    // Back to a Markdown editing mode restores the full sequence.
    await switchMode(page, 'ir')
    await expect
      .poll(() => visibleRowTokens(page))
      .toEqual([[...sequenceFor(wikiEnabled), TOGGLE], []])

    // The same switch with a plan that has controls in More.
    await page.setViewportSize({ width: 420, height: 700 })
    await page.waitForTimeout(250)
    expectNoStraySeparators(await visibleRowTokens(page))
    await switchMode(page, 'sv')
    expectNoStraySeparators(await visibleRowTokens(page))
    await switchMode(page, 'ir')
    expectNoStraySeparators(await visibleRowTokens(page))
  }
})

test('keyboard traversal follows the visual order and starts at Undo (A14)', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })

  const visual = [...controlsOf(OWNER_SEQUENCE), TOGGLE]
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))

  // The one tabbable stop is Undo, and Tab from the start of the page reaches it.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.keyboard.press('Tab')
  await expect.poll(focusedType).toBe('undo')

  const walked: string[] = ['undo']
  for (let step = 1; step < visual.length; step++) {
    await page.keyboard.press('ArrowRight')
    walked.push((await focusedType()) ?? '')
  }
  expect(walked).toEqual(visual)
  await page.keyboard.press('ArrowRight')
  await expect.poll(focusedType).toBe('undo')

  // ArrowLeft walks the same order backwards, wrapping from Undo to the toggle.
  await page.keyboard.press('ArrowLeft')
  await expect.poll(focusedType).toBe(TOGGLE)
})

// Task 631: the collapse toggle hides the whole toolbar except itself, and a later expand restores
// the exact layout (hidden items report width 0, so the overflow pass must re-measure).
const COLLAPSE_TOGGLE = '.vditor-toolbar [data-type="collapse-toolbar"]'

const overflowSet = (page: import('@playwright/test').Page) =>
  page
    .locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-type')),
    )

const toolbarHeight = (page: import('@playwright/test').Page) =>
  page
    .locator('.vditor-toolbar')
    .evaluate((toolbar) => Math.round(toolbar.getBoundingClientRect().height))

for (const width of [1400, 420]) {
  test(`collapse then expand at ${width}px restores the same rows and overflow set`, async ({
    page,
  }) => {
    await page.goto('/toolbar-overflow.html?wiki=enabled')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(250)
    const rowsBefore = await visibleRowTokens(page)
    const overflowBefore = await overflowSet(page)
    const heightBefore = await toolbarHeight(page)
    if (width < 800) expect(overflowBefore.length).toBeGreaterThan(0)

    const toggle = page.locator(COLLAPSE_TOGGLE)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Row two leaves; the strip is one slim row (F1: 70% of a row) that keeps Preview, Edit Mode
    // and More as its last three controls before the toggle (A3).
    await expect(page.locator('.vmde-toolbar-row:visible')).toHaveCount(1)
    await expect(toggle).toBeVisible()
    for (const name of ['preview', 'edit-mode', 'more'])
      await expect(
        page.locator(`.vditor-toolbar [data-type="${name}"]`),
      ).toBeVisible()
    expect(await toolbarHeight(page)).toBeLessThan(heightBefore)
    // F1: the strip is 70% of one expanded row (35 px), not a full row.
    expect(await toolbarHeight(page)).toBeLessThanOrEqual(26)
    expect(await toolbarHeight(page)).toBeGreaterThanOrEqual(23)
    await expect(page.locator('.vmde-toolbar-row:visible')).toHaveCount(1)
    // The toggle sits at the trailing edge of the strip.
    const edges = await page.evaluate(() => {
      const strip = document.querySelector('.vditor-toolbar') as HTMLElement
      const button = document.querySelector(
        '.vditor-toolbar [data-type="collapse-toolbar"]',
      ) as HTMLElement
      return {
        gap:
          strip.getBoundingClientRect().right -
          button.getBoundingClientRect().right,
      }
    })
    expect(edges.gap).toBeLessThan(24)

    // A resize while collapsed must not poison the overflow measurements.
    await page.setViewportSize({ width: width + 40, height: 700 })
    await page.setViewportSize({ width, height: 700 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(() => visibleRowTokens(page)).toEqual(rowsBefore)
    await expect.poll(() => overflowSet(page)).toEqual(overflowBefore)
    await expect.poll(() => toolbarHeight(page)).toBe(heightBefore)
  })
}

// Task 631 follow-up F1 (Owner request 2026-10-15): the toggle is 30% smaller than a normal toolbar
// button and the collapsed strip is 30% shorter than one expanded row. Expected ratio 0.7 (+-1 px).
test('F1: the collapse toggle and the collapsed strip are 70% of the normal sizes', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.waitForTimeout(250)
  const measure = () =>
    page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return { w: r.width, h: r.height }
      }
      const toggle = document.querySelector(
        '.vditor-toolbar [data-type="collapse-toolbar"]',
      ) as HTMLElement
      const bold = document.querySelector(
        '.vditor-toolbar [data-type="bold"]',
      ) as HTMLElement
      const row1 = document.querySelector(
        '.vditor-toolbar .vmde-toolbar-row[data-vmde-toolbar-row="1"]',
      )
      const row2 = document.querySelector(
        '.vditor-toolbar .vmde-toolbar-row[data-vmde-toolbar-row="2"]',
      )
      return {
        toggle: box(toggle),
        toggleIcon: box(toggle.querySelector('svg')),
        bold: box(bold),
        boldIcon: box(bold.querySelector('svg')),
        row1: box(row1),
        row2: box(row2),
        toolbar: box(document.querySelector('.vditor-toolbar')),
        toggleCenterY:
          toggle.getBoundingClientRect().top +
          toggle.getBoundingClientRect().height / 2,
        toolbarTop: document
          .querySelector('.vditor-toolbar')!
          .getBoundingClientRect().top,
      }
    })
  const expanded = await measure()
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

  // Toggle box and icon: 70% of a normal toolbar button's, in the expanded state.
  near(expanded.toggle.w, expanded.bold.w * 0.7)
  near(expanded.toggle.h, expanded.bold.h * 0.7)
  near(expanded.toggleIcon.w, expanded.boldIcon.w * 0.7)
  near(expanded.toggleIcon.h, expanded.boldIcon.h * 0.7)

  const toggle = page.locator(COLLAPSE_TOGGLE)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const collapsed = await measure()
  // Same sizes in the collapsed state; the strip is 70% of one expanded row.
  near(collapsed.toggle.w, expanded.bold.w * 0.7)
  near(collapsed.toggle.h, expanded.bold.h * 0.7)
  near(collapsed.toggleIcon.w, expanded.boldIcon.w * 0.7)
  near(collapsed.toolbar.h, expanded.row1.h * 0.7)
  // Vertically centred in the strip.
  near(collapsed.toggleCenterY - collapsed.toolbarTop, collapsed.toolbar.h / 2)

  // Expanded layout heights are unchanged by the collapse and expand round trip.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(async () => {
      const again = await measure()
      return [again.row1.h, again.row2.h, again.toolbar.h]
    })
    .toEqual([expanded.row1.h, expanded.row2.h, expanded.toolbar.h])

  // The smaller toggle still toggles by keyboard (Enter and Space) and shows a focus ring.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const ring = await toggle.evaluate((el) => {
    const cs = getComputedStyle(el)
    return (
      document.activeElement === el &&
      el.matches(':focus-visible') &&
      cs.outlineStyle !== 'none' &&
      Number.parseFloat(cs.outlineWidth) > 0
    )
  })
  expect(ring).toBe(true)
})

test('an open More menu closes when the toolbar collapses', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 360, height: 700 })
  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  const panel = page.locator('.vmde-toolbar-more > .vditor-hint')
  await moreButton.click()
  await expect(panel).toBeVisible()
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'false')
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
})

test('an open Headings menu closes when the toolbar collapses', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const headings = page.locator('.vditor-toolbar [data-type="headings"]')
  await headings.click()
  const panel = page.locator(
    '.vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(panel).toBeVisible()
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(panel).toBeHidden()
})

test('a mouse click on the collapse toggle keeps the caret, selection and scroll position', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 500 })
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n\n')
  await page.evaluate((value) => (window as any).vditor.setValue(value), lines)
  // The harness toolbar scrolls with the page, so the browser's scroll anchoring would move
  // scrollTop to keep content in place when the strip changes height. Turn it off to assert that
  // nothing in the toggle path scrolls on its own.
  await page.addStyleTag({ content: 'body { overflow-anchor: none; }' })
  const snapshot = () =>
    page.evaluate(() => {
      const root = document.querySelector(
        '.vditor-ir .vditor-reset',
      ) as HTMLElement
      const selection = getSelection()
      const scroller = document.body
      const sources = [root, root.parentElement as HTMLElement, scroller]
      return {
        selected: selection?.toString() ?? '',
        anchorOffset: selection?.anchorOffset ?? -1,
        focusOffset: selection?.focusOffset ?? -1,
        anchorText: selection?.anchorNode?.textContent ?? '',
        inEditor: Boolean(
          selection?.anchorNode && root.contains(selection.anchorNode),
        ),
        focusInEditor: Boolean(document.activeElement?.closest('.vditor-ir')),
        scroll: sources.map((el) => el.scrollTop),
      }
    })
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const target = root.querySelectorAll('p')[40] as HTMLElement
    target.scrollIntoView()
    const text = target.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 1)
    range.setEnd(text, 4)
    ;(root as HTMLElement).focus()
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.body.scrollTop = 12
  })
  const before = await snapshot()
  expect(before.selected).toBe('ine')
  expect(before.focusInEditor).toBe(true)
  expect(before.scroll[2]).toBeGreaterThan(0)

  // A raw mouse click at the toggle's on-screen position: Playwright's own click would scroll the
  // toggle into view first and mask a scroll change.
  const toggle = page.locator(COLLAPSE_TOGGLE)
  const clickToggle = async () => {
    const box = await toggle.boundingBox()
    expect(box).not.toBeNull()
    // The harness toolbar scrolls with the page, so click the part of the toggle still on screen.
    const top = Math.max(box?.y ?? 0, 0)
    const bottom = (box?.y ?? 0) + (box?.height ?? 0)
    expect(bottom).toBeGreaterThan(top)
    await page.mouse.click(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (top + bottom) / 2,
    )
  }
  await clickToggle()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(150)
  const collapsed = await snapshot()
  expect(collapsed).toEqual(before)

  await clickToggle()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(150)
  expect(await snapshot()).toEqual(before)
})

test('keyboard traversal in the collapsed row starts at Undo and reaches the toggle (A14)', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const toggle = page.locator(COLLAPSE_TOGGLE)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const focusedType = () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-type'))

  // The collapsed row keeps the controls the flow placed in it, so the Escape then Tab gesture from
  // the editor reaches the first of them (task 456); the toggle is the last stop of the row.
  await page.locator('.vditor-ir .vditor-reset').click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect.poll(focusedType).toBe('undo')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(focusedType).toBe(TOGGLE)
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(focusedType).toBe(TOGGLE)
})

// Task 631 follow-up F2 (Owner request 2026-10-15): "collapsing state of toolbar must be remembered
// through VSCode sessions" and "All files receive the same toolbar collapsing state". The host owns
// one value; the webview receives it with the init payload (`?collapsed=1` plays that) and with
// later state messages, and posts every toggle.
test('F2: an editor whose host state is collapsed never paints an expanded toolbar', async ({
  page,
}) => {
  // Sample every animation frame from document start: any frame that shows a toolbar taller than
  // the collapsed strip (25 px with its border) is a flash of the expanded toolbar.
  await page.addInitScript(() => {
    ;(window as any).__expandedFrames = 0
    const sample = () => {
      const toolbar = document.querySelector('.vditor-toolbar')
      if (toolbar && toolbar.getBoundingClientRect().height > 30) {
        ;(window as any).__expandedFrames++
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.goto('/toolbar-overflow.html?wiki=enabled&collapsed=1')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  const toggle = page.locator(COLLAPSE_TOGGLE)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.vditor-toolbar')).toHaveClass(
    /vmde-toolbar--collapsed/,
  )
  await expect(page.locator('.vmde-toolbar-row:visible')).toHaveCount(1)
  expect(await toolbarHeight(page)).toBeLessThanOrEqual(26)
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => (window as any).__expandedFrames)).toBe(0)
  // Applying the host value is not a user toggle: nothing is posted back.
  expect(await page.evaluate(() => (window as any).__toolbarPosts)).toEqual([])
})

test('F2: a toggle posts the new value to the host', async ({ page }) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  const toggle = page.locator(COLLAPSE_TOGGLE)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await page.evaluate(() => (window as any).__toolbarPosts)).toEqual([
    { command: 'save-toolbar-collapsed', collapsed: true },
    { command: 'save-toolbar-collapsed', collapsed: false },
  ])
})

test('F2: a host state message collapses and expands without moving focus or changing bytes, selection or Undo (631 acceptance 3)', async ({
  page,
}) => {
  await page.goto('/toolbar-overflow.html?wiki=enabled')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.evaluate(() =>
    (window as any).vditor.setValue('alpha beta gamma\n\ndelta'),
  )
  // setValue arms a delayed after-render Undo record that re-renders the surface; let it land
  // before the selection and the baseline are taken.
  await page.waitForTimeout(1500)
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const text = root.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 7)
    ;(root as HTMLElement).focus()
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  })
  await page.waitForTimeout(500)
  const snapshot = () =>
    page.evaluate(() => {
      const editor = (window as any).vditor
      const root = document.querySelector('.vditor-ir .vditor-reset')
      const selection = getSelection()
      return {
        value: editor.getValue(),
        undoDepth: editor.vditor.undo.ir.undoStack.length,
        selected: selection?.toString() ?? '',
        anchorOffset: selection?.anchorOffset ?? -1,
        focusOffset: selection?.focusOffset ?? -1,
        focusInEditor: document.activeElement === root,
      }
    })
  const before = await snapshot()
  expect(before.selected).toBe('pha b')
  expect(before.focusInEditor).toBe(true)

  const toggle = page.locator(COLLAPSE_TOGGLE)
  await page.evaluate(() => (window as any).__receiveToolbarCollapsed(true))
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.vmde-toolbar-row:visible')).toHaveCount(1)
  await page.waitForTimeout(300)
  expect(await snapshot()).toEqual(before)

  await page.evaluate(() => (window as any).__receiveToolbarCollapsed(false))
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(300)
  expect(await snapshot()).toEqual(before)
  expect(await page.evaluate(() => (window as any).__toolbarPosts)).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// Task 642 — responsive toolbar flow: collapsed row, geometry, tooltips, labels, icons, traversal.
// ---------------------------------------------------------------------------------------------

const openToolbar = async (
  page: Page,
  query: string,
  width: number,
  height = 700,
) => {
  await page.goto(`/toolbar-overflow.html?${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.setViewportSize({ width, height })
  await page.waitForTimeout(250)
}

// Direct controls the flow placed in the rows (not the ones inside More), toggle included.
const DIRECT_BUTTONS =
  '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type]'

const selectWord = (page: Page) =>
  page.evaluate(() => {
    ;(window as any).vditor.setValue('alpha beta gamma')
  })

const selectInEditor = async (page: Page) => {
  await selectWord(page)
  await page.waitForTimeout(400)
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const text = root.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 5)
    ;(root as HTMLElement).focus()
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  })
}

test('collapsed: one small row holds the longest prefix, Preview, Edit Mode and More last, the rest in More (A3)', async ({
  page,
}) => {
  for (const wikiEnabled of [true, false]) {
    await openToolbar(
      page,
      `wiki=${wikiEnabled ? 'enabled' : 'disabled'}&collapsed=1`,
      1400,
    )
    const sequence = sequenceFor(wikiEnabled)
    for (const width of [1400, 900, 700, 420, 300, 200]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(250)
      const layout = await readLayout(page)
      expectFlowContract(layout, sequence, `collapsed w${width}`)
      // One row only: row two is never used while collapsed.
      expect(layout.rows[1]).toEqual([])
      if (width === 1400) expect(layout.more).toEqual([])
      if (width <= 420) expect(layout.more.length).toBeGreaterThan(0)
      expect(layout.rows[0].at(-1)).toBe(TOGGLE)
    }
  }
})

test('a control moved into More works from its row, collapsed and expanded (A3)', async ({
  page,
}) => {
  for (const [query, width] of [
    ['wiki=disabled&collapsed=1', 150],
    ['wiki=disabled', 180],
  ] as const) {
    await openToolbar(page, query, width)
    await page.addStyleTag({ content: '#app { min-height: 100vh; }' })
    await selectInEditor(page)
    const inMore = page.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type="strike"]',
    )
    await expect(inMore).toHaveCount(1)
    await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
    await inMore.click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('~~alpha~~')
  }
})

test('collapsed-row buttons are as small as the toggle and run their actions (A4)', async ({
  page,
}) => {
  await openToolbar(page, 'wiki=enabled&collapsed=1', 1400)
  const sizes = await page.locator(DIRECT_BUTTONS).evaluateAll((buttons) =>
    buttons
      .filter((button) => getComputedStyle(button).display !== 'none')
      .map((button) => {
        const box = button.getBoundingClientRect()
        const icon = button.querySelector('svg')?.getBoundingClientRect()
        return {
          name: button.getAttribute('data-type'),
          w: box.width,
          h: box.height,
          iw: icon?.width ?? 0,
          ih: icon?.height ?? 0,
        }
      }),
  )
  expect(sizes.length).toBeGreaterThan(30)
  for (const size of sizes) {
    expect(Math.abs(size.w - 17.5), `${size.name} width`).toBeLessThanOrEqual(
      0.5,
    )
    expect(Math.abs(size.h - 24), `${size.name} height`).toBeLessThanOrEqual(
      0.5,
    )
    expect(Math.abs(size.iw - 11.2), `${size.name} icon`).toBeLessThanOrEqual(
      0.5,
    )
    expect(Math.abs(size.ih - 11.2), `${size.name} icon`).toBeLessThanOrEqual(
      0.5,
    )
  }
  await selectInEditor(page)
  await page.locator('.vditor-toolbar [data-type="bold"]').click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toContain('**alpha**')
})

for (const collapsed of [false, true]) {
  test(`resizing wider and narrower gives the same layout for the same width, ${collapsed ? 'collapsed' : 'expanded'}, also after a Source round trip (A5)`, async ({
    page,
  }) => {
    await openToolbar(
      page,
      `wiki=enabled${collapsed ? '&collapsed=1' : ''}`,
      1400,
    )
    const sequence = sequenceFor(true)
    const seen = new Map<number, string>()
    for (const width of [1400, 700, 420, 1400, 420, 900, 700, 300, 1400]) {
      await page.setViewportSize({ width, height: 700 })
      await page.waitForTimeout(250)
      const layout = await readLayout(page)
      expectFlowContract(layout, sequence, `w${width}`)
      const key = JSON.stringify(layout)
      if (seen.has(width))
        expect(key, `width ${width} is stable`).toBe(seen.get(width))
      else seen.set(width, key)
    }
    // A Source round trip hides and shows controls; the layout afterwards matches the earlier one.
    await page.setViewportSize({ width: 420, height: 700 })
    await switchMode(page, 'sv')
    await page.waitForTimeout(250)
    expectNoStraySeparators(await visibleRowTokens(page))
    await switchMode(page, 'ir')
    await page.waitForTimeout(250)
    expect(JSON.stringify(await readLayout(page))).toBe(seen.get(420))
  })
}

/** Gap between the painted bands of the two expanded rows, their hit-box overlap and the toolbar
 *  height, read from the first control of each row (Tasks 642 A6 and 661 A3). */
const measureBandGap = (page: Page) =>
  page.evaluate(() => {
    const bandOf = (row: string) => {
      const button = document.querySelector<HTMLElement>(
        `.vmde-toolbar-row[data-vmde-toolbar-row="${row}"] > .vditor-toolbar__item > [data-type]:not([data-type="collapse-toolbar"])`,
      ) as HTMLElement
      const box = button.getBoundingClientRect()
      const style = getComputedStyle(button)
      return {
        top: box.top + Number.parseFloat(style.borderTopWidth),
        bottom: box.bottom - Number.parseFloat(style.borderBottomWidth),
        boxTop: box.top,
        boxBottom: box.bottom,
      }
    }
    const first = bandOf('1')
    const second = bandOf('2')
    return {
      gap: second.top - first.bottom,
      overlap: first.boxBottom - second.boxTop,
      height: document.querySelector('.vditor-toolbar')?.getBoundingClientRect()
        .height,
      ratio: window.devicePixelRatio,
    }
  })

const expectBandGap = (gap: Awaited<ReturnType<typeof measureBandGap>>) => {
  expect(Math.abs(gap.gap - 2.4)).toBeLessThanOrEqual(1)
  // The hit boxes meet without overlapping, so neither row takes the other's clicks.
  expect(gap.overlap).toBeLessThanOrEqual(0.01)
  // Two rows of 30.2 px plus the border.
  expect(Math.abs((gap.height ?? 0) - 61.4)).toBeLessThanOrEqual(1)
}

for (const mode of ['ir', 'wysiwyg', 'sv']) {
  test(`the band gap between the two expanded rows is 2.4 px (+-1) in ${mode} (A6)`, async ({
    page,
  }) => {
    await openToolbar(page, 'wiki=enabled', 640)
    if (mode !== 'ir') await switchMode(page, mode)
    await page.waitForTimeout(250)
    await expect(page.locator('.vditor-toolbar')).toHaveClass(
      /vmde-toolbar--two-rows/,
    )
    expectBandGap(await measureBandGap(page))
  })
}

test.describe('device pixel ratio 2', () => {
  test.use({ deviceScaleFactor: 2 })

  test('band gap at device pixel ratio 2 is 2.4 px (+/- 1) (661 A3)', async ({
    page,
  }) => {
    await openToolbar(page, 'wiki=enabled', 640)
    await expect(page.locator('.vditor-toolbar')).toHaveClass(
      /vmde-toolbar--two-rows/,
    )
    const gap = await measureBandGap(page)
    test.info().annotations.push({
      type: '661 gap at ratio 2',
      description: JSON.stringify(gap),
    })
    expect(gap.ratio).toBe(2)
    expectBandGap(gap)
  })
})

test('one-row threshold is 1,143 px with wiki and 1,076 px without (661 A2)', async ({
  page,
}) => {
  const cases = [
    { query: 'wiki=enabled', width: 1142, twoRows: true },
    { query: 'wiki=enabled', width: 1143, twoRows: false },
    { query: 'wiki=disabled', width: 1075, twoRows: true },
    { query: 'wiki=disabled', width: 1076, twoRows: false },
  ]
  const seen: string[] = []
  for (const { query, width, twoRows } of cases) {
    await openToolbar(page, query, width)
    const state = await page.locator('.vditor-toolbar').evaluate((toolbar) => ({
      twoRows: toolbar.classList.contains('vmde-toolbar--two-rows'),
      height: toolbar.getBoundingClientRect().height,
    }))
    seen.push(`${query}@${width}: ${JSON.stringify(state)}`)
    expect(state.twoRows, `${query} at ${width}`).toBe(twoRows)
    expect(
      Math.abs(state.height - (twoRows ? 61.4 : 36)),
      `${query} at ${width} height ${state.height}`,
    ).toBeLessThanOrEqual(0.25)
  }
  test.info().annotations.push({
    type: '661 thresholds',
    description: seen.join(' | '),
  })
})

/** Installs a painted-state sampler: a ResizeObserver on the root created after the toolbar's own
 *  (observers notify in creation order, so it reads the state that is about to be painted) plus a
 *  rAF loop. Each reading records a violation string for a half-placed flow. */
const installFrameSampler = (page: Page) =>
  page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.vditor-toolbar')
    if (!toolbar) throw new Error('no toolbar')
    const shown = (element: Element) =>
      getComputedStyle(element).display !== 'none'
    const controlCount = toolbar.querySelectorAll('[data-type]').length
    const state = {
      samples: 0,
      violations: [] as string[],
      stop: false,
    }
    const boxOf = (element: Element | null | undefined) =>
      element?.getBoundingClientRect() ?? { width: 1, height: 1 }
    const when = (condition: boolean, text: string): string[] =>
      condition ? [text] : []
    const readViolations = (): string[] => {
      const collapsed = toolbar.classList.contains('vmde-toolbar--collapsed')
      const twoRows = toolbar.classList.contains('vmde-toolbar--two-rows')
      const rows = Array.from(
        toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
      ).filter(shown)
      const buttons = rows
        .flatMap((row) => Array.from(row.children).filter(shown))
        .map((item) => item.querySelector<HTMLElement>(':scope > [data-type]'))
        .filter((button): button is HTMLElement => button !== null)
      const expected = { collapsed: 25, two: 61.4, one: 36 }
      const height = boxOf(toolbar).height
      const want = collapsed
        ? expected.collapsed
        : twoRows
          ? expected.two
          : expected.one
      const count = toolbar.querySelectorAll('[data-type]').length
      return [
        ...when(
          !collapsed && twoRows !== rows.length > 1,
          `two-rows class ${twoRows} with ${rows.length} rows shown`,
        ),
        ...rows
          .filter((row) => row.scrollWidth > row.clientWidth + 1)
          .map(
            (row) => `row overflows ${row.scrollWidth} > ${row.clientWidth}`,
          ),
        ...buttons
          .filter((button) => boxOf(button).width === 0)
          .map((button) => `${button.dataset.type} has a zero-width box`),
        ...buttons
          .filter((button) => {
            const icon = boxOf(button.querySelector('svg'))
            return icon.width === 0 || icon.height === 0
          })
          .map((button) => `${button.dataset.type} icon is empty`),
        ...when(
          Math.abs(height - want) > 0.25,
          `height ${height} against ${want}`,
        ),
        ...when(
          count !== controlCount,
          `control count ${count} against ${controlCount}`,
        ),
      ]
    }
    const read = () => {
      if (boxOf(toolbar).width === 0) return
      state.samples++
      for (const reason of readViolations()) {
        if (state.violations.length < 40)
          state.violations.push(`w${window.innerWidth}: ${reason}`)
      }
    }
    const observer = new ResizeObserver(read)
    observer.observe(document.documentElement)
    const loop = () => {
      if (state.stop) return
      read()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    ;(window as any).__frameSampler = state
    ;(window as any).__frameSamplerStop = () => {
      state.stop = true
      observer.disconnect()
      return { samples: state.samples, violations: state.violations }
    }
  })

for (const collapsed of [false, true]) {
  test(`painted frames stay consistent through a resize sweep, ${collapsed ? 'collapsed' : 'expanded'} (661 A1)`, async ({
    page,
  }) => {
    await openToolbar(
      page,
      collapsed ? 'wiki=enabled&collapsed=1' : 'wiki=enabled',
      1500,
    )
    await installFrameSampler(page)
    const twoFrames = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
    for (const width of [
      1500, 1143, 1142, 1076, 1075, 900, 640, 521, 520, 380, 640, 1500,
    ]) {
      await page.setViewportSize({ width, height: 700 })
      await twoFrames()
    }
    for (let step = 0; step < 40; step++) {
      await page.setViewportSize({
        width: step % 2 === 0 ? 1500 - step * 28 : 380 + step * 3,
        height: 700,
      })
    }
    await twoFrames()
    const result = await page.evaluate(() =>
      (window as any).__frameSamplerStop(),
    )
    test.info().annotations.push({
      type: '661 sampler',
      description: `samples ${result.samples}, violations ${result.violations.length}`,
    })
    expect(result.samples).toBeGreaterThan(30)
    expect(result.violations).toEqual([])
  })
}

test('the toggle keeps its box across collapse and expand, and a gap of 12 px or more separates it from the controls (A7, A8)', async ({
  page,
}) => {
  for (const width of [1400, 640]) {
    await openToolbar(page, 'wiki=enabled', width)
    const toggle = page.locator(COLLAPSE_TOGGLE)
    const measure = () =>
      page.evaluate(() => {
        const button = document.querySelector(
          '.vditor-toolbar [data-type="collapse-toolbar"]',
        ) as HTMLElement
        const box = button.getBoundingClientRect()
        // The nearest control edge in any row, dividers included.
        let nearest = 0
        for (const el of document.querySelectorAll<HTMLElement>(
          '.vmde-toolbar-row > .vditor-toolbar__item, .vmde-toolbar-row > .vditor-toolbar__divider',
        )) {
          if (el.contains(button)) continue
          if (getComputedStyle(el).display === 'none') continue
          nearest = Math.max(nearest, el.getBoundingClientRect().right)
        }
        return {
          x: box.x,
          y: box.y,
          w: box.width,
          h: box.height,
          gap: box.left - nearest,
        }
      })
    const expanded = await measure()
    expect(expanded.gap, `expanded gap at ${width}`).toBeGreaterThanOrEqual(
      11.99,
    )
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await page.waitForTimeout(250)
    const collapsed = await measure()
    expect(collapsed.gap, `collapsed gap at ${width}`).toBeGreaterThanOrEqual(
      11.99,
    )
    for (const key of ['x', 'y', 'w', 'h'] as const)
      expect(
        Math.abs(collapsed[key] - expanded[key]),
        `toggle ${key}`,
      ).toBeLessThanOrEqual(0.5)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.waitForTimeout(250)
    const again = await measure()
    for (const key of ['x', 'y', 'w', 'h'] as const)
      expect(
        Math.abs(again[key] - expanded[key]),
        `toggle ${key} again`,
      ).toBeLessThanOrEqual(0.5)
  }
})

test('the toolbar icons are 16 px and the stroke icons stay strokes, in the row and in More (A9, A13)', async ({
  page,
}) => {
  await openToolbar(page, 'wiki=enabled', 1400)
  const iconInfo = (name: string, scope: string) =>
    page
      .locator(`${scope} [data-type="${name}"] > svg`)
      .first()
      .evaluate((svg) => {
        const box = svg.getBoundingClientRect()
        const style = getComputedStyle(svg)
        return {
          w: box.width,
          h: box.height,
          fill: style.fill,
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          viewBox: svg.getAttribute('viewBox'),
        }
      })
  // Preview is a Codicon: a 16x16 fill icon. It is part of the tail, so it is never in More.
  const preview = await iconInfo('preview', '.vmde-toolbar-row')
  expect([preview.w, preview.h]).toEqual([16, 16])
  expect(preview.viewBox).toBe('0 0 16 16')
  expect(preview.fill).not.toBe('none')
  // Wiki Pages, Headings, Edit Mode, Insert Before and Insert After are Tabler and Lucide strokes.
  for (const name of [
    'wiki-pages',
    'headings',
    'edit-mode',
    'insert-before',
    'insert-after',
  ]) {
    const info = await iconInfo(name, '.vmde-toolbar-row')
    expect([info.w, info.h], name).toEqual([16, 16])
    expect(info.viewBox, name).toBe('0 0 24 24')
    expect(info.fill, name).toBe('none')
    expect(info.stroke, name).not.toBe('none')
    expect(info.strokeWidth, name).toBe('2px')
  }
  // The same icons inside More (Wiki Pages leaves first), still 16 px strokes.
  await page.setViewportSize({ width: 300, height: 700 })
  await page.waitForTimeout(250)
  await page.addStyleTag({ content: '#app { min-height: 100vh; }' })
  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  for (const name of ['wiki-pages', 'insert-before', 'insert-after']) {
    const info = await iconInfo(name, '.vmde-toolbar-more > .vditor-hint')
    expect([info.w, info.h], `${name} in More`).toEqual([16, 16])
    expect(info.fill, `${name} in More`).toBe('none')
    expect(info.strokeWidth, `${name} in More`).toBe('2px')
  }
})

test('every top-level control has a description without a key, shown on hover and focus, and tooltips stay inside the viewport (A10)', async ({
  page,
}) => {
  const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/
  await openToolbar(page, 'wiki=enabled', 1400)
  const tips = await page.locator(DIRECT_BUTTONS).evaluateAll((buttons) =>
    buttons.map((button) => ({
      name: button.getAttribute('data-type'),
      tip: button.getAttribute('data-vmde-tip'),
      description: button.getAttribute('aria-description'),
      label: button.getAttribute('aria-label'),
    })),
  )
  expect(tips.length).toBe(35)
  for (const entry of tips) {
    expect(entry.tip, `${entry.name} tip`).toBeTruthy()
    expect(entry.tip, `${entry.name} tip`).not.toMatch(KEY_HINT)
    expect(entry.description, `${entry.name} description`).toBe(entry.tip)
    expect(entry.label, `${entry.name} name stays the label`).toBeTruthy()
  }

  // Hover and keyboard focus paint the description (not the name).
  const painted = (name: string) =>
    page.evaluate((n) => {
      const button = document.querySelector(
        `.vditor-toolbar [data-type="${n}"]`,
      ) as HTMLElement
      const after = getComputedStyle(button, '::after')
      return { content: after.content, display: after.display }
    }, name)
  await page.hover('.vditor-toolbar [data-type="bold"]')
  expect(await painted('bold')).toEqual({
    content: '"Make the selection bold"',
    display: 'block',
  })
  await page.mouse.move(700, 400)
  await page.locator('.vditor-toolbar [data-type="redo"]').focus()
  expect((await painted('redo')).content).toBe('"Redo the last undone change"')

  // The toggle's description follows its state.
  await page.locator(COLLAPSE_TOGGLE).click()
  await expect(page.locator(COLLAPSE_TOGGLE)).toHaveAttribute(
    'data-vmde-tip',
    'Expand the toolbar to full-size buttons',
  )
  await page.locator(COLLAPSE_TOGGLE).click()

  // Each painted tooltip stays inside the viewport at both edges, at wide and narrow widths.
  // 280 px is narrower than the longest description, which cannot fit any viewport that small.
  for (const width of [1400, 420]) {
    await page.setViewportSize({ width, height: 700 })
    await page.waitForTimeout(250)
    const names = await page
      .locator(DIRECT_BUTTONS)
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => getComputedStyle(button).display !== 'none')
          .map((button) => button.getAttribute('data-type') as string),
      )
    for (const name of names) {
      await page.hover(`${DIRECT_BUTTONS}[data-type="${name}"]`)
      const box = await page.evaluate((n) => {
        const button = document.querySelector(
          `.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="${n}"]`,
        ) as HTMLElement
        const rect = button.getBoundingClientRect()
        const after = getComputedStyle(button, '::after')
        const matrix = new DOMMatrixReadOnly(
          after.transform === 'none' ? undefined : after.transform,
        )
        const width =
          Number.parseFloat(after.width) +
          Number.parseFloat(after.paddingLeft) +
          Number.parseFloat(after.paddingRight) +
          Number.parseFloat(after.borderLeftWidth) +
          Number.parseFloat(after.borderRightWidth)
        const left =
          rect.left +
          Number.parseFloat(after.left) +
          Number.parseFloat(after.marginLeft) +
          matrix.e
        return { left, right: left + width, viewport: window.innerWidth }
      }, name)
      expect(
        box.left,
        `${name} tooltip left at ${width}`,
      ).toBeGreaterThanOrEqual(0)
      expect(
        box.right,
        `${name} tooltip right at ${width}`,
      ).toBeLessThanOrEqual(box.viewport + 0.01)
    }
  }
})

test('every More row, authored or moved, shows its icon and its name; moved controls carry a native description (A10, A11, A12)', async ({
  page,
}) => {
  const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/
  for (const query of ['wiki=enabled', 'wiki=enabled&collapsed=1']) {
    await openToolbar(page, query, 420)
    await page.addStyleTag({ content: '#app { min-height: 100vh; }' })
    await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
    const rows = await page
      .locator('.vmde-toolbar-more > .vditor-hint > *')
      .evaluateAll((items) =>
        items
          .filter((item) => !item.classList.contains('vditor-toolbar__divider'))
          .map((item) => {
            const button = item.querySelector(
              ':scope > [data-type]',
            ) as HTMLElement
            const label = button.querySelector('.vmde-menu-label')
            const after = getComputedStyle(button, '::after').content
            const icon = button.querySelector('svg')?.getBoundingClientRect()
            const visible = button.getClientRects().length > 0
            return {
              name: button.getAttribute('data-type'),
              hasIcon: Boolean(button.querySelector('svg')),
              visible,
              display: getComputedStyle(button).display,
              iconLeft: icon ? Math.round(icon.left) : null,
              labelGap:
                label && icon
                  ? Math.round(label.getBoundingClientRect().left - icon.right)
                  : null,
              moved: item.classList.contains('vditor-toolbar__item'),
              label: label?.textContent?.trim() ?? '',
              after,
              ariaLabel: button.getAttribute('aria-label'),
              title: button.getAttribute('title') ?? '',
              tipClass: button.className.includes('vditor-tooltipped'),
            }
          }),
      )
    const names = rows.map((row) => row.name)
    for (const authored of [
      'both',
      'settings',
      'insert-anchor',
      'insert-picture',
      'info',
      'about',
    ])
      expect(names, authored).toContain(authored)
    expect(rows.filter((row) => row.moved).length).toBeGreaterThan(5)
    for (const row of rows) {
      expect(row.hasIcon, `${row.name} icon`).toBe(true)
      expect(row.title, `${row.name} description`).toBeTruthy()
      expect(row.title, `${row.name} description`).not.toMatch(KEY_HINT)
      if (row.moved) {
        // A moved control's label is the generated content of its aria-label.
        expect(row.after, `${row.name} label`).toBe(`"${row.ariaLabel}"`)
        expect(row.tipClass, `${row.name} paints no second tooltip`).toBe(false)
      } else {
        expect(row.label.length, `${row.name} label`).toBeGreaterThan(0)
        expect(row.label, `${row.name} label`).not.toContain('undefined')
      }
    }
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
    expect(byName.settings.label).toBe('Settings')
    expect(byName['insert-anchor'].label).toBe('Insert ID')
    expect(byName['insert-picture'].label).toBe('Insert picture')
    expect(byName.both.label).toBe('Split View')
    // Every visible row is a flex row with its icon in one column, and an authored label starts
    // 8px after its icon, so labels line up with the moved controls' labels.
    const shown = rows.filter((row) => row.visible)
    const iconColumn = shown[0].iconLeft
    for (const row of shown) {
      expect(row.display, `${row.name} display`).toBe('flex')
      expect(row.iconLeft, `${row.name} icon column`).toBe(iconColumn)
      if (!row.moved) expect(row.labelGap, `${row.name} label gap`).toBe(8)
    }
  }
})

test('the Math menu rows show their icon and name, and Settings shows the cog and opens the settings (A11, A12)', async ({
  page,
}) => {
  await openToolbar(page, 'wiki=enabled', 1400)
  await page.evaluate(() => {
    const posts: unknown[] = []
    ;(window as any).__posts = posts
    ;(window as any).vscode = {
      postMessage: (message: unknown) => posts.push(message),
    }
  })
  await page.locator('.vditor-toolbar [data-type="math"]').click()
  const mathRows = await page
    .locator(
      '.vditor-toolbar__item:has(> [data-type="math"]) > .vditor-hint button',
    )
    .evaluateAll((buttons) =>
      buttons.map((button) => ({
        name: button.getAttribute('data-type'),
        label: button.querySelector('.vmde-menu-label')?.textContent ?? '',
        hasIcon: Boolean(button.querySelector('svg')),
        iconBox: button.querySelector('svg')?.getBoundingClientRect().width,
      })),
    )
  expect(mathRows).toEqual([
    {
      name: 'math-inline-github',
      label: 'Inline math (GitHub)',
      hasIcon: true,
      iconBox: 16,
    },
    { name: 'math-block', label: 'Math block', hasIcon: true, iconBox: 16 },
  ])
  await page.keyboard.press('Escape')

  await page.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const settings = page.locator(
    '.vmde-toolbar-more > .vditor-hint [data-type="settings"]',
  )
  await expect(settings.locator('svg')).toBeVisible()
  // The Codicons settings-gear path, beside the name.
  await expect(settings.locator('svg path')).toHaveAttribute(
    'd',
    /^M12 9C10\.3425 9/,
  )
  await expect(settings.locator('.vmde-menu-label')).toHaveText('Settings')
  expect((await settings.locator('svg').boundingBox())?.width).toBe(16)
  await settings.click()
  expect(await page.evaluate(() => (window as any).__posts)).toEqual([
    { command: 'open-settings' },
  ])
})

for (const [label, query, width] of [
  ['two expanded rows', 'wiki=enabled', 800],
  ['the collapsed row', 'wiki=enabled&collapsed=1', 600],
] as const) {
  test(`keyboard traversal follows the visual order in ${label} (A14)`, async ({
    page,
  }) => {
    await openToolbar(page, query, width)
    const visual = await page.locator(DIRECT_BUTTONS).evaluateAll((buttons) =>
      buttons
        .filter((button) => getComputedStyle(button).display !== 'none')
        .map((button) => {
          const box = button.getBoundingClientRect()
          return {
            name: button.getAttribute('data-type') as string,
            row: Math.round(box.top / 20),
            left: box.left,
            rowIndex: (button.closest('.vmde-toolbar-row') as HTMLElement)
              .dataset.vmdeToolbarRow,
          }
        }),
    )
    // Reading order: the toggle belongs to row one, so rows are compared by their authored index.
    visual.sort(
      (a, b) => Number(a.rowIndex) - Number(b.rowIndex) || a.left - b.left,
    )
    const expected = visual.map((entry) => entry.name)
    expect(new Set(expected).size).toBe(expected.length)
    const focusedType = () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-type'))
    await page.locator('.vditor-ir .vditor-reset').click()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect.poll(focusedType).toBe('undo')
    const walked = ['undo']
    for (let step = 1; step < expected.length; step++) {
      await page.keyboard.press('ArrowRight')
      walked.push((await focusedType()) ?? '')
    }
    expect(walked).toEqual(expected)
  })
}

test('Headings and Emoji panels opened from inside More stay open there (edge case)', async ({
  page,
}) => {
  await openToolbar(page, 'wiki=disabled', 160)
  await page.addStyleTag({ content: '#app { min-height: 100vh; }' })
  const morePanel = page.locator('.vmde-toolbar-more > .vditor-hint')
  const moreButton = page.locator('.vmde-toolbar-more > [data-type="more"]')
  await expect(
    page.locator(
      '.vmde-toolbar-more .vditor-toolbar__item[data-vmde-overflow="true"]:has([data-type="headings"])',
    ),
  ).toHaveCount(1)

  // Vditor's Headings first hides every hint, More's included; the panel must still open.
  await moreButton.click()
  await page.locator('.vmde-toolbar-more [data-type="headings"]').click()
  await expect(morePanel).toBeVisible()
  const headingsPanel = page.locator(
    '.vmde-toolbar-more .vditor-toolbar__item:has(> [data-type="headings"]) > .vditor-hint',
  )
  await expect(headingsPanel).toBeVisible()
  await expect(moreButton).toHaveAttribute('aria-expanded', 'true')

  // The Emoji picker does the same; its search field and results render inside More.
  await page.locator('.vmde-toolbar-more [data-type="emoji"]').click()
  await expect(morePanel).toBeVisible()
  const picker = page.locator('.vmde-emoji-picker')
  await expect(picker).toBeVisible()
  await expect(headingsPanel).toBeHidden()
  await expect
    .poll(() =>
      picker
        .locator('.vmde-emoji-picker__results')
        .evaluate((results) => results.scrollHeight),
    )
    .toBeGreaterThan(0)

  // Closing More closes the panels it holds, so a later open shows no stale one.
  await moreButton.click()
  await expect(morePanel).toBeHidden()
  await expect(picker).toBeHidden()
  await moreButton.click()
  await expect(morePanel).toBeVisible()
  await expect(picker).toBeHidden()
  await expect(headingsPanel).toBeHidden()
})
