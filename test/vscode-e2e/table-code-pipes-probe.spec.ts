import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// PROBE (task 704, Step 1) — records what IR, WYSIWYG, SV and Preview show for a table row whose
// code span holds unescaped pipes, and what reaches the disk after three kinds of edit. It asserts
// nothing about product behaviour: the matrix goes to `tmp/704/step1.json` for the task record.
// The only assertions are positive controls (the fixture opened, the table row was found, the
// typed character reached the TextDocument), so an empty matrix cannot pass as "no defect".
// @probe — excluded from the default run; run with `npm --prefix test/vscode-e2e run test:probes`.

const root = path.join(__dirname, '..', '..')
const OUT = path.join(root, 'tmp', '704', 'step1.json')
const dir = path.join(tmpdir(), `vmde-table-code-pipes-probe-${process.pid}`)
mkdirSync(dir, { recursive: true })
mkdirSync(path.dirname(OUT), { recursive: true })

const FIXTURE = path.join(__dirname, 'fixtures', 'table-code-pipes.md')
// Untracked and ignored: present only on the machine that holds the Owner's report.
const REPORT = path.join(root, 'tmp', 'pending-questions.md')

test.use({ baseDir: dir })

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'
type Evaluate = Parameters<typeof reopenVmdeFixture>[0]
type Edit = 'a' | 'b' | 'c'

const MODES: Mode[] = ['ir', 'wysiwyg', 'sv']
// (a) a character in an unrelated paragraph, (b) at the start of the I57 first cell, (c) at the
// start of the I56 first cell.
const EDITS: Record<Edit, string | null> = { a: null, b: 'I57', c: 'I56' }

const matrix: Record<string, unknown> = {}
let bootCount = 0

// Merge into the file on disk: a failed case restarts the worker, which would lose an in-memory
// matrix. Delete `tmp/704/step1.json` before a fresh run.
function record(pathKeys: string[], value: unknown) {
  if (existsSync(OUT))
    Object.assign(matrix, JSON.parse(readFileSync(OUT, 'utf8')))
  let node = matrix as Record<string, unknown>
  for (const key of pathKeys.slice(0, -1)) {
    node[key] ??= {}
    node = node[key] as Record<string, unknown>
  }
  node[pathKeys[pathKeys.length - 1]] = value
  writeFileSync(OUT, `${JSON.stringify(matrix, null, 2)}\n`)
}

function freshCopy(source: string): string {
  const target = path.join(dir, `case-${bootCount++}.md`)
  copyFileSync(source, target)
  return target
}

async function openFresh(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  source: string,
): Promise<{ frame: Frame; file: string }> {
  const file = freshCopy(source)
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    '.vditor-ir',
    // VS Code reopens in the remembered mode, so IR may not be the visible editor;
    // readiness below waits for whichever mode is active.
    false,
  )
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0, {
    message: 'the editor finished initialization',
  })
  return { frame, file }
}

async function switchMode(frame: Frame, mode: Mode) {
  if (mode === 'ir') return
  const before = await waitForE2EReadiness(frame, () => true)
  await frame.locator('body').evaluate((_b, m) => {
    const btn = document.querySelector(
      `.vditor-toolbar button[data-mode="${m}"]`,
    )
    if (!btn) throw new Error(`mode button not found: ${m}`)
    btn.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  }, mode)
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === mode,
    { message: `the editor reported ${mode} mode` },
  )
}

// What the pane shows for row I57 (and the SV source line).
function readDisplay(frame: Frame, scope: string) {
  return frame.locator('body').evaluate((_el, sel) => {
    const clean = (s: string | null | undefined) =>
      s === null || s === undefined ? null : s.replace(/​/g, '')
    if (sel === '.vditor-sv') {
      const text = document.querySelector('.vditor-sv')?.textContent ?? ''
      return {
        found: text.includes('| I57 |'),
        i57Line:
          clean(text.split('\n').find((l) => l.includes('| I57 |'))) ?? null,
      }
    }
    const rows = Array.from(
      document.querySelectorAll(`${sel} table tr`),
    ) as HTMLTableRowElement[]
    const i57 = rows.find((r) => r.cells[0]?.textContent?.trim() === 'I57')
    return {
      found: !!i57,
      cells: i57?.cells.length ?? null,
      cell3Code: clean(i57?.cells[2]?.querySelector('code')?.textContent),
      cell3Text: clean(i57?.cells[2]?.textContent),
      cell5Text: clean(i57?.cells[4]?.textContent),
    }
  }, scope)
}

