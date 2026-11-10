// Task 721 — full Preview keeps the reading and navigation decorations of the edit modes, read-only:
// the heading and list fold gutters (same look and alignment as IR, Task 722) and the Git change
// bars. Fold state is one per-document state: a fold made in Preview shows in IR after Preview is
// turned off and the reverse, and survives a reopen. The saved Markdown never changes.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { itemLocator, measureItem, type Mode } from './list-fold-ink'
import { docState, PREVIEW_BUTTON, setConfig } from './preview-mode-helpers'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const FILLER = Array.from({ length: 10 }, (_, index) => [
  `Filler paragraph ${index + 1}.`,
  '',
]).flat()

const CONTENT = [
  '# One',
  '',
  'one body',
  '',
  '## Child',
  '',
  'child body',
  '',
  '# Two',
  '',
  ...FILLER,
  '- parent',
  '  - nested a',
  '  - nested b',
  '',
  'Ordered list:',
  '',
  '1. ordered top',
  '   1. ordered child',
  '',
  'Task list:',
  '',
  '- [ ] task top',
  '  - [ ] task child',
  '',
  'tail paragraph',
  '',
  ...FILLER,
].join('\n')

const LIST_ITEMS = ['parent', 'ordered top', 'task top'] as const

type Frame = ReturnType<typeof wf>

const surfaceSelector = (mode: Mode) => `.vditor-${mode} .vditor-reset`

/** The folds on the surface the user sees: the Preview pane while it is shown, else the editor. */
const foldView = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const preview = inner.preview.element.style.display === 'block'
    const root: HTMLElement = preview
      ? inner.preview.previewElement
      : inner[inner.currentMode].element
    const ownText = (item: Element) => {
      const clone = item.cloneNode(true) as HTMLElement
      for (const nested of clone.querySelectorAll('ul, ol')) nested.remove()
      return clone.textContent?.trim() ?? ''
    }
    return {
      surface: preview ? 'preview' : inner.currentMode,
      headings: Array.from(root.querySelectorAll('[data-vmde-folded]')).map(
        (heading) => heading.textContent?.replace(/^#+\s*/, '').trim(),
      ),
      lists: Array.from(root.querySelectorAll('[data-vmde-list-folded]')).map(
        ownText,
      ),
      hidden: Array.from(root.querySelectorAll('[data-vmde-fold-hidden]'))
        .filter((element) => getComputedStyle(element).display === 'none')
        .map((element) => element.textContent?.replace(/\s+/g, ' ').trim()),
    }
  })

/** The heading's arrow box (the pointer target) and its painted glyph, relative to the heading's
 *  first text character, so IR (with its `## ` marker) and Preview compare directly. */
const headingGutter = (frame: Frame, mode: Mode, text: string) =>
  frame
    .locator(`${surfaceSelector(mode)} > :is(h1, h2, h3, h4, h5, h6)`, {
      hasText: text,
    })
    .first()
    .evaluate((element) => {
      element.scrollIntoView({ block: 'center' })
      const px = Number.parseFloat
      const box = element.getBoundingClientRect()
      const arrow = getComputedStyle(element, '::after')
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.nodeValue?.trim() &&
          !node.parentElement?.closest('.vditor-ir__marker')
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
      })
      const textNode = walker.nextNode() as Text
      const range = document.createRange()
      const first = textNode.nodeValue!.search(/\S/)
      range.setStart(textNode, first)
      range.setEnd(textNode, first + 1)
      const textBox = range.getBoundingClientRect()
      const left = box.left + px(arrow.left)
      const top = box.top + px(arrow.top)
      return {
        foldable: element.hasAttribute('data-vmde-foldable'),
        content: arrow.content,
        click: {
          x: left + px(arrow.width) / 2,
          y: top + px(arrow.height) / 2,
        },
        glyph: {
          x: left + px(arrow.width) / 2 - textBox.left,
          y: top + px(arrow.paddingTop) - textBox.top,
        },
      }
    })

/** Centre of a list item's painted triangle box (the `::before` glyph inside its pointer target). */
const listGlyph = (frame: Frame, mode: Mode, needle: string) =>
  itemLocator(frame, mode, needle).evaluate((element) => {
    element.scrollIntoView({ block: 'center' })
    const box = element.getBoundingClientRect()
    const glyph = getComputedStyle(element, '::before')
    return {
      x:
        box.left +
        Number.parseFloat(glyph.left) +
        Number.parseFloat(glyph.width) / 2,
      y:
        box.top +
        Number.parseFloat(glyph.top) +
        Number.parseFloat(glyph.height) / 2,
    }
  })

const click = (frame: Frame, point: { x: number; y: number }) =>
  frame.locator('body').click({ position: point })

const togglePreview = async (frame: Frame, shown: boolean) => {
  await frame.locator(PREVIEW_BUTTON).click()
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () =>
            (window as any).vditor.vditor.preview.element.style.display ===
            'block',
        ),
    )
    .toBe(shown)
  await frame.locator('body').press('Escape')
}

const open = (
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  file: string,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType],
  )

