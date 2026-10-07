/**
 * Task 596 S4 - real-VS-Code acceptance for the live-selection toolbar-hotkey gate.
 *
 * A formatting command clicks Vditor's toolbar button, and that click obeys the button's
 * `vditor-menu--disabled` / `vditor-menu--current` classes. Vditor rewrites them only 200 ms after
 * a click or keyup, never for a selection set by program, so a command pressed at once after the
 * selection moved acted on the PREVIOUS context: it corrupted inline code (``Echo `**foxtrot**` ``),
 * doubled bold (`****India****`), nested a quote (`>> oscar papa`) or removed bold in WYSIWYG, or did
 * nothing. The router now recomputes both classes from the live selection on the one button it
 * clicks (media-src/src/editing/format-hotkey-context.ts). Each row below is one of the measured
 * rows of tasks/596 ("Problem" table) or the same stale window for another toolbar name.
 *
 * Inputs. Ctrl+B, Ctrl+I, Ctrl+] and Ctrl+[ are OS-level XTEST keys into the verified, focused VS
 * Code window (docs/os-keyboard-testing-setup.md), so they go through VS Code's keybinding service
 * like a user's key. The other eight toolbar names ship unbound (and Linux Ctrl+G is Go to Line),
 * so they run through `executeCommand` of the contributed `vmde.format.*` command, which reaches
 * the same `trigger-toolbar-hotkey` route. Never rely on a default key for them.
 *
 * Each row runs on a fresh copy of the document:
 *   1. settle context A: place a caret, send an XTEST `Shift_L` and wait 450 ms, so Vditor's own
 *      highlight has set the toolbar classes for A (the "stale" state the next step leaves behind);
 *   2. move to context B WITHOUT a click or keyup, so no highlight runs for B: a programmatic
 *      selection (a synthetic `keydown` first, so caret.ts's ADR-0007 caret intent does not
 *      re-assert A's caret), or a real double-click, or real Ctrl+Left / Shift+Home keys;
 *   3. send the command at once and read the exact document text from the host.
 * The expected text is the "fresh" result: what Vditor does when its highlight HAS settled at B.
 *
 * Control mode (`VMDE_T596_CONTROL=1`): after step 2 send `Shift_L` and wait 450 ms, so Vditor's own
 * highlight runs at B before the command. Every row must still equal `expected`. Run on the
 * pre-Task-596 product it shows `expected` is Vditor's own fresh result, independent of the gate;
 * the default mode on that product shows which rows the gate fixes.
 *
 * Run (the Xvfb + Openbox shell of the runbook, then):
 *   node build.mjs
 *   VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- format-hotkey-live-gate.spec.ts --workers=1 --retries=0
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

const runFile = promisify(execFile)

const CONTROL = process.env.VMDE_T596_CONTROL === '1'
/** Vditor's highlight is debounced 200 ms; a settle must outlast it. */
const SETTLE_MS = 450
/** Gap between the keys of one xdotool chain: inside the 200 ms highlight window. */
const CHAIN_DELAY_MS = 40
/** Negative-observation window: a late or second edit must land before the exact read (250 ms
 *  edit sync plus the host round trip). */
const HOST_QUIET_MS = 1_000

const DOC = [
  '# Heading one',
  '',
  'Alpha bravo charlie delta.',
  '',
  'Echo `foxtrot` golf hotel.',
  '',
  '**India** juliet kilo.',
  '',
  '- lima mike',
  '- november',
  '',
  '> oscar papa',
  '',
].join('\n')
/** Outdent needs a nested item. */
const NESTED = DOC.replace('- november\n', '- november\n  - sierra\n')

/** The document with each [from, to] replaced once; `from` must exist, so a row cannot rot silently. */
function edit(
  doc: string,
  ...pairs: ReadonlyArray<readonly [string, string]>
): string {
  let out = doc
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`fixture lost: ${from}`)
    out = out.replace(from, to)
  }
  return out
}

type Mode = 'ir' | 'wysiwyg'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>

/** `word` selects the word, `caret` collapses two characters into it, `contents` selects the whole
 *  contents of the paragraph holding the text (a range whose start is the paragraph element). */
