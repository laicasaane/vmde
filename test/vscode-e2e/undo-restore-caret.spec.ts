/**
 * Task 597 — Undo/Redo keep the caret in the editor when the restored snapshot has no usable caret
 * marker, in the real VS Code webview with OS-level XTEST keys.
 *
 * Vditor writes a `<wbr>` caret marker into an undo snapshot only when the live selection is inside
 * the editor. Find's Replace One records its snapshots while focus is in the Find input (no marker),
 * a checkpoint that fires while Find is open has none either, and a snapshot recorded right after an
 * innerHTML rebuild carries a marker at the editable root. Restoring any of them used to collapse the
 * selection outside the editable blocks: the next key was dropped and the toolbar kept stale state.
 * The patched `Undo.renderDiff` now hands such restores to `undo-restore-caret.ts`, which puts a
 * collapsed caret at the change start (Undo) or end (Redo).
 *
 * Each leg asserts the exact host text after the history step, a collapsed caret inside an editable
 * block at the expected boundary, the toolbar state (IR/WYSIWYG; SV has no toolbar highlighting),
 * and the first following OS key. After typing, the large fixture's host text is Vditor's normalized
 * serialization (accepted, Task 597 ruling 6), so the typed-key expectation is derived from
 * `getValue()` captured just before the key. `restores` counts the bridge's fallback restores, which
 * proves a leg exercised the unusable-marker path. Find legs use a copy of the large fixture; legs
 * that never open Find use a small inline document. Fixture text stays out of the output: document
 * comparisons are booleans and caret edges are compared inside the page.
 *
 * The Palette leg covers a Task 597 S4 design question: an undo checkpoint's caret request stays live
 * for up to 5 s, and an Undo with no webview key or pointer in between (the Command Palette route)
 * must not be pulled back to that older caret.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  FIXTURE as LARGE,
  FIXTURE_SHA256,
  UNIQUE_PROSE_TOKEN as TOKEN,
  literalMatches,
} from './find-replace-fixture-helpers'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type Host = (fn: unknown, args: string[]) => Promise<unknown>

const REPLACEMENT = 'ZZZZ'
// Match Case leaves one prose match (in an ordered list item far below the heading).
const AFTER_ONE = LARGE.replace(TOKEN, REPLACEMENT)
const SMALL =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const ROOT: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  sv: '.vditor-sv',
}
// The token's ordered list item, as Vditor's toolbar highlighting reports it.
const AT_TOKEN = { headings: 'plain', 'ordered-list': 'current' }

interface Session {
  xtest: XtestInput
  host: Host
  workbox: Page
  baseDir: string
  facts: Record<string, unknown>[]
}

interface Doc {
  file: string
  frame: Frame
  mode: Mode
}

// --- In-page readers (each runs inside the webview; they must stay self-contained) ---

function installRestoreProbe(): boolean {
  const w = window as any
  const bridge = w.__vmdeUndoRestoreCaret
  w.__t597 = { restores: 0, maxMs: 0 }
  if (!bridge) return false
  const restore = bridge.restore
  bridge.restore = (capture: unknown) => {
    const start = performance.now()
    try {
      return restore(capture)
    } finally {
      w.__t597.restores++
      w.__t597.maxMs = Math.max(w.__t597.maxMs, performance.now() - start)
    }
  }
  return true
}

function readProbe(): { restores: number; maxMs: number } {
  return (window as any).__t597
}

function readHistory(): { undo: number; redo: number; marker: boolean } {
  const inner = (window as any).vditor.vditor
  const slot = inner.undo[inner.currentMode]
  return {
    undo: slot.undoStack.length,
    redo: slot.redoStack.length,
    marker: slot.lastText.includes('<wbr>'),
  }
}

function readRendered(): string {
  return (window as any).vditor.getValue()
}

function readToolbar(_body: Element, names: string[]): Record<string, string> {
  const elements = (window as any).vditor.vditor.toolbar.elements
  return Object.fromEntries(
    names.map((name) => {
      const button = elements[name]?.children[0] as HTMLElement | undefined
      const state = !button
        ? 'missing'
        : button.classList.contains('vditor-menu--current')
          ? 'current'
          : button.classList.contains('vditor-menu--disabled')
            ? 'disabled'
            : 'plain'
      return [name, state]
    }),
  )
}

// The live caret: collapsed, inside an editable block (not a preview, not the root), whether the
// block text before/after it ends/starts with the expected edges, and whether its line box lies in
// the scroll viewport.
function readCaret(_body: Element, edges: { before: string; after: string }) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = window.getSelection()
  const node = selection?.focusNode ?? null
  const state = {
    collapsed: !!selection?.isCollapsed,
    inBlock: false,
    focused: document.activeElement === root,
    atBefore: false,
    atAfter: false,
    visible: false,
  }
  if (!selection?.rangeCount || !node || node === root || !root.contains(node))
    return state
  const host =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const block = host?.closest(
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, [data-block]',
  )
  const excluded = host?.closest(
    '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-render="1"], [data-render="2"], [contenteditable="false"]',
  )
  state.inBlock =
    !!block &&
    block !== root &&
    root.contains(block) &&
    !(excluded && excluded !== root && root.contains(excluded))
  if (!block) return state
  const head = document.createRange()
  head.selectNodeContents(block)
  head.setEnd(node, selection.focusOffset)
  const tail = document.createRange()
  tail.selectNodeContents(block)
  tail.setStart(node, selection.focusOffset)
  state.atBefore = head.toString().endsWith(edges.before)
  state.atAfter = tail.toString().startsWith(edges.after)
  const range = selection.getRangeAt(0)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  let scroller: HTMLElement | null = root
  while (
    scroller &&
    !(
      /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
      scroller.scrollHeight > scroller.clientHeight
    )
  )
    scroller = scroller.parentElement
  const view = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight }
  state.visible =
    rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom
  return state
}

// Scrolls the editor's scroller to the top or bottom (or only reads it) and returns its scrollTop.
function scrollEditor(_body: Element, where: 'top' | 'bottom' | null): number {
  const inner = (window as any).vditor.vditor
  let scroller: HTMLElement | null = inner[inner.currentMode].element
  while (
    scroller &&
    !(
      /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
      scroller.scrollHeight > scroller.clientHeight
    )
  )
    scroller = scroller.parentElement
  const target = scroller ?? (document.scrollingElement as HTMLElement)
  if (where) target.scrollTop = where === 'top' ? 0 : target.scrollHeight
  return target.scrollTop
}

// Test setup only (before any measured key): a collapsed caret `offset` characters into the first
// visible editable text node containing `needle`, armed through the caret authority so an older
// undo checkpoint cannot move it. The caller ends the setup with an OS Shift press.
async function placeCaret(
  _body: Element,
  args: { needle: string; offset: number },
): Promise<boolean> {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node as Text).data.indexOf(args.needle)
    const parent = node.parentElement
    if (
      index < 0 ||
      !parent?.getClientRects().length ||
      parent.closest('.vditor-ir__preview, .vditor-wysiwyg__preview')
    )
      continue
    parent.scrollIntoView({ block: 'center' })
    root.focus({ preventScroll: true })
    ;(window as any).__vmdeRequestCaret({ node, offset: index + args.offset })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const selection = window.getSelection()
    return (
      !!selection?.isCollapsed &&
      selection.focusNode === node &&
      selection.focusOffset === index + args.offset
    )
  }
  return false
}

// --- Test-side helpers ---

const history = (doc: Doc) => doc.frame.locator('body').evaluate(readHistory)
const rendered = (doc: Doc) => doc.frame.locator('body').evaluate(readRendered)
const probe = (doc: Doc) => doc.frame.locator('body').evaluate(readProbe)
const hostText = async (s: Session, doc: Doc) =>
  (await docText(s.host as never, doc.file)) as string

/** `text` with `insert` spliced `at` characters into its only occurrence of `needle`. */
function spliceAtUnique(
  text: string,
  needle: string,
  at: number,
  insert: string,
): string {
  const index = text.indexOf(needle)
  expect(
    index >= 0 && text.indexOf(needle, index + 1) < 0,
    `exactly one "${needle}" in the serialization`,
  ).toBe(true)
  return text.slice(0, index + at) + insert + text.slice(index + at)
}

