import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

function largePreviewFixture(): string {
  const lines = [
    '# Preview performance fixture',
    '',
    'hard break source  ',
    'next line',
    '',
  ]
  for (let index = 0; index < 920; index++) {
    lines.push(
      `Paragraph ${index} carries enough repeated preview-performance prose to make serialization and parsing measurable on a realistic document.`,
      '',
    )
  }
  for (let index = 0; index < 40; index++)
    lines.push(`- list ${index} first`, `- list ${index} second`, '')
  for (let index = 0; index < 4; index++)
    lines.push('| A | B |', '| - | - |', `| ${index} | ${index + 1} |`, '')
  for (let index = 0; index < 4; index++)
    lines.push('```ts', `const block${index} = true`, '```', '')
  for (let index = 0; index < 4; index++)
    lines.push('```mermaid', `graph LR; A${index} --> B${index}`, '```', '')
  return `${lines.join('\n')}\n`
}

const installCounters = (frame: ReturnType<typeof wf>) =>
  frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const inner = outer.vditor
    const stats = {
      snapshot: 0,
      md2html: 0,
      morph: 0,
      firstMorphMs: -1,
      scheduledFloor: 0,
      started: 0,
      firstNodes: [] as Node[],
    }
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (stats.started && stats.firstMorphMs < 0 && timeout === 500)
        stats.scheduledFloor++
      return nativeSetTimeout(handler, timeout, ...args)
    }) as typeof window.setTimeout
    const snapshot = (window as any).__vmdePreviewSnapshot
    ;(window as any).__vmdePreviewSnapshot = () => {
      stats.snapshot++
      return snapshot()
    }
    ;(window as any).__previewPerfWrapHardBreak = () => {
      const hardBreakSnapshot = (window as any).__vmdePreviewMarkdown
      ;(window as any).__vmdePreviewMarkdown = (vditor: unknown) => {
        const markdown = hardBreakSnapshot?.(vditor)
        if (markdown !== undefined) stats.snapshot++
        return markdown
      }
    }
    ;(window as any).__previewPerfWrapHardBreak()
    const md2html = inner.lute.Md2HTML.bind(inner.lute)
    inner.lute.Md2HTML = (markdown: string) => {
      stats.md2html++
      return md2html(markdown)
    }
    const morph = (window as any).__vmdeMorphPreview
    ;(window as any).__vmdeMorphPreview = (
      element: HTMLElement,
      html: string,
    ) => {
      stats.morph++
      if (stats.started && stats.firstMorphMs < 0)
        stats.firstMorphMs = performance.now() - stats.started
      morph(element, html)
    }
    ;(window as any).__previewPerfReset = () => {
      stats.snapshot = 0
      stats.md2html = 0
      stats.morph = 0
      stats.firstMorphMs = -1
      stats.scheduledFloor = 0
      stats.started = performance.now()
    }
    ;(window as any).__previewPerfCaptureIdentity = () => {
      stats.firstNodes = Array.from(inner.preview.previewElement.childNodes)
    }
    ;(window as any).__previewPerfToggle = () => {
      stats.started = performance.now()
      inner.toolbar.elements.preview.children[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    }
    ;(window as any).__previewPerfStats = () => {
      const previewElement = inner.preview.previewElement as HTMLElement
      const nodes = Array.from(previewElement.childNodes)
      return {
        snapshot: stats.snapshot,
        md2html: stats.md2html,
        morph: stats.morph,
        firstMorphMs: stats.firstMorphMs,
        scheduledFloor: stats.scheduledFloor,
        visible: inner.preview.element.style.display === 'block',
        identity:
          nodes.length === stats.firstNodes.length &&
          nodes.every((node, index) => node === stats.firstNodes[index]),
        mermaidHits: previewElement.querySelectorAll(
          '.language-mermaid[data-vmde-cache-hit="1"]',
        ).length,
        mermaidSvgs: previewElement.querySelectorAll('.language-mermaid svg')
          .length,
        text: previewElement.textContent ?? '',
        hardBreak: Boolean(
          Array.from(previewElement.querySelectorAll('p'))
            .find((paragraph) =>
              paragraph.textContent?.includes('hard break source'),
            )
            ?.querySelector('br'),
        ),
      }
    }
  })

