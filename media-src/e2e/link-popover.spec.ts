import { expect, test } from './coverage-fixture'

function addVscodeStub(page: import('@playwright/test').Page) {
  return page.addInitScript(() => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (message: unknown) => (window as any).__posted.push(message),
      getState: () => undefined,
      setState: () => undefined,
    })
  })
}

test('default IR plain click opens a link popover without marker expansion or reflow', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const longUrl = `https://example.com/${'segment/'.repeat(35)}?q=${'long-value-'.repeat(18)}`
  const markdown = `Before [A long label](${longUrl} "kept title") after.\n`
  await page.evaluate(
    (value) => (window as any).vditor.setValue(value),
    markdown,
  )
  const link = page.locator('.vditor-ir .vditor-reset [data-type="a"]')
  await expect(link).toHaveCount(1)
  const paragraph = page.locator('.vditor-ir .vditor-reset p').first()
  const before = {
    exact: await page.evaluate(() => (window as any).vditor.getValue()),
    height: await paragraph.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  }

  // Real VS Code's pointerdown/selection path expands IR markers before click.
  // Model that earlier handler after the popover's capture listener to make the
  // user-visible no-reflow contract fail if pointerdown is not consumed.
  await page.evaluate(() => {
    document.addEventListener(
      'pointerdown',
      (event) => {
        const link = (event.target as Element).closest('[data-type="a"]')
        if (link && !event.defaultPrevented)
          link.classList.add('vditor-ir__node--expand')
      },
      true,
    )
  })
  await link.locator('.vditor-ir__link').click()

  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await expect(link).not.toHaveClass(/vditor-ir__node--expand/)
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before.exact,
  )
  expect(
    await paragraph.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBe(before.height)
  expect(
    await page.evaluate(() =>
      (window as any).__posted.filter(
        (message: any) => message.command === 'open-link',
      ),
    ),
  ).toEqual([])
})

test('second duplicate link edits only its URL and preserves both titles', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before =
    '[same](https://same.test/a "first") and [same](https://same.test/a "second")\n'
  const after =
    '[same](https://same.test/a "first") and [same](https://changed.test/b "second")\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  const links = page.locator('.vditor-ir .vditor-reset [data-type="a"]')
  await expect(links).toHaveCount(2)
  await links.nth(1).locator('.vditor-ir__link').click()
  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.test/b')
  await popover.getByRole('button', { name: 'Save' }).click()
  expect(await page.evaluate(() => (window as any).__postedLinkExact)).toBe(
    after,
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(after)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(before)
})

test('IR image Edit URL and Unlink preserve the exact selected alt source', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before =
    'Before ![first](https://same.test/a "one") and ![second **alt**](https://same.test/a "two") after.\n'
  const edited =
    'Before ![first](https://same.test/a "one") and ![second **alt**](https://changed.test/b "two") after.\n'
  const unlinked =
    'Before ![first](https://same.test/a "one") and second **alt** after.\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  const images = page.locator('.vditor-ir .vditor-reset [data-type="img"]')
  await expect(images).toHaveCount(2)
  await images.nth(1).locator('img').click()
  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.test/b')
  await popover.getByRole('button', { name: 'Save' }).click()
  expect(await page.evaluate(() => (window as any).__postedLinkExact)).toBe(
    edited,
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(edited)
  await images.nth(1).locator('img').click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Unlink' }).click()
  expect(await page.evaluate(() => (window as any).__postedLinkExact)).toBe(
    unlinked,
  )
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(unlinked)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(edited)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(before)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.redo(inner)
    inner.undo.redo(inner)
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(unlinked)
})

test('same-count duplicate titles cannot bind a changed exact source owner', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const rendered =
    '[same](https://same.test/a "first") and [same](https://same.test/a "second")\n'
  const otherOwner =
    '[same](https://same.test/a "second") and [same](https://same.test/a "first")\n'
  await page.evaluate(
    ({ rendered, otherOwner }) => {
      ;(window as any).vditor.setValue(rendered)
      ;(window as any).__linkExactSource = otherOwner
    },
    { rendered, otherOwner },
  )
  await page
    .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
    .last()
    .click()
  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Edit URL' })).toBeDisabled()
  await expect(popover.getByRole('button', { name: 'Unlink' })).toBeDisabled()
  expect(
    await page.evaluate(() => (window as any).__postedLinkExact),
  ).toBeUndefined()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    rendered,
  )
})

test('popover Open and Copy URL share the host route while modifier click keeps navigation', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before = 'Go [Docs](https://docs.example/path "title") here.\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  const label = page.locator('.vditor-ir [data-type="a"] .vditor-ir__link')
  const popover = page.locator('.vmde-link-popover')
  await label.click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Copy URL' }).click()
  expect(await page.evaluate(() => (window as any).__posted)).toContainEqual({
    command: 'copy-link-url',
    href: 'https://docs.example/path',
  })
  await label.click()
  await expect(popover).toBeVisible()
  await popover.getByRole('button', { name: 'Open', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__posted)).toContainEqual({
    command: 'open-link',
    href: 'https://docs.example/path',
  })
  const beforeModifier = await page.evaluate(
    () => (window as any).__posted.length,
  )
  await label.click({ modifiers: ['Control'] })
  await expect(popover).toBeHidden()
  expect(await page.evaluate(() => (window as any).__posted.length)).toBe(
    beforeModifier + 1,
  )
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})

