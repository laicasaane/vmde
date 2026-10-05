/**
 * Task 580 Checkpoint 4 — the shared kit of the OS-level XTEST shortcut specs:
 * shortcut-identity.spec.ts (CP4-1) and shortcut-remap.spec.ts (CP4-2).
 *
 * It verifies and focuses the VS Code window (see docs/os-keyboard-testing-setup.md), opens a
 * fixture in a mode, places selections through VMDE's caret authority, records the host→webview
 * action messages, and runs each check as a leg that records its observations and failure instead
 * of stopping the test. Document comparisons are booleans so fixture text stays out of failure
 * output.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from 'vscode-test-playwright'
import { ProductDisplayName } from '../../../src/shared/product-identity'
import { FIXTURE as LARGE } from '../find-replace-fixture-helpers'
import { waitForE2EReadiness } from '../webview-helpers'
import { createXtestInput, type XtestInput } from './xtest-input'

export type Mode = 'ir' | 'wysiwyg' | 'sv'
export const MODES: Mode[] = ['ir', 'wysiwyg', 'sv']

export const SMALL = readFileSync(
  path.join(__dirname, '..', 'fixtures', 'shortcut-identity-exact.md'),
  'utf8',
)

// Vditor moves an edit into its undo stack `undoDelay` (800 ms) after it; an Undo before that
// would undo the previous step.
export const UNDO_LOCK_MS = 1200
// Negative-observation window: longer than the 250 ms edit sync, a host round trip and WYSIWYG's
// debounced post.
export const QUIET_MS = 1200
// WYSIWYG/SV caret.ts re-asserts the mode-entry caret for about 5 s.
export const MODE_SETTLE_MS = 6500
// After a save: the WYSIWYG debounced post and Task 434's deferred no-op check (1200 ms) have run.
export const AFTER_SAVE_MS = 2500

// Host→webview messages that start a VMDE action. A former key must never deliver one.
export const ACTION_COMMANDS = new Set([
  'trigger-toolbar-hotkey',
  'editor-action',
  'open-find-replace',
  'find-widget-action',
  'toggle-section-fold',
  'shift-heading-level',
  'rewrap-selection',
  'prepare-rewrap-document',
  'activate-link-at-caret',
  'format-table',
  'request-block-transform-options',
  'fix-list-numbering',
  'renormalize-all-lists',
  'paste-plain',
])

export type Host = <R, A>(
  fn: (vscode: typeof import('vscode'), args: A) => R | Promise<R>,
  args: A,
) => Promise<R>

export interface Kit {
  host: Host
  workbox: Page
  electronApp: ElectronApplication
  xtest: XtestInput
  baseDir: string
  frame: () => ReturnType<Page['frameLocator']>
  /** The console log tag of this spec's legs. */
  label: string
}

export interface Ctx {
  kit: Kit
  mode: Mode
  file: string
  initial: string
  /** The large fixture, with its pre-existing exactness limits (see `exactHost`). */
  large: boolean
  results: Record<string, unknown>[]
}

export interface SpyMessage {
  command: string
  detail: string | null
}

export interface HostState {
  text: string | null
  dirty: boolean | null
  willSaves: string[]
  didSaves: string[]
}

// The assertion text without terminal colors, enough lines to name the failed expectation.
export const firstLine = (error: unknown) =>
  String((error as Error)?.message ?? error)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color escapes
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, 4)
    .join(' | ')
    .slice(0, 1500)

// Where two texts first differ, without printing either text.
export function difference(actual: string | null, expected: string) {
  if (actual === null) return { actual: null }
  let index = 0
  while (
    index < actual.length &&
    index < expected.length &&
    actual[index] === expected[index]
  )
    index++
  return {
    actualLength: actual.length,
    expectedLength: expected.length,
    firstDifference: index,
  }
}

// ---------------------------------------------------------------------------------------------
// Webview-side probes (run inside the VMDE frame).

export function installSpyInPage() {
  const page = window as any
  if (page.__cp41) return
  page.__cp41 = { messages: [], composition: [] }
  window.addEventListener('message', (event) => {
    const data = event.data
    if (data && typeof data.command === 'string')
      page.__cp41.messages.push({
        command: data.command,
        detail:
          data.name ??
          data.action ??
          data.mode ??
          (data.command === 'block-action-outcome'
            ? JSON.stringify(data).slice(0, 200)
            : null),
      })
  })
  for (const type of [
    'compositionstart',
    'compositionupdate',
    'compositionend',
  ])
    document.addEventListener(
      type,
      (event) =>
        page.__cp41.composition.push({
          type,
          data: (event as CompositionEvent).data,
        }),
      true,
    )
}

