import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  DEFINITION_LINES,
  definitionHeavyMarkdown,
} from './definition-heavy-markdown'
import {
  docText,
  reopenVmdeFixture,
  settle,
  shippedSwitches,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 733 / 017 (task 017 section 6.8): reference definitions, footnotes and a table of contents keep
// the IR model live (DEFINITION_UNITS on). Typing in a referencing paragraph, a table cell, a list
// item, a definition and a footnote definition publishes deltas without whole-document work; the
// saved text keeps every definition where it was written; a label rename re-renders its references;
// a footnote edit updates its tooltip; a heading edit refreshes the TOC; Undo and Redo of a
// definition edit restore text and rendering; a multi-paragraph footnote still declines the model. The
// factor-16 timing rows are in `definition-units-probe.spec.ts`.
// The ToC option is on in every case. Counters and stats are numbers and reason names only.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: unknown[]) => Promise<unknown>

interface Counters {
  fullGetValue: number
  luteDocument: number
  legacyEditPosts: number
  deltaPosts: number
  fallbackPublications: number
  rootQueryAll: number
  historyDeltaPosts: number
}
interface ModelStats {
  state: string
  offReason?: string
}

const FIXTURE = definitionHeavyMarkdown(1)

async function setToc(evaluate: Evaluate, on: boolean): Promise<void> {
  await evaluate(
    async (vscode: typeof import('vscode'), args: unknown[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'markdown.toc',
          args[0] ? true : undefined,
          vscode.ConfigurationTarget.Global,
        )
    },
    [on],
  )
}

async function open(
  workbox: Page,
  evaluate: Evaluate,
  baseDir: string,
  name: string,
  text: string,
  live = true,
): Promise<{ frame: Frame; file: string }> {
  // The ToC option is off by default; every case needs the TOC block rendered (reset after each case).
  await setToc(evaluate, true)
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  const frame = (await reopenVmdeFixture(
    evaluate as never,
    workbox,
    file,
  )) as Frame
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the definition-units editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  // Task 733 / 024: a live open needs definition units; the test skips while they ship off. The
  // whole-text case (live = false) holds in both states and keeps no guard.
  if (live)
    test.skip(
      !(await shippedSwitches(frame)).definitionUnits,
      'definition units ship off',
    )
  if (live)
    await expect
      .poll(async () => (await modelStats(frame))?.state, {
        timeout: 90_000,
        message: 'the IR model is live over a document with definitions',
      })
      .toBe('live')
  return { frame, file }
}

const modelStats = (frame: Frame): Promise<ModelStats | undefined> =>
  frame.locator('body').evaluate(() => {
    const s = (window as unknown as { __vmdeModelShadowStats?: ModelStats })
      .__vmdeModelShadowStats
    return s ? { state: s.state, offReason: s.offReason } : undefined
  })

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, n) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(n as number)
  }, length)

const counters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      luteDocument: c.luteDocument,
      legacyEditPosts: c.legacyEditPosts,
      deltaPosts: c.deltaPosts,
      fallbackPublications: c.fallbackPublications,
      rootQueryAll: c.rootQueryAll,
      historyDeltaPosts: c.historyDeltaPosts,
    }
  })

/**
 * Caret at the end of the last text (trailing line feeds excluded) of the first element under the IR
 * root that matches `selector` and holds `needle`.
 */