type Where = { word: string } | { caret: string } | { contents: string }

type Move =
  | { to: Where }
  | { dblclick: string }
  /** Real keys, sent in one xdotool process with the command key appended after CHAIN_DELAY_MS. */
  | { keys: readonly string[] }

type Act = { key: string } | { command: string }

interface Row {
  id: string
  mode: Mode
  /** The document the row starts from. */
  doc?: string
  /** Word whose context is settled first (a caret two characters into it). */
  settle: string
  move: Move
  act: Act
  /** The document after Vditor's fresh (correct) result. */
  expected: string
  /** Headings opens a picker panel instead of editing; it must be visible afterwards. */
  panelOpens?: boolean
}

const BOLD = { key: 'ctrl+b' }
const ITALIC = { key: 'ctrl+i' }
const INDENT = { key: 'ctrl+bracketright' }
const OUTDENT = { key: 'ctrl+bracketleft' }
const cmd = (name: string): Act => ({ command: `vmde.format.${name}` })

const IR_ROWS: Row[] = [
  // Ctrl+B: the measured code-span, doubled-bold and no-op rows of tasks/596.
  {
    id: 'bold: in code -> plain word (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: BOLD,
    expected: edit(DOC, ['bravo', '**bravo**']),
  },
  {
    id: 'bold: plain -> word in code (stale enabled: corrupted the code span)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: BOLD,
    expected: DOC,
  },
  {
    id: 'bold: plain -> bold word (stale not current: ****India****)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'India' } },
    act: BOLD,
    expected: edit(DOC, ['**India**', 'India']),
  },
  {
    id: 'bold: bold word -> plain word (stale current: no-op)',
    mode: 'ir',
    settle: 'India',
    move: { to: { word: 'bravo' } },
    act: BOLD,
    expected: edit(DOC, ['bravo', '**bravo**']),
  },
  // Ctrl+I.
  {
    id: 'italic: in code -> plain word (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: ITALIC,
    expected: edit(DOC, ['bravo', '*bravo*']),
  },
  {
    id: 'italic: plain -> word in code (stale enabled: corrupted the code span)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: ITALIC,
    expected: DOC,
  },
  // Ctrl+] and Ctrl+[.
  {
    id: 'indent: plain -> second list item (stale disabled: no-op)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { caret: 'november' } },
    act: INDENT,
    expected: edit(DOC, ['- november', '  - november']),
  },
  {
    id: 'outdent: plain -> nested list item (stale disabled: no-op)',
    mode: 'ir',
    doc: NESTED,
    settle: 'bravo',
    move: { to: { caret: 'sierra' } },
    act: OUTDENT,
    expected: edit(NESTED, ['  - sierra', '- sierra']),
  },
  // Real keys and pointer instead of a programmatic selection: the keyboard-only,
  // double-click and Shift+Home rows of tasks/596.
  {
    id: 'bold: Ctrl+Left twice into code, Ctrl+B 40 ms later (stale enabled: ****foxtrot)',
    mode: 'ir',
    settle: 'golf',
    move: { keys: ['ctrl+Left', 'ctrl+Left'] },
    act: BOLD,
    expected: DOC,
  },
  {
    id: 'bold: double-click a plain word right after leaving code (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { dblclick: 'bravo' },
    act: BOLD,
    expected: edit(DOC, ['bravo', '**bravo**']),
  },
  {
    id: 'bold: End, Shift+Home out of code, Ctrl+B 40 ms later (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { keys: ['End', 'shift+Home'] },
    act: BOLD,
    expected: edit(DOC, [
      'Echo `foxtrot` golf hotel.',
      '**Echo `foxtrot` golf hotel.**',
    ]),
  },
  // The eight unbound names through their commands.
  {
    id: 'inline-code: in code -> plain word (stale current: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: cmd('inlineCode'),
    expected: edit(DOC, ['bravo', '`bravo`']),
  },
  {
    id: 'inline-code: plain -> word in code (stale not current: nested code)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: cmd('inlineCode'),
    expected: edit(DOC, ['`foxtrot`', 'foxtrot']),
  },
  {
    id: 'strike: in code -> plain word (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: cmd('strike'),
    expected: edit(DOC, ['bravo', '~~bravo~~']),
  },
  {
    id: 'strike: plain -> word in code (stale enabled: corrupted the code span)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: cmd('strike'),
    expected: DOC,
  },
  {
    id: 'quote: plain -> quote text (stale not current: >> oscar papa)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'oscar' } },
    act: cmd('quote'),
    expected: edit(DOC, ['> oscar papa', 'oscar papa']),
  },
  {
    id: 'quote: quote text -> plain word (stale current: no-op)',
    mode: 'ir',
    settle: 'oscar',
    move: { to: { word: 'bravo' } },
    act: cmd('quote'),
    expected: edit(DOC, ['Alpha bravo', '> Alpha bravo']),
  },
  {
    id: 'headings: heading -> plain caret (stale current: the picker stays hidden)',
    mode: 'ir',
    settle: 'Heading',
    move: { to: { caret: 'bravo' } },
    act: cmd('headings'),
    expected: DOC,
    panelOpens: true,
  },
  {
    id: 'list: plain -> list item caret (stale not current: no-op)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { caret: 'lima' } },
    act: cmd('list'),
    expected: edit(DOC, [
      '- lima mike\n- november\n',
      'lima mike\n\nnovember\n',
    ]),
  },
  {
    id: 'ordered-list: in code -> plain caret (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { caret: 'bravo' } },
    act: cmd('orderedList'),
    expected: edit(DOC, [
      'Alpha bravo charlie delta.',
      '1. Alpha bravo charlie delta.',
    ]),
  },
  {
    id: 'check: in code -> plain caret (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { caret: 'bravo' } },
    act: cmd('check'),
    expected: edit(DOC, [
      'Alpha bravo charlie delta.',
      '* [ ]  Alpha bravo charlie delta.',
    ]),
  },
  {
    id: 'code: in code -> plain word (stale disabled: no-op)',
    mode: 'ir',
    settle: 'foxtrot',
    move: { to: { word: 'charlie' } },
    act: cmd('code'),
    expected: edit(DOC, [
      'Alpha bravo charlie delta.',
      'Alpha bravo\n\n```\ncharlie\n```\n\ndelta.',
    ]),
  },
  {
    id: 'code: plain -> word in code (stale enabled: corrupted the code span)',
    mode: 'ir',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: cmd('code'),
    expected: DOC,
  },
]

