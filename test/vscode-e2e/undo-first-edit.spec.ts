/**
 * Task 598 — the first edit after opening a document can be undone, in the real VS Code webview
 * with OS-level XTEST input.
 *
 * Every mode starts with an empty undo history and only schedules its first snapshot (`undoDelay`
 * after a render, measured 640–1570 ms after the editor appears). Before Task 598 an edit made in
 * that window became part of the first snapshot, so Undo could never remove it. The patched
 * `vmdeSeedBaseline` now takes the snapshot at the user's first action, before it changes anything.
 *
 * Each leg opens a fresh document, so the active mode's history is naturally empty, and performs
 * its first action without waiting out the race. A read-only wrapper around the seed records the
 * stack it saw and the event that called it. A leg whose first seed did not find an empty stack, or
 * was not called by the measured action, fails as "race window missed": that is a missed setup
 * window, not behavior evidence either way. The wrappers count calls only; they never change timers,
 * history, source, selection or routing.
 *
 * Input mechanisms are named in every leg record: OS keys are XTEST (`helpers/xtest-input.ts`);
 * the clipboard Cut and the format/undo commands run through `vscode.commands.executeCommand` (the
 * same commands the webview context menu, the Edit menu and the Command Palette run); the toolbar
 * Undo is a Playwright mouse click; the drag/drop is an XTEST pointer drag. Setup (opening files,
 * placing the caret or a selection through VMDE's caret authority) never edits the source or the
 * history. Fixture text stays out of the output: host comparisons are booleans or lengths.
 *
 * The first XTEST Ctrl chord of a VS Code session sometimes never reached the webview in the Task
 * 598 investigation (6 of 8 probe sessions, cause not investigated), so every test first sends one
 * Ctrl+Z to an untouched, settled document. A measured key is never retried.
 *
 * The formatting leg waits for the Bold button to lose `vditor-menu--disabled` before the key
 * (Task 596's stale toolbar class, as shortcut-identity.spec.ts does). The drag/drop leg's drop is
 * cancelled by VS Code's webview host (see dragLeg). The cold-Mermaid leg is the detector of ruling
 * 598 Q3. It reproduces with the chosen design, so its exact failure is an expected failure owned by
 * Task 623 (tasks/623-cold-mermaid-undo-rerender.md); its record is that task's sanitized evidence.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { ProductDisplayName } from '../../src/shared/product-identity'
import { difference, firstLine, type Host } from './helpers/shortcut-xtest-kit'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import { waitForInitialUndoSnapshot } from './webview-helpers'

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<Page['frameLocator']>

const runFile = promisify(execFile)

// A small document that round-trips exactly through every mode's serializer.
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const ROOT: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  sv: '.vditor-sv',
}
// Negative-observation window for "a second Undo changes nothing" (Task 598 §2.3).
const INERT_MS = 1000

interface Session {
  xtest: XtestInput
  host: Host
  workbox: Page
  electronApp: ElectronApplication
  baseDir: string
  results: Record<string, unknown>[]
}

interface Doc {
  file: string
  frame: Frame
  mode: Mode
  initial: string
}

interface SeedRecord {
  at: number
  result: boolean
  undo: number
  redo: number
  adds: number
  mode: string
  event: string | null
  key: string | null
  trusted: boolean | null
  svg: boolean
}

interface Armed {
  ready: boolean
  seedMethod?: boolean
  readyMs?: number
  svgAtReady?: boolean
  atReady?: Record<string, string>
  beforeAction?: Record<string, string>
  placed?: boolean
  hasFocus?: boolean
  msToArmed?: number
}

interface Probe {
  seeds: SeedRecord[]
  adds: number
  undos: number
  redos: number
  events: { type: string; trusted: boolean; at: number }[]
  messages: string[]
}

// --- In-page readers (each runs inside the webview and must stay self-contained) ---

// Waits for the editor in `mode` to be ready, installs the read-only probe and places the caret or
// selection through the caret authority. Returns how long readiness took and the stacks it found.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page task must wait, instrument and place the selection without extra round trips inside the race window
async function armFirstAction(
  _body: Element,
  args: {
    mode: Mode
    needle: string
    offset: number
    length: number
    early: boolean
  },
): Promise<Armed> {
  const w = window as any
  const started = performance.now()
  const ready = () => {
    const inner = w.vditor?.vditor
    const ledger = w.__vmdeE2EReadiness
    // `early`: as soon as Vditor exists, before VMDE's finish-init (the cold-diagram window).
    return (
      !!inner?.undo &&
      inner.currentMode === args.mode &&
      typeof w.__vmdeRequestCaret === 'function' &&
      !!inner[args.mode]?.element?.textContent?.includes(args.needle) &&
      (args.early || (!!ledger?.routerReady && ledger.editorEpoch > 0))
    )
  }
  while (!ready()) {
    if (performance.now() - started > 60_000) return { ready: false }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const inner = w.vditor.vditor
  const undo = inner.undo
  const root = inner[inner.currentMode].element as HTMLElement
  const t0 = performance.now()
  const at = () => Math.round(performance.now() - t0)
  const stacks = () =>
    Object.fromEntries(
      ['ir', 'wysiwyg', 'sv'].map((m) => [
        m,
        `${undo[m].undoStack.length}/${undo[m].redoStack.length}`,
      ]),
    )
  const probe: Probe = {
    seeds: [],
    adds: 0,
    undos: 0,
    redos: 0,
    events: [],
    messages: [],
  }
  if (!w.__t598) {
    const seed = undo.vmdeSeedBaseline
    if (typeof seed !== 'function') return { ready: true, seedMethod: false }
    undo.vmdeSeedBaseline = function (vditor: any, event?: Event) {
      const state = this[vditor.currentMode]
      const before = {
        undo: state.undoStack.length as number,
        redo: state.redoStack.length as number,
      }
      const result = seed.call(this, vditor, event)
      w.__t598.seeds.push({
        at: at(),
        result,
        ...before,
        adds: w.__t598.adds,
        mode: vditor.currentMode,
        event: event?.type ?? null,
        key: (event as KeyboardEvent | undefined)?.key ?? null,
        trusted: event ? event.isTrusted : null,
        svg: !!vditor[vditor.currentMode].element.querySelector(
          '.language-mermaid svg',
        ),
      })
      return result
    }
    for (const name of ['addToUndoStack', 'undo', 'redo'] as const) {
      const original = undo[name]
      const counter = name === 'addToUndoStack' ? 'adds' : `${name}s`
      undo[name] = function (vditor: unknown) {
        w.__t598[counter]++
        return original.call(this, vditor)
      }
    }
    for (const type of ['keydown', 'paste', 'cut', 'dragstart', 'drop'])
      window.addEventListener(
        type,
        (event) => {
          if (w.__t598.events.length < 40)
            w.__t598.events.push({ type, trusted: event.isTrusted, at: at() })
        },
        true,
      )
    // Host→webview action messages, to show a command reached the editor once.
    window.addEventListener('message', (event) => {
      const data = event.data
      if (
        data &&
        typeof data.command === 'string' &&
        w.__t598.messages.length < 40
      )
        w.__t598.messages.push(
          `${data.command}:${data.name ?? data.action ?? data.mode ?? ''}`,
        )
    })
  }
  w.__t598 = probe
  const readyMs = Math.round(t0 - started)
  const svgAtReady = !!root.querySelector('.language-mermaid svg')
  const atReady = stacks()
  root.focus({ preventScroll: true })
  let placed = false
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node.nodeValue ?? '').indexOf(args.needle)
    const parent = node.parentElement
    if (
      index < 0 ||
      !parent?.getClientRects().length ||
      parent.closest('.vditor-ir__preview, .vditor-wysiwyg__preview')
    )
      continue
    const start = index + args.offset
    const end = start + args.length
    w.__vmdeRequestCaret(
      args.length
        ? { anchor: { node, offset: start }, focus: { node, offset: end } }
        : { node, offset: start },
    )
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const selection = getSelection()
    placed =
      !!selection?.rangeCount &&
      root.contains(selection.anchorNode) &&
      selection.toString().length === args.length
    break
  }
  return {
    ready: true,
    seedMethod: true,
    readyMs,
    svgAtReady,
    atReady,
    beforeAction: stacks(),
    placed,
    hasFocus: document.hasFocus(),
    msToArmed: at(),
  }
}

function readProbe(): Probe & { stacks: Record<string, string> } {
  const w = window as any
  const undo = w.vditor.vditor.undo
  return {
    ...w.__t598,
    stacks: Object.fromEntries(
      ['ir', 'wysiwyg', 'sv'].map((m) => [
        m,
        `${undo[m].undoStack.length}/${undo[m].redoStack.length}`,
      ]),
    ),
  }
}

function readHistory(): { undo: number; redo: number; undoButton: string } {
  const inner = (window as any).vditor.vditor
  const slot = inner.undo[inner.currentMode]
  const button = inner.toolbar?.elements?.undo?.children[0] as
    | HTMLElement
    | undefined
  return {
    undo: slot.undoStack.length,
    redo: slot.redoStack.length,
    undoButton: !button
      ? 'missing'
      : button.classList.contains('vditor-menu--disabled')
        ? 'disabled'
        : 'enabled',
  }
}

function readRendered(): string {
  return (window as any).vditor.getValue()
}

// The live caret: collapsed, in an editable block of the active root (not a preview, not the root
// itself), focused, painted, and whether the block text before it ends with `before`.
function readCaret(_body: Element, before: string | null) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const selection = getSelection()
  const node = selection?.focusNode ?? null
  const state = {
    collapsed: !!selection?.isCollapsed,
    editable: false,
    focused: document.hasFocus() && root.contains(document.activeElement),
    painted: false,
    before: before === null,
  }
  if (!selection?.rangeCount || !node || node === root || !root.contains(node))
    return state
  const element =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const block = element?.closest(
    '[data-block], p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th',
  )
  const preview = element?.closest(
    '.vditor-ir__preview, .vditor-wysiwyg__preview, [contenteditable="false"]',
  )
  state.editable =
    !!block &&
    block !== root &&
    root.contains(block) &&
    !(preview && root.contains(preview))
  if (block && before !== null) {
    const head = document.createRange()
    head.selectNodeContents(block)
    head.setEnd(node, selection.focusOffset)
    state.before = head.toString().endsWith(before)
  }
  const range = selection.getRangeAt(0)
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
  state.painted = rect.height > 0
  return state
}

// The diagram's rendered state plus sanitized structure for the detector record: whether its
// preview exists, Vditor's render flag, its geometry and whether it is in the window.
function readMermaid(_body: Element, scroll: boolean) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const preview = root
    .querySelector('.vditor-ir__preview .language-mermaid')
    ?.closest('.vditor-ir__preview') as HTMLElement | null
  if (scroll) preview?.scrollIntoView({ block: 'center' })
  const box = preview?.getBoundingClientRect()
  const structure = {
    preview: !!preview,
    dataRender: preview?.getAttribute('data-render') ?? null,
    previewChildren:
      preview?.querySelector('.language-mermaid')?.childElementCount ?? -1,
    previewHeight: Math.round(box?.height ?? 0),
    inView: !!box && box.bottom > 0 && box.top < window.innerHeight,
  }
  const svg = root.querySelector('.language-mermaid svg')
  if (!svg)
    return {
      svg: false,
      width: 0,
      height: 0,
      shapes: 0,
      error: false,
      ...structure,
    }
  const rect = svg.getBoundingClientRect()
  return {
    svg: true,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    shapes: svg.querySelectorAll('g.node, rect, path, polygon').length,
    error:
      /Syntax error|Parse error|Lexical error/i.test(svg.textContent ?? '') ||
      !!svg.querySelector('.error-icon'),
    ...structure,
  }
}

// Viewport rectangles (CSS pixels relative to the editor frame) of `length` characters starting
// `offset` characters into the first editable text node containing `needle`.
function readTextRect(
  _body: Element,
  args: { needle: string; offset: number; length: number },
) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node.nodeValue ?? '').indexOf(args.needle)
    if (index < 0 || node.parentElement?.closest('.vditor-ir__preview'))
      continue
    const range = document.createRange()
    range.setStart(node, index + args.offset)
    range.setEnd(node, index + args.offset + args.length)
    const rect = range.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }
  return null
}

const toolbarEnabled = (_body: Element, name: string) =>
  !(window as any).vditor.vditor.toolbar.elements[
    name
  ]?.children[0]?.classList.contains('vditor-menu--disabled')

// --- Test-side helpers ---

const body = (doc: Doc) => doc.frame.locator('body')
const probe = (doc: Doc) => body(doc).evaluate(readProbe)
const history = (doc: Doc) => body(doc).evaluate(readHistory)
const rendered = (doc: Doc) => body(doc).evaluate(readRendered)

const hostState = (s: Session, doc: Doc) =>
  s.host(
    (vscode, [fsPath]: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      return {
        text: document?.getText() ?? null,
        version: document?.version ?? -1,
        dirty: document?.isDirty ?? null,
      }
    },
    [doc.file],
  )

// The host text published for a serialization. SV publishes its DOM text without the newline span
// Vditor appends and the trailing zero-width placeholder (edit-sync.ts serializeSvForHost), both of
// which `getValue()` keeps.
const published = (mode: Mode, text: string) =>
  mode === 'sv' ? text.replace(/\u200B(?=\n*$)/gu, '').replace(/\n$/, '') : text

// Whether the webview's serialization is the host text. SV opened directly keeps one more trailing
// newline in `getValue()` than SV entered from IR (measured: `.\n\n` against `.\n` after the
// transform above) while the host stays exact, so SV compares without trailing newlines; the host
// assertions stay exact.
const agrees = (mode: Mode, text: string, host: string) =>
  mode === 'sv'
    ? published(mode, text).replace(/\n+$/, '') === host.replace(/\n+$/, '')
    : text === host

async function expectHost(
  s: Session,
  doc: Doc,
  expected: string,
  what: string,
) {
  let last: string | null = null
  try {
    await expect
      .poll(
        async () => {
          last = (await hostState(s, doc)).text
          return last === expected
        },
        { timeout: 15_000, message: what },
      )
      .toBe(true)
  } catch {
    throw new Error(
      `${doc.mode}: ${what}: ${JSON.stringify(difference(last, expected))}`,
    )
  }
}

const setDefaultMode = (s: Session, mode: Mode | undefined) =>
  s.host(
    async (vscode, [value]: [Mode | undefined]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', value, true)
    },
    [mode],
  )

// Reverts any dirty document (a failed leg may leave one), then closes every editor.
const closeAll = (s: Session) =>
  s.host(async (vscode) => {
    for (const document of vscode.workspace.textDocuments)
      if (document.isDirty && document.uri.scheme === 'file')
        await vscode.commands.executeCommand(
          'workbench.action.files.revert',
          document.uri,
        )
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [])

const runCommand = (s: Session, command: string) =>
  s.host(
    async (vscode, [id]: [string]) => {
      await vscode.commands.executeCommand(id)
    },
    [command],
  )

// Opens `content` as a fresh file in `mode` and waits until the paragraph is visible. Nothing here
// waits for Vditor's first snapshot: the caller acts inside the empty-history window.
async function openFresh(
  s: Session,
  name: string,
  content: string,
  mode: Mode,
  write = true,
): Promise<Doc> {
  await setDefaultMode(s, mode)
  const file = path.join(s.baseDir, `${name}.md`)
  if (write) writeFileSync(file, content)
  await closeAll(s)
  await s.host(
    async (vscode, [fsPath]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(fsPath),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = s.workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`)
  return { file, frame, mode, initial: content }
}

// Gives the webview keyboard focus and a user activation with a real click on the first paragraph,
// then arms the probe and places the caret (`length` 0) or a selection.
async function arm(
  doc: Doc,
  target: { needle: string; offset: number; length: number },
  click = true,
  early = false,
) {
  if (click)
    await doc.frame
      .locator(ROOT[doc.mode])
      .first()
      .getByText('Alpha bravo')
      .first()
      .click({ timeout: 90_000 })
  const armed = await body(doc).evaluate(armFirstAction, {
    mode: doc.mode,
    ...target,
    early,
  })
  expect(armed.ready, `${doc.mode}: editor ready`).toBe(true)
  expect(armed.seedMethod, 'the Task 598 seed method exists').toBe(true)
  expect(armed.placed, `${doc.mode}: setup selection placed`).toBe(true)
  return armed
}

// Proves the first action arrived inside the genuine empty-history window: the first seed call
// found both stacks empty, no snapshot had been taken before it, and it came from the measured
// action (`event`, and `key` for a keydown). Anything else is a missed window, not a result.
async function expectFirstSeed(
  doc: Doc,
  expected: { event: string | null; key?: string },
) {
  await expect
    .poll(async () => (await probe(doc)).seeds.length, {
      timeout: 5_000,
      message: `${doc.mode}: the first action reached the seed`,
    })
    .toBeGreaterThan(0)
  const { seeds, events } = await probe(doc)
  const first = seeds[0]
  const inWindow =
    first.result && first.undo === 0 && first.redo === 0 && first.adds === 0
  if (!inWindow)
    throw new Error(
      `race window missed: ${JSON.stringify({ first, events: events.slice(0, 8) })}`,
    )
  if (
    first.event !== expected.event ||
    (expected.key !== undefined && first.key !== expected.key)
  )
    throw new Error(
      `race window missed: the first seed was not the measured action ${JSON.stringify({ first, expected })}`,
    )
  return first
}

const USABLE_CARET = {
  collapsed: true,
  editable: true,
  focused: true,
  painted: true,
  before: true,
}

async function expectCaret(doc: Doc, before: string | null) {
  const seen = { caret: null as unknown }
  try {
    await expect
      .poll(
        async () => {
          seen.caret = await body(doc).evaluate(readCaret, before)
          return seen.caret
        },
        { timeout: 5_000 },
      )
      .toEqual(USABLE_CARET)
  } catch {
    throw new Error(
      `${doc.mode}: editable caret after Undo ${JSON.stringify(seen.caret)}`,
    )
  }
}

interface Journey {
  /** Host text after the first action (exact). */
  edited: string
  /** Host text after the final OS `Y`, or a check of it. */
  afterY: string | ((text: string) => boolean)
  /** Block text the restored caret follows, or null to skip the edge check. */
  caretBefore: string | null
  undoVia?: 'keyboard' | 'toolbar' | 'command'
  saveAndReopen?: boolean
}

