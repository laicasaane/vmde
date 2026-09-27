import { expect, test } from './coverage-fixture'

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`caret class keeps ${mode} link source, history and warm index unchanged and paints in every contrast mode`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      ;(window as any).acquireVsCodeApi = () => ({
        postMessage: () => undefined,
        getState: () => undefined,
        setState: () => undefined,
      })
    })
    await page.goto(`/link.html?mode=${mode}&policy=modifier`)
    await page.waitForFunction(() => (window as any).__ready === true)
    const root = page.locator(`.vditor-${mode} .vditor-reset`)
    const link = root.locator(mode === 'ir' ? '.vditor-ir__link' : 'a[href]')
    const before = await page.evaluate(() => {
      const win = window as any
      const inner = win.vditor.vditor
      const history = inner.undo[inner.currentMode]
      win.__caretWarmEntry = win.__linkSourceIndex.read()
      return {
        source: win.vditor.getValue(),
        undo: history.undoStack.length,
        redo: history.redoStack.length,
      }
    })
    // A DOM Range isolates decoration from marker expansion. The real-VS-Code
    // companion supplies XTEST keyboard acceptance; no browser key is claimed here.
    await link.evaluate((element) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 1)
      range.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await expect(link).toHaveClass(/vmde-caret-inside/)
    await link.click()
    await expect(link).toHaveClass(/vmde-caret-inside/)
    const paint = () =>
      link.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          style: style.outlineStyle,
          width: style.outlineWidth,
          offset: style.outlineOffset,
        }
      })
    await expect
      .poll(paint)
      .toEqual({ style: 'solid', width: '1px', offset: '1px' })
    for (const theme of [
      'vscode-high-contrast',
      'vscode-high-contrast-light',
    ]) {
      await page.evaluate((name) => document.body.classList.add(name), theme)
      await expect
        .poll(paint)
        .toEqual({ style: 'solid', width: '3px', offset: '2px' })
      await page.evaluate((name) => document.body.classList.remove(name), theme)
    }
    await page.emulateMedia({ forcedColors: 'active' })
    await expect
      .poll(paint)
      .toEqual({ style: 'solid', width: '3px', offset: '2px' })
    await page.emulateMedia({ forcedColors: 'none' })
    await root.locator('p').evaluate((paragraph) => {
      const range = document.createRange()
      range.setStart(paragraph.lastChild!, 1)
      range.collapse(true)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await expect(link).not.toHaveClass(/vmde-caret-inside/)
    const after = await page.evaluate(() => {
      const win = window as any
      const inner = win.vditor.vditor
      const history = inner.undo[inner.currentMode]
      return {
        source: win.vditor.getValue(),
        undo: history.undoStack.length,
        redo: history.redoStack.length,
        sameEntry: win.__linkSourceIndex.read() === win.__caretWarmEntry,
      }
    })
    expect(after).toEqual({ ...before, sameEntry: true })
  })
}