const WYSIWYG_ROWS: Row[] = [
  {
    id: 'bold: heading -> plain word (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: 'Heading',
    move: { to: { word: 'bravo' } },
    act: BOLD,
    expected: edit(DOC, ['bravo', '**bravo**']),
  },
  {
    id: 'italic: in code -> plain word (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: ITALIC,
    expected: edit(DOC, ['bravo', '*bravo*']),
  },
  {
    id: 'indent: plain -> second list item (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: 'bravo',
    move: { to: { caret: 'november' } },
    act: INDENT,
    expected: edit(DOC, ['- november', '  - november']),
  },
  {
    id: 'outdent: plain -> nested list item (stale disabled: no-op)',
    mode: 'wysiwyg',
    doc: NESTED,
    settle: 'bravo',
    move: { to: { caret: 'sierra' } },
    act: OUTDENT,
    expected: edit(NESTED, ['  - sierra', '- sierra']),
  },
  {
    id: 'inline-code: in code -> plain word (stale current: no-op)',
    mode: 'wysiwyg',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: cmd('inlineCode'),
    expected: edit(DOC, ['bravo', '`bravo`']),
  },
  {
    id: 'inline-code: plain -> word in code (stale not current: no-op)',
    mode: 'wysiwyg',
    settle: 'bravo',
    move: { to: { word: 'foxtrot' } },
    act: cmd('inlineCode'),
    expected: edit(DOC, ['`foxtrot`', 'foxtrot']),
  },
  {
    id: 'inline-code: in code -> paragraph contents, STRONG first (stale current: removed the bold)',
    mode: 'wysiwyg',
    settle: 'foxtrot',
    move: { to: { contents: 'India' } },
    act: cmd('inlineCode'),
    expected: DOC,
  },
  {
    id: 'quote: in quote -> paragraph contents, STRONG first (stale current: removed the bold)',
    mode: 'wysiwyg',
    settle: 'oscar',
    move: { to: { contents: 'India' } },
    act: cmd('quote'),
    expected: edit(DOC, ['**India**', '> **India**']),
  },
  {
    id: 'quote: plain -> quote text (stale not current: >> oscar papa)',
    mode: 'wysiwyg',
    settle: 'bravo',
    move: { to: { word: 'oscar' } },
    act: cmd('quote'),
    expected: edit(DOC, ['> oscar papa', 'oscar papa']),
  },
  {
    id: 'quote: quote text -> plain word (stale current: no-op)',
    mode: 'wysiwyg',
    settle: 'oscar',
    move: { to: { word: 'bravo' } },
    act: cmd('quote'),
    expected: edit(DOC, ['Alpha bravo', '> Alpha bravo']),
  },
  {
    id: 'strike: in code -> plain word (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: 'foxtrot',
    move: { to: { word: 'bravo' } },
    act: cmd('strike'),
    expected: edit(DOC, ['bravo', '~~bravo~~']),
  },
  {
    id: 'headings: heading -> list item caret (stale current: the picker stays hidden)',
    mode: 'wysiwyg',
    settle: 'Heading',
    move: { to: { caret: 'lima' } },
    act: cmd('headings'),
    expected: DOC,
    panelOpens: true,
  },
]