async function undoOnce(s: Session, doc: Doc, via: Journey['undoVia']) {
  if (via === 'toolbar')
    await doc.frame
      .locator('.vditor-toolbar [data-type="undo"]')
      .first()
      .click()
  else if (via === 'command') await runCommand(s, 'vmde.format.undo')
  else await s.xtest.key('ctrl+z')
}

// After the first action: its checkpoint, exact Undo to the opened bytes with a clean host, an inert
// second Undo, Redo, Undo again, and one OS `Y` at the restored caret. Disk keeps the opened bytes
// until an explicit save.
async function historyJourney(s: Session, doc: Doc, journey: Journey) {
  const via = journey.undoVia ?? 'keyboard'
  await expectHost(s, doc, journey.edited, 'the first action reaches the host')
  // Poll the post-edit checkpoint; an Undo while it is pending belongs to Task 601.
  await expect
    .poll(
      async () => {
        const h = await history(doc)
        return `${h.undo}/${h.redo}`
      },
      { timeout: 5_000, message: `${doc.mode}: seed plus one edit entry` },
    )
    .toBe('2/0')
  const webview = await rendered(doc)
  if (!agrees(doc.mode, webview, journey.edited))
    throw new Error(
      `${doc.mode}: webview agrees with the host ${JSON.stringify({ ...difference(webview, journey.edited), tail: [...webview.slice(-3)].map((c) => c.charCodeAt(0)) })}`,
    )
  const undoButton = (await history(doc)).undoButton
  if (doc.mode !== 'sv')
    expect(undoButton, 'toolbar Undo enabled').toBe('enabled')
  const edited = await hostState(s, doc)
  expect(edited.dirty).toBe(true)
  const undosBefore = (await probe(doc)).undos

  await undoOnce(s, doc, via)
  await expectHost(s, doc, doc.initial, `${via} Undo restores the opened bytes`)
  const undone = await hostState(s, doc)
  expect(undone.version, `${via} Undo raises the host version once`).toBe(
    edited.version + 1,
  )
  expect(undone.dirty, `${via} Undo leaves the host clean`).toBe(false)
  const engineUndos = (await probe(doc)).undos - undosBefore
  expect(engineUndos, `${via} Undo reaches the engine once`).toBe(1)
  await expectCaret(doc, journey.caretBefore)

  const historyBefore = await history(doc)
  await undoOnce(s, doc, via)
  await s.workbox.waitForTimeout(INERT_MS) // negative-observation window
  const inert = await hostState(s, doc)
  const historyAfter = await history(doc)
  expect(
    {
      text: inert.text === doc.initial,
      version: inert.version,
      dirty: inert.dirty,
      undo: historyAfter.undo,
      redo: historyAfter.redo,
    },
    `second ${via} Undo is inert`,
  ).toEqual({
    text: true,
    version: undone.version,
    dirty: false,
    undo: historyBefore.undo,
    redo: historyBefore.redo,
  })

  await s.xtest.key('ctrl+y')
  await expectHost(s, doc, journey.edited, 'Redo restores the first action')
  await s.xtest.key('ctrl+z')
  await expectHost(s, doc, doc.initial, 'Undo after Redo')
  expect((await hostState(s, doc)).dirty, 'clean after Undo').toBe(false)

  await s.xtest.type('Y')
  const seen = { text: null as string | null }
  await expect
    .poll(
      async () => {
        const text = (await hostState(s, doc)).text
        seen.text = text
        return typeof journey.afterY === 'string'
          ? text === journey.afterY
          : text !== null && journey.afterY(text)
      },
      {
        timeout: 15_000,
        message: `${doc.mode}: Y lands at the restored caret`,
      },
    )
    .toBe(true)
  expect(readFileSync(doc.file, 'utf8') === doc.initial, 'disk unchanged').toBe(
    true,
  )
  const facts: Record<string, unknown> = {
    undoVia: via,
    undoButton,
    versionEdited: edited.version,
    versionUndone: undone.version,
    engineUndos,
  }
  if (!journey.saveAndReopen) return facts
  const final = seen.text as string
  await runCommand(s, 'workbench.action.files.save')
  await expect
    .poll(() => readFileSync(doc.file, 'utf8') === final, {
      message: 'save writes the final bytes',
    })
    .toBe(true)
  const reopened = await openFresh(
    s,
    path.basename(doc.file, '.md'),
    final,
    doc.mode,
    false,
  )
  await reopened.frame
    .locator(ROOT[doc.mode])
    .first()
    .waitFor({ timeout: 90_000 })
  await waitForInitialUndoSnapshot(reopened.frame)
  await s.workbox.waitForTimeout(INERT_MS) // negative-observation window: no post on reopen
  const state = await hostState(s, reopened)
  expect(
    {
      host: state.text === final,
      dirty: state.dirty,
      webview: agrees(doc.mode, await rendered(reopened), final),
    },
    'reopen keeps the saved bytes',
  ).toEqual({ host: true, dirty: false, webview: true })
  return { ...facts, savedAndReopened: true }
}