async function openDoc(
  s: Session,
  name: string,
  content: string,
  mode: Mode,
): Promise<Doc> {
  await s.host(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', args[0], true)
    },
    [mode],
  )
  const file = path.join(s.baseDir, `${name}.md`)
  writeFileSync(file, content)
  const frame = await reopenVmdeFixture(
    s.host as never,
    s.workbox,
    file,
    90_000,
    mode === 'sv' ? '.vditor-sv' : `.vditor-${mode}`,
  )
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    { timeout: 90_000, message: `${name} readiness` },
  )
  const doc = { file, frame, mode }
  await expect
    .poll(async () => (await hostText(s, doc)) === content, { timeout: 60_000 })
    .toBe(true)
  await waitForInitialUndoSnapshot(frame)
  expect(await frame.locator('body').evaluate(installRestoreProbe)).toBe(true)
  // A real click gives the webview keyboard focus before any OS key.
  await frame
    .locator(ROOT[mode])
    .first()
    .click({ position: { x: 8, y: 8 } })
  await s.xtest.activateAndFocus()
  return doc
}

async function placeAt(s: Session, doc: Doc, needle: string, offset: number) {
  const placed = await doc.frame
    .locator(ROOT[doc.mode])
    .first()
    .evaluate(placeCaret, { needle, offset })
  expect(placed, `caret placed in ${doc.mode}`).toBe(true)
  await s.xtest.key('Shift_L')
}