/** Per-row evidence read back from the page. */
interface Dispatch {
  type: string
  cls: string
  sinceInputMs: number
  selection: string
}

interface Outcome {
  id: string
  ok: boolean
  line: string
  failure?: string
}

interface Env {
  xtest: XtestInput
  workbox: import('@playwright/test').Page
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0]
  baseDir: string
  serial: number
  previous?: string
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

async function chain(env: Env, keys: readonly string[]) {
  await env.xtest.activateAndFocus()
  await runFile(
    '/usr/bin/xdotool',
    [
      'key',
      '--clearmodifiers',
      '--delay',
      String(CHAIN_DELAY_MS),
      '--',
      ...keys,
    ],
    { encoding: 'utf8', timeout: 5_000 },
  )
}

/** Set the selection by program. A synthetic keydown first drops any caret intent still armed
 *  (caret.ts invalidates on any keydown, ADR-0007) without reaching Vditor's handlers. */
function selectInPage(
  _body: Element,
  where: Where,
): { ok: boolean; selected: string; focused: boolean } {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft' }),
  )
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  root.normalize()
  const range = document.createRange()
  const needle = Object.values(where)[0] as string
  if ('contents' in where) {
    const paragraph = [...root.querySelectorAll('p')].find((p) =>
      (p.textContent ?? '').includes(needle),
    )
    if (!paragraph) return { ok: false, selected: '', focused: false }
    range.selectNodeContents(paragraph)
  } else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !(node.textContent ?? '').includes(needle))
      node = walker.nextNode()
    if (!node) return { ok: false, selected: '', focused: false }
    const at = (node.textContent ?? '').indexOf(needle)
    if ('word' in where) {
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
    } else {
      range.setStart(node, at + 2)
      range.collapse(true)
    }
  }
  root.focus({ preventScroll: true })
  const selection = window.getSelection() as Selection
  selection.removeAllRanges()
  selection.addRange(range)
  return {
    ok: true,
    selected: selection.toString(),
    focused: document.activeElement === root,
  }
}

async function place(frame: Frame, where: Where) {
  const placed = await frame.locator('body').evaluate(selectInPage, where)
  expect(placed.ok, `place ${JSON.stringify(where)}`).toBe(true)
  expect(placed.focused, 'the editor holds focus').toBe(true)
}

/** Record every router-dispatched toolbar click (untrusted) with the button's classes at that
 *  moment, and how long ago the last real keyup or mouseup was: the classes Vditor's click reads. */
