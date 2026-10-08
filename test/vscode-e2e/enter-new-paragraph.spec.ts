/**
 * Tasks 625 + 627 — Enter at the end of a paragraph, heading, blockquote or the document opens a
 * new paragraph that takes the next typed character, in the real VS Code webview with OS-level
 * XTEST input (IR and WYSIWYG).
 *
 * Vditor's Enter leaves an empty `<p>` with the caret at offset 0. Its only line box is the
 * `p:empty::before` space under `white-space: pre-wrap`, which main.css's reflow rule
 * (`white-space: normal` on `p`/`li`) used to collapse. The paragraph then had height 0 and a
 * Shift-modified first key (XTEST `Y`, which is Shift+y) typed into a neighbouring block: the start
 * of the next block, or the end of the previous one when the paragraph was last. An unshifted key
 * masks the defect (Vditor's `fixCJKPosition` seeds a ZWSP on it), which is why the cells type `Y`.
 *
 * Each cell opens a fresh document, places the caret (the end of a block, or Ctrl+End in the empty
 * document), presses Enter, waits 100 ms and types `Y`, then checks:
 *   - the paragraph Enter added is empty and has a line box (height above 0);
 *   - the host text is exactly the expected one and `Y` is in the block that held the caret after
 *     Enter (not a neighbour);
 *   - Undo twice returns to the opened bytes, clean, with the opened block count.
 * The build before the fix fails the line-box and the `Y` checks in every paragraph and heading
 * cell. Fixture text is synthetic, so failure output may print the texts. The Chromium twin is
 * media-src/e2e/enter-empty-paragraph.spec.ts. Run with
 * `VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- enter-new-paragraph.spec.ts` inside the
 * isolated Xvfb/Openbox shell of docs/os-keyboard-testing-setup.md.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  closeAll,
  evalFrame,
  expectHost,
  expectRestored,
  firstLine,
  hostState,
  type Kit,
  leg,
  type Mode,
  makeKit,
  openDocument,
  report,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const TAG = 'Task 625/627 enter'
// Task 602's document: it round-trips exactly through every mode's serializer.
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const PREFIX = '# Probe\n\nAlpha bravo charlie delta.\n\n'
const LIMA = 'India juliet kilo lima.'

interface Case {
  id: string
  mode: Mode
  content: string
  /** Token whose end holds the caret; null = focus the editor, then Ctrl+End. */
  anchor: string | null
  /** Exact host text after Enter and `Y`. */
  expected: string
  /** Pause between Enter and `Y` in ms (default 100). */
  pause?: number
}

// The block holding the caret and the blocks holding `Y`, by top-level index in the active surface.
function readBlocks(_body: Element, ch: string) {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const topIndex = (start: Node | null) => {
    let node = start
    while (node && node.parentNode !== root) node = node.parentNode
    return node ? Array.prototype.indexOf.call(root.childNodes, node) : -1
  }
  const selection = getSelection()
  const anchor = selection?.rangeCount ? selection.anchorNode : null
  const element = anchor instanceof Element ? anchor : anchor?.parentElement
  const leaf = element?.closest('p, li, h1, h2, h3, h4, h5, h6')
  return {
    blocks: root.childNodes.length,
    caretTop: topIndex(anchor),
    leaf:
      leaf && root.contains(leaf)
        ? {
            tag: leaf.tagName.toLowerCase(),
            // Childless (the defect) or only a ZWSP seed (an empty document's leading paragraph).
            blank: (leaf.textContent ?? '').replaceAll('\u200b', '') === '',
            height: Math.round(leaf.getBoundingClientRect().height * 10) / 10,
          }
        : null,
    chTops: Array.from(root.childNodes)
      .map((node, index) =>
        (node.textContent ?? '').includes(ch) ? index : -1,
      )
      .filter((index) => index >= 0),
  }
}

function focusRoot() {
  const inner = (window as any).vditor.vditor
  ;(inner[inner.currentMode].element as HTMLElement).focus()
}

const read = (kit: Kit) => evalFrame(kit, readBlocks, 'Y')