async function typeInto(s: Session, input: Locator, value: string) {
  await input.focus()
  await expect(input).toBeFocused()
  await s.xtest.key('ctrl+a')
  await s.xtest.type(value, 20)
  await expect(input).toHaveValue(value)
}

const widgetOf = (doc: Doc) => doc.frame.locator('.vmde-find-replace')

// Opens Replace with Ctrl+H, fills the case-sensitive query and the replacement. Match Case is a
// VS Code-wide Find option that survives reopening, so it is toggled only when off.
async function openReplace(s: Session, doc: Doc) {
  const widget = widgetOf(doc)
  await s.xtest.key('ctrl+h')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await typeInto(s, widget.locator('[data-find]'), TOKEN)
  const matchCase = widget.locator('[data-action="case"]')
  if ((await matchCase.getAttribute('aria-checked')) !== 'true')
    await s.xtest.key('alt+c')
  await expect(matchCase).toHaveAttribute('aria-checked', 'true')
  await expect(widget.locator('[data-status]')).toHaveText('1 of 1')
  await typeInto(s, widget.locator('[data-replace]'), REPLACEMENT)
}

async function expectHost(s: Session, doc: Doc, text: string, what: string) {
  await expect
    .poll(async () => (await hostText(s, doc)) === text, {
      timeout: 15_000,
      message: `${doc.mode}: ${what}`,
    })
    .toBe(true)
}

// Replace One from the Replace input (Enter), then Escape.
async function replaceOneAndClose(s: Session, doc: Doc) {
  const before = (await history(doc)).undo
  await openReplace(s, doc)
  await s.xtest.key('Return')
  await expectHost(s, doc, AFTER_ONE, 'Replace One')
  await expect
    .poll(async () => (await history(doc)).undo)
    .toBeGreaterThan(before)
  await s.xtest.key('Escape')
  await expect(widgetOf(doc)).toBeHidden()
}

async function expectCaret(
  doc: Doc,
  edges: { before: string; after: string },
  what: string,
  visible = true,
) {
  await expect
    .poll(() => doc.frame.locator('body').evaluate(readCaret, edges), {
      timeout: 5_000,
      message: `${doc.mode}: ${what} caret`,
    })
    .toEqual({
      collapsed: true,
      inBlock: true,
      focused: true,
      atBefore: true,
      atAfter: true,
      visible,
    })
}

// Polls the toolbar through Vditor's ~200 ms highlight debounce; returns the observed delay.
async function expectToolbar(
  doc: Doc,
  expected: Record<string, string>,
  what: string,
): Promise<number | null> {
  if (doc.mode === 'sv') return null
  const start = Date.now()
  await expect
    .poll(
      () =>
        doc.frame.locator('body').evaluate(readToolbar, Object.keys(expected)),
      { timeout: 3_000, message: `${doc.mode}: ${what} toolbar` },
    )
    .toEqual(expected)
  return Date.now() - start
}

// The host text published for a serialization. SV publishes its DOM text without the newline span
// Vditor appends and the trailing zero-width placeholder (edit-sync.ts serializeSvForHost), both of
// which `getValue()` keeps.
const published = (doc: Doc, text: string) =>
  doc.mode === 'sv'
    ? text.replace(/\u200B(?=\n*$)/gu, '').replace(/\n$/, '')
    : text

