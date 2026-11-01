import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Task 643 (acceptance 1, 2, 5, 6, 7, 8 in Chromium): Preview is its own mode. The real boot/main
// runs against a stubbed host; a Preview rule or remembered Preview builds no edit view, streams a
// large document, renders far diagrams only when scrolled near, and keeps its features.

interface Init {
  content: string
  options?: Record<string, unknown>
}

async function open(page: Page, init: Init) {
  await page.addInitScript(
    (message) => {
      ;(window as any).__posts = [] as unknown[]
      // Long tasks after the first Preview content is visible are the streaming limit.
      ;(window as any).__longTasks = [] as Array<[number, number]>
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          (window as any).__longTasks.push([entry.startTime, entry.duration])
      }).observe({ entryTypes: ['longtask'] })
      ;(window as any).acquireVsCodeApi = () => ({
        postMessage: (m: any) => {
          ;(window as any).__posts.push(m)
          if (m && m.command === 'ready') window.postMessage(message, '*')
        },
        getState: () => undefined,
        setState: () => {
          /* state persistence unused in this spec */
        },
      })
    },
    {
      command: 'update',
      type: 'init',
      content: init.content,
      cdn: '/vditor',
      options: {
        showToolbar: true,
        useVscodeThemeColor: true,
        defaultMode: 'preview',
        interactivePreviewCheckboxes: true,
        restorePosition: false,
        ...init.options,
      },
      theme: 'dark',
      wiki: { enabled: false },
    },
  )
  await page.goto('/preview-mode.html', { waitUntil: 'domcontentloaded' })
}

const PREVIEW_BUTTON = '.vditor-toolbar button[data-type="preview"]'
const PANE = '.vditor-preview .vditor-reset'

const previewShown = (page: Page) =>
  page.waitForFunction(
    () => {
      const preview = document.querySelector<HTMLElement>('.vditor-preview')
      return (
        !!preview &&
        getComputedStyle(preview).display === 'block' &&
        !!document.querySelector('.vditor-preview .vditor-reset > *')
      )
    },
    undefined,
    { timeout: 30_000 },
  )

// Vditor renders one empty paragraph for an empty value, so "no edit view" is no text, not no nodes.
const editTextLength = (page: Page) =>
  page.evaluate(
    () =>
      document
        .querySelector('#app .vditor-ir pre.vditor-reset')
        ?.textContent?.replace(/[^\p{L}\p{N}]/gu, '').length ?? -1,
  )

const posted = (page: Page, command: string) =>
  page.evaluate(
    (name) =>
      ((window as any).__posts as Array<{ command: string }>).filter(
        (m) => m.command === name,
      ),
    command,
  )

const prose = (count: number, label = 'paragraph') =>
  Array.from(
    { length: count },
    (_, index) =>
      `${label} ${index} has enough words to occupy a line of the rendered preview for a while.`,
  ).join('\n\n')

test('a Preview rule builds no edit view; leaving Preview builds it, with no edit posted', async ({
  page,
}) => {
  await open(page, {
    content:
      '# Hello world\n\nA paragraph.\n\n- [ ] task one\n\n```ts\nconst a = 1\n```\n',
  })
  await previewShown(page)
  await expect(page.locator(`${PANE} h1`)).toHaveText('Hello world')
  // The code block gets its copy button from the cheap per-chunk passes.
  await expect(page.locator(`${PANE} pre .vditor-copy`)).toHaveCount(1)
  expect(await editTextLength(page)).toBe(0)
  expect(await posted(page, 'history-base')).toEqual([])

  await page.locator(PREVIEW_BUTTON).click()
  await page.waitForFunction(
    () =>
      (document
        .querySelector('#app .vditor-ir pre.vditor-reset')
        ?.textContent?.replace(/[^\p{L}\p{N}]/gu, '').length ?? 0) > 0,
  )
  await expect(page.locator('.vditor-ir h1')).toContainText('Hello world')
  await page.waitForTimeout(600)
  // Building the edit view is not an edit: nothing reaches the host as one.
  expect(await posted(page, 'edit')).toEqual([])
  // The undo base the built edit view reports is the document, not the empty shell.
  const bases = (await posted(page, 'history-base')) as Array<{
    content: string
  }>
  for (const base of bases) expect(base.content).toContain('Hello world')
})

test('a large document streams into Preview: content before completion, no long task over 100 ms, no edit view', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const content = `# Big document\n\n${prose(9000)}\n`
  expect(content.length).toBeGreaterThan(700_000)
  await open(page, { content })
  await previewShown(page)
  const early = await page.evaluate(() => ({
    children: document.querySelectorAll('.vditor-preview .vditor-reset > *')
      .length,
    complete: (window as any).__vmdeOpenMetrics?.completeMs,
  }))
  expect(early.children).toBeGreaterThan(0)
  expect(early.complete).toBeUndefined()
  await page.waitForFunction(
    () => typeof (window as any).__vmdeOpenMetrics?.completeMs === 'number',
    undefined,
    { timeout: 90_000 },
  )
  const result = await page.evaluate(() => ({
    children: document.querySelectorAll('.vditor-preview .vditor-reset > *')
      .length,
    metrics: (window as any).__vmdeOpenMetrics,
    longTasks: (window as any).__longTasks as Array<[number, number]>,
  }))
  expect(result.children).toBeGreaterThan(early.children)
  expect(result.metrics.previewChunks).toBeGreaterThan(10)
  expect(result.metrics.contentVisibleMs).toBeLessThan(
    result.metrics.completeMs,
  )
  // Every task from the first visible chunk to the end of the stream is held to the limit.
  const during = result.longTasks.filter(
    ([start]) => start >= result.metrics.contentVisibleMs,
  )
  expect(
    Math.max(0, ...during.map(([, duration]) => duration)),
    JSON.stringify({ during, all: result.longTasks, metrics: result.metrics }),
  ).toBeLessThanOrEqual(100)
  expect(await editTextLength(page)).toBe(0)
})

