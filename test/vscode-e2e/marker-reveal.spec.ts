import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const pageLines = Array.from(
  { length: 24 },
  (_, index) => `**real-page-bold-${index}**`,
)
const INITIAL = [
  '**real-home-bold** tail',
  '[real-home-link](https://example.com) tail',
  '`real-home-code` tail',
  `**real-wrapped-bold** ${'wrapped prose '.repeat(30)}`,
  ...pageLines,
  // PageUp starts here, directly under the bold-only page lines and wider than any of them. Any
  // native page distance, from one line to a full page, then lands in a page line, and a caret at
  // this line's end keeps an x past every page line's text, inside its closing hidden `**` marker.
  // Chromium's page distance near hidden link/code markers depends on font metrics, so the start
  // must not sit below the link line (Task 286 contract: typing after PageUp never corrupts markers).
  `real-page-anchor ${'x'.repeat(40)}`,
  'tail **real-end-bold**',
  'tail [real-end-link](https://example.com)',
  'tail `real-end-code`',
].join('\n\n')

type VmdeFrame = ReturnType<typeof wf>

async function placeInline(
  frame: VmdeFrame,
  needle: string,
  at: 'middle' | 'line-end' = 'middle',
): Promise<boolean> {
  return frame.locator('body').evaluate(
    (_body, [target, where]) => {
      const surface = document.querySelector<HTMLElement>('.vditor-ir')
      if (!surface) return false
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        const index = text.indexOf(target as string)
        if (index < 0) continue
        node.parentElement
          ?.closest<HTMLElement>('[data-block]')
          ?.scrollIntoView({ block: 'center' })
        surface.focus({ preventScroll: true })
        const range = document.createRange()
        range.setStart(
          node,
          where === 'line-end'
            ? text.length
            : index + Math.floor((target as string).length / 2),
        )
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    },
    [needle, at] as const,
  )
}

const markerState = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')
    const selection = getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    const parent =
      anchor?.nodeType === Node.TEXT_NODE
        ? anchor.parentElement
        : (anchor as HTMLElement | null)
    return {
      parentClass: parent?.className ?? '',
      expandedNodes: Array.from(
        surface?.querySelectorAll<HTMLElement>('.vditor-ir__node--expand') ??
          [],
      ).map((node) => ({
        type: node.getAttribute('data-type') ?? '?',
        text: node.textContent ?? '',
      })),
    }
  })

// The block that holds the caret after PageUp: a page line whose own strong is expanded.
const pageLanding = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const selection = getSelection()
    const anchor = selection?.rangeCount ? selection.anchorNode : null
    const element =
      anchor?.nodeType === Node.TEXT_NODE
        ? anchor.parentElement
        : (anchor as HTMLElement | null)
    const block = element?.closest<HTMLElement>('[data-block]')
    const strong = block?.querySelector<HTMLElement>('[data-type="strong"]')
    return {
      inPageLine: Boolean(strong?.textContent?.includes('real-page-bold-')),
      strongExpanded: Boolean(
        strong?.classList.contains('vditor-ir__node--expand'),
      ),
    }
  })

// True when `after` is `before` with exactly one `inserted` character added somewhere.
function insertedOnce(before: string, after: string, inserted: string) {
  if (after.length !== before.length + inserted.length) return false
  let index = 0
  while (index < before.length && before[index] === after[index]) index++
  return (
    after.slice(index, index + inserted.length) === inserted &&
    after.slice(index + inserted.length) === before.slice(index)
  )
}

const webviewMarkdown = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

async function navigateAndType(
  workbox: Page,
  frame: VmdeFrame,
  sample: {
    needle: string
    key: 'Home' | 'End'
    type: string
    inserted: string
    expected: string
  },
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (!(await placeInline(frame, sample.needle))) return false
        await frame
          .locator('body')
          .evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
        return (await markerState(frame)).expandedNodes.some(
          (node) =>
            node.type === sample.type && node.text.includes(sample.needle),
        )
      },
      { message: `expand placed ${sample.needle}` },
    )
    .toBe(true)
  await workbox.keyboard.press(sample.key)
  await expect
    .poll(
      async () =>
        (await markerState(frame)).expandedNodes.some(
          (node) =>
            node.type === sample.type && node.text.includes(sample.needle),
        ),
      { message: `${sample.key} keeps ${sample.needle} expanded` },
    )
    .toBe(true)
  expect((await markerState(frame)).parentClass).not.toContain(
    'vditor-ir__marker',
  )
  await workbox.keyboard.type(sample.inserted)
  await expect.poll(() => webviewMarkdown(frame)).toContain(sample.expected)
}

