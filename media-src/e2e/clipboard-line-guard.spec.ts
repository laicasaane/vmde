import type { Page } from '@playwright/test'
import { tableHeavyMarkdown } from '../../test/vscode-e2e/table-heavy-markdown'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'
import { hostStubState, installHostStub } from './helpers/host-stub'

// Task 733/037: collapsed Ctrl+C and Ctrl+X expand to one line block strictly inside the editable
// surface. Before this task, an element-point caret (`UL,1`, the surface `PRE,n`) reached the
// surface `<pre>` through `closest`, and the whole document was copied and cut. One arrow key over a
// `---` into a list produced such a caret (`UL,0` or `UL,len`, gap-nav `placeCaretAtEdge`).
//
// The page runs the real webview entry (main.ts) with the build patches and the shipped unit
// switches (`/smoke/none.html`), the host stub keeps the host text, and the Chromium
// clipboard is real (permissions granted). No case runs Undo, Redo, Replace or a mode switch, so no
// history replays. The real-VS-Code spec of the same name is the authority for VS Code's command
// path; this one checks the same flows and the 50 ms budget in a plain browser.
//
// Run: `npm --prefix media-src run test:e2e -- clipboard-line-guard --workers=1`.

type Mode = 'ir' | 'wysiwyg'

const SENTINEL = 'SENTINEL-037-keep'
const BUDGET_MS = 50

const FIXTURE = [
  '# Guard fixture',
  '',
  'Head paragraph ALPHA.',
  '',
  '- item one BRAVO',
  '- item two CHARLIE',
  '',
  'Middle paragraph KILO.',
  '',
  '---',
  '',
  '- item three DELTA',
  '- item four ECHO',
  '',
  '---',
  '',
  'Tail paragraph ZULU.',
  '',
].join('\n')

async function open(page: Page, mode: Mode, content: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await installHostStub(page, {
    content,
    options: { showToolbar: true, defaultMode: mode },
  })
  await page.goto('/smoke/none.html')
  await page.waitForFunction(
    (m) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === m
      )
    },
    mode,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(400)
  await installRecorder(page)
}

interface Seen {
  type: string
  caret: boolean
  container: string
  offset: number
  start: number
  end: number
}

/**
 * Records the caret every `beforecopy`/`beforecut` saw and its span (window capture to window
 * bubble: every listener on the path, an upper bound of the guard's cost), plus long tasks and
 * Event Timing entries of 16 ms or more.
 */
const installRecorder = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    w.__guardSeen = []
    w.__guardPerf = { long: [], events: [] }
    const describe = (node: Node): string => {
      const surface = w.vditor.vditor[w.vditor.getCurrentMode()].element
      if (node === surface) return 'SURFACE'
      if (node.nodeType !== Node.ELEMENT_NODE) return 'TEXT'
      const el = node as Element
      return `${el.tagName}#${[...surface.querySelectorAll(el.tagName)].indexOf(el)}`
    }
    for (const type of ['beforecopy', 'beforecut']) {
      window.addEventListener(
        type,
        () => {
          const selection = getSelection()
          const range =
            selection && selection.rangeCount > 0
              ? selection.getRangeAt(0)
              : null
          w.__guardSeen.push({
            type,
            caret: range !== null && range.toString() === '',
            container: range ? describe(range.startContainer) : '',
            offset: range ? range.startOffset : -1,
            start: performance.now(),
            end: -1,
          })
        },
        true,
      )
      window.addEventListener(type, () => {
        const last = w.__guardSeen.at(-1)
        if (last && last.end < 0) last.end = performance.now()
      })
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        w.__guardPerf.long.push([entry.startTime, entry.duration])
    }).observe({ type: 'longtask', buffered: false })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        w.__guardPerf.events.push([entry.startTime, entry.duration])
    }).observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit)
  })

/**
 * Read and clear what the recorder saw. Only long tasks and Event Timing entries that start at or
 * after the latest key mark count: entries of the caret placement before it are delivered late.
 */
