/**
 * Task 196 — Find & Replace contract in the real VS Code webview, on the large synthetic fixture
 * (Test fixture scope, task record 2026-09-26: no small control document). Migrated from the
 * original small inline document: Find/Replace use VS Code's keys (Task 579), Replace All is one exact
 * transaction undone in one step, and a single replace
 * persists to disk. The rework adds exact-byte oracles: every expected document is derived from
 * the fixture's exact bytes (Vditor's own serialization differs from them in tables), checked in
 * host text and on disk, and again after save/reopen. Keyboard input is OS-level XTEST.
 * Document comparisons are booleans so fixture text stays out of failure output.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  BOLD_TOKEN,
  CROSS_REGION_TOKEN,
  FIXTURE_SHA256,
  PAIR_TOKEN,
  UNIQUE_PROSE_TOKEN,
  applyReplacements,
  literalMatches,
  wholeWordMatches,
} from './find-replace-fixture-helpers'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

async function typeInput(input: Locator, xtest: XtestInput, value: string) {
  await input.focus()
  await expect(input).toBeFocused()
  await xtest.key('ctrl+a')
  await xtest.type(value, 20)
  await expect(input).toHaveValue(value)
}

async function expectSelected(input: Locator) {
  await expect(input).toBeFocused()
  expect(
    await input.evaluate(
      (element: HTMLInputElement) =>
        element.selectionStart === 0 &&
        element.selectionEnd === element.value.length,
    ),
  ).toBe(true)
}

// Only arrange the editor selection here; every acceptance shortcut is delivered through XTEST.
async function selectFixtureWord(
  frame: ReturnType<typeof wf>,
  token: string,
  collapsed = false,
) {
  const editor = frame.locator('#app .vditor-ir .vditor-reset').first()
  await editor.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one live-browser task finds the token, arms caret authority and proves the same Range survived two frames
    async (root, args) => {
      const settledOnToken = (
        selection: Selection,
        node: Node,
        start: number,
        end: number,
      ) =>
        selection.anchorNode === node &&
        selection.anchorOffset === start &&
        selection.focusNode === node &&
        selection.focusOffset === end &&
        selection.isCollapsed === args.collapsed &&
        root.contains(node) &&
        (args.collapsed || selection.toString() === args.token)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.nodeValue ?? '').indexOf(args.token)
        if (index < 0 || !node.parentElement?.getClientRects().length) continue
        node.parentElement.scrollIntoView({ block: 'center' })
        ;(root as HTMLElement).focus({ preventScroll: true })
        const range = document.createRange()
        range.setStart(node, index + (args.collapsed ? 1 : 0))
        range.setEnd(node, index + (args.collapsed ? 1 : args.token.length))
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        // A synthetic Range is not a user gesture. Register it with the existing caret authority
        // so an older Undo checkpoint cannot move it back to a Markdown marker on the next rAF.
        const requestCaret = (window as any).__vmdeRequestCaret
        if (typeof requestCaret !== 'function')
          throw new Error('VMDE caret authority bridge is missing')
        const anchorOffset = index + (args.collapsed ? 1 : 0)
        requestCaret(
          args.collapsed
            ? { node, offset: anchorOffset }
            : {
                anchor: { node, offset: anchorOffset },
                focus: { node, offset: index + args.token.length },
              },
        )
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        const settled = window.getSelection()
        if (
          !settled ||
          !settledOnToken(
            settled,
            node,
            anchorOffset,
            index + (args.collapsed ? 1 : args.token.length),
          )
        )
          throw new Error('Fixture selection moved before the Find shortcut')
        return
      }
      throw new Error('Fixture selection anchor not found')
    },
    { token, collapsed },
  )
  await expect(editor).toBeFocused()
}

type Frame = ReturnType<typeof wf>

// Task 599: a collapsed caret at offset 3 of the first inline code span (a list item near the
// top), registered with the caret authority and checked two frames later.
async function caretInFirstInlineCode(frame: Frame) {
  const placed = await frame.locator('body').evaluate(async () => {
    const editor = document.querySelector<HTMLElement>(
      '#app .vditor-ir .vditor-reset',
    )!
    const code = editor.querySelector('span[data-type="code"] > code')
    const text = code?.firstChild
    if (!code || !(text instanceof Text)) return false
    code.scrollIntoView({ block: 'center' })
    editor.focus({ preventScroll: true })
    ;(window as any).__vmdeRequestCaret({ node: text, offset: 3 })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const selection = getSelection()!
    return (
      selection.isCollapsed &&
      selection.anchorNode === text &&
      selection.anchorOffset === 3
    )
  })
  expect(placed).toBe(true)
}

/** The editor selection after a close, as booleans and offsets only (never fixture text). */
function editorSelectionState(_body: Element, token: string) {
  const editor = document.querySelector('#app .vditor-ir .vditor-reset')!
  const selection = getSelection()!
  const block = (node: Node | null) =>
    (node instanceof Element ? node : node?.parentElement)?.closest(
      'p, li, h1, h2, h3, h4, h5, h6, td, th, pre',
    ) ?? null
  const anchorBlock = block(selection.anchorNode)
  return {
    focused: document.activeElement === editor,
    token: !selection.isCollapsed && selection.toString() === token,
    proseBlock:
      (anchorBlock?.tagName === 'P' || anchorBlock?.tagName === 'LI') &&
      anchorBlock === block(selection.focusNode) &&
      editor.contains(anchorBlock),
    collapsed: selection.isCollapsed,
    inCode: !!(
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement
    )?.closest('span[data-type="code"] > code'),
    offset: selection.anchorOffset,
  }
}

