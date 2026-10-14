import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  blockActionPreparePayload,
  planBlockAction,
} from '../../src/shared/block-move'
import {
  isLuteWarm,
  prewarmLute,
  reserializeMarkdown,
} from '../../src/lute/lute-host'
import { minimalDiffWriteback } from '../../src/markdown/minimal-diff-writeback'
import { HistoryCouplingController } from '../../src/writeback/history-coupling'
import { normalizeContent } from '../../src/writeback/sync-state'
import type { HostMessage, WebviewMessage } from '../../src/shared/protocol'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 607 S3 — Chromium test cases for the exact actions (Turn Into, Find Replace one and all, a
// table insert row, Move Block Down and Up) after a trusted edit (a typed key and a paste), in IR
// and WYSIWYG, on a document whose rendering differs from its source.
//
// The page is the REAL webview entry (shortcut-negative harness: main.ts with the shipped Vditor
// patches). The host is a small model in this file: it answers the webview's messages with the
// extension host's own pure modules (minimal-diff write-back, history coupling, block-move planner)
// and applies the extension host's exact-edit rules to its text. It is the reference for every
// assertion: the host text after the trusted edit is the reference, and an action must change only
// its own span of it.
//
// HOST_GUARD=0 selects the host model of the commit before the exact-ownership work: an exact edit is
// written as posted, `request-exact-authority` is unknown, and nothing is ever refused. The same
// spec then runs against that commit's build (see the task record) to show the cases fail without
// the fix.
//
// Acceptance items (tasks/607-exact-actions-after-trusted-edit.md):
//   A1 "Trusted input followed by every covered exact action changes only the intended source spans"
//      and A2 "No path promotes unrelated normalized rendered bytes ... as an exact edit" — the
//      `after a typed edit` / `after a pasted edit` test cases, one per action, mode and edit kind.
//   A3 "Host, webview, disk and native Undo/Redo agree on the final exact document" — in those test
//      cases, one Undo restores the host text from before the action.
//   A4 "IR and WYSIWYG: Move Block (Down and Up) after an edit and its Undo moves the block exactly"
//      — the `Move Block after an edit and its Undo` test cases (one Undo restores the document).
//   A5/A7 "A real mismatch ... changes nothing" and "An edit that cannot be ... bounded fails closed
//      with no write" — the `host text forced to differ` test cases.

const HOST_GUARD = process.env.HOST_GUARD !== '0'
const ROOT = path.resolve(__dirname, '../..')

type Mode = 'ir' | 'wysiwyg'
const MODES: Mode[] = ['ir', 'wysiwyg']
type EditKind = 'type' | 'paste'
const EDITS: EditKind[] = ['type', 'paste']

// Privacy-safe, generic content. The source differs from its rendering: setext heading, `__strong__`,
// `*` bullets with a nested item, a repeated-number ordered list, a table with unaligned pipes and
// trailing spaces.
const NORMALIZING = [
  'Setext title',
  '============',
  '',
  'editword paragraph with __strongword__ before the table',
  '',
  'pairword paragraph one   ',
  '',
  '| Name | Value |',
  '|:--|--:|',
  '| cellone |   2 |',
  '| celltwo| 30 |',
  '',
  '* starred item one',
  '* starred item two',
  '    * nested item three',
  '',
  '1. numbered one',
  '1. numbered two',
  '1. numbered three',
  '',
  'turnword paragraph after the list',
  '',
  'onlyword paragraph near the end',
  '',
  'pairword paragraph two',
  '',
  'italicword paragraph',
  '',
  'moveword paragraph',
  '',
  'after paragraph',
  '',
].join('\n')

// ---------------------------------------------------------------------------------------------
// The host model.

interface Sent {
  command: string
  [key: string]: unknown
}

class HostModel {
  text: string
  version = 0
  readonly received: WebviewMessage[] = []
  readonly sent: Sent[] = []
  // Texts of the document, oldest first: one native Undo step per host write.
  private undoStack: string[] = []
  private redoStack: string[] = []
  private lastSynced: string
  private chain: Promise<unknown> = Promise.resolve()
  private outbound: Promise<unknown> = Promise.resolve()
  private readonly baseline: string
  private readonly coupling: HistoryCouplingController
  /** Overwrites the host text with an outside change just before the next message of this kind is
   *  handled, as an edit that landed earlier in the host's queue would. */
  interfereBefore: 'exact-edit' | 'block-request' | null = null

  constructor(
    initial: string,
    private readonly post: (message: Sent) => Promise<unknown>,
  ) {
    this.text = initial
    this.baseline = initial
    this.lastSynced = initial
    const canonical = (markdown: string) => reserializeMarkdown(ROOT, markdown)
    const equivalent = (source: string, content: string) =>
      normalizeContent(source) === normalizeContent(content) ||
      (canonical(source) !== undefined &&
        canonical(source) === canonical(content))
    this.coupling = new HistoryCouplingController({
      currentContent: () => this.text,
      equivalentToCurrent: (content) => equivalent(this.text, content),
      equivalent,
      execute: async (kind) => {
        this.nativeHistory(kind)
      },
      setApplying: () => undefined,
      markSynced: (content) => {
        this.lastSynced = content
      },
      postUpdate: async () => {
        this.lastSynced = this.text
        await this.send({
          command: 'update',
          type: 'update',
          content: this.text,
        })
      },
      debug: () => undefined,
    })
  }

  send(message: Sent): Promise<unknown> {
    this.sent.push(message)
    this.outbound = this.outbound.then(() => this.post(message))
    return this.outbound
  }

  private write(next: string) {
    if (next === this.text) return
    this.undoStack.push(this.text)
    this.redoStack = []
    this.text = next
    this.version++
  }

  private nativeHistory(kind: 'undo' | 'redo') {
    const [from, to] =
      kind === 'undo'
        ? [this.undoStack, this.redoStack]
        : [this.redoStack, this.undoStack]
    const next = from.pop()
    if (next === undefined) return
    to.push(this.text)
    this.text = next
    this.version++
  }

  /** Text the host holds because something other than the webview wrote it. */
  externalWrite(next: string) {
    this.write(next)
  }

  receive(message: WebviewMessage): Promise<unknown> {
    this.received.push(message)
    const turn = this.chain
      .catch(() => undefined)
      .then(() => this.handle(message))
    this.chain = turn
    return turn
  }

  private async handle(message: WebviewMessage): Promise<void> {
    switch (message.command) {
      case 'edit':
        return this.onEdit(message)
      case 'history-base':
        this.coupling.recordBase(
          (message as any).mode,
          (message as any).content,
          normalizeContent(this.text) === normalizeContent(this.lastSynced)
            ? this.text
            : undefined,
        )
        return
      case 'history-transition':
        await this.coupling.handle({
          kind: (message as any).kind,
          before: (message as any).before,
          after: (message as any).after,
        })
        return
      case 'request-exact-authority':
        if (HOST_GUARD)
          await this.send({
            command: 'exact-authority',
            requestId: message.requestId,
            content: this.text,
          })
        return
      case 'request-block-action':
        return this.onBlockRequest(message)
      case 'apply-block-action':
        return this.onBlockApply(message)
      default:
    }
  }

  private async onEdit(message: Extract<WebviewMessage, { command: 'edit' }>) {
    if (message.exact && this.interfereBefore === 'exact-edit') {
      this.interfereBefore = null
      this.externalWrite(`${this.text}externalword paragraph\n\n`)
    }
    const plain =
      !message.exact && !message.explicitBlock && !message.rewrapDocument
    if (await this.coupling.consumeEdit(message.content, plain)) return
    const versionBefore = this.version
    const outcome = this.sync(message)
    if (outcome === 'refused')
      await this.send({
        command: 'exact-edit-refused',
        ...(message.requestId === undefined
          ? {}
          : { requestId: message.requestId }),
        content: this.text,
      })
    if (
      this.version !== versionBefore ||
      normalizeContent(this.text) === normalizeContent(message.content)
    ) {
      this.coupling.recordPublished(message.content, this.text)
      this.lastSynced = this.text
    }
  }

  // The write-back controller's rules: an equal text is unchanged; an exact edit needs the text it
  // names to be the host text; a plain edit is minimized against the clean baseline.
  private sync(
    message: Extract<WebviewMessage, { command: 'edit' }>,
  ): 'written' | 'unchanged' | 'refused' {
    if (normalizeContent(message.content) === normalizeContent(this.text))
      return 'unchanged'
    if (message.exact && HOST_GUARD) {
      const before = typeof message.before === 'string' ? message.before : null
      if (
        before === null ||
        normalizeContent(before) !== normalizeContent(this.text)
      )
        return 'refused'
    }
    this.write(
      message.exact
        ? message.content
        : minimalDiffWriteback(this.baseline, message.content, (block) =>
            reserializeMarkdown(ROOT, block),
          ),
    )
    return 'written'
  }

  private pendingBlocks = new Map<
    string,
    { version: number; before: string; after: string }
  >()

  private async onBlockRequest(
    message: Extract<WebviewMessage, { command: 'request-block-action' }>,
  ) {
    if (this.interfereBefore === 'block-request') {
      this.interfereBefore = null
      this.externalWrite(`${this.text}externalword paragraph\n\n`)
    }
    const before = this.text
    const plan =
      message.before === before
        ? planBlockAction(before, message.action)
        : { status: 'rejected' as const }
    if (plan.status !== 'ok') {
      await this.send({
        command: 'block-action-outcome',
        requestId: message.requestId,
        status: plan.status === 'noop' ? 'noop' : 'stale',
        content: before,
      })
      return
    }
    const binding = { version: this.version, before, after: plan.markdown }
    this.pendingBlocks.set(message.requestId, binding)
    await this.send(
      blockActionPreparePayload(
        message.requestId,
        { uri: 'model://document', ...binding },
        plan.caretOffset,
      ),
    )
  }

  private async onBlockApply(
    message: Extract<WebviewMessage, { command: 'apply-block-action' }>,
  ) {
    const binding = this.pendingBlocks.get(message.requestId)
    this.pendingBlocks.delete(message.requestId)
    const valid =
      binding &&
      binding.version === message.version &&
      binding.before === message.before &&
      binding.after === message.after
    let status: 'applied' | 'stale' | 'noop' = 'stale'
    if (
      valid &&
      this.version === binding.version &&
      this.text === binding.before
    ) {
      if (binding.after === binding.before) status = 'noop'
      else {
        this.write(binding.after)
        this.lastSynced = this.text
        status = 'applied'
      }
    }
    await this.send({
      command: 'block-action-outcome',
      requestId: message.requestId,
      status,
      content: this.text,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Page helpers.

interface Session {
  page: Page
  host: HostModel
  mode: Mode
}

async function openEditor(
  page: Page,
  mode: Mode,
  content: string,
): Promise<Session> {
  const host = new HostModel(content, (message) =>
    page.evaluate((m) => window.postMessage(m, '*'), message as any),
  )
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.exposeFunction('__hostReceive', (message: WebviewMessage) => {
    if (message?.command === 'ready')
      return host.send({
        command: 'update',
        type: 'init',
        content,
        cdn: '/vditor',
        options: { showToolbar: true, defaultMode: mode },
        theme: 'light',
        wiki: { enabled: false },
        e2e: true,
      } as HostMessage)
    return host.receive(message)
  })
  await page.addInitScript(() => {
    const win = window as any
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: unknown) => {
        win.__hostReceive(JSON.parse(JSON.stringify(posted)))
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  })
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    (target) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === target
      )
    },
    mode,
    { timeout: 15_000 },
  )
  return { page, host, mode }
}

const route = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((m) => window.postMessage(m, '*'), message)

const rendered = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

/** Focus the surface and put a caret (or selection) at `offset` into `needle`. */
async function place(page: Page, needle: string, offset = 0, length = 0) {
  await page.evaluate(async () => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  // A command keeps a live caret intent until a real gesture; a bare Shift press is one.
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, length] as const)
  await page.keyboard.press('Shift')
  // Focus restoration can still move the caret after the selection is set; the next key would then
  // land elsewhere. Settle two frames and set it again until it stays in the target block.
  const stays = () =>
    page.evaluate(async (target) => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      const anchor = getSelection()?.anchorNode
      const block = (
        anchor instanceof Element ? anchor : anchor?.parentElement
      )?.closest('p, td, th, li, h1, h2, h3, h4, h5, h6, div[data-block]')
      return Boolean(block?.textContent?.includes(target))
    }, needle)
  for (let attempt = 0; attempt < 5 && !(await stays()); attempt++)
    await page.evaluate(selectEditorText, [needle, offset, length] as const)
  expect(await stays(), `caret placed in ${needle}`).toBe(true)
}

