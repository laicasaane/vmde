import { expect, test } from './coverage-fixture'

const INITIAL = 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n'
const MOVED = '```ts\nconst x = 1\n```\n\nalpha\n\nomega\n'

async function open(page: import('@playwright/test').Page) {
  await page.goto('/block-handle.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

function value(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => (window as any).vditor.getValue())
}

test('handle-originated drag moves a paragraph below a fence with one edit and undo', async ({
  page,
}) => {
  await open(page)
  expect(await value(page)).toBe(INITIAL)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  const geometry = await page.evaluate(() => {
    const block = document.querySelector('.vditor-ir .vditor-reset > p')!
    const handle = document.querySelector('.vmde-block-handle')!
    return {
      blockLeft: block.getBoundingClientRect().left,
      handleRight: handle.getBoundingClientRect().right,
      insideEditable: Boolean(handle.closest('.vditor-reset')),
    }
  })
  expect(geometry.handleRight).toBeLessThanOrEqual(geometry.blockLeft - 38)
  expect(geometry.insideEditable).toBe(false)
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
    if (
      (document.querySelector('.vmde-block-drop-indicator') as HTMLElement)
        .hidden
    )
      throw new Error('drop indicator missing')
    fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => value(page)).toBe(MOVED)
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
  await page.locator('.vditor-ir').click({ position: { x: 4, y: 4 } })
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => value(page)).toBe(INITIAL)
})

test('Alt+Down uses the same move and text/file drags remain independent', async ({
  page,
}) => {
  await open(page)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.click()
  await alpha.evaluate((element) => {
    const text = element.firstChild!
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => value(page)).toBe(MOVED)

  const fileResult = await page.evaluate(() => {
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'x.png', { type: 'image/png' }))
    const rect = fence.getBoundingClientRect()
    const over = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientY: rect.top + 1,
      dataTransfer: data,
    })
    fence.dispatchEvent(over)
    const indicator = !(
      document.querySelector('.vmde-block-drop-indicator') as HTMLElement
    ).hidden
    const drop = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientY: rect.top + 1,
      dataTransfer: data,
    })
    fence.dispatchEvent(drop)
    return {
      overPrevented: over.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
      indicator,
    }
  })
  expect(fileResult).toEqual({
    overPrevented: false,
    dropPrevented: true,
    indicator: true,
  })
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
})

test('handle click menu routes Turn Into, Duplicate and Delete by source identity', async ({
  page,
}) => {
  await open(page)
  const alpha = page.locator('.vditor-ir .vditor-reset > p').first()
  await alpha.hover()
  await page.locator('.vmde-block-handle').click()
  await expect(page.locator('.vmde-block-handle-menu')).toBeVisible()
  await page.locator('.vmde-block-handle-menu [data-action="turnInto"]').click()
  expect(await page.evaluate(() => (window as any).__blockHandleTurnInto)).toBe(
    0,
  )
  expect(await value(page)).toBe(INITIAL)

  await alpha.hover()
  await page.locator('.vmde-block-handle').click()
  await page
    .locator('.vmde-block-handle-menu [data-action="duplicate"]')
    .click()
  await expect.poll(() => value(page)).toContain('alpha\n\nalpha\n\n```ts')
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(1)
})

test('stale internal handle drop is consumed without editor mutation', async ({
  page,
}) => {
  await open(page)
  await page.locator('.vditor-ir .vditor-reset > p').first().hover()
  const outcome = await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    ;(window as any).vditor.setValue('external edit\n')
    const target = document.querySelector('.vditor-ir .vditor-reset > p')!
    const over = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    })
    target.dispatchEvent(over)
    const drop = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    })
    target.dispatchEvent(drop)
    return {
      overPrevented: over.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
    }
  })
  expect(outcome).toEqual({ overPrevented: true, dropPrevented: true })
  expect(await value(page)).toContain('external edit')
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(0)
})

test('heading handle moves the whole same-level section including body and child heading', async ({
  page,
}) => {
  await open(page)
  const before =
    '# Alpha\n\nalpha body\n\n## Child\n\nchild body\n\n# Beta\n\nbeta body\n'
  const after =
    '# Beta\n\nbeta body\n\n# Alpha\n\nalpha body\n\n## Child\n\nchild body\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  await expect.poll(() => value(page)).toBe(before)
  await page.locator('.vditor-ir .vditor-reset > h1').first().hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = document.querySelectorAll('.vditor-ir .vditor-reset > h1')[1]
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => value(page)).toBe(after)
})

