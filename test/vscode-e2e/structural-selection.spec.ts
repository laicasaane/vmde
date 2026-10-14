import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const INITIAL = [
  'alpha **bold scope** omega',
  '',
  '- first item',
  '  - nested item',
  '',
  '| A | B |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```ts',
  'const fence = true',
  '```',
  '',
  'strikeword remains',
  '',
  'list target',
  '',
  'final paragraph',
].join('\n')

type VmdeFrame = ReturnType<typeof wf>

// Task 580 CP2-6 — Select All and Expand Selection are the contributed `vmde.selectAll` and
// `vmde.expandSelection` commands on VS Code's own Linux keys, so every key below goes through VS
// Code's keybinding service. Ctrl+E is free again (VS Code's Quick Open).
const SELECT_ALL = 'Control+a'
const EXPAND = 'Shift+Alt+ArrowRight'

const selectionText = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => getSelection()?.toString() ?? '')

const wholeEditorSelected = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    return Boolean(
      range &&
        range.startContainer === editor &&
        range.startOffset === 0 &&
        range.endContainer === editor &&
        range.endOffset === editor.childNodes.length,
    )
  })

const markdown = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() =>
      (
        window as unknown as { vditor: { getValue(): string } }
      ).vditor.getValue(),
    )

const insertText = (frame: VmdeFrame, text: string) =>
  frame.locator('body').evaluate((_body, insert) => {
    document.execCommand('insertText', false, insert as string)
  }, text)

const copyOf = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const editor = (window as any).vditor.vditor.ir.element as HTMLElement
    const data = new DataTransfer()
    editor.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return data.getData('text/plain')
  })

const selectFenceBlock = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = (window as any).vditor.vditor.ir.element as HTMLElement
    const block = surface.querySelector<HTMLElement>(
      '[data-type="code-block"]',
    )!
    surface.focus({ preventScroll: true })
    const range = document.createRange()
    range.selectNodeContents(block)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })

const copySelection = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    const data = new DataTransfer()
    data.setData('text/plain', '__UNSET__')
    data.setData('text/html', '__UNSET__')
    surface.dispatchEvent(
      new ClipboardEvent('copy', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    )
    return {
      plain: data.getData('text/plain'),
      html: data.getData('text/html'),
    }
  })

async function placeText(frame: VmdeFrame, needle: string): Promise<boolean> {
  return frame.locator('body').evaluate((_body, target) => {
    const surface = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    // Ctrl+A now reaches Vditor's keydown, whose first-position undo record splits the caret's
    // text node (Task 580 P6); rejoin the halves so the needle is found again.
    surface.normalize()
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.nodeValue ?? '').indexOf(target as string)
      if (index < 0 || node.parentElement?.closest('.vditor-ir__preview'))
        continue
      node.parentElement
        ?.closest<HTMLElement>('[data-block]')
        ?.scrollIntoView({ block: 'center' })
      surface.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, index + Math.floor((target as string).length / 2))
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      ;(window as any).__vmdeRequestCaret?.({
        node: range.startContainer,
        offset: range.startOffset,
      })
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    return false
  }, needle)
}

const expandedTarget = (frame: VmdeFrame, needle: string) =>
  frame
    .locator('body')
    .evaluate(
      (_body, target) =>
        Array.from(
          document.querySelectorAll<HTMLElement>('.vditor-ir__node--expand'),
        ).some((node) => (node.textContent ?? '').includes(target as string)),
      needle,
    )

const placeFenceForKey = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const block = document.querySelector<HTMLElement>(
      '.vditor-ir [data-type="code-block"]',
    )
    const source = block?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    if (!block || !source) return false
    block.classList.add('vditor-ir__node--expand')
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
    let target: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent ?? '').includes('const fence')) {
        target = node as Text
        break
      }
    }
    if (!target) return false
    source.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(target, 3)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  })