// A selection on `token` (or a collapsed caret `offset` units into it) in the active editing
// surface, registered with VMDE's caret authority so a pending caret intent cannot move it.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one live-browser task finds the token, places and registers the Range and proves it survived two frames
export async function selectInPage(
  _body: Element,
  args: { token: string; collapsed: boolean; offset: number },
): Promise<boolean> {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  root.normalize()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node.nodeValue ?? '').indexOf(args.token)
    const parent = node.parentElement
    if (
      index < 0 ||
      !parent ||
      parent.closest('.vditor-ir__preview, .vditor-wysiwyg__preview') ||
      !parent.getClientRects().length
    )
      continue
    parent.scrollIntoView({ block: 'center' })
    root.focus({ preventScroll: true })
    const start = index + (args.collapsed ? args.offset : 0)
    const end = args.collapsed ? start : index + args.token.length
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const requestCaret = (window as any).__vmdeRequestCaret
    if (typeof requestCaret === 'function')
      requestCaret(
        args.collapsed
          ? { node, offset: start }
          : { anchor: { node, offset: start }, focus: { node, offset: end } },
      )
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const settled = getSelection()
    return Boolean(
      settled?.rangeCount &&
        root.contains(settled.anchorNode) &&
        (args.collapsed
          ? settled.isCollapsed
          : settled.toString() === args.token),
    )
  }
  return false
}

export function selectionInPage() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const text = range?.toString() ?? ''
  let whole = false
  let surfaceLength = -1
  if (
    range &&
    (root.contains(range.startContainer) || range.startContainer === root)
  ) {
    const all = document.createRange()
    all.selectNodeContents(root)
    whole =
      (range.startContainer === root &&
        range.startOffset === 0 &&
        range.endContainer === root &&
        range.endOffset === root.childNodes.length) ||
      (text.length > 0 &&
        text.replace(/\s+$/, '') === all.toString().replace(/\s+$/, ''))
    surfaceLength = all.toString().length
  }
  return {
    collapsed: selection?.isCollapsed ?? true,
    inSurface:
      !!range &&
      (root.contains(range.startContainer) || range.startContainer === root),
    length: text.length,
    // Short excerpts only: the whole-document selection is 170 K characters.
    head: text.slice(0, 60),
    surfaceLength,
    whole,
    focused: document.hasFocus() && root.contains(document.activeElement),
  }
}

// The live Range's endpoints and the text nodes of the inline node holding its start: evidence for
// a scope ladder that does not advance.
export function rangeDetailInPage() {
  const selection = getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!range) return null
  const describe = (node: Node, offset: number) => ({
    node: node.nodeName,
    length:
      node.nodeType === Node.TEXT_NODE
        ? (node as Text).data.length
        : node.childNodes.length,
    offset,
  })
  const element =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
  const inline = element?.closest('.vditor-ir__node:not([data-block])')
  const texts: number[] = []
  if (inline) {
    const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      texts.push((node as Text).data.length)
  }
  return {
    start: describe(range.startContainer, range.startOffset),
    end: describe(range.endContainer, range.endOffset),
    inlineTextNodeLengths: texts,
  }
}

// Native contenteditable formatting leaves elements that Vditor's Markdown rendering never makes.
export function nativeFormattingInPage(): number {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  return root.querySelectorAll(
    'b, i, u, font, span[style*="font-weight"], span[style*="font-style"], span[style*="text-decoration"]',
  ).length
}

export function foldInPage() {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  return {
    folded: Array.from(
      root.querySelectorAll<HTMLElement>('[data-vmde-folded]'),
    ).map((heading) => (heading.textContent ?? '').trim().slice(0, 40)),
    lists: root.querySelectorAll('[data-vmde-list-folded]').length,
  }
}