const takeSeen = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    const since = (w.__guardKeyAt as number | undefined) ?? 0
    const keep = (entries: Array<[number, number]>) =>
      entries.filter(([start]) => start >= since).map(([, d]) => d)
    const out = {
      seen: w.__guardSeen,
      long: keep(w.__guardPerf.long),
      events: keep(w.__guardPerf.events),
      longAt: (w.__guardPerf.long as Array<[number, number]>)
        .filter(([start]) => start >= since)
        .map(([start, d]) => [Math.round(start - since), Math.round(d)]),
    }
    w.__guardSeen = []
    w.__guardPerf = { long: [], events: [] }
    return out
  }) as Promise<{
    seen: Seen[]
    long: number[]
    events: number[]
    longAt: number[][]
  }>

/** Mark the key time; long tasks and events before it are not the gesture's. */
const markKey = (page: Page) =>
  page.evaluate(() => {
    ;(window as any).__guardKeyAt = performance.now()
  })

const seed = (page: Page) =>
  page.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL)
const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const host = async (page: Page) => (await hostStubState(page)).text

/** A collapsed caret `offset` characters into `needle`, placed through a real Shift gesture. */
async function textCaret(page: Page, needle: string, offset: number) {
  await page.evaluate(() => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
  })
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, 0] as const)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(150)
}

/** A collapsed caret at (`nth` UL, `offset`) or (surface, index of the `nth` child `tag`). */
async function elementCaret(
  page: Page,
  point:
    | { kind: 'ul'; nth: number; offset: number }
    | { kind: 'surface'; tag: string; nth: number },
): Promise<{ container: string; offset: number }> {
  await page.evaluate(() => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
  })
  await page.keyboard.press('Shift')
  return page.evaluate((p) => {
    const v = (window as any).vditor
    const root = v.vditor[v.getCurrentMode()].element as HTMLElement
    let node: Node
    let offset: number
    let container: string
    if (p.kind === 'ul') {
      node = root.querySelectorAll('ul')[p.nth] as Element
      offset = p.offset < 0 ? node.childNodes.length : p.offset
      container = `UL#${p.nth}`
    } else {
      const children = [...root.childNodes]
      const target = children.filter((c) => c.nodeName === p.tag.toUpperCase())[
        p.nth
      ]
      node = root
      offset = children.indexOf(target as ChildNode)
      container = 'SURFACE'
    }
    const r = document.createRange()
    r.setStart(node, offset)
    r.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(r)
    return { container, offset }
  }, point)
}

const liveCaret = (page: Page) =>
  page.evaluate(() => {
    const v = (window as any).vditor
    const surface = v.vditor[v.getCurrentMode()].element as HTMLElement
    const range = getSelection()?.getRangeAt(0)
    if (!range) return null
    const node = range.startContainer
    const el = node as Element
    return {
      caret: range.toString() === '',
      container:
        node === surface
          ? 'SURFACE'
          : node.nodeType === Node.ELEMENT_NODE
            ? `${el.tagName}#${[...surface.querySelectorAll(el.tagName)].indexOf(el)}`
            : 'TEXT',
      offset: range.startOffset,
      length: node.nodeType === Node.ELEMENT_NODE ? node.childNodes.length : -1,
    }
  })

type Key = 'Control+c' | 'Control+x'

/** Press `key` over the sentinel; return the before-event the page saw. */
async function press(page: Page, key: Key): Promise<Seen> {
  await seed(page)
  // Let the caret placement's own work finish before the gesture is measured.
  await page.waitForTimeout(500)
  await takeSeen(page)
  await markKey(page)
  await page.keyboard.press(key)
  const type = key === 'Control+c' ? 'beforecopy' : 'beforecut'
  await expect
    .poll(() =>
      page.evaluate(
        (t) => (window as any).__guardSeen.some((s: Seen) => s.type === t),
        type,
      ),
    )
    .toBe(true)
  return page.evaluate(
    (t) => (window as any).__guardSeen.find((s: Seen) => s.type === t),
    type,
  )
}