test('real IR structural selection stages scopes without stealing format chords', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'structural-selection.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath, ExtensionId] as [string, string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'structural-selection fixture readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 20, y: 20 } })

  await expect.poll(() => placeText(frame, 'alpha')).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => selectionText(frame)).toContain('alpha')
  expect(await selectionText(frame)).not.toContain('final paragraph')
  expect(await copySelection(frame)).toEqual({
    plain: 'alpha **bold scope** omega',
    html: '',
  })
  await expect.poll(() => placeText(frame, 'alpha')).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => selectionText(frame)).toContain('alpha')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  await expect.poll(() => expandedTarget(frame, 'bold scope')).toBe(true)
  await expect.poll(() => placeText(frame, 'bold scope')).toBe(true)
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => selectionText(frame)).toBe('bold scope')
  await insertText(frame, 'REPLACED')
  await expect.poll(() => markdown(frame)).toContain('alpha **REPLACED** omega')

  // The fence-source stage comes first from a caret in the code. Vditor's own IR keydown selects
  // the code too; the command's selection snapshot keeps the ladder starting from the caret.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeFenceForKey(frame)).toBe(true)
  await workbox.keyboard.press(SELECT_ALL)
  await expect
    .poll(async () => (await selectionText(frame)).trim())
    .toBe('const fence = true')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => copyOf(frame)).toContain('```ts')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await selectFenceBlock(frame)
  expect(await copyOf(frame)).toContain('```ts')
  await workbox.keyboard.press(SELECT_ALL)
  // Read the Range, not the selection text: measured here, Chromium's text of this
  // element-boundary document selection can stop before the last block.
  await expect.poll(() => wholeEditorSelected(frame)).toBe(true)

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  // Task 580 CP3-1 — Strikethrough and Bulleted List ship unbound; their commands still act after
  // the structural stages above.
  expect(await placeText(frame, 'strikeword')).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.format.strike')
  })
  await expect.poll(() => markdown(frame)).toContain('~~strikeword~~ remains')
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'list target')).toBe(true)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.format.list')
  })
  await expect.poll(() => markdown(frame)).toContain('* list target')

  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'cell one')).toBe(true)
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => selectionText(frame)).toBe('cell one')
  await workbox.keyboard.press(EXPAND)
  await expect.poll(() => copyOf(frame)).toContain('| cell one | cell two |')

  await expect.poll(() => placeText(frame, 'REPLACED')).toBe(true)
  await expect.poll(() => expandedTarget(frame, 'REPLACED')).toBe(true)
  await workbox.keyboard.press('Escape')
  await expect.poll(() => expandedTarget(frame, 'REPLACED')).toBe(false)
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press('Escape')
  expect(await selectionText(frame)).toContain('alpha')
  await workbox.keyboard.press('Tab')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => document.activeElement?.closest('[role="toolbar"]') !== null,
        ),
    )
    .toBe(true)

  // Ctrl+E no longer expands in the webview: VS Code runs its own binding (Quick Open).
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  expect(await placeText(frame, 'final paragraph')).toBe(true)
  await workbox.keyboard.press('Control+e')
  await expect(workbox.locator('.quick-input-widget')).toBeVisible()
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press('Escape')
  await expect(workbox.locator('.quick-input-widget')).toBeHidden()

  // In VMDE's Find input, Select All selects the input's text.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.find')
  })
  const findInput = frame.locator('.vmde-find-replace input').first()
  await expect(findInput).toBeVisible()
  await findInput.fill('alpha')
  await findInput.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(2, 2),
  )
  await workbox.keyboard.press(SELECT_ALL)
  await expect
    .poll(() =>
      findInput.evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    )
    .toEqual([0, 5])
  await workbox.keyboard.press('Escape')
  await expect(frame.locator('.vmde-find-replace')).toBeHidden()

  const finalValue = await markdown(frame)
  expect(finalValue).toContain('alpha **REPLACED** omega')
  expect(finalValue).toContain('~~strikeword~~ remains')
  expect(finalValue).toContain('* list target')
  expect(finalValue).toContain('```ts\nconst fence = true\n```')
})

