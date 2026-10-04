import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

/**
 * E2e for IR/WYSIWYG link-click behaviour (task 62), driven by the configurable
 * link-open policy:
 *   - 'modifier' (default): a PLAIN click does NOT follow the link (no `open-link`
 *     → caret stays for editing); a Ctrl/Cmd+click DOES follow it.
 *   - 'click' (legacy): a plain click follows the link.
 * Exactly one `open-link` is posted when following (no double-post across the IR/
 * WYSIWYG patch + fixLinkClick). The harness records posts on window.__posted.
 */
const HREF = 'https://example.com/page'

async function gotoLink(
  page: Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
  policy: 'modifier' | 'click' = 'modifier',
) {
  await page.addInitScript(() => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => (window as any).__posted.push(m),
      getState: () => undefined,
      setState: () => {
        /* vscode API stub: state persistence unused in this spec */
      },
    })
  })
  await page.goto(`/link.html?mode=${mode}&policy=${policy}`)
  await page.waitForFunction(() => (window as any).__ready === true)
}

// Dispatch a bubbling click (optionally with Ctrl) on the link node, then return
// the open-link hrefs posted to the host.
async function clickLinkHrefs(page: Page, mode: string, ctrl: boolean) {
  return page.evaluate(
    ({ mode, ctrl }) => {
      ;(window as any).__posted = []
      const node =
        mode === 'ir'
          ? document.querySelector('[data-type="a"]')
          : mode === 'sv'
            ? document.querySelector('.vditor-sv [data-type="link-text"]')
            : document.querySelector('a[href]')
      if (!node) return { found: false, hrefs: [] as string[] }
      node.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: ctrl,
        }),
      )
      const hrefs = (window as any).__posted
        .filter((m: any) => m.command === 'open-link')
        .map((m: any) => m.href)
      return { found: true, hrefs }
    },
    { mode, ctrl },
  )
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test.describe(`link click — ${mode} mode, default (modifier) policy`, () => {
    test('plain click does NOT follow the link (stays for editing)', async ({
      page,
    }) => {
      await gotoLink(page, mode, 'modifier')
      const res = await clickLinkHrefs(page, mode, false)
      expect(res.found).toBe(true)
      expect(res.hrefs).toEqual([])
    })

    test('Ctrl+click follows the link exactly once (correct URL, no double-post)', async ({
      page,
    }) => {
      await gotoLink(page, mode, 'modifier')
      const res = await clickLinkHrefs(page, mode, true)
      expect(res.found).toBe(true)
      expect(res.hrefs).toEqual([HREF])
    })
  })

  test.describe(`link click — ${mode} mode, 'click' policy (legacy)`, () => {
    test('plain click follows the link exactly once', async ({ page }) => {
      await gotoLink(page, mode, 'click')
      const res = await clickLinkHrefs(page, mode, false)
      expect(res.found).toBe(true)
      expect(res.hrefs).toEqual([HREF])
    })
  })
}

// Task 580 CP2-8 — Activate Link at Caret is unbound. Ctrl/Cmd+Enter in the editor no longer
// opens the link and leaves the document unchanged; a user key bound to the command (the harness's
// keybinding shim, Alt+L) still opens it through the `activate-link-at-caret` route.
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: Ctrl/Cmd+Enter on a link is inert; a user key for Activate Link at Caret opens it`, async ({
    page,
  }) => {
    await gotoLink(page, mode, 'modifier')
    const placeCaret = () =>
      page.evaluate((mode) => {
        const root = document.querySelector<HTMLElement>(
          mode === 'ir'
            ? '.vditor-ir .vditor-reset'
            : '.vditor-wysiwyg .vditor-reset',
        )!
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!(node as Text).data.includes('Example')) continue
          root.focus()
          const range = document.createRange()
          range.setStart(node, 2)
          range.collapse(true)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          return true
        }
        return false
      }, mode)
    const state = () =>
      page.evaluate(() => ({
        value: (window as any).vditor.getValue() as string,
        hrefs: (window as any).__posted
          .filter((m: any) => m.command === 'open-link')
          .map((m: any) => m.href) as string[],
      }))
    const before = (await state()).value
    expect(await placeCaret()).toBe(true)
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.waitForTimeout(150)
    expect(await state()).toEqual({ value: before, hrefs: [] })

    expect(await placeCaret()).toBe(true)
    await page.keyboard.press('Alt+KeyL')
    await expect.poll(async () => (await state()).hrefs).toEqual([HREF])
    expect((await state()).value).toBe(before)
  })
}

test.describe('split-source link identity and paired Preview routing', () => {
  test('trusted clicks on label and destination resolve the same raw href', async ({
    page,
  }) => {
    await gotoLink(page, 'sv', 'modifier')
    const posted = () =>
      page.evaluate(() =>
        (window as any).__posted
          .filter((message: any) => message.command === 'open-link')
          .map((message: any) => message.href),
      )

    await page
      .locator('.vditor-sv [data-type="link-text"]')
      .click({ modifiers: ['Control'] })
    await expect.poll(posted).toEqual([HREF])

    await page.evaluate(() => {
      ;(window as any).__posted = []
    })
    await page
      .locator('.vditor-sv .vditor-sv__marker--link')
      .click({ modifiers: ['Control'] })
    await expect.poll(posted).toEqual([HREF])
  })

  test('the paired Preview link posts exactly once', async ({ page }) => {
    await gotoLink(page, 'sv', 'modifier')
    await page
      .locator('.vditor-preview a[href]')
      .click({ modifiers: ['Control'] })
    const hrefs = await page.evaluate(() =>
      (window as any).__posted
        .filter((message: any) => message.command === 'open-link')
        .map((message: any) => message.href),
    )
    expect(hrefs).toEqual([HREF])
  })
})

test.describe('IR links after a trusted pointer gesture expands their source', () => {
  const posted = (page: Page) =>
    page.evaluate(() =>
      (window as any).__posted
        .filter((message: any) => message.command === 'open-link')
        .map((message: any) => message.href),
    )

  test('Ctrl+click opens the expanded IR link under the default policy', async ({
    page,
  }) => {
    await gotoLink(page, 'ir', 'modifier')
    await page
      .locator('.vditor-ir [data-type="a"] .vditor-ir__link')
      .click({ modifiers: ['Control'] })
    await expect.poll(() => posted(page)).toEqual([HREF])
  })

  test('plain click opens the expanded IR link under the click policy', async ({
    page,
  }) => {
    await gotoLink(page, 'ir', 'click')
    await page.locator('.vditor-ir [data-type="a"] .vditor-ir__link').click()
    await expect.poll(() => posted(page)).toEqual([HREF])
  })
})

// A link OUTSIDE the editor content (the About/Info dialog / a `.vditor-tip`) must
// NOT be gated by the modifier policy — a plain click opens it, even in the default
// 'modifier' mode where an editor link would stay for editing.
test.describe('chrome links (dialogs/tips) ignore the modifier policy', () => {
  test('a plain click on a dialog link opens it in modifier mode', async ({
    page,
  }) => {
    await gotoLink(page, 'ir', 'modifier')
    const hrefs = await page.evaluate(() => {
      ;(window as any).__posted = []
      document
        .querySelector<HTMLAnchorElement>('#dialog-link')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
      return (window as any).__posted
        .filter((m: any) => m.command === 'open-link')
        .map((m: any) => m.href)
    })
    expect(hrefs).toEqual(['https://dialog.example/info'])
  })
})