async function typeOrPaste(page: Page, kind: EditKind) {
  if (kind === 'type') await page.keyboard.type('x')
  else {
    await page.evaluate(() => navigator.clipboard.writeText('pq'))
    await page.keyboard.press('Control+V')
  }
}

const hostSays = (host: HostModel, predicate: (text: string) => boolean) =>
  expect.poll(() => predicate(host.text), { timeout: 15_000 }).toBe(true)

// A trusted edit: a typed key or a paste into the paragraph before the table. Resolves once the
// host holds the edit; returns the host text after it, the reference every action is judged by.
async function trustedEdit(
  s: Session,
  kind: EditKind,
  target: { needle: string; offset: number } = {
    needle: 'editword',
    offset: 2,
  },
) {
  const initial = s.host.text
  await place(s.page, target.needle, target.offset)
  await typeOrPaste(s.page, kind)
  await hostSays(s.host, (text) => text !== initial)
  const at = initial.indexOf(target.needle) + target.offset
  const typed = kind === 'type' ? 'x' : 'pq'
  // Positive control: the trusted edit is the only change of the host text.
  expect(s.host.text).toBe(initial.slice(0, at) + typed + initial.slice(at))
  return s.host.text
}

interface Span {
  start: number
  end: number
}

// Whether any byte of `reference` outside `span` differs in `after`.
function outsideSpanChanged(reference: string, after: string, span: Span) {
  const head = reference.slice(0, span.start)
  const tail = reference.slice(span.end)
  return !(
    after.length >= head.length + tail.length &&
    after.startsWith(head) &&
    after.endsWith(tail)
  )
}