// Task 580 CP2-6 — outside IR, Select All keeps what the native key did before the guard (Task 580
// P4): the whole surface in WYSIWYG and Split View. Expand Selection has no scopes there. In
// Preview the guard leaves the key to the browser's own select-all and the command does nothing.
test('real Select All selects the whole surface in WYSIWYG and SV, and Preview keeps native select-all', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const docPath = path.join(baseDir, 'structural-selection-modes.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath, ExtensionId] as [string, string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'structural-selection modes readiness' },
  )
  const switchMode = async (mode: 'wysiwyg' | 'sv') => {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: `structural-selection ${mode} readiness`,
    })
  }
  const surfaceSelected = () =>
    frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      const surface = inner[inner.currentMode].element as HTMLElement
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      return Boolean(
        range &&
          surface.contains(range.startContainer) &&
          surface.contains(range.endContainer) &&
          range.toString().includes('alpha') &&
          range.toString().includes('final paragraph'),
      )
    })

  await switchMode('wysiwyg')
  await frame
    .locator('.vditor-wysiwyg .vditor-reset > p')
    .filter({ hasText: 'final paragraph' })
    .click()
  await workbox.keyboard.press(EXPAND)
  await workbox.waitForTimeout(500)
  expect(await selectionText(frame)).toBe('')
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(surfaceSelected).toBe(true)

  await switchMode('sv')
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 8, y: 8 } })
  await workbox.keyboard.press(SELECT_ALL)
  await expect.poll(surfaceSelected).toBe(true)
  expect(await selectionText(frame)).toContain('```ts')

  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const preview = frame.locator('.vditor-preview').first()
  await expect(preview).toBeVisible()
  await preview.getByText('final paragraph').click()
  const beforePreviewSelectAll = await markdown(frame)
  await workbox.keyboard.press(SELECT_ALL)
  // The browser selects the whole webview document, so the rendered preview text with it.
  await expect
    .poll(() => selectionText(frame))
    .toContain('alpha bold scope omega')
  expect(await selectionText(frame)).toContain('final paragraph')
  expect(await markdown(frame)).toBe(beforePreviewSelectAll)
})

// Task 613 and Task 615 — a selection made inside the windows that follow a prose keystroke. A
// one-code-point prose keystroke skips Vditor's spin: `edit-activity` replays it as a synthetic
// `input` 220 ms later (the settle re-spin), and Vditor records the edit in its undo stack
// `undoDelay` after that. Both used to collapse a whole-document Range (and the table block stage,
// `selectNode(table)`, which also has its endpoints on the editable root) to the document start.
// Every selection below is made by OS-level XTEST keys inside the 220 ms window.
const SELECT_ALL_KEY = 'ctrl+a'

type Stage = 'whole' | 'table' | 'collapsed' | 'range' | 'none'
interface ProbeEvent {
  kind: 'typed' | 'respin' | 'selection' | 'pointerdown' | 'pointerup'
  at: number
  stage?: Stage
}

// Page-side recorder. `typed` is a trusted `input` event (the keystroke), `respin` is edit-activity's
// untrusted `insertText` input with empty data, `selection` is every `selectionchange` with the
// selection's shape. It only listens; it never touches the selection, timers or the source.
const installSettleProbe = () => {
  const w = window as any
  const editor = w.vditor.vditor.ir.element as HTMLElement
  const log: ProbeEvent[] = []
  const stage = (): Stage => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!range) return 'none'
    if (
      range.startContainer === editor &&
      range.startOffset === 0 &&
      range.endContainer === editor &&
      range.endOffset === editor.childNodes.length
    )
      return 'whole'
    const table = editor.querySelector('table')
    const parent = table?.parentNode
    const index = parent
      ? Array.prototype.indexOf.call(parent.childNodes, table)
      : -1
    if (
      parent &&
      range.startContainer === parent &&
      range.startOffset === index &&
      range.endContainer === parent &&
      range.endOffset === index + 1
    )
      return 'table'
    return range.collapsed ? 'collapsed' : 'range'
  }
  editor.addEventListener(
    'input',
    (event) => {
      const input = event as InputEvent
      if (input.isTrusted) log.push({ kind: 'typed', at: performance.now() })
      else if (input.inputType === 'insertText' && input.data === '')
        log.push({ kind: 'respin', at: performance.now() })
    },
    true,
  )
  document.addEventListener('selectionchange', () =>
    log.push({ kind: 'selection', at: performance.now(), stage: stage() }),
  )
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button === 0)
        log.push({ kind: 'pointerdown', at: performance.now() })
    },
    true,
  )
  window.addEventListener(
    'pointerup',
    (event) => {
      if (event.button === 0)
        log.push({ kind: 'pointerup', at: performance.now() })
    },
    true,
  )
  w.__settleProbe = {
    reset: () => {
      log.length = 0
    },
    state: () => ({ log: log.slice(), now: performance.now(), stage: stage() }),
    stage,
  }
}

const probeState = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(
    () =>
      (window as any).__settleProbe.state() as {
        log: ProbeEvent[]
        now: number
        stage: Stage
      },
  )

const resetProbe = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => (window as any).__settleProbe.reset())