test('Preview keeps the fold gutters and change bars and shares fold state with IR', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'preview-decorations.md')
  writeFileSync(file, CONTENT)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'ir')
  try {
    await open(evaluateInVSCode, file)
    const frame = wf(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { message: 'preview-decorations readiness' },
    )
    await frame.locator('body').evaluate(() => document.fonts.ready)

    // Edit-mode reference: where the heading arrow and each list triangle paint in IR.
    const irHeading = await headingGutter(frame, 'ir', 'Child')
    const irItems = new Map<string, Awaited<ReturnType<typeof measureItem>>>()
    for (const needle of LIST_ITEMS)
      irItems.set(needle, await measureItem(workbox, frame, 'ir', needle))

    await togglePreview(frame, true)
    await frame
      .locator(`${surfaceSelector('preview')} > h2[data-vmde-foldable]`)
      .first()
      .waitFor({ timeout: 30_000 })

    // Same look and alignment as the edit modes.
    const previewHeading = await headingGutter(frame, 'preview', 'Child')
    expect(previewHeading).toMatchObject({ foldable: true, content: '"▼"' })
    expect(
      Math.abs(previewHeading.glyph.x - irHeading.glyph.x),
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(previewHeading.glyph.y - irHeading.glyph.y),
    ).toBeLessThanOrEqual(1)
    for (const needle of LIST_ITEMS) {
      const preview = await measureItem(workbox, frame, 'preview', needle)
      const ir = irItems.get(needle)!
      console.log(
        `TASK721 ${JSON.stringify({ needle, preview: { marker: preview.marker, arrow: preview.arrow }, ir: { marker: ir.marker, arrow: ir.arrow } })}`,
      )
      expect(
        Math.abs(preview.arrow.cx - preview.marker.cx),
      ).toBeLessThanOrEqual(1)
      // The triangle sits beneath its marker by the same gap as in IR.
      expect(
        Math.abs(
          preview.arrow.top -
            preview.marker.bottom -
            (ir.arrow.top - ir.marker.bottom),
        ),
      ).toBeLessThanOrEqual(1)
    }

    // Fold a heading and a list item in Preview with real clicks on their gutters.
    await click(frame, (await headingGutter(frame, 'preview', 'Child')).click)
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({ surface: 'preview', headings: ['Child'] })
    expect((await foldView(frame)).hidden).toContain('child body')
    expect((await headingGutter(frame, 'preview', 'Child')).content).toBe('"▶"')
    await click(frame, await listGlyph(frame, 'preview', 'parent'))
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({ headings: ['Child'], lists: ['parent'] })
    expect((await foldView(frame)).hidden.join(' | ')).toContain('nested a')

    // Read-only: no editable Preview, no document change.
    expect(
      await frame
        .locator(surfaceSelector('preview'))
        .first()
        .evaluate((pane) => (pane as HTMLElement).isContentEditable),
    ).toBe(false)
    expect(await docState(evaluateInVSCode, file)).toMatchObject({
      text: CONTENT,
      dirty: false,
    })

    // Git change bars: the host's diff for the "tail paragraph" line draws a bar beside it.
    const tailLine = CONTENT.split('\n').indexOf('tail paragraph')
    await frame.locator('body').evaluate((_body, line) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            command: 'diff-info',
            changes: [{ startLine: line, endLine: line + 1, type: 'modified' }],
          },
        }),
      )
    }, tailLine)
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const pane = document.querySelector('.vditor-preview .vditor-reset')!
          const bar = document.querySelector<HTMLElement>(
            '.vditor-preview > .me-diff-layer > .me-diff-marker--modified',
          )
          const tail = Array.from(pane.children).find(
            (child) => child.textContent?.trim() === 'tail paragraph',
          )!
          if (!bar) return null
          const barBox = bar.getBoundingClientRect()
          const tailBox = tail.getBoundingClientRect()
          return {
            insidePane: pane.querySelector('.me-diff-marker') !== null,
            dTop: Math.round(barBox.top - tailBox.top),
            dHeight: Math.round(barBox.height - tailBox.height),
            visible: barBox.width > 0,
          }
        }),
      )
      .toEqual({ insidePane: false, dTop: 0, dHeight: 0, visible: true })

    // Preview off: IR shows the folds made in Preview.
    await togglePreview(frame, false)
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({
        surface: 'ir',
        headings: ['Child'],
        lists: ['parent'],
      })
    expect((await foldView(frame)).hidden).toContain('child body')

    // Fold in IR, then Preview on: Preview shows the IR folds.
    await click(frame, (await headingGutter(frame, 'ir', 'Child')).click)
    await expect.poll(() => foldView(frame)).toMatchObject({ headings: [] })
    await click(frame, (await headingGutter(frame, 'ir', 'One')).click)
    await click(frame, await listGlyph(frame, 'ir', 'parent'))
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({ surface: 'ir', headings: ['One'], lists: [] })
    await togglePreview(frame, true)
    await expect
      .poll(() => foldView(frame))
      .toMatchObject({ surface: 'preview', headings: ['One'], lists: [] })
    expect((await foldView(frame)).hidden).toEqual(
      expect.arrayContaining(['one body', 'Child', 'child body']),
    )

    // The per-document store: a reopen restores the same folds on whichever surface it opens.
    await open(evaluateInVSCode, file)
    const reopened = wf(workbox)
    await waitForE2EReadiness(
      reopened,
      (state) => state.routerReady && state.editorEpoch > 0,
      { message: 'preview-decorations reopen' },
    )
    await expect
      .poll(() => foldView(reopened), { timeout: 30_000 })
      .toMatchObject({ headings: ['One'], lists: [] })
    expect(await docState(evaluateInVSCode, file)).toMatchObject({
      text: CONTENT,
      dirty: false,
    })
  } finally {
    await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
  }
})
