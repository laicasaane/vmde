import { copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import { wf } from './webview-helpers'

// MEASUREMENT (diagnostic; a gate only with VMDE_PERF_ASSERT=1). Per gated operation (typing at two
// cadences, Backspace, Enter, paste, Undo, Redo in a paragraph, a table cell, a list item and a code
// block; the first pointer move over the document; a selection change) it records:
//   - the Event Timing duration (PerformanceObserver type `event`, durationThreshold 16),
//   - long tasks in the 3 s after the operation,
//   - keydown to the second animation frame after it (second column, kept from the first version).
// Input: VMDE_PERF_FILE (a document, never committed) or VMDE_PERF_FACTOR (1, 4, 16; synthetic
// fixture). VMDE_PROFILE=<dir> adds a CPU profile per profiled operation. VMDE_PERF_OUT=<path> gets the
// same JSON as the `EDIT-LATENCY` line. The JSON holds operation names, places and numbers only,
// never document text. @probe: excluded from the default run.

type Frame = ReturnType<typeof wf>

const EVENT_THRESHOLD_MS = 16
const GATE_MS = 50
const LETTERS = 'abcdefghij'

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

interface Row {
  operation: string
  place: string
  /** keydown-to-second-frame samples (second column). */
  frames: number
  frameMedianMs: number
  frameMaxMs: number
  /** Event Timing entries at or over the threshold. */
  eventCount: number
  eventMaxMs: number
  longTaskCount: number
  longTaskMs: number
}

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

const install = (frame: Frame) =>
  frame.locator('body').evaluate((_body, threshold) => {
    const w = window as unknown as {
      __lat: {
        samples: number[]
        events: number[]
        long: number[]
      }
    }
    w.__lat = { samples: [], events: [], long: [] }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lat.long.push(entry.duration)
    }).observe({ type: 'longtask', buffered: false })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__lat.events.push(entry.duration)
    }).observe({
      type: 'event',
      durationThreshold: threshold as number,
      buffered: false,
    } as PerformanceObserverInit)
    document.addEventListener(
      'keydown',
      () => {
        const start = performance.now()
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            w.__lat.samples.push(performance.now() - start),
          ),
        )
      },
      true,
    )
  }, EVENT_THRESHOLD_MS)

/** Wait 3 s after the operation (long tasks and late Event Timing entries), then read and clear. */
const take = (frame: Frame) =>
  frame.locator('body').evaluate(async () => {
    await new Promise((r) => setTimeout(r, 3000))
    const w = window as unknown as {
      __lat: { samples: number[]; events: number[]; long: number[] }
    }
    const { samples, events, long } = w.__lat
    w.__lat = { samples: [], events: [], long: [] }
    const sorted = [...samples].sort((a, b) => a - b)
    const pick = (q: number) =>
      Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ??
          -1,
      )
    return {
      frames: samples.length,
      frameMedianMs: pick(0.5),
      frameMaxMs: Math.round(sorted.at(-1) ?? -1),
      eventCount: events.length,
      eventMaxMs: Math.round(Math.max(0, ...events)),
      longTaskCount: long.length,
      longTaskMs: Math.round(long.reduce((a, b) => a + b, 0)),
    }
  })

function resolveSource(baseDir: string): { file: string; label: string } {
  const file = path.join(baseDir, 'edit-latency.md')
  const source = process.env.VMDE_PERF_FILE
  if (source) {
    copyFileSync(source, file)
    return { file, label: 'file' }
  }
  const factor = Number(process.env.VMDE_PERF_FACTOR ?? '1')
  if (factor !== 1 && factor !== 4 && factor !== 16)
    throw new Error('VMDE_PERF_FACTOR must be 1, 4 or 16')
  writeFileSync(file, tableHeavyMarkdown(factor))
  return { file, label: `factor ${factor}` }
}