test('a far diagram renders only when it is scrolled near', async ({
  page,
}) => {
  const content = `# Diagrams\n\n${prose(80)}\n\n\`\`\`mermaid\ngraph LR; far-->diagram\n\`\`\`\n\n${prose(20, 'tail')}\n`
  await open(page, { content })
  await previewShown(page)
  const block = page.locator(`${PANE} .language-mermaid`)
  await expect(block).toHaveAttribute('data-vmde-preview-pending', 'true')
  expect(await block.locator('svg').count()).toBe(0)
  await block.scrollIntoViewIfNeeded()
  await expect(block).not.toHaveAttribute('data-vmde-preview-pending', 'true')
  await expect(block.locator('svg')).toHaveCount(1, { timeout: 30_000 })
})

test('Preview features: checkbox request, link click, outline navigation', async ({
  page,
}) => {
  const content = [
    '# Top',
    '',
    '- [ ] first task',
    '',
    'A [link](https://example.com/x) here.',
    '',
    prose(60),
    '',
    '## Lower section',
    '',
    'End.',
    '',
  ].join('\n')
  await open(page, { content, options: { outlineOpen: true } })
  await previewShown(page)

  await page
    .locator(`${PANE} li.vditor-task input[type="checkbox"]`)
    .first()
    .click()
  await expect
    .poll(
      async () => (await posted(page, 'toggle-preview-task-checkbox')).length,
    )
    .toBe(1)

  const prevented = await page
    .locator(`${PANE} a[href]`)
    .first()
    .evaluate((a) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      a.dispatchEvent(event)
      return event.defaultPrevented
    })
  expect(prevented).toBe(true)

  // Activating an outline item (keyboard, the VMDE-owned path) scrolls the Preview heading into view.
  const item = page
    .locator('.vditor-outline__content li > span[data-target-id]', {
      hasText: 'Lower section',
    })
    .first()
  await item.focus()
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const heading = [
          ...document.querySelectorAll('.vditor-preview h2'),
        ].find((h) => h.textContent?.includes('Lower section')) as HTMLElement
        const top = heading.getBoundingClientRect().top
        return top >= 0 && top < window.innerHeight
      }),
    )
    .toBe(true)
})

test('Find in Preview highlights and navigates; Replace is unavailable', async ({
  page,
}) => {
  const content = `# Find\n\nneedle one\n\n${prose(80)}\n\nneedle two\n`
  await open(page, { content })
  await previewShown(page)
  await page.evaluate(() =>
    window.postMessage({ command: 'open-find-replace', mode: 'replace' }, '*'),
  )
  const root = page.locator('.vmde-find-replace')
  await expect(root).toBeVisible()
  await expect(root.locator('.vmde-find-replace__row[hidden]')).toHaveCount(1)
  await expect(root.locator('[data-action="toggle-replace"]')).toBeDisabled()

  await root.locator('[data-find]').fill('needle')
  await expect(root.locator('[role="status"]')).toHaveText('1 of 2')
  await expect(page.locator('.vmde-find-overlay').first()).toBeVisible()

  await root.locator('[data-find]').press('Enter')
  await expect(root.locator('[role="status"]')).toHaveText('2 of 2')
  // The second match is far down: reaching it scrolls the Preview, so its painted highlight is on screen.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const current = document.querySelector('.vmde-find-overlay--current')
        if (!current) return false
        const top = current.getBoundingClientRect().top
        return top >= 0 && top < window.innerHeight
      }),
    )
    .toBe(true)

  const before = await page.locator(PANE).innerText()
  await page.keyboard.press('Control+Alt+Enter')
  expect(await page.locator(PANE).innerText()).toBe(before)
  expect(await posted(page, 'edit')).toEqual([])
})

test('switching to an edit mode and back keeps the section in view and changes no document state', async ({
  page,
}) => {
  const sections = Array.from(
    { length: 40 },
    (_, i) => `## Section ${i}\n\n${prose(4, `s${i}`)}`,
  ).join('\n\n')
  await open(page, { content: `# Doc\n\n${sections}\n` })
  await previewShown(page)
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.vditor-preview h2')].find(
      (h) => h.textContent === 'Section 25',
    ) as HTMLElement
    heading.scrollIntoView({ block: 'start' })
  })
  await page.waitForTimeout(300)
  await page.locator(PREVIEW_BUTTON).click()
  await page.waitForFunction(
    () =>
      (document
        .querySelector('#app .vditor-ir pre.vditor-reset')
        ?.textContent?.replace(/[^\p{L}\p{N}]/gu, '').length ?? 0) > 0,
  )
  await page.waitForTimeout(1200)
  const offset = await page.evaluate(() => {
    const heading = [...document.querySelectorAll('.vditor-ir h2')].find((h) =>
      h.textContent?.includes('Section 25'),
    ) as HTMLElement
    return heading.getBoundingClientRect().top
  })
  // Section 25 is within the viewport after the switch (it was at the top of Preview).
  expect(offset).toBeGreaterThanOrEqual(-50)
  expect(offset).toBeLessThan(500)
  expect(await posted(page, 'edit')).toEqual([])
})