/** The webview's serialization with the single exact-case token replaced by `edit(token)`. */
function editUniqueProse(source: string, edit: (token: string) => string) {
  const found = [...source.matchAll(new RegExp(UNIQUE_PROSE_TOKEN, 'g'))]
  expect(found).toHaveLength(1)
  const start = found[0]!.index
  const end = start + UNIQUE_PROSE_TOKEN.length
  return source.slice(0, start) + edit(UNIQUE_PROSE_TOKEN) + source.slice(end)
}

async function setToggle(button: Locator, checked: boolean) {
  if ((await button.getAttribute('aria-checked')) !== String(checked))
    await button.click()
  await expect(button).toHaveAttribute('aria-checked', String(checked))
}

// Return only geometry agreement, never fixture text. The current overlay must still track the
// live match after content-visibility replaces a block's placeholder height.
function currentMatchOverlayInScroller(_body: Element, token: string): boolean {
  const editor = document.querySelector<HTMLElement>(
    '#app .vditor-ir .vditor-reset',
  )
  const overlay = document.querySelector<HTMLElement>(
    '.vmde-find-overlay--current',
  )
  if (!editor || !overlay) return false

  const firstVisibleMatchRect = () => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      const offset = node.data.indexOf(token)
      if (offset < 0) continue
      if (
        !node.parentElement?.checkVisibility?.({ contentVisibilityAuto: true })
      )
        return null
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + token.length)
      return (
        Array.from(range.getClientRects()).find(
          (rect) => rect.width > 0 && rect.height > 0,
        ) ?? null
      )
    }
    return null
  }
  const line = firstVisibleMatchRect()
  if (!line) return false

  const ancestors: HTMLElement[] = []
  for (
    let node: HTMLElement | null = editor;
    node && node !== document.body;
    node = node.parentElement
  )
    ancestors.push(node)
  const scroller =
    ancestors.find((node) => {
      const overflow = getComputedStyle(node).overflowY
      return (
        ['auto', 'scroll', 'overlay'].includes(overflow) &&
        node.scrollHeight > node.clientHeight + 1
      )
    }) ??
    (document.scrollingElement as HTMLElement | null) ??
    document.documentElement
  const documentScroller =
    scroller === document.scrollingElement ||
    scroller === document.documentElement ||
    scroller === document.body
  const bounds = documentScroller
    ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
    : scroller.getBoundingClientRect()
  const painted = overlay.getBoundingClientRect()
  const overlapWidth =
    Math.min(painted.right, line.right) - Math.max(painted.left, line.left)
  const overlapHeight =
    Math.min(painted.bottom, line.bottom) - Math.max(painted.top, line.top)
  const inside =
    painted.top >= Math.max(0, bounds.top) &&
    painted.bottom <= Math.min(innerHeight, bounds.bottom) &&
    painted.left >= bounds.left &&
    painted.right <= bounds.right
  return overlapWidth > 0 && overlapHeight > 0 && inside
}