const stageOf = async (frame: VmdeFrame) => (await probeState(frame)).stage

const respinCount = async (frame: VmdeFrame) =>
  (await probeState(frame)).log.filter((event) => event.kind === 'respin')
    .length

const undoDepthOf = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(
      () => (window as any).vditor.vditor.undo.ir.undoStack.length as number,
    )

// Text and direction of the live selection. A backward selection has its focus before its anchor.
const selectionInfo = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    let backward = false
    if (selection.anchorNode && selection.focusNode) {
      const range = document.createRange()
      range.setStart(selection.anchorNode, selection.anchorOffset)
      range.setEnd(selection.focusNode, selection.focusOffset)
      backward = range.collapsed && !selection.isCollapsed
    }
    return { text: selection.toString(), backward }
  })

interface WindowRecord {
  label: string
  firstSelectionAfterTypedMs: number
  keysTookMs: number
  keyCostMs: number
  selectedAfterTypedMs: number
  respinAfterTypedMs: number
}

async function openIrFixture(
  fixtures: {
    workbox: Page
    evaluateInVSCode: (fn: any, args: any) => Promise<unknown>
    electronApp: ElectronApplication
    baseDir: string
  },
  fileName: string,
) {
  const { workbox, evaluateInVSCode, electronApp, baseDir } = fixtures
  const docPath = path.join(baseDir, fileName)
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [docPath, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: `${fileName} readiness` },
  )
  const delay = await frame
    .locator('body')
    .evaluate(
      () => ((window as any).vditor.vditor.options.undoDelay as number) ?? 800,
    )
  // The opening snapshot settles first: a first keydown on a one-entry history runs Vditor's
  // recordFirstPosition, which is outside this task (see tasks/613's follow-up).
  await workbox.waitForTimeout(delay + 200)
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  await xtest.activateAndFocus()
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  // The first XTEST Ctrl chord of a VS Code session sometimes never reaches the webview (Task 598
  // investigation), so send one Ctrl+Z to the untouched, settled document first. It is inert there.
  await xtest.key('ctrl+z')
  await frame.locator('body').evaluate(installSettleProbe)
  // Cost of one XTEST key, measured with an inert modifier press on the settled document.
  const calibrationStart = Date.now()
  for (let press = 0; press < 3; press++) await xtest.key('Shift_L')
  const keyCostMs = Math.round((Date.now() - calibrationStart) / 3)
  return { frame, delay, xtest, keyCostMs }
}

// Place the caret in `needle`, type `letter` with XTEST, wait (less the cost of the presses), then
// send `presses` Select All keys. The selection must reach `want` before the settle re-spin runs,
// keep it through the re-spin, and keep it through the undo snapshot (which adds exactly one Undo
// entry).
async function selectAllInsideSettleWindow(
  s: {
    frame: VmdeFrame
    workbox: Page
    xtest: XtestInput
    keyCostMs: number
  },
  options: {
    label: string
    needle: string
    letter: string
    targetMs: number
    presses: number
    want: 'whole' | 'table'
    source: string
  },
): Promise<WindowRecord> {
  const { frame, workbox, xtest } = s
  expect(await placeText(frame, options.needle)).toBe(true)
  const depth = await undoDepthOf(frame)
  await resetProbe(frame)
  await xtest.type(options.letter)
  // An XTEST key costs a few processes (focus check and xdotool), so the wait is shortened by
  // the measured cost of the presses that follow: the last Select All lands near `targetMs`.
  await workbox.waitForTimeout(
    Math.max(0, options.targetMs - s.keyCostMs * options.presses),
  )
  const keyStartedAt = Date.now()
  for (let press = 0; press < options.presses; press++)
    await xtest.key(SELECT_ALL_KEY)
  const keysTookMs = Date.now() - keyStartedAt
  await expect.poll(() => stageOf(frame)).toBe(options.want)
  await expect.poll(() => respinCount(frame)).toBe(1) // the settle re-spin ran
  const log = (await probeState(frame)).log
  const typedAt = log.find((event) => event.kind === 'typed')!.at
  const firstKeyAt = log.find(
    (event) =>
      event.kind === 'selection' &&
      event.stage !== 'collapsed' &&
      event.at > typedAt,
  )!.at
  const selectedAt = log.find(
    (event) =>
      event.kind === 'selection' &&
      event.stage === options.want &&
      event.at > typedAt,
  )!.at
  const respinAt = log.find((event) => event.kind === 'respin')!.at
  expect(selectedAt, 'the selection landed before the re-spin').toBeLessThan(
    respinAt,
  )
  expect(await markdown(frame)).toContain(options.source) // the keystroke itself landed
  expect(await stageOf(frame), 'kept through the settle re-spin').toBe(
    options.want,
  )
  expect(await undoDepthOf(frame)).toBe(depth) // the edit's snapshot is still pending
  await expect.poll(() => undoDepthOf(frame)).toBe(depth + 1)
  await workbox.waitForTimeout(200) // negative assertion: nothing after the snapshot moves it
  expect(await stageOf(frame), 'kept through the undo snapshot').toBe(
    options.want,
  )
  return {
    label: options.label,
    firstSelectionAfterTypedMs: Math.round(firstKeyAt - typedAt),
    keysTookMs,
    selectedAfterTypedMs: Math.round(selectedAt - typedAt),
    keyCostMs: s.keyCostMs,
    respinAfterTypedMs: Math.round(respinAt - typedAt),
  }
}