test('narrow editor keeps a reachable handle outside the heading-fold hit region', async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 640 })
  await open(page)
  await page.evaluate(() =>
    (window as any).vditor.setValue('# Heading\n\nbody\n'),
  )
  const heading = page.locator('.vditor-ir .vditor-reset > h1').first()
  await heading.hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  const geometry = await page.evaluate(() => {
    const block = document
      .querySelector('.vditor-ir .vditor-reset > h1')!
      .getBoundingClientRect()
    const handle = document
      .querySelector('.vmde-block-handle')!
      .getBoundingClientRect()
    return {
      blockLeft: block.left,
      blockRight: block.right,
      handleLeft: handle.left,
      handleRight: handle.right,
      viewport: window.innerWidth,
    }
  })
  expect(geometry.handleLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.blockLeft).toBeLessThan(50)
  expect(geometry.handleLeft).toBeGreaterThanOrEqual(geometry.blockRight - 12)
  expect(geometry.handleRight).toBeLessThanOrEqual(geometry.viewport)
})

test('duplicate text uses the hovered second source occurrence', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() =>
    (window as any).vditor.setValue('same\n\nsame\n\nother\n'),
  )
  await page.locator('.vditor-ir .vditor-reset > p').nth(1).hover()
  await page.locator('.vmde-block-handle').click()
  await page.locator('.vmde-block-handle-menu [data-action="delete"]').click()
  await expect.poll(() => value(page)).toBe('same\n\nother\n')
  expect(
    await page.evaluate(() => (window as any).__blockHandleLastAction),
  ).toEqual({
    kind: 'delete',
    sourceStart: 6,
  })
})

test('hovering a nested child keeps the complete parent list item as the action target', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() =>
    (window as any).vditor.setValue('- parent\n  - child\n- sibling\n'),
  )
  await page.locator('.vditor-ir .vditor-reset > ul > li > ul > li').hover()
  await page.locator('.vmde-block-handle').click()
  await page
    .locator('.vmde-block-handle-menu [data-action="duplicate"]')
    .click()
  await expect
    .poll(() => value(page))
    .toBe('- parent\n  - child\n- parent\n  - child\n- sibling\n')
  expect(
    await page.evaluate(() => (window as any).__blockHandleLastAction),
  ).toEqual({
    kind: 'duplicate',
    sourceStart: 0,
  })
})

test('paired details uses one opening handle and moves the full enclosure', async ({
  page,
}) => {
  await open(page)
  const before =
    'A\n\n<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n\nB\n'
  const after =
    'A\n\nB\n\n<details>\n<summary>Sum</summary>\n\nbody\n\n</details>\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  const htmlBlocks = page.locator(
    '.vditor-ir .vditor-reset > [data-type="html-block"]',
  )
  await expect(htmlBlocks).toHaveCount(2)
  await htmlBlocks.first().hover()
  const handle = page.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .filter({ hasText: 'body' })
    .hover()
  await expect(handle).toBeHidden()
  await htmlBlocks.last().hover()
  await expect(handle).toBeHidden()
  await htmlBlocks.first().hover()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = Array.from(
      document.querySelectorAll('.vditor-ir .vditor-reset > p'),
    ).find((p) => p.textContent?.trim() === 'B')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => value(page)).toBe(after)
})

test('lazy list and quote continuations move as complete exact source groups', async ({
  page,
}) => {
  await open(page)
  const list = '- first\nlazy continuation\n- second\n'
  await page.evaluate((source) => {
    ;(window as any).__blockHandleExactInput = source
    ;(window as any).vditor.setValue(source)
  }, list)
  await page.locator('.vditor-ir .vditor-reset > ul > li').first().hover()
  await expect(page.locator('.vmde-block-handle')).toBeVisible()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = document.querySelectorAll(
      '.vditor-ir .vditor-reset > ul > li',
    )[1]
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__blockHandleExact))
    .toBe('- second\n- first\nlazy continuation\n')

  const quote = '> first\nlazy continuation\n> last\n\nB\n'
  await page.evaluate((source) => {
    ;(window as any).__blockHandleExactInput = source
    ;(window as any).vditor.setValue(source)
  }, quote)
  await page.locator('.vditor-ir .vditor-reset > blockquote').hover()
  await expect(page.locator('.vmde-block-handle')).toBeVisible()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = Array.from(
      document.querySelectorAll('.vditor-ir .vditor-reset > p'),
    ).find((p) => p.textContent?.trim() === 'B')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__blockHandleExact))
    .toBe('B\n\n> first\nlazy continuation\n> last\n')
})

test('nested details exposes one outer handle and carries the complete enclosure', async ({
  page,
}) => {
  await open(page)
  const before =
    'A\n\n<details>\n<summary>Outer</summary>\n\nouter\n\n<details>\n<summary>Inner</summary>\n\ninner\n\n</details>\n\n</details>\n\nB\n'
  await page.evaluate((source) => {
    ;(window as any).__blockHandleExactInput = source
    ;(window as any).vditor.setValue(source)
  }, before)
  const htmlBlocks = page.locator(
    '.vditor-ir .vditor-reset > [data-type="html-block"]',
  )
  await expect(htmlBlocks).toHaveCount(4)
  await htmlBlocks.first().hover()
  await expect(page.locator('.vmde-block-handle')).toBeVisible()
  await htmlBlocks.nth(1).hover()
  await expect(page.locator('.vmde-block-handle')).toBeHidden()
  await htmlBlocks.first().hover()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = Array.from(
      document.querySelectorAll('.vditor-ir .vditor-reset > p'),
    ).find((p) => p.textContent?.trim() === 'B')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  const group = before.slice(
    before.indexOf('<details>'),
    before.lastIndexOf('</details>') + '</details>'.length,
  )
  expect(await page.evaluate(() => (window as any).__blockHandleExact)).toBe(
    `A\n\nB\n\n${group}\n`,
  )
})

