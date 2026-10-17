import { expect, test } from './coverage-fixture'

// Task 651 (acceptance 1, 2, 6): the real Preview button click posts the state, `?previewOn=1`
// (the host's `openInPreview` init option) shows Preview before the first painted frame and a
// toggle off restores the stored edit-mode layout, rule-driven opens post nothing, and a toggle
// never touches the document, Undo depth, selection or the input (dirty) signal.

const BUTTON = '.vditor-toolbar button[data-type="preview"]'

async function open(page: import('@playwright/test').Page, query: string) {
  await page.goto(`/preview-memory.html${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
}

const posts = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__previewPosts as unknown[])

const layout = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    const mode = inner.currentMode as 'ir' | 'wysiwyg' | 'sv'
    const pane =
      mode === 'sv' ? inner.sv.element : inner[mode].element.parentElement
    return {
      mode,
      paneDisplay: getComputedStyle(pane).display,
      previewDisplay: getComputedStyle(inner.preview.element).display,
      current: document
        .querySelector('.vditor-toolbar button[data-type="preview"]')
        ?.classList.contains('vditor-menu--current'),
    }
  })

test('a user click on the Preview button posts on:true then on:false', async ({
  page,
}) => {
  await open(page, '')
  await page.locator(BUTTON).click()
  expect(await posts(page)).toEqual([
    { command: 'save-preview-state', on: true },
  ])
  expect((await layout(page)).current).toBe(true)

  await page.locator(BUTTON).click()
  expect(await posts(page)).toEqual([
    { command: 'save-preview-state', on: true },
    { command: 'save-preview-state', on: false },
  ])
  expect((await layout(page)).current).toBe(false)
})

for (const mode of ['ir', 'sv'] as const) {
  test(`previewOn opens Preview at first paint over ${mode} without posting, and toggling off restores the layout`, async ({
    page,
  }) => {
    await open(page, `?previewOn=1&mode=${mode}`)
    // Ready is set in the same synchronous block as the open, so this is the state of the first
    // painted frame: Preview up, edit pane hidden.
    const first = await layout(page)
    expect(first.mode).toBe(mode)
    expect(first.current).toBe(true)
    expect(first.previewDisplay).toBe('block')
    expect(first.paneDisplay).toBe('none')
    // The rule-driven / remembered open itself is not stored.
    expect(await posts(page)).toEqual([])

    await page.locator(BUTTON).click()
    expect(await posts(page)).toEqual([
      { command: 'save-preview-state', on: false },
    ])
    const restored = await layout(page)
    expect(restored.current).toBe(false)
    expect(restored.mode).toBe(mode)
    expect(restored.paneDisplay).toBe('block')
    // Split keeps its rendered pane beside the source; IR hides the overlay.
    expect(restored.previewDisplay).toBe(mode === 'sv' ? 'block' : 'none')
  })
}

test('toggling Preview on and off leaves text, Undo depth, selection and the input signal unchanged', async ({
  page,
}) => {
  await open(page, '')
  await page.evaluate(() => {
    const p = document.querySelector(
      '.vditor-ir .vditor-reset > p',
    ) as HTMLElement
    const range = document.createRange()
    range.setStart(p.firstChild as Text, 0)
    range.setEnd(p.firstChild as Text, 5)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  const snapshot = () =>
    page.evaluate(() => {
      const v = (window as any).vditor
      return {
        value: v.getValue(),
        undo: v.vditor.undo.ir.undoStack.length,
        selection: getSelection()?.toString(),
        inputs: (window as any).__inputs.length,
      }
    })
  const before = await snapshot()
  expect(before.selection).toBe('first')

  await page.locator(BUTTON).click()
  await page.locator(BUTTON).click()

  expect(await snapshot()).toEqual(before)
})