async function installRecorder(frame: Frame) {
  await frame.locator('body').evaluate(() => {
    const log = { dispatches: [] as unknown[], lastInput: 0 }
    ;(window as any).__t596 = log
    for (const type of ['keyup', 'mouseup'])
      document.addEventListener(
        type,
        (event) => {
          if (event.isTrusted) log.lastInput = performance.now()
        },
        true,
      )
    document.addEventListener(
      'click',
      (event) => {
        const button = (event.target as Element | null)?.closest?.(
          '.vditor-toolbar button[data-type]',
        )
        if (!button || event.isTrusted) return
        const has = (c: string) => button.classList.contains(c)
        log.dispatches.push({
          type: button.getAttribute('data-type'),
          cls:
            `${has('vditor-menu--disabled') ? 'D' : ''}${has('vditor-menu--current') ? 'C' : ''}` ||
            '-',
          sinceInputMs: Math.round(performance.now() - log.lastInput),
          selection: window.getSelection()?.toString() ?? '',
        })
      },
      true,
    )
  })
}

const readDispatches = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).__t596.dispatches as Dispatch[])

const readPanel = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (
          (
            window as any
          ).vditor.vditor.toolbar.elements.headings?.querySelector(
            '.vditor-hint',
          ) as HTMLElement | null
        )?.style.display ?? null,
    )

/** Open the row's document in the row's mode and wait until Vditor is ready for selections. */
async function openRow(
  env: Env,
  row: Row,
): Promise<{ frame: Frame; file: string }> {
  // Save the previous disposable document so closeAllEditors cannot open a dirty-file dialog.
  if (env.previous) {
    await env.evaluateInVSCode(
      async (vscode: typeof import('vscode'), [file]: string[]) => {
        await vscode.workspace.textDocuments
          .find((item) => item.uri.fsPath === file)
          ?.save()
      },
      [env.previous],
    )
  }
  const file = path.join(env.baseDir, `t596-live-${++env.serial}.md`)
  writeFileSync(file, row.doc ?? DOC)
  env.previous = file
  const frame = await reopenVmdeFixture(
    env.evaluateInVSCode,
    env.workbox,
    file,
    60_000,
    'body',
    false,
  )
  const opened = await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode !== null,
    { message: 'Task 596 live gate editor ready', timeout: 60_000 },
  )
  await waitForInitialUndoSnapshot(frame)
  if (opened.mode !== row.mode) {
    // The mode is remembered across documents, so this switches only on the first row of a test.
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${row.mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === row.mode, {
      message: `Task 596 live gate ${row.mode} ready`,
    })
    await waitForInitialUndoSnapshot(frame)
  }
  await env.xtest.activateAndFocus()
  await frame
    .locator(`.vditor-${row.mode} p`)
    .filter({ hasText: 'Alpha' })
    .first()
    .click()
  await wait(400)
  await installRecorder(frame)
  return { frame, file }
}

/** An OS-level `Shift_L`: the keyup makes Vditor's highlight run, then wait it out. */
async function settleHighlight(env: Env) {
  await env.xtest.key('Shift_L')
  await wait(SETTLE_MS)
}

async function dblclickWord(frame: Frame, row: Row, word: string) {
  const paragraph = frame
    .locator(`.vditor-${row.mode} p`)
    .filter({ hasText: word })
    .first()
  const position = await paragraph.evaluate((element, target) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(target)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + target.length)
      const word = range.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      return {
        x: word.left - box.left + word.width / 2,
        y: word.top - box.top + word.height / 2,
      }
    }
    throw new Error(`no text node holds ${target}`)
  }, word)
  await paragraph.dblclick({ position })
}

/** Move from context A to B. Returns true when the key chain already sent the command key. */
async function moveToB(env: Env, frame: Frame, row: Row): Promise<boolean> {
  const { move } = row
  if ('to' in move) await place(frame, move.to)
  else if ('dblclick' in move) await dblclickWord(frame, row, move.dblclick)
  else {
    if (!('key' in row.act)) throw new Error('a key move needs a key command')
    // Live: the command key follows in the same process, inside Vditor's 200 ms window.
    if (!CONTROL) {
      await chain(env, [...move.keys, row.act.key])
      return true
    }
    await chain(env, move.keys)
  }
  if (CONTROL) await settleHighlight(env)
  return false
}