// Runs one leg, recording its observations or its failure, so one run returns the whole picture.
async function leg(
  s: Session,
  id: string,
  fn: () => Promise<Record<string, unknown>>,
) {
  const result: Record<string, unknown> = { id }
  try {
    Object.assign(result, await fn())
    result.ok = true
  } catch (error) {
    result.ok = false
    result.error = firstLine(error)
    result.missedWindow = /race window missed/.test(String(error))
  }
  s.results.push(result)
  console.log('[Task 598 first edit]', JSON.stringify(result))
}

// --- Legs ---

const CARET_AFTER_DELTA = { needle: 'delta.', offset: 6, length: 0 }

// Leg 1: OS typing as the first edit, the keyboard Undo journey, then save and reopen.
async function typingLeg(s: Session, mode: Mode) {
  const doc = await openFresh(s, `typing-${mode}`, DOC, mode)
  const armed = await arm(doc, CARET_AFTER_DELTA)
  await s.xtest.type('X')
  const seed = await expectFirstSeed(doc, { event: 'keydown', key: 'X' })
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('delta.', 'delta.X'),
    afterY: DOC.replace('delta.', 'delta.Y'),
    caretBefore: 'delta.',
    saveAndReopen: true,
  })
  return { mechanism: 'XTEST type', armed, seed, ...facts }
}