// Types one OS key and checks it landed at `expected` (derived from the serialization captured
// just before it); the host must publish exactly that serialization.
async function typeAndExpect(
  s: Session,
  doc: Doc,
  key: string,
  expected: (before: string) => string,
  what: string,
) {
  const next = expected(await rendered(doc))
  await s.xtest.type(key)
  await expect
    .poll(async () => (await rendered(doc)) === next, {
      timeout: 10_000,
      message: `${doc.mode}: ${what}: ${key} lands at the restored caret`,
    })
    .toBe(true)
  await expectHost(
    s,
    doc,
    published(doc, next),
    `${what}: host publishes the typed key`,
  )
}

async function save(s: Session, doc: Doc) {
  const text = await hostText(s, doc)
  await s.host(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [])
  await expect.poll(() => readFileSync(doc.file, 'utf8') === text).toBe(true)
}

// Logs the leg's measured facts. A leg that needs the unusable-marker path also proves the bridge
// fallback ran (`restores`), so a reproduction that stopped exercising it cannot pass silently.
async function record(
  s: Session,
  doc: Doc,
  leg: string,
  extra: Record<string, unknown> = {},
  fallback = true,
) {
  const fact = { leg, mode: doc.mode, ...(await probe(doc)), ...extra }
  s.facts.push(fact)
  console.log('[Task 597 real-VS-Code leg]', JSON.stringify(fact))
  if (fallback)
    expect(fact.restores, `${leg}: fallback restores`).toBeGreaterThan(0)
}

// --- Legs ---

// Replace One, Escape, Undo: the caret lands before the restored token and the next key types there.
async function undoLeg(s: Session, mode: Mode) {
  const doc = await openDoc(s, `undo-${mode}`, LARGE, mode)
  await replaceOneAndClose(s, doc)
  await s.xtest.key('ctrl+z')
  await expectHost(s, doc, LARGE, 'Undo restores the exact fixture')
  await expectCaret(doc, { before: '', after: TOKEN }, 'Undo')
  const toolbarMs = await expectToolbar(doc, AT_TOKEN, 'Undo')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, TOKEN, 0, 'Q'),
    'Undo',
  )
  await record(s, doc, 'replace-undo', { toolbarMs })
  await save(s, doc)
}

// Replace One, Escape, Undo, Redo: the caret lands after the replacement.
async function redoLeg(s: Session, mode: Mode) {
  const doc = await openDoc(s, `redo-${mode}`, LARGE, mode)
  await replaceOneAndClose(s, doc)
  await s.xtest.key('ctrl+z')
  await expectHost(s, doc, LARGE, 'Undo restores the exact fixture')
  await s.xtest.key('ctrl+y')
  await expectHost(s, doc, AFTER_ONE, 'Redo restores the exact replacement')
  await expectCaret(doc, { before: REPLACEMENT, after: '' }, 'Redo')
  const toolbarMs = await expectToolbar(doc, AT_TOKEN, 'Redo')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, REPLACEMENT, REPLACEMENT.length, 'Q'),
    'Redo',
  )
  await record(s, doc, 'replace-redo', { toolbarMs })
  await save(s, doc)
}

// Type X, open Find before Vditor's 800 ms undoDelay so its checkpoint fires while the Find input
// has focus (a snapshot without a marker), close, type Y, move to the heading, Undo. Undo restores
// the marker-less X snapshot: the caret goes back to the change (where Y was), not the heading,
// the off-screen change is revealed, and the toolbar leaves the heading state.
async function findCheckpointLeg(s: Session) {
  const doc = await openDoc(s, 'find-checkpoint-ir', LARGE, 'ir')
  const widget = widgetOf(doc)
  await placeAt(s, doc, TOKEN, 0)
  const start = (await history(doc)).undo
  await s.xtest.type('X')
  await s.xtest.key('ctrl+f')
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(async () => (await history(doc)).undo, { timeout: 5_000 })
    .toBe(start + 1)
  await expect(widget.locator('[data-find]')).toBeFocused()
  expect((await history(doc)).marker, 'X snapshot has no caret marker').toBe(
    false,
  )
  await s.xtest.key('Escape')
  await expect(widget).toBeHidden()
  const withX = await rendered(doc)
  await s.xtest.type('Y')
  await expect
    .poll(async () => (await history(doc)).undo, { timeout: 5_000 })
    .toBe(start + 2)
  // Task 599 restores the opening caret on close, so Y follows X.
  expect(
    (await rendered(doc)) === spliceAtUnique(withX, `X${TOKEN}`, 1, 'Y'),
    'Y typed after X',
  ).toBe(true)
  await doc.frame.locator('body').evaluate(scrollEditor, 'top')
  await doc.frame.locator(`${ROOT.ir} h1`).first().click()
  await expectToolbar(doc, { headings: 'current' }, 'heading click')
  await s.xtest.key('ctrl+z')
  await expect.poll(async () => (await rendered(doc)) === withX).toBe(true)
  await expectHost(s, doc, withX, 'Undo publishes the X state')
  await expectCaret(
    doc,
    { before: 'X', after: TOKEN },
    'Undo after Find checkpoint',
  )
  const toolbarMs = await expectToolbar(doc, AT_TOKEN, 'Undo after heading')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, `X${TOKEN}`, 1, 'Q'),
    'Undo after Find checkpoint',
  )
  await record(s, doc, 'find-checkpoint-undo', { toolbarMs })
  await save(s, doc)
}

