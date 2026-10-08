/**
 * Task 620 — IR Expand Selection widens past the inline scope on the first keys after opening, in
 * the real VS Code webview with OS-level XTEST input (Shift+Alt+Right).
 *
 * Vditor's keydown can leave empty text nodes inside the inline node (`recordFirstPosition` →
 * `addCaret` splits text around its caret marker). Before commit 3e5d5996 the ladder compared its
 * stage ranges by DOM node identity, so after such a split every press re-selected the inline text.
 * Now `rangesEqual` (selection-scope.ts) compares the characters a range covers.
 *
 * - S1: a freshly opened document, no edit. The paragraph ladder is inline → block → document and
 *   the cell ladder inline → cell → block → document; the host keeps its exact bytes and stays
 *   clean, and the undo stack does not grow.
 * - S2: the same ladders after one typed character (the "unchanged after an edit" acceptance item),
 *   then Select All: block, then the whole document. The ladders and Select All leave the host on
 *   the edited text.
 * - S3: the same paragraph ladder on the large synthetic fixture, where Vditor's empty text nodes
 *   appear from the first press. Only this leg fails on the build before the fix.
 *
 * Every press is an XTEST key. Setup (opening, placing the caret through VMDE's caret authority)
 * never edits. Each press's selection, stage and the text-node lengths of the strong node are
 * logged under `[task-620 ...]`, to show whether the empty text nodes still appear. Fixture text
 * stays out of failure output except the short heads of the selections.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { FIXTURE as LARGE } from './find-replace-fixture-helpers'
import {
  actionsSince,
  type Ctx,
  closeAll,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  expectHost,
  hostState,
  makeKit,
  openDocument,
  report,
  select,
  selection,
  spyMark,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const TAG = 'task-620'
const FIXTURE_TEXT = readFileSync(
  path.join(__dirname, 'fixtures', 'expand-selection-first-keys.md'),
  'utf8',
)
const INLINE_TOKEN = 'bold scope'
const CELL_INLINE_TOKEN = 'cellbold'
// The large synthetic fixture (S3): a bold span of 20 characters in a prose paragraph.
const LARGE_TOKEN = 'Tllwmntrlw'
const LARGE_INLINE = 'Tllwmntrlw wgsbwrlw.'

type Stage = 'inline' | 'cell' | 'block' | 'document' | string

// The text-node lengths of the strong node holding `token`, and the undo/redo stack lengths.
function strongTextNodesInPage(_body: Element, token: string): number[] | null {
  const strong = Array.from(
    document.querySelectorAll('.vditor-ir__node[data-type="strong"]'),
  ).find((node) => (node.textContent ?? '').includes(token))
  if (!strong) return null
  const lengths: number[] = []
  const walker = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    lengths.push((node as Text).data.length)
  return lengths
}

function undoStacksInPage() {
  const inner = (window as any).vditor.vditor
  const history = inner.undo?.[inner.currentMode]
  return {
    undo: (history?.undoStack?.length ?? -1) as number,
    redo: (history?.redoStack?.length ?? -1) as number,
  }
}

const strongTextNodes = (ctx: Ctx, token: string) =>
  evalFrame(ctx.kit, strongTextNodesInPage, token)
const undoStacks = (ctx: Ctx) => evalFrame(ctx.kit, undoStacksInPage, 0)

// Classifies the selection by its text, never by its length alone.
function classify(
  current: Awaited<ReturnType<typeof selection>>,
  large: boolean,
): Stage {
  if (current.whole) return 'document'
  const head = current.head
  if (large) {
    if (head === LARGE_INLINE) return 'inline'
    return current.length > LARGE_INLINE.length && head.includes(LARGE_TOKEN)
      ? 'block'
      : `other:${head}`
  }
  if (head === INLINE_TOKEN || head === CELL_INLINE_TOKEN) return 'inline'
  const paragraph = head.includes('alpha') && head.includes('omega')
  const table = head.includes('Name') && head.includes('plain')
  // The table text also holds the cell text, so the table block is classified first.
  if (paragraph || table) return 'block'
  // IR shows the strong markers as text while the caret is in the node: the cell reads
  // `**cellbold** word`.
  const plain = head.replaceAll('*', '')
  if (plain.includes(CELL_INLINE_TOKEN) && plain.includes('word')) return 'cell'
  return `other:${head}`
}

// Presses Expand Selection once per expected stage, each a single routed action, and records what
// every press selected.
async function ladder(
  ctx: Ctx,
  name: string,
  token: string,
  offset: number,
  strongToken: string,
  expected: Stage[],
  settleMs = 300,
) {
  const { kit } = ctx
  await select(ctx, token, { collapsed: true, offset })
  await endSelectionGesture(ctx)
  const before = await strongTextNodes(ctx, strongToken)
  const mark = await spyMark(kit)
  const stages: Stage[] = []
  const presses: Record<string, unknown>[] = []
  for (let press = 1; press <= expected.length; press++) {
    await kit.xtest.key('shift+alt+Right')
    await expect
      .poll(async () => (await actionsSince(kit, mark)).length, {
        message: `${name}: press ${press} delivers one Expand Selection action`,
      })
      .toBe(press)
    await kit.workbox.waitForTimeout(settleMs) // the runner's selection lands after its message
    const current = await selection(ctx)
    const stage = classify(current, ctx.large)
    stages.push(stage)
    presses.push({
      press,
      stage,
      length: current.length,
      head: current.head,
      collapsed: current.collapsed,
      inSurface: current.inSurface,
      whole: current.whole,
      strongTextNodes: await strongTextNodes(ctx, strongToken),
    })
  }
  console.log(
    `[${TAG} ${ctx.file.split(path.sep).pop()}] ${name} ${JSON.stringify({ before, presses })}`,
  )
  ctx.results.push({ id: `ladder:${name}`, ok: true, before, presses })
  expect(
    (await actionsSince(kit, mark)).map((message) => message.detail),
    `${name}: every press is one expand-selection action`,
  ).toEqual(expected.map(() => 'expand-selection'))
  expect(stages, `${name}: stages ${JSON.stringify(presses)}`).toEqual(expected)
}

const paragraphLadder = (ctx: Ctx) =>
  ladder(ctx, 'paragraph', INLINE_TOKEN, 3, INLINE_TOKEN, [
    'inline',
    'block',
    'document',
  ])
const cellLadder = (ctx: Ctx) =>
  ladder(ctx, 'cell', CELL_INLINE_TOKEN, 3, CELL_INLINE_TOKEN, [
    'inline',
    'cell',
    'block',
    'document',
  ])

async function expectUntouched(ctx: Ctx, expected: string, label: string) {
  await expectHost(ctx, expected, `${label}: host text`)
  expect((await hostState(ctx)).dirty, `${label}: dirty flag`).toBe(
    expected !== ctx.initial,
  )
}

test.describe('Task 620 IR Expand Selection on the first keys (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('S1: freshly opened document, no edit: paragraph and cell ladders widen, host exact and clean', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const ctx = await openDocument(
      kit,
      'expand-first-keys-s1.md',
      FIXTURE_TEXT,
      'ir',
    )
    try {
      await waitForInitialUndoSnapshot(kit.frame())
      const stacks = await undoStacks(ctx)
      console.log(`[${TAG} s1] undo stacks at start ${JSON.stringify(stacks)}`)
      ctx.results.push({ id: 'ir:s1-undo-start', ok: true, ...stacks })
      expect(stacks.redo, 'redo stack empty on a fresh document').toBe(0)
      // The Task 598 baseline: one entry. A different length is recorded, not failed.
      if (stacks.undo !== 1)
        console.log(`[${TAG} s1] NOTE undo stack length ${stacks.undo}, not 1`)

      // The cell ladder runs last: its outcome must not hide the paragraph evidence.
      await paragraphLadder(ctx)
      await expectUntouched(ctx, ctx.initial, 'after the paragraph ladder')
      const after = await undoStacks(ctx)
      console.log(`[${TAG} s1] undo stacks at end ${JSON.stringify(after)}`)
      ctx.results.push({ id: 'ir:s1-undo-end', ok: true, ...after })
      expect(after, 'the ladder does not change the undo history').toEqual(
        stacks,
      )
      await cellLadder(ctx)
      await expectUntouched(ctx, ctx.initial, 'after the cell ladder')
      expect(
        await undoStacks(ctx),
        'the cell ladder does not change the undo history',
      ).toEqual(stacks)
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    report('S1', ctx.results, TAG)
  })

  test('S2: after one typed character: ladders and Select All are unchanged, host keeps the edit', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const ctx = await openDocument(
      kit,
      'expand-first-keys-s2.md',
      FIXTURE_TEXT,
      'ir',
    )
    try {
      await waitForInitialUndoSnapshot(kit.frame())
      await select(ctx, 'final paragraph', { collapsed: true, offset: 15 })
      await endSelectionGesture(ctx)
      await kit.xtest.type('q', 20)
      const edited = FIXTURE_TEXT.replace(
        'final paragraph\n',
        'final paragraphq\n',
      )
      expect(edited, 'the edit changes the fixture').not.toBe(FIXTURE_TEXT)
      await expectHost(ctx, edited, 'typed q reaches the host')
      await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
      const stacks = await undoStacks(ctx)
      console.log(
        `[${TAG} s2] undo stacks after the edit ${JSON.stringify(stacks)}`,
      )
      ctx.results.push({ id: 'ir:s2-undo-after-edit', ok: true, ...stacks })
      expect(stacks.undo, 'the edit is an undo step').toBeGreaterThanOrEqual(2)

      await paragraphLadder(ctx)
      await expectUntouched(ctx, edited, 'after the paragraph ladder')

      // Select All: block, then the whole document.
      await select(ctx, 'alpha', { collapsed: true, offset: 2 })
      await endSelectionGesture(ctx)
      await kit.xtest.key('ctrl+a')
      await kit.workbox.waitForTimeout(300)
      const first = await selection(ctx)
      console.log(`[${TAG} s2] ctrl+a #1 ${JSON.stringify(first)}`)
      expect(first.whole, 'first Ctrl+A is not the whole document').toBe(false)
      expect(first.head, 'first Ctrl+A selects the paragraph').toContain(
        'omega',
      )
      await kit.xtest.key('ctrl+a')
      await kit.workbox.waitForTimeout(300)
      const second = await selection(ctx)
      console.log(`[${TAG} s2] ctrl+a #2 ${JSON.stringify(second)}`)
      expect(second.whole, 'second Ctrl+A selects the whole document').toBe(
        true,
      )
      ctx.results.push({ id: 'ir:s2-select-all', ok: true, first, second })
      await expectUntouched(ctx, edited, 'after Select All')

      // Last, so its outcome does not hide the evidence above.
      await cellLadder(ctx)
      await expectUntouched(ctx, edited, 'after the cell ladder')
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    report('S2', ctx.results, TAG)
  })

  // The small fixture above never shows Vditor's empty text nodes (both builds keep [2,10,2]); the
  // large synthetic fixture does from the first press, and is where the Task 580 CP4-1 classification
  // (3e5d5996^: inline, inline, inline) was measured. This is the leg that fails without the fix.
  test('S3: large fixture, freshly opened: Expand Selection widens with empty text nodes in the inline node', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      TAG,
    )
    const ctx = await openDocument(kit, 'expand-first-keys-s3.md', LARGE, 'ir')
    try {
      await waitForInitialUndoSnapshot(kit.frame())
      await ladder(
        ctx,
        'large-paragraph',
        LARGE_TOKEN,
        3,
        LARGE_TOKEN,
        ['inline', 'block', 'document'],
        900,
      )
      await expectUntouched(ctx, ctx.initial, 'after the large ladder')
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
    report('S3', ctx.results, TAG)
  })
})