// One cell: Enter at the caret, `Y` 100 ms later, then Undo twice. Checks are collected so one run
// shows every failed fact of the cell.
async function enterCell(ctx: Ctx, c: Case) {
  const { kit } = ctx
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what)
  }
  await waitForInitialUndoSnapshot(kit.frame())
  if (c.anchor)
    await select(ctx, c.anchor, { collapsed: true, offset: c.anchor.length })
  else {
    await evalFrame(kit, focusRoot, 0)
    await kit.xtest.key('ctrl+End')
    await kit.workbox.waitForTimeout(300)
  }
  const before = await read(kit)
  await kit.xtest.key('Return')
  await kit.workbox.waitForTimeout(c.pause ?? 100)
  const entered = await read(kit)
  console.log(`[${TAG}] ${c.id} after Enter ${JSON.stringify(entered)}`)
  check(
    entered.leaf?.tag === 'p' && entered.leaf.blank,
    'Enter leaves the caret in an empty paragraph',
  )
  check(
    (entered.leaf?.height ?? 0) > 0,
    `the empty paragraph has a line box (height ${entered.leaf?.height})`,
  )
  await kit.xtest.type('Y')
  try {
    await expectHost(ctx, c.expected, `${c.id}: host text with Y`)
  } catch (error) {
    problems.push(firstLine(error))
  }
  const typed = await read(kit)
  console.log(`[${TAG}] ${c.id} after Y ${JSON.stringify(typed)}`)
  check(
    typed.chTops.length === 1 && typed.chTops[0] === entered.caretTop,
    `Y is in the block that held the caret (block ${entered.caretTop}); it is in ${JSON.stringify(typed.chTops)}`,
  )
  // Vditor moves an edit into its undo stack 800 ms after it: wait before the first Undo.
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  for (const step of [1, 2]) {
    await kit.xtest.key('ctrl+z')
    try {
      await expectRestored(
        ctx,
        `${c.id}: Undo ${step} reaches the opened bytes`,
      )
    } catch (error) {
      problems.push(firstLine(error))
    }
    check(
      (await hostState(ctx)).dirty === false,
      `Undo ${step}: the host is clean`,
    )
  }
  try {
    await expect
      .poll(async () => (await read(kit)).blocks, { timeout: 5000 })
      .toBe(before.blocks)
  } catch {
    problems.push(
      `Undo twice returns the ${before.blocks} opened blocks; the view has ${(await read(kit)).blocks}`,
    )
  }
  expect(problems.join(' | '), `${c.id}: failed checks`).toBe('')
  return { enteredLeaf: entered.leaf, yBlocks: typed.chTops }
}

const kind = (
  mode: Mode,
  id: string,
  block: string,
  anchor: string | null,
  lf = true,
) => ({
  mode,
  id,
  anchor,
  content: `${PREFIX}${block}${lf ? '\n' : ''}`,
})
const casesFor = (mode: Mode): Case[] => [
  {
    ...kind(mode, 'paragraph-lf', LIMA, 'lima.'),
    expected: `${PREFIX}${LIMA}\n\nY\n`,
  },
  {
    ...kind(mode, 'paragraph-nolf', LIMA, 'lima.', false),
    expected: `${PREFIX}${LIMA}\n\nY`,
  },
  {
    ...kind(mode, 'heading', '## Echo foxtrot', 'foxtrot'),
    expected: `${PREFIX}## Echo foxtrot\n\nY\n`,
  },
  {
    ...kind(mode, 'blockquote', '> Echo foxtrot golf.', 'golf.'),
    expected: `${PREFIX}> Echo foxtrot golf.\n>\n> Y\n`,
  },
  { mode, id: 'empty', content: '', anchor: null, expected: 'Y\n' },
]
const MIDDLE: Case = {
  mode: 'ir',
  id: '625-middle',
  content: DOC,
  anchor: 'delta.',
  expected: DOC.replace('delta.\n\n', 'delta.\n\nY\n\n'),
}
const LAST: Case = {
  mode: 'ir',
  id: '625-last',
  content: DOC,
  anchor: 'lima.',
  expected: DOC.replace(/lima\.\n$/, 'lima.\n\nY\n'),
}

test.describe('Tasks 625/627 Enter opens a paragraph that takes the next key (OS-level XTEST)', () => {
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

  const run = async (
    fixtures: {
      workbox: unknown
      electronApp: Parameters<typeof makeKit>[1]
      evaluateInVSCode: unknown
      baseDir: string
    },
    label: string,
    cases: Case[],
  ) => {
    const kit = await makeKit(
      fixtures.workbox,
      fixtures.electronApp,
      fixtures.evaluateInVSCode,
      fixtures.baseDir,
      TAG,
    )
    // The first open of a session is slower and can differ; run none of the cells on it.
    const warm = await openDocument(kit, 'enter-warm-up.md', DOC, cases[0].mode)
    await waitForInitialUndoSnapshot(kit.frame())
    await closeAll(kit, warm.file)
    const results: Record<string, unknown>[] = []
    for (const [index, c] of cases.entries()) {
      const ctx = await openDocument(
        kit,
        `enter-${index}-${c.mode}-${c.id}.md`,
        c.content,
        c.mode,
      )
      try {
        await leg(ctx, c.id, () => enterCell(ctx, c))
      } finally {
        results.push(...ctx.results)
        await closeAll(kit, ctx.file).catch(() => undefined)
      }
    }
    report(label, results, TAG)
  }

  test('IR: Enter at a middle and the last paragraph, then the document-end kinds', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await run({ workbox, electronApp, evaluateInVSCode, baseDir }, 'IR', [
      MIDDLE,
      LAST,
      { ...MIDDLE, id: '625-middle-1000ms', pause: 1000 },
      { ...LAST, id: '625-last-1000ms', pause: 1000 },
      ...casesFor('ir'),
    ])
  })

  test('WYSIWYG: Enter at the document end by last-block kind', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await run(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'WYSIWYG',
      casesFor('wysiwyg'),
    )
  })
})
