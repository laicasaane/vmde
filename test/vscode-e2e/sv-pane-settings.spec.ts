import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import { ExtensionId, waitForE2EReadiness, wf } from './webview-helpers'

// Task 645 — the Split View source pane settings in the real webview and the real configuration
// pipeline: `vmde.editor.sourceFontSize`, `sourceLineNumbers`, `sourceBackground`,
// `sourceHighlightCurrentLine`, `sourceCurrentLineBackground` and `splitGap`. Each setting changes
// an already-open editor live; the rendered pane keeps `fontSize`; invalid values fall back; OS-level
// keys (XTEST, needs openbox and VMDE_XTEST=1, see DEVELOPMENT.md) move the numbers and the current
// row; and no setting changes the document bytes, dirty state or the Undo history.
const LONG = 'word '.repeat(70).trim() // wraps to several rows in the Split source pane
// Ends with a newline: the Split source pane always shows a final empty line, so the gutter and the
// host's line count agree only for a document that ends with one.
const DOC = `Alpha line\n\n${LONG}\n\nTail line\n`
const SETTINGS = [
  'editor.sourceFontSize',
  'editor.sourceLineNumbers',
  'editor.sourceBackground',
  'editor.sourceHighlightCurrentLine',
  'editor.sourceCurrentLineBackground',
  'editor.splitGap',
  'editor.fontSize',
] as const

type Frame = ReturnType<typeof wf>
type Evaluate = <A extends unknown[]>(
  fn: (vscode: typeof import('vscode'), args: A) => Promise<unknown>,
  args: A,
) => Promise<unknown>

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const global = vscode.ConfigurationTarget.Global
      const config = vscode.workspace.getConfiguration('vmde')
      for (const key of (args as [string[]])[0])
        await config.update(key, undefined, global)
    },
    [[...SETTINGS]] as [string[]],
  )
})

// `null` clears the key (back to its default). The settings travel as one JSON string because the
// evaluator cannot carry `null` across the process boundary.
async function setConfig(
  evaluateInVSCode: Evaluate,
  values: Record<string, string | number | boolean | null>,
) {
  await evaluateInVSCode(
    async (vscode, args) => {
      const entries = JSON.parse((args as [string])[0]) as Record<
        string,
        string | number | boolean | null
      >
      const global = vscode.ConfigurationTarget.Global
      const config = vscode.workspace.getConfiguration('vmde')
      for (const [key, value] of Object.entries(entries))
        await config.update(key, value === null ? undefined : value, global)
    },
    [JSON.stringify(values)] as [string],
  )
}

const readDocument = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode, args) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === (args as [string])[0],
      )
      return {
        text: document?.getText() ?? null,
        dirty: document?.isDirty ?? null,
        lines: document?.lineCount ?? 0,
      }
    },
    [file] as [string],
  ) as Promise<{ text: string | null; dirty: boolean | null; lines: number }>

async function openInSplitView(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<Frame> {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri, extensionId] = args as [string, string]
      await vscode.extensions.getExtension(extensionId)?.activate()
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file, ExtensionId] as [string, string],
  )
  const frame = wf(workbox)
  await frame.locator('body').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode !== null,
    { message: 'Task 645 editor readiness', timeout: 60_000 },
  )
  const mode = await frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeE2EReadiness?: { mode: string | null } })
          .__vmdeE2EReadiness?.mode,
    )
  if (mode !== 'sv') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="sv"]').click()
  }
  await frame.locator('.vditor-sv').waitFor({ timeout: 30_000 })
  await frame.locator('.vditor-preview').first().waitFor({ timeout: 30_000 })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'Task 645 split-view readiness',
  })
  return frame
}

interface Pane {
  sourceFont: string
  sourceLineHeight: string
  previewFont: string
  sourceBackground: string
  gap: number
}

