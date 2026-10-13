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
 * media-src/e2e/enter-empty-paragraph.spec.ts.
 *
 * Task 627 adds two more groups:
 *   - A document that ends in a fenced code block (IR, WYSIWYG, SV). Ctrl+End lands the caret in the
 *     block's rendered preview, outside the editable code; Enter must still stay a newline in the
 *     code, so `Y` is a code line of its own. A control starts from the code line end and must give the
 *     same text. Chromium twin: media-src/e2e/code-block-enter-preview-caret.spec.ts.
 *   - Enter alone (no typed key) at the end of a final paragraph: how many Undo steps return to the
 *     opened bytes and the opened block count. Run with
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
const CODE_TAG = 'Task 627 code-end'
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

// --- Task 627: a document that ends in a fenced code block, and Enter alone ---

const CODE_LINE = 'const echo = 1'
const CODE_DOC = `${PREFIX}\`\`\`js\n${CODE_LINE}\n\`\`\`\n`
// The task contract: Enter inside a fenced code block stays a newline in the code.
const CODE_EXPECTED = `${PREFIX}\`\`\`js\n${CODE_LINE}\nY\n\`\`\`\n`
const MAX_UNDO = 6

// The code block's rendered preview and its editable code, per mode.
const CODE_PARTS: Record<'ir' | 'wysiwyg', { preview: string; code: string }> =
  {
    ir: {
      preview: '.vditor-ir__node[data-type="code-block"] .vditor-ir__preview',
      code: 'pre.vditor-ir__marker--pre code',
    },
    wysiwyg: {
      preview:
        '.vditor-wysiwyg__block[data-type="code-block"] .vditor-wysiwyg__preview',
      code: '.vditor-wysiwyg__block[data-type="code-block"] > pre:not(.vditor-wysiwyg__preview) code',
    },
  }

// Where the selection sits: the editable code, the rendered preview, or elsewhere.
function caretPlace(
  _body: Element,
  parts: { preview: string; code: string },
): string {
  const node = getSelection()?.anchorNode ?? null
  const element = node instanceof Element ? node : node?.parentElement
  if (!element) return 'none'
  if (element.closest(parts.code)) return 'editable-code'
  if (element.closest(parts.preview)) return 'preview'
  return `other:${element.tagName.toLowerCase()}`
}

// A collapsed caret at the end of the code block's first line, registered with VMDE's caret
// authority like `selectInPage`. The WYSIWYG code is syntax highlighted, so its first line is split
// over several text nodes and a token search cannot place the caret.
async function placeAtCodeLineEnd(
  _body: Element,
  codeSelector: string,
): Promise<boolean> {
  const inner = (window as any).vditor.vditor
  const root = inner[inner.currentMode].element as HTMLElement
  const code = root.querySelector(codeSelector)
  if (!code) return false
  const text = code.textContent ?? ''
  const target = text.includes('\n') ? text.indexOf('\n') : text.length
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length
    if (seen + length < target) {
      seen += length
      continue
    }
    code.scrollIntoView({ block: 'center' })
    root.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(node, target - seen)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const requestCaret = (window as any).__vmdeRequestCaret
    if (typeof requestCaret === 'function')
      requestCaret({ node, offset: target - seen })
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const settled = getSelection()
    return Boolean(
      settled?.rangeCount &&
        settled.isCollapsed &&
        code.contains(settled.anchorNode),
    )
  }
  return false
}

// Presses Undo until `restored` holds and returns the number of presses (-1 after MAX_UNDO). After
// each press it waits up to 2 s for the host to reach the restored state, so a late host sync never
// counts as one more step.
async function undoUntil(
  ctx: Ctx,
  restored: () => Promise<boolean>,
  trail: string[],
): Promise<number> {
  const { kit } = ctx
  for (let step = 1; step <= MAX_UNDO; step++) {
    await kit.xtest.key('ctrl+z')
    const deadline = Date.now() + 2000
    let done = await restored()
    while (!done && Date.now() < deadline) {
      await kit.workbox.waitForTimeout(100)
      done = await restored()
    }
    const host = await hostState(ctx)
    trail.push(
      `undo${step}:${host.text === ctx.initial ? 'opened' : 'edited'}:${host.dirty ? 'dirty' : 'clean'}`,
    )
    if (done) return step
  }
  return -1
}