async function caretAfter(frame: Frame, selector: string, needle: string) {
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(
    (_body, [sel, text]) => {
      const root = document.querySelector<HTMLElement>(
        '.vditor-ir .vditor-reset',
      )
      const target = Array.from(
        root?.querySelectorAll<HTMLElement>(sel as string) ?? [],
      ).find((el) => (el.textContent ?? '').includes(text as string))
      if (!root || !target) return false
      target.scrollIntoView({ block: 'center' })
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if ((n.textContent ?? '').replace(/\n+$/u, '') !== '') last = n as Text
      if (!last) return false
      const range = document.createRange()
      range.setStart(last, (last.textContent ?? '').replace(/\n+$/u, '').length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      root.focus({ preventScroll: true })
      return true
    },
    [selector, needle],
  )
  expect(placed, `caret placed after "${needle}" in ${selector}`).toBe(true)
}

/** Count of rendered link references inside the top-level block that holds `needle`. */
const linkRefsIn = (frame: Frame, needle: string): Promise<number> =>
  frame.locator('body').evaluate((_body, text) => {
    const root = document.querySelector('.vditor-ir .vditor-reset')
    const block = Array.from(root?.children ?? []).find((el) =>
      (el.textContent ?? '').includes(text as string),
    )
    return block?.querySelectorAll('[data-type="link-ref"]').length ?? -1
  }, needle)

test.describe('definition units (task 733 / 017)', () => {
  test.afterEach(async ({ evaluateInVSCode }) => {
    await setToc(evaluateInVSCode as Evaluate, false)
  })

  test('the model is live with definition, footnote and toc blocks in source order', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-live.md',
      FIXTURE,
    )
    const types = await frame
      .locator('body')
      .evaluate(() =>
        Array.from(
          document.querySelector('.vditor-ir .vditor-reset')?.children ?? [],
          (el) => el.getAttribute('data-type') ?? el.tagName.toLowerCase(),
        ),
      )
    expect(types).toContain('toc-block')
    expect(types.filter((t) => t === 'footnotes-block')).toHaveLength(2)
    // The mid-document definition sits before the first table, the tail one after it.
    const defs = types.flatMap((t, i) =>
      t === 'link-ref-defs-block' ? [i] : [],
    )
    expect(defs).toHaveLength(2)
    expect(defs[0]).toBeLessThan(types.indexOf('table'))
    expect((await modelStats(frame))?.offReason).toBeUndefined()
  })

  for (const [name, selector, needle] of [
    ['a referencing paragraph', '.vditor-reset > p', 'First paragraph'],
    ['a table cell', 'td', 'see '],
    ['a list item', 'li', 'list item 1 with'],
    ['a definition', '[data-type="link-ref-defs-block"]', '[guide]'],
    [
      'a footnote definition',
      '[data-type="footnotes-def"] p',
      'The first note.',
    ],
  ] as const) {
    test(`typing in ${name} publishes deltas without whole-document work`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const { frame, file } = await open(
        workbox,
        evaluateInVSCode as Evaluate,
        baseDir,
        `du-type-${name.replace(/\W+/gu, '-')}.md`,
        FIXTURE,
      )
      await caretAfter(frame, selector, needle)
      await resetCounters(frame, FIXTURE.length)
      await workbox.keyboard.type('q', { delay: 80 })
      await settle(frame, 800)
      const first = await counters(frame)
      await workbox.keyboard.type('rs', { delay: 80 })
      await settle(frame, 1500)
      const after = await counters(frame)
      expect(after.deltaPosts).toBeGreaterThanOrEqual(1)
      expect(after.luteDocument).toBe(0)
      expect(after.fullGetValue).toBe(0)
      expect(after.legacyEditPosts).toBe(0)
      expect(after.fallbackPublications).toBe(0)
      // Recorded, not asserted (design A-17, run 1 triage 4.4): the per-key root queries come from consumers
      // that design 13.16 exempts or no task migrated, in plain IR documents as well.
      test.info().annotations.push({
        type: 'rootQueryAll growth after the first key',
        description: String(after.rootQueryAll - first.rootQueryAll),
      })
      // Only the typed characters changed; every definition stays where it was written, with its title.
      const saved = await docText(evaluateInVSCode as never, file)
      expect(saved.length).toBe(FIXTURE.length + 3)
      expect(saved).toContain('qrs')
      expect(saved).toContain(DEFINITION_LINES.spec)
      expect(saved.indexOf('[guide]: ')).toBe(FIXTURE.indexOf('[guide]: '))
      expect((await modelStats(frame))?.state).toBe('live')
    })
  }

  test('renaming a definition label re-renders the paragraph that references it', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-rename.md',
      FIXTURE,
    )
    expect(await linkRefsIn(frame, 'First paragraph')).toBe(1)
    // Caret after `[guide` (before the closing bracket); one more character renames the label.
    await caretAfter(frame, '[data-type="link-ref-defs-block"]', '[guide]')
    for (let i = 0; i < ']: https://example.com/guide'.length; i++)
      await workbox.keyboard.press('ArrowLeft')
    await workbox.keyboard.type('x', { delay: 80 })
    await settle(frame, 1500)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain('[guidex]: https://example.com/guide')
    await expect.poll(() => linkRefsIn(frame, 'First paragraph')).toBe(0)
    expect((await counters(frame)).fallbackPublications).toBe(0)
  })

  test('editing a footnote definition updates its tooltip and keeps the numbers', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-footnote.md',
      FIXTURE,
    )
    const reference = (label: string) =>
      frame.locator('body').evaluate((_body, l) => {
        const sup = document.querySelector(
          `.vditor-ir sup[data-footnotes-label="${l}"]`,
        )
        return {
          tooltip: sup?.getAttribute('aria-label') ?? '',
          number: sup?.querySelector('[data-render]')?.textContent ?? '',
        }
      }, label)
    const before = await reference('^note')
    await caretAfter(frame, '[data-type="footnotes-def"] p', 'The first note.')
    await workbox.keyboard.type(' More', { delay: 80 })
    await settle(frame, 1500)
    await expect
      .poll(async () => (await reference('^note')).tooltip)
      .toContain('More')
    expect((await reference('^note')).number).toBe(before.number)
    expect((await reference('^two')).number).not.toBe(before.number)
  })

  test('a heading edit refreshes the TOC and leaves the [toc] line unchanged', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-toc.md',
      FIXTURE,
    )
    await caretAfter(frame, '.vditor-reset > h2', 'Items')
    await workbox.keyboard.type('Z', { delay: 80 })
    await settle(frame, 2500)
    await expect
      .poll(() =>
        frame
          .locator('.vditor-ir [data-type="toc-block"]')
          .first()
          .textContent(),
      )
      .toContain('ItemsZ')
    const saved = await docText(evaluateInVSCode as never, file)
    expect(saved).toContain('\n\n[toc]\n\n# Overview')
    expect(saved).toContain('## ItemsZ')
    expect((await counters(frame)).fallbackPublications).toBe(0)
  })

  test('Undo and Redo of a definition edit restore the text and the reference rendering', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-undo.md',
      FIXTURE,
    )
    await caretAfter(frame, '[data-type="link-ref-defs-block"]', '[guide]')
    for (let i = 0; i < ']: https://example.com/guide'.length; i++)
      await workbox.keyboard.press('ArrowLeft')
    await resetCounters(frame, FIXTURE.length)
    await workbox.keyboard.type('x', { delay: 80 })
    await settle(frame, 1500)
    await expect.poll(() => linkRefsIn(frame, 'First paragraph')).toBe(0)
    await workbox.keyboard.press('Control+z')
    await settle(frame, 1500)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(FIXTURE)
    await expect.poll(() => linkRefsIn(frame, 'First paragraph')).toBe(1)
    await workbox.keyboard.press('Control+y')
    await settle(frame, 1500)
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toContain('[guidex]: ')
    await expect.poll(() => linkRefsIn(frame, 'First paragraph')).toBe(0)
    expect((await counters(frame)).historyDeltaPosts).toBeGreaterThanOrEqual(1)
  })

  test('a multi-paragraph footnote keeps the whole-text path (scan-declined)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text =
      'See [^1].\n\n[^1]: First paragraph of the note.\n\n    Second paragraph of the note.\n\nTail.\n'
    const { frame } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'du-declined.md',
      text,
      false,
    )
    await expect
      .poll(async () => (await modelStats(frame))?.offReason, {
        timeout: 30_000,
      })
      .toBe('scan-declined')
  })
})
