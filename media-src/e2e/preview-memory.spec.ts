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

// Task 652 (acceptance 1-3): the editor selection survives a Preview on and off cycle in IR,
// WYSIWYG and Split source, a dispatched click behaves like a real one, and an older caret intent
// cannot overwrite the restored selection. `?caret=1` wires the caret authority, focus-restore and
// the selection tracker as main.ts does.
test.describe('caret restore', () => {
  type Page = import('@playwright/test').Page

  async function openCaret(page: Page, mode: string) {
    await page.goto(`/preview-memory.html?caret=1&mode=${mode}`)
    await page.waitForFunction(() => (window as any).__ready === true)
  }

  // Select across the whole editor text (directional: anchor after focus) or a collapsed caret.
  const place = (page: Page, collapsed: boolean) =>
    page.evaluate((isCollapsed) => {
      const v = (window as any).vditor.vditor
      const editor = v[v.currentMode].element as HTMLElement
      editor.focus()
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      const texts: Text[] = []
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if ((n as Text).data.length > 0) texts.push(n as Text)
      const first = texts[0]
      const last = texts[texts.length - 1]
      const sel = getSelection() as Selection
      if (isCollapsed) sel.setBaseAndExtent(first, 3, first, 3)
      else sel.setBaseAndExtent(last, Math.min(4, last.data.length), first, 2)
    }, collapsed)

  const state = (page: Page) =>
    page.evaluate(() => {
      const v = (window as any).vditor.vditor
      const editor = v[v.currentMode].element as HTMLElement
      const sel = getSelection() as Selection
      const offset = (node: Node | null, o: number) => {
        if (!node || !editor.contains(node)) return null
        const r = document.createRange()
        r.selectNodeContents(editor)
        r.setEnd(node, o)
        return r.toString().length
      }
      return {
        anchor: offset(sel.anchorNode, sel.anchorOffset),
        focus: offset(sel.focusNode, sel.focusOffset),
        text: sel.toString(),
        collapsed: sel.isCollapsed,
        inEditor: editor.contains(document.activeElement),
      }
    })

  const doc = (page: Page) =>
    page.evaluate(() => ({
      value: (window as any).vditor.getValue() as string,
      inputs: (window as any).__inputs.length as number,
    }))

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a real click cycle returns the directional selection, focus and Markdown`, async ({
      page,
    }) => {
      await openCaret(page, mode)
      await place(page, false)
      const before = await state(page)
      const docBefore = await doc(page)
      expect(before.collapsed).toBe(false)
      expect(before.anchor).toBeGreaterThan(before.focus as number)
      expect(before.inEditor).toBe(true)

      await page.locator(BUTTON).click()
      await page.locator(BUTTON).click()
      // The authority re-asserts per frame; two frames are enough for any stray write to land.
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      )

      expect(await state(page)).toEqual(before)
      expect(await doc(page)).toEqual(docBefore)
    })

    test(`${mode}: a dispatched click cycle returns the same collapsed caret`, async ({
      page,
    }) => {
      await openCaret(page, mode)
      await place(page, true)
      const before = await state(page)

      await page.evaluate(() => {
        const b = document.querySelector(
          '.vditor-toolbar button[data-type="preview"]',
        ) as HTMLElement
        b.click()
        b.click()
      })
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      )

      expect(before.collapsed).toBe(true)
      expect(await state(page)).toEqual(before)
    })
  }

  test('a selection made in the overlay does not replace the editor selection on return', async ({
    page,
  }) => {
    await openCaret(page, 'ir')
    await place(page, false)
    const before = await state(page)

    await page.locator(BUTTON).click()
    await page.evaluate(() => {
      const preview = (window as any).vditor.vditor.preview
        .element as HTMLElement
      const text = document
        .createTreeWalker(preview, NodeFilter.SHOW_TEXT)
        .nextNode() as Text
      getSelection()?.setBaseAndExtent(text, 0, text, 3)
    })
    await page.locator(BUTTON).click()
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    )

    expect(await state(page)).toEqual(before)
  })

  test('an older caret intent cannot overwrite the restored selection (Task 649 interplay)', async ({
    page,
  }) => {
    await openCaret(page, 'ir')
    // One synchronous block, so no animation frame lets the older intent run before the cycle (a
    // real click's pointerdown would retire it too): arm the intent, set a range the authority
    // does not know about, snapshot it, then toggle Preview on and off with dispatched clicks.
    const before = await page.evaluate(() => {
      const v = (window as any).vditor.vditor
      const editor = v[v.currentMode].element as HTMLElement
      editor.focus()
      ;(window as any).__vmdeRequestCaret({ textOffset: 3 })
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      const first = walker.nextNode() as Text
      const sel = getSelection() as Selection
      sel.setBaseAndExtent(first, 8, first, 2)
      const snap = { text: sel.toString(), collapsed: sel.isCollapsed }
      const b = document.querySelector(
        '.vditor-toolbar button[data-type="preview"]',
      ) as HTMLElement
      b.click()
      b.click()
      return snap
    })
    await page.evaluate(() => window.dispatchEvent(new Event('resize')))
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    )
    await page.waitForTimeout(150)

    expect(before.collapsed).toBe(false)
    const after = await state(page)
    expect(after.text).toBe(before.text)
    expect(after.collapsed).toBe(false)
    expect(after.inEditor).toBe(true)
  })
})
