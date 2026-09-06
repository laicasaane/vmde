import { wf } from './webview-helpers'
// Edit-cycle MONITOR for diagram rendering — the regression net that was missing.
//
// Earlier diagram specs were "open → assert the final state" snapshots; they could not catch a
// diagram that renders fine at OPEN but breaks (shrinks / errors / vanishes) when its source is
// EDITED. The flowchart-shrink bug (svg 179→79px wide after an edit, because flowchart.js measures
// text and the task-161 defer re-rendered it into a still-display:none child) slipped through exactly
// that gap. This spec drives a REAL keystroke edit through the debounce→settle→swap cycle and watches
// the three things that regress there:
//   1. size jump      — the live diagram must not shrink/collapse vs its initial render,
//   2. error          — a valid edit must NOT show an error box; an invalid one MUST, then recover,
//   3. renders        — the diagram (svg) is actually present after the edit.
// Real VS Code only (the overlay/defer + flowchart text-measure happen only in the custom editor).
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'diagram-edit-monitor.md')

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (fn: unknown, args: unknown) => Promise<unknown>,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const [uri] = args
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // Give the nested webview iframe PAGE-LEVEL keyboard focus before typing (click the editor's
  // top-left margin, clear of the diagram). placeCaretAfter() only does a DOM-level source.focus();
  // keyboard.type() dispatches to the top Electron window, so without this the keystrokes race the
  // focus and drop non-deterministically. Harness focus fix, not product behaviour.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  return frame
}

// Measure the LIVE (non-overlay) render of one engine: its `.language-X` wrapper REGION + the svg.
async function measure(frame: ReturnType<typeof wf>, langClass: string) {
  // NB: locator.evaluate passes the ELEMENT as the 1st param, the arg as the 2nd (memory:
  // plantuml-engine-type-stickiness) — so the langClass is `cls`, NOT the first param.
  return frame.locator('body').evaluate((_el, cls) => {
    const wrap = Array.from(
      document.querySelectorAll(`.vditor-ir__preview .${cls}`),
    ).filter((w) => !w.closest('.vmde-stale-overlay'))[0] as
      | HTMLElement
      | undefined
    const svg = wrap?.querySelector('svg') as SVGElement | null
    const rect = (el: Element | null | undefined) =>
      el
        ? {
            w: Math.round(el.getBoundingClientRect().width),
            h: Math.round(el.getBoundingClientRect().height),
          }
        : null
    return {
      region: rect(wrap),
      svg: rect(svg),
      hasSvg: !!svg,
      hasError: !!document.querySelector(
        '.vditor-ir__preview .vmde-diagram-error',
      ),
    }
  }, langClass)
}

async function waitForStableRender(
  frame: ReturnType<typeof wf>,
  langClass: string,
) {
  let previous = ''
  await expect
    .poll(async () => {
      const current = await measure(frame, langClass)
      const serialized = JSON.stringify(current)
      const stable =
        current.hasSvg &&
        !current.hasError &&
        (current.svg?.h ?? 0) > 0 &&
        serialized === previous
      previous = serialized
      return stable
    })
    .toBe(true)
}

// Expand the engine's IR node and drop the caret right after `anchor` in its editable source.
async function placeCaretAfter(
  frame: ReturnType<typeof wf>,
  lang: string,
  anchor: string,
) {
  return frame.locator('body').evaluate(
    (_el, { lang, anchor }) => {
      const code = Array.from(
        document.querySelectorAll('.vditor-ir__marker--pre code'),
      ).find((c) => c.className.includes(`language-${lang}`))
      const node = code?.closest('.vditor-ir__node') as HTMLElement | null
      if (!node) return false
      node.classList.add('vditor-ir__node--expand')
      const source = node.querySelector(
        '.vditor-ir__marker--pre',
      ) as HTMLElement | null
      if (!source) return false
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
      let target: Text | null = null
      let n = walker.nextNode() as Text | null
      while (n) {
        if (n.textContent?.includes(anchor)) {
          target = n
          break
        }
        n = walker.nextNode() as Text | null
      }
      if (!target) return false
      const idx = (target.textContent ?? '').indexOf(anchor) + anchor.length
      source.focus({ preventScroll: true })
      const r = document.createRange()
      r.setStart(target, idx)
      r.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      return true
    },
    { lang, anchor },
  )
}