test('stale source and composition cannot commit the popover URL input', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const label = page.locator('.vditor-ir [data-type="a"] .vditor-ir__link')
  const popover = page.locator('.vmde-link-popover')
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  await label.click()
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  const input = popover.getByRole('textbox', { name: 'URL' })
  await input.fill('https://new.example/path')
  await input.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    ),
  )
  await input.press('Enter')
  expect(
    await page.evaluate(() => (window as any).__postedLinkExact),
  ).toBeUndefined()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
  await input.evaluate((element) =>
    element.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  )
  await page.evaluate(() => (window as any).vditor.setValue('external edit\n'))
  await expect(popover).toBeHidden()
  expect(
    await page.evaluate(() => (window as any).__postedLinkExact),
  ).toBeUndefined()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    'external edit\n',
  )
})

test('long-link popover stays inside a narrow editor pane and clear of its label', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.setViewportSize({ width: 520, height: 720 })
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const url = `https://example.com/${'long-segment/'.repeat(25)}`
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    `Before [A label](${url}) after.\n`,
  )
  const label = page.locator('.vditor-ir [data-type="a"] .vditor-ir__link')
  await label.click()
  const popover = page.locator('.vmde-link-popover')
  await expect(popover).toBeVisible()
  const geometry = await popover.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const editor = document
      .querySelector('.vditor-content')!
      .getBoundingClientRect()
    const label = document
      .querySelector('.vditor-ir__link')!
      .getBoundingClientRect()
    return {
      panel: {
        left: panel.left,
        right: panel.right,
        top: panel.top,
        bottom: panel.bottom,
      },
      editor: {
        left: editor.left,
        right: editor.right,
        top: editor.top,
        bottom: editor.bottom,
      },
      label: {
        left: label.left,
        right: label.right,
        top: label.top,
        bottom: label.bottom,
      },
    }
  })
  expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.editor.left)
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.editor.right)
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.label.bottom + 2)
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.editor.bottom)
})

test('modifier click on a linked image keeps Vditor image-source Open policy', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before = '[![alt](https://image.test/a)](https://outer.test/page)\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  const image = page.locator('.vditor-ir [data-type="img"] img').first()
  await image.click({ modifiers: ['Control'] })
  expect(await page.evaluate(() => (window as any).__posted)).toContainEqual({
    command: 'open-link',
    href: 'https://image.test/a',
  })
  await expect(page.locator('.vmde-link-popover')).toBeHidden()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})

test('an unrelated rendered mutation rolls back the Link edit without posting exact source', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  const undoBefore = await page.evaluate(
    () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
  )
  await page.locator('.vditor-ir [data-type="a"] .vditor-ir__link').click()
  const popover = page.locator('.vmde-link-popover')
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.test/b')
  await page.evaluate(() => {
    const original = document.execCommand.bind(document)
    document.execCommand = ((command: string, ...args: unknown[]) => {
      const accepted = original(command, ...(args as [boolean, string]))
      if (command === 'insertText')
        document
          .querySelector('.vditor-ir .vditor-reset p')
          ?.append(' unrelated')
      return accepted
    }) as typeof document.execCommand
  })
  await popover.getByRole('button', { name: 'Save' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(before)
  expect(
    await page.evaluate(() => (window as any).__postedLinkExact),
  ).toBeUndefined()
  expect(
    await page.evaluate(() => (window as any).__linkPopoverError),
  ).toContain('diverged')
  expect(
    await page.evaluate(
      () => (window as any).vditor.vditor.undo.ir.undoStack.length,
    ),
  ).toBe(undoBefore)
})

test('a changed live editor selection during URL input cancels the retained target', async ({
  page,
}) => {
  await addVscodeStub(page)
  await page.goto('/link.html?mode=ir&policy=modifier')
  await page.waitForFunction(() => (window as any).__ready === true)
  const before = await page.evaluate(() => (window as any).vditor.getValue())
  await page.locator('.vditor-ir [data-type="a"] .vditor-ir__link').click()
  const popover = page.locator('.vmde-link-popover')
  await popover.getByRole('button', { name: 'Edit URL' }).click()
  await popover
    .getByRole('textbox', { name: 'URL' })
    .fill('https://changed.test/b')
  await page
    .locator('.vditor-ir .vditor-reset p')
    .first()
    .evaluate((paragraph) => {
      const text = Array.from(paragraph.childNodes).find(
        (node): node is Text =>
          node instanceof Text && node.data.includes('Click'),
      )!
      const range = document.createRange()
      range.setStart(text, 1)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  await expect(popover).toBeHidden()
  expect(
    await page.evaluate(() => (window as any).__postedLinkExact),
  ).toBeUndefined()
  expect(await page.evaluate(() => (window as any).vditor.getValue())).toBe(
    before,
  )
})