function anchorSpan(text: string, needle: string): Span {
  const at = text.indexOf(needle)
  expect(at, `${needle} exists`).toBeGreaterThanOrEqual(0)
  return { start: at, end: at + needle.length }
}
function lineSpan(text: string, needle: string): Span {
  const at = anchorSpan(text, needle).start
  const start = text.lastIndexOf('\n', at) + 1
  const end = text.indexOf('\n', at)
  return { start, end: end < 0 ? text.length : end }
}
function tableSpan(text: string): Span {
  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.startsWith('|'))
  let last = first
  while (lines[last + 1]?.startsWith('|')) last++
  const start = lines.slice(0, first).join('\n').length + (first > 0 ? 1 : 0)
  return { start, end: lines.slice(0, last + 1).join('\n').length }
}
const pipeLines = (text: string) =>
  text.split('\n').filter((line) => line.startsWith('|')).length

// ---------------------------------------------------------------------------------------------
// Actions. Each returns the span it may change in the reference and the exact result when the
// contract gives one.

type ActionName =
  | 'turn-into'
  | 'find-replace-one'
  | 'find-replace-all'
  | 'table-insert-row'
  | 'table-move-row-down'
  | 'move-block-down'
  | 'move-block-up'

interface Plan {
  span: Span
  expected: string | null
  applied: (text: string) => boolean
  run: (s: Session) => Promise<void>
}