test('real IR navigation reveals and protects hidden inline markers', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'marker-reveal.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'marker-reveal fixture readiness' },
  )
  // Give the nested webview page keyboard focus once. The DOM helper below chooses exact text
  // offsets, but `HTMLElement.focus()` inside the iframe cannot by itself focus VS Code's outer
  // iframe target for `workbox.keyboard`.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 20, y: 20 } })

  for (const sample of [
    {
      needle: 'real-home-bold',
      key: 'Home',
      type: 'strong',
      inserted: 'B',
      expected: 'B**real-home-bold** tail',
    },
    {
      needle: 'real-home-link',
      key: 'Home',
      type: 'a',
      inserted: 'L',
      expected: 'L[real-home-link](https://example.com) tail',
    },
    {
      needle: 'real-home-code',
      key: 'Home',
      type: 'code',
      inserted: 'C',
      expected: 'C`real-home-code` tail',
    },
    {
      needle: 'real-end-bold',
      key: 'End',
      type: 'strong',
      inserted: 'b',
      expected: 'tail **real-end-bold**b',
    },
    {
      needle: 'real-end-link',
      key: 'End',
      type: 'a',
      inserted: 'l',
      expected: 'tail [real-end-link](https://example.com)l',
    },
    {
      needle: 'real-end-code',
      key: 'End',
      type: 'code',
      inserted: 'c',
      expected: 'tail `real-end-code`c',
    },
  ] as const) {
    await navigateAndType(workbox, frame, sample)
  }

  await expect
    .poll(async () => {
      if (!(await placeInline(frame, 'real-wrapped-bold'))) return false
      await frame
        .locator('body')
        .evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
      return (await markerState(frame)).expandedNodes.some((node) =>
        node.text.includes('real-wrapped-bold'),
      )
    })
    .toBe(true)
  await workbox.keyboard.press('Home')
  await workbox.keyboard.type('W')
  await expect
    .poll(() => webviewMarkdown(frame))
    .toContain('W**real-wrapped-bold**')

  await expect
    .poll(() => placeInline(frame, 'real-page-anchor', 'line-end'))
    .toBe(true)
  await workbox.keyboard.press('PageUp')
  // The native landing is a page line's closing hidden `**`; the normalizer must move the caret out
  // of the marker and keep that line's own strong expanded.
  await expect
    .poll(async () => {
      const state = await markerState(frame)
      const landing = await pageLanding(frame)
      return (
        !state.parentClass.includes('vditor-ir__marker') &&
        landing.inPageLine &&
        landing.strongExpanded
      )
    })
    .toBe(true)
  const beforeTyping = await webviewMarkdown(frame)
  await workbox.keyboard.type('P')

  await expect
    .poll(async () => {
      const markdown = await webviewMarkdown(frame)
      const intactPageMarkers =
        markdown.match(/^P?\*\*real-page-bold-\d+\*\*P?$/gm)?.length ?? 0
      return (
        insertedOnce(beforeTyping, markdown, 'P') &&
        !markdown.includes('*P*') &&
        markdown.includes('B**real-home-bold** tail') &&
        markdown.includes('L[real-home-link](https://example.com) tail') &&
        markdown.includes('C`real-home-code` tail') &&
        markdown.includes('tail **real-end-bold**b') &&
        markdown.includes('tail [real-end-link](https://example.com)l') &&
        markdown.includes('tail `real-end-code`c') &&
        markdown.includes('W**real-wrapped-bold**') &&
        intactPageMarkers === pageLines.length
      )
    })
    .toBe(true)
})
