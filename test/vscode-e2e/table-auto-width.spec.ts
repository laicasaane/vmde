/**
 * Task 639 S3 — content-aware table column widths in the real VS Code webview.
 *
 * Two test cases, because their states are incompatible: the first needs no OS input and covers
 * layout in every mode (reopened per mode through `vmde.editor.defaultMode`); the second drives
 * OS-level (XTEST) typing and history and needs the isolated Xvfb/Openbox session.
 *
 * Acceptance map (tasks/639-content-aware-table-column-widths.md):
 *   1  mixed table (a): short columns on one line, table at least 25% shorter than the
 *      baseline-equivalent height (the same table with its automatic class removed, i.e. equal
 *      widths, read in the same session) — IR, WYSIWYG, Preview.
 *   2  similar table (b): max/min column ratio at most 1.15 — IR, WYSIWYG, Preview.
 *   3  over-wide table (c): no horizontal overflow beyond what the baseline-equivalent layout has,
 *      same height as that layout (no regression) — IR, WYSIWYG, Preview. Tables (a) and (b) have
 *      no horizontal overflow at all.
 *   4  Task 219 drag wins over the automatic widths; handles line up within 1 px before and after.
 *   5  OS typing in a cell: widths hold per keystroke and change once, after the typing pause.
 *   7  host bytes, disk bytes, dirty state and Undo depth are unchanged by layout; one Undo and
 *      one Redo after a cell edit restore exact bytes and keep Redo available.
 *
 * Expected values come from the task contract, never from the code under test. Fixture text stays
 * in the assertions only as booleans or lengths.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  ExtensionId,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

type Mode = 'ir' | 'wysiwyg' | 'preview'
type Frame = ReturnType<typeof wf>

const FIXTURE = readFileSync(
  path.join(__dirname, '../../media-src/e2e/fixtures/table-widths.md'),
  'utf8',
)
const SURFACE: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  preview: '.vditor-preview .vditor-reset',
}
const TABLE_MIXED = 0
const TABLE_SIMILAR = 1
const TABLE_WIDE = 2
const AUTO_CLASS = '^vmde-table-auto-\\d+$'
// The typing pause of the width engine is 600 ms; a change sooner than this after the last key
// would be a per-keystroke change.
const MIN_PAUSE_MS = 400

test.afterEach(async ({ evaluateInVSCode }) => {
  // The harness user-data dir is shared across boots; leaving a default mode set would change how
  // every later spec opens its document.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update(
        'editor.defaultMode',
        undefined,
        vscode.ConfigurationTarget.Global,
      )
  })
})

interface TableState {
  widths: number[]
  height: number
  width: number
  overflowTable: number
  overflowParent: number
  overflowSurface: number
  classes: string
  /** Text lines per cell of columns 0..2, row by row (mixed table only). */
  lines: number[]
}

interface Measured {
  auto: TableState
  equal: TableState
}

interface HandleError {
  count: number
  max: number
  detail: Array<{ right: number; handle: number | null; clipRight: number }>
}

/** Opens `file` in `mode` and returns the frame once the surface and the three tables exist. */
async function openInMode(
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  workbox: Page,
  file: string,
  mode: Mode,
): Promise<Frame> {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension(args[0])?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          args[1],
          vscode.ConfigurationTarget.Global,
        )
    },
    [ExtensionId, mode] as [string, string],
  )
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    90_000,
    mode === 'wysiwyg' ? '.vditor-wysiwyg' : '.vditor-ir',
    mode !== 'preview',
  )
  await waitForE2EReadiness(frame as Frame, (state) => state.routerReady, {
    timeout: 90_000,
    message: `${mode} readiness`,
  })
  await expect(frame.locator(`${SURFACE[mode]} table`)).toHaveCount(3, {
    timeout: 60_000,
  })
  // Preview renders after a debounce; its tables are in the DOM before they are visible.
  await frame
    .locator(`${SURFACE[mode]} table`)
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
  return frame as Frame
}