const SWAP_FROM = 'moveword paragraph\n\nafter paragraph'
const SWAP_TO = 'after paragraph\n\nmoveword paragraph'

const findWidget = (page: Page) => page.locator('.vmde-find-replace')

async function runFind(
  s: Session,
  find: string,
  replace: string,
  all: boolean,
) {
  const { page } = s
  const before = s.host.text
  await place(page, 'italicword', 2)
  await route(page, { command: 'open-find-replace', mode: 'replace' })
  const widget = findWidget(page)
  await expect(widget).toBeVisible()
  await widget.locator('[data-find]').fill(find)
  await widget.locator('[data-replace]').fill(replace)
  // Matches appear once the source is owned; the status line is the sign that Replace may act.
  await expect(widget.locator('[data-status]')).toHaveText(
    all ? '1 of 2' : '1 of 1',
  )
  await route(page, {
    command: 'find-widget-action',
    action: all ? 'replace-all' : 'replace-one',
  })
  // The result is read from the host; Undo goes to the document once the widget is closed (a
  // focused Find field keeps Undo for its own text).
  await expect
    .poll(() => s.host.text !== before, { timeout: 15_000 })
    .toBe(true)
  await route(page, { command: 'find-widget-action', action: 'close' })
  await expect(widget).toBeHidden()
}