// Leg 2: formatting as the first edit, by OS Ctrl+B or by the `vmde.format.bold` command.
async function boldLeg(s: Session, route: 'keyboard' | 'command') {
  const doc = await openFresh(s, `bold-${route}`, DOC, 'ir')
  const armed = await arm(doc, { needle: 'bravo', offset: 0, length: 5 })
  // The command selection snapshot refreshes on keyup (format-hotkey-guard.ts), as after a user's
  // own selection; a bare Shift takes no seed.
  await s.xtest.key('Shift_L')
  // Task 596: Vditor sets the toolbar's disabled class in a 200 ms debounce after keyup; a Bold
  // routed before it clears acts on the previous context and does nothing. Wait for the state, as
  // shortcut-identity.spec.ts does.
  await expect
    .poll(() => body(doc).evaluate(toolbarEnabled, 'bold'), {
      timeout: 3_000,
      message: 'Bold enabled before the first action (Task 596)',
    })
    .toBe(true)
  if (route === 'keyboard') await s.xtest.key('ctrl+b')
  else await runCommand(s, 'vmde.format.bold')
  const seed = await expectFirstSeed(
    doc,
    route === 'keyboard' ? { event: 'keydown', key: 'b' } : { event: null },
  )
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('Alpha bravo', 'Alpha **bravo**'),
    afterY: DOC.replace('Alpha bravo', 'Alpha Ybravo'),
    caretBefore: 'Alpha ',
  })
  const actions = (await probe(doc)).messages.filter((m) =>
    m.startsWith('trigger-toolbar-hotkey:bold'),
  )
  expect(actions.length, 'one Bold action').toBe(1)
  return {
    mechanism:
      route === 'keyboard'
        ? 'XTEST Ctrl+B'
        : "executeCommand('vmde.format.bold')",
    armed,
    seed,
    ...facts,
  }
}

