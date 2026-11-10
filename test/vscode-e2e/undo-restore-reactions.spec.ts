/**
 * Task 720 Part 2b — the VMDE reactions to an Undo/Redo restore, in the real VS Code webview with
 * OS-level XTEST keys.
 *
 * Vditor restores a history step by replacing the whole editor root (`renderDiff`). Three VMDE
 * reactions to that rebuild moved the page (measured by the Task 720 probe):
 * 1. On a document of 100 KB or more, off-screen blocks skip rendering (`content-visibility`, main.css)
 *    and the rebuilt blocks have no remembered size yet. The caret restore measured the caret against
 *    those placeholder sizes and scrolled the edited paragraph ~330 px.
 * 2. The responsive-table width cache kept widths only when one table replaced one table, so a
 *    rebuild of several tables dropped every table's content-aware column widths for a few frames.
 * 3. In WYSIWYG, Undo put the caret at the document start, inside the front matter, which then
 *    showed its YAML source and moved the page 54 px.
 *
 * Each test samples every animation frame from just before the history key until the page is quiet
 * and asserts the geometry the user sees. Fixture text stays out of the output.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

type Mode = 'ir' | 'wysiwyg'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type Host = (fn: unknown, args: string[]) => Promise<unknown>

const TYPED = 'qzx'
const ROOT: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
}

// --- Fixtures ---

const filler = (label: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `${label} paragraph ${i} with enough words to wrap across the editor line once or twice in the pane.`,
  ).flatMap((p) => [p, ''])

const SMALL = [
  '---',
  'title: Undo reactions',
  'tags: [undo, restore]',
  '---',
  '',
  '# Undo reactions',
  '',
  ...filler('Opening', 3),
  'The middle paragraph MIDPARA is where the caret goes for the edit.',
  '',
  ...filler('Closing', 3),
].join('\n')

// Three tables with content of different widths, so their content-aware column widths differ from
// equal widths; a paragraph between the first two and a cell in the second are the edit sites.
const TABLES = [
  '# Tables',
  '',
  '| Name | Description | N |',
  '| ---- | ----------- | - |',
  '| alpha | a long description that needs most of the table width to fit | 1 |',
  '| bravo | short | 2 |',
  '',
  'The paragraph TABLEPARA sits between the first two tables.',
  '',
  '| Key | Value |',
  '| --- | ----- |',
  '| cellbeta | a value |',
  '| k2 | another value that is a little longer than the first |',
  '',
  '| Wide header column | B | C | D |',
  '| ------------------ | - | - | - |',
  '| x | y | z | a longer final column value |',
  '',
  'A closing paragraph after the tables.',
].join('\n')

// The probe's large-document shape: units of paragraphs, a table, a code block and a list until the
// document passes the 100 000-character content-visibility band (boot/vditor-init.ts). Unit 40
// holds the edit paragraph DEEPPARA.
const largeUnit = (k: number) =>
  [
    `## Unit ${k}`,
    '',
    ...Array.from(
      { length: 4 },
      (_, i) =>
        `Unit ${k} paragraph ${i} with \`inline code ${k}\` and **bold** words, long enough to wrap across the editor line at least once.`,
    ).flatMap((p) => [p, '']),
    '| Key | Value |',
    '| --- | ----- |',
    `| unit${k}a | \`code\` value ${k} |`,
    `| unit${k}b | plain value ${k} |`,
    '',
    '```js',
    `const unit${k} = ${k} * 2`,
    '```',
    '',
    `- unit ${k} item one`,
    `- unit ${k} item two`,
    '',
    ...(k === 40
      ? [
          'The deep paragraph DEEPPARA is the edit site of the large-document test.',
          '',
        ]
      : []),
  ].join('\n')

const LARGE = (() => {
  const parts = [SMALL]
  for (let k = 1; parts.join('\n\n').length < 110_000; k++)
    parts.push(largeUnit(k))
  return parts.join('\n\n')
})()

// --- In-page code (self-contained; runs inside the webview) ---

interface SampleOptions {
  needle: string
  tables: boolean
  blocks: boolean
}

// Starts a per-frame sampler: scrollTop, the needle's line top, the caret line top, the first-row
// cell widths of every table, the tops of the top-level blocks and the front-matter state.
function startSampler(_body: Element, options: SampleOptions) {
  const w = window as any
  const root = (): HTMLElement =>
    w.vditor.vditor[w.vditor.vditor.currentMode].element
  const scroller = (): HTMLElement => {
    let el: HTMLElement | null = root()
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if (/auto|scroll/.test(oy) && el.scrollHeight > el.clientHeight) return el
      el = el.parentElement
    }
    return document.scrollingElement as HTMLElement
  }
  const needleTop = () => {
    const walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent?.indexOf(options.needle) ?? -1
      if (i < 0) continue
      const range = document.createRange()
      range.setStart(n, i)
      range.setEnd(n, i + options.needle.length)
      const rect = range.getBoundingClientRect()
      if (rect.height > 0) return Math.round(rect.top * 10) / 10
    }
    return null
  }
  const caretTop = () => {
    const selection = getSelection()
    if (!selection?.rangeCount) return null
    const rects = selection.getRangeAt(0).getClientRects()
    return rects.length ? Math.round(rects[0].top * 10) / 10 : null
  }
  const tables = () =>
    Array.from(root().querySelectorAll('table'), (table) =>
      Array.from(
        table.rows[0]?.cells ?? [],
        (cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10,
      ),
    )
  const blocks = () =>
    Array.from(
      root().children,
      (block) => Math.round(block.getBoundingClientRect().top * 10) / 10,
    )
  const frontMatter = () => {
    const block = root().querySelector('[data-type="yaml-front-matter"]')
    return block
      ? `${block.getAttribute('data-vmde-front-matter')}|${block.hasAttribute('data-vmde-front-matter-editing') ? 'editing' : 'view'}`
      : null
  }
  const sample = () => ({
    scrollTop: Math.round(scroller().scrollTop * 10) / 10,
    needle: needleTop(),
    caret: caretTop(),
    tables: options.tables ? tables() : [],
    blocks: options.blocks ? blocks() : [],
    frontMatter: frontMatter(),
  })
  const state = { frames: [] as unknown[], running: true, first: root() }
  w.__t720 = state
  const bridge = w.__vmdeUndoRestoreCaret
  w.__t720restores ??= 0
  if (bridge && !bridge.__t720) {
    const restore = bridge.restore
    bridge.restore = (capture: unknown) => {
      w.__t720restores++
      return restore(capture)
    }
    bridge.__t720 = true
  }
  const before = sample()
  // Each frame is read in a task right after its rendering update, so a read never forces a layout
  // ahead of the update (in a content-visibility document such a layout gives freshly rebuilt
  // blocks their placeholder size, which the update itself corrects before painting).
  const tick = () => {
    if (!state.running) return
    setTimeout(() => {
      if (!state.running) return
      state.frames.push(sample())
      requestAnimationFrame(tick)
    })
  }
  requestAnimationFrame(tick)
  return before
}

function stopSampler() {
  const w = window as any
  w.__t720.running = false
  return { frames: w.__t720.frames, restores: w.__t720restores }
}

// The text of the caret's paragraph from its start to the caret.
function caretPrefix(): string | null {
  const selection = getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed) return null
  const node = selection.focusNode
  const el = node?.nodeType === 1 ? (node as Element) : node?.parentElement
  const block = el?.closest('p, li, td, th, h1, h2, h3, h4, h5, h6')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(node as Node, selection.focusOffset)
  return range.toString()
}

function needlePoint(_body: Element, needle: string) {
  const w = window as any
  const root = w.vditor.vditor[w.vditor.vditor.currentMode]
    .element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.textContent?.indexOf(needle) ?? -1
    if (i < 0) continue
    const range = document.createRange()
    range.setStart(n, i + needle.length - 1)
    range.setEnd(n, i + needle.length)
    const rect = range.getBoundingClientRect()
    if (rect.height === 0) continue
    const base = root.getBoundingClientRect()
    return {
      x: rect.right - base.left - 1,
      y: rect.top + rect.height / 2 - base.top,
      visible: rect.top > 10 && rect.bottom < root.clientHeight - 10,
    }
  }
  return null
}

function scrollNeedle(_body: Element, needle: string) {
  const w = window as any
  const root = w.vditor.vditor[w.vditor.vditor.currentMode]
    .element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n.textContent?.includes(needle)) {
      n.parentElement?.scrollIntoView({ block: 'center' })
      return true
    }
  return false
}

const documentHas = (frame: Frame, needle: string) =>
  frame
    .locator('body')
    .evaluate(
      (_b, n) =>
        ((window as any).vditor.getValue() as string).includes(n as string),
      needle,
    ) as Promise<boolean>

const pause = (frame: Frame, ms: number) =>
  frame
    .locator('body')
    .evaluate((_b, d) => new Promise((r) => setTimeout(r, d as number)), ms)

// --- Test-side helpers ---

interface Session {
  xtest: XtestInput
  host: Host
  workbox: Page
  baseDir: string
}

// Opens the document in IR (the default mode) and, for WYSIWYG, switches with the toolbar, the
// way the Task 720 probe measured the WYSIWYG fallback: the switch leaves the caret at the document
// start, inside the front matter, and the first undo snapshot records it there.
async function openDoc(
  s: Session,
  name: string,
  content: string,
  mode: Mode,
): Promise<Frame> {
  const file = path.join(s.baseDir, `${name}.md`)
  writeFileSync(file, content)
  const frame = await reopenVmdeFixture(
    s.host as never,
    s.workbox,
    file,
    90_000,
    '.vditor-ir',
  )
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: `${name} readiness` },
  )
  if (mode === 'wysiwyg') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="wysiwyg"]').click()
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === mode,
      { timeout: 60_000, message: `${name} ${mode} readiness` },
    )
  }
  await waitForInitialUndoSnapshot(frame)
  await pause(frame, 1500)
  // The first XTEST Ctrl chord of a session sometimes never reaches the webview
  // (undo-first-edit.spec.ts); send one to the untouched document first.
  await s.xtest.key('ctrl+z')
  await pause(frame, 800)
  return frame
}

// Scrolls the needle into the view (again while a content-visibility document settles) and clicks
// just before its last character's right edge, so the caret lands at the needle's end.
async function clickNeedle(frame: Frame, mode: Mode, needle: string) {
  let point: Awaited<ReturnType<typeof needlePoint>> = null
  for (let i = 0; i < 10; i++) {
    point = await frame.locator('body').evaluate(needlePoint, needle)
    if (point?.visible) break
    await frame.locator('body').evaluate(scrollNeedle, needle)
    await pause(frame, 400)
  }
  expect(point?.visible, `${needle} is in view`).toBe(true)
  await frame
    .locator(ROOT[mode])
    .first()
    .click({ position: { x: point?.x ?? 0, y: point?.y ?? 0 } })
  await pause(frame, 300)
}

interface Sampled {
  before: ReturnType<typeof startSampler>
  frames: ReturnType<typeof startSampler>[]
  restores: number
  prefix: string | null
}

// Sends one history key with the sampler running; returns once the text is (un)done and the page
// has been quiet for `settleMs`.
async function historyKey(
  s: Session,
  frame: Frame,
  key: string,
  options: SampleOptions,
  expectTyped: boolean,
  settleMs: number,
): Promise<Sampled> {
  const before = await frame.locator('body').evaluate(startSampler, options)
  await s.xtest.key(key)
  await expect
    .poll(() => documentHas(frame, TYPED), { timeout: 20_000 })
    .toBe(expectTyped)
  await pause(frame, settleMs)
  const { frames, restores } = await frame.locator('body').evaluate(stopSampler)
  const prefix = await frame.locator('body').evaluate(caretPrefix)
  return { before, frames, restores, prefix }
}

const maxDelta = (values: (number | null)[], base: number | null) =>
  base === null
    ? Number.NaN
    : Math.max(
        0,
        ...values.map((v) => (v === null ? Infinity : Math.abs(v - base))),
      )

/** The largest column-width change of each table over every frame (NaN for a changed shape). */
function tableDeltas(sampled: Sampled): number[] {
  return sampled.before.tables.map((cells, index) =>
    Math.max(
      0,
      ...sampled.frames.map((frame) => {
        const row = frame.tables[index]
        if (!row || row.length !== cells.length) return Number.NaN
        return Math.max(...row.map((w, i) => Math.abs(w - cells[i])))
      }),
    ),
  )
}