async function sendCommand(env: Env, act: Act) {
  if ('key' in act) {
    await env.xtest.key(act.key)
    return
  }
  await env.evaluateInVSCode(
    async (vscode: typeof import('vscode'), [id]: string[]) => {
      await vscode.commands.executeCommand(id)
    },
    [act.command],
  )
}

/** After the one router click: let a late or second edit land, then read the exact host text. */
async function readHostText(env: Env, file: string, expected: string) {
  await wait(HOST_QUIET_MS)
  let actual = await docText(env.evaluateInVSCode, file)
  if (actual !== expected) {
    // A slow host sync gets one more window before the mismatch counts.
    await expect
      .poll(() => docText(env.evaluateInVSCode, file), { timeout: 4_000 })
      .toBe(expected)
      .catch(() => undefined)
    actual = await docText(env.evaluateInVSCode, file)
  }
  return actual
}

/** The lines that differ from the original document, for a compact log line. */
function changedLines(doc: string, actual: string) {
  const before = new Set(doc.split('\n'))
  const after = new Set(actual.split('\n'))
  return [
    ...[...before].filter((l) => !after.has(l)).map((l) => `-${l}`),
    ...[...after].filter((l) => !before.has(l)).map((l) => `+${l}`),
  ].join(' | ')
}

async function runRow(env: Env, row: Row): Promise<Outcome> {
  const { frame, file } = await openRow(env, row)
  await place(frame, { caret: row.settle })
  await settleHighlight(env)
  const sent = await moveToB(env, frame, row)
  if (!sent) await sendCommand(env, row.act)
  await expect
    .poll(async () => (await readDispatches(frame)).length, {
      timeout: 10_000,
      message: 'the router clicks one toolbar button',
    })
    .toBeGreaterThanOrEqual(1)
  const actual = await readHostText(env, file, row.expected)
  const dispatches = await readDispatches(frame)
  const panel = row.panelOpens ? await readPanel(frame) : null
  const clicks = dispatches
    .map((d) => `${d.type}:${d.cls}@${d.sinceInputMs}ms`)
    .join(',')
  const problems: string[] = []
  if (actual !== row.expected)
    problems.push(
      `host text ${JSON.stringify(actual)}, expected ${JSON.stringify(row.expected)}`,
    )
  if (dispatches.length !== 1)
    problems.push(`${dispatches.length} toolbar clicks, expected 1`)
  if (row.panelOpens && panel !== 'block')
    problems.push(`headings picker display ${panel}, expected block`)
  const doc = row.doc ?? DOC
  const line = `${problems.length ? 'FAIL' : 'ok  '} ${row.id} [${clicks}] ${actual === doc ? 'unchanged' : changedLines(doc, actual)}`
  return {
    id: row.id,
    ok: problems.length === 0,
    line,
    failure: problems.length ? `${row.id}: ${problems.join('; ')}` : undefined,
  }
}

/** Run every row, recording a failure instead of stopping, so one run returns the whole picture. */
async function runRows(env: Env, rows: Row[]) {
  const failures: string[] = []
  for (const row of rows) {
    let outcome: Outcome
    try {
      outcome = await runRow(env, row)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      outcome = {
        id: row.id,
        ok: false,
        line: `FAIL ${row.id} [threw]`,
        failure: `${row.id}: threw ${reason.split('\n')[0]}`,
      }
    }
    console.log(outcome.line)
    if (outcome.failure) failures.push(outcome.failure)
  }
  return failures
}

test.describe('Task 596 live-selection toolbar-hotkey gate (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  for (const [mode, rows] of [
    ['ir', IR_ROWS],
    ['wysiwyg', WYSIWYG_ROWS],
  ] as const)
    test(`${mode}: a toolbar command acts on the live selection, not the stale toolbar classes`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(900_000)
      const xtest = await createXtestInput(electronApp, workbox)
      const env: Env = {
        xtest,
        workbox,
        evaluateInVSCode: evaluateInVSCode as Env['evaluateInVSCode'],
        baseDir,
        serial: 0,
      }
      const failures = await runRows(env, rows)
      expect(
        failures,
        `${mode} rows that differ from Vditor's fresh result`,
      ).toEqual([])
    })
})