// Replace One by keybinding (Ctrl+Shift+1) while the editor has focus and Find stays open, then
// Undo and Redo. The Redo snapshot was recorded right after the rebuild with a root-level marker.
async function keybindingReplaceLeg(s: Session) {
  const doc = await openDoc(s, 'keybinding-replace-ir', LARGE, 'ir')
  await openReplace(s, doc)
  const heading = LARGE.split('\n')[0].slice(2, 8)
  await doc.frame.locator(`${ROOT.ir} h1`).first().click()
  await placeAt(s, doc, heading, 0)
  await expect(widgetOf(doc)).toBeVisible()
  await s.xtest.key('ctrl+shift+1')
  await expectHost(s, doc, AFTER_ONE, 'Ctrl+Shift+1 Replace One')
  await s.xtest.key('ctrl+z')
  await expectHost(s, doc, LARGE, 'Undo restores the exact fixture')
  const afterUndo = await doc.frame
    .locator('body')
    .evaluate(readCaret, { before: '', after: '' })
  expect({ ...afterUndo, visible: true }, 'Undo leaves a usable caret').toEqual(
    {
      collapsed: true,
      inBlock: true,
      focused: true,
      atBefore: true,
      atAfter: true,
      visible: true,
    },
  )
  const restoresAfterUndo = (await probe(doc)).restores
  await s.xtest.key('ctrl+y')
  await expectHost(s, doc, AFTER_ONE, 'Redo restores the exact replacement')
  await expectCaret(doc, { before: REPLACEMENT, after: '' }, 'Redo')
  await expectToolbar(doc, AT_TOKEN, 'Redo')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, REPLACEMENT, REPLACEMENT.length, 'Q'),
    'Ctrl+Shift+1 Redo',
  )
  await record(s, doc, 'keybinding-replace-undo-redo', {
    restoresAfterUndo,
    undoCaretVisible: afterUndo.visible,
  })
  // Close Find before the next leg reopens the document.
  await widgetOf(doc).locator('[data-find]').focus()
  await s.xtest.key('Escape')
  await expect(widgetOf(doc)).toBeHidden()
  await save(s, doc)
}

// Undo from the keyboard-focused toolbar (Escape arms, Tab enters the toolbar, arrows reach Undo,
// Enter activates it). Focus moves to the editor, as the marker path's restore does.
async function keyboardToolbarLeg(s: Session) {
  const doc = await openDoc(s, 'keyboard-toolbar-ir', LARGE, 'ir')
  await replaceOneAndClose(s, doc)
  await s.xtest.key('Escape')
  await s.xtest.key('Tab')
  const active = () =>
    doc.frame
      .locator('body')
      .evaluate(() => document.activeElement?.getAttribute('data-type') ?? null)
  await expect.poll(active).not.toBeNull()
  // Undo sits near the end of the row; Left wraps there from the first item. An item moved into
  // the overflow menu leaves the roving set, which this loop would report as not reachable.
  for (let step = 0; step < 60 && (await active()) !== 'undo'; step++)
    await s.xtest.key('Left')
  expect(await active(), 'Undo reachable in the toolbar row').toBe('undo')
  await s.xtest.key('Return')
  await expectHost(s, doc, LARGE, 'toolbar Undo restores the exact fixture')
  await expectCaret(doc, { before: '', after: TOKEN }, 'keyboard toolbar Undo')
  const toolbarMs = await expectToolbar(doc, AT_TOKEN, 'keyboard toolbar Undo')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, TOKEN, 0, 'Q'),
    'keyboard toolbar Undo',
  )
  await record(s, doc, 'keyboard-toolbar-undo', { toolbarMs })
  await save(s, doc)
}