// Leg 3a: a native paste (OS Ctrl+V of VS Code's clipboard) as the first edit.
async function pasteLeg(s: Session) {
  await s.host(async (vscode) => {
    await vscode.env.clipboard.writeText('PASTED')
  }, [])
  const doc = await openFresh(s, 'paste-ir', DOC, 'ir')
  const armed = await arm(doc, CARET_AFTER_DELTA)
  await s.xtest.key('ctrl+v')
  // The Ctrl+V keydown reaches the webview before VS Code's paste does, so it takes the seed.
  const seed = await expectFirstSeed(doc, { event: 'keydown', key: 'v' })
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('delta.', 'delta.PASTED'),
    afterY: DOC.replace('delta.', 'delta.Y'),
    caretBefore: 'delta.',
  })
  const { events } = await probe(doc)
  return {
    mechanism: 'XTEST Ctrl+V (native paste)',
    pasteEvent: events.find((e) => e.type === 'paste') ?? null,
    armed,
    seed,
    ...facts,
  }
}

// Leg 3b: a non-keyboard cut (the clipboard Cut command, as the webview context menu runs it).
async function cutLeg(s: Session) {
  const doc = await openFresh(s, 'cut-ir', DOC, 'ir')
  const armed = await arm(doc, { needle: 'bravo ', offset: 0, length: 6 })
  await runCommand(s, 'editor.action.clipboardCutAction')
  const seed = await expectFirstSeed(doc, { event: 'cut' })
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('bravo ', ''),
    afterY: DOC.replace('Alpha bravo', 'Alpha Ybravo'),
    caretBefore: 'Alpha ',
  })
  return {
    mechanism: "executeCommand('editor.action.clipboardCutAction')",
    armed,
    seed,
    ...facts,
  }
}