test('edit latency on a large document @probe', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(1_800_000)
  const { file, label } = resolveSource(baseDir)
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
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 4000)))
  await install(frame)

  // VMDE_PROFILE=<dir>: a CPU profile of each profiled burst, taken through a CDP session on the webview frame.
  const profileDir = process.env.VMDE_PROFILE
  let cdp: import('@playwright/test').CDPSession | null = null
  if (profileDir) {
    // The webview runs out of process: take the first non-main frame that owns a CDP session.
    for (const candidate of workbox.frames()) {
      if (candidate === workbox.mainFrame()) continue
      try {
        cdp = await workbox.context().newCDPSession(candidate)
        break
      } catch {
        /* shares its parent's session */
      }
    }
  }
  if (cdp) {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  }
  const startProfile = async () => {
    if (cdp) await cdp.send('Profiler.start')
  }
  const stopProfile = async (name: string) => {
    if (!cdp || !profileDir) return
    const { profile } = (await cdp.send('Profiler.stop')) as {
      profile: unknown
    }
    writeFileSync(
      path.join(profileDir, `${name.replace(/\W+/g, '-')}.cpuprofile`),
      JSON.stringify(profile),
    )
  }

  const placeCaret = async (place: {
    selector: string
    nth: number
    programmatic?: boolean
  }) => {
    if (place.programmatic) return placeCaretInCodeSource(frame, place.selector)
    const target = frame.locator(place.selector).nth(place.nth)
    await target.scrollIntoViewIfNeeded()
    await target.click({ timeout: 10_000 })
    await workbox.keyboard.press('End')
  }
  const rows: Row[] = []
  const failures: { place: string; operation: string; error: string }[] = []
  // One failed step must not end the run: keep the first line of the message only (a locator call log
  // quotes page text), and carry on with the next operation.
  const fail = (place: string, operation: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    failures.push({
      place,
      operation,
      error: message.split('\n')[0].slice(0, 120),
    })
  }
  const record = async (
    operation: string,
    place: string,
    drive: () => Promise<void>,
  ) => {
    try {
      await startProfile()
      await drive()
      const numbers = await take(frame)
      await stopProfile(`${place} ${operation}`)
      rows.push({ operation, place, ...numbers })
    } catch (error) {
      fail(place, operation, error)
      await take(frame).catch(() => undefined)
    }
  }
  const press = async (key: string, times: number, gapMs: number) => {
    for (let i = 0; i < times; i++) {
      await workbox.keyboard.press(key)
      await workbox.waitForTimeout(gapMs)
    }
  }
  const type = async (gapMs: number) => {
    for (const ch of LETTERS) {
      await workbox.keyboard.press(ch)
      await workbox.waitForTimeout(gapMs)
    }
  }

  // The first pointer move over the document, then a selection change by click.
  await record('first pointer move', 'table', async () => {
    const firstTable = frame.locator('.vditor-ir .vditor-reset > table').first()
    await firstTable.scrollIntoViewIfNeeded()
    const box = await firstTable.boundingBox()
    if (!box) throw new Error('table has no bounding box')
    await workbox.mouse.move(box.x + 20, box.y + 20)
    await workbox.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 8,
    })
  })
  await record('selection change', 'paragraph', async () => {
    await frame.locator(PLACES[0].selector).nth(1).click()
    await workbox.keyboard.press('ArrowRight')
  })

  for (const place of PLACES) {
    try {
      await placeCaret(place)
      await frame
        .locator('body')
        .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
      await take(frame)
    } catch (error) {
      fail(place.name, 'place caret', error)
      continue
    }
    await record('type 80 ms', place.name, () => type(80))
    await record('type 300 ms', place.name, () => type(300))
    await record('backspace', place.name, () => press('Backspace', 5, 150))
    await record('enter', place.name, () => press('Enter', 2, 400))
    await record('paste', place.name, async () => {
      // A constant synthetic text; the clipboard may refuse the write outside a user gesture.
      await frame
        .locator('body')
        .evaluate(() => navigator.clipboard.writeText('pasted words'))
        .catch(() => undefined)
      await workbox.keyboard.press('Control+v')
    })
    await record('undo', place.name, () => press('Control+z', 5, 400))
    await record('redo', place.name, () => press('Control+y', 5, 400))
  }

  // The first block action after the typing above: Move Block Down re-resolves fresh units through
  // the block handle's own proof, which a model-backed hover no longer warms (task 005 decision 2).
  await placeCaret(PLACES[0]).catch((error) =>
    fail('paragraph', 'place caret', error),
  )
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
  await take(frame)
  await record('first block action', 'paragraph', async () => {
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.moveBlockDown')
    }, [])
  })

  const violations = rows
    .filter(
      (row) =>
        row.eventMaxMs > GATE_MS ||
        row.frameMaxMs > GATE_MS ||
        row.longTaskCount > 0,
    )
    .map((row) => `${row.place} ${row.operation}`)
  const json = JSON.stringify({
    source: label,
    gateMs: GATE_MS,
    rows,
    failures,
    violations,
  })
  console.log(`EDIT-LATENCY ${json}`)
  if (process.env.VMDE_PERF_OUT) writeFileSync(process.env.VMDE_PERF_OUT, json)
  if (process.env.VMDE_PERF_ASSERT === '1') {
    expect(failures).toEqual([])
    expect(violations).toEqual([])
  }
  // Without the assert flag the probe fails only when nothing was measured.
  expect(rows.length, 'measured operations').toBeGreaterThan(0)
})