function plan(action: ActionName, reference: string): Plan {
  switch (action) {
    case 'turn-into': {
      const span = lineSpan(reference, 'turnword')
      return {
        span,
        expected: `${reference.slice(0, span.start)}## ${reference.slice(span.start)}`,
        applied: (text) => text !== reference,
        run: async (s) => {
          await place(s.page, 'turnword', 2)
          await route(s.page, { command: 'request-block-transform-options' })
          await expect
            .poll(() =>
              s.host.received.some(
                (m) => m.command === 'block-transform-options',
              ),
            )
            .toBe(true)
          const options = [...s.host.received]
            .reverse()
            .find((m) => m.command === 'block-transform-options') as any
          await route(s.page, {
            command: 'apply-block-transform-choice',
            token: options.token,
            target: { type: 'h2' },
          })
        },
      }
    }
    case 'find-replace-one': {
      const span = anchorSpan(reference, 'onlyword')
      return {
        span,
        expected: `${reference.slice(0, span.start)}zzword${reference.slice(span.end)}`,
        applied: (text) => text !== reference,
        run: (s) => runFind(s, 'onlyword', 'zzword', false),
      }
    }
    case 'find-replace-all': {
      const first = anchorSpan(reference, 'pairword')
      const lastAt = reference.lastIndexOf('pairword')
      expect(lastAt).toBeGreaterThan(first.start)
      return {
        span: { start: first.start, end: lastAt + 'pairword'.length },
        expected: reference.replaceAll('pairword', 'zzword'),
        applied: (text) => text !== reference,
        run: (s) => runFind(s, 'pairword', 'zzword', true),
      }
    }
    case 'table-insert-row':
      return {
        span: tableSpan(reference),
        expected: null,
        applied: (text) => pipeLines(text) === pipeLines(reference) + 1,
        run: async (s) => {
          await place(s.page, 'cellone', 3)
          await route(s.page, {
            command: 'editor-action',
            action: 'table-insert-row-below',
          })
        },
      }
    case 'table-move-row-down':
      return {
        span: tableSpan(reference),
        expected: null,
        applied: (text) => {
          const table = text.slice(tableSpan(text).start, tableSpan(text).end)
          return (
            pipeLines(text) === pipeLines(reference) &&
            table.indexOf('celltwo') < table.indexOf('cellone')
          )
        },
        run: async (s) => {
          await place(s.page, 'cellone', 3)
          await route(s.page, {
            command: 'editor-action',
            action: 'table-move-row-down',
          })
        },
      }
    case 'move-block-down':
    case 'move-block-up': {
      expect(reference.split(SWAP_FROM).length - 1).toBe(1)
      const start = reference.indexOf(SWAP_FROM)
      return {
        span: { start, end: start + SWAP_FROM.length },
        expected: reference.replace(SWAP_FROM, SWAP_TO),
        applied: (text) => text !== reference,
        run: async (s) => {
          // Down from the first paragraph and Up from the second swap the same two blocks.
          await place(
            s.page,
            action === 'move-block-down'
              ? 'moveword paragraph'
              : 'after paragraph',
            2,
          )
          await route(s.page, {
            command: 'editor-action',
            action:
              action === 'move-block-down'
                ? 'move-block-down'
                : 'move-block-up',
          })
        },
      }
    }
    default:
      throw new Error(`unknown action ${action}`)
  }
}

const ACTIONS: ActionName[] = [
  'turn-into',
  'find-replace-one',
  'find-replace-all',
  'table-insert-row',
  'table-move-row-down',
  'move-block-down',
  'move-block-up',
]

const undoOnce = (page: Page) =>
  route(page, { command: 'trigger-toolbar-hotkey', name: 'undo' })

test.beforeAll(async () => {
  prewarmLute(ROOT)
  await expect.poll(() => isLuteWarm(), { timeout: 20_000 }).toBe(true)
})

