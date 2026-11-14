import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 009: the IR edit path without whole-document scans. While the model is live, Enter
// and paste publish through the model (no whole-document serialization), the trailing definitions
// and footnotes lookups and the diagram deferral stay near the caret, and the identity encoder keeps
// hard breaks. Each case reads the file text through the VS Code document and the counters from
// `window.__vmdeEditCounters` (end-to-end runs only; numbers only, no document text).

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  fullGetValue: number
  deltaPosts: number
  fallbackPublications: number
}

interface ModelStats {
  state: string
  offReason?: string
}

const FIXTURE = tableHeavyMarkdown(1)
const PARAGRAPH = '.vditor-ir .vditor-reset > p'
const THIRD = 'Third paragraph introduces the list below.'
// A 1×1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

async function open(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the edit-path editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await expect
    .poll(async () => (await modelStats(frame))?.state, {
      timeout: 90_000,
      message: 'the IR model is live',
    })
    .toBe('live')
  return { frame, file }
}

const modelStats = (frame: Frame): Promise<ModelStats | undefined> =>
  frame.locator('body').evaluate(() => {
    const s = (window as unknown as { __vmdeModelShadowStats?: ModelStats })
      .__vmdeModelShadowStats
    return s ? { state: s.state, offReason: s.offReason } : undefined
  })

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, n) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(n as number)
  }, length)

const counters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      deltaPosts: c.deltaPosts,
      fallbackPublications: c.fallbackPublications,
    }
  })

async function caretAtEnd(
  workbox: Page,
  frame: Frame,
  selector: string,
  nth: number,
) {
  const target = frame.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

/** Caret at the end of the last text of the first IR paragraph that contains `needle`. */
async function caretAfterText(frame: Frame, needle: string) {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, text) => {
    const root = document.querySelector<HTMLElement>('.vditor-ir .vditor-reset')
    const block = Array.from(root?.children ?? []).find((el) =>
      (el.textContent ?? '').includes(text as string),
    )
    if (!root || !block) return false
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let last: Text | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n as Text
    if (!last) return false
    const range = document.createRange()
    range.setStart(last, (last.textContent ?? '').length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    root.focus({ preventScroll: true })
    return true
  }, needle)
  expect(placed, `caret placed after "${needle}"`).toBe(true)
}

/** Caret after `needle` in the editable source of the first IR code block (expanded first). */
async function caretInCodeSource(frame: Frame, needle: string) {
  // The top window must hold keyboard focus before the page-side selection is set.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, text) => {
    const code = document.querySelector(
      '.vditor-ir .vditor-reset > [data-type="code-block"] pre.vditor-ir__marker--pre > code',
    )
    const node = code?.closest('.vditor-ir__node')
    const source = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    if (!code || !node || !source) return false
    node.classList.add('vditor-ir__node--expand')
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n.textContent ?? '').indexOf(text as string)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at + (text as string).length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      source.focus()
      return true
    }
    return false
  }, needle)
  expect(placed, `caret placed after "${needle}" in the code source`).toBe(true)
}

async function type(workbox: Page, text: string, cadence = 120) {
  for (const ch of text) {
    await workbox.keyboard.press(ch)
    await workbox.waitForTimeout(cadence)
  }
}

