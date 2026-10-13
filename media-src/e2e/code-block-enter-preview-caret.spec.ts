import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 627 (RED). With the caret in a code block's rendered preview (where Control+End lands in the
// real webview), Enter must stay a newline in the code. Currently Vditor's code-block Enter rule does
// not run (the caret is outside the editable code), the native paragraph insert is dropped by the
// re-spin, and the caret falls to the end of the first heading. The keybugs harness serves the built
// bundle, so run `node build.mjs` first. Real-VS-Code twin: the S2b-a probe spec.

type Mode = 'ir' | 'wysiwyg'

const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\n```js\nconst echo = 1\n```\n'
const AFTER_ENTER =
  '# Probe\n\nAlpha bravo charlie delta.\n\n```js\nconst echo = 1\nY\n```\n'

// Rendered preview element of the code block.
//   IR:      .vditor-ir__node[data-type="code-block"] .vditor-ir__preview
//   WYSIWYG: .vditor-wysiwyg__block[data-type="code-block"] .vditor-wysiwyg__preview
const PREVIEW: Record<Mode, string> = {
  ir: '.vditor-ir__node[data-type="code-block"] .vditor-ir__preview',
  wysiwyg:
    '.vditor-wysiwyg__block[data-type="code-block"] .vditor-wysiwyg__preview',
}
// Editable code of the block.
const EDITABLE: Record<Mode, string> = {
  ir: 'pre.vditor-ir__marker--pre code',
  wysiwyg:
    '.vditor-wysiwyg__block[data-type="code-block"] > pre:not(.vditor-wysiwyg__preview) code',
}

async function open(page: Page, mode: Mode, doc = DOC) {
  await page.goto(`/keybugs.html?mode=${mode}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(async (value) => {
    const editor = (window as any).vditor
    editor.setValue(value)
    await new Promise((resolve) => setTimeout(resolve, 100))
    ;((window as any).__modeEl() as HTMLElement).focus()
  }, doc)
}

/** Collapse the selection at the end (or start) of the first text node holding `token`, within `selector`. */
async function collapseIn(
  page: Page,
  selector: string,
  where: 'end' | 'start',
  token?: string,
) {
  await page.evaluate(
    ([sel, at, tok]) => {
      const root = document.querySelector(sel as string)
      if (!root) throw new Error(`no element ${sel}`)
      const target = firstTextNode(root, tok as string)
      if (!target) throw new Error(`no text in ${sel}`)
      // With a token, the caret goes right after it (the code text ends with a newline).
      const end = tok
        ? target.data.indexOf(tok as string) + (tok as string).length
        : target.data.length
      const range = document.createRange()
      range.setStart(target, at === 'end' ? end : 0)
      range.collapse(true)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      // First text node under `base` holding `token` (any text node when `token` is empty).
      function firstTextNode(base: Element, token: string): Text | null {
        const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n as Text
          if (!token || t.data.includes(token)) return t
        }
        return null
      }
    },
    [selector, where, token ?? ''],
  )
}

const value = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

// Where the selection sits: inside the editable code, inside the preview, or elsewhere.
const where = (page: Page, mode: Mode) =>
  page.evaluate(
    ([preview, editable]) => {
      const node = window.getSelection()?.anchorNode ?? null
      const el = node instanceof Element ? node : node?.parentElement
      if (!el) return 'none'
      if (el.closest(editable as string)) return 'editable-code'
      if (el.closest(preview as string)) return 'preview'
      return `other:${el.tagName.toLowerCase()}:${(el.textContent ?? '').slice(0, 20)}`
    },
    [PREVIEW[mode], EDITABLE[mode]],
  )

for (const mode of ['ir', 'wysiwyg'] as const) {
  test.describe(`Enter in a code block (${mode})`, () => {
    // Route (a): where Control+End puts the caret, measured.
    test(`DEFECT Control+End, Enter, Shift+Y keeps Y in the code`, async ({
      page,
    }) => {
      await open(page, mode)
      await page.keyboard.press('Control+End')
      const landed = await where(page, mode)
      test
        .info()
        .annotations.push({ type: 'ctrl-end-lands', description: landed })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      await page.keyboard.press('Shift+Y')
      await page.waitForTimeout(300)
      expect(await value(page), 'Y is on its own code line').toBe(AFTER_ENTER)
    })

    test(`DEFECT caret in the rendered preview, Enter, Shift+Y keeps Y in the code`, async ({
      page,
    }) => {
      await open(page, mode)
      await collapseIn(page, PREVIEW[mode], 'end')
      expect(await where(page, mode), 'caret starts in the preview').toBe(
        'preview',
      )
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      expect
        .soft(
          await where(page, mode),
          'caret is in the editable code after Enter',
        )
        .toBe('editable-code')
      await page.keyboard.press('Shift+Y')
      await page.waitForTimeout(300)
      expect(await value(page), 'Y is on its own code line').toBe(AFTER_ENTER)
    })

    test(`CONTROL caret at the code line end, Enter, Shift+Y`, async ({
      page,
    }) => {
      await open(page, mode)
      await collapseIn(page, EDITABLE[mode], 'end', 'const echo = 1')
      expect(await where(page, mode)).toBe('editable-code')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      expect(await where(page, mode)).toBe('editable-code')
      await page.keyboard.press('Shift+Y')
      await page.waitForTimeout(300)
      expect(await value(page)).toBe(AFTER_ENTER)
    })

    test(`RECORD Control+End then Shift+Y without Enter`, async ({ page }) => {
      await open(page, mode)
      await page.keyboard.press('Control+End')
      const landed = await where(page, mode)
      await page.keyboard.press('Shift+Y')
      await page.waitForTimeout(300)
      const got = await value(page)
      const ir =
        '# Probe\n\nAlpha bravo charlie delta.\n\n```js\nconst echo = 1Y\n```\n'
      test.info().annotations.push({
        type: 'measured',
        description: JSON.stringify(got),
      })
      console.log(
        `[measured ${mode}] ctrl-end lands: ${landed}; Y without Enter -> ${JSON.stringify(got)}`,
      )
      // Recorded cell. Real VS Code gives `ir` (typing in the preview reaches the code line end); in
      // headless Chromium the key typed into the preview never reaches the source in either mode, so the
      // source stays the opened bytes. Assert only that the source is one of these two, never corrupted.
      expect([ir, DOC]).toContain(got)
    })

    test(`CONTROL Enter at the end of the paragraph, Shift+Y`, async ({
      page,
    }) => {
      await open(page, mode)
      await collapseIn(
        page,
        mode === 'ir' ? '.vditor-ir p' : '.vditor-wysiwyg p',
        'end',
        'delta.',
      )
      await page.keyboard.press('Enter')
      await page.waitForTimeout(100)
      await page.keyboard.press('Shift+Y')
      await page.waitForTimeout(300)
      expect(await value(page)).toBe(
        '# Probe\n\nAlpha bravo charlie delta.\n\nY\n\n```js\nconst echo = 1\n```\n',
      )
    })
  })
}