// A1 + A2 + A3: after a trusted edit, an action changes only its own span of the host text, and
// one Undo restores the host text from before the action.
for (const mode of MODES)
  for (const edit of EDITS)
    for (const action of ACTIONS)
      test(`${mode}: ${action} after a ${edit === 'type' ? 'typed' : 'pasted'} edit changes only its span`, async ({
        page,
      }) => {
        test.setTimeout(60_000)
        const s = await openEditor(page, mode, NORMALIZING)
        // Positive control: the document normalizes, so a rendered serialization has bytes to leak.
        expect(await rendered(page)).not.toBe(NORMALIZING)
        const reference = await trustedEdit(s, edit)
        const todo = plan(action, reference)
        await todo.run(s)
        await hostSays(s.host, todo.applied)
        const afterAction = s.host.text
        expect(
          outsideSpanChanged(reference, afterAction, todo.span),
          'bytes outside the action span changed',
        ).toBe(false)
        if (todo.expected !== null) expect(afterAction).toBe(todo.expected)
        else if (action === 'table-insert-row')
          expect(pipeLines(afterAction)).toBe(pipeLines(reference) + 1)
        // Exact edits the action posted must have been accepted as exact, never refused.
        expect(
          s.host.sent.filter((m) => m.command === 'exact-edit-refused'),
        ).toEqual([])
        // One Undo returns the host text to the reference.
        await undoOnce(page)
        await expect
          .poll(() => s.host.text, { timeout: 15_000 })
          .toBe(reference)
      })

// A4: Move Block after an edit and its Undo moves the block, and one Undo restores the document.
for (const mode of MODES)
  for (const action of ['move-block-down', 'move-block-up'] as const)
    test(`${mode}: ${action} after an edit and its Undo moves the block and one Undo restores it`, async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const s = await openEditor(page, mode, NORMALIZING)
      expect(await rendered(page)).not.toBe(NORMALIZING)
      // An Italic command on `italicword`, then its Undo: the host text is the original again.
      await place(page, 'italicword', 0, 'italicword'.length)
      await route(page, { command: 'trigger-toolbar-hotkey', name: 'italic' })
      await hostSays(s.host, (text) => text.includes('*italicword*'))
      await undoOnce(page)
      await expect
        .poll(() => s.host.text, { timeout: 15_000 })
        .toBe(NORMALIZING)
      const todo = plan(action, NORMALIZING)
      await todo.run(s)
      await hostSays(s.host, todo.applied)
      expect(s.host.text).toBe(todo.expected)
      await undoOnce(page)
      await expect
        .poll(() => s.host.text, { timeout: 15_000 })
        .toBe(NORMALIZING)
    })

// A5 + A7: the host text differs from what the action was planned on when the action's edit
// arrives. Nothing is written for the action, and the webview takes the host text back.
for (const mode of MODES)
  for (const action of [
    'turn-into',
    'find-replace-one',
    'table-move-row-down',
    'move-block-down',
  ] as const)
    test(`${mode}: ${action} with the host text forced to differ writes nothing`, async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const s = await openEditor(page, mode, NORMALIZING)
      const reference = await trustedEdit(s, 'type')
      const todo = plan(action, reference)
      s.host.interfereBefore =
        action === 'move-block-down' ? 'block-request' : 'exact-edit'
      const external = `${reference}externalword paragraph\n\n`
      await todo.run(s)
      await expect
        .poll(() => s.host.interfereBefore, { timeout: 15_000 })
        .toBe(null)
      // The action's edit or request was handled against the changed host text.
      await expect.poll(() => s.host.text, { timeout: 15_000 }).toBe(external)
      if (action !== 'move-block-down')
        await expect
          .poll(() =>
            s.host.sent.some((m) => m.command === 'exact-edit-refused'),
          )
          .toBe(true)
      else
        await expect
          .poll(() =>
            s.host.sent.some(
              (m) =>
                m.command === 'block-action-outcome' && m.status === 'stale',
            ),
          )
          .toBe(true)
      // No write by the action: every byte of the host text is the outside change.
      expect(s.host.text).toBe(external)
      // The webview shows the host text, without the action's result, and its exact source is the
      // host text or unowned, never other bytes.
      if (action !== 'move-block-down')
        await expect
          .poll(async () => (await rendered(page)).includes('externalword'), {
            timeout: 15_000,
          })
          .toBe(true)
      const value = await rendered(page)
      if (action === 'turn-into') expect(value).not.toContain('## turnword')
      if (action === 'find-replace-one') expect(value).not.toContain('zzword')
      if (action === 'move-block-down')
        expect(value.indexOf('moveword paragraph')).toBeLessThan(
          value.indexOf('after paragraph'),
        )
      const exact = await page.evaluate(
        () => (window as any).__vmdeE2EExactMarkdown?.() as string | null,
      )
      expect(exact === null || exact === external).toBe(true)
    })