// Leg 3c: an internal drag/drop of a selected word into the next paragraph by an XTEST pointer
// drag. The drop arrives trusted and takes the seed at capture, but the text does not move: VS
// Code's webview host frame cancels every drop (`handleInnerDropEvent` calls `preventDefault()` in
// its pre/index.html), and Vditor's internal-drop handler only schedules a render. Measured the same
// on the pre-598 build and with settled history, so it predates Task 598. The leg therefore proves
// that the drop seed itself publishes nothing and is a correct baseline: the next typed edit undoes
// back to the opened bytes. The drop edit itself is covered by the Chromium harness.
async function dragLeg(s: Session) {
  const doc = await openFresh(s, 'drag-ir', DOC, 'ir')
  const browserWindow = await s.electronApp.browserWindow(s.workbox)
  const bounds = await browserWindow.evaluate((w) => w.getContentBounds())
  const frameBox = await s.workbox
    .frameLocator('iframe.webview:visible')
    .locator(`iframe[title="${ProductDisplayName}"], #active-frame`)
    .boundingBox()
  expect(frameBox, 'editor frame box').not.toBeNull()
  const armed = await arm(doc, { needle: 'bravo', offset: 0, length: 5 })
  const [from, to] = await Promise.all([
    body(doc).evaluate(readTextRect, { needle: 'bravo', offset: 2, length: 1 }),
    body(doc).evaluate(readTextRect, { needle: 'golf', offset: 0, length: 1 }),
  ])
  expect(from && to, 'drag endpoints').toBeTruthy()
  const screen = (
    rect: { x: number; y: number; width: number; height: number },
    dx: number,
  ) => [
    String(Math.round(bounds.x + frameBox!.x + rect.x + dx)),
    String(Math.round(bounds.y + frameBox!.y + rect.y + rect.height / 2)),
  ]
  const [x0, y0] = screen(from!, from!.width / 2)
  const [x1, y1] = screen(to!, 0)
  await s.xtest.activateAndFocus()
  const xdotool = (args: string[]) =>
    runFile('/usr/bin/xdotool', args, { encoding: 'utf8', timeout: 5000 })
  await xdotool(['mousemove', '--sync', x0, y0])
  await xdotool(['mousedown', '1'])
  try {
    // Past Chromium's drag threshold first, then to the target.
    for (const step of [4, 12])
      await xdotool(['mousemove', '--sync', String(Number(x0) + step), y0])
    await xdotool(['mousemove', '--sync', x1, y1])
    await xdotool(['mousemove', '--sync', String(Number(x1) + 1), y1])
  } finally {
    await xdotool(['mouseup', '1'])
  }
  const seed = await expectFirstSeed(doc, { event: 'drop' })
  const { events } = await probe(doc)
  const dragEvents = events.filter(
    (e) => e.type === 'dragstart' || e.type === 'drop',
  )
  expect(
    dragEvents.map((e) => `${e.type}:${e.trusted}`),
    'a trusted drag and drop',
  ).toEqual(['dragstart:true', 'drop:true'])
  // Longer than undoDelay: the drop's own scheduled render and any late post have run.
  await s.workbox.waitForTimeout(1500) // negative-observation window
  const afterDrop = await hostState(s, doc)
  expect(
    {
      host: afterDrop.text === DOC,
      dirty: afterDrop.dirty,
      webview: (await rendered(doc)) === DOC,
      history: await history(doc),
    },
    'the cancelled drop and its seed change nothing',
  ).toEqual({
    host: true,
    dirty: false,
    webview: true,
    history: { undo: 1, redo: 0, undoButton: 'disabled' },
  })
  await arm(doc, CARET_AFTER_DELTA, false)
  await s.xtest.type('X')
  // The baseline is the drop seed; its caret marker is wherever the drag left the selection at the
  // drop, so the Y check only requires one Y in otherwise unchanged bytes.
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('delta.', 'delta.X'),
    afterY: (text) =>
      text.split('Y').length === 2 && text.replace('Y', '') === DOC,
    caretBefore: null,
  })
  return {
    mechanism: 'XTEST pointer drag (xdotool mousedown/mousemove/mouseup)',
    dropOutcome: 'cancelled by the VS Code webview host (pre-existing)',
    dragEvents,
    armed,
    seed,
    ...facts,
  }
}

