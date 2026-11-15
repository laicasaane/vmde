import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

// Task 733 / 012-19 (D-13 design sections 1.2, 1.3, 11.3 and 12.2): counter gates of the shared
// budget and scope primitives on the table-heavy fixture in IR mode. Counter assertions only, no
// timing. `selectionWrites` and `__vmdeBackgroundStats` are recorded in the log, not asserted
// (design section 12.2). The saved-bytes cases are the real-VS-Code check of the table cell Enter
// (unpatched path) and of the code block Enter (V-3a).

type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type Page = import('@playwright/test').Page

const fixture = tableHeavyMarkdown(1)
const ROOT = '.vditor-ir .vditor-reset'
const CODE_SOURCE = `${ROOT} > [data-type="code-block"] pre.vditor-ir__marker--pre > code`

const PLACES = [
  { name: 'paragraph', selector: `${ROOT} > p`, nth: 2 },
  { name: 'table cell', selector: `${ROOT} > table td`, nth: 7 },
  { name: 'list item', selector: `${ROOT} > ul > li`, nth: 2 },
  { name: 'code block', selector: CODE_SOURCE, nth: 0, programmatic: true },
] as const

async function openFixture(
  workbox: Page,
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  baseDir: string,
  name: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, `scope-budget-gates-${name}.md`)
  writeFileSync(file, fixture)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the scope budget editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(
          () =>
            (
              window as unknown as {
                __vmdeModelShadowStats?: { state: string }
              }
            ).__vmdeModelShadowStats?.state,
        ),
      { timeout: 30_000 },
    )
    .toBe('live')
  return { frame, file }
}

/**
 * Caret at the end of the first line of the IR code block. Its source sits under the rendered
 * preview, so a click cannot reach it: expand the node, select in the source and focus it.
 */
async function placeCaretInCodeSource(frame: Frame): Promise<void> {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, selector) => {
    const code = document.querySelector(selector as string)
    const node = code?.closest('.vditor-ir__node')
    const source = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    const text = code?.firstChild
    if (!node || !source || !(text instanceof Text)) return false
    node.classList.add('vditor-ir__node--expand')
    const newline = text.data.indexOf('\n')
    window
      .getSelection()
      ?.setBaseAndExtent(
        text,
        newline < 0 ? text.length : newline,
        text,
        newline < 0 ? text.length : newline,
      )
    source.focus()
    return true
  }, CODE_SOURCE)
  if (!placed) throw new Error('code block source not found')
}

async function placeCaret(
  workbox: Page,
  frame: Frame,
  place: (typeof PLACES)[number],
): Promise<void> {
  if ('programmatic' in place) {
    await placeCaretInCodeSource(frame)
    return
  }
  const target = frame.locator(place.selector).nth(place.nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

// A negative-assertion wait: the idle publication and its follow-up run before the counters are
// read, so a counter that stays 0 proves the path did not run.
const settleForPublication = (workbox: Page) => workbox.waitForTimeout(2000)

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    const win = window as unknown as {
      __vmdeEditCounters?: { reset(length: number): void }
      __vmdeDecoratorPasses?: { full: number; scoped: number }
    }
    win.__vmdeEditCounters?.reset(length as number)
    win.__vmdeDecoratorPasses = { full: 0, scoped: 0 }
  }, fixture.length)

interface ScopeCounters {
  rootQueryAll: number
  selectionWrites: number | null
  decoratorFull: number
  decoratorScoped: number
  backgroundStats: unknown
}

/** Numbers and job kinds only (SR-5): the background statistics hold counts per job name. */
const readScopeCounters = (frame: Frame): Promise<ScopeCounters> =>
  frame.locator('body').evaluate(() => {
    const win = window as unknown as {
      __vmdeEditCounters?: { rootQueryAll: number; selectionWrites?: number }
      __vmdeDecoratorPasses?: { full: number; scoped: number }
      __vmdeBackgroundStats?: unknown
    }
    const stats = win.__vmdeBackgroundStats
    return {
      rootQueryAll: win.__vmdeEditCounters?.rootQueryAll ?? -1,
      selectionWrites: win.__vmdeEditCounters?.selectionWrites ?? null,
      decoratorFull: win.__vmdeDecoratorPasses?.full ?? 0,
      decoratorScoped: win.__vmdeDecoratorPasses?.scoped ?? 0,
      backgroundStats:
        stats === undefined ? null : JSON.parse(JSON.stringify(stats)),
    }
  })

test.describe('scope budget gates', () => {
  test('keys after the first make no root query and no whole decorator pass', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame } = await openFixture(
      workbox,
      evaluateInVSCode,
      baseDir,
      'keys',
    )
    // Soft assertions: every place runs and logs its counters even when one fails.
    for (const place of PLACES) {
      await placeCaret(workbox, frame, place)
      // The first key may map a unit the feed has not seen yet; it is outside the gate.
      await workbox.keyboard.press('a')
      await settleForPublication(workbox)
      await resetCounters(frame)
      for (const ch of 'bcdef') {
        await workbox.keyboard.press(ch)
        await workbox.waitForTimeout(300)
      }
      await settleForPublication(workbox)
      const counters = await readScopeCounters(frame)
      console.log(
        `SCOPE-BUDGET ${JSON.stringify({ test: 'keys after the first', place: place.name, counters })}`,
      )
      expect.soft(counters.rootQueryAll, `${place.name} rootQueryAll`).toBe(0)
      expect
        .soft(counters.decoratorFull, `${place.name} full decorator passes`)
        .toBe(0)
      // The instrument fired: the keys reached the feed consumers as scoped passes.
      expect
        .soft(counters.decoratorScoped, `${place.name} scoped passes`)
        .toBeGreaterThanOrEqual(1)
    }
  })

  test('Enter and one key in a table cell save the edited cell line only', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await openFixture(
      workbox,
      evaluateInVSCode,
      baseDir,
      'cell',
    )
    await placeCaret(workbox, frame, PLACES[1])
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(300)
    await workbox.keyboard.press('x')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .not.toBe(fixture)
    await settleForPublication(workbox)
    const saved = (await docText(evaluateInVSCode, file)).split('\n')
    const original = fixture.split('\n')
    // Cell 7 of the first table is the third cell of body row 2.
    const row = original.indexOf(
      '| Item a2 | `code2` | text 2 | plain 2 | v2 |',
    )
    expect(row).toBeGreaterThan(0)
    expect(saved).toHaveLength(original.length)
    expect(saved[row]).toMatch(
      /^\| Item a2 \| `code2` \| text 2<br ?\/?>x \| plain 2 \| v2 \|$/,
    )
    expect(saved.filter((line, index) => line !== original[index])).toEqual([
      saved[row],
    ])
  })

  test('Enter and one key in the code block save one new code line', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await openFixture(
      workbox,
      evaluateInVSCode,
      baseDir,
      'code',
    )
    await placeCaret(workbox, frame, PLACES[3])
    await workbox.keyboard.press('Enter')
    await workbox.waitForTimeout(300)
    await workbox.keyboard.press('x')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .not.toBe(fixture)
    await settleForPublication(workbox)
    const firstLine = 'const value1 = 1 * 2\n'
    expect(fixture.split(firstLine)).toHaveLength(2)
    expect(await docText(evaluateInVSCode, file)).toBe(
      fixture.replace(firstLine, `${firstLine}x\n`),
    )
  })
})