const stats = (frame: ReturnType<typeof wf>) =>
  frame.locator('body').evaluate(() => (window as any).__previewPerfStats())

test('large full Preview is immediate, single-snapshot, reusable, and invalidates exactly once', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'preview-performance.md')
  const initial = largePreviewFixture()
  expect(initial.split('\n').length).toBeGreaterThan(2_000)
  expect(initial.length).toBeGreaterThan(100_000)
  writeFileSync(file, initial)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  let frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 120_000, message: 'preview performance fixture readiness' },
  )
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-mermaid svg').count(),
      { timeout: 120_000 },
    )
    .toBe(4)
  await installCounters(frame)
  await frame.locator('body').evaluate(() => {
    ;(window as any).__previewPerfReset()
    ;(window as any).__previewPerfToggle()
  })
  await expect
    .poll(() => stats(frame), { timeout: 60_000 })
    .toMatchObject({
      visible: true,
      snapshot: 1,
      md2html: 1,
      morph: 1,
      mermaidHits: 4,
      mermaidSvgs: 4,
      scheduledFloor: 0,
    })
  const first = await stats(frame)
  expect(first.firstMorphMs).toBeLessThan(800)

  await frame.locator('body').evaluate(() => {
    ;(window as any).__previewPerfCaptureIdentity()
    ;(window as any).__previewPerfToggle()
    ;(window as any).__previewPerfReset()
    ;(window as any).__previewPerfToggle()
  })
  await expect
    .poll(() => stats(frame))
    .toMatchObject({
      visible: true,
      snapshot: 0,
      md2html: 0,
      morph: 0,
      scheduledFloor: 0,
      identity: true,
      mermaidSvgs: 4,
    })

  await frame.locator('body').evaluate(() => {
    ;(window as any).__previewPerfToggle()
    const inner = (window as any).vditor.vditor
    const paragraph = inner.ir.element.querySelectorAll('p')[20] as HTMLElement
    const node = paragraph.firstChild ?? paragraph
    const range = document.createRange()
    range.selectNodeContents(node)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    inner.ir.element.focus({ preventScroll: true })
  })
  await workbox.keyboard.type(' TASK530_EDIT')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain('TASK530_EDIT')
  await frame.locator('body').evaluate(() => {
    ;(window as any).__previewPerfReset()
    ;(window as any).__previewPerfToggle()
  })
  await expect
    .poll(() => stats(frame), { timeout: 60_000 })
    .toMatchObject({
      visible: true,
      snapshot: 1,
      md2html: 1,
      morph: 1,
      scheduledFloor: 0,
      text: expect.stringContaining('TASK530_EDIT'),
    })

  await frame
    .locator('body')
    .evaluate(() => (window as any).__previewPerfToggle())
  await evaluateInVSCode(
    async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'preview.reflowLineBreaks',
          true,
          vscode.ConfigurationTarget.Global,
        )
    },
    [file] as [string],
  )
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
  await frame.locator('body').evaluate(() => {
    ;(window as any).__previewPerfWrapHardBreak()
    ;(window as any).__previewPerfReset()
    ;(window as any).__previewPerfToggle()
  })
  await expect
    .poll(() => stats(frame), { timeout: 60_000 })
    .toMatchObject({
      visible: true,
      snapshot: 1,
      md2html: 1,
      hardBreak: true,
    })

  await frame
    .locator('body')
    .evaluate(() => (window as any).__previewPerfToggle())
  await evaluateInVSCode(
    async (vscode) =>
      vscode.commands.executeCommand('workbench.action.files.save'),
    [file] as [string],
  )
  const saved = (await docText(evaluateInVSCode, file)) as string
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(saved)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file, 120_000)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect
    .poll(() => frame.locator('.vditor-preview:visible').count(), {
      timeout: 60_000,
    })
    .toBe(1)
  expect(await docText(evaluateInVSCode, file)).toBe(saved)
})