/** Waits until every fixture table carries its automatic width class. */
async function waitForAutoClasses(frame: Frame, mode: Mode): Promise<void> {
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(
          (_body, args) => {
            const [surface, pattern] = args
            const tables = Array.from(
              document.querySelectorAll(`${surface} table`),
            )
            return (
              tables.length === 3 &&
              tables.every((table) =>
                Array.from(table.classList).some((token) =>
                  new RegExp(pattern).test(token),
                ),
              )
            )
          },
          [SURFACE[mode], AUTO_CLASS] as const,
        ),
      { timeout: 30_000, message: `${mode} tables got automatic widths` },
    )
    .toBe(true)
}

/**
 * Reads each fixture table with its automatic widths, then with the automatic class removed (the
 * equal-width layout of today, i.e. the baseline-equivalent), and restores the class attribute
 * exactly. Everything happens in one synchronous script, so no observer runs in between.
 */
function measureTables(frame: Frame, mode: Mode): Promise<Measured[]> {
  return frame.locator('body').evaluate(
    (_body, args) => {
      const [surfaceSelector, pattern] = args
      const surface = document.querySelector(surfaceSelector) as HTMLElement
      const scroller = (surface.closest('.vditor-preview') ??
        surface) as HTMLElement
      const read = (table: HTMLTableElement): TableState => {
        const parent = table.parentElement as HTMLElement
        const rect = table.getBoundingClientRect()
        const lines: number[] = []
        for (const column of [0, 1, 2])
          for (const row of Array.from(table.rows)) {
            const range = document.createRange()
            range.selectNodeContents(row.cells[column])
            const tops = new Set(
              Array.from(range.getClientRects())
                .filter((box) => box.width > 0 && box.height > 0)
                .map((box) => Math.round(box.top / 4)),
            )
            lines.push(tops.size)
          }
        return {
          widths: Array.from(
            table.rows[0].cells,
            (cell) => cell.getBoundingClientRect().width,
          ),
          height: rect.height,
          width: rect.width,
          overflowTable: table.scrollWidth - table.clientWidth,
          overflowParent: parent.scrollWidth - parent.clientWidth,
          overflowSurface: Math.max(
            surface.scrollWidth - surface.clientWidth,
            scroller.scrollWidth - scroller.clientWidth,
          ),
          classes: table.getAttribute('class') ?? '',
          lines,
        }
      }
      return Array.from(surface.querySelectorAll('table'))
        .slice(0, 3)
        .map((table) => {
          const original = table.getAttribute('class') ?? ''
          const auto = read(table)
          for (const token of Array.from(table.classList))
            if (new RegExp(pattern).test(token)) table.classList.remove(token)
          const equal = read(table)
          table.setAttribute('class', original)
          return { auto, equal }
        })
    },
    [SURFACE[mode], AUTO_CLASS] as const,
  )
}

/**
 * Largest distance between a header cell's right edge and the centre of its resize handle, over
 * the header cells that are not clipped by their scrolling parent (a handle outside the clip is
 * hidden by design).
 */
function handleAlignment(frame: Frame, mode: Mode): Promise<HandleError> {
  return frame.locator('body').evaluate((_body, surfaceSelector) => {
    const surface = document.querySelector(surfaceSelector as string)!
    const table = surface.querySelector('table') as HTMLTableElement
    // The visible part of the scrolling surface (without its scrollbar).
    const surfaceBox = surface.getBoundingClientRect()
    const clipRight = Math.min(
      (table.parentElement as HTMLElement).getBoundingClientRect().right,
      surfaceBox.left + surface.clientLeft + surface.clientWidth,
    )
    const handles = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-table-resize-handle'),
    ).map((handle) => {
      const box = handle.getBoundingClientRect()
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })
    let count = 0
    let max = 0
    const detail: HandleError['detail'] = []
    for (const cell of Array.from(table.querySelectorAll('th'))) {
      const box = cell.getBoundingClientRect()
      const near = handles.filter(
        (handle) => handle.y >= box.top && handle.y <= box.bottom,
      )
      const distance = near.length
        ? Math.min(...near.map((handle) => Math.abs(handle.x - box.right)))
        : null
      const nearest = near.find(
        (handle) => Math.abs(handle.x - box.right) === distance,
      )
      detail.push({
        right: box.right,
        handle: nearest?.x ?? null,
        clipRight,
      })
      if (box.right > clipRight) continue
      count++
      max = Math.max(max, distance ?? Number.POSITIVE_INFINITY)
    }
    return { count, max, detail }
  }, SURFACE[mode])
}