async function placeCaret(frame: Frame, mode: Mode, id: string | null) {
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page search for the caret target across the TYPE-HERE paragraph, a table cell and the Source-mode text
    (_el, arg) => {
      const { pane, rowId, isSv } = arg as {
        pane: string
        rowId: string | null
        isSv: boolean
      }
      const rootEl = document.querySelector(pane) as HTMLElement | null
      if (!rootEl) throw new Error(`${pane} not found`)
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
      let target: { node: Text; offset: number } | null = null
      for (let n = walker.nextNode(); n && !target; n = walker.nextNode()) {
        const text = n.textContent ?? ''
        if (rowId === null) {
          // End of the first non-empty paragraph-like text outside any table (fixture: TYPE-HERE).
          const owner = (n.parentElement as HTMLElement | null)?.closest(
            'td,th,code,.vditor-ir__marker',
          )
          if (!owner && text.trim() && !text.trim().startsWith('|'))
            target = { node: n as Text, offset: text.length }
        } else if (isSv) {
          const at = text.indexOf(`| ${rowId} |`)
          if (at >= 0) target = { node: n as Text, offset: at + 2 }
        } else {
          const cell = (n.parentElement as HTMLElement | null)?.closest('td')
          if (
            cell &&
            cell === cell.parentElement?.firstElementChild &&
            text.replace(/​/g, '').trim() === rowId
          )
            target = { node: n as Text, offset: text.indexOf(rowId) }
        }
      }
      if (!target) throw new Error(`caret target ${String(rowId)} not found`)
      const range = document.createRange()
      range.setStart(target.node, target.offset)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      const editable = rootEl.matches('[contenteditable]')
        ? rootEl
        : (rootEl.querySelector(
            '[contenteditable="true"]',
          ) as HTMLElement | null)
      editable?.focus()
    },
    { pane: `.vditor-${mode}`, rowId: id, isSv: mode === 'sv' },
  )
}

const clip = (l: string) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)

// Every differing line, not only table lines (Task 704 byte-diff measure). Equal line counts pair
// by index; otherwise the lines missing on each side are listed by multiset difference.
function lineDifferences(srcLines: string[], savedLines: string[]) {
  if (srcLines.length === savedLines.length) {
    return {
      pairing: 'by-index',
      pairs: srcLines
        .map((source, index) => ({ index, source, saved: savedLines[index] }))
        .filter((row) => row.source !== row.saved)
        .map((row) => ({
          index: row.index,
          source: clip(row.source),
          saved: clip(row.saved),
        })),
    }
  }
  // The window between the common prefix and the common suffix: where the two texts really differ.
  let head = 0
  while (
    head < srcLines.length &&
    head < savedLines.length &&
    srcLines[head] === savedLines[head]
  )
    head++
  let tail = 0
  while (
    tail < srcLines.length - head &&
    tail < savedLines.length - head &&
    srcLines[srcLines.length - 1 - tail] ===
      savedLines[savedLines.length - 1 - tail]
  )
    tail++
  const window = {
    firstDifferingIndex: head,
    sourceWindow: srcLines.slice(head, srcLines.length - tail).map(clip),
    savedWindow: savedLines.slice(head, savedLines.length - tail).map(clip),
  }
  const missing = (from: string[], other: string[]) => {
    const counts = new Map<string, number>()
    for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1)
    return from
      .map((line, index) => ({ index, line }))
      .filter((row) => {
        const n = counts.get(row.line) ?? 0
        if (n > 0) counts.set(row.line, n - 1)
        return n === 0
      })
      .map((row) => ({ index: row.index, line: clip(row.line) }))
  }
  return {
    pairing: 'multiset',
    ...window,
    sourceLineCount: srcLines.length,
    savedLineCount: savedLines.length,
    onlyInSource: missing(srcLines, savedLines),
    onlyInSaved: missing(savedLines, srcLines),
  }
}

const countQ = (s: string) => (s.match(/Q/g) ?? []).length

