// Task 643 (acceptance 3): the rendered output of full Preview matches an independent render of the
// same text — the Split view's preview pane, which keeps Vditor's own render path — for a document
// over the streaming threshold covering links and footnotes across chunks, diagrams, math, callouts,
// Details, task lists, wiki-link text, anchors and images.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PANE,
  PREVIEW_BUTTON,
  openFile,
  setConfig,
  waitComplete,
  type Frame,
} from './preview-mode-helpers'
import { waitForE2EReadiness } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'preview-mode-output.md')

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

// What the pane shows, without engine output: each top-level block as tag, class and text, plus every
// link target and id. Diagram SVG, KaTeX's hidden MathML and copy buttons are removed from the text.
const signature = (frame: Frame) =>
  frame.locator('body').evaluate((_body, selector) => {
    const pane = document.querySelector(selector) as HTMLElement
    const strip = (el: Element) => {
      const clone = el.cloneNode(true) as HTMLElement
      for (const skipped of clone.querySelectorAll(
        'svg, .katex-mathml, .vditor-copy, canvas, .vmde-diagram-controls',
      ))
        skipped.remove()
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    return {
      blocks: [...pane.children].map(
        (child) =>
          `${child.tagName}.${[...child.classList].sort().join('.')}|${strip(child)}`,
      ),
      links: [...pane.querySelectorAll('a[href]')].map((a) =>
        a.getAttribute('href'),
      ),
      ids: [...pane.querySelectorAll('[id]')]
        // Heading ids are renamed by Vditor's outline render, which the Preview runs only when the
        // outline is shown; they exist in one form or another by that, not by content. Engine ids
        // are generated per render.
        .filter(
          (el) =>
            !/^H[1-6]$/.test(el.tagName) &&
            !/^(mermaid|m[0-9]|d2|svg|echarts)/i.test(el.id),
        )
        .map((el) => el.id),
      images: [...pane.querySelectorAll('img')].map((img) =>
        img.getAttribute('src'),
      ),
    }
  }, PANE)

// Heavy blocks render when scrolled near; walk the whole pane so every one has rendered.
const renderEverything = async (frame: Frame) => {
  await frame.locator('body').evaluate(async (_body, selector) => {
    const pane = document.querySelector(selector) as HTMLElement
    const scroller = (() => {
      let el: HTMLElement | null = pane
      while (el) {
        const overflow = getComputedStyle(el).overflowY
        if (/auto|scroll/.test(overflow) && el.scrollHeight > el.clientHeight)
          return el
        el = el.parentElement
      }
      return document.scrollingElement as HTMLElement
    })()
    for (
      let top = 0;
      top < scroller.scrollHeight;
      top += scroller.clientHeight * 0.7
    ) {
      scroller.scrollTop = top
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    scroller.scrollTop = 0
  }, PANE)
  await expect
    .poll(() => frame.locator(`${PANE} [data-vmde-preview-pending]`).count(), {
      timeout: 60_000,
    })
    .toBe(0)
}

test('full Preview renders the same document as the Split preview pane', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(420_000)
  expect(readFileSync(FIXTURE, 'utf8').length).toBeGreaterThan(50_000)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'preview')
  const frame = await openFile(evaluateInVSCode, workbox, FIXTURE)
  const done = await waitComplete(frame)
  expect(done.previewChunks).toBeGreaterThan(2)

  // Acceptance 5 at the fixture level: the far diagram has not rendered yet.
  const farBlock = frame.locator(`${PANE} .language-mermaid`).last()
  await expect(farBlock).toHaveAttribute('data-vmde-preview-pending', 'true')
  expect(await farBlock.locator('svg').count()).toBe(0)

  await renderEverything(frame)
  await expect(frame.locator(`${PANE} .language-mermaid svg`)).toHaveCount(2, {
    timeout: 90_000,
  })
  const full = await signature(frame)
  expect(full.blocks.length).toBeGreaterThan(100)
  // Features the fixture carries really rendered (not just equal-but-empty).
  expect(full.links).toContain('#far-anchor')
  expect(full.ids.some((id) => id.startsWith('footnotes-ref'))).toBe(true)
  expect(full.images.length).toBe(1)
  await expect(frame.locator(`${PANE} .katex`).first()).toBeVisible()
  await expect(frame.locator(`${PANE} details`)).toHaveCount(1)
  await expect(frame.locator(`${PANE} li.vditor-task`)).toHaveCount(3)

  // The independent render: Split's right pane, produced by Vditor's own Preview.render.
  await frame.locator(PREVIEW_BUTTON).click()
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('.vditor-toolbar button[data-mode="sv"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    timeout: 120_000,
  })
  await expect
    .poll(() => frame.locator(`${PANE} li.vditor-task`).count(), {
      timeout: 60_000,
    })
    .toBe(3)
  await renderEverything(frame)
  await expect(frame.locator(`${PANE} .language-mermaid svg`)).toHaveCount(2, {
    timeout: 90_000,
  })
  const split = await signature(frame)

  expect(full.links).toEqual(split.links)
  expect(full.ids).toEqual(split.ids)
  expect(full.images).toEqual(split.images)
  expect(full.blocks.length).toBe(split.blocks.length)
  const different = full.blocks
    .map((block, index) => [index, block, split.blocks[index]] as const)
    .filter(([, a, b]) => a !== b)
    .slice(0, 5)
  expect(different).toEqual([])
})