function undoDepth(frame: Frame): Promise<{ undo: number; redo: number }> {
  return frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const history = inner.undo[inner.currentMode]
    return {
      undo: history.undoStack.length as number,
      redo: history.redoStack.length as number,
    }
  })
}

function isDirty(
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  file: string,
): Promise<boolean> {
  return evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === args[0])
        ?.isDirty ?? null,
    [file] as [string],
  ) as Promise<boolean>
}

function expectLayout(mode: Mode, tables: Measured[]) {
  const [mixed, similar, wide] = [
    tables[TABLE_MIXED],
    tables[TABLE_SIMILAR],
    tables[TABLE_WIDE],
  ]
  for (const table of tables) {
    expect(table.auto.classes).toMatch(/vmde-table-auto-\d+/u)
    // The cells fill the table; Acceptance 3: no horizontal overflow beyond the equal layout.
    expect(
      Math.abs(
        table.auto.widths.reduce((sum, width) => sum + width, 0) -
          table.auto.width,
      ),
      `${mode}: columns fill the table`,
    ).toBeLessThanOrEqual(1)
  }
  // Acceptance 1: short columns on one line; table at least 25% shorter than equal widths.
  expect(mixed.auto.lines.every((count) => count === 1)).toBe(true)
  expect(mixed.auto.height).toBeLessThanOrEqual(mixed.equal.height * 0.75)
  expect(
    Math.max(...mixed.auto.widths) / Math.min(...mixed.auto.widths),
  ).toBeGreaterThan(2)
  // Acceptance 2: similar columns stay roughly equal.
  expect(
    Math.max(...similar.auto.widths) / Math.min(...similar.auto.widths),
  ).toBeLessThanOrEqual(1.15)
  // Acceptance 3: tables (a) and (b) do not scroll; (c) never scrolls more than today.
  for (const table of [mixed, similar]) {
    expect(table.auto.overflowTable).toBeLessThanOrEqual(0)
    expect(table.auto.overflowParent).toBeLessThanOrEqual(0)
    expect(table.auto.overflowSurface).toBeLessThanOrEqual(0)
  }
  expect(wide.auto.overflowTable).toBeLessThanOrEqual(
    wide.equal.overflowTable + 1,
  )
  expect(wide.auto.overflowParent).toBeLessThanOrEqual(
    wide.equal.overflowParent + 1,
  )
  expect(wide.auto.overflowSurface).toBeLessThanOrEqual(
    wide.equal.overflowSurface + 1,
  )
  expect(Math.abs(wide.auto.height - wide.equal.height)).toBeLessThanOrEqual(1)
}