/** The text-caret control's Copy clipboard and Cut clipboard and host, each in a fresh page. */
async function control(page: Page, mode: Mode, needle: string) {
  await open(page, mode, FIXTURE)
  await textCaret(page, needle, 2)
  await press(page, 'Control+c')
  await expect.poll(() => clip(page)).not.toBe(SENTINEL)
  const copy = await clip(page)
  await open(page, mode, FIXTURE)
  await textCaret(page, needle, 2)
  await press(page, 'Control+x')
  await expect.poll(() => host(page)).not.toBe(FIXTURE)
  await page.waitForTimeout(500)
  return { copy, cutClip: await clip(page), cutHost: await host(page) }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  for (const edge of [
    {
      label: 'ArrowDown over a rule',
      from: 'KILO',
      at: 'KILO'.length,
      arrow: 'ArrowDown',
      line: 'item three DELTA',
      end: false,
    },
    {
      label: 'ArrowUp over a rule',
      from: 'Tail paragraph',
      at: 0,
      arrow: 'ArrowUp',
      line: 'item four ECHO',
      end: true,
    },
  ])
    test(`${mode}: ${edge.label} then collapsed Copy and Cut take exactly the edge line`, async ({
      page,
    }) => {
      const ctl = await control(page, mode, edge.line)
      expect(ctl.copy).toContain(edge.line)
      for (const key of ['Control+c', 'Control+x'] as const) {
        await open(page, mode, FIXTURE)
        await textCaret(page, edge.from, edge.at)
        await page.keyboard.press(edge.arrow)
        await page.waitForTimeout(300)
        const live = await liveCaret(page)
        expect(
          {
            caret: live?.caret,
            container: live?.container,
            atEdge: edge.end
              ? live?.offset === live?.length
              : live?.offset === 0,
          },
          'the arrow move left a collapsed caret at the list edge',
        ).toEqual({ caret: true, container: 'UL#1', atEdge: true })
        const seen = await press(page, key)
        expect(seen.container, 'the before-event saw the list edge').toBe(
          'UL#1',
        )
        if (key === 'Control+c') {
          await expect.poll(() => clip(page)).not.toBe(SENTINEL)
          expect(await clip(page)).toBe(ctl.copy)
          expect(await host(page)).toBe(FIXTURE)
        } else {
          await expect.poll(() => host(page)).not.toBe(FIXTURE)
          await page.waitForTimeout(500)
          expect(await clip(page)).toBe(ctl.cutClip)
          expect(await host(page)).toBe(ctl.cutHost)
        }
      }
    })

  test(`${mode}: an ambiguous element point keeps the clipboard and the document`, async ({
    page,
  }) => {
    for (const point of [
      { kind: 'ul', nth: 0, offset: 1 },
      { kind: 'surface', tag: 'ul', nth: 0 },
      { kind: 'surface', tag: 'hr', nth: 1 },
    ] as const)
      for (const key of ['Control+c', 'Control+x'] as const) {
        await open(page, mode, FIXTURE)
        const at = await elementCaret(page, point)
        const seen = await press(page, key)
        expect(
          { caret: seen.caret, container: seen.container, offset: seen.offset },
          `${JSON.stringify(point)} ${key}: the before-event saw the caret`,
        ).toEqual({ caret: true, ...at })
        await page.waitForTimeout(1000)
        expect(await clip(page), 'the sentinel is kept').toBe(SENTINEL)
        expect(await host(page), 'the document is unchanged').toBe(FIXTURE)
      }
  })

  test(`${mode}: controls (text caret, explicit selection) keep today's behaviour`, async ({
    page,
  }) => {
    await open(page, mode, FIXTURE)
    await textCaret(page, 'ALPHA', 2)
    await press(page, 'Control+c')
    await expect.poll(() => clip(page)).not.toBe(SENTINEL)
    expect(await clip(page)).toBe('Head paragraph ALPHA.')
    for (const key of ['Control+c', 'Control+x'] as const) {
      await open(page, mode, FIXTURE)
      await textCaret(page, 'ALPHA', 0)
      // A real Shift+Arrow selection: a scripted selection write is not a gesture, and the caret
      // authority restores its own caret over it.
      for (let i = 0; i < 'ALPHA'.length; i++)
        await page.keyboard.press('Shift+ArrowRight')
      await page.waitForTimeout(150)
      await press(page, key)
      await expect.poll(() => clip(page)).toBe('ALPHA')
      if (key === 'Control+x') {
        await expect.poll(() => host(page)).not.toBe(FIXTURE)
        await page.waitForTimeout(500)
        expect(await host(page)).toBe(
          FIXTURE.replace('Head paragraph ALPHA.', 'Head paragraph .'),
        )
      } else expect(await host(page)).toBe(FIXTURE)
    }
  })
}