/** The largest top-level block top change over every frame (NaN for a changed block count). */
function blockDelta(sampled: Sampled): number {
  const base = sampled.before.blocks
  return Math.max(
    0,
    ...sampled.frames.map((frame) =>
      frame.blocks.length !== base.length
        ? Number.NaN
        : Math.max(0, ...frame.blocks.map((top, i) => Math.abs(top - base[i]))),
    ),
  )
}

function log(label: string, sampled: Sampled, extra: Record<string, unknown>) {
  console.log(
    `[Task 720 2b] ${label}`,
    JSON.stringify({
      frames: sampled.frames.length,
      restores: sampled.restores,
      scrollBefore: sampled.before.scrollTop,
      scrollAfter: sampled.frames.at(-1)?.scrollTop,
      scrollDelta: maxDelta(
        sampled.frames.map((f) => f.scrollTop),
        sampled.before.scrollTop,
      ),
      needleDelta: maxDelta(
        sampled.frames.map((f) => f.needle),
        sampled.before.needle,
      ),
      needleFinal:
        sampled.before.needle === null
          ? null
          : (sampled.frames.at(-1)?.needle ?? Number.NaN) -
            sampled.before.needle,
      // Consecutive distinct (scrollTop, needle) samples, to show how a movement develops.
      series: sampled.frames
        .map((f) => `${f.scrollTop}/${f.needle}`)
        .filter((v, i, all) => i === 0 || v !== all[i - 1])
        .slice(0, 12),
      frontMatter: [...new Set(sampled.frames.map((f) => f.frontMatter))],
      ...extra,
    }),
  )
}