async function selectSourceText(
  frame: ReturnType<typeof wf>,
  lang: string,
  target: string,
) {
  return frame.locator('body').evaluate(
    (_el, { lang, target }) => {
      const code = Array.from(
        document.querySelectorAll('.vditor-ir__marker--pre code'),
      ).find((candidate) => candidate.className.includes(`language-${lang}`))
      const source = code?.closest<HTMLElement>('.vditor-ir__marker--pre')
      if (!source) return false
      source.focus({ preventScroll: true })
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(target)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + target.length)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      }
      return false
    },
    { lang, target },
  )
}

// rAF-sample the live svg height across the whole cycle (catches a mid-edit collapse the
// before/after snapshots would miss).
async function startSampling(frame: ReturnType<typeof wf>, langClass: string) {
  await frame.locator('body').evaluate((_el, cls) => {
    const w = window as unknown as Record<string, unknown>
    w.__samples = []
    w.__sampling = true
    const tick = () => {
      if (!w.__sampling) return
      const wrap = Array.from(
        document.querySelectorAll(`.vditor-ir__preview .${cls}`),
      ).filter((x) => !x.closest('.vmde-stale-overlay'))[0] as
        | HTMLElement
        | undefined
      const svg = wrap?.querySelector('svg') as SVGElement | null
      ;(w.__samples as number[]).push(
        svg ? Math.round(svg.getBoundingClientRect().height) : 0,
      )
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, langClass)
}

async function stopSampling(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    w.__sampling = false
    const arr = (w.__samples as number[]).filter((x) => x > 0)
    return {
      min: arr.length ? Math.min(...arr) : 0,
      max: arr.length ? Math.max(...arr) : 0,
      n: arr.length,
    }
  })
}

const settle = (frame: ReturnType<typeof wf>, ms: number) =>
  frame
    .locator('body')
    .evaluate((_el, d) => new Promise((r) => setTimeout(r, d)), ms)

// 1. SIZE STABILITY — flowchart (the regression). A valid edit must keep it rendered at full size and
// never collapse mid-cycle. RED before the fix: svg shrank 412→282 (boxes to ~0-width via getBBox).
test('flowchart: a valid edit keeps it full-size (no shrink, no collapse, no error)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = await open(workbox, evaluateInVSCode)
  await frame
    .locator('.vditor-ir__preview .language-flowchart svg')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForStableRender(frame, 'language-flowchart')

  const before = await measure(frame, 'language-flowchart')
  // eslint-disable-next-line no-console
  console.log(`[monitor flowchart] before ${JSON.stringify(before)}`)
  expect(before.hasSvg).toBe(true)
  expect(before.svg?.h ?? 0).toBeGreaterThan(40)

  await startSampling(frame, 'language-flowchart')
  expect(await placeCaretAfter(frame, 'flowchart', 'Start')).toBe(true)
  await workbox.keyboard.type('XYZ', { delay: 40 })
  // task 512: retain — this is an observation window, not a positive completion wait. Sampling
  // must remain active long enough to catch a transient mid-edit collapse before the final render.
  await settle(frame, 4000)
  const samples = await stopSampling(frame)
  const after = await measure(frame, 'language-flowchart')
  // eslint-disable-next-line no-console
  console.log(
    `[monitor flowchart] after ${JSON.stringify(after)} samples ${JSON.stringify(samples)}`,
  )

  expect(after.hasSvg, 'flowchart lost its svg after edit').toBe(true)
  expect(after.hasError, 'a valid flowchart edit showed an error box').toBe(
    false,
  )
  expect(
    after.svg?.h ?? 0,
    `flowchart shrank after edit: ${before.svg?.h} → ${after.svg?.h}`,
  ).toBeGreaterThanOrEqual(Math.round((before.svg?.h ?? 0) * 0.85))
  expect(
    samples.min,
    `flowchart collapsed mid-edit (min ${samples.min} vs baseline ${before.svg?.h})`,
  ).toBeGreaterThanOrEqual(Math.round((before.svg?.h ?? 0) * 0.5))
})