// Compare the saved file with the source and describe what the edit did to the table lines.
function analyze(source: string, saved: string) {
  const srcLines = source.split('\n')
  const savedLines = saved.split('\n')
  const srcSet = new Set(srcLines)
  const differing = savedLines
    .map((line, index) => ({ index, line }))
    .filter((row) => row.line.startsWith('|') && !srcSet.has(row.line))
  const i57 = savedLines.find((l) => /^\|\s*I57\s*\|/.test(l))
  const padded = (l: string) => / {3,}\|/.test(l)
  return {
    diskBytes: Buffer.byteLength(saved),
    sourceBytes: Buffer.byteLength(source),
    deltaVsSourcePlusOne:
      Buffer.byteLength(saved) - (Buffer.byteLength(source) + 1),
    differingTableLines: differing.map((row) => ({
      index: row.index,
      text: row.line.length > 220 ? `${row.line.slice(0, 220)}…` : row.line,
    })),
    differingTableLineCount: differing.length,
    allDifferingLines: lineDifferences(srcLines, savedLines),
    i57Line: i57 ?? null,
    i57HasEnterAtAsync: i57?.includes('EnterAtAsync') ?? false,
    i57HasF11: i57?.includes('[F11]') ?? false,
    e1EscapeSurvives: saved.includes('`x \\| y`'),
    paddedRowsInSource: srcLines.filter(padded).length,
    paddedRowsInSaved: savedLines.filter(padded).length,
    paddedRowsNotInSource: savedLines.filter((l) => padded(l) && !srcSet.has(l))
      .length,
  }
}

async function editAndSave(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  source: string,
  mode: Mode,
  edit: Edit,
) {
  const { frame, file } = await openFresh(evaluateInVSCode, workbox, source)
  await switchMode(frame, mode)
  // Positive control: the table is on screen in this mode before the edit.
  const before = await readDisplay(frame, `.vditor-${mode}`)
  expect(before.found, `${mode}: the I57 row is on screen`).toBe(true)
  await placeCaret(frame, mode, EDITS[edit])
  await workbox.keyboard.type('Q', { delay: 40 })
  const sourceText = readFileSync(source, 'utf8')
  // Positive control: the keystroke reached the TextDocument.
  await expect
    .poll(
      async () =>
        countQ(await docText(evaluateInVSCode, file)) > countQ(sourceText),
      { message: `${mode}/${edit}: the typed character reached the document` },
    )
    .toBe(true)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as unknown as [string],
  )
  await expect
    .poll(() => countQ(readFileSync(file, 'utf8')) > countQ(sourceText), {
      message: `${mode}/${edit}: the save reached the disk`,
    })
    .toBe(true)
  return analyze(sourceText, readFileSync(file, 'utf8'))
}

async function probeSource(
  label: string,
  source: string,
  modes: Mode[],
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
) {
  for (const mode of modes) {
    const { frame } = await openFresh(evaluateInVSCode, workbox, source)
    await switchMode(frame, mode)
    const display = await readDisplay(frame, `.vditor-${mode}`)
    expect(display.found, `${label}/${mode}: the I57 row was found`).toBe(true)
    record([label, mode, 'display'], display)
    for (const edit of Object.keys(EDITS) as Edit[])
      record(
        [label, mode, 'edit', edit],
        await editAndSave(evaluateInVSCode, workbox, source, mode, edit),
      )
  }
}

for (const mode of MODES) {
  test(`probe: fixture display and edits in ${mode} @probe`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(600_000)
    await probeSource('fixture', FIXTURE, [mode], evaluateInVSCode, workbox)
  })
}

test('probe: Preview overlay shows row I57 @probe', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const { frame } = await openFresh(evaluateInVSCode, workbox, FIXTURE)
  await frame.locator('.vditor-toolbar [data-type="preview"]').first().click()
  await expect
    .poll(async () => (await readDisplay(frame, '.vditor-preview')).found, {
      message: 'the Preview table rendered',
    })
    .toBe(true)
  record(
    ['fixture', 'preview', 'display'],
    await readDisplay(frame, '.vditor-preview'),
  )
})

// The Owner's own file: the I57 row of the 5-column table 3, in a 67 KB document. It is untracked,
// so a machine without it skips with a visible reason instead of recording an empty case.
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`probe: tmp/pending-questions.md display and edits in ${mode} @probe`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.skip(
      !existsSync(REPORT),
      `skipped: ${REPORT} is absent (untracked file from the Owner's report)`,
    )
    test.setTimeout(900_000)
    await probeSource(
      'pending-questions',
      REPORT,
      [mode],
      evaluateInVSCode,
      workbox,
    )
  })
}

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