// A mouse Undo on the toolbar with the change site above the viewport: the toolbar scroll guard
// must not pin the reveal back (Task 597 markIntentionalHistoryReveal).
async function mouseToolbarRevealLeg(s: Session) {
  const doc = await openDoc(s, 'mouse-toolbar-ir', LARGE, 'ir')
  await replaceOneAndClose(s, doc)
  const bottom = await doc.frame
    .locator('body')
    .evaluate(scrollEditor, 'bottom')
  const hidden = await doc.frame
    .locator('body')
    .evaluate(readCaret, { before: '', after: '' })
  expect(hidden.visible, 'change site starts above the viewport').toBe(false)
  const undo = doc.frame.locator('.vditor-toolbar [data-type="undo"]').first()
  await expect(undo).toBeInViewport()
  await undo.click()
  await expectHost(s, doc, LARGE, 'mouse Undo restores the exact fixture')
  // Negative-observation wait: the guard pins upward scroll jumps for 600 ms after a toolbar click.
  await s.workbox.waitForTimeout(900)
  await expectCaret(doc, { before: '', after: TOKEN }, 'mouse toolbar Undo')
  const after = await doc.frame.locator('body').evaluate(scrollEditor, null)
  expect(after).toBeLessThan(bottom)
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, TOKEN, 0, 'Q'),
    'mouse toolbar Undo',
  )
  await record(s, doc, 'mouse-toolbar-reveal', {
    scrolledFrom: bottom,
    scrolledTo: after,
  })
  await save(s, doc)
}

// An external WorkspaceEdit (host update), typing, then two Undos. The host update rebuilds the
// editor and records its base snapshot without a usable marker, so the Undo that returns to it
// takes the fallback; Task 597's measurement also saw an extra caret-only step there (Task 603
// owns that), in which case the second Undo restores it. Either way the caret stays usable where
// the typed character was removed.
async function externalUpdateLeg(s: Session) {
  const doc = await openDoc(s, 'external-update-ir', SMALL, 'ir')
  await s.host(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )!
      const start = document.getText().indexOf('charlie')
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(start),
          document.positionAt(start + 'charlie'.length),
        ),
        'CHARLIE',
      )
      await vscode.workspace.applyEdit(edit)
    },
    [doc.file],
  )
  await expectHost(s, doc, SMALL.replace('charlie', 'CHARLIE'), 'external edit')
  await expect
    .poll(async () => (await rendered(doc)).includes('CHARLIE'))
    .toBe(true)
  await waitForInitialUndoSnapshot(doc.frame)
  await doc.frame.locator(ROOT.ir).first().getByText('India juliet').click()
  await placeAt(s, doc, 'juliet', 6)
  const external = await rendered(doc)
  const start = await history(doc)
  await s.xtest.type('Y')
  await expect
    .poll(async () => (await history(doc)).undo, { timeout: 5_000 })
    .toBe(start.undo + 1)
  expect(await rendered(doc)).toBe(
    spliceAtUnique(external, 'juliet kilo', 6, 'Y'),
  )
  await s.xtest.key('ctrl+z')
  await expect.poll(async () => await rendered(doc)).toBe(external)
  const afterFirst = await history(doc)
  const restoresAfterFirst = (await probe(doc)).restores
  await s.xtest.key('ctrl+z')
  await expect
    .poll(async () => (await history(doc)).undo, { timeout: 5_000 })
    .toBe(Math.max(1, afterFirst.undo - 1))
  expect(await rendered(doc)).toBe(external)
  await expectHost(s, doc, external, 'two Undos keep the external edit')
  await expectCaret(doc, { before: 'juliet', after: ' kilo' }, 'second Undo')
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, 'juliet kilo', 6, 'Q'),
    'external update double Undo',
  )
  await record(s, doc, 'external-update-double-undo', {
    undoDepthBeforeY: start.undo,
    undoDepthAfterFirst: afterFirst.undo,
    restoresAfterFirst,
  })
  await save(s, doc)
}

