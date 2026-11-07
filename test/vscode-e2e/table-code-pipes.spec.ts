import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 704 — a `|` between the backticks of a code span in a table row is part of the code span,
// not a cell separator (Decision D1). Real webview: the host pre-escape, the webview Lute patch,
// the incremental IR serializer, the minimal-diff write-back and VS Code's save path only meet
// here. The Chromium harness and Vitest each cover one half of that chain.
//
// Fixture rows: I56 (plain cells), I57 (a code span holding five bare pipes, as in the Owner's
// report), E1 (a code span written `x \| y`), E2 (a double-backtick span `a | b`).

const dir = path.join(tmpdir(), `vmde-table-code-pipes-${process.pid}`)
mkdirSync(dir, { recursive: true })
const FIXTURE = path.join(__dirname, 'fixtures', 'table-code-pipes.md')
const ORIGINAL = readFileSync(FIXTURE, 'utf8')

test.use({ baseDir: dir })

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'
type Evaluate = Parameters<typeof reopenVmdeFixture>[0]

const CODE_I57 = 'Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll'
const ZWSP = /​/g

let bootCount = 0

function freshCopy(): string {
  const target = path.join(dir, `case-${bootCount++}.md`)
  copyFileSync(FIXTURE, target)
  return target
}

async function openFresh(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
): Promise<{ frame: Frame; file: string }> {
  const file = freshCopy()
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

// The user's own path: the edit-mode toolbar button (mode-roundtrip.spec.ts).
async function switchMode(frame: Frame, mode: Mode) {
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

interface RowDisplay {
  cells: number
  cell3Code: string | null
  cell5Link: string | null
  e1Code: string | null
}

// The I57 and E1 rows of the table in `scope`, read from the rendered DOM. IR and WYSIWYG hold the
// editable table; the Preview overlay holds the read-only one.
function readRows(frame: Frame, scope: string): Promise<RowDisplay | null> {
  return frame.locator('body').evaluate((_el, sel) => {
    const rows = Array.from(
      document.querySelectorAll(`${sel} table tr`),
    ) as HTMLTableRowElement[]
    const rowOf = (id: string) =>
      rows.find((r) => r.cells[0]?.textContent?.trim() === id)
    const i57 = rowOf('I57')
    if (!i57) return null
    const clean = (s: string | null | undefined) =>
      s === null || s === undefined ? null : s.replace(/​/g, '')
    const e1 = rowOf('E1')
    return {
      cells: i57.cells.length,
      cell3Code: clean(i57.cells[2]?.querySelector('code')?.textContent),
      // IR keeps the link as marker source; the text `F11` is in the cell either way.
      cell5Link: clean(
        i57.cells[4]?.querySelector('a')?.textContent ??
          (i57.cells[4]?.textContent?.includes('F11') ? 'F11' : null),
      ),
      e1Code: clean(e1?.cells[1]?.querySelector('code')?.textContent),
    }
  }, scope)
}

function expectDisplay(display: RowDisplay | null, label: string) {
  expect(display, `${label}: the I57 row exists`).not.toBeNull()
  expect(display?.cells, `${label}: I57 has 5 cells`).toBe(5)
  expect(
    display?.cell3Code,
    `${label}: I57 cell 3 holds the full code span`,
  ).toBe(CODE_I57)
  expect(display?.cell5Link, `${label}: I57 cell 5 holds the F11 link`).toBe(
    'F11',
  )
  expect(display?.e1Code, `${label}: E1 code span`).toBe('x | y')
}

// A line is "the same row" when its pipes are read the same way: Source mode shows the host's
// escaped form (Decision Q1), so the comparison ignores `\|` versus `|` inside the span.
const unescapePipes = (s: string) => s.replace(/\\\|/g, '|')

async function savedText(
  evaluateInVSCode: Evaluate,
  file: string,
  isDone: (text: string) => boolean,
): Promise<string> {
  // The save command writes the TextDocument as it is when it runs; poll the document for the
  // typed character first (the writeback debounce is 250 ms), then save and poll the disk.
  await expect
    .poll(async () => isDone(await docText(evaluateInVSCode, file)), {
      message: 'the typed character reached the TextDocument',
    })
    .toBe(true)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as unknown as [string],
  )
  await expect
    .poll(() => isDone(readFileSync(file, 'utf8')), {
      message: 'the save reached the disk',
    })
    .toBe(true)
  return readFileSync(file, 'utf8')
}

// Click the editor first: `workbox.keyboard` goes to the top Electron window, and a DOM-level
// focus inside the iframe alone drops the keystroke (block-fidelity.spec.ts).
async function focusPane(frame: Frame, pane: string) {
  await frame
    .locator(pane)
    .first()
    .click({ position: { x: 4, y: 4 } })
}

// Put the caret at the start of the first cell of row `id` (IR, WYSIWYG), or at the end of the
// TYPE-HERE paragraph when `id` is null.
async function placeCaret(frame: Frame, mode: Mode, id: string | null) {
  await focusPane(frame, `.vditor-${mode}`)
  await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page search for the caret target across the TYPE-HERE paragraph, a table cell and the Source-mode text
    (_el, arg) => {
      const { pane, rowId, isSv } = arg as {
        pane: string
        rowId: string | null
        isSv: boolean
      }
      const root = document.querySelector(pane) as HTMLElement | null
      if (!root) throw new Error(`${pane} not found`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let target: { node: Text; offset: number } | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent ?? ''
        if (rowId === null) {
          const anchor = 'TYPE-HERE anchor paragraph.'
          const at = text.indexOf(anchor)
          if (at >= 0) target = { node: n as Text, offset: at + anchor.length }
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
        if (target) break
      }
      if (!target) throw new Error(`caret target ${String(rowId)} not found`)
      const range = document.createRange()
      range.setStart(target.node, target.offset)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      const editable = root.matches('[contenteditable]')
        ? root
        : (root.querySelector('[contenteditable="true"]') as HTMLElement | null)
      editable?.focus()
    },
    { pane: `.vditor-${mode}`, rowId: id, isSv: mode === 'sv' },
  )
}

// Table lines of `text` that differ from the fixture (as sets of lines).
function changedLines(text: string): string[] {
  const original = new Set(ORIGINAL.split('\n'))
  return text.split('\n').filter((line) => !original.has(line))
}

// Acceptance item "display": row I57 shows 5 cells and the full code span in IR, WYSIWYG and
// Preview, and Source mode holds the whole line.
test('T1 display: I57 and E1 show their full code spans in IR, WYSIWYG, Preview and SV', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const { frame } = await openFresh(evaluateInVSCode, workbox)

  await expect
    .poll(() => readRows(frame, '.vditor-ir'), { message: 'IR table rendered' })
    .not.toBeNull()
  expectDisplay(await readRows(frame, '.vditor-ir'), 'IR')

  await frame.locator('.vditor-toolbar [data-type="preview"]').first().click()
  await expect
    .poll(() => readRows(frame, '.vditor-preview'), {
      message: 'Preview table rendered',
    })
    .not.toBeNull()
  expectDisplay(await readRows(frame, '.vditor-preview'), 'Preview')
  await frame.locator('.vditor-toolbar [data-type="preview"]').first().click()

  await switchMode(frame, 'wysiwyg')
  await expect
    .poll(() => readRows(frame, '.vditor-wysiwyg'), {
      message: 'WYSIWYG table rendered',
    })
    .not.toBeNull()
  expectDisplay(await readRows(frame, '.vditor-wysiwyg'), 'WYSIWYG')

  await switchMode(frame, 'sv')
  const svLine = await frame.locator('body').evaluate(() => {
    const sv = document.querySelector('.vditor-sv')
    return (
      (sv?.textContent ?? '')
        .split('\n')
        .find((line) => line.includes('| I57 |')) ?? null
    )
  })
  expect(svLine, 'SV: the I57 source line exists').not.toBeNull()
  const normalized = unescapePipes((svLine ?? '').replace(ZWSP, ''))
  expect(normalized, 'SV: the full code span is on the line').toContain(
    `\`${CODE_I57}\``,
  )
  expect(normalized, 'SV: the line runs through the link').toContain(
    '[F11](../F11-sample-custom-kind.md) |',
  )
})