test('automatic widths in IR, WYSIWYG and Preview, manual resize wins, source/dirty/undo untouched', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}, testInfo) => {
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'table-auto-width.md')
  writeFileSync(file, FIXTURE)
  const hostText = () => docText(evaluateInVSCode as never, file)
  const record: Record<string, unknown> = {}

  const expectSourceUntouched = async (label: string) => {
    expect(await hostText(), `${label}: host text`).toBe(FIXTURE)
    expect(readFileSync(file, 'utf8') === FIXTURE, `${label}: disk bytes`).toBe(
      true,
    )
    expect(await isDirty(evaluateInVSCode as never, file), label).toBe(false)
  }

  for (const mode of ['ir', 'wysiwyg', 'preview'] as const) {
    const frame = await openInMode(
      evaluateInVSCode as never,
      workbox,
      file,
      mode,
    )
    if (mode !== 'preview') await waitForInitialUndoSnapshot(frame)
    await waitForAutoClasses(frame, mode)
    const depthBefore = mode === 'preview' ? null : await undoDepth(frame)
    const viewport = await frame
      .locator('body')
      .evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const tables = await measureTables(frame, mode)
    record[mode] = { viewport, tables }
    console.log(`[table-auto-width ${mode}]`, JSON.stringify(record[mode]))
    expectLayout(mode, tables)
    await expectSourceUntouched(`${mode} after layout`)

    if (mode !== 'preview') {
      // Handles follow the automatic widths (Acceptance 4, before any drag).
      const alignment = await handleAlignment(frame, mode)
      record[`${mode}Handles`] = alignment
      expect(alignment.count).toBe(tables[TABLE_MIXED].auto.widths.length)
      expect(alignment.max).toBeLessThanOrEqual(1)
    }

    if (mode === 'ir') {
      // Acceptance 4: a real pointer drag beats the automatic widths and starts from them.
      const before = tables[TABLE_MIXED].auto.widths
      const handle = frame.locator('.vmde-table-resize-handle').first()
      await expect(handle).toBeVisible()
      const box = (await handle.boundingBox())!
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      await workbox.mouse.move(x, y)
      await workbox.mouse.down()
      await workbox.mouse.move(x + 30, y, { steps: 4 })
      await workbox.mouse.move(x + 60, y, { steps: 4 })
      await workbox.mouse.up()
      await expect
        .poll(
          () =>
            frame.locator(`${SURFACE.ir} table`).first().getAttribute('class'),
          { timeout: 15_000 },
        )
        .toContain('vmde-table-resized')
      const dragged = (await measureTables(frame, 'ir'))[TABLE_MIXED]
      record.drag = { before, after: dragged.auto.widths }
      expect(dragged.auto.classes).not.toMatch(/vmde-table-auto-\d+/u)
      expect(
        Math.abs(dragged.auto.widths[0] - (before[0] + 60)),
      ).toBeLessThanOrEqual(2)
      for (let column = 1; column < before.length; column++)
        expect(
          Math.abs(dragged.auto.widths[column] - before[column]),
        ).toBeLessThanOrEqual(1)
      console.log(
        '[table-auto-width handles after drag]',
        JSON.stringify(await handleAlignment(frame, 'ir')),
      )
      await expect
        .poll(async () => (await handleAlignment(frame, 'ir')).max)
        .toBeLessThanOrEqual(1)
      const afterDrag = await handleAlignment(frame, 'ir')
      record.dragHandles = afterDrag
      expect(afterDrag.count).toBeGreaterThanOrEqual(1)
    }

    if (depthBefore) {
      // Acceptance 7: neither the layout nor the drag is a history step.
      await frame
        .locator('body')
        .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
      expect(await undoDepth(frame)).toEqual(depthBefore)
    }
    await expectSourceUntouched(`${mode} after drag and settle`)
  }

  console.log('[table-auto-width layout]', JSON.stringify(record))
  await testInfo.attach('table-auto-width-layout.json', {
    body: JSON.stringify(record, null, 2),
    contentType: 'application/json',
  })
})

