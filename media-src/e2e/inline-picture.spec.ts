import { expect, test } from './coverage-fixture'
import type { Page } from '@playwright/test'

async function gotoBehaviors(page: Page) {
  await page.addInitScript(() => {
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: () => undefined,
      getState: () => undefined,
      setState: () => undefined,
    })
  })
  await page.goto('/behaviors.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

test('Insert picture creates one escaped source transaction, preserves the stored range, and cancels without mutation', async ({
  page,
}) => {
  await gotoBehaviors(page)
  const result = await page.evaluate(() => {
    const editor = document.createElement('p')
    editor.contentEditable = 'true'
    editor.textContent = 'before after'
    document.body.append(editor)
    const text = editor.firstChild!
    const range = document.createRange()
    range.setStart(text, 7)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const inserts: string[] = []
    ;(window as any).vditor = {
      getCurrentMode: () => 'ir',
      getValue: () => 'before after',
      focus: () => undefined,
      insertValue: (value: string) => inserts.push(value),
      vditor: { ir: { element: editor, range } },
    }
    const dispose = (
      window as any
    ).__inlinePicture.installInlinePictureInsertion()
    document.dispatchEvent(new Event('vmde-insert-picture'))
    const dialog = document.querySelector<HTMLFormElement>(
      '[data-vmde-picture-dialog]',
    )!
    ;(dialog.elements.namedItem('fallback') as HTMLInputElement).value =
      'images/light.png'
    ;(dialog.elements.namedItem('alt') as HTMLInputElement).value = 'A "light"'
    ;(dialog.elements.namedItem('dark') as HTMLInputElement).value =
      'https://cdn.example.test/dark.webp'
    dialog.requestSubmit()
    document.dispatchEvent(new Event('vmde-insert-picture'))
    document
      .querySelector<HTMLFormElement>('[data-vmde-picture-dialog]')!
      .querySelector<HTMLButtonElement>('[data-vmde-picture-cancel]')!
      .click()
    dispose()
    return {
      inserts,
      dialogs: document.querySelectorAll('[data-vmde-picture-dialog]').length,
    }
  })

  expect(result).toEqual({
    inserts: [
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.example.test/dark.webp"><img src="images/light.png" alt="A &quot;light&quot;"></picture>',
    ],
    dialogs: 0,
  })
})