// Edge case: Replace All whose matches surround the edited span. The edit sits between the two
// matches, so the replaced span covers it; the edit must survive and nothing else may change.
for (const mode of MODES)
  for (const edit of EDITS)
    test(`${mode}: find-replace-all across the edited span after a ${edit === 'type' ? 'typed' : 'pasted'} edit keeps the edit`, async ({
      page,
    }) => {
      test.setTimeout(60_000)
      const s = await openEditor(page, mode, NORMALIZING)
      expect(await rendered(page)).not.toBe(NORMALIZING)
      const reference = await trustedEdit(s, edit, {
        needle: 'turnword paragraph',
        offset: 3,
      })
      const first = reference.indexOf('pairword')
      const last = reference.lastIndexOf('pairword')
      const edited = NORMALIZING.indexOf('turnword') + 3
      expect(first).toBeLessThan(edited)
      expect(edited).toBeLessThan(last)
      const todo = plan('find-replace-all', reference)
      await todo.run(s)
      await hostSays(s.host, todo.applied)
      expect(s.host.text).toBe(todo.expected)
      expect(s.host.text).toContain(edit === 'type' ? 'turx' : 'turpq')
      await undoOnce(page)
      await expect.poll(() => s.host.text, { timeout: 15_000 }).toBe(reference)
    })

// Edge case (decision D3): the action runs right after the typed key, before the 250 ms edit
// publication. The host must end with the typed key plus the action and nothing else.
for (const mode of MODES) {
  test(`${mode}: turn-into right after typing, before the edit is published, writes the key and the action`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const s = await openEditor(page, mode, NORMALIZING)
    expect(await rendered(page)).not.toBe(NORMALIZING)
    await place(page, 'editword', 2)
    await page.keyboard.type('x')
    await route(page, { command: 'request-block-transform-options' })
    await expect
      .poll(() =>
        s.host.received.some((m) => m.command === 'block-transform-options'),
      )
      .toBe(true)
    const options = [...s.host.received]
      .reverse()
      .find((m) => m.command === 'block-transform-options') as any
    await route(page, {
      command: 'apply-block-transform-choice',
      token: options.token,
      target: { type: 'h2' },
    })
    const expected = NORMALIZING.replace(
      'editword paragraph',
      '## edxitword paragraph',
    )
    // Decision D3 allows two outcomes: the key and the action written together (a rebase proven
    // against the rendering), or the action declined with nothing written for it, so the key alone
    // reaches the host. Both mean "no bytes outside the key and the action".
    const typedOnly = NORMALIZING.replace('editword', 'edxitword')
    await expect
      .poll(() => s.host.text === expected || s.host.text === typedOnly, {
        timeout: 15_000,
      })
      .toBe(true)
    if (s.host.text === typedOnly) {
      // A declined action stays declined: a quiet window shows no later write and no DOM change.
      await page.waitForTimeout(1000)
      expect(s.host.text).toBe(typedOnly)
      expect(await rendered(page)).not.toContain('## edxitword')
    }
  })

  test(`${mode}: move-block-down right after typing, before the edit is published, writes the key and the move`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const s = await openEditor(page, mode, NORMALIZING)
    expect(await rendered(page)).not.toBe(NORMALIZING)
    await place(page, 'moveword paragraph', 1)
    await page.keyboard.type('x')
    await route(page, { command: 'editor-action', action: 'move-block-down' })
    const expected = NORMALIZING.replace(
      SWAP_FROM,
      'after paragraph\n\nmxoveword paragraph',
    )
    await expect.poll(() => s.host.text, { timeout: 15_000 }).toBe(expected)
  })
}