async function session(
  workbox: Page,
  electronApp: Parameters<typeof createXtestInput>[0],
  evaluateInVSCode: unknown,
  baseDir: string,
): Promise<Session> {
  await (evaluateInVSCode as Host)(async (vscode: typeof import('vscode')) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
  }, [])
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  return { xtest, host: evaluateInVSCode as Host, workbox, baseDir }
}

// --- Tests ---

test.describe('Task 720 Undo/Redo restore reactions', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('large IR document: Undo and Redo of a deep paragraph edit keep the scroll position', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(420_000)
    expect(LARGE.length).toBeGreaterThan(100_000)
    const s = await session(workbox, electronApp, evaluateInVSCode, baseDir)
    const frame = await openDoc(s, 'undo-reactions-large', LARGE, 'ir')
    await clickNeedle(frame, 'ir', 'DEEPPARA')
    await s.xtest.type(TYPED)
    // Past the 2 s undoDelay of a document over 20 000 characters, so the edit is one record.
    await pause(frame, 2600)
    const options = { needle: 'DEEPPARA', tables: false, blocks: false }
    const undo = await historyKey(s, frame, 'ctrl+z', options, false, 2500)
    const undoScroll = maxDelta(
      undo.frames.map((f) => f.scrollTop),
      undo.before.scrollTop,
    )
    const undoNeedle = maxDelta(
      undo.frames.map((f) => f.needle),
      undo.before.needle,
    )
    log('large deep Undo', undo, {})
    await pause(frame, 1500)
    const redo = await historyKey(s, frame, 'ctrl+y', options, true, 2500)
    const redoScroll = maxDelta(
      redo.frames.map((f) => f.scrollTop),
      redo.before.scrollTop,
    )
    const redoNeedle = maxDelta(
      redo.frames.map((f) => f.needle),
      redo.before.needle,
    )
    log('large deep Redo', redo, {})
    expect(undo.prefix?.endsWith('DEEPPARA'), 'Undo caret at the change').toBe(
      true,
    )
    expect(undoScroll, 'Undo scrollTop change (px)').toBeLessThanOrEqual(2)
    expect(undoNeedle, 'Undo edit line movement (px)').toBeLessThanOrEqual(2)
    expect(
      redo.prefix?.endsWith(`DEEPPARA${TYPED}`),
      'Redo caret at the change end',
    ).toBe(true)
    expect(redoScroll, 'Redo scrollTop change (px)').toBeLessThanOrEqual(2)
    expect(redoNeedle, 'Redo edit line movement (px)').toBeLessThanOrEqual(2)
  })

  test('IR tables: Undo and Redo keep every unedited table column width', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const s = await session(workbox, electronApp, evaluateInVSCode, baseDir)
    const frame = await openDoc(s, 'undo-reactions-tables', TABLES, 'ir')
    // Every table has its content-aware widths before the first edit.
    await expect
      .poll(
        () =>
          frame
            .locator('body')
            .evaluate(() =>
              Array.from(document.querySelectorAll('.vditor-ir table')).every(
                (t) =>
                  Array.from(t.classList).some((c) =>
                    c.startsWith('vmde-table-auto-'),
                  ),
              ),
            ),
        { timeout: 20_000 },
      )
      .toBe(true)
    const results: Record<string, number[]> = {}
    for (const [site, edited] of [
      ['TABLEPARA', -1],
      ['cellbeta', 1],
    ] as const) {
      await clickNeedle(frame, 'ir', site)
      await s.xtest.type(TYPED)
      await pause(frame, 1500)
      const options = { needle: site, tables: true, blocks: false }
      for (const [key, typed] of [
        ['ctrl+z', false],
        ['ctrl+y', true],
      ] as const) {
        const sampled = await historyKey(s, frame, key, options, typed, 1500)
        const deltas = tableDeltas(sampled)
        results[`${site} ${key}`] = deltas
        log(`tables ${site} ${key}`, sampled, { deltas, edited })
        await pause(frame, 800)
      }
      // Leave the document as it was opened.
      await s.xtest.key('ctrl+z')
      await expect
        .poll(() => documentHas(frame, TYPED), { timeout: 20_000 })
        .toBe(false)
      await pause(frame, 1200)
    }
    for (const [label, deltas] of Object.entries(results)) {
      const edited = label.startsWith('cellbeta') ? 1 : -1
      expect(deltas.length, `${label}: tables`).toBe(3)
      deltas.forEach((delta, index) => {
        if (index !== edited)
          expect(
            delta,
            `${label}: table ${index} column width change (px)`,
          ).toBeLessThanOrEqual(1)
      })
    }
  })

  test('WYSIWYG: Undo and Redo put the caret at the change and keep the front-matter table', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const s = await session(workbox, electronApp, evaluateInVSCode, baseDir)
    const frame = await openDoc(s, 'undo-reactions-wysiwyg', SMALL, 'wysiwyg')
    // The switch leaves the caret in the front matter (its source shows); the click moves it out.
    await clickNeedle(frame, 'wysiwyg', 'MIDPARA')
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              document
                .querySelector(
                  '.vditor-wysiwyg [data-type="yaml-front-matter"]',
                )
                ?.getAttribute('data-vmde-front-matter') ?? null,
          ),
      )
      .toBe('table')
    await s.xtest.type(TYPED)
    await pause(frame, 1500)
    const options = { needle: 'MIDPARA', tables: false, blocks: true }
    const undo = await historyKey(s, frame, 'ctrl+z', options, false, 1500)
    log('wysiwyg Undo', undo, { blockDelta: blockDelta(undo) })
    await pause(frame, 800)
    const redo = await historyKey(s, frame, 'ctrl+y', options, true, 1500)
    log('wysiwyg Redo', redo, { blockDelta: blockDelta(redo) })
    expect(undo.prefix?.endsWith('MIDPARA'), 'Undo caret at the change').toBe(
      true,
    )
    expect(
      redo.prefix?.endsWith(`MIDPARA${TYPED}`),
      'Redo caret at the change end',
    ).toBe(true)
    for (const [label, sampled] of [
      ['Undo', undo],
      ['Redo', redo],
    ] as const) {
      expect(
        [...new Set(sampled.frames.map((f) => f.frontMatter))],
        `${label}: front matter stays a table`,
      ).toEqual(['table|view'])
      expect(
        blockDelta(sampled),
        `${label}: page shift (px)`,
      ).toBeLessThanOrEqual(1)
    }
  })
})