const hostOpened = async (ctx: Ctx) => {
  const host = await hostState(ctx)
  return host.text === ctx.initial && host.dirty === false
}

interface CodeLeg {
  id: string
  mode: Mode
  /** ctrlEnd: focus, then Ctrl+End (lands in the preview); lineEnd: caret at the code line end. */
  route: 'ctrlEnd' | 'lineEnd'
  /** Exact host text after Enter and `Y`. */
  expected: string
  content: string
  /**
   * Undo presses back to the opened bytes (ir / wysiwyg). The Enter-to-`Y` pause must then pass
   * Vditor's 800 ms undo delay: inside it the two edits merge into one step in some runs and not
   * in others (measured 1 or 2 presses at a 100 ms pause), outside it they are always two.
   */
  undos?: number
}

type CodeParts = (typeof CODE_PARTS)['ir'] | null

// Places the caret for a code-block leg: Ctrl+End (lands in the preview) or the code line end.
async function placeCodeCaret(ctx: Ctx, c: CodeLeg, parts: CodeParts) {
  const { kit } = ctx
  if (c.route === 'ctrlEnd') {
    await evalFrame(kit, focusRoot, 0)
    await kit.xtest.key('ctrl+End')
    await kit.workbox.waitForTimeout(300)
  } else if (parts)
    expect(
      await evalFrame(kit, placeAtCodeLineEnd, parts.code),
      `${ctx.mode}: caret at the code line end`,
    ).toBe(true)
  else
    await select(ctx, CODE_LINE, { collapsed: true, offset: CODE_LINE.length })
}

// Where the caret is ('sv' has no preview / editable-code distinction).
const caretWhere = (kit: Kit, parts: CodeParts) =>
  parts ? evalFrame(kit, caretPlace, parts) : Promise.resolve('sv')

// One cell: place the caret, Enter, `Y`, then Undo until the opened bytes. Checks are collected so
// one run shows every failed fact of the cell.
async function codeEndCell(ctx: Ctx, c: CodeLeg) {
  const { kit } = ctx
  const parts: CodeParts = ctx.mode === 'sv' ? null : CODE_PARTS[ctx.mode]
  const problems: string[] = []
  const trail: string[] = []
  const inCode = (when: string, where: string) => {
    if (parts && where !== 'editable-code')
      problems.push(
        `the caret is in the editable code ${when}; it is in ${where}`,
      )
  }
  await waitForInitialUndoSnapshot(kit.frame())
  await placeCodeCaret(ctx, c, parts)
  const placed = await caretWhere(kit, parts)
  await kit.xtest.key('Return')
  await kit.workbox.waitForTimeout(c.undos === undefined ? 100 : UNDO_LOCK_MS)
  const entered = await caretWhere(kit, parts)
  console.log(
    `[${CODE_TAG}] ${ctx.mode}:${c.id} caret before Enter ${placed}, after Enter ${entered}`,
  )
  inCode('after Enter', entered)
  await kit.xtest.type('Y')
  try {
    await expectHost(ctx, c.expected, `${c.id}: host text with Y`)
  } catch (error) {
    problems.push(firstLine(error))
  }
  inCode('after Y', await caretWhere(kit, parts))
  let undos: number | undefined
  if (c.undos !== undefined) {
    // Vditor moves an edit into its undo stack 800 ms after it: wait before the first Undo.
    await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
    undos = await undoUntil(ctx, () => hostOpened(ctx), trail)
    console.log(
      `[${CODE_TAG}] ${ctx.mode}:${c.id} undo presses ${undos} ${trail.join(' ')}`,
    )
    if (undos !== c.undos)
      problems.push(
        `Undo presses back to the opened bytes: ${undos}, measured ${c.undos} (${trail.join(' ')})`,
      )
  }
  expect(problems.join(' | '), `${ctx.mode}:${c.id}: failed checks`).toBe('')
  return { placed, entered, undos, leavesEdit: c.undos === undefined }
}

