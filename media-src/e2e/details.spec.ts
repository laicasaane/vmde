import { expect, test } from './coverage-fixture'

const value = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__details.editor.getValue() as string)

const undoLength = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const inner = (window as any).__details.editor.vditor
    return inner.undo[inner.currentMode].undoStack.length as number
  })

async function open(
  page: import('@playwright/test').Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
  snippet = false,
  table = false,
) {
  await page.goto(
    `/details.html?mode=${mode}${snippet ? '&snippet=1' : ''}${table ? '&table=1' : ''}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function selectToolbarBody(
  page: import('@playwright/test').Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
) {
  if (mode === 'sv') {
    await page.evaluate(() => {
      const root = (window as any).__details.editor.vditor.sv
        .element as HTMLElement
      const source = root.textContent ?? ''
      const start = source.indexOf('Toolbar body **exact**.')
      const end = source.indexOf('- toolbar item') + '- toolbar item'.length
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let offset = 0
      let startPoint: [Text, number] | null = null
      let endPoint: [Text, number] | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        if (!startPoint && start <= offset + text.length)
          startPoint = [text, start - offset]
        if (end <= offset + text.length) {
          endPoint = [text, end - offset]
          break
        }
        offset += text.length
      }
      const range = document.createRange()
      range.setStart(...startPoint!)
      range.setEnd(...endPoint!)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus({ preventScroll: true })
      document.dispatchEvent(new Event('selectionchange'))
    })
    return
  }
  await page.evaluate((currentMode) => {
    const root = (window as any).__details.editor.vditor[currentMode]
      .element as HTMLElement
    const paragraph = Array.from(root.querySelectorAll<HTMLElement>('p')).find(
      (candidate) => candidate.textContent?.includes('Toolbar body'),
    )!
    const item = Array.from(root.querySelectorAll<HTMLElement>('li')).find(
      (candidate) => candidate.textContent?.includes('toolbar item'),
    )!
    const edgeText = (element: HTMLElement, last: boolean) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest('[data-render]'))
          nodes.push(node as Text)
      }
      return last ? nodes.at(-1)! : nodes[0]
    }
    const startText = edgeText(paragraph, false)
    const endText = edgeText(item, true)
    const range = document.createRange()
    range.setStart(startText, 0)
    range.setEnd(endText, endText.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    root.focus({ preventScroll: true })
    document.dispatchEvent(new Event('selectionchange'))
  }, mode)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: details toggle is visual-only and caret entry reveals exact source`, async ({
    page,
  }) => {
    await open(page, mode)
    const expected = await page.evaluate(
      () => (window as any).__details.expected,
    )
    expect(await value(page)).toBe(expected)

    const buttons = page.locator(`.vditor-${mode} .vmde-details__toggle`)
    const body = page
      .locator(`.vditor-${mode} p`)
      .filter({ hasText: 'Body' })
      .first()
    const visibleBody = page
      .locator(`.vditor-${mode} p`)
      .filter({ hasText: 'Visible body.' })
      .first()
    await expect(buttons).toHaveCount(2)
    await expect(buttons.first()).toHaveText('More info')
    await expect(buttons.first()).toHaveAttribute('aria-expanded', 'false')
    await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeHidden()
    await expect(visibleBody).toBeVisible()

    await buttons.first().press('Enter')
    await expect(buttons.first()).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeVisible()
    expect(await value(page)).toBe(expected)

    await buttons.first().click()
    await page.evaluate(() => {
      const inner = (window as any).__details.editor.vditor
      const root = inner[inner.currentMode].element as HTMLElement
      const text = Array.from(root.querySelectorAll<HTMLElement>('p')).find(
        (paragraph) => paragraph.textContent?.includes('Body'),
      )!.firstChild!
      const range = document.createRange()
      range.setStart(text, 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus({ preventScroll: true })
      document.dispatchEvent(new Event('selectionchange'))
    })
    await expect(
      page.locator(`.vditor-${mode} [data-vmde-details-editing]`),
    ).toHaveCount(2)
    const rawTags = page.locator(
      `.vditor-${mode} [data-vmde-details-editing] > pre:first-of-type`,
    )
    await expect(rawTags).toHaveCount(2)
    await expect(rawTags.first()).toBeVisible()
    await expect(rawTags.nth(1)).toBeVisible()
    await expect(buttons.first()).toBeHidden()
    await expect(body).toBeVisible()
    expect(await value(page)).toBe(expected)
  })
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: pinned details toolbar wraps and unwraps the selected blocks`, async ({
    page,
  }) => {
    await open(page, mode)
    const initial = await value(page)
    await selectToolbarBody(page, mode)
    const toolbar = page.locator('.vditor-toolbar [data-type="details"]')
    await expect(toolbar).toBeEnabled()
    await toolbar.click()
    await expect.poll(() => value(page)).toContain('<summary>Details</summary>')
    const wrapped = await value(page)
    expect(wrapped).toContain('Toolbar body **exact**.\n\n- toolbar item')
    await expect(toolbar).toHaveAttribute('aria-pressed', 'true')
    await toolbar.click()
    await expect.poll(() => value(page)).toBe(initial)
    expect(await page.evaluate(() => (window as any).__details.syncs())).toBe(2)
  })
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: responsive tables follow details collapse state`, async ({
    page,
  }) => {
    await open(page, mode, false, true)
    const before = await value(page)
    const toggle = page.locator(`.vditor-${mode} .vmde-details__toggle`)
    const table = page.locator(`.vditor-${mode} table`)
    const code = page.locator(`.vditor-${mode} [data-type="code-block"]`)

    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(() =>
        table.evaluate((element) =>
          element.style.getPropertyValue('table-layout'),
        ),
      )
      .toBe('fixed')
    await expect(table).toBeHidden()
    await expect(code).toBeHidden()
    await toggle.click()
    await expect(table).toBeVisible()
    await expect(table).toHaveCSS('display', 'table')
    await expect(code).toBeVisible()
    await toggle.click()
    await expect(table).toBeHidden()
    await expect(code).toBeHidden()
    expect(await value(page)).toBe(before)
  })
}