test('all seven raw HTML classes keep one source-owned handle and exact move', async ({
  page,
}) => {
  await open(page)
  const htmlBlocks = [
    '<script>\n# marker\n</script>',
    '<!--\n- marker\n-->',
    '<?pi\n> marker\n?>',
    '<!DOCTYPE html>',
    '<![CDATA[\n# marker\n]]>',
    '<div>\n# marker\n</div>',
    '<custom>\ntext\n</custom>',
  ]
  for (const html of htmlBlocks) {
    const before = `A\n\n${html}\n\nB\n`
    await page.evaluate((source) => {
      ;(window as any).__blockHandleExactInput = source
      ;(window as any).vditor.setValue(source)
    }, before)
    await page
      .locator('.vditor-ir .vditor-reset > [data-type="html-block"]')
      .hover()
    await expect(page.locator('.vmde-block-handle')).toBeVisible()
    await page.evaluate(() => {
      const handle = document.querySelector('.vmde-block-handle')!
      const target = Array.from(
        document.querySelectorAll('.vditor-ir .vditor-reset > p'),
      ).find((p) => p.textContent?.trim() === 'B')!
      const data = new DataTransfer()
      handle.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
      )
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientY: rect.bottom - 1,
          dataTransfer: data,
        }),
      )
    })
    await expect
      .poll(() => page.evaluate(() => (window as any).__blockHandleExact))
      .toBe(`A\n\nB\n\n${html}\n`)
  }
})

test('loose list item carries its blank and continuation paragraph across siblings', async ({
  page,
}) => {
  await open(page)
  const before = '- first\n\n  continuation\n\n- second\n'
  await page.evaluate((source) => {
    ;(window as any).__blockHandleExactInput = source
    ;(window as any).vditor.setValue(source)
  }, before)
  const items = page.locator('.vditor-ir .vditor-reset > ul > li')
  await expect(items).toHaveCount(2)
  await items.first().hover()
  await expect(page.locator('.vmde-block-handle')).toBeVisible()
  await page.evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = document.querySelectorAll(
      '.vditor-ir .vditor-reset > ul > li',
    )[1]
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect
    .poll(() => page.evaluate(() => (window as any).__blockHandleExact))
    .toBe('- second\n\n- first\n\n  continuation\n')
})

test('paired div and custom HTML enclosures each expose one complete-group handle', async ({
  page,
}) => {
  await open(page)
  for (const tag of ['div', 'custom']) {
    const before = `A\n\n<${tag}>\n\nbody\n\n</${tag}>\n\nB\n`
    await page.evaluate((source) => {
      ;(window as any).__blockHandleExactInput = source
      ;(window as any).vditor.setValue(source)
    }, before)
    const html = page.locator(
      '.vditor-ir .vditor-reset > [data-type="html-block"]',
    )
    await expect(html).toHaveCount(2)
    await html.first().hover()
    await expect(page.locator('.vmde-block-handle')).toBeVisible()
    await page
      .locator('.vditor-ir .vditor-reset > p')
      .filter({ hasText: 'body' })
      .hover()
    await expect(page.locator('.vmde-block-handle')).toBeHidden()
    await html.first().hover()
    await page.evaluate(() => {
      const handle = document.querySelector('.vmde-block-handle')!
      const target = Array.from(
        document.querySelectorAll('.vditor-ir .vditor-reset > p'),
      ).find((p) => p.textContent?.trim() === 'B')!
      const data = new DataTransfer()
      handle.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
      )
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientY: rect.bottom - 1,
          dataTransfer: data,
        }),
      )
    })
    await expect
      .poll(() => page.evaluate(() => (window as any).__blockHandleExact))
      .toBe(`A\n\nB\n\n<${tag}>\n\nbody\n\n</${tag}>\n`)
  }
})

test('mismatched HTML enclosure declines without a fragment handle or source edit', async ({
  page,
}) => {
  await open(page)
  const source = 'A\n\n<div>\n\nbody\n\n</section>\n\nB\n'
  await page.evaluate((markdown) => {
    ;(window as any).__blockHandleExactInput = markdown
    ;(window as any).vditor.setValue(markdown)
  }, source)
  await page
    .locator('.vditor-ir .vditor-reset > p')
    .filter({ hasText: 'A' })
    .hover()
  await expect(page.locator('.vmde-block-handle')).toBeHidden()
  expect(await page.evaluate(() => (window as any).__blockHandlePosts)).toBe(0)
})