test.describe('edit path without whole-document scans', () => {
  test('Enter in a paragraph publishes through the model', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-enter.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await resetCounters(frame, FIXTURE.length)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(300)
    await type(workbox, 'x')
    await settle(frame, 2000)
    expect(await docText(evaluateInVSCode, file)).toContain(`${THIRD}\n\nx\n`)
    const c = await counters(frame)
    expect(c.fullGetValue).toBe(0)
    expect(c.deltaPosts).toBeGreaterThanOrEqual(1)
  })

  test('paste in a paragraph publishes through the model', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-paste.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await resetCounters(frame, FIXTURE.length)
    // A synthetic paste of constant text; the clipboard itself may refuse a write without a gesture.
    await frame.locator('body').evaluate(() => {
      const editor = document.querySelector('.vditor-ir .vditor-reset')
      if (!editor) throw new Error('no IR editor')
      const transfer = new DataTransfer()
      transfer.setData('text/plain', 'pasted words')
      editor.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    await settle(frame, 2000)
    expect(await docText(evaluateInVSCode, file)).toContain('pasted words')
    expect((await counters(frame)).fullGetValue).toBe(0)
  })

  test('a reference typed mid-document still moves its definitions block to the end', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    // A diagram far above the edit: a spin of the whole root (the caret in the definitions block)
    // re-creates its preview, which must render again.
    const text = FIXTURE.replace(
      '# Overview\n',
      '# Overview\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    )
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-reference.md',
      text,
    )
    const diagram = frame.locator(
      '.vditor-ir [data-type="code-block"] .vditor-ir__preview svg',
    )
    await expect(diagram.first()).toBeAttached({ timeout: 30_000 })
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await resetCounters(frame, text.length)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(300)
    await workbox.keyboard.type('[r]: https://example.com', { delay: 60 })
    await workbox.keyboard.press('Enter')
    await settle(frame, 2500)
    // The last content child of the IR root (view-only paragraphs skipped) is the definitions block.
    const lastType = await frame.locator('body').evaluate(() => {
      const root = document.querySelector('.vditor-ir .vditor-reset')
      let el = root?.lastElementChild ?? null
      while (
        el &&
        (el.hasAttribute('data-vmde-trailing') ||
          el.hasAttribute('data-vmde-gap') ||
          el.hasAttribute('data-vmde-leading'))
      )
        el = el.previousElementSibling
      return el?.getAttribute('data-type') ?? null
    })
    expect(lastType).toBe('link-ref-defs-block')
    const defsBlocks = await frame
      .locator('.vditor-ir .vditor-reset > [data-type="link-ref-defs-block"]')
      .count()
    expect(defsBlocks).toBe(1)
    expect(await docText(evaluateInVSCode, file)).toContain(
      '[r]: https://example.com',
    )
    // A definitions block is not a unit kind: the model turns off and publishes the whole text.
    expect((await counters(frame)).fallbackPublications).toBeGreaterThanOrEqual(
      1,
    )
    expect((await modelStats(frame))?.offReason).toBe('unit-without-kind')
    await expect(diagram.first()).toBeAttached({ timeout: 10_000 })
    expect(
      await frame
        .locator('.vditor-ir .vditor-ir__preview[data-render="2"]')
        .count(),
    ).toBe(0)
  })

  test('typing after a titled image shows no caption element', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text = `Intro paragraph.\n\n![alt](data:image/png;base64,${PNG} "Image title")\n\nAfter the image.\n`
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-caption.md',
      text,
    )
    await caretAfterText(frame, 'After the image.')
    await type(workbox, 'x')
    await settle(frame, 1500)
    expect(await docText(evaluateInVSCode, file)).toContain('After the image.x')
    // The caption renderer is a build stub: no IR caption element appears (behaviour unchanged).
    expect(await frame.locator('.vditor-ir [data-image-caption]').count()).toBe(
      0,
    )
  })

  test('typing in a paragraph with three hard breaks keeps the breaks', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text =
      'Line one  \nLine two  \nLine three  \nLine four.\n\nTail paragraph.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-hard-breaks.md',
      text,
    )
    await caretAfterText(frame, 'Line four.')
    await type(workbox, 'x')
    await settle(frame, 2000)
    expect(await docText(evaluateInVSCode, file)).toBe(
      text.replace('Line four.', 'Line four.x'),
    )
  })

  test('a Mermaid diagram stays rendered when its block is re-spun', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text =
      'Before the diagram.\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter the diagram.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'eps-mermaid.md',
      text,
    )
    const rendered = frame.locator(
      '.vditor-ir [data-type="code-block"] .vditor-ir__preview svg',
    )
    await expect(rendered.first()).toBeAttached({ timeout: 30_000 })
    // Type inside the fence: the settle re-spin spins the diagram's block, so its preview comes
    // back fresh and the scoped loop must render it.
    await caretInCodeSource(frame, 'A --> B')
    await type(workbox, 'x')
    await settle(frame, 2500)
    expect(await docText(evaluateInVSCode, file)).toContain('A --> Bx')
    await expect(rendered.first()).toBeAttached({ timeout: 10_000 })
    expect(
      await frame
        .locator('.vditor-ir .vditor-ir__preview[data-render="2"]')
        .count(),
    ).toBe(0)
  })
})