export function webviewStateInPage() {
  const inner = (window as any).vditor.vditor
  const popoverControl = document.querySelector(
    '.vditor-panel .vmde-callout__type',
  )
  const find = document.querySelector<HTMLElement>('.vmde-find-replace')
  return {
    mode: inner.currentMode as string,
    findVisible:
      !!find && !find.hidden && getComputedStyle(find).display !== 'none',
    calloutControlFocused:
      !!popoverControl && document.activeElement === popoverControl,
  }
}

// ---------------------------------------------------------------------------------------------
// Kit: host, frame and XTEST helpers.

export async function makeKit(
  workbox: unknown,
  electronApp: ElectronApplication,
  evaluateInVSCode: unknown,
  baseDir: string,
  label = 'cp4-1',
): Promise<Kit> {
  const page = workbox as Page
  const xtest = await createXtestInput(electronApp, page)
  expect(xtest.client.visible).toBe(true)
  const kit: Kit = {
    host: evaluateInVSCode as Host,
    workbox: page,
    electronApp,
    xtest,
    baseDir,
    label,
    frame: () =>
      page
        .frameLocator('iframe.webview:visible')
        .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`),
  }
  await kit.host(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  }, [])
  console.log(`[${label} xtest]`, JSON.stringify(xtest.client))
  return kit
}

export const evalFrame = <R, A>(
  kit: Kit,
  fn: (body: Element, arg: A) => R,
  arg: A,
) =>
  kit
    .frame()
    .locator('body')
    .evaluate(fn as never, arg) as Promise<Awaited<R>>

export const hostState = (ctx: Ctx): Promise<HostState> =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      const saves = (globalThis as any).__cp41Saves?.[fsPath]
      return {
        text: document?.getText() ?? null,
        dirty: document?.isDirty ?? null,
        willSaves: saves?.will ?? [],
        didSaves: saves?.did ?? [],
      }
    },
    [ctx.file],
  )

export const hostText = async (ctx: Ctx) => (await hostState(ctx)).text

export const tabLabels = (kit: Kit) =>
  kit.host(
    (vscode) =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => tab.label),
    [],
  )

// Will-save reasons and did-save texts for one file, on the host.
export const observeSaves = (ctx: Ctx) =>
  ctx.kit.host(
    (vscode, [fsPath]: [string]) => {
      const g = globalThis as any
      g.__cp41Saves ??= {}
      g.__cp41Subs ??= []
      const record = { will: [] as string[], did: [] as string[] }
      g.__cp41Saves[fsPath] = record
      g.__cp41Subs.push(
        vscode.workspace.onWillSaveTextDocument((event) => {
          if (event.document.uri.fsPath === fsPath)
            record.will.push(String(event.reason))
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
          if (document.uri.fsPath === fsPath)
            record.did.push(document.getText())
        }),
      )
    },
    [ctx.file],
  )

export const disposeObservers = (kit: Kit) =>
  kit.host(() => {
    const g = globalThis as any
    for (const sub of g.__cp41Subs ?? []) sub.dispose()
    g.__cp41Subs = []
  }, [])

export async function expectHost(
  ctx: Ctx,
  expected: string,
  label: string,
  timeout = 15_000,
) {
  let last: string | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await hostText(ctx)
          return last === expected
        },
        { timeout, message: label },
      )
      .toBe(true)
  } catch {
    // A small document is printed whole; the large fixture only as a difference position.
    const shown =
      expected.length < 2000 ? { actual: last } : difference(last, expected)
    throw new Error(`${label}: ${JSON.stringify(shown)}`)
  }
}

// Whether Undo, the will-save no-op check and inert commands keep the host's exact bytes in this
// context. On the large fixture, SV does not: after any SV edit or toolbar command the host holds
// the SV serializer's normalization of the whole file, and Undo keeps it (measured on the pre-580
// build 8c2ec1f0 too). There the content is checked word for word instead.
export const exactHost = (ctx: Ctx) => !(ctx.large && ctx.mode === 'sv')

// The text's words in order: equal for a source and its rendered normalization (spacing, table
// pipes, list markers, escapes), different for any content change. Inline tags are left out: the SV
// normalization drops the fixture's literal `<N>` type arguments (also on 8c2ec1f0).
export const words = (text: string | null) =>
  (text ?? '')
    .replace(/<[^<>\n]*>/g, ' ')
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(' ') ?? ''

// One native Undo (or an inert key) leaves the opened content: exact bytes where `exactHost` holds,
// the same words otherwise.
export async function expectRestored(
  ctx: Ctx,
  label: string,
  timeout = 15_000,
) {
  if (exactHost(ctx)) return expectHost(ctx, ctx.initial, label, timeout)
  const expected = words(ctx.initial)
  await expect
    .poll(async () => words(await hostText(ctx)) === expected, {
      timeout,
      message: `${label} (same words; SV normalization predates Task 580)`,
    })
    .toBe(true)
}

export async function expectHostIncludes(
  ctx: Ctx,
  needle: string,
  label: string,
) {
  await expect
    .poll(async () => ((await hostText(ctx)) ?? '').includes(needle), {
      timeout: 15_000,
      message: label,
    })
    .toBe(true)
}

export const spyMark = (kit: Kit) =>
  evalFrame(kit, () => ((window as any).__cp41.messages as unknown[]).length, 0)

export const spySince = (kit: Kit, mark: number) =>
  evalFrame(
    kit,
    (_body, from: number) =>
      ((window as any).__cp41.messages as SpyMessage[]).slice(from),
    mark,
  )

export const actionsSince = async (kit: Kit, mark: number) =>
  (await spySince(kit, mark)).filter((message) =>
    ACTION_COMMANDS.has(message.command),
  )

export async function select(
  ctx: Ctx,
  token: string,
  options: { collapsed?: boolean; offset?: number } = {},
) {
  const collapsed = options.collapsed ?? false
  const placed = await evalFrame(ctx.kit, selectInPage, {
    token,
    collapsed,
    offset: options.offset ?? token.length,
  })
  expect(placed, `${ctx.mode}: selection on ${token}`).toBe(true)
}

// Ends a programmatic selection with an OS gesture: Vditor refreshes its toolbar state and the
// command selection snapshot on keyup, as after a user's own selection.
export const endSelectionGesture = (ctx: Ctx) => ctx.kit.xtest.key('Shift_L')

export const selection = (ctx: Ctx) => evalFrame(ctx.kit, selectionInPage, 0)
export const nativeFormatting = (ctx: Ctx) =>
  evalFrame(ctx.kit, nativeFormattingInPage, 0)
export const folds = (ctx: Ctx) => evalFrame(ctx.kit, foldInPage, 0)
export const webviewState = (ctx: Ctx) =>
  evalFrame(ctx.kit, webviewStateInPage, 0)

export const quickInputVisible = (kit: Kit) =>
  kit.workbox.evaluate(() => {
    const widget = document.querySelector(
      '.quick-input-widget',
    ) as HTMLElement | null
    return (
      !!widget &&
      getComputedStyle(widget).display !== 'none' &&
      widget.getBoundingClientRect().height > 0
    )
  })

export const sidebarVisible = (kit: Kit) =>
  kit.workbox.evaluate(() => {
    const part = document.querySelector('.part.sidebar') as HTMLElement | null
    return (
      !!part &&
      getComputedStyle(part).display !== 'none' &&
      part.getBoundingClientRect().width > 0
    )
  })

export async function switchMode(ctx: Ctx, mode: Mode) {
  const frame = ctx.kit.frame()
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { timeout: 90_000, message: `${ctx.file} ${mode} readiness` },
  )
  await ctx.kit.workbox.waitForTimeout(MODE_SETTLE_MS)
}

// Opens `content` as a fresh file in IR, enters `mode` through the toolbar and installs the spy.
// Opens the context's file in IR, enters its mode through the toolbar and installs the spy.
export async function openEditor(ctx: Ctx) {
  const { kit } = ctx
  await kit.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(fsPath),
        'vmde.editor',
        { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      )
    },
    [ctx.file],
  )
  await waitForE2EReadiness(
    kit.frame(),
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: `${ctx.file} IR readiness` },
  )
  if (ctx.mode === 'ir') await kit.workbox.waitForTimeout(MODE_SETTLE_MS)
  else await switchMode(ctx, ctx.mode)
  await evalFrame(kit, installSpyInPage, 0)
}

// Writes `content` as a fresh file and opens it in `mode`.
export async function openDocument(
  kit: Kit,
  name: string,
  content: string,
  mode: Mode,
): Promise<Ctx> {
  const file = path.join(kit.baseDir, name)
  writeFileSync(file, content)
  const ctx: Ctx = {
    kit,
    mode,
    file,
    initial: content,
    large: content === LARGE,
    results: [],
  }
  await observeSaves(ctx)
  await openEditor(ctx)
  const opened = await hostState(ctx)
  ctx.results.push({
    id: `${mode}:open`,
    ok: opened.text === content && opened.dirty === false,
    hostExact: opened.text === content,
    dirty: opened.dirty,
    ...(opened.text === content ? {} : difference(opened.text, content)),
  })
  return ctx
}

// Closes VS Code's and VMDE's transient UI. If a failed leg left an edit, reopens the file fresh
// from its original bytes, so the next leg starts from the same state as the first one.
export async function recover(ctx: Ctx, always = false): Promise<string> {
  await ctx.kit.host(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    await vscode.commands.executeCommand('vmde.closeFindWidget')
  }, [])
  if (!always && (await hostText(ctx)) === ctx.initial) return 'clean'
  await closeAll(ctx.kit, ctx.file)
  writeFileSync(ctx.file, ctx.initial)
  await openEditor(ctx)
  return (await hostText(ctx)) === ctx.initial ? 'reopened' : 'still-changed'
}

export async function failureState(ctx: Ctx) {
  const state = await hostState(ctx)
  const messages = await spySince(ctx.kit, 0)
  return {
    host: difference(state.text, ctx.initial),
    dirty: state.dirty,
    selection: await selection(ctx),
    webview: await webviewState(ctx),
    toolbar: await evalFrame(
      ctx.kit,
      () =>
        ['bold', 'italic'].map(
          (name) =>
            `${name}:${document.querySelector(`.vditor-toolbar [data-type="${name}"]`)?.className ?? 'missing'}`,
        ),
      0,
    ),
    rendered:
      ctx.initial.length < 2000
        ? await evalFrame(
            ctx.kit,
            () => (window as any).vditor.getValue() as string,
            0,
          )
        : null,
    vditorRange: await evalFrame(
      ctx.kit,
      () => {
        const inner = (window as any).vditor.vditor
        const range = inner[inner.currentMode]?.range as Range | undefined
        return range
          ? `${range.startContainer.nodeName}:${range.startOffset}-${range.endContainer.nodeName}:${range.endOffset} "${range.toString().slice(0, 30)}"`
          : null
      },
      0,
    ),
    lastMessages: messages
      .slice(-8)
      .map((message) => `${message.command}:${message.detail}`),
  }
}

export async function leg(
  ctx: Ctx,
  name: string,
  body: () => Promise<Record<string, unknown> | undefined>,
) {
  const result: Record<string, unknown> = { id: `${ctx.mode}:${name}` }
  try {
    Object.assign(result, (await body()) ?? {})
    result.ok = true
    // A late post (WYSIWYG's debounce, SV processing) belongs to the leg that caused it.
    await ctx.kit.workbox.waitForTimeout(QUIET_MS)
    // Every leg starts from the opened bytes. Where exactness holds, a leg that leaves anything
    // else behind fails; SV on the large fixture keeps its normalization and is reopened. A leg
    // that may leave an edit or a late normalization is always reopened after.
    if (result.leavesEdit || result.mayNormalize)
      result.reopened = await recover(ctx, true)
    else if ((await hostText(ctx)) !== ctx.initial) {
      if (exactHost(ctx)) {
        result.ok = false
        result.error = 'the leg left the document changed'
      }
      result.reopened = await recover(ctx)
    }
  } catch (error) {
    result.ok = false
    result.error = firstLine(error)
    // State at the failure, before recovery changes it.
    result.atFailure = await failureState(ctx).catch((stateError) =>
      firstLine(stateError),
    )
    result.recovery = await recover(ctx).catch((recoveryError) =>
      firstLine(recoveryError),
    )
  }
  ctx.results.push(result)
  console.log(`[${ctx.kit.label}]`, JSON.stringify(result))
}

export function report(
  label: string,
  results: Record<string, unknown>[],
  tag = 'cp4-1',
) {
  console.log(`[${tag} ${label}] ${JSON.stringify(results)}`)
  const failed = results.filter((result) => result.ok !== true)
  expect(failed, `${label}: failed legs`).toEqual([])
}

// Never saves: revert and close the VMDE tab (a dirty failed leg would otherwise prompt), then the rest.
export const closeAll = (kit: Kit, file: string) =>
  kit.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
      const tabs = () =>
        vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      const vmde = tabs().find(
        (tab) =>
          tab.input instanceof vscode.TabInputCustom &&
          tab.input.uri.fsPath === fsPath,
      )
      if (vmde) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(fsPath),
          'vmde.editor',
          { viewColumn: vmde.group.viewColumn, preserveFocus: false },
        )
        await vscode.commands.executeCommand(
          'workbench.action.revertAndCloseActiveEditor',
        )
      }
      for (const document of vscode.workspace.textDocuments)
        if (document.isDirty && document.uri.scheme === 'file')
          await vscode.commands.executeCommand(
            'workbench.action.files.revert',
            document.uri,
          )
      const rest = tabs()
      if (rest.length) await vscode.window.tabGroups.close(rest)
    },
    [file],
  )

// Asserts one key, or a chord of space-separated keys, changes nothing in the VMDE document and
// delivers no VMDE action.
export async function expectInert(
  ctx: Ctx,
  key: string,
  options: { quickInput?: boolean; strictHost?: boolean } = {},
) {
  const kit = ctx.kit
  // Where `exactHost` does not hold (SV on the large fixture), SV may post its normalization of the
  // unchanged document after a key (also on 8c2ec1f0): the content is compared word for word and
  // the dirty flag and dirty tab title are not compared. `strictHost` keeps the exact checks.
  const relaxed = !exactHost(ctx) && !options.strictHost
  const unchanged = (text: string | null) =>
    relaxed ? words(text) === words(ctx.initial) : text === ctx.initial
  const tabs = async () =>
    (await tabLabels(kit)).map((label) =>
      relaxed ? label.replace(/^\[edit\]/, '') : label,
    )
  // The setup (caret placement) must not itself change anything during the window.
  await kit.workbox.waitForTimeout(QUIET_MS)
  const settled = await hostState(ctx)
  if (!unchanged(settled.text))
    throw new Error(
      `${key}: setup changed the document ${JSON.stringify(difference(settled.text, ctx.initial))}`,
    )
  const before = await webviewState(ctx)
  const dirtyBefore = settled.dirty
  const tabsBefore = await tabs()
  const foldsBefore = await folds(ctx)
  const mark = await spyMark(kit)
  for (const part of key.split(' ')) await kit.xtest.key(part)
  await kit.workbox.waitForTimeout(QUIET_MS) // negative-observation window
  const quickInput = await quickInputVisible(kit)
  if (quickInput) {
    await kit.xtest.key('Escape')
    await expect.poll(() => quickInputVisible(kit)).toBe(false)
  }
  const state = await hostState(ctx)
  const observed: Record<string, unknown> = {
    quickInput,
    documentUnchanged: unchanged(state.text),
    // An earlier edit and its Undo can leave VS Code's dirty flag set on identical text.
    dirtyUnchanged: relaxed || state.dirty === dirtyBefore,
    actions: await actionsSince(kit, mark),
    webview: await webviewState(ctx),
    folds: await folds(ctx),
    tabs: await tabs(),
    nativeFormatting: await nativeFormatting(ctx),
  }
  const expected: Record<string, unknown> = {
    quickInput: options.quickInput ?? false,
    documentUnchanged: true,
    dirtyUnchanged: true,
    actions: [],
    webview: before,
    folds: foldsBefore,
    tabs: tabsBefore,
    nativeFormatting: 0,
  }
  const differing = Object.keys(expected).filter(
    (name) => JSON.stringify(observed[name]) !== JSON.stringify(expected[name]),
  )
  if (differing.length)
    throw new Error(
      `${key} is not inert: ${JSON.stringify({
        differing: Object.fromEntries(
          differing.map((name) => [
            name,
            { observed: observed[name], expected: expected[name] },
          ]),
        ),
        host: difference(state.text, ctx.initial),
      })}`,
    )
}

// ---------------------------------------------------------------------------------------------
// User keybindings in the test profile (shared by every test of the run: always restored).

export async function userKeybindingsPath(kit: Kit): Promise<string> {
  const userData = await kit.electronApp.evaluate(({ app }) =>
    app.getPath('userData'),
  )
  return path.join(userData, 'User', 'keybindings.json')
}