test('Preview keeps the browser-native details toggle', async ({ page }) => {
  await open(page, 'ir')
  const expected = await value(page)
  await page.locator('.vditor-toolbar [data-type="preview"]').click()
  const details = page.locator('.vditor-preview details').first()
  await expect(details).toBeVisible()
  await expect(details).not.toHaveAttribute('open', /.*/)
  await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
  expect(await value(page)).toBe(expected)
})

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: ;;details inserts the shared source skeleton`, async ({
    page,
  }) => {
    await open(page, mode, true)
    await expect.poll(() => undoLength(page)).toBeGreaterThanOrEqual(1)
    const before = await value(page)
    const beforeUndo = await undoLength(page)
    const root = page.locator(`.vditor-${mode}`)
    await root.click()
    await page.keyboard.type(';;det')
    const hint = page.locator('.vditor-hint:visible button').filter({
      hasText: 'Details',
    })
    await expect(hint).toHaveCount(1)
    if (mode === 'ir') await page.keyboard.press('Enter')
    else await hint.click()
    await expect.poll(() => value(page)).toContain('<details>')
    expect(await value(page)).toContain('<summary>Details</summary>')
    expect(await value(page)).toContain('Details body')
    await expect.poll(() => undoLength(page)).toBeGreaterThan(beforeUndo)
    await page.keyboard.press('Control+z')
    await expect.poll(() => value(page)).toBe(before)
  })
}

// Task 605: in SV a pending Turn Into choice must survive passive Details activity (no editor
// mutation, the token still applies) and Details must keep tracking the selection afterwards.
for (const outcome of ['apply', 'cancel'] as const) {
  test(`sv: a pending Turn Into choice survives passive Details activity and Details resumes after ${outcome}`, async ({
    page,
  }) => {
    await open(page, 'sv')
    const before = await value(page)
    const token = await page.evaluate(() => {
      const w = window as any
      const root = w.__details.editor.vditor.sv.element as HTMLElement
      const needle = 'exact'
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        const at = text.data.indexOf(needle)
        // SV splits the emphasis markers into their own Text nodes, so match the word alone.
        if (at < 0) continue
        root.focus()
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + needle.length)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        break
      }
      w.__task605Mutations = []
      const observer = new MutationObserver((records) => {
        w.__task605Mutations.push(records.length)
      })
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
      })
      w.__task605Observer = observer
      return w.__details.turnInto.request()?.token ?? 0
    })
    expect(token).toBeGreaterThan(0)
    // The request itself may touch nothing either: start counting after it, then drive passive
    // Details updates (a settled selection change and a pointer-free frame wait).
    await page.evaluate(() => {
      ;(window as any).__task605Observer.takeRecords()
      ;(window as any).__task605Mutations.length = 0
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.waitForTimeout(400)
    expect(
      await page.evaluate(() => (window as any).__task605Mutations.length),
    ).toBe(0)
    const applied = await page.evaluate(
      ({ token, outcome }) => {
        const w = window as any
        if (outcome === 'cancel') {
          w.__details.turnInto.cancel(token)
          return true
        }
        return w.__details.turnInto.apply(token)
      },
      { token, outcome },
    )
    expect(applied).toBe(true)
    const posted = await page.evaluate(() =>
      (window as any).__details.turnInto.posted(),
    )
    if (outcome === 'apply') {
      const at = before.indexOf('Toolbar body **exact**.')
      expect(posted.posted).toEqual([
        `${before.slice(0, at)}## ${before.slice(at)}`,
      ])
    } else expect(posted.posted).toEqual([])
    expect(posted.errors).toBe(0)
    // Details resumes: selecting the toolbar body enables the pinned control again.
    await selectToolbarBody(page, 'sv')
    await expect(
      page.locator('.vditor-toolbar [data-type="details"]'),
    ).toBeEnabled()
  })
}