/** The 50 ms overruns of one measured row; a missing before-event span is an overrun too. */
function overruns(
  label: string,
  r: { beforeEventMs: number; longTaskMaxMs: number; eventMaxMs: number },
): string[] {
  const out: string[] = []
  if (r.beforeEventMs < 0 || r.beforeEventMs >= BUDGET_MS)
    out.push(`${label}: before-event ${r.beforeEventMs} ms`)
  if (r.longTaskMaxMs >= BUDGET_MS)
    out.push(`${label}: long task ${r.longTaskMaxMs} ms`)
  if (r.eventMaxMs >= BUDGET_MS)
    out.push(`${label}: Event Timing ${r.eventMaxMs} ms`)
  return out
}

test('the guard keeps collapsed Copy and Cut within 50 ms at x1, x4 and x16', async ({
  page,
}) => {
  test.setTimeout(600_000)
  const rows: Array<Record<string, number | string | boolean>> = []
  const failures: string[] = []
  for (const factor of [1, 4, 16] as const) {
    const content = tableHeavyMarkdown(factor)
    await open(page, 'ir', content)
    let text = await host(page)
    const measure = async (
      row: string,
      gated: boolean,
      key: Key,
      place: () => Promise<unknown>,
      check: () => Promise<void>,
    ) => {
      await place()
      const seen = await press(page, key)
      await check()
      await page.waitForTimeout(1500)
      const perf = await takeSeen(page)
      const result = {
        factor,
        row,
        gated,
        beforeEventMs:
          seen.end < 0 ? -1 : Math.round((seen.end - seen.start) * 10) / 10,
        longTaskCount: perf.long.length,
        longTaskMaxMs: Math.round(Math.max(0, ...perf.long)),
        eventCount: perf.events.length,
        eventMaxMs: Math.round(Math.max(0, ...perf.events)),
        longTasksAt: JSON.stringify(perf.longAt),
      }
      rows.push(result)
      if (gated) failures.push(...overruns(`x${factor} ${row}`, result))
    }
    const declined = async () => {
      await page.waitForTimeout(1000)
      expect(await clip(page)).toBe(SENTINEL)
      expect(await host(page)).toBe(text)
    }
    const copied = (line: string) => async () => {
      await expect.poll(() => clip(page)).not.toBe(SENTINEL)
      expect(await clip(page)).toBe(line)
      expect(await host(page)).toBe(text)
    }
    const cut = (line: string) => async () => {
      const previous = text
      await expect.poll(() => host(page)).not.toBe(previous)
      await page.waitForTimeout(500)
      text = await host(page)
      expect(await clip(page)).toBe(line)
      expect(previous.includes(`- ${line}\n`)).toBe(true)
      expect(text.includes(`- ${line}\n`)).toBe(false)
      expect(text.length).toBeGreaterThan(previous.length - line.length - 8)
    }
    const ul = (offset: number) => () =>
      elementCaret(page, { kind: 'ul', nth: 0, offset })
    const at = (needle: string) => () => textCaret(page, needle, 2)

    await measure('declined copy UL,1', true, 'Control+c', ul(1), declined)
    await measure('declined cut UL,1', true, 'Control+x', ul(1), declined)
    await measure(
      'resolved copy UL,0',
      true,
      'Control+c',
      ul(0),
      copied('list item 1'),
    )
    await measure(
      'control copy text caret',
      false,
      'Control+c',
      at('list item 1'),
      copied('list item 1'),
    )
    await measure(
      'resolved cut UL,0',
      true,
      'Control+x',
      ul(0),
      cut('list item 1'),
    )
    await measure(
      'control cut text caret',
      false,
      'Control+x',
      at('list item 3'),
      cut('list item 3'),
    )
  }
  // Operation names and numbers only, never document text.
  console.log(`CLIPBOARD-GUARD-LATENCY ${JSON.stringify(rows)}`)
  expect(failures, 'every gated row stays within 50 ms').toEqual([])
})