const readPane = (frame: Frame): Promise<Pane> =>
  frame.locator('body').evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const preview = document.querySelector('.vditor-preview') as HTMLElement
    const reset = preview.querySelector('.vditor-reset') as HTMLElement
    const cs = getComputedStyle(sv)
    return {
      sourceFont: cs.fontSize,
      sourceLineHeight: cs.lineHeight,
      previewFont: getComputedStyle(reset).fontSize,
      sourceBackground: cs.backgroundColor,
      gap:
        preview.getBoundingClientRect().left - sv.getBoundingClientRect().right,
    }
  })

interface Gutter {
  numbers: string[]
  subs: { mark: string; text: string }[]
  newlines: number
  columns: number
  insideEditor: boolean
}

const readGutter = (frame: Frame): Promise<Gutter> =>
  frame.locator('body').evaluate(() => {
    const overlay = document.querySelector('body > .vmde-sv-gutter')
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const layer = overlay?.querySelector(
      '.vmde-sv-gutter__layer',
    ) as HTMLElement | null
    let columns = 0
    if (overlay && layer) {
      const probe = document.createElement('span')
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre'
      probe.textContent = '0'.repeat(20)
      overlay.appendChild(probe)
      columns =
        layer.getBoundingClientRect().width /
        (probe.getBoundingClientRect().width / 20)
      probe.remove()
    }
    return {
      numbers: Array.from(
        overlay?.querySelectorAll('.vmde-sv-gutter__num') ?? [],
      ).map((el) => el.textContent ?? ''),
      subs: Array.from(
        overlay?.querySelectorAll('.vmde-sv-gutter__sub') ?? [],
      ).map((el) => ({
        mark: el.querySelector('.vmde-sv-gutter__mark')?.textContent ?? '',
        text: el.querySelector('.vmde-sv-gutter__subnum')?.textContent ?? '',
      })),
      newlines: sv.querySelectorAll('[data-type="newline"]').length,
      columns: Math.round(columns * 10) / 10,
      insideEditor: !!overlay?.closest('.vditor'),
    }
  })

interface Band {
  height: number
  bandCenter: number | null
  caretCenter: number | null
  background: string
}

// The caret's row center in viewport coordinates. A caret at an element boundary has no rect of its
// own: an empty line reports its line break, a caret after a text span reports that span's last row.
const readCaretCenter = (frame: Frame): Promise<number | null> =>
  frame.locator('body').evaluate(() => {
    const range = getSelection()?.rangeCount
      ? getSelection()?.getRangeAt(0)
      : null
    if (!range) return null
    let rect: DOMRect | undefined = range.getClientRects()[0]
    if (!rect) {
      const container = range.startContainer
      const element =
        container.nodeType === 1
          ? (container as HTMLElement)
          : (container.parentElement as HTMLElement)
      const lineBreak = element.closest('[data-type="newline"]')
      const contents = document.createRange()
      contents.selectNodeContents(element)
      const rects = contents.getClientRects()
      rect = lineBreak
        ? (lineBreak.firstElementChild as HTMLElement).getBoundingClientRect()
        : rects[rects.length - 1]
    }
    return rect ? rect.top + rect.height / 2 : null
  })

// The current-row band (viewport coordinates) and the caret's own row center.
const readBand = async (frame: Frame): Promise<Band> => {
  const band = await frame.locator('body').evaluate(() => {
    const sv = document.querySelector('.vditor-sv') as HTMLElement
    const cs = getComputedStyle(sv)
    const top = parseFloat(cs.getPropertyValue('--vmde-sv-row-top')) || 0
    const height = parseFloat(cs.getPropertyValue('--vmde-sv-row-height')) || 0
    const svRect = sv.getBoundingClientRect()
    return {
      height,
      bandCenter:
        height > 0
          ? svRect.top + sv.clientTop + top - sv.scrollTop + height / 2
          : null,
      background: cs.backgroundImage,
    }
  })
  return { ...band, caretCenter: await readCaretCenter(frame) }
}