test.describe('OS typing and history', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('typing in a cell keeps widths until the pause; one Undo and one Redo restore exact bytes', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }, testInfo) => {
    test.setTimeout(300_000)
    const record: Record<string, unknown> = {}
    const typed = 'abcdefghij'
    const collapse = (markdown: string) =>
      markdown.replace(/ +/gu, ' ').replace(/-+/gu, '-')
    const input = await createXtestInput(electronApp, workbox)
    expect(input.client.visible).toBe(true)

    for (const mode of ['ir', 'wysiwyg'] as const) {
      const file = path.join(baseDir, `table-auto-typing-${mode}.md`)
      writeFileSync(file, FIXTURE)
      const hostText = () => docText(evaluateInVSCode as never, file)
      const frame = await openInMode(
        evaluateInVSCode as never,
        workbox,
        file,
        mode,
      )
      await waitForInitialUndoSnapshot(frame)
      await waitForAutoClasses(frame, mode)
      await input.activateAndFocus()
      // The first OS Ctrl chord of a VS Code session may not reach the webview (Task 598); send
      // one to the untouched document. The measured keys below are never retried.
      await input.key('ctrl+z')
      expect(await hostText()).toBe(FIXTURE)

      // Per-frame log of first-row widths (changes of at least 1 px) and key times, in the page.
      await frame.locator('body').evaluate((_body, selector) => {
        const log: Array<{ time: number; widths: number[] }> = []
        const keys: number[] = []
        let previous: number[] | null = null
        const tick = () => {
          const table = document
            .querySelector(selector as string)
            ?.querySelector('table') as HTMLTableElement | null
          if (table) {
            const widths = Array.from(
              table.rows[0].cells,
              (cell) => cell.getBoundingClientRect().width,
            )
            if (
              !previous ||
              widths.length !== previous.length ||
              widths.some((width, i) => Math.abs(width - previous![i]) >= 1)
            ) {
              log.push({ time: performance.now(), widths })
              previous = widths
            }
          }
          requestAnimationFrame(tick)
        }
        document.addEventListener(
          'keydown',
          () => keys.push(performance.now()),
          true,
        )
        ;(window as any).__widthLog = log
        ;(window as any).__keyLog = keys
        tick()
      }, SURFACE[mode])

      // Real pointer into the status cell of the first body row, caret to its end by OS key.
      await frame
        .locator(`${SURFACE[mode]} table`)
        .first()
        .locator('tbody td')
        .nth(1)
        .click()
      await input.key('End')
      const initial = (await measureTables(frame, mode))[TABLE_MIXED].auto
      const depthBefore = await undoDepth(frame)
      await frame.locator('body').evaluate(() => {
        ;(window as any).__widthLog.length = 0
        ;(window as any).__keyLog.length = 0
      })
      await input.type(typed, 20)
      await expect
        .poll(async () => (await hostText()) !== FIXTURE, { timeout: 15_000 })
        .toBe(true)
      const typingEnd = await frame
        .locator('body')
        .evaluate(() => Math.max(...((window as any).__keyLog as number[])))
      await frame
        .locator('body')
        .evaluate(() => new Promise((resolve) => setTimeout(resolve, 2500)))
      const log = await frame.locator('body').evaluate(
        () =>
          (window as any).__widthLog as Array<{
            time: number
            widths: number[]
          }>,
      )
      record[`${mode}Typing`] = {
        initial: initial.widths,
        log,
        typingEnd,
      }
      // Acceptance 5: exactly one change, after the pause, not during the keystrokes.
      expect(log).toHaveLength(1)
      expect(log[0].time - typingEnd).toBeGreaterThanOrEqual(MIN_PAUSE_MS)
      const settled = (await measureTables(frame, mode))[TABLE_MIXED].auto
      expect(settled.widths[1]).toBeGreaterThan(initial.widths[1] + 2)
      expect(settled.classes).toMatch(/vmde-table-auto-\d+/u)
      const afterEdit = await hostText()
      expect(collapse(afterEdit)).toBe(
        collapse(FIXTURE).replace(
          '| T-101 | Open |',
          `| T-101 | Open${typed} |`,
        ),
      )

      // Acceptance 7: the edit is one history step; the width change adds none.
      const depthEdited = await undoDepth(frame)
      record[`${mode}Depth`] = { depthBefore, depthEdited }
      expect(depthEdited.undo).toBe(depthBefore.undo + 1)
      expect(depthEdited.redo).toBe(depthBefore.redo)
      await input.key('ctrl+z')
      await expect.poll(hostText, { timeout: 15_000 }).toBe(FIXTURE)
      const afterUndo = await undoDepth(frame)
      record[`${mode}DepthUndo`] = afterUndo
      expect(afterUndo.redo).toBeGreaterThanOrEqual(1)
      expect(afterUndo.undo).toBe(depthBefore.undo)
      await input.key('ctrl+y')
      await expect.poll(hostText, { timeout: 15_000 }).toBe(afterEdit)
      const afterRedo = await undoDepth(frame)
      record[`${mode}DepthRedo`] = afterRedo
      expect(afterRedo).toEqual(depthEdited)
      // Return to the original bytes and save, so the next mode reopens a clean document.
      await input.key('ctrl+z')
      await expect.poll(hostText, { timeout: 15_000 }).toBe(FIXTURE)
      await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      })
      await expect.poll(() => readFileSync(file, 'utf8') === FIXTURE).toBe(true)
      expect(await isDirty(evaluateInVSCode as never, file)).toBe(false)
    }

    console.log('[table-auto-width typing]', JSON.stringify(record))
    await testInfo.attach('table-auto-width-typing.json', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    })
  })
})