// Type XY, open the Command Palette with native F1 before Vditor's 800 ms undoDelay so the
// checkpoint (and its caret request) fires while the Palette is open, then run "VMDE: Undo".
// Undo restores the earlier snapshot's usable marker; nothing in the webview saw a key or pointer
// since that checkpoint, so its still-live caret request must not pull the caret back after XY.
async function paletteUndoLeg(s: Session) {
  const doc = await openDoc(s, 'palette-undo-ir', SMALL, 'ir')
  await placeAt(s, doc, 'bravo', 1)
  const initial = await rendered(doc)
  const start = await history(doc)
  await s.xtest.type('XY')
  await s.xtest.key('F1')
  const input = s.workbox.locator('.quick-input-widget input').first()
  await expect(input).toBeFocused({ timeout: 10_000 })
  await expect
    .poll(async () => (await history(doc)).undo, { timeout: 5_000 })
    .toBe(start.undo + 1)
  const checkpointAt = Date.now()
  expect(await rendered(doc)).toBe(spliceAtUnique(initial, 'bravo', 1, 'XY'))
  await s.xtest.type('VMDE: Undo', 20)
  await expect(
    s.workbox.locator('.quick-input-list .monaco-list-row.focused').first(),
  ).toContainText('VMDE: Undo')
  await s.xtest.key('Return')
  await expect(input).toBeHidden()
  await expect.poll(async () => await rendered(doc)).toBe(initial)
  const undoAt = Date.now()
  await expectHost(s, doc, initial, 'Palette Undo')
  // Negative-observation wait: a stale caret request re-asserts on the next animation frames.
  await s.workbox.waitForTimeout(300)
  const caret = await doc.frame
    .locator('body')
    .evaluate(readCaret, { before: 'Alpha b', after: 'ravo' })
  // This Undo restores a usable marker (the upstream path), so no fallback restore is required.
  await record(
    s,
    doc,
    'palette-undo',
    { msFromCheckpointToUndo: undoAt - checkpointAt, caret },
    false,
  )
  await typeAndExpect(
    s,
    doc,
    'Q',
    (r) => spliceAtUnique(r, 'bravo', 1, 'Q'),
    'Palette Undo',
  )
  await save(s, doc)
}

// --- Tests ---

test.describe('Task 597 Undo/Redo restore without a usable caret marker', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  const run = (
    name: string,
    legs: ((s: Session) => Promise<void>)[],
    timeout: number,
  ) =>
    test(name, async ({ workbox, electronApp, evaluateInVSCode, baseDir }) => {
      test.setTimeout(timeout)
      expect(createHash('sha256').update(LARGE).digest('hex')).toBe(
        FIXTURE_SHA256,
      )
      // The prose token also appears in upper case; Match Case leaves exactly one match.
      expect(literalMatches(LARGE, TOKEN, false).length).toBe(2)
      expect(literalMatches(LARGE, TOKEN, true).length).toBe(1)
      expect(LARGE.includes(REPLACEMENT)).toBe(false)
      await evaluateInVSCode(async (vscode) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      })
      const xtest = await createXtestInput(electronApp, workbox)
      expect(xtest.client.visible).toBe(true)
      const s: Session = {
        xtest,
        host: evaluateInVSCode as unknown as Host,
        workbox,
        baseDir,
        facts: [],
      }
      try {
        for (const leg of legs) await leg(s)
      } finally {
        await evaluateInVSCode(async (vscode) => {
          await vscode.workspace
            .getConfiguration('vmde')
            .update('editor.defaultMode', undefined, true)
        })
      }
    })

  run(
    'IR: Replace One Undo/Redo, Find checkpoint, Ctrl+Shift+1, keyboard and mouse toolbar Undo',
    [
      (s) => undoLeg(s, 'ir'),
      (s) => redoLeg(s, 'ir'),
      findCheckpointLeg,
      keybindingReplaceLeg,
      keyboardToolbarLeg,
      mouseToolbarRevealLeg,
    ],
    600_000,
  )
  run(
    'WYSIWYG: Replace One Undo and Redo',
    [(s) => undoLeg(s, 'wysiwyg'), (s) => redoLeg(s, 'wysiwyg')],
    300_000,
  )
  run(
    'SV: Replace One Undo and Redo',
    [(s) => undoLeg(s, 'sv'), (s) => redoLeg(s, 'sv')],
    300_000,
  )
  run(
    'IR small document: external update double Undo and Command Palette Undo',
    [externalUpdateLeg, paletteUndoLeg],
    240_000,
  )
})