// 2. SIZE STABILITY — graphviz (control). A non-measuring SVG engine that renders fine while hidden;
// proves the monitor generalises and that the cover-mode change didn't regress the deferred path.
test('graphviz: a valid edit keeps it full-size (no shrink, no collapse, no error)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const frame = await open(workbox, evaluateInVSCode)
  await frame
    .locator('.vditor-ir__preview .language-graphviz svg')
    .first()
    .waitFor({ timeout: 60_000 })
  await waitForStableRender(frame, 'language-graphviz')

  const before = await measure(frame, 'language-graphviz')
  // eslint-disable-next-line no-console
  console.log(`[monitor graphviz] before ${JSON.stringify(before)}`)
  expect.soft(before.hasSvg).toBe(true)
  expect.soft(before.svg?.h ?? 0).toBeGreaterThan(40)

  await startSampling(frame, 'language-graphviz')
  expect.soft(await placeCaretAfter(frame, 'graphviz', 'alpha')).toBe(true)
  await workbox.keyboard.type('XYZ', { delay: 40 })
  // task 512: retain — same transient-collapse observation window as the flowchart case above.
  await settle(frame, 4000)
  const samples = await stopSampling(frame)
  const after = await measure(frame, 'language-graphviz')
  // eslint-disable-next-line no-console
  console.log(
    `[monitor graphviz] after ${JSON.stringify(after)} samples ${JSON.stringify(samples)}`,
  )

  expect.soft(after.hasSvg).toBe(true)
  expect.soft(after.hasError).toBe(false)
  expect
    .soft(
      after.svg?.h ?? 0,
      `graphviz shrank after edit: ${before.svg?.h} → ${after.svg?.h}`,
    )
    .toBeGreaterThanOrEqual(Math.round((before.svg?.h ?? 0) * 0.85))
  expect
    .soft(samples.min)
    .toBeGreaterThanOrEqual(Math.round((before.svg?.h ?? 0) * 0.5))
  // break it: type DOT garbage after a node name
  expect.soft(await placeCaretAfter(frame, 'graphviz', 'gamma')).toBe(true)
  const GARBAGE = ' @@@bad'
  await workbox.keyboard.type(GARBAGE, { delay: 40 })
  await frame
    .locator('.vditor-ir__preview .vmde-diagram-error')
    .first()
    .waitFor({ timeout: 30_000 })
  const broken = await measure(frame, 'language-graphviz')
  // eslint-disable-next-line no-console
  console.log(`[monitor recover] broken ${JSON.stringify(broken)}`)
  expect
    .soft(broken.hasError, 'invalid graphviz did not show the error box')
    .toBe(true)

  // recover: delete the garbage we typed (caret is right after it) → valid again
  expect.soft(await selectSourceText(frame, 'graphviz', GARBAGE)).toBe(true)
  await workbox.keyboard.press('Backspace')
  await expect
    .poll(async () => {
      const current = await measure(frame, 'language-graphviz')
      return (
        current.hasSvg &&
        !current.hasError &&
        (current.svg?.h ?? 0) >= Math.round((before.svg?.h ?? 0) * 0.85)
      )
    })
    .toBe(true)
    .catch(() => {
      // Preserve the detailed recovery assertions below on a red run.
    })
  const recovered = await measure(frame, 'language-graphviz')
  // eslint-disable-next-line no-console
  console.log(`[monitor recover] recovered ${JSON.stringify(recovered)}`)

  expect
    .soft(recovered.hasError, 'error box lingered after the source was fixed')
    .toBe(false)
  expect
    .soft(recovered.hasSvg, 'diagram did not re-render after recovery')
    .toBe(true)
  expect
    .soft(
      recovered.svg?.h ?? 0,
      `recovered graphviz smaller than before: ${before.svg?.h} → ${recovered.svg?.h}`,
    )
    .toBeGreaterThanOrEqual(Math.round((before.svg?.h ?? 0) * 0.85))
})