test.describe('Tasks 196/568/579 OS-level Find & Replace acceptance', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('VS Code Find/Replace keys, context and exact source survive Undo, save and reopen', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(420_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const file = path.join(baseDir, 'find-replace-synthetic.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    const save = () =>
      evaluateInVSCode(async (vscode) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      })
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
    })
    await evaluateInVSCode(
      async (vscode, [uri]: [string]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { timeout: 90_000, message: 'Task 196 fixture readiness' },
    )
    await expect
      .poll(async () => (await host()) === initial, { timeout: 60_000 })
      .toBe(true)
    // Vditor's rendered serialization differs from the file (root cause 5); Find must not use it.
    const rendered = await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue() as string)
    expect(rendered === initial).toBe(false)

    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await frame
      .locator('.vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.activateAndFocus()

    const editor = frame.locator('#app .vditor-ir .vditor-reset').first()
    // Observe host routing as well as visible effects: a hidden widget ignores actions itself,
    // so a no-op alone would miss a stale host context key still dispatching Alt+C.
    await frame.locator('body').evaluate(() => {
      ;(window as any).__findActions = []
      window.addEventListener('message', (event) => {
        if (event.data?.command === 'find-widget-action')
          (window as any).__findActions.push(event.data.action)
      })
    })
    const routedActions = () =>
      frame
        .locator('body')
        .evaluate(() => (window as any).__findActions as string[])
    const widget = frame.locator('.vmde-find-replace')
    const findInput = widget.locator('[data-find]')
    const replaceInput = widget.locator('[data-replace]')
    const replaceRow = widget.locator('#vmde-find-replace-row')
    const toggle = widget.getByRole('button', {
      name: 'Toggle Replace',
      exact: true,
    })
    const status = widget.locator('[data-status]')
    const caseButton = widget.locator('[data-action="case"]')
    const wordButton = widget.locator('[data-action="word"]')

    // --- Closed Ctrl+F seeds a literal caret word, selects Find, and hides Replace accessibly ---
    expect(initial.includes(PAIR_TOKEN)).toBe(true)
    const pairCount = wholeWordMatches(initial, PAIR_TOKEN, true).length
    expect(pairCount).toBe(2)
    await selectFixtureWord(frame, PAIR_TOKEN, true)
    await xtest.key('ctrl+f')
    await expect(widget).toBeVisible({ timeout: 10_000 })
    await expect(findInput).toHaveValue(PAIR_TOKEN)
    await expectSelected(findInput)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(replaceRow).toHaveCSS('display', 'none')
    await expect(
      widget.getByRole('textbox', { name: 'Replace', exact: true }),
    ).toHaveCount(0)
    await expect(widget.getByRole('button', { name: /^Replace/ })).toHaveCount(
      0,
    )

    // OS shortcuts must route through the host and preserve input focus.
    await xtest.key('alt+c')
    await expect(caseButton).toHaveAttribute('aria-checked', 'true')
    await expect.poll(routedActions).toContain('toggle-case')
    await expect(status).toHaveText(
      `1 of ${literalMatches(initial, PAIR_TOKEN, true).length}`,
    )
    await expect(findInput).toBeFocused()
    await xtest.key('alt+w')
    await expect(wordButton).toHaveAttribute('aria-checked', 'true')
    await expect(status).toHaveText(`1 of ${pairCount}`)
    await expect(findInput).toBeFocused()
    await xtest.key('F3')
    await expect(status).toHaveText(`2 of ${pairCount}`)
    await expect(findInput).toBeFocused()
    await xtest.key('shift+F3')
    await expect(status).toHaveText(`1 of ${pairCount}`)
    await expect(findInput).toBeFocused()
    // Find's local Enter must navigate without the global Undo boundary publishing getValue().
    await xtest.key('Return')
    await expect(status).toHaveText(`2 of ${pairCount}`)
    await expect(findInput).toBeFocused()
    await xtest.key('shift+Return')
    await expect(status).toHaveText(`1 of ${pairCount}`)
    await expect(findInput).toBeFocused()
    // Negative-observation window: outlast the boundary's task and 250 ms host edit-sync tick.
    await workbox.waitForTimeout(500)
    expect((await host()) === initial).toBe(true)

    // --- Mode switches keep query/options/current match; the chevron keeps focus ---
    await xtest.key('ctrl+h')
    await expect(replaceRow).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(replaceInput).toBeFocused()
    expect((await host()) === initial).toBe(true)
    await typeInput(replaceInput, xtest, 'ZZZZ')
    await xtest.key('ctrl+f')
    await expect(replaceRow).toBeVisible()
    await expectSelected(findInput)
    await expect(replaceInput).toHaveValue('ZZZZ')
    await xtest.key('ctrl+h')
    await expectSelected(replaceInput)
    await toggle.click()
    await expect(replaceRow).toBeHidden()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeFocused()
    await toggle.click()
    await expect(replaceRow).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeFocused()
    await expect(findInput).toHaveValue(PAIR_TOKEN)
    await expect(replaceInput).toHaveValue('ZZZZ')
    await expect(caseButton).toHaveAttribute('aria-checked', 'true')
    await expect(wordButton).toHaveAttribute('aria-checked', 'true')
    await expect(status).toHaveText(`1 of ${pairCount}`)
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    await expect(editor).toBeFocused()

    // --- Closed Ctrl+H focuses Find; Ctrl+Alt+Enter is one exact Replace All transaction ---
    await xtest.key('ctrl+h')
    await expect(replaceRow).toBeVisible()
    await expectSelected(findInput)
    await xtest.key('alt+w')
    await expect(wordButton).toHaveAttribute('aria-checked', 'false')
    await typeInput(findInput, xtest, CROSS_REGION_TOKEN)
    const crossMatches = literalMatches(initial, CROSS_REGION_TOKEN, true)
    await expect(status).toHaveText(`1 of ${crossMatches.length}`)
    await expect(frame.locator('.vmde-find-overlay--current')).toHaveCount(1)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(currentMatchOverlayInScroller, CROSS_REGION_TOKEN),
      )
      .toBe(true)
    // Overlays are rebuilt on every paint: read one and its style in the same evaluation.
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const overlay = document.querySelector('.vmde-find-overlay')
          return overlay ? getComputedStyle(overlay).pointerEvents : null
        }),
      )
      .toBe('none')
    await typeInput(replaceInput, xtest, 'ZZZZ')
    await xtest.key('ctrl+alt+Return')
    const afterAll = applyReplacements(initial, crossMatches, 'ZZZZ')
    await expect.poll(async () => (await host()) === afterAll).toBe(true)
    await expect(status).toHaveText('No results')
    await expect(replaceInput).toBeFocused()

    // --- One Undo restores the exact baseline, in host text and on disk ---
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    await expect(editor).toBeFocused()
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await save()
    await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)

    // --- A marker-safe single replace inside bold persists to disk; Undo restores exact bytes ---
    await frame
      .locator('.vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.key('ctrl+h')
    await expect(widget).toBeVisible()
    await expect(findInput).toBeFocused()
    await xtest.key('alt+w')
    await expect(wordButton).toHaveAttribute('aria-checked', 'true')
    await typeInput(findInput, xtest, BOLD_TOKEN)
    await expect(status).toHaveText('1 of 1')
    await typeInput(replaceInput, xtest, 'saved phrase')
    await xtest.key('ctrl+shift+1')
    await expect.poll(routedActions).toContain('replace-one')
    const afterOne = applyReplacements(
      initial,
      wholeWordMatches(initial, BOLD_TOKEN, true),
      'saved phrase',
    )
    await expect.poll(async () => (await host()) === afterOne).toBe(true)
    await expect(replaceInput).toBeFocused()
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    await expect(editor).toBeFocused()
    await xtest.key('ctrl+s')
    await expect
      .poll(() => readFileSync(file, 'utf8') === afterOne, { timeout: 15_000 })
      .toBe(true)
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await save()
    await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)

    // --- Enter in Replace is Replace One (not navigation); editor Escape and Shift+Escape ---
    await xtest.key('ctrl+h')
    await expect(findInput).toBeFocused()
    await typeInput(findInput, xtest, PAIR_TOKEN)
    await expect(status).toHaveText(`1 of ${pairCount}`)
    await typeInput(replaceInput, xtest, 'entered phrase')
    await xtest.key('Return')
    const afterEnter = applyReplacements(
      initial,
      wholeWordMatches(initial, PAIR_TOKEN, true).slice(0, 1),
      'entered phrase',
    )
    await expect.poll(async () => (await host()) === afterEnter).toBe(true)
    await expect(status).toHaveText(`1 of ${pairCount - 1}`)
    await expect(replaceInput).toBeFocused()
    await editor.click({ position: { x: 8, y: 8 } })
    await expect(editor).toBeFocused()
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    await expect(editor).toBeFocused()
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await xtest.key('ctrl+f')
    await expect(replaceRow).toBeHidden()
    await expectSelected(findInput)
    await xtest.key('shift+Escape')
    await expect(widget).toBeHidden()
    await expect(editor).toBeFocused()

    // --- Task 599: Ctrl+B right after Escape formats the restored match, with no reselection ---
    await xtest.key('ctrl+f')
    await expect(findInput).toBeFocused()
    await setToggle(caseButton, true)
    await setToggle(wordButton, false)
    await typeInput(findInput, xtest, UNIQUE_PROSE_TOKEN)
    await expect(status).toHaveText('1 of 1')
    await xtest.key('Return')
    await expect(findInput).toBeFocused()
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    expect(
      await frame
        .locator('body')
        .evaluate(editorSelectionState, UNIQUE_PROSE_TOKEN),
    ).toMatchObject({ focused: true, token: true, proseBlock: true })
    const boldExpected = editUniqueProse(
      await frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string),
      (token) => `**${token}**`,
    )
    await xtest.key('ctrl+b')
    await expect
      .poll(async () => (await host()) === boldExpected, {
        message: 'Ctrl+B right after Escape bolds the restored match',
      })
      .toBe(true)
    // Vditor's history stack transfer is locked for undoDelay (800 ms).
    await workbox.waitForTimeout(1200)
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await workbox.waitForTimeout(1200)

    // --- Closing clears the host gate, not just the visible widget ---
    const actionsBeforeCloseKeys = await routedActions()
    const closedCase = await caseButton.getAttribute('aria-checked')
    const closedStatus = await status.textContent()
    await xtest.key('alt+c')
    // Negative-observation window: allow a stale context key's host round trip to arrive.
    await workbox.waitForTimeout(400)
    expect(await routedActions()).toEqual(actionsBeforeCloseKeys)
    await expect(caseButton).toHaveAttribute('aria-checked', closedCase!)
    await expect(widget).toBeHidden()
    await expect(frame.locator('.vmde-find-overlay')).toHaveCount(0)
    expect((await host()) === initial).toBe(true)

    // Task 580 CP3-1: Bold and Italic keep their convention keys with Find closed.
    for (const [key, marker, name] of [
      ['ctrl+b', '**', 'bold'],
      ['ctrl+i', '*', 'italic'],
    ]) {
      await selectFixtureWord(frame, UNIQUE_PROSE_TOKEN)
      // Programmatic selection has no keyup/click. End it with an OS gesture so Vditor refreshes
      // toolbar availability before its command handler clicks the formatting button.
      await xtest.key('Shift_L')
      await expect(
        frame.locator(`.vditor-toolbar [data-type="${name}"]`),
      ).not.toHaveClass(/vditor-menu--disabled|vditor-menu--current/)
      await expect(editor).toBeFocused()
      expect(
        await editor.evaluate((root, token) => {
          const selection = window.getSelection()
          return (
            !!selection &&
            !selection.isCollapsed &&
            selection.toString() === token &&
            root.contains(selection.anchorNode) &&
            root.contains(selection.focusNode)
          )
        }, UNIQUE_PROSE_TOKEN),
      ).toBe(true)
      await xtest.key(key)
      await expect
        .poll(
          async () =>
            (await host()).includes(`${marker}${UNIQUE_PROSE_TOKEN}${marker}`),
          { message: `${key} still formats with Find closed` },
        )
        .toBe(true)
      await expect(widget).toBeHidden()
      await expect(status).toHaveText(closedStatus!)
      expect(await routedActions()).toEqual(actionsBeforeCloseKeys)
      // Vditor's history stack transfer is locked for undoDelay (800 ms).
      await workbox.waitForTimeout(1200)
      await xtest.key('ctrl+z')
      await expect.poll(async () => (await host()) === initial).toBe(true)
      await workbox.waitForTimeout(1200)
    }
    // Strikethrough (Ctrl+D) and Inline Code (Ctrl+G) ship unbound: neither key formats. Linux
    // Ctrl+G is VS Code's Go to Line, NOT Find Next (the macOS-only Cmd+G Find binding must not
    // leak), so it runs last and its quick input is closed afterwards.
    for (const key of ['ctrl+d', 'ctrl+g']) {
      await selectFixtureWord(frame, UNIQUE_PROSE_TOKEN)
      await xtest.key('Shift_L')
      await expect(editor).toBeFocused()
      await xtest.key(key)
      // Negative-observation window: longer than the 250 ms edit sync and a host round trip.
      await workbox.waitForTimeout(1200)
      expect((await host()) === initial, `${key} must not format`).toBe(true)
      await expect(widget).toBeHidden()
      await expect(status).toHaveText(closedStatus!)
      expect(await routedActions()).toEqual(actionsBeforeCloseKeys)
    }
    const quickInput = workbox.locator('.quick-input-widget')
    await expect(quickInput, 'Ctrl+G opens Go to Line').toBeVisible()
    await xtest.key('Escape')
    await expect(quickInput).toBeHidden()
    await save()
    await expect.poll(() => readFileSync(file, 'utf8') === initial).toBe(true)

    // --- Save/reopen gives the same exact bytes ---
    const reopened = await reopenVmdeFixture(
      evaluateInVSCode as never,
      workbox,
      file,
      90_000,
    )
    await waitForE2EReadiness(reopened, (state) => state.editorEpoch > 0, {
      timeout: 90_000,
      message: 'Task 196 reopened fixture readiness',
    })
    expect((await host()) === initial).toBe(true)
    expect(readFileSync(file, 'utf8') === initial).toBe(true)

    // Ctrl+Shift+F must leave VMDE's widget closed and focus VS Code's own Search view.
    await reopened
      .locator('#app .vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.key('ctrl+shift+f')
    const searchView = workbox.locator('.search-view')
    await expect(searchView).toBeVisible()
    await expect(
      searchView.locator('.search-widget textarea').first(),
    ).toBeFocused()
    await expect(reopened.locator('.vmde-find-replace')).toBeHidden()
    expect((await host()) === initial).toBe(true)
  })

  test('Task 599: every Find close route restores the selection that Ctrl+B and typing act on', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(600_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    // Match Case leaves one plain-prose match, in a list item far below the inline code.
    expect(literalMatches(initial, UNIQUE_PROSE_TOKEN, true)).toHaveLength(1)
    const file = path.join(baseDir, 'find-close-selection.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
    })
    await evaluateInVSCode(
      async (vscode, [uri]: [string]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      { timeout: 90_000, message: 'Task 599 fixture readiness' },
    )
    await expect
      .poll(async () => (await host()) === initial, { timeout: 60_000 })
      .toBe(true)
    await waitForInitialUndoSnapshot(frame)
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await frame
      .locator('.vditor-ir .vditor-reset')
      .first()
      .click({ position: { x: 8, y: 8 } })
    await xtest.activateAndFocus()

    const editor = frame.locator('#app .vditor-ir .vditor-reset').first()
    const widget = frame.locator('.vmde-find-replace')
    const findInput = widget.locator('[data-find]')
    const status = widget.locator('[data-status]')
    const toolbarItem = (name: string) =>
      frame.locator(`#app .vditor-toolbar [data-type="${name}"]`)
    const serialization = () =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue() as string)
    const selectionState = () =>
      frame.locator('body').evaluate(editorSelectionState, UNIQUE_PROSE_TOKEN)

    // Start each leg from the inline-code caret; a real no-op key settles Vditor's toolbar on that
    // context (Inline Code current), the stale state a close must not leave behind.
    const startInInlineCode = async () => {
      await caretInFirstInlineCode(frame)
      await xtest.key('Shift_L')
      await expect(editor).toBeFocused()
      await expect(toolbarItem('inline-code')).toHaveClass(
        /vditor-menu--current/,
      )
    }
    const search = async (open: 'ctrl+f' | 'ctrl+h') => {
      await xtest.key(open)
      await expect(widget).toBeVisible({ timeout: 10_000 })
      await expect(findInput).toBeFocused()
      await setToggle(widget.locator('[data-action="case"]'), true)
      await setToggle(widget.locator('[data-action="word"]'), false)
      await typeInput(findInput, xtest, UNIQUE_PROSE_TOKEN)
      await expect(status).toHaveText('1 of 1')
    }

    const priors = {
      Enter: { open: 'ctrl+f', key: 'Return' },
      F3: { open: 'ctrl+f', key: 'F3' },
      'Ctrl+H then Enter': { open: 'ctrl+h', key: 'Return' },
    } as const
    const routes: Record<string, () => Promise<void>> = {
      Escape: () => xtest.key('Escape'),
      'Shift+Escape': () => xtest.key('shift+Escape'),
      'close button': () => widget.locator('[data-action="close"]').click(),
    }
    const edits = {
      'Ctrl+B': {
        send: () => xtest.key('ctrl+b'),
        apply: (token: string) => `**${token}**`,
      },
      'typing Q': {
        send: () => xtest.type('Q', 20),
        apply: () => 'Q',
      },
    }
    for (const [priorName, prior] of Object.entries(priors))
      for (const [routeName, close] of Object.entries(routes))
        for (const [editName, edit] of Object.entries(edits)) {
          const leg = `${priorName} / ${routeName} / ${editName}`
          await startInInlineCode()
          await search(prior.open)
          await xtest.key(prior.key)
          await expect(status).toHaveText('1 of 1')
          await expect(findInput).toBeFocused()
          await expect(
            frame.locator('.vmde-find-overlay--current'),
          ).toHaveCount(1)
          await close()
          await expect(widget, leg).toBeHidden()
          expect(await selectionState(), leg).toMatchObject({
            focused: true,
            token: true,
            proseBlock: true,
          })
          await expect(toolbarItem('inline-code'), leg).not.toHaveClass(
            /vditor-menu--current/,
          )
          await expect(toolbarItem('bold'), leg).not.toHaveClass(
            /vditor-menu--disabled|vditor-menu--current/,
          )
          const hostBefore = await host()
          const expected = editUniqueProse(await serialization(), edit.apply)
          await edit.send()
          await expect
            .poll(async () => (await host()) === expected, { message: leg })
            .toBe(true)
          // Vditor's history stack transfer is locked for undoDelay (800 ms).
          await workbox.waitForTimeout(1200)
          await xtest.key('ctrl+z')
          await expect
            .poll(async () => (await host()) === hostBefore, {
              message: `${leg}: Undo`,
            })
            .toBe(true)
          await workbox.waitForTimeout(1200)
        }

    // The workbench command (Command Palette, executeCommand) closes through the same path. A
    // chord-less Bold command right after it acts on the restored match: no chord selection
    // snapshot from before the close may be restored over it.
    await startInInlineCode()
    await search('ctrl+f')
    await xtest.key('Return')
    await expect(findInput).toBeFocused()
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vmde.closeFindWidget')
    })
    await expect(widget).toBeHidden()
    expect(await selectionState()).toMatchObject({
      focused: true,
      token: true,
      proseBlock: true,
    })
    const commandBefore = await host()
    const commandExpected = editUniqueProse(
      await serialization(),
      (token) => `**${token}**`,
    )
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vmde.format.bold')
    })
    await expect
      .poll(async () => (await host()) === commandExpected, {
        message: 'vmde.closeFindWidget / vmde.format.bold',
      })
      .toBe(true)
    await workbox.waitForTimeout(1200)
    await xtest.key('ctrl+z')
    await expect.poll(async () => (await host()) === commandBefore).toBe(true)
    await workbox.waitForTimeout(1200)

    // Closing without navigating returns the caret from before Find opened; Ctrl+B there acts in
    // the inline code, where Bold is unavailable, so the host stays byte-identical.
    await startInInlineCode()
    await search('ctrl+f')
    await xtest.key('Escape')
    await expect(widget).toBeHidden()
    expect(await selectionState()).toMatchObject({
      focused: true,
      collapsed: true,
      inCode: true,
      offset: 3,
    })
    const unchanged = await host()
    await xtest.key('ctrl+b')
    // Negative-observation window: longer than the 250 ms edit sync and a host round trip.
    await workbox.waitForTimeout(1200)
    expect((await host()) === unchanged).toBe(true)
  })

  test('Task 568 highlighting acceptance: match-only geometry, live settings, light/dark readability', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const initial = readFileSync(FIXTURE, 'utf8')
    expect(createHash('sha256').update(initial).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const file = path.join(baseDir, 'find-replace-highlighting.md')
    writeFileSync(file, initial)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', 'Default Light Modern', true)
    })
    await evaluateInVSCode(
      async (vscode, [uri]: [string]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(uri),
          'vmde.editor',
        )
      },
      [file] as [string],
    )
    const frame = wf(workbox)
    try {
      await waitForE2EReadiness(
        frame,
        (state) =>
          state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
        { timeout: 90_000, message: 'Task 568 fixture readiness' },
      )
      await expect
        .poll(async () => (await host()) === initial, { timeout: 60_000 })
        .toBe(true)

      const xtest = await createXtestInput(electronApp, workbox)
      expect(xtest.client.visible).toBe(true)
      await frame
        .locator('.vditor-ir .vditor-reset')
        .first()
        .click({ position: { x: 8, y: 8 } })
      await xtest.activateAndFocus()
      await xtest.key('ctrl+f')
      const widget = frame.locator('.vmde-find-replace')
      await expect(widget).toBeVisible({ timeout: 10_000 })
      await typeInput(widget.locator('[data-find]'), xtest, CROSS_REGION_TOKEN)
      // Case/word toggles start off, so this is a plain case-insensitive substring count — the
      // same semantics the widget uses by default.
      const matches = literalMatches(initial, CROSS_REGION_TOKEN, false)
      expect(matches.length).toBeGreaterThan(1)
      await expect(widget.locator('[data-status]')).toHaveText(
        `1 of ${matches.length}`,
      )

      // Read geometry and computed paint from ONE evaluation per call so a read is never split
      // across a repaint frame. `elementFromPoint` sees the text under an overlay because the
      // overlay layer is `pointer-events: none` (main.css `.vmde-find-overlays`).
      const readOverlays = () =>
        frame.locator('body').evaluate(() => {
          const fallback = document.querySelector(
            '.vditor-ir .vditor-reset',
          ) as HTMLElement | null
          const overlays = Array.from(
            document.querySelectorAll<HTMLElement>('.vmde-find-overlay'),
          )
          return overlays.map((overlay) => {
            const rect = overlay.getBoundingClientRect()
            const cx = Math.min(
              window.innerWidth - 1,
              Math.max(0, rect.left + rect.width / 2),
            )
            const cy = Math.min(
              window.innerHeight - 1,
              Math.max(0, rect.top + rect.height / 2),
            )
            const style = getComputedStyle(overlay)
            const under = document.elementFromPoint(
              cx,
              cy,
            ) as HTMLElement | null
            const container = (under?.closest(
              'p, li, td, th, pre, blockquote, h1, h2, h3, h4, h5, h6, dd, dt',
            ) ??
              under?.closest('.vditor-reset') ??
              fallback) as HTMLElement | null
            const containerRect = container?.getBoundingClientRect() ?? null
            return {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              containerWidth: containerRect
                ? Math.round(containerRect.width)
                : null,
              isCurrent: overlay.classList.contains(
                'vmde-find-overlay--current',
              ),
              backgroundColor: style.backgroundColor,
              opacity: Number(style.opacity),
              pointerEvents: style.pointerEvents,
            }
          })
        })
      type Overlay = Awaited<ReturnType<typeof readOverlays>>[number]

      // (a) Match-only geometry: every fragment is narrower than the block it sits in (never a
      // containing-block highlight), and no two fragments stack on an identical rect.
      const assertMatchOnlyGeometry = (overlays: Overlay[]) => {
        expect(overlays.length).toBeGreaterThan(1)
        const seen = new Set<string>()
        for (const overlay of overlays) {
          expect(overlay.containerWidth).not.toBeNull()
          expect(overlay.width).toBeLessThan(overlay.containerWidth as number)
          expect(overlay.pointerEvents).toBe('none')
          const key = `${overlay.left}x${overlay.top}x${overlay.width}x${overlay.height}`
          expect(seen.has(key)).toBe(false)
          seen.add(key)
        }
      }

      let overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)
      // (c) Readability under the light theme with the shipped default opacities: a translucent
      // fill, never an opaque one that would hide the text underneath.
      for (const overlay of overlays) expect(overlay.opacity).toBeLessThan(1)

      await evaluateInVSCode(async (vscode) => {
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', 'Default Dark Modern', true)
      })
      await expect
        .poll(
          async () => {
            const list = await readOverlays()
            return (
              list.length > 1 &&
              list.every(
                (overlay) =>
                  overlay.opacity < 1 && overlay.pointerEvents === 'none',
              )
            )
          },
          { timeout: 20_000 },
        )
        .toBe(true)
      overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)

      // (b) Live settings: vmde.findMatch.* apply to the OPEN widget without reopening it
      // (boot/live-config.ts `applyBodyOptions` -> the `--vmde-find-*` CSS vars main.css reads).
      const ORDINARY_COLOR = 'rgb(10, 40, 90)'
      const CURRENT_COLOR = 'rgb(200, 60, 10)'
      await evaluateInVSCode(async (vscode) => {
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update('findMatch.color', 'rgb(10, 40, 90)', true)
        await config.update('findMatch.opacity', 0.55, true)
        await config.update('findMatch.currentColor', 'rgb(200, 60, 10)', true)
        await config.update('findMatch.currentOpacity', 0.65, true)
      })
      await expect
        .poll(
          async () => {
            const list = await readOverlays()
            const ordinary = list.find((overlay) => !overlay.isCurrent)
            const current = list.find((overlay) => overlay.isCurrent)
            return (
              ordinary?.backgroundColor === ORDINARY_COLOR &&
              Math.abs(ordinary.opacity - 0.55) < 0.01 &&
              current?.backgroundColor === CURRENT_COLOR &&
              Math.abs(current.opacity - 0.65) < 0.01
            )
          },
          { timeout: 20_000 },
        )
        .toBe(true)
      overlays = await readOverlays()
      assertMatchOnlyGeometry(overlays)
      for (const overlay of overlays) expect(overlay.opacity).toBeLessThan(1)

      // Task 579: change toolbar layout on the live instance while Find stays open. The setting
      // editor.toolbar reconstructs Vditor, so use the same display change as the CP2 regression
      // harness to isolate re-measurement of existing highlights in the actual VS Code webview.
      const toolbar = frame.locator('#app .vditor-toolbar')
      await expect(toolbar).toBeVisible()
      const pairCount = literalMatches(initial, PAIR_TOKEN, false).length
      expect(pairCount).toBe(2)
      await typeInput(widget.locator('[data-find]'), xtest, PAIR_TOKEN)
      await expect(widget.locator('[data-status]')).toHaveText(
        `1 of ${pairCount}`,
      )
      await expect(frame.locator('.vmde-find-overlay--current')).toHaveCount(1)
      const highlightDrift = () =>
        frame.locator('body').evaluate((_body, token) => {
          const editor = document.querySelector('#app .vditor-ir .vditor-reset')
          const overlay = document.querySelector('.vmde-find-overlay--current')
          if (!editor || !overlay) return Number.MAX_SAFE_INTEGER
          const matchingRect = () => {
            const walker = document.createTreeWalker(
              editor,
              NodeFilter.SHOW_TEXT,
            )
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const index = (node.nodeValue ?? '')
                .toLowerCase()
                .indexOf(token.toLowerCase())
              if (index < 0) continue
              const range = document.createRange()
              range.setStart(node, index)
              range.setEnd(node, index + token.length)
              return range.getClientRects()[0]
            }
            return null
          }
          const text = matchingRect()
          if (!text) return Number.MAX_SAFE_INTEGER
          const highlight = overlay.getBoundingClientRect()
          return Math.max(
            Math.abs(highlight.left - text.left),
            Math.abs(highlight.top - text.top),
            Math.abs(highlight.width - text.width),
            Math.abs(highlight.height - text.height),
          )
        }, PAIR_TOKEN)
      await expect.poll(highlightDrift).toBeLessThan(5)
      await toolbar.evaluate((element: HTMLElement) => {
        element.style.display = 'none'
      })
      try {
        await expect(toolbar).toBeHidden()
        await expect(widget).toBeVisible()
        await expect
          .poll(highlightDrift, {
            message: 'hidden-toolbar highlight stays on its literal text Range',
          })
          .toBeLessThan(5)
      } finally {
        await toolbar.evaluate((element: HTMLElement) => {
          element.style.removeProperty('display')
        })
      }
      await expect(toolbar).toBeVisible()
      await expect
        .poll(highlightDrift, {
          message: 'restored-toolbar highlight stays on its literal text Range',
        })
        .toBeLessThan(5)
      expect((await host()) === initial).toBe(true)
      await expect(widget.locator('[data-find]')).toBeFocused()
      await xtest.key('Escape')
      await expect(widget).toBeHidden()
    } finally {
      // Reset the live overrides so a later test in this session/file sees shipped defaults.
      await evaluateInVSCode(async (vscode) => {
        const global = vscode.ConfigurationTarget.Global
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update('findMatch.color', undefined, global)
        await config.update('findMatch.opacity', undefined, global)
        await config.update('findMatch.currentColor', undefined, global)
        await config.update('findMatch.currentOpacity', undefined, global)
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', undefined, global)
      })
    }
  })
})