// Leg 4: the toolbar Undo button and the `vmde.format.undo` command after a typed first edit (the
// keyboard route is leg 1's).
async function undoRouteLeg(s: Session, via: 'toolbar' | 'command') {
  const doc = await openFresh(s, `undo-${via}`, DOC, 'ir')
  const armed = await arm(doc, CARET_AFTER_DELTA)
  await s.xtest.type('X')
  const seed = await expectFirstSeed(doc, { event: 'keydown', key: 'X' })
  const facts = await historyJourney(s, doc, {
    edited: DOC.replace('delta.', 'delta.X'),
    afterY: DOC.replace('delta.', 'delta.Y'),
    caretBefore: 'delta.',
    undoVia: via,
  })
  return {
    mechanism: 'XTEST type',
    undoMechanism:
      via === 'toolbar'
        ? 'Playwright mouse click on the toolbar Undo'
        : "executeCommand('vmde.format.undo')",
    armed,
    seed,
    ...facts,
  }
}

// Leg 5: open in IR, settle its history, switch to a newly visited mode through the toolbar and
// type the first edit there inside that mode's own empty-history window.
async function modeSwitchLeg(s: Session, target: 'sv' | 'wysiwyg') {
  const doc = await openFresh(s, `switch-${target}`, DOC, 'ir')
  await doc.frame.locator(ROOT.ir).first().waitFor({ timeout: 90_000 })
  await waitForInitialUndoSnapshot(doc.frame)
  await doc.frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await doc.frame.locator(`button[data-mode="${target}"]`).click()
  const switched: Doc = { ...doc, mode: target }
  const armed = await arm(switched, CARET_AFTER_DELTA, false)
  // The view switch itself publishes nothing.
  const afterSwitch = await hostState(s, switched)
  await s.xtest.type('X')
  expect(
    { text: afterSwitch.text === DOC, dirty: afterSwitch.dirty },
    'the switch leaves the host unchanged',
  ).toEqual({ text: true, dirty: false })
  const seed = await expectFirstSeed(switched, { event: 'keydown', key: 'X' })
  const facts = await historyJourney(s, switched, {
    edited: DOC.replace('delta.', 'delta.X'),
    afterY: DOC.replace('delta.', 'delta.Y'),
    caretBefore: 'delta.',
  })
  const { stacks } = await probe(switched)
  // IR keeps its own settled history: the target's seed did not touch it.
  expect(stacks.ir, 'IR history untouched').toBe(armed.beforeAction?.ir)
  return { mechanism: 'XTEST type', armed, seed, stacksAfter: stacks, ...facts }
}

// A valid flowchart of 30 side-by-side pairs: two rows, so it stays short and in view once scaled
// to the editor width, and enough work that its first render is still in flight at the first key.
// A two-node diagram had already rendered when the editor accepted input (measured).
const MERMAID = (unique: string) =>
  `graph TD\n${Array.from({ length: 30 }, (_, i) => `  A${i}[Top ${i} ${unique}] --> B${i}[Bottom ${i}]\n`).join('')}`