// Acceptance item "bytes": opening, editing a cell of ANOTHER row and saving keeps the source of
// row I57 and of the `\|` row byte for byte; only the typed character is new.
test('T2 IR: a character typed in the I56 first cell changes nothing else on disk', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const { frame, file } = await openFresh(evaluateInVSCode, workbox)
  await placeCaret(frame, 'ir', 'I56')
  await workbox.keyboard.type('Q', { delay: 40 })
  const saved = await savedText(evaluateInVSCode, file, (t) =>
    t.includes('QI56'),
  )
  const expected = ORIGINAL.replace('| I56 |', '| QI56 |')
  expect(saved.length, 'the file grew by exactly one character').toBe(
    ORIGINAL.length + 1,
  )
  expect(
    changedLines(saved),
    'only the I56 row differs from the fixture',
  ).toEqual([expected.split('\n').find((l) => l.startsWith('| QI56 |'))])
  expect(saved, 'I57 keeps its bare pipes').toContain(
    '| `Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll`, as',
  )
  expect(saved, 'E1 keeps its escaped pipe').toContain('| E1 | `x \\| y` |')
  expect(saved).toBe(expected)
})

// Acceptance item "bytes, edited row": editing a cell of the I57 row itself changes only that
// cell; the code span the user did not touch keeps its bare pipes and the row keeps 5 cells.
test('T3 IR: a character typed in the I57 first cell changes only that cell', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const { frame, file } = await openFresh(evaluateInVSCode, workbox)
  await placeCaret(frame, 'ir', 'I57')
  await workbox.keyboard.type('Q', { delay: 40 })
  const saved = await savedText(evaluateInVSCode, file, (t) =>
    t.includes('QI57'),
  )
  expect(saved).toBe(ORIGINAL.replace('| I57 |', '| QI57 |'))
})

// Acceptance item "bytes, other block": an edit in a block outside the table, in WYSIWYG and in
// Source mode (whose text carries the host's escaped form, Decision Q1), keeps the table bytes.
for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`T4 ${mode}: a character typed in the TYPE-HERE paragraph leaves the table bytes identical`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(300_000)
    const { frame, file } = await openFresh(evaluateInVSCode, workbox)
    await switchMode(frame, mode)
    await placeCaret(frame, mode, null)
    await workbox.keyboard.type('Q', { delay: 40 })
    const saved = await savedText(evaluateInVSCode, file, (t) =>
      t.includes('TYPE-HERE anchor paragraph.Q'),
    )
    expect(saved).toBe(
      ORIGINAL.replace(
        'TYPE-HERE anchor paragraph.',
        'TYPE-HERE anchor paragraph.Q',
      ),
    )
  })
}

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