test('real Select All, Delete, type-over and Shift+Arrow inside the prose-settle window keep their selection through the settle re-spin and the undo snapshot', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const s = {
    ...(await openIrFixture(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'structural-selection-settle-window.md',
    )),
    workbox,
  }
  const { frame, delay, xtest } = s
  const records: WindowRecord[] = []

  // Acceptance 1: Select All 50 ms and 150 ms after the keystroke (block stage, then document stage).
  records.push(
    await selectAllInsideSettleWindow(s, {
      label: 'document stage, short wait',
      needle: 'final paragraph',
      letter: 'Z',
      targetMs: 50,
      presses: 2,
      want: 'whole',
      source: 'final pZaragraph',
    }),
    await selectAllInsideSettleWindow(s, {
      label: 'document stage, long wait',
      needle: 'strikeword',
      letter: 'Z',
      targetMs: 150,
      presses: 2,
      want: 'whole',
      source: 'strikZeword remains',
    }),
  )

  // Edge: the table block stage is a `selectNode(table)` Range, also on the root.
  records.push(
    await selectAllInsideSettleWindow(s, {
      label: 'table block stage, short wait',
      needle: 'cell one',
      letter: 'X',
      targetMs: 50,
      presses: 1,
      want: 'table',
      source: '| cellX one |',
    }),
  )

  // Acceptance 2: Delete and type-over of the whole document, each undone in one step to the exact
  // source. The selection is made inside the window; the act follows the re-spin and the snapshot.
  for (const [label, needle, source, act, expected, extraMs] of [
    [
      'before Delete',
      'list target',
      'list Ztarget',
      () => xtest.key('Delete'),
      '\n',
      0,
    ],
    [
      'before type-over',
      'remains',
      'remZains',
      () => xtest.type('X'),
      'X\n',
      220,
    ],
  ] as const) {
    records.push(
      await selectAllInsideSettleWindow(s, {
        label: `${label}, short wait`,
        needle,
        letter: 'Z',
        targetMs: 50,
        presses: 2,
        want: 'whole',
        source,
      }),
    )
    const original = await markdown(frame)
    await act()
    await expect.poll(() => markdown(frame)).toBe(expected)
    // The type-over letter is a skipped prose keystroke too: its re-spin runs 220 ms after it and
    // Vditor's undo snapshot `undoDelay` after that, so the replacement is its own Undo step only then.
    await workbox.waitForTimeout(delay + 200 + extraMs)
    await xtest.key('ctrl+z')
    await expect.poll(() => markdown(frame)).toBe(original)
    await workbox.waitForTimeout(delay + 200)
  }

  // Edge: a Shift+Arrow selection made inside the window keeps its text and direction through the
  // re-spin, and the next Shift+Arrow extends it from the same anchor. The expected text is read from
  // the DOM before the keystroke (the characters left of the caret), not from the code under test.
  expect(await placeText(frame, 'target')).toBe(true)
  const preceding = await frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    return (selection.anchorNode as Text).data.slice(
      selection.anchorOffset - 3,
      selection.anchorOffset,
    )
  })
  expect(preceding).toHaveLength(3)
  const depth = await undoDepthOf(frame)
  await resetProbe(frame)
  await xtest.type('Z')
  await xtest.key('shift+Left')
  await xtest.key('shift+Left')
  expect(await respinCount(frame), 'Shift+Arrow ran before the settle').toBe(0)
  expect(await selectionInfo(frame)).toEqual({
    text: `${preceding.slice(2)}Z`,
    backward: true,
  })
  await expect.poll(() => respinCount(frame)).toBe(1)
  expect(await selectionInfo(frame), 'kept through the re-spin').toEqual({
    text: `${preceding.slice(2)}Z`,
    backward: true,
  })
  await expect.poll(() => undoDepthOf(frame)).toBe(depth + 1)
  expect(await selectionInfo(frame), 'kept through the snapshot').toEqual({
    text: `${preceding.slice(2)}Z`,
    backward: true,
  })
  await xtest.key('shift+Left')
  expect(await selectionInfo(frame), 'extends from the same anchor').toEqual({
    text: `${preceding.slice(1)}Z`,
    backward: true,
  })
  console.log('[Task 615 settle window]', JSON.stringify(records))
})

