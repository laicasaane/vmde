import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 counter gates. They run on the synthetic table-heavy fixture in IR mode and read
// `window.__vmdeEditCounters` (installed by finish-init in end-to-end runs only). A gate that a later
// task turns green carries `test.fail()` with the task id or design step in its reason; the task
// that turns it green removes the annotation. The positive control is not annotated: a run whose
// instrument never fired is invalid.

type Frame = ReturnType<typeof wf>

interface Counters {
  fullGetValue: number
  luteDocument: number
  luteTable: number
  luteList: number
  rootClone: number
  rootInnerHtmlRead: number
  tableClone: number
  legacyEditPosts: number
  deltaPosts: number
  historyDeltaPosts: number
  maxPostBytes: number
  fallbackPublications: number
}

const fixture = tableHeavyMarkdown(1)
const LETTERS = 'abcdefghij'

// Caret places. Each selector names the Nth element the click lands on; End then moves the caret to
// the end of its line.
const PLACES = [
  { name: 'paragraph', selector: '.vditor-ir .vditor-reset > p', nth: 2 },
  {
    name: 'table cell',
    selector: '.vditor-ir .vditor-reset > table td',
    nth: 7,
  },
  { name: 'list item', selector: '.vditor-ir .vditor-reset > ul > li', nth: 2 },
  {
    name: 'code block',
    // The fenced block's editable source; the YAML front matter is also a `pre > code`, but under
    // `data-type="yaml-front-matter"` with a view-only table preview over it.
    selector:
      '.vditor-ir .vditor-reset > [data-type="code-block"] pre.vditor-ir__marker--pre > code',
    nth: 0,
    programmatic: true,
  },
] as const

async function openFixture(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  baseDir: string,
): Promise<Frame> {
  const file = path.join(baseDir, 'edit-counter-gates.md')
  writeFileSync(file, fixture)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the counter-gate editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(length as number)
  }, fixture.length)

/** The IR model state (`live` or `off`), from the end-to-end model statistics. */
const modelState = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelShadowStats?: { state: string }
        }
      ).__vmdeModelShadowStats?.state,
  )

/** Read the counters and print them (numbers only) before any assertion, so the baseline values of
 *  an expected failure are in the log. */
async function readCounters(
  frame: Frame,
  test: string,
  place: string,
): Promise<Counters> {
  const counters = await readCountersRaw(frame)
  console.log(`EDIT-COUNTERS ${JSON.stringify({ test, place, counters })}`)
  return counters
}

const readCountersRaw = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      luteDocument: c.luteDocument,
      luteTable: c.luteTable,
      luteList: c.luteList,
      rootClone: c.rootClone,
      rootInnerHtmlRead: c.rootInnerHtmlRead,
      tableClone: c.tableClone,
      legacyEditPosts: c.legacyEditPosts,
      deltaPosts: c.deltaPosts,
      historyDeltaPosts: c.historyDeltaPosts,
      maxPostBytes: c.maxPostBytes,
      fallbackPublications: c.fallbackPublications,
    }
  })

/**
 * Caret in a collapsed IR code block. Its source is covered by the rendered preview, so a pointer click
 * cannot reach it (the editor intercepts it). Select inside the source, expand the node and focus,
 * as the d2 edit-performance spec does, then the keyboard drives it.
 */
async function placeCaretInCodeSource(
  frame: Frame,
  selector: string,
): Promise<void> {
  // The top window must hold keyboard focus before the page-side selection is set.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, sel) => {
    const code = document.querySelector(sel as string)
    const node = code?.closest('.vditor-ir__node')
    const source = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    if (!code || !node || !source) return false
    node.classList.add('vditor-ir__node--expand')
    // End of the first code line.
    const text = document
      .createTreeWalker(code, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null
    if (!text) return false
    const content = text.textContent ?? ''
    const newline = content.indexOf('\n')
    const range = document.createRange()
    range.setStart(text, newline < 0 ? content.length : newline)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    source.focus()
    return true
  }, selector)
  if (!placed) throw new Error('code block source not found')
}