// Enter alone (no typed key) at the end of a final paragraph: the Undo presses that return to the
// opened bytes and the opened block count.
async function enterAloneCell(ctx: Ctx, c: Case, undos: number) {
  const { kit } = ctx
  const trail: string[] = []
  await waitForInitialUndoSnapshot(kit.frame())
  await select(ctx, c.anchor as string, {
    collapsed: true,
    offset: (c.anchor as string).length,
  })
  const before = await read(kit)
  await kit.xtest.key('Return')
  await kit.workbox.waitForTimeout(100)
  const entered = await read(kit)
  // Whether Enter alone already changed the host (an empty trailing paragraph may not serialize).
  await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
  const afterEnter = await hostState(ctx)
  const presses = await undoUntil(
    ctx,
    async () =>
      (await hostOpened(ctx)) && (await read(kit)).blocks === before.blocks,
    trail,
  )
  console.log(
    `[${CODE_TAG}] ${ctx.mode}:${c.id} Enter alone: blocks ${before.blocks} -> ${entered.blocks}, host changed ${afterEnter.text !== ctx.initial}, dirty ${afterEnter.dirty}, undo presses ${presses} ${trail.join(' ')}`,
  )
  expect(entered.blocks, `${c.id}: Enter adds one block`).toBe(
    before.blocks + 1,
  )
  expect(
    presses,
    `${c.id}: Undo presses back to the opened bytes and blocks`,
  ).toBe(undos)
  return { undos: presses }
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

  const run = async <T extends { id: string; mode: Mode; content: string }>(
    fixtures: {
      workbox: unknown
      electronApp: Parameters<typeof makeKit>[1]
      evaluateInVSCode: unknown
      baseDir: string
    },
    label: string,
    cases: T[],
    cell: (ctx: Ctx, c: T) => Promise<Record<string, unknown> | undefined>,
    tag: string,
  ) => {
    const kit = await makeKit(
      fixtures.workbox,
      fixtures.electronApp,
      fixtures.evaluateInVSCode,
      fixtures.baseDir,
      tag,
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
        await leg(ctx, c.id, () => cell(ctx, c))
      } finally {
        results.push(...ctx.results)
        await closeAll(kit, ctx.file).catch(() => undefined)
      }
    }
    report(label, results, tag)
  }

  test('IR: Enter at a middle and the last paragraph, then the document-end kinds', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await run(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'IR',
      [
        MIDDLE,
        LAST,
        { ...MIDDLE, id: '625-middle-1000ms', pause: 1000 },
        { ...LAST, id: '625-last-1000ms', pause: 1000 },
        ...casesFor('ir'),
      ],
      enterCell,
      TAG,
    )
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
      enterCell,
      TAG,
    )
  })

  const codeLegs = (mode: 'ir' | 'wysiwyg', undos: number): CodeLeg[] => [
    // Ctrl+End lands the caret in the rendered preview, outside the editable code.
    {
      id: 'code-ctrl-end',
      mode,
      route: 'ctrlEnd',
      expected: CODE_EXPECTED,
      undos,
      content: CODE_DOC,
    },
    // Control: a caret at the code line end gives the same text.
    {
      id: 'code-line-end',
      mode,
      route: 'lineEnd',
      expected: CODE_EXPECTED,
      undos,
      content: CODE_DOC,
    },
  ]

  for (const [mode, label, undos] of [
    ['ir', 'IR', 2],
    ['wysiwyg', 'WYSIWYG', 2],
  ] as const)
    test(`${label}: Enter at the end of a document that ends in a code block stays in the code`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(900_000)
      await run(
        { workbox, electronApp, evaluateInVSCode, baseDir },
        `${label} code block`,
        codeLegs(mode, undos),
        codeEndCell,
        CODE_TAG,
      )
    })

  test('SV: Enter at the end of a document that ends in a code block is a source newline', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    await run(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      'SV code block',
      [
        {
          id: 'code-ctrl-end',
          mode: 'sv' as const,
          route: 'ctrlEnd' as const,
          expected: `${CODE_DOC}\nY\n`,
          content: CODE_DOC,
        },
        {
          id: 'code-line-end',
          mode: 'sv' as const,
          route: 'lineEnd' as const,
          expected: CODE_EXPECTED,
          content: CODE_DOC,
        },
      ],
      codeEndCell,
      CODE_TAG,
    )
  })

  test('IR and WYSIWYG: Enter alone at the end of a final paragraph, Undo presses back to the opened bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(900_000)
    for (const mode of ['ir', 'wysiwyg'] as const)
      await run(
        { workbox, electronApp, evaluateInVSCode, baseDir },
        `${mode} Enter alone`,
        casesFor(mode).slice(0, 2),
        (ctx, c) => enterAloneCell(ctx, c, 1),
        CODE_TAG,
      )
  })
})