// Leg 6: the cold-Mermaid detector. A unique diagram source cannot come from the render cache, so
// the seed is taken before the first render lands; Undo to that snapshot must leave the source, a
// usable caret and a real rendered diagram.
async function mermaidLeg(s: Session): Promise<Record<string, unknown>> {
  const unique = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const content = DOC.replace(
    'Echo',
    `\`\`\`mermaid\n${MERMAID(unique)}\`\`\`\n\nEcho`,
  )
  const doc = await openFresh(s, 'mermaid-cold', content, 'ir')
  // No click and no wait for VMDE's finish-init: the earliest moment the editor takes a key.
  const armed = await arm(doc, CARET_AFTER_DELTA, false, true)
  await s.xtest.type('X')
  const seed = await expectFirstSeed(doc, { event: 'keydown', key: 'X' })
  if (seed.svg)
    throw new Error(
      `race window missed: the diagram had rendered before the seed (not a cold window) ${JSON.stringify({ seed, armed })}`,
    )
  await expectHost(s, doc, content.replace('delta.', 'delta.X'), 'first edit')
  await expect
    .poll(
      async () => {
        const h = await history(doc)
        return `${h.undo}/${h.redo}`
      },
      { timeout: 5_000, message: 'seed plus one edit entry' },
    )
    .toBe('2/0')
  const renderedBeforeUndo = await body(doc).evaluate(readMermaid, false)
  await s.xtest.key('ctrl+z')
  await expectHost(s, doc, content, 'Undo restores the opened bytes')
  expect((await hostState(s, doc)).dirty, 'clean after Undo').toBe(false)
  await expectCaret(doc, 'delta.')
  type Diagram = Awaited<ReturnType<typeof readMermaid>>
  const drawn = (state: Diagram) =>
    state.svg &&
    state.width > 0 &&
    state.height > 0 &&
    state.shapes > 0 &&
    !state.error
  // First without scrolling (the diagram sits right below the edited paragraph), then with the
  // diagram scrolled into view, so a render deferred by the viewport gate still gets its chance.
  const watch = async (scroll: boolean, timeout: number) => {
    const seen = { state: null as Diagram | null }
    try {
      await expect
        .poll(
          async () => {
            seen.state = await body(doc).evaluate(readMermaid, scroll)
            return drawn(seen.state)
          },
          { timeout },
        )
        .toBe(true)
    } catch {
      // Not drawn within `timeout`: the last state is the evidence.
    }
    return seen.state
  }
  const diagramAfterUndo = await watch(false, 10_000)
  const diagramInView =
    diagramAfterUndo && drawn(diagramAfterUndo)
      ? null
      : await watch(true, 10_000)
  await s.xtest.type('Y')
  const expectedY = content.replace('delta.', 'delta.Y')
  await expect
    .poll(async () => (await hostState(s, doc)).text === expectedY, {
      timeout: 15_000,
    })
    .toBe(true)
    .catch(() => {
      // Recorded as `keyLands` below.
    })
  const keyLands = (await hostState(s, doc)).text === expectedY
  const detector = {
    seed,
    svgAtReady: armed.svgAtReady,
    renderedBeforeUndo,
    diagramAfterUndo,
    diagramInView,
    keyLands,
  }
  // Sanitized detector evidence for the follow-up of ruling 598 Q3. Task 623 owns the missing
  // re-render, so only its exact outcome is an expected failure: the cold seed, source, caret and
  // next key are correct, and no diagram appears, even after scrolling it into view. A missed
  // window or any other failure still fails the test. A drawn diagram also fails it, as
  // `test.fail` would, so the Task 623 fix is noticed and this marker is removed.
  const drawnAfterUndo = !!diagramAfterUndo && drawn(diagramAfterUndo)
  const drawnInView = !!diagramInView && drawn(diagramInView)
  if (keyLands && !drawnAfterUndo && !drawnInView)
    test.fail(
      true,
      'Task 623: Undo to a seed taken during the first Mermaid render never re-renders the diagram',
    )
  if (keyLands && drawnAfterUndo)
    throw new Error(
      `cold Mermaid detector passed: Task 623 looks fixed; remove its expected failure ${JSON.stringify({ mechanism: 'XTEST type', armed, ...detector })}`,
    )
  throw new Error(`cold Mermaid detector: ${JSON.stringify(detector)}`)
}

// --- Tests ---

async function warmUp(s: Session) {
  const doc = await openFresh(s, 'warm-up', DOC, 'ir')
  await doc.frame.locator(ROOT.ir).first().waitFor({ timeout: 90_000 })
  await waitForInitialUndoSnapshot(doc.frame)
  await doc.frame.locator(ROOT.ir).first().getByText('Alpha bravo').click()
  await s.xtest.key('ctrl+z')
  await s.workbox.waitForTimeout(INERT_MS) // negative-observation window
  const state = await hostState(s, doc)
  expect(
    { text: state.text === DOC, dirty: state.dirty },
    'warm-up Ctrl+Z on an untouched document changes nothing',
  ).toEqual({ text: true, dirty: false })
}

test.describe('Task 598 first edit after opening is undoable', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  const run = (
    name: string,
    legs: [string, (s: Session) => Promise<Record<string, unknown>>][],
    timeout: number,
  ) =>
    test(name, async ({ workbox, electronApp, evaluateInVSCode, baseDir }) => {
      test.setTimeout(timeout)
      await evaluateInVSCode(async (vscode) => {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      })
      const xtest = await createXtestInput(electronApp, workbox)
      expect(xtest.client.visible).toBe(true)
      const s: Session = {
        xtest,
        host: evaluateInVSCode as unknown as Host,
        workbox,
        electronApp,
        baseDir,
        results: [],
      }
      await warmUp(s)
      for (const [id, fn] of legs) await leg(s, id, () => fn(s))
      console.log(`[Task 598 ${name}]`, JSON.stringify(s.results))
      expect(s.results.filter((result) => result.ok !== true)).toEqual([])
    })

  run(
    'typing first in IR, WYSIWYG and SV: keyboard Undo, Redo, save and reopen',
    [
      ['typing:ir', (s) => typingLeg(s, 'ir')],
      ['typing:wysiwyg', (s) => typingLeg(s, 'wysiwyg')],
      ['typing:sv', (s) => typingLeg(s, 'sv')],
    ],
    420_000,
  )
  run(
    'formatting first: OS Ctrl+B and the Bold command',
    [
      ['bold:keyboard', (s) => boldLeg(s, 'keyboard')],
      ['bold:command', (s) => boldLeg(s, 'command')],
    ],
    300_000,
  )
  run(
    'paste, clipboard Cut and drag/drop first',
    [
      ['paste:ir', pasteLeg],
      ['cut:ir', cutLeg],
      ['drag-drop:ir', dragLeg],
    ],
    360_000,
  )
  run(
    'Undo from the toolbar and the vmde.format.undo command',
    [
      ['undo:toolbar', (s) => undoRouteLeg(s, 'toolbar')],
      ['undo:command', (s) => undoRouteLeg(s, 'command')],
    ],
    300_000,
  )
  run(
    'mode switch first edits: IR to SV and IR to WYSIWYG',
    [
      ['switch:sv', (s) => modeSwitchLeg(s, 'sv')],
      ['switch:wysiwyg', (s) => modeSwitchLeg(s, 'wysiwyg')],
    ],
    300_000,
  )
  run('cold Mermaid detector', [['mermaid:cold', mermaidLeg]], 240_000)
})