async function placeCaret(
  workbox: import('@playwright/test').Page,
  frame: Frame,
  place: { selector: string; nth: number; programmatic?: boolean },
) {
  if (place.programmatic) {
    await placeCaretInCodeSource(frame, place.selector)
    return
  }
  const target = frame.locator(place.selector).nth(place.nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

// A negative-assertion wait: the idle publication and its follow-up must have run before the
// counters are read, so a counter that stays 0 proves the path did not run (not that it had not run yet).
const settleForPublication = (workbox: import('@playwright/test').Page) =>
  workbox.waitForTimeout(2000)

async function typeLetters(
  workbox: import('@playwright/test').Page,
  cadenceMs: number,
) {
  for (const ch of LETTERS) {
    await workbox.keyboard.press(ch)
    await workbox.waitForTimeout(cadenceMs)
  }
}

test.describe('edit counter gates', () => {
  test('positive control: every counter family fires the instrument', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[0])
    await resetCounters(frame)
    // Every counter family fires in the real webview. Nothing is posted to the host.
    await frame.locator('body').evaluate(() => {
      const w = window as unknown as {
        vditor: {
          getValue(): string
          vditor: {
            ir: { element: HTMLElement }
            lute: { VditorIRDOM2Md(html: string): string }
          }
        }
      }
      const inner = w.vditor.vditor
      w.vditor.getValue()
      inner.ir.element.cloneNode(true)
      void inner.ir.element.innerHTML
      const table = inner.ir.element.querySelector('table')
      if (!table) throw new Error('no table in the IR root')
      inner.lute.VditorIRDOM2Md(table.outerHTML)
    })
    const counters = await readCounters(frame, 'positive control', 'all')
    expect(counters.fullGetValue).toBe(1)
    expect(counters.luteDocument).toBeGreaterThanOrEqual(1)
    expect(counters.rootClone).toBe(1)
    expect(counters.rootInnerHtmlRead).toBeGreaterThanOrEqual(1)
    expect(counters.luteTable).toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts).toBe(0)
    expect(counters.deltaPosts).toBe(0)
  })

  test('typing and Backspace publish as deltas', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    // Soft assertions: every place runs and logs its counters even when one fails.
    for (const place of PLACES) {
      await placeCaret(workbox, frame, place)
      await resetCounters(frame)
      await typeLetters(workbox, 80)
      await typeLetters(workbox, 300)
      for (let i = 0; i < 5; i++) {
        await workbox.keyboard.press('Backspace')
        await workbox.waitForTimeout(80)
      }
      await settleForPublication(workbox)
      const counters = await readCounters(
        frame,
        'typing and Backspace publish as deltas',
        place.name,
      )
      expect.soft(counters.fullGetValue, `${place.name} fullGetValue`).toBe(0)
      // Q-18 (b): typing in a table cell makes whole-table Lute calls from Vditor's own input handling
      // (it spins the edited block, here the whole table; a list item shows the same with `luteList`,
      // 26 calls for 23 keys, with the model not involved). That is design step S5: the assertion for
      // this place lives in the S5 test "keys in a table cell" below.
      if (place.name !== 'table cell')
        expect.soft(counters.luteDocument, `${place.name} luteDocument`).toBe(0)
      expect
        .soft(counters.legacyEditPosts, `${place.name} legacyEditPosts`)
        .toBe(0)
      expect
        .soft(
          counters.fallbackPublications,
          `${place.name} fallbackPublications`,
        )
        .toBe(0)
      expect
        .soft(counters.deltaPosts, `${place.name} deltaPosts`)
        .toBeGreaterThanOrEqual(1)
      expect
        .soft(counters.maxPostBytes, `${place.name} maxPostBytes`)
        .toBeLessThan(1024)
    }
  })

  test('pointer move and selection change make no whole-document Lute call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    const pointerMoveAndClick = async () => {
      const table = frame.locator('.vditor-ir .vditor-reset > table').first()
      await table.scrollIntoViewIfNeeded()
      const box = await table.boundingBox()
      if (!box) throw new Error('table has no bounding box')
      await workbox.mouse.move(box.x + 20, box.y + 20)
      await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
        steps: 8,
      })
      const paragraph = frame
        .locator('.vditor-ir .vditor-reset > p:not(:has(a))')
        .nth(2)
      await paragraph.scrollIntoViewIfNeeded()
      await paragraph.click()
    }
    await resetCounters(frame)
    await pointerMoveAndClick()
    await settleForPublication(workbox)
    const first = await readCounters(
      frame,
      'pointer move and selection change (first)',
      'table and paragraph',
    )
    expect(first.luteDocument, 'first move luteDocument').toBe(0)
    expect(first.fullGetValue, 'first move fullGetValue').toBe(0)
    // One edit, its publication and the host answer, then the same pointer move and click again.
    await workbox.keyboard.press('End')
    await workbox.keyboard.press('x')
    await settleForPublication(workbox)
    await resetCounters(frame)
    await pointerMoveAndClick()
    await settleForPublication(workbox)
    const repeat = await readCounters(
      frame,
      'pointer move and selection change (repeat)',
      'table and paragraph',
    )
    expect(repeat.luteDocument, 'repeat luteDocument').toBe(0)
    expect(repeat.fullGetValue, 'repeat fullGetValue').toBe(0)
  })

  // Task 733 / 002: a key in a cell re-spins that cell alone, so no whole-table Lute call runs.
  // Enter stays in the drive (the `.` after it types into a cell that holds a break); its own
  // whole-document work is the gate below (task 009). `tableClone` is task 007's gate (Q-48).
  test('keys in a table cell make no whole-table Lute call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[1])
    await resetCounters(frame)
    // Q-18 (b): letters first, the case moved here from "typing and Backspace publish as deltas".
    await typeLetters(workbox, 80)
    await workbox.keyboard.press('Backspace')
    await workbox.waitForTimeout(150)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(150)
    await workbox.keyboard.press('.')
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'keys in a table cell',
      'table cell',
    )
    expect(counters.luteTable).toBe(0)
  })

  // Task 733 / 007 (Q-48): table chrome works from the changed cell, so a short edit that stays
  // inside the column width clones no table, not even after the 600 ms typing pause.
  test('typing in a table cell clones no table', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[1])
    // The first measurement of the tables that scrolled near is not typing; let it finish first.
    await settleForPublication(workbox)
    await resetCounters(frame)
    await typeLetters(workbox, 80)
    await workbox.waitForTimeout(1000)
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'typing in a table cell',
      'table cell',
    )
    expect(counters.tableClone).toBe(0)
  })

  test('Enter in a table cell makes no whole-document Lute call', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[1])
    await resetCounters(frame)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(400)
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(400)
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'Enter in a table cell',
      'table cell',
    )
    expect(counters.luteDocument).toBe(0)
    expect(counters.fullGetValue).toBe(0)
    // Q-56: Enter in a cell keeps the model live (no fallback publication).
    expect(counters.fallbackPublications).toBe(0)
    expect(await modelState(frame)).toBe('live')
  })

  test('Backspace in a paragraph reads no root HTML', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[0])
    await resetCounters(frame)
    for (let i = 0; i < 5; i++) {
      await workbox.keyboard.press('Backspace')
      await workbox.waitForTimeout(150)
    }
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'Backspace in a paragraph',
      'paragraph',
    )
    expect(counters.rootInnerHtmlRead).toBe(0)
  })

  test('typing, Undo and Redo take no whole-editor snapshot', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[0])
    await resetCounters(frame)
    await typeLetters(workbox, 150)
    for (let i = 0; i < 3; i++) {
      await workbox.keyboard.press('Control+z')
      await workbox.waitForTimeout(400)
    }
    for (let i = 0; i < 3; i++) {
      await workbox.keyboard.press('Control+y')
      await workbox.waitForTimeout(400)
    }
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'typing, Undo and Redo',
      'paragraph',
    )
    expect(counters.rootClone).toBe(0)
    expect(counters.rootInnerHtmlRead).toBe(0)
    // The unit engine (task 004): no whole-document Lute call, and the Undos and Redos reach the host
    // as history deltas, never as the legacy whole-text edit or history-transition posts.
    expect(counters.luteDocument).toBe(0)
    expect(counters.historyDeltaPosts).toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts).toBe(0)
  })

  // Ledger amendment (Q-44): after an Undo and a Redo the model is trusted again, so typing
  // publishes deltas, not the whole text, and the Vditor snapshot is gone.
  test('typing after Undo and Redo publishes deltas', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openFixture(workbox, evaluateInVSCode, baseDir)
    await placeCaret(workbox, frame, PLACES[0])
    await typeLetters(workbox, 150)
    await workbox.waitForTimeout(1000)
    for (const key of ['Control+z', 'Control+z', 'Control+y', 'Control+y']) {
      await workbox.keyboard.press(key)
      await workbox.waitForTimeout(400)
    }
    await settleForPublication(workbox)
    await resetCounters(frame)
    for (const ch of 'xyz') {
      await workbox.keyboard.press(ch)
      await workbox.waitForTimeout(150)
    }
    await settleForPublication(workbox)
    const counters = await readCounters(
      frame,
      'typing after Undo and Redo',
      'paragraph',
    )
    expect(counters.deltaPosts).toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts).toBe(0)
    expect(counters.rootClone).toBe(0)
  })
})