// Edge (Task 615 contract 5): while the primary pointer is held, the settle re-spin waits for the
// release, so no DOM rebuild runs under a native drag; after the release it runs and the dragged
// selection (here backward and across two blocks) is restored with its text and direction.
test('real held drag that crosses the prose-settle deadline keeps its selection through the re-spin after release', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const s = await openIrFixture(
    { workbox, electronApp, evaluateInVSCode, baseDir },
    'structural-selection-settle-drag.md',
  )
  const { frame, xtest } = s
  expect(await placeText(frame, 'final paragraph')).toBe(true)
  const pointIn = async (needle: string, offset: number) => {
    const paragraph = frame
      .locator('.vditor-ir .vditor-reset > p')
      .filter({ hasText: needle })
      .first()
    const box = await paragraph.boundingBox()
    if (!box) throw new Error(`no box for ${needle}`)
    const rel = await paragraph.evaluate((element, at) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      const node = walker.nextNode() as Text
      const range = document.createRange()
      range.setStart(node, at)
      range.collapse(true)
      const rect = range.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return {
        x: rect.x - bounds.x + 0.2,
        y: rect.y - bounds.y + rect.height / 2,
      }
    }, offset)
    return { x: box.x + rel.x, y: box.y + rel.y }
  }
  // Both endpoints are measured before the keystroke; the first line of each block does not move.
  const start = await pointIn('final paragraph', 4)
  const end = await pointIn('list target', 6)
  const depth = await undoDepthOf(frame)
  await workbox.mouse.move(start.x, start.y)
  await resetProbe(frame)
  await xtest.type('Z')
  await workbox.mouse.down()
  let dragged: Awaited<ReturnType<typeof selectionInfo>>
  try {
    for (let step = 1; step <= 5; step++) {
      await workbox.mouse.move(
        start.x + ((end.x - start.x) * step) / 5,
        start.y + ((end.y - start.y) * step) / 5,
      )
      await workbox.waitForTimeout(80)
    }
    const held = await probeState(frame)
    const typedAt = held.log.find((event) => event.kind === 'typed')!.at
    const downAt = held.log.find((event) => event.kind === 'pointerdown')!.at
    expect(downAt - typedAt, 'pointer was down inside the window').toBeLessThan(
      220,
    )
    expect(
      held.now - typedAt,
      'the hold crossed the settle deadline',
    ).toBeGreaterThan(220)
    expect(
      held.log.some((event) => event.kind === 'respin'),
      'no re-spin under the held pointer',
    ).toBe(false)
    dragged = await selectionInfo(frame) // the selection under the held pointer
  } finally {
    await workbox.mouse.up()
  }
  expect(dragged.backward).toBe(true)
  expect(dragged.text.length).toBeGreaterThan(10)
  await expect.poll(() => respinCount(frame)).toBe(1) // the re-spin ran after the release
  const log = (await probeState(frame)).log
  expect(log.find((event) => event.kind === 'respin')!.at).toBeGreaterThan(
    log.find((event) => event.kind === 'pointerup')!.at,
  )
  expect(await selectionInfo(frame), 'kept through the re-spin').toEqual(
    dragged,
  )
  expect(await markdown(frame)).toContain('final pZaragraph')
  await expect.poll(() => undoDepthOf(frame)).toBe(depth + 1)
  await workbox.waitForTimeout(200) // negative assertion: nothing after the snapshot moves it
  expect(await selectionInfo(frame), 'kept through the snapshot').toEqual(
    dragged,
  )
})
