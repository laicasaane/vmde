// Task 640: the shared boot of the wrap-hint Chromium specs - the real webview entry (main.ts)
// answered with an `init` message, a copy recorder, and the Undo/Redo route of VS Code's keys.
import type { Page } from '@playwright/test'

export type Mode = 'ir' | 'wysiwyg'

export async function openEditor(
  page: Page,
  mode: Mode,
  content: string,
  width = 1280,
) {
  const init = {
    command: 'update',
    type: 'init',
    content,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: mode },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript((message) => {
    const win = window as any
    win.__posted = []
    win.__copied = []
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        win.__posted.push(posted)
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
    const setData = DataTransfer.prototype.setData
    DataTransfer.prototype.setData = function (type: string, value: string) {
      win.__copied.push([type, String(value)])
      return setData.call(this, type, value)
    }
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    (target) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === target
      )
    },
    mode,
    { timeout: 20_000 },
  )
  await page.waitForFunction(
    () => {
      const inner = (window as any).vditor.vditor
      return inner.undo[inner.currentMode].undoStack.length >= 1
    },
    undefined,
    { timeout: 20_000 },
  )
  return init
}

export async function toPreview(page: Page) {
  await page.evaluate(() => {
    const v = (window as any).vditor.vditor
    v.preview.element.style.display = 'block'
    v[v.currentMode].element.parentElement.style.display = 'none'
    v.preview.render(v)
  })
  await page.locator('.vditor-preview p').first().waitFor()
}

export const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

// The Undo/Redo route of VS Code's keys: the keydown reaches the webview, then the command posts this.
export async function postHistory(page: Page, name: 'undo' | 'redo') {
  await page.keyboard.down('Control')
  await page.evaluate((command) => {
    window.postMessage(
      { command: 'trigger-toolbar-hotkey', name: command },
      '*',
    )
  }, name)
  await page.keyboard.up('Control')
}