// Places a collapsed caret `offset` characters into the source line that starts with `lineText`.
const placeCaret = (frame: Frame, lineText: string, offset: number) =>
  frame.locator('body').evaluate(
    (_body, args) => {
      const sv = document.querySelector('.vditor-sv') as HTMLElement
      sv.focus()
      const span = Array.from(
        sv.querySelectorAll<HTMLElement>('[data-type="text"]'),
      ).find((el) => (el.textContent ?? '').startsWith(args.lineText))
      if (!span) return false
      // The span can start with an empty text node: use the first node that holds text.
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node && !(node as Text).data.length) node = walker.nextNode()
      if (!node) return false
      const range = document.createRange()
      range.setStart(node, Math.min(args.offset, (node as Text).data.length))
      range.collapse(true)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return true
    },
    { lineText, offset },
  )

test('source pane settings apply live, keep the document untouched and answer OS keys', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'sv-pane-settings.md')
  writeFileSync(file, DOC)
  await setConfig(evaluateInVSCode, {
    'editor.fontSize': '17',
    'editor.sourceFontSize': null,
    'editor.sourceLineNumbers': null,
    'editor.sourceBackground': null,
    'editor.sourceHighlightCurrentLine': null,
    'editor.sourceCurrentLineBackground': null,
    'editor.splitGap': null,
  })
  const frame = await openInSplitView(workbox, evaluateInVSCode, file)
  await expect
    .poll(async () => (await readPane(frame)).sourceFont, {
      message: 'source pane follows fontSize by default',
    })
    .toBe('17px')

  // --- Defaults, then each setting live -------------------------------------------------------
  const base = await readPane(frame)
  expect(base.previewFont).toBe('17px')
  expect(base.gap).toBe(0)
  expect(await readGutter(frame).then((g) => g.numbers.length)).toBe(0)

  await setConfig(evaluateInVSCode, { 'editor.sourceFontSize': '20' })
  await expect.poll(async () => (await readPane(frame)).sourceFont).toBe('20px')
  const sized = await readPane(frame)
  expect(sized.sourceLineHeight).toBe('31px')
  expect(sized.previewFont).toBe(base.previewFont) // fontSize still sizes the rendered pane

  await setConfig(evaluateInVSCode, { 'editor.sourceBackground': '#102030' })
  await expect
    .poll(async () => (await readPane(frame)).sourceBackground)
    .toBe('rgb(16, 32, 48)')

  await setConfig(evaluateInVSCode, { 'editor.splitGap': 24 })
  await expect.poll(async () => (await readPane(frame)).gap).toBe(24)

  // Invalid values fall back to the defaults.
  await setConfig(evaluateInVSCode, {
    'editor.sourceFontSize': 'huge',
    'editor.sourceBackground': 'red;}',
    'editor.splitGap': 500,
  })
  await expect
    .poll(async () => {
      const pane = await readPane(frame)
      return [pane.sourceFont, pane.sourceBackground, pane.gap]
    })
    .toEqual([base.sourceFont, base.sourceBackground, 0])
  await setConfig(evaluateInVSCode, {
    'editor.sourceFontSize': null,
    'editor.sourceBackground': null,
    'editor.splitGap': null,
  })

  // --- Line numbers ---------------------------------------------------------------------------
  const lineCount = (await readDocument(evaluateInVSCode, file)).lines
  await setConfig(evaluateInVSCode, { 'editor.sourceLineNumbers': true })
  await expect
    .poll(async () => (await readGutter(frame)).numbers.length)
    .toBe(lineCount)
  const gutter = await readGutter(frame)
  expect(gutter.numbers).toEqual(
    Array.from({ length: lineCount }, (_, i) => String(i + 1)),
  )
  expect(gutter.newlines).toBe(lineCount)
  expect(gutter.subs.length).toBeGreaterThan(0)
  expect(gutter.subs.every((sub) => sub.mark === '↳')).toBe(true)
  expect(gutter.subs[0].text).toBe('1')
  expect(gutter.insideEditor).toBe(false)

  // --- Nothing above touched the document ------------------------------------------------------
  await setConfig(evaluateInVSCode, {
    'editor.sourceHighlightCurrentLine': true,
    'editor.sourceCurrentLineBackground': '#112233',
  })
  const untouched = await readDocument(evaluateInVSCode, file)
  expect(untouched.text).toBe(DOC)
  expect(untouched.dirty).toBe(false)

  // --- OS-level keys ---------------------------------------------------------------------------
  const delay = await frame
    .locator('body')
    .evaluate(
      () => ((window as any).vditor.vditor.options.undoDelay as number) ?? 800,
    )
  await workbox.waitForTimeout(delay + 400) // the opening Undo snapshot settles first
  const xtest = await createXtestInput(electronApp, workbox)
  await xtest.activateAndFocus()
  await frame.locator('.vditor-sv').click({ position: { x: 120, y: 8 } })
  await xtest.key('ctrl+z') // the first XTEST Ctrl chord may not arrive; inert on a settled document

  // The band follows ArrowDown across source lines and is hidden by a selection.
  expect(await placeCaret(frame, 'Alpha line', 10)).toBe(true)
  await expect
    .poll(async () => {
      const band = await readBand(frame)
      return (
        band.bandCenter !== null &&
        band.caretCenter !== null &&
        Math.abs(band.bandCenter - band.caretCenter) <= 2
      )
    })
    .toBe(true)
  const first = await readBand(frame)
  expect(first.background).toContain('rgb(17, 34, 51)')
  await xtest.key('Down')
  await xtest.key('Down')
  await expect
    .poll(async () => {
      const band = await readBand(frame)
      return (
        band.bandCenter !== null &&
        band.caretCenter !== null &&
        band.bandCenter > first.bandCenter! + 20 &&
        Math.abs(band.bandCenter - band.caretCenter) <= 2
      )
    })
    .toBe(true)
  await xtest.key('shift+Right')
  await expect.poll(async () => (await readBand(frame)).height).toBe(0)
  await xtest.key('Right')

  expect(await placeCaret(frame, 'Tail line', 9)).toBe(true)
  await xtest.type('Q')
  await expect
    .poll(async () => (await readDocument(evaluateInVSCode, file)).text)
    .toBe(DOC.replace('Tail line', 'Tail lineQ'))
  await workbox.waitForTimeout(delay + 400)
  await xtest.key('ctrl+z')
  await expect
    .poll(async () => (await readDocument(evaluateInVSCode, file)).text)
    .toBe(DOC)
  await expect
    .poll(async () => (await readDocument(evaluateInVSCode, file)).dirty)
    .toBe(false)

  // Enter adds a line number and Backspace takes it away again. A lone Enter is not written to the
  // host until the next edit (the same as before this task), so the host is checked afterwards.
  expect(await placeCaret(frame, 'Alpha line', 10)).toBe(true)
  await xtest.key('Return')
  await expect
    .poll(async () => (await readGutter(frame)).numbers.length)
    .toBe(lineCount + 1)
  await xtest.key('BackSpace')
  await expect
    .poll(async () => (await readGutter(frame)).numbers.length)
    .toBe(lineCount)
  await expect
    .poll(async () => (await readDocument(evaluateInVSCode, file)).text)
    .toBe(DOC)

  // --- Turning the numbers off removes the gutter, again without touching the document ----------
  await setConfig(evaluateInVSCode, {
    'editor.sourceLineNumbers': false,
    'editor.sourceHighlightCurrentLine': false,
  })
  await expect
    .poll(async () => (await readGutter(frame)).numbers.length)
    .toBe(0)
  const end = await readDocument(evaluateInVSCode, file)
  expect(end.text).toBe(DOC)
  expect(end.dirty).toBe(false)
})
