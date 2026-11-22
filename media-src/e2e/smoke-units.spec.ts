import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CDPSession, Locator, Page } from '@playwright/test'
import { definitionHeavyMarkdown } from '../../test/vscode-e2e/definition-heavy-markdown'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'
import {
  type HostStubCounters,
  type HostStubOp,
  hostStubCounters,
  hostStubState,
  installHostStub,
  releaseRebind,
  requestFlush,
} from './helpers/host-stub'
import { tableHeavyMarkdown } from '../../test/vscode-e2e/table-heavy-markdown'
import { UNIQUE_PROSE_TOKEN } from '../../test/vscode-e2e/find-replace-fixture-helpers'

// Task 733 / 024 (plan D-14 section 4.1): the smoke stage. The page runs the real webview entry
// (main.ts) with Vditor built from source and the build patches applied, bundled by the e2e server
// with a chosen set of unit switches on (`/smoke/<set>.html`). The host stub keeps the host text,
// applies the `edit`, `edit-delta` and `history-delta` posts as the host does, answers a `rebind`
// request once, and resynchronizes on a mismatch, so a delta the host would refuse shows as a resync.
//
// Run: `npm --prefix media-src run test:e2e -- smoke-units --workers=1`.
// Tasks 019, 020 and 021 add their describe blocks at the end of this file, on their own sets.

const DOC = [
  '# Smoke heading',
  '',
  'Alpha bravo charlie.',
  '',
  '| a | b |',
  '| - | - |',
  '| cellA | cellB |',
  '',
  '- item one',
  '- item two',
  '',
  '```js',
  'const echo = 1',
  '```',
  '',
  'Tail para.',
  '',
].join('\n')

type Mode = 'ir' | 'wysiwyg' | 'sv'

// Undo and Redo are VS Code commands: the keybinding shim posts their routes as the host would.
const HISTORY_COMMANDS = ['vmde.format.undo', 'vmde.format.redo']
// The idle publication and the model's follow-up run after the typing settles. A counter that stays
// 0 after this wait proves its path did not run (not that it had not run yet).
const SETTLE_MS = 1000

/** Opens `/smoke/<set>.html` on the fixture with the host stub, in IR, with the shim installed. */
async function openSmoke(page: Page, set: string): Promise<void> {
  await installHostStub(page, {
    content: DOC,
    options: { showToolbar: true, defaultMode: 'ir' },
  })
  // VS Code's webview preload blocks the browser default of Ctrl+Z and Ctrl+Y (the workbench owns them).
  await page.addInitScript(() => {
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if ([90, 89].includes(event.keyCode)) event.preventDefault()
    })
  })
  await page.goto(`/smoke/${set}.html`)
  await page.waitForFunction(
    () => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === 'ir'
      )
    },
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(
    (commands) => (window as any).__installKeybindingShim(commands),
    HISTORY_COMMANDS,
  )
}

/** The model's state and served mode (kinds only); `null` stands for an absent mode. */
const shadow = (page: Page) =>
  page.evaluate(() => {
    const stats = (window as any).__vmdeModelShadowStats as
      | { state: string; mode?: string }
      | undefined
    return stats ? { state: stats.state, mode: stats.mode ?? null } : null
  })

async function switchMode(page: Page, mode: Mode): Promise<void> {
  await page.evaluate((m) => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>(`button[data-mode="${m}"]`)
      ?.click()
  }, mode)
  await expect(page.locator(`.vditor-${mode}`)).toBeVisible()
}

/** Focuses the surface and puts a caret `offset` characters into the first `needle`. */
async function caretIn(page: Page, needle: string, offset: number) {
  await page.evaluate(async () => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  // A bare Shift press is a real gesture: it retires a live caret intent and does nothing else.
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, 0] as const)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(150)
}

const resetCounters = (page: Page) =>
  page.evaluate(
    (length) => (window as any).__vmdeEditCounters.reset(length),
    DOC.length,
  )

const readCounters = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).__vmdeEditCounters
    return {
      legacyEditPosts: c.legacyEditPosts as number,
      luteDocument: c.luteDocument as number,
      deltaPosts: c.deltaPosts as number,
    }
  })

/** The fixture with `key` inserted `offset` characters into the first `needle`. */
function typedInto(needle: string, offset: number, key: string): string {
  const at = DOC.indexOf(needle)
  if (at < 0) throw new Error(`needle not in the fixture: ${needle}`)
  return DOC.slice(0, at + offset) + key + DOC.slice(at + offset)
}

const stubText = async (page: Page) => (await hostStubState(page)).text

// One key per unit kind, each on a fresh page so its edit is the page's first.
const UNITS = [
  { name: 'paragraph', needle: 'Alpha bravo charlie.', offset: 5 },
  { name: 'cell', needle: 'cellB', offset: 2 },
  { name: 'list item', needle: 'item two', offset: 4 },
  { name: 'code block', needle: 'const echo = 1', offset: 5 },
] as const

test.describe('IR, all switches off', () => {
  test.describe.configure({ timeout: 90_000 })

  test('the model is live in IR after open', async ({ page }) => {
    await openSmoke(page, 'none')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    expect((await hostStubState(page)).text).toBe(DOC)
  })

  test('mode switches turn the model off in WYSIWYG and Source and back on in IR', async ({
    page,
  }) => {
    await openSmoke(page, 'none')
    // Task 733 / 020 (Q-181, recorded edit): this case asserts WYSIWYG units off. When the build ships
    // them on, the WYSIWYG block below covers the switches, so the case skips.
    const switches = await page.evaluate(
      () => (window as any).__vmdeE2EReadiness?.switches,
    )
    expect(switches, 'the shipped switches are recorded').toBeDefined()
    test.skip(switches.wysiwygUnits, 'WYSIWYG units ship on')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'wysiwyg')
    await expect.poll(() => shadow(page)).toEqual({ state: 'off', mode: null })
    expect((await hostStubState(page)).resyncs).toBe(0)
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'off', mode: null })
    expect((await hostStubState(page)).resyncs).toBe(0)
    await switchMode(page, 'ir')
    // After the re-entry the model waits for the host bytes: the first IR post asks for a rebind, the
    // stub answers it once (024-A1), and the model is live again.
    const unit = UNITS[0]
    await caretIn(page, unit.needle, unit.offset)
    await page.keyboard.type('W')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    const state = await hostStubState(page)
    // The re-entry post is whole text, which Vditor's serializer normalizes (the table delimiter row).
    expect(state.text).toContain(
      typedInto(unit.needle, unit.offset, 'W').split('\n')[2],
    )
    expect(state.rebinds).toBe(1)
    expect(state.resyncs).toBe(0)
  })

  test('the live DOM keeps the tagged code source and expands the caret node', async ({
    page,
  }) => {
    await openSmoke(page, 'none')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    const codes = page.locator('.vditor-ir .vditor-ir__marker--pre > code')
    await expect(codes).toHaveCount(1)
    await expect(codes.first()).toHaveClass(/\bhljs\b/)
    const heading = page.locator('.vditor-ir h1')
    await heading.click()
    await expect(heading).toHaveClass(/vditor-ir__node--expand/)
  })

  for (const unit of UNITS) {
    test(`one key in a ${unit.name} posts a delta the host accepts`, async ({
      page,
    }) => {
      await openSmoke(page, 'none')
      await expect
        .poll(() => shadow(page))
        .toEqual({ state: 'live', mode: 'ir' })
      await caretIn(page, unit.needle, unit.offset)
      await resetCounters(page)
      await page.keyboard.type('W')
      const expected = typedInto(unit.needle, unit.offset, 'W')
      await expect.poll(() => stubText(page)).toBe(expected)
      await page.waitForTimeout(SETTLE_MS)
      const counters = await readCounters(page)
      expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
      expect(counters.luteDocument, 'luteDocument').toBe(0)
      expect(counters.deltaPosts, 'deltaPosts').toBeGreaterThanOrEqual(1)
      const state = await hostStubState(page)
      expect(state.text).toBe(expected)
      expect(state.resyncs).toBe(0)
    })
  }

  test('one Undo and one Redo of a paragraph key move the host text back and forth', async ({
    page,
  }) => {
    await openSmoke(page, 'none')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    const unit = UNITS[0]
    await caretIn(page, unit.needle, unit.offset)
    await page.keyboard.type('W')
    const expected = typedInto(unit.needle, unit.offset, 'W')
    await expect.poll(() => stubText(page)).toBe(expected)
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(() => stubText(page)).toBe(DOC)
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Control+KeyY')
    await expect.poll(() => stubText(page)).toBe(expected)
    await page.waitForTimeout(SETTLE_MS)
    expect((await hostStubState(page)).resyncs).toBe(0)
  })
})

// Task 733 / 019 (Q-154 to Q-161): the Source block, on `/smoke/source.html` (`SOURCE_UNITS` on). From
// the 019-E probes P1, P2, P3, P8, P11, P13 and P14. The host stub applies `history-transition` posts and
// can hold a rebind request (Q-161).

/** Opens `/smoke/<set>.html` on `content` with extra init options, in IR, with the history shim. */
async function openSourceSet(
  page: Page,
  set: string,
  content: string,
  options: Record<string, unknown> = {},
  holdRebind = false,
  refuseExact = false,
): Promise<void> {
  await installHostStub(page, {
    content,
    options: { showToolbar: true, defaultMode: 'ir', ...options },
    holdRebind,
    refuseExact,
  })
  await page.addInitScript(() => {
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if ([90, 89].includes(event.keyCode)) event.preventDefault()
    })
  })
  await page.goto(`/smoke/${set}.html`)
  await page.waitForFunction(
    () =>
      ((window as any).__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
      (window as any).vditor?.getCurrentMode?.() === 'ir',
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(
    (commands) => (window as any).__installKeybindingShim(commands),
    HISTORY_COMMANDS,
  )
}

/** Shows (true) or hides (false) the Split pane of Source. */
async function splitPane(page: Page, shown: boolean): Promise<void> {
  await page.evaluate((want) => {
    const pane = document.querySelector<HTMLElement>('.vditor-preview')
    const visible = !!pane && getComputedStyle(pane).display !== 'none'
    if (visible !== want)
      document
        .querySelector('.vditor-toolbar [data-type="both"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, shown)
}

/** The model text a switch out of Source would keep (`__vmdeModeSwitchText`); null when it declines. */
const ownedSourceText = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    return (w.__vmdeModeSwitchText?.(w.vditor.vditor, 'ir') as string) ?? null
  })

/** The Source text offset of the caret in `vditor.sv.element`; -1 without a caret there. */
const sourceCaret = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    const selection = window.getSelection()
    if (!selection?.rangeCount) return -1
    const range = selection.getRangeAt(0)
    if (!root.contains(range.startContainer)) return -1
    const before = document.createRange()
    before.setStart(root, 0)
    before.setEnd(range.startContainer, range.startOffset)
    return before.toString().length
  })

/** The Source text offset of `needle` plus `offset`. */
const sourceOffsetOf = (page: Page, needle: string, offset: number) =>
  page.evaluate(
    ([n, o]) => {
      const root = (window as any).vditor.vditor.sv.element as HTMLElement
      const at = (root.textContent ?? '').indexOf(n as string)
      return at < 0 ? -1 : at + (o as number)
    },
    [needle, offset] as const,
  )

const fullCounters = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).__vmdeEditCounters
    return {
      legacyEditPosts: c.legacyEditPosts as number,
      luteDocument: c.luteDocument as number,
      deltaPosts: c.deltaPosts as number,
      historyDeltaPosts: c.historyDeltaPosts as number,
      rootClone: c.rootClone as number,
      fallbackPublications: c.fallbackPublications as number,
    }
  })

test.describe('Source, SOURCE_UNITS on', () => {
  test.describe.configure({ timeout: 90_000 })

  test('IR, Source, IR, Source keep the model live and the owned text defined (C1)', async ({
    page,
  }) => {
    await openSourceSet(page, 'source', DOC)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await page.waitForTimeout(SETTLE_MS)
    expect(await ownedSourceText(page), 'owned text 1 s into Source').toBe(DOC)
    await switchMode(page, 'ir')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await resetCounters(page)
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    expect((await fullCounters(page)).luteDocument, 'luteDocument').toBe(0)
    await page.waitForTimeout(SETTLE_MS)
    expect(
      await ownedSourceText(page),
      'owned text after the second switch',
    ).toBe(DOC)
    const state = await hostStubState(page)
    expect(state.rebinds).toBe(0)
    expect(state.resyncs).toBe(0)
  })

  test('four keys, Undo and Redo go by deltas with no root clone, and the caret follows (C2, C3, 019-A2)', async ({
    page,
  }) => {
    await openSourceSet(page, 'source', DOC)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await caretIn(page, 'Alpha bravo charlie.', 5)
    const firstKey = await sourceOffsetOf(page, 'Alpha bravo charlie.', 5)
    await resetCounters(page)
    await page.keyboard.type('WXYZ', { delay: 60 })
    const typed = typedInto('Alpha bravo charlie.', 5, 'WXYZ')
    await expect.poll(() => stubText(page)).toBe(typed)
    await page.waitForTimeout(SETTLE_MS)
    let counters = await fullCounters(page)
    expect(counters.deltaPosts, 'deltaPosts').toBeGreaterThanOrEqual(1)
    expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
    expect(counters.rootClone, 'rootClone while typing').toBe(0)
    await resetCounters(page)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(() => stubText(page)).toBe(DOC)
    await page.waitForTimeout(SETTLE_MS)
    counters = await fullCounters(page)
    expect(
      counters.historyDeltaPosts,
      'historyDeltaPosts',
    ).toBeGreaterThanOrEqual(1)
    expect(counters.rootClone, 'rootClone on Undo').toBe(0)
    expect(await sourceCaret(page), 'caret after Undo').toBe(firstKey)
    await page.keyboard.press('Control+KeyY')
    await expect.poll(() => stubText(page)).toBe(typed)
    await page.waitForTimeout(SETTLE_MS)
    expect(await sourceCaret(page), 'caret after Redo').toBe(firstKey + 4)
    counters = await fullCounters(page)
    expect(counters.fallbackPublications, 'fallbackPublications').toBe(0)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(() => stubText(page)).toBe(DOC)
    await page.waitForTimeout(SETTLE_MS)
    // One key typed after Undo lands at the restored caret.
    await page.keyboard.type('Q')
    await expect
      .poll(() => stubText(page))
      .toBe(typedInto('Alpha bravo charlie.', 5, 'Q'))
    const state = await hostStubState(page)
    expect(state.resyncs).toBe(0)
    expect(state.rebinds).toBe(0)
  })

  test('Undo right after a switch into Source has nothing to undo (019-A7)', async ({
    page,
  }) => {
    await openSourceSet(page, 'source', DOC)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await caretIn(page, 'Alpha bravo charlie.', 5)
    await page.keyboard.type('W')
    const typed = typedInto('Alpha bravo charlie.', 5, 'W')
    await expect.poll(() => stubText(page)).toBe(typed)
    await page.waitForTimeout(SETTLE_MS)
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await caretIn(page, 'Tail para.', 4)
    await page.keyboard.press('Control+KeyZ')
    await page.waitForTimeout(SETTLE_MS)
    // The unit engine starts a new history in the mode entered: the IR key stays.
    expect(await stubText(page)).toBe(typed)
    expect((await hostStubState(page)).resyncs).toBe(0)
  })

  test('the Split pane keeps the block separators and morphs units after it opens (C5, C6)', async ({
    page,
  }) => {
    await openSourceSet(page, 'source', DOC)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'sv')
    await splitPane(page, true)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await page.waitForTimeout(SETTLE_MS)
    const paneText = () =>
      page.evaluate(
        () =>
          document.querySelector('.vditor-preview .vditor-reset')
            ?.textContent ?? '',
      )
    // A whole render writes a line break between top-level blocks.
    expect(await paneText()).toContain('Smoke heading\nAlpha bravo charlie.')
    await caretIn(page, 'Tail para.', 4)
    await page.evaluate(() => {
      const w = window as any
      const lute = w.vditor.vditor.lute
      const original = lute.Md2HTML.bind(lute)
      w.__smokeRenders = { morph: 0, whole: 0 }
      lute.Md2HTML = (markdown: string) => {
        const stack = new Error().stack ?? ''
        if (stack.includes('morphRange')) w.__smokeRenders.morph++
        else if (stack.includes('step')) w.__smokeRenders.whole++
        return original(markdown)
      }
    })
    await resetCounters(page)
    for (const key of 'abcdefghij') {
      await page.keyboard.type(key)
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(SETTLE_MS)
    const renders = await page.evaluate(() => (window as any).__smokeRenders)
    expect(renders.whole, 'whole-job unit renders after the pane opened').toBe(
      0,
    )
    expect(renders.morph, 'unit morphs').toBeGreaterThanOrEqual(1)
    expect((await fullCounters(page)).luteDocument, 'luteDocument').toBe(0)
    expect(await paneText()).toContain('Tailabcdefghij para.')
    expect(await paneText()).toContain('Smoke heading\nAlpha bravo charlie.')
  })

  test('the auto-wrap after a typed key is published with no exact read (C4)', async ({
    page,
  }) => {
    const original = 'alpha beta gamma delta epsilon\n\nTail.\n'
    await openSourceSet(page, 'source', original, {
      autoWrap: true,
      autoWrapDelay: 1000,
      wrapColumn: 12,
      reflowLineBreaks: false,
    })
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await caretIn(page, 'gamma', 5)
    await page.keyboard.type('z')
    await expect
      .poll(() => stubText(page), { timeout: 8_000 })
      .toBe('alpha beta\ngammaz delta\nepsilon\n\nTail.\n')
  })

  test('a manual Rewrap after one typed key is published (C4)', async ({
    page,
  }) => {
    const original = 'alpha beta gamma delta epsilon\n\nTail.\n'
    await openSourceSet(page, 'source', original, { wrapColumn: 12 })
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    await switchMode(page, 'sv')
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'sv' })
    await caretIn(page, 'gamma', 5)
    await page.keyboard.type('z')
    await expect
      .poll(() => stubText(page))
      .toBe(original.replace('gamma', 'gammaz'))
    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => (window as any).__vmdeRunRewrapForTest())
    await expect
      .poll(() => stubText(page))
      .toBe('alpha beta\ngammaz delta\nepsilon\n\nTail.\n')
  })

  test('Source model off: a key gives a whole-text post of the exact host bytes (C3 stop rule)', async ({
    page,
  }) => {
    await openSourceSet(page, 'source', DOC, {}, true)
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
    // An IR key left unpublished at the switch: the model does not keep the text, and the first post
    // in Source asks for a rebind, which the stub holds.
    await caretIn(page, 'Alpha bravo charlie.', 5)
    await page.keyboard.type('W')
    await switchMode(page, 'sv')
    await page.waitForTimeout(SETTLE_MS)
    const state = await hostStubState(page)
    expect(
      (await shadow(page))?.state,
      'the model is off after the switch',
    ).not.toBe('live')
    // The host holds the whole text the switch posted (it carries the IR key).
    expect(state.text).toContain('AlphaW bravo charlie.')
    await caretIn(page, 'Tail para.', 4)
    await page.keyboard.type('Q')
    // The first post in Source asks for a rebind, which the stub holds: the model stays off, and the
    // whole Source text is the host text plus the key.
    await expect
      .poll(() => stubText(page))
      .toBe(state.text.replace('Tail para.', 'TailQ para.'))
    const after = await hostStubState(page)
    expect(after.rebinds, 'rebind requests').toBeGreaterThanOrEqual(1)
    expect((await shadow(page))?.state, 'the held rebind').not.toBe('live')
  })

  // Q-160: typing at offset 0 of the front-matter open marker, on both sets. Equal bytes mean the
  // behaviour is the off build's own (a follow-up, not a 019 defect); a difference blocks the switch.
  test('a key at offset 0 of the front matter gives the same bytes on none and source (Q-160)', async ({
    browser,
  }) => {
    const doc = '---\ntitle: Smoke\n---\n\nBody para.\n'
    const texts: string[] = []
    for (const set of ['none', 'source'] as const) {
      const page = await browser.newPage()
      try {
        await openSourceSet(page, set, doc)
        await page.waitForTimeout(SETTLE_MS)
        await switchMode(page, 'sv')
        await page.waitForTimeout(SETTLE_MS)
        await caretIn(page, '---', 0)
        await page.keyboard.type('x')
        await page.waitForTimeout(SETTLE_MS)
        texts.push(await stubText(page))
      } finally {
        await page.close()
      }
    }
    expect(texts[0]).toContain('Body para.')
    expect(texts[1], 'source bytes equal the none bytes').toBe(texts[0])
  })
})

// Task 733 / 020 (design Q-164 to Q-168, review Q-171): the WYSIWYG block, on `/smoke/wysiwyg.html`
// (`WYSIWYG_UNITS` on), over `tableHeavyMarkdown(1)` with the places of `wysiwyg-units.spec.ts`. From the
// 020-E causes: W-A (the model reaches WYSIWYG at the switch), W-B (empty paragraph at a build), W-C (the
// unit engine holds WYSIWYG history), W-D (no root read per key) and W-E (Undo after a delta publishes).
// Logged values are counters and kinds only.

const WYSIWYG_DOC = tableHeavyMarkdown(1)
const WYSIWYG_ROOT = '.vditor-wysiwyg .vditor-reset'
const WYSIWYG_PLACES = {
  paragraph: { selector: `${WYSIWYG_ROOT} > p`, nth: 2 },
  cell: { selector: `${WYSIWYG_ROOT} > table td`, nth: 7 },
  item: { selector: `${WYSIWYG_ROOT} > ul > li`, nth: 2 },
} as const
type WysiwygPlace = keyof typeof WYSIWYG_PLACES

/** Opens `/smoke/wysiwyg.html` on `content` in IR and waits for the live IR model. */
async function openWysiwygSet(page: Page, content = WYSIWYG_DOC) {
  await openSourceSet(page, 'wysiwyg', content)
  await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
}

/** 020-A4: switches through the VMDE mode command (`vmde.switchTo*`), as the host posts it. */
async function modeCommand(page: Page, mode: 'ir' | 'wysiwyg') {
  await page.evaluate((m) => {
    window.postMessage(
      {
        command: 'editor-action',
        action: m === 'ir' ? 'switch-to-ir' : 'switch-to-wysiwyg',
      },
      '*',
    )
  }, mode)
  await expect(page.locator(`.vditor-${mode}`)).toBeVisible()
}

const twoFrames = (page: Page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 2; i++)
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })

/** The model text digest equals the stub text digest (FNV-1a over UTF-16 code units, as the page's). */
const modelMatchesStub = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    const text = w.__vmdeHostStub.text as string
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    const model = w.__vmdeModelTextDigest?.() as
      | { length: number; hash: number }
      | null
      | undefined
    return !!model && model.length === text.length && model.hash === hash >>> 0
  })

const wysiwygCounters = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).__vmdeEditCounters
    return {
      legacyEditPosts: c.legacyEditPosts as number,
      luteDocument: c.luteDocument as number,
      luteTable: c.luteTable as number,
      deltaPosts: c.deltaPosts as number,
      historyDeltaPosts: c.historyDeltaPosts as number,
      rootClone: c.rootClone as number,
      rootInnerHtmlRead: c.rootInnerHtmlRead as number,
    }
  })

const resetWysiwygCounters = (page: Page) =>
  page.evaluate(
    (length) => (window as any).__vmdeEditCounters.reset(length),
    WYSIWYG_DOC.length,
  )

const spunCount = (page: Page) =>
  page.evaluate(
    () => ((window as any).__vmdeUnitSpinStats?.spun as number) ?? 0,
  )

/** Clicks the right edge of the place, which puts the caret at the end of its text. */
async function caretAtPlaceEnd(page: Page, place: WysiwygPlace) {
  const { selector, nth } = WYSIWYG_PLACES[place]
  const target = page.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error(`${place} has no bounding box`)
  await target.click({
    position: { x: Math.max(1, box.width - 2), y: box.height / 2 },
  })
  await page.waitForTimeout(150)
}

/** Caret at the end of the first code line of the first fenced block (its source pre is hidden). */
async function caretInWysiwygCode(page: Page) {
  await page
    .locator('.vditor-wysiwyg')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await page.evaluate(() => {
    const code = document.querySelector(
      '.vditor-wysiwyg .vditor-reset > [data-type="code-block"] pre.vditor-wysiwyg__pre > code',
    )
    const source = code?.closest<HTMLElement>('.vditor-wysiwyg__pre')
    const text = code
      ? (document
          .createTreeWalker(code, NodeFilter.SHOW_TEXT)
          .nextNode() as Text | null)
      : null
    if (!source || !text) return false
    source.style.removeProperty('display')
    const newline = text.data.indexOf('\n')
    const range = document.createRange()
    range.setStart(text, newline < 0 ? text.data.length : newline)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    source.focus()
    return true
  })
  if (!placed) throw new Error('code block source not found')
}

/** The caret's text offset in the WYSIWYG root; -1 without a caret there. */
const wysiwygCaret = (page: Page) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector)
    const selection = window.getSelection()
    if (!root || !selection?.rangeCount) return -1
    const range = selection.getRangeAt(0)
    if (!root.contains(range.startContainer)) return -1
    const before = document.createRange()
    before.setStart(root, 0)
    before.setEnd(range.startContainer, range.startOffset)
    return before.toString().length
  }, WYSIWYG_ROOT)

/** The one inserted character of `after` against `before`, or -1 when the change is not one insert. */
function insertedAt(before: string, after: string): number {
  if (after.length !== before.length + 1) return -1
  let i = 0
  while (i < before.length && before[i] === after[i]) i++
  return after.slice(0, i) + after.slice(i + 1) === before ? i : -1
}

test.describe('WYSIWYG, WYSIWYG_UNITS on', () => {
  test.describe.configure({ timeout: 120_000 })

  test('1. IR to WYSIWYG with no key: live in WYSIWYG within two frames and equal to the host (W-A)', async ({
    page,
  }) => {
    await openWysiwygSet(page)
    await switchMode(page, 'wysiwyg')
    await twoFrames(page)
    expect(await shadow(page)).toEqual({ state: 'live', mode: 'wysiwyg' })
    expect(await modelMatchesStub(page), 'model digest equals the stub').toBe(
      true,
    )
  })

  // Task 733 / 020 (Q-184): a follow-up. The mode command's undo seed runs Vditor's old engine, whose
  // caret marker write dirties a WYSIWYG unit, so the switch back keeps no text. Fixme until it lands.
  test.fixme('2. WYSIWYG, IR, WYSIWYG (toolbar and mode command): live after each, no whole post (step d)', async ({
    page,
  }) => {
    await openWysiwygSet(page)
    await resetWysiwygCounters(page)
    await switchMode(page, 'wysiwyg')
    await expect
      .poll(() => shadow(page), { timeout: 2_000 })
      .toEqual({ state: 'live', mode: 'wysiwyg' })
    await modeCommand(page, 'ir')
    await expect
      .poll(() => shadow(page), { timeout: 2_000 })
      .toEqual({ state: 'live', mode: 'ir' })
    await modeCommand(page, 'wysiwyg')
    await expect
      .poll(() => shadow(page), { timeout: 2_000 })
      .toEqual({ state: 'live', mode: 'wysiwyg' })
    const counters = await wysiwygCounters(page)
    expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
    expect(counters.luteDocument, 'luteDocument').toBe(0)
    expect(await modelMatchesStub(page)).toBe(true)
  })

  for (const place of ['paragraph', 'cell', 'item', 'code block'] as const)
    test(`3. one key in a ${place} posts a delta of the key only (step b)`, async ({
      page,
    }) => {
      await openWysiwygSet(page)
      await switchMode(page, 'wysiwyg')
      await page.waitForTimeout(SETTLE_MS)
      if (place === 'code block') await caretInWysiwygCode(page)
      else await caretAtPlaceEnd(page, place)
      const before = await stubText(page)
      const spunBefore = await spunCount(page)
      await resetWysiwygCounters(page)
      await page.keyboard.press('x')
      await page.waitForTimeout(SETTLE_MS)
      const counters = await wysiwygCounters(page)
      expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
      expect(counters.luteDocument, 'luteDocument').toBe(0)
      expect(counters.deltaPosts, 'deltaPosts').toBeGreaterThanOrEqual(1)
      if (place === 'cell' || place === 'item')
        expect(await spunCount(page), 'unit spins').toBeGreaterThan(spunBefore)
      // The key only: no table padding, no other byte changed.
      expect(
        insertedAt(before, await stubText(page)),
        'one inserted character',
      ).toBeGreaterThanOrEqual(0)
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

  test('4. a cell key makes no table or document Lute call; a paragraph Backspace reads no root (step e, W-D)', async ({
    page,
  }) => {
    await openWysiwygSet(page)
    await switchMode(page, 'wysiwyg')
    await page.waitForTimeout(SETTLE_MS)
    await caretAtPlaceEnd(page, 'cell')
    await resetWysiwygCounters(page)
    await page.keyboard.press('x')
    await page.waitForTimeout(SETTLE_MS)
    const cell = await wysiwygCounters(page)
    expect(cell.luteTable, 'luteTable').toBe(0)
    expect(cell.luteDocument, 'luteDocument').toBe(0)
    await caretAtPlaceEnd(page, 'paragraph')
    await resetWysiwygCounters(page)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(SETTLE_MS)
    const paragraph = await wysiwygCounters(page)
    expect(paragraph.rootInnerHtmlRead, 'rootInnerHtmlRead').toBe(0)
    expect(paragraph.rootClone, 'rootClone').toBe(0)
  })

  for (const place of ['cell', 'item'] as const)
    test(`5. Undo and Redo of a ${place} key go by history deltas, with the bytes and the caret (step c, W-C, 020-A2)`, async ({
      page,
    }) => {
      await openWysiwygSet(page)
      await switchMode(page, 'wysiwyg')
      await page.waitForTimeout(SETTLE_MS)
      await caretAtPlaceEnd(page, place)
      const before = await stubText(page)
      const caretBefore = await wysiwygCaret(page)
      await page.keyboard.press('q')
      await page.waitForTimeout(SETTLE_MS)
      const typed = await stubText(page)
      const at = insertedAt(before, typed)
      expect(at, 'the key is one insert').toBeGreaterThanOrEqual(0)
      await resetWysiwygCounters(page)
      await page.keyboard.press('Control+KeyZ')
      await expect.poll(() => stubText(page)).toBe(before)
      await page.waitForTimeout(SETTLE_MS)
      expect(await wysiwygCaret(page), 'caret after Undo').toBe(caretBefore)
      await page.keyboard.press('Control+KeyY')
      await expect.poll(() => stubText(page)).toBe(typed)
      await page.waitForTimeout(SETTLE_MS)
      expect(await wysiwygCaret(page), 'caret after Redo').toBe(caretBefore + 1)
      const counters = await wysiwygCounters(page)
      expect(
        counters.historyDeltaPosts,
        'historyDeltaPosts',
      ).toBeGreaterThanOrEqual(2)
      expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
      await page.keyboard.press('Control+KeyZ')
      await expect.poll(() => stubText(page)).toBe(before)
      await page.waitForTimeout(SETTLE_MS)
      // One key typed after Undo lands at the restored caret.
      await page.keyboard.press('r')
      await expect
        .poll(() => stubText(page))
        .toBe(`${before.slice(0, at)}r${before.slice(at)}`)
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

  test('5. Undo after a paragraph delta gives back the stub text from before it (W-E)', async ({
    page,
  }) => {
    await openWysiwygSet(page)
    await switchMode(page, 'wysiwyg')
    await page.waitForTimeout(SETTLE_MS)
    await caretAtPlaceEnd(page, 'paragraph')
    await page.keyboard.press('a')
    await page.waitForTimeout(SETTLE_MS)
    const before = await stubText(page)
    await page.keyboard.press('b')
    await page.waitForTimeout(SETTLE_MS)
    expect(insertedAt(before, await stubText(page))).toBeGreaterThanOrEqual(0)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(() => stubText(page)).toBe(before)
  })

  test('6. Enter at a paragraph end, then Undo and Redo: the model stays live (W-B)', async ({
    page,
  }) => {
    await openWysiwygSet(page)
    await switchMode(page, 'wysiwyg')
    await caretAtPlaceEnd(page, 'paragraph')
    // A key and Enter with no wait: the empty paragraph exists at the first build after the switch.
    await page.keyboard.press('a')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(SETTLE_MS)
    expect(await shadow(page), 'after Enter').toEqual({
      state: 'live',
      mode: 'wysiwyg',
    })
    await page.keyboard.press('Control+KeyZ')
    await page.waitForTimeout(SETTLE_MS)
    expect(await shadow(page), 'after Undo').toEqual({
      state: 'live',
      mode: 'wysiwyg',
    })
    await page.keyboard.press('Control+KeyY')
    await page.waitForTimeout(SETTLE_MS)
    expect(await shadow(page), 'after Redo').toEqual({
      state: 'live',
      mode: 'wysiwyg',
    })
    expect(await modelMatchesStub(page)).toBe(true)
  })

  // 020-E W3: one run in six lost a character. Six runs, each on a fresh page.
  const CODE_END = '# Head\n\nPara.\n\n```js\nconst a = 1\n```\n'
  const CODE_END_EXPECTED = '# Head\n\nPara.\n\n```js\nconst a = 1\nY\n```\n'
  for (let run = 1; run <= 6; run++)
    test(`7. Enter at the end of a document that ends in a code block, then a key (run ${run})`, async ({
      page,
    }) => {
      await openWysiwygSet(page, CODE_END)
      await switchMode(page, 'wysiwyg')
      await page.waitForTimeout(SETTLE_MS)
      await caretInWysiwygCode(page)
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.keyboard.type('Y')
      await expect.poll(() => stubText(page)).toBe(CODE_END_EXPECTED)
      expect(CODE_END_EXPECTED).toHaveLength(39)
    })
})

// Task 733 / 021 (design 021 section 7.4): definition units on `definitionHeavyMarkdown(1)` with the ToC
// option on. "The click" at (4, 4) of the IR surface is the first step of the real-VS-Code spec's caret
// placement; above the front matter it adds and removes a view-only gap paragraph, which makes the next
// sync a whole change (021-E T-1), so both paths stay covered.
test.describe('Definitions, DEFINITION_UNITS on', () => {
  test.describe.configure({ timeout: 90_000 })
  const FIXTURE = definitionHeavyMarkdown(1)

  async function openDefinitions(page: Page): Promise<void> {
    await openSourceSet(page, 'definition', FIXTURE, { markdownToc: true })
    await expect
      .poll(async () => (await shadow(page))?.state, { timeout: 30_000 })
      .toBe('live')
  }

  const proofsDone = (page: Page) =>
    expect
      .poll(
        () =>
          page.evaluate(() => {
            const s = (window as any).__vmdeModelShadowStats
            return s.proven === s.units
          }),
        { timeout: 30_000, message: 'every unit proven' },
      )
      .toBe(true)

  // Before the period: at the end of the text the caret resolves to the start of the next definition.
  const NOTE_CARET = 14

  const theClick = (page: Page) =>
    page
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })

  const resetFixtureCounters = (page: Page) =>
    page.evaluate(
      (length) => (window as any).__vmdeEditCounters.reset(length),
      FIXTURE.length,
    )

  const modelInfo = (page: Page) =>
    page.evaluate(() => {
      const s = (window as any).__vmdeModelShadowStats
      return {
        state: s.state as string,
        offReason: s.offReason as string | undefined,
        unprovenFallbacks: (s.fallbacks?.['unproven-unit'] ?? 0) as number,
        proven: s.proven as number,
        units: s.units as number,
      }
    })

  /** Rendered link references in the top-level block that holds `First paragraph`. */
  const linkRefs = (page: Page) =>
    page.evaluate(() => {
      const root = document.querySelector('.vditor-ir .vditor-reset')
      const block = Array.from(root?.children ?? []).find((el) =>
        (el.textContent ?? '').includes('First paragraph'),
      )
      return block?.querySelectorAll('[data-type="link-ref"]').length ?? -1
    })

  const footnoteRef = (page: Page, label: string) =>
    page.evaluate((l) => {
      const sup = document.querySelector(
        `.vditor-ir sup[data-footnotes-label="${l}"]`,
      )
      return {
        tooltip: sup?.getAttribute('aria-label') ?? '',
        number: sup?.querySelector('[data-render]')?.textContent ?? '',
      }
    }, label)

  const footnoteDefinitions = (page: Page) =>
    page.evaluate(
      () =>
        document.querySelector('.vditor-ir [data-type="footnotes-block"]')
          ?.children.length ?? -1,
    )

  /** Renames `[guide]` to `[guidex]` with one key before its closing bracket. */
  async function renameGuide(page: Page): Promise<void> {
    await caretIn(page, '[guide]: https', 6)
    await page.keyboard.type('x', { delay: 80 })
    await expect
      .poll(() => stubText(page))
      .toContain('[guidex]: https://example.com/guide')
  }

  test('the live DOM holds the definition, footnote and toc blocks in source order (guard)', async ({
    page,
  }) => {
    await openDefinitions(page)
    const types = await page.evaluate(() =>
      Array.from(
        document.querySelector('.vditor-ir .vditor-reset')?.children ?? [],
        (el) => el.getAttribute('data-type') ?? el.tagName.toLowerCase(),
      ),
    )
    expect(types).toContain('toc-block')
    expect(types.filter((t) => t === 'footnotes-block')).toHaveLength(2)
    const defs = types.flatMap((t, i) =>
      t === 'link-ref-defs-block' ? [i] : [],
    )
    expect(defs).toHaveLength(2)
    expect(defs[0]).toBeLessThan(types.indexOf('table'))
    expect((await modelInfo(page)).offReason).toBeUndefined()
  })

  for (const place of [
    { name: 'the first paragraph', needle: 'First paragraph', offset: 5 },
    { name: 'the see cell', needle: 'see [spec]', offset: 4 },
    { name: 'a list item', needle: 'list item 1 with', offset: 4 },
    { name: 'the guide definition', needle: '[guide]: https', offset: 10 },
  ] as const) {
    test(`one key in ${place.name} posts a delta the host accepts (guard)`, async ({
      page,
    }) => {
      await openDefinitions(page)
      await caretIn(page, place.needle, place.offset)
      await resetFixtureCounters(page)
      await page.keyboard.type('Q')
      const typed =
        place.needle.slice(0, place.offset) +
        'Q' +
        place.needle.slice(place.offset)
      await expect.poll(() => stubText(page)).toContain(typed)
      await page.waitForTimeout(SETTLE_MS)
      const counters = await readCounters(page)
      expect(counters.legacyEditPosts, 'legacyEditPosts').toBe(0)
      expect(counters.luteDocument, 'luteDocument').toBe(0)
      expect(counters.deltaPosts, 'deltaPosts').toBeGreaterThanOrEqual(1)
      expect((await stubText(page)).length).toBe(FIXTURE.length + 1)
      expect((await modelInfo(page)).state).toBe('live')
    })
  }

  test('a label rename after the click re-renders the referencing paragraph (D-1)', async ({
    page,
  }) => {
    await openDefinitions(page)
    await proofsDone(page)
    expect(await linkRefs(page)).toBe(1)
    await theClick(page)
    await renameGuide(page)
    await expect.poll(() => linkRefs(page)).toBe(0)
    expect((await fullCounters(page)).fallbackPublications).toBe(0)
  })

  test('a footnote edit after the click updates its tooltip and keeps its number (D-2)', async ({
    page,
  }) => {
    await openDefinitions(page)
    await proofsDone(page)
    const before = await footnoteRef(page, '^note')
    await theClick(page)
    await caretIn(page, 'The first note.', NOTE_CARET)
    await page.keyboard.type(' More', { delay: 80 })
    await expect.poll(() => stubText(page)).toContain('The first note More.')
    await expect
      .poll(async () => (await footnoteRef(page, '^note')).tooltip)
      .toContain('More')
    expect((await footnoteRef(page, '^note')).number).toBe(before.number)
  })

  test('a footnote key right after the model goes live publishes a delta (D-4)', async ({
    page,
  }) => {
    await openDefinitions(page)
    await caretIn(page, 'The first note.', NOTE_CARET)
    const atKey = await modelInfo(page)
    test.info().annotations.push({
      type: 'proven / units at the key',
      description: `${atKey.proven} / ${atKey.units}`,
    })
    await resetFixtureCounters(page)
    await page.keyboard.type('M')
    await expect.poll(() => stubText(page)).toContain('The first noteM.')
    await page.waitForTimeout(SETTLE_MS)
    const info = await modelInfo(page)
    expect(info.state, `model state (${info.offReason ?? ''})`).toBe('live')
    expect(info.unprovenFallbacks, 'unproven-unit fallbacks').toBe(0)
    expect((await readCounters(page)).deltaPosts).toBeGreaterThanOrEqual(1)
  })

  for (const click of [true, false]) {
    test(`Undo and Redo of a rename ${click ? 'after the click (D-3a)' : 'with no click (D-3b)'} restore text and rendering`, async ({
      page,
    }) => {
      await openDefinitions(page)
      await proofsDone(page)
      if (click) await theClick(page)
      await renameGuide(page)
      await page.waitForTimeout(SETTLE_MS)
      await page.keyboard.press('Control+KeyZ')
      await expect.poll(() => stubText(page)).toBe(FIXTURE)
      expect(
        (await fullCounters(page)).historyDeltaPosts,
        'historyDeltaPosts',
      ).toBeGreaterThanOrEqual(1)
      await expect.poll(() => linkRefs(page)).toBe(1)
      await page.waitForTimeout(SETTLE_MS)
      await page.keyboard.press('Control+KeyY')
      await expect.poll(() => stubText(page)).toContain('[guidex]: ')
      await expect.poll(() => linkRefs(page)).toBe(0)
      expect((await modelInfo(page)).state).toBe('live')
    })
  }

  test('Undo and Redo of a footnote edit keep the footnotes block and the tooltip (D-3c)', async ({
    page,
  }) => {
    await openDefinitions(page)
    await proofsDone(page)
    await caretIn(page, 'The first note.', NOTE_CARET)
    await page.keyboard.type(' More', { delay: 80 })
    await expect.poll(() => stubText(page)).toContain('The first note More.')
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Control+KeyZ')
    await page.waitForTimeout(SETTLE_MS)
    const afterUndo = await modelInfo(page)
    test.info().annotations.push({
      type: 'after Undo: model state, definitions in the first footnotes block',
      description: `${afterUndo.state} ${afterUndo.offReason ?? ''} ${await footnoteDefinitions(page)}`,
    })
    await expect.poll(() => stubText(page)).toBe(FIXTURE)
    expect(await footnoteDefinitions(page)).toBe(2)
    await expect
      .poll(async () => (await footnoteRef(page, '^note')).tooltip)
      .toBe('The first note.')
    expect((await modelInfo(page)).state).toBe('live')
    await page.waitForTimeout(SETTLE_MS)
    await page.keyboard.press('Control+KeyY')
    await expect.poll(() => stubText(page)).toContain('The first note More.')
    await expect
      .poll(async () => (await footnoteRef(page, '^note')).tooltip)
      .toContain('More')
    expect((await modelInfo(page)).state).toBe('live')
  })
})

// Task 733 / 022 (Q-183): Replace All on the large fixture publishes a whole post that asks for a
// rebind; the stub holds the answer. An Undo in that window shows at once (Vditor's restore), and the
// session publishes it as one `history-transition` with exact host bytes when the answer arrives.
test.describe('022: history during a pending rebind', () => {
  test.describe.configure({ timeout: 120_000 })
  const LARGE = readFileSync(
    path.join(
      __dirname,
      '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
    ),
    'utf8',
  )

  test('an Undo while the Replace All answer is held restores the host bytes after the answer', async ({
    page,
  }) => {
    await openSourceSet(page, 'none', LARGE, {}, true)
    await expect
      .poll(() => shadow(page), { timeout: 30_000 })
      .toEqual({ state: 'live', mode: 'ir' })
    await page.evaluate(() =>
      window.postMessage(
        { command: 'open-find-replace', mode: 'replace' },
        '*',
      ),
    )
    const widget = page.locator('.vmde-find-replace')
    await expect(widget.locator('[data-replace]')).toBeVisible()
    await widget.locator('[data-find]').fill('ncjw')
    await widget.locator('[data-replace]').fill('ZZZZ')
    await widget.locator('[data-action="replace-all"]').click()
    await expect.poll(async () => (await hostStubState(page)).rebinds).toBe(1)
    expect((await stubText(page)).includes('ZZZZ')).toBe(true)
    await widget.locator('[data-find]').click()
    await page.keyboard.press('Escape')
    await expect(widget).toBeHidden()
    // The time from the key to the first DOM change of the editor (the 50 ms rule).
    await page.evaluate(() => {
      const win = window as any
      const root = win.vditor.vditor.ir.element as HTMLElement
      win.__undoShown = undefined
      win.__undoKeyAt = performance.now()
      const observer = new MutationObserver(() => {
        win.__undoShown ??= performance.now() - win.__undoKeyAt
        observer.disconnect()
      })
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      })
    })
    await page.keyboard.press('Control+KeyZ')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as any).vditor.vditor.ir.element.textContent as string
          ).includes('ZZZZ'),
        ),
      )
      .toBe(false)
    const shownMs = await page.evaluate(
      () => (window as any).__undoShown as number | undefined,
    )
    test.info().annotations.push({
      type: 'undo-key-to-dom-ms',
      description: String(shownMs === undefined ? -1 : Math.round(shownMs)),
    })
    expect(shownMs).toBeDefined()
    const editsBefore = (await hostStubState(page)).kinds.filter(
      (kind) => kind === 'edit',
    ).length
    expect(await releaseRebind(page)).toBe(true)
    await expect.poll(async () => (await stubText(page)) === LARGE).toBe(true)
    const state = await hostStubState(page)
    expect(state.transitions).toBe(1)
    expect(state.resyncs).toBe(0)
    expect(state.kinds.filter((kind) => kind === 'edit').length).toBe(
      editsBefore,
    )
    await expect.poll(() => shadow(page)).toEqual({ state: 'live', mode: 'ir' })
  })
})

// Task 733 / 030 (design Q-190, review Q-192): WYSIWYG diagram renders wait for the settle while typing,
// on `/smoke/wysiwyg.html` and `/smoke/none.html` (the deferral is not gated on `WYSIWYG_UNITS`). The
// document and the counter are 030-E's: the page's render hook `__vmdeDeferIrDiagramRender` is wrapped
// after the first renders land, keeping `acceptsWysiwyg`, and counts each `processCodeRender` call by
// language, split into "while typing" and "at the settle". Logged values are counters and lines only.

const DEFERRAL_DOC = [
  '# Probe heading',
  '',
  'Alpha bravo charlie.',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  'Middle para.',
  '',
  '```graphviz',
  'digraph G { a -> b }',
  '```',
  '',
  '```js',
  'const echo = 1',
  '```',
  '',
  'Tail para.',
  '',
  '- item one',
  '- item two',
  '',
  '  ```mermaid',
  '  graph LR',
  '    C --> D',
  '  ```',
  '',
].join('\n')
const DEFERRAL_KEYS = 6
const DEFERRAL_RUN = 'x'.repeat(DEFERRAL_KEYS)
const DEFERRAL_GAP_MS = 40 // under the 220 ms quiet window: the whole run is one typing burst
const DEFERRAL_SETTLE_MS = 2000
const DIAGRAM_LANGS = ['mermaid', 'graphviz']

/** Wraps the render hook: counts processCodeRender calls per language, while typing and at the settle. */
const installRenderCounter = (page: Page) =>
  page.evaluate(() => {
    const w = window as any
    const original = w.__vmdeDeferIrDiagramRender
    if (!original) throw new Error('no render hook')
    const stats = {
      typing: true,
      whileTyping: {} as Record<string, number>,
      atSettle: {} as Record<string, number>,
    }
    const wrapped = (
      vditor: unknown,
      render: (el: HTMLElement, v: unknown) => void,
    ) =>
      original(vditor, (el: HTMLElement, v: unknown) => {
        const lang = (el.firstElementChild?.className ?? '').replace(
          'language-',
          '',
        )
        const bucket = stats.typing ? stats.whileTyping : stats.atSettle
        bucket[lang] = (bucket[lang] ?? 0) + 1
        render(el, v)
      })
    ;(wrapped as any).acceptsWysiwyg = original.acceptsWysiwyg
    w.__vmdeDeferIrDiagramRender = wrapped
    w.__vmdeRenderCount = stats
  })

const diagramRenders = (counts: Record<string, number>) =>
  DIAGRAM_LANGS.reduce((sum, lang) => sum + (counts[lang] ?? 0), 0)

/** Caret at the end of the first paragraph (click at its right edge). */
async function caretInFirstParagraph(page: Page) {
  const target = page.locator(`${WYSIWYG_ROOT} > p`).first()
  const box = await target.boundingBox()
  if (!box) throw new Error('paragraph has no bounding box')
  await target.click({
    position: { x: Math.max(1, box.width - 2), y: box.height / 2 },
  })
  await page.waitForTimeout(150)
}

/** Shows the first mermaid source and puts the caret after `A --> B`. */
async function caretInMermaidSource(page: Page) {
  await page
    .locator(
      `${WYSIWYG_ROOT} > [data-type="code-block"] .vditor-wysiwyg__preview`,
    )
    .first()
    .click()
  await page.waitForTimeout(200)
  const placed = await page.evaluate((root) => {
    const code = document.querySelector(
      `${root} > [data-type="code-block"] pre.vditor-wysiwyg__pre > code.language-mermaid`,
    )
    const source = code?.closest<HTMLElement>('.vditor-wysiwyg__pre')
    if (!code || !source) return false
    source.style.removeProperty('display')
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node as Text).data.indexOf('A --> B')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at + 7)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return true
    }
    return false
  }, WYSIWYG_ROOT)
  if (!placed) throw new Error('mermaid source not found')
  await page.waitForTimeout(150)
}

/** Caret at the end of the first item of the list that holds a mermaid block. */
async function caretInFirstItem(page: Page) {
  const item = page.locator(`${WYSIWYG_ROOT} > ul > li`).first()
  await item.scrollIntoViewIfNeeded()
  const paragraph = item.locator('p').first()
  const target = (await paragraph.count()) ? paragraph : item
  const box = await target.boundingBox()
  if (!box) throw new Error('item has no bounding box')
  await target.click({
    position: {
      x: Math.max(1, box.width - 2),
      y: Math.min(box.height / 2, 10),
    },
  })
  await page.waitForTimeout(150)
}

const DEFERRAL_PLACES = [
  // Lines are 0-based in the host text; 030-E measured the landing lines 6 and 21.
  { name: 'mermaid source', caret: caretInMermaidSource, line: 6, renders: 1 },
  { name: 'list item', caret: caretInFirstItem, line: 21, renders: 1 },
  { name: 'paragraph', caret: caretInFirstParagraph, line: 2, renders: 0 },
] as const

for (const set of ['wysiwyg', 'none'] as const) {
  test.describe(`030: WYSIWYG diagram deferral (${set})`, () => {
    test.describe.configure({ timeout: 90_000 })

    for (const place of DEFERRAL_PLACES) {
      test(`${DEFERRAL_KEYS} keys in the ${place.name}: 0 diagram renders while typing, ${place.renders} at the settle`, async ({
        page,
      }) => {
        await openSourceSet(page, set, DEFERRAL_DOC)
        await switchMode(page, 'wysiwyg')
        await page.waitForTimeout(2500) // the first renders land before the counter is installed
        await installRenderCounter(page)
        await place.caret(page)
        for (let i = 0; i < DEFERRAL_KEYS; i++) {
          await page.keyboard.type('x')
          await page.waitForTimeout(DEFERRAL_GAP_MS)
        }
        await page.evaluate(() => {
          ;(window as any).__vmdeRenderCount.typing = false
        })
        await page.waitForTimeout(DEFERRAL_SETTLE_MS)
        const counts = await page.evaluate(
          () =>
            (window as any).__vmdeRenderCount as {
              whileTyping: Record<string, number>
              atSettle: Record<string, number>
            },
        )
        expect
          .soft(diagramRenders(counts.whileTyping), 'renders while typing')
          .toBe(0)
        expect
          .soft(diagramRenders(counts.atSettle), 'renders at the settle')
          .toBe(place.renders)
        // No overlay text reaches the bytes: the host text is the document with the run at its line.
        await expect
          .poll(async () => (await stubText(page)).includes(DEFERRAL_RUN))
          .toBe(true)
        const text = await stubText(page)
        const at = text.indexOf(DEFERRAL_RUN)
        expect(text.slice(0, at).split('\n').length - 1, 'landing line').toBe(
          place.line,
        )
        expect(
          text.slice(0, at) + text.slice(at + DEFERRAL_RUN.length),
          'host text without the run',
        ).toBe(DEFERRAL_DOC)
      })
    }
  })
}

// Task 733 / 034 (rows 1 and 2): Vditor's legacy Source paste (`processPaste`) edits by Range calls and
// emits no `input` event, so the publication took the paste after a mode switch for the switch's own
// render and posted nothing (real VS Code `paste-over-selection.spec.ts` and `paste-url-link.spec.ts`,
// Source). Set `none`: Source keeps the whole-text path.
test.describe('034: legacy Source paste', () => {
  test.describe.configure({ timeout: 90_000 })

  /** Dispatches a `paste` of `text` on the Source element, as Chromium's paste does. */
  const pasteInSource = (page: Page, text: string) =>
    page.evaluate((value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      ;(window as any).vditor.vditor.sv.element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
    }, text)

  /** The `edit` posts the stub recorded after the first `from` posts. */
  const editsSince = async (page: Page, from: number) =>
    (await hostStubState(page)).kinds.slice(from).filter((k) => k === 'edit')
      .length

  for (const place of [
    {
      name: 'over a selection',
      doc: 'Read the paper today.\n',
      target: ['the paper', 0, 'the paper'.length] as const,
      paste: 'WORDS',
      expected: (text: string) => expect(text).toBe('Read WORDS today.\n'),
    },
    {
      name: 'a URL at a caret',
      doc: '# Notes\n\nSee also: \n',
      target: ['See also:', 'See also:'.length, 0] as const,
      paste: 'https://example.com/a-paper',
      expected: (text: string) =>
        expect(text).toContain('https://example.com/a-paper'),
    },
  ]) {
    test(`a paste ${place.name} after the switch to Source reaches the host`, async ({
      page,
    }) => {
      await openSourceSet(page, 'none', place.doc)
      await page.waitForTimeout(SETTLE_MS)
      await switchMode(page, 'sv')
      await page.waitForTimeout(SETTLE_MS)
      // The Source switch schedules a Vditor undo snapshot that arms a caret restore; a scripted
      // selection is not a gesture, so wait for the snapshot and retire its intent with Shift.
      await page.waitForFunction(
        () => (window as any).vditor.vditor.sv.vmdeAfterRender === undefined,
      )
      await page.keyboard.press('Shift')
      const from = (await hostStubState(page)).kinds.length
      await page.evaluate(selectEditorText, place.target)
      await pasteInSource(page, place.paste)
      await page.waitForTimeout(SETTLE_MS)
      place.expected(await stubText(page))
      expect(await editsSince(page, from), 'edit posts').toBe(1)
    })
  }
})

// Task 733 / 036 (F6, F7b, F8; design section 3 "Harness"): Undo and Redo of a Find action replay the
// admitted pair as one `history-exact`, and the stub ends on the exact text. Genuine pending typing is
// flushed and popped first; a second Undo during the replay posts nothing; an evicted pair takes the
// Task 685 exact recovery (an `edit` with `history`); a refusal fails closed with one `update`. Row 7:
// Escape, Escape and Tab after Replace One publish nothing and leave no dirty unit. The step H probe and
// matrix (below) gate the timing. These cases fail before steps 2 to 8 (no `history-exact` is posted).
// Covered elsewhere: an Undo before Find's confirmation (block "022", preservation), the outstanding
// confirmation with a pending input timer (model-session block "036"), and Save (editor-session block
// "036 history-exact"; the stub does not model save).
test.describe('036: exact replay of Find', () => {
  test.describe.configure({ timeout: 180_000 })
  const LARGE = readFileSync(
    path.join(
      __dirname,
      '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
    ),
    'utf8',
  )
  const kindsOf = async (page: Page, kind: string) =>
    (await hostStubState(page)).kinds.filter((k) => k === kind).length
  // The editor's visible text (its `getValue()` is a canonical serialization, not the host bytes).
  const editorShows = (page: Page, needle: string) =>
    page.evaluate(
      (n) =>
        (
          (window as any).vditor.vditor.ir.element.textContent as string
        ).includes(n),
      needle,
    )

  async function openFind(page: Page, find: string, replace: string) {
    const widget = page.locator('.vmde-find-replace')
    // A scaled fixture (x4, x16) may still be streaming in when the model is live, and the open request
    // is ignored then: ask again until the Replace row shows.
    await expect
      .poll(
        async () => {
          await page.evaluate(() =>
            window.postMessage(
              { command: 'open-find-replace', mode: 'replace' },
              '*',
            ),
          )
          return widget.locator('[data-replace]').isVisible()
        },
        { timeout: 120_000, intervals: [500] },
      )
      .toBe(true)
    await widget.locator('[data-find]').fill(find)
    await widget.locator('[data-replace]').fill(replace)
    return widget
  }
  async function closeFind(page: Page) {
    const widget = page.locator('.vmde-find-replace')
    await widget.locator('[data-find]').click()
    await page.keyboard.press('Escape')
    await expect(widget).toBeHidden()
  }
  /** One Find action; resolves once the stub holds `expected` and the rebind was answered. */
  async function findAction(
    page: Page,
    action: 'replace' | 'replace-all',
    find: string,
    replace: string,
    expected: string,
    options: { timeout?: number } = {},
  ) {
    const widget = await openFind(page, find, replace)
    const before = await hostStubCounters(page)
    await widget.locator(`[data-action="${action}"]`).click()
    const timeout = options.timeout ?? 5000
    await expect
      .poll(async () => (await hostStubCounters(page)).rebinds, { timeout })
      .toBeGreaterThan(before.rebinds)
    // Task 733 C1: the action's own request reached the stub (one more whole `edit`, the rebind) before the
    // longer wait for its bytes; a scaled Replace All blocks the page for seconds at x16 (Q-245).
    const kinds = (await hostStubCounters(page)).kinds.slice(
      before.kinds.length,
    )
    expect(kinds.filter((k) => k === 'edit').length, 'the Find edit').toBe(1)
    await expect
      .poll(async () => (await stubText(page)) === expected, { timeout })
      .toBe(true)
    await closeFind(page)
  }
  const live = (page: Page) =>
    expect
      .poll(() => shadow(page), { timeout: 30_000 })
      .toEqual({ state: 'live', mode: 'ir' })

  for (const set of ['none', 'wysiwyg', 'source'] as const)
    for (const action of ['replace-all', 'replace'] as const)
      test(`${set}: ${action}, immediate Undo then Redo: one history-exact each, exact stub text`, async ({
        page,
      }) => {
        await openSourceSet(page, set, DOC)
        await live(page)
        const after =
          action === 'replace-all'
            ? DOC.replaceAll('item', 'ZZZZ')
            : DOC.replace('Tail', 'ZZZZ')
        await findAction(
          page,
          action,
          action === 'replace-all' ? 'item' : 'Tail',
          'ZZZZ',
          after,
        )
        const edits = await kindsOf(page, 'edit')

        await page.keyboard.press('Control+KeyZ')
        await expect.poll(async () => (await stubText(page)) === DOC).toBe(true)
        await page.keyboard.press('Control+KeyY')
        await expect
          .poll(async () => (await stubText(page)) === after)
          .toBe(true)

        const state = await hostStubState(page)
        expect(state.kinds.filter((k) => k === 'history-exact').length).toBe(2)
        expect(state.exactReplays).toBe(2)
        expect(state.resyncs).toBe(0)
        expect(await kindsOf(page, 'edit')).toBe(edits)
      })

  test('genuine pending typing is flushed and popped first; the next Undo replays the Find entry', async ({
    page,
  }) => {
    await openSourceSet(page, 'none', DOC)
    await live(page)
    const after = DOC.replaceAll('item', 'ZZZZ')
    await findAction(page, 'replace-all', 'item', 'ZZZZ', after)
    await caretIn(page, 'Tail para.', 4)
    await page.keyboard.type('k')
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(async () => (await stubText(page)) === after).toBe(true)
    expect(await kindsOf(page, 'history-exact')).toBe(0)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(async () => (await stubText(page)) === DOC).toBe(true)
    expect(await kindsOf(page, 'history-exact')).toBe(1)
  })

  test('a rapid second Undo during the replay posts nothing', async ({
    page,
  }) => {
    await openSourceSet(page, 'none', DOC)
    await live(page)
    await findAction(
      page,
      'replace-all',
      'item',
      'ZZZZ',
      DOC.replaceAll('item', 'ZZZZ'),
    )
    await page.keyboard.press('Control+KeyZ')
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(async () => (await stubText(page)) === DOC).toBe(true)
    await page.waitForTimeout(SETTLE_MS)
    const state = await hostStubState(page)
    expect(state.kinds.filter((k) => k === 'history-exact').length).toBe(1)
    expect(state.resyncs).toBe(0)
    expect(await editorShows(page, 'ZZZZ')).toBe(false)
  })

  test('nine undone Find actions: eight replay exactly, the evicted ninth takes the exact recovery', async ({
    page,
  }) => {
    const words = Array.from({ length: 9 }, (_, i) => `word${i}x`)
    const nine = `${words.map((w) => `Para ${w} end.`).join('\n\n')}\n`
    await openSourceSet(page, 'none', nine)
    await live(page)
    let text = nine
    for (const word of words) {
      const next = text.replace(word, word.toUpperCase())
      await findAction(page, 'replace', word, word.toUpperCase(), next)
      text = next
    }
    const edits = await kindsOf(page, 'edit')
    // Each Undo waits for the previous replay's answer: a press during a replay is refused (Q7 (a)).
    for (let i = 0; i < 9; i++) {
      const answered =
        (await hostStubState(page)).accepted +
        (await hostStubState(page)).exactReplays
      await page.keyboard.press('Control+KeyZ')
      await expect
        .poll(async () => {
          const state = await hostStubState(page)
          return state.accepted + state.exactReplays
        })
        .toBeGreaterThan(answered)
      await page.waitForFunction(() => {
        const win = window as any
        return !(
          win.__vmdeUnitHistory?.historyBusy?.(win.vditor.vditor) ?? false
        )
      })
    }
    await expect.poll(async () => (await stubText(page)) === nine).toBe(true)
    const state = await hostStubState(page)
    expect(state.kinds.filter((k) => k === 'history-exact').length).toBe(8)
    expect(state.kinds.filter((k) => k === 'edit').length).toBe(edits + 1)
    expect(state.resyncs).toBe(0)
  })

  test('a refused replay fails closed: one update, and the editor shows the host text', async ({
    page,
  }) => {
    await openSourceSet(page, 'none', DOC, {}, false, true)
    await live(page)
    const after = DOC.replaceAll('item', 'ZZZZ')
    await findAction(page, 'replace-all', 'item', 'ZZZZ', after)
    await page.keyboard.press('Control+KeyZ')
    await expect.poll(async () => (await hostStubState(page)).resyncs).toBe(1)
    expect(await kindsOf(page, 'history-exact')).toBe(1)
    await expect.poll(() => editorShows(page, 'ZZZZ')).toBe(true)
  })

  test.describe('intervening ordinary edit between Find and Undo', () => {
    for (const changed of [false, true])
      test(`${changed ? 'changing' : 'leaving'} the host bytes ${changed ? 'fails closed' : 'still replays exactly'}`, async ({
        page,
      }) => {
        await openSourceSet(page, 'none', DOC)
        await live(page)
        const after = DOC.replaceAll('item', 'ZZZZ')
        await findAction(page, 'replace-all', 'item', 'ZZZZ', after)
        const content = changed ? after.replace('Tail', 'Tall') : after
        await page.evaluate((text) => {
          ;(window as any).vscode.postMessage({
            command: 'edit',
            content: text,
          })
        }, content)
        await page.keyboard.press('Control+KeyZ')
        if (changed) {
          await expect
            .poll(async () => (await hostStubState(page)).resyncs)
            .toBe(1)
          await expect.poll(() => editorShows(page, 'Tall')).toBe(true)
        } else {
          await expect
            .poll(async () => (await stubText(page)) === DOC)
            .toBe(true)
          expect((await hostStubState(page)).resyncs).toBe(0)
        }
        expect(await kindsOf(page, 'history-exact')).toBe(1)
      })
  })

  test.describe('row 7: Replace One, Escape, Escape, Tab, then toolbar Undo', () => {
    for (const route of ['keyboard Enter', 'toolbar click'] as const)
      test(route, async ({ page }) => {
        await openSourceSet(page, 'none', LARGE)
        await live(page)
        const afterOne = LARGE.replace(UNIQUE_PROSE_TOKEN, 'ZZZZ')
        const widget = await openFind(page, UNIQUE_PROSE_TOKEN, 'ZZZZ')
        await widget.locator('[data-action="case"]').click()
        await widget.locator('[data-action="replace"]').click()
        await expect
          .poll(async () => (await stubText(page)) === afterOne)
          .toBe(true)
        await closeFind(page)
        const edits = await kindsOf(page, 'edit')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Tab')
        await page.waitForTimeout(SETTLE_MS)
        const stats = await page.evaluate(
          () => (window as any).__vmdeModelShadowStats,
        )
        expect(stats.dirtyNow).toBe(0)
        expect(await kindsOf(page, 'edit')).toBe(edits)
        expect((await stubText(page)) === afterOne).toBe(true)
        if (route === 'keyboard Enter') {
          const active = () =>
            page.evaluate(
              () => document.activeElement?.getAttribute('data-type') ?? null,
            )
          for (let step = 0; step < 60 && (await active()) !== 'undo'; step++)
            await page.keyboard.press('ArrowLeft')
          expect(await active()).toBe('undo')
          await page.keyboard.press('Enter')
        } else
          await page
            .locator('.vditor-toolbar [data-type="undo"]')
            .first()
            .click()
        await expect
          .poll(async () => (await stubText(page)) === LARGE)
          .toBe(true)
        expect(await kindsOf(page, 'history-exact')).toBe(1)
        expect(await kindsOf(page, 'edit')).toBe(edits)
      })
  })

  // Steps H and H2 (036 fix design revision 5, section 6, rows "H. Probe and matrix" and "H2. Gate"): the
  // timing probe and the case matrix at x1, x4 and x16. Per window the probe records every long task that
  // overlaps it (G1), the Event Timing durations of Z and of every typed key, with the character, the caret
  // and (for a history key) the first rendered group checked at the paint after the key (G2), and the
  // history operations, the replay counters, the host bytes and render catch-up (G3).
  // The window opens at Z's own keydown `event.timeStamp`. It ends at the later of two independent
  // timestamps: the last render (the last mutation of the IR surface; the replay account is checked closed
  // after the window) and the last `replay-ack` (or `replay-status: applied`) the page received, and it
  // closes once every posted replay operation is acknowledged (or the stub resynchronized) and nothing has
  // rendered, been posted or been acknowledged for `H_QUIET_MS`. A key the replay refuses ends its own
  // sample at the refusal. Inside the window no host text and no product state is read: the stub is read
  // by counters only, polled every 50 ms.
  // Event Timing rounds durations to 8 ms, so a 48 or 56 ms sample is resolved in the same run: from the
  // unrounded `processingEnd - startTime` of its entry (a lower bound) and a post-paint mark taken for that
  // sample (a `requestAnimationFrame` callback followed by a `MessageChannel` message, a presentation
  // proxy). A sample neither settles stays unresolved and fails G2.
  // The baseline cases (no replay) are reported, not gated (Q-D (b)); so are the x16 rows (fix design 4.6)
  // and the input-refused span during the recovery after a refusal. With `H036_OUT` set, each sample is
  // appended to that file as one JSON line.
  // ---- 036 core C10 (R2.1 with C10 review item 1, T8): same-run trace of a measured window ----
  // The window runs with CDP `Tracing` on. A key's duration is the unrounded `EventTiming` trace event
  // matched by `timeStamp` (nearest within 0.2 ms) and type. A probe snapshot (`p0-<frame>` mark, written in the
  // frame's `ResizeObserver` callback, the last script point before paint) counts as displayed only when
  // its renderer main frame reaches a presented compositor frame through ids, not timestamp order: the
  // mark lies in the main frame begun by the last `BeginMainThreadFrame`; that main frame is the one the
  // `SendBeginMainFrameToCommit` stage of exactly one `PipelineReporter` carried (nestable async events,
  // paired per thread and id in emission order); the reporter's `frame_sequence` and state say whether the
  // compositor presented it, and its end is the presentation time. No link, or more than one sequence,
  // is ambiguous, and an ambiguous deciding frame fails the sample.
  const TRACE_CATEGORIES = [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'blink.user_timing',
    'viz',
    'benchmark',
    'cc',
  ]
  /** The trace events the analysis reads; everything else is dropped as it arrives. */
  const TRACE_KEPT = new Set([
    'EventTiming',
    'BeginMainThreadFrame',
    'PipelineReporter',
    'SendBeginMainFrameToCommit',
  ])
  /**
   * Q-276 (S-1): the task events that attribute a slow owned keydown: top-level tasks, script calls, and
   * the browser-side message a task may only hold.
   */
  const TRACE_ATTRIBUTION = new Set([
    'ThreadControllerImpl::RunTask',
    'FunctionCall',
    'v8.callFunction',
    'Receive mojo message',
  ])
  /** The trace events on the keydown's thread overlapping its EventTiming window. */
  function traceTasksIn(events: TraceEvent[], m: TraceEvent): any[] {
    const from = m.ts
    const to = from + Number(m.args.data.duration) * 1000
    return events.filter(
      (e: any) =>
        e.pid === m.pid &&
        e.tid === m.tid &&
        e.ph === 'X' &&
        e.ts < to &&
        e.ts + e.dur > from,
    )
  }
  /** The task only receives a browser message and runs no script. */
  const envOnly = (task: any, main: any[]): boolean => {
    const inside = main.filter(
      (c) =>
        c !== task && c.ts >= task.ts && c.ts + c.dur <= task.ts + task.dur,
    )
    return (
      inside.some((c) => c.name === 'Receive mojo message') &&
      !inside.some(
        (c) => c.name === 'FunctionCall' || c.name === 'v8.callFunction',
      )
    )
  }
  /**
   * Q-276 (S-1): the longest top-level task inside the keydown's EventTiming window that only receives a
   * browser message and runs no script (a test-environment cost); 0 when none.
   */
  function traceEnvTaskMs(events: TraceEvent[], timeStamp: number): number {
    const m = events.find(
      (e) =>
        traceInput(e, ['keydown']) &&
        Math.abs(Number(e.args.data.timeStamp) - timeStamp) <= TRACE_MATCH_MS,
    )
    if (!m) return 0
    const main = traceTasksIn(events, m)
    let longest = 0
    for (const task of main)
      if (task.name === 'ThreadControllerImpl::RunTask' && envOnly(task, main))
        longest = Math.max(longest, task.dur / 1000)
    return longest
  }
  interface TraceEvent {
    name: string
    ph: string
    ts: number
    pid: number
    tid: number
    id2?: { local?: string }
    args?: any
  }
  /** Starts a trace on `cdp`; the returned function ends it and resolves with the kept events. */
  async function startTrace(cdp: CDPSession, attribution = false) {
    const events: TraceEvent[] = []
    const kept = (e: TraceEvent) =>
      TRACE_KEPT.has(e.name) ||
      e.name.startsWith('p0-') ||
      (attribution && TRACE_ATTRIBUTION.has(e.name))
    const onData = (data: { value: object[] }) => {
      for (const raw of data.value) {
        const e = raw as TraceEvent
        if (kept(e)) events.push(e)
      }
    }
    cdp.on('Tracing.dataCollected', onData)
    await cdp.send('Tracing.start', {
      traceConfig: {
        includedCategories: attribution
          ? [...TRACE_CATEGORIES, 'toplevel', 'v8']
          : TRACE_CATEGORIES,
      },
      transferMode: 'ReportEvents',
    })
    return async (): Promise<TraceEvent[]> => {
      const complete = new Promise<void>((resolve) =>
        cdp.once('Tracing.tracingComplete', () => resolve()),
      )
      await cdp.send('Tracing.end')
      await complete
      cdp.off('Tracing.dataCollected', onData)
      return events
    }
  }
  type FrameLink =
    | { state: 'presented'; displayedAt: number }
    | { state: 'not-presented' }
    | { state: 'ambiguous' }
  interface Reporter {
    state: string
    seq: number
    end: number
    stage?: [number, number]
    stageBegin?: number
  }
  /** A `PipelineReporter` begin or end on its stack; the finished reporter is returned. */
  function pipelineStep(
    stack: Reporter[],
    e: TraceEvent,
  ): Reporter | undefined {
    if (e.ph !== 'b') {
      const done = stack.pop()
      if (done) done.end = e.ts
      return done
    }
    const fr = e.args?.frame_reporter ?? {}
    stack.push({ state: String(fr.state), seq: fr.frame_sequence, end: -1 })
    return undefined
  }
  /** One reporter-related event applied to its thread-and-id stack; a finished reporter is returned. */
  function reporterStep(
    stack: Reporter[],
    e: TraceEvent,
  ): Reporter | undefined {
    if (e.name === 'PipelineReporter') return pipelineStep(stack, e)
    const top = stack[stack.length - 1]
    if (e.name !== 'SendBeginMainFrameToCommit' || !top) return undefined
    if (e.ph === 'b') top.stageBegin = e.ts
    else if (top.stageBegin !== undefined) top.stage = [top.stageBegin, e.ts]
    return undefined
  }
  /** The `PipelineReporter`s of process `pid`, paired per thread and id in emission order (nestable async). */
  function traceReporters(events: TraceEvent[], pid: number): Reporter[] {
    const stacks = new Map<string, Reporter[]>()
    const out: Reporter[] = []
    for (const e of events) {
      if (e.pid !== pid || (e.ph !== 'b' && e.ph !== 'e')) continue
      const key = `${e.tid}:${e.id2?.local ?? ''}`
      const stack = stacks.get(key) ?? []
      stacks.set(key, stack)
      const done = reporterStep(stack, e)
      if (done) out.push(done)
    }
    return out
  }
  /** One mark's link: the reporters that carried its main frame (begun at `begin`), by sequence and state. */
  function linkOf(
    begin: number,
    reporters: Reporter[],
    offset: number,
  ): FrameLink {
    const carried =
      begin < 0
        ? []
        : reporters.filter(
            (r) => r.stage && r.stage[0] <= begin && begin <= r.stage[1],
          )
    if (new Set(carried.map((r) => r.seq)).size > 1)
      return { state: 'ambiguous' }
    const presented = carried.filter((r) =>
      r.state.startsWith('STATE_PRESENTED'),
    )
    if (presented.length === 0) return { state: 'not-presented' }
    return {
      state: 'presented',
      displayedAt: Math.min(...presented.map((r) => r.end)) / 1000 - offset,
    }
  }
  /** Each `p0-<frame>` mark's link to a presented frame, in page-clock milliseconds. */
  function traceFrameLinks(events: TraceEvent[]): Map<number, FrameLink> {
    const links = new Map<number, FrameLink>()
    const marks = events.filter((e) => e.name.startsWith('p0-'))
    if (marks.length === 0) return links
    const { pid, tid } = marks[0]
    // Page clock = trace clock less this offset (from a mark's own two clocks).
    const offset =
      marks[0].ts / 1000 - Number(marks[0].args?.data?.startTime ?? 0)
    const begins = events
      .filter(
        (e) =>
          e.name === 'BeginMainThreadFrame' && e.pid === pid && e.tid === tid,
      )
      .map((e) => e.ts)
      .sort((x, y) => x - y)
    const reporters = traceReporters(events, pid)
    for (const mark of marks) {
      const begin = begins.filter((ts) => ts <= mark.ts).pop() ?? -1
      links.set(Number(mark.name.slice(3)), linkOf(begin, reporters, offset))
    }
    return links
  }
  // The page's `event.timeStamp` is coarsened to 0.1 ms with jitter (measured 0.137 ms off the trace's
  // unrounded value), so the match takes the nearest event of the type within 0.2 ms; keys are at least
  // several ms apart, and two candidates within the window are ambiguous (no match).
  const TRACE_MATCH_MS = 0.2
  /** The `EventTiming` trace data of an input of one of `types`, or null. */
  const traceInput = (e: TraceEvent, types: readonly string[]): any => {
    const data = e.name === 'EventTiming' && e.ph === 'b' ? e.args?.data : null
    return data && types.includes(data.type) ? data : null
  }
  /** The unrounded `EventTiming` trace duration of the input at `timeStamp` of one of `types`; null when none. */
  function traceEventMs(
    events: TraceEvent[],
    timeStamp: number,
    types: readonly string[],
  ): number | null {
    const near = new Map<number, number>()
    for (const e of events) {
      const data = traceInput(e, types)
      if (!data) continue
      const stamp = Number(data.timeStamp)
      if (Math.abs(stamp - timeStamp) > TRACE_MATCH_MS) continue
      // One input can carry more than one entry (bubbling targets): its longest duration.
      near.set(stamp, Math.max(near.get(stamp) ?? 0, Number(data.duration)))
    }
    return near.size === 1 ? [...near.values()][0] : null
  }

  const H_CATCH_UP_MS: Record<number, number> = { 1: 250, 4: 1500, 16: 8000 }
  // Owner decision Q-270 (2026-11-22): with typing during the replay, and for the collapsed Cut, the catch-up
  // limit is 1.4 times the plain one (350 ms at x1, 2,100 ms at x4).
  const H_CATCH_UP_TYPED_MS: Record<number, number> = {
    1: 350,
    4: 2100,
    16: 8000,
  }
  /**
   * C10 pass rule: the known limits a sample may be recorded under, only for their exact class evidence.
   * K3: x4, a typed key (or IME commit) during a replay, 56-72 ms (core plan 3.3).
   */
  const K3_MAX_MS = 72
  /** The known class of a timed sample over 50 ms, or null (it fails). */
  const hKnownClass = (
    s: { kind: string; traceMs: number | null; displayedMs: number | null },
    factor: number,
  ): 'K3' | null => {
    const worst = Math.max(s.traceMs ?? 999, s.displayedMs ?? 0)
    if (factor === 4 && s.kind !== 'history' && worst <= K3_MAX_MS) return 'K3'
    return null
  }
  const H_LATE_REPLY_MS: Record<number, number> = {
    1: 1000,
    4: 4000,
    16: 20_000,
  }
  // The idle publication of typing settles within SETTLE_MS: a window stays open this long after the last
  // render, post or acknowledgement, so a late publication is inside it.
  const H_QUIET_MS = 2000
  const H_TOP = 'ldgwck nzw ldfmywnwb'
  const H_PENDING = 'Pzwr wfsnnsra tr wumyslsn'
  const H_CUT = 'Pzwr wfsnnsra'
  // H2 fix design rev2 (D3.3): seeded into the system clipboard before each Cut case's window; a refused
  // Cut or Copy leaves it there.
  const H_SENTINEL = 'vmde clipboard sentinel 036'

  /**
   * `k7`: until 038 the caret may sit after Enter's U+00A0 with `prev` before it in the block (K7, the DOM
   * shape of the dev Enter defect).
   */
  type HExpect = {
    prev?: string
    next?: string
    emptyRoot?: boolean
    k7?: true
  } | null
  /** A history key's visible effect: the nearest block holding either string shows `show`, not `hide`. */
  type HShows = readonly [show: string, hide: string]
  interface HSample {
    kind: 'history' | 'key' | 'ime'
    key: string
    stamp: number
    seen: boolean
    refused: boolean | null
    endAt: number
    postPaint: number
    /** A history key: the post-paint mark at which its first group showed; -1 when it never did. */
    visibleAt: number
    paint: {
      ok: boolean | null
      collapsed: boolean
      caretKept: boolean | null
      backward: boolean | null
    } | null
    /** 036 core C10 (R2.1): the IME sample's committing event, its input time. */
    commitStamp?: number
  }
  interface HEvent {
    name: string
    start: number
    duration: number
    processingEnd: number
  }
  interface HProbe {
    armAt: number
    zStamp: number
    lastRender: number
    samples: HSample[]
    tasks: number[][]
    /** Task 733 C1: long animation frames as [start, duration, blockingDuration] (recorded, not gated). */
    frames: number[][]
    events: HEvent[]
    gaps: number[][]
    cut: { prevented: boolean; text: string | null } | null
    /** P1: whether the selection at Z's command dispatch is the one checked at arm (null: no dispatch). */
    dispatchHolds: boolean | null
    /** 036 core C10 (P0): `[frame, sample, caretOk, groupOk, typedOk]`, 1 / 0 / -1 (not checked). */
    snaps: number[][]
    /** 036 core C10 (T6a): `[time, open]` at each frame where the replay account's state changed. */
    budgetOpen: number[][]
    /** 036 core C10 (R2.2): `[sequence, at]` of each completed replay (`__vmdeE2EReplayEnd`). */
    ends: number[][]
  }

  /**
   * In-page probe, installed before the page's scripts so its window listeners run before the replay's
   * input guard (`unit-history.ts`, `guardInput`): a key the guard stops never reaches the document's
   * capture listener, which is how a refusal is told apart. Idle until `__h036.arm`.
   */
  function installProbe() {
    const probe: any = {
      armed: false,
      armAt: -1,
      zStamp: -1,
      lastRender: -1,
      samples: [],
      tasks: [],
      frames: [],
      events: [],
      gaps: [],
      expects: [],
      shows: [],
      caret: null,
      cut: null,
      deletes: 0,
      current: undefined,
      placed: null,
      dispatchHolds: null,
      // 036 core C10 (P0, T1, T2): frame snapshots `[frame, sample, caretOk, groupOk, typedOk]` (1, 0, or -1
      // for not checked), the intended group of each history key, and the evicted-move flag.
      snaps: [],
      groups: [],
      nonReplay: false,
      frameNo: 0,
      // T6a: the replay account's open state at each frame where it changed, `[time, open]`.
      budgetOpen: [],
      // T6a (C10 review item 2): each completed replay's `[sequence, at]`, one record per move.
      ends: [],
      lastEnd: null,
    }
    ;(window as any).__h036 = probe
    const root = () => (window as any).vditor.vditor.ir.element as HTMLElement
    // 036 core C10 (T3, K7): the K7 shape, read within the caret's block only.
    const k7Prev = (prev: string): boolean => {
      const sel = getSelection()
      let block: Node | null | undefined = sel?.focusNode
      while (block && block.parentNode !== root()) block = block.parentNode
      if (!block || !sel?.focusNode) return false
      const range = document.createRange()
      range.setStart(block, 0)
      range.setEnd(sel.focusNode, sel.focusOffset)
      return range.toString().endsWith(`${prev}\u00a0`)
    }
    const caretFits = (e: any, data: string, offset: number): boolean => {
      if (e.emptyRoot)
        return (root().textContent ?? '').replace(/[\s​]/g, '').length === 0
      const prevOk =
        e.prev === undefined ||
        data.slice(0, offset).endsWith(e.prev) ||
        (e.k7 === true &&
          data.slice(0, offset).endsWith('\u00a0') &&
          k7Prev(e.prev))
      const nextOk =
        e.next === undefined ||
        data.slice(offset).trimStart().startsWith(e.next.trimStart())
      return prevOk && nextOk
    }
    // The text around the focus, to tell whether a history key kept the caret at its intent.
    const caretContext = (): string | null => {
      const sel = getSelection()
      const node = sel?.focusNode
      if (node?.nodeType !== 3 || !root().contains(node)) return null
      const data = (node as Text).data
      const at = sel?.focusOffset ?? 0
      return `${data.slice(Math.max(0, at - 8), at)}|${data.slice(at, at + 8)}`
    }
    const backwardOf = (): boolean | null => {
      const sel = getSelection()
      if (!sel?.anchorNode || !sel.focusNode || sel.isCollapsed) return null
      if (sel.anchorNode === sel.focusNode)
        return sel.anchorOffset > sel.focusOffset
      return (
        (sel.anchorNode.compareDocumentPosition(sel.focusNode) &
          Node.DOCUMENT_POSITION_PRECEDING) !==
        0
      )
    }
    // The first group a history move renders is the one nearest the caret: scan the top-level blocks
    // outward from the caret's block for the first that holds either string (reads a few blocks only).
    const caretBlock = (blocks: HTMLCollection): number => {
      let node: Node | null | undefined = getSelection()?.focusNode
      while (node && node.parentNode !== root()) node = node.parentNode
      return node ? Array.prototype.indexOf.call(blocks, node as Element) : 0
    }
    const blockText = (blocks: HTMLCollection, i: number): string =>
      (i >= 0 && i < blocks.length ? blocks[i].textContent : '') ?? ''
    const showsFit = ([show, hide]: readonly [string, string]): boolean => {
      const blocks = root().children
      const from = caretBlock(blocks)
      for (let d = 0; d < blocks.length; d++) {
        const text = [from - d, from + d]
          .map((i) => blockText(blocks, i))
          .find((t) => t.includes(show) || t.includes(hide))
        if (text !== undefined)
          return text.includes(show) && !text.includes(hide)
      }
      return false
    }
    const paintOk = (s: any): boolean | null => {
      if (!s.expect) return null
      if (s.kind === 'history') return showsFit(s.expect)
      const sel = getSelection()
      const node = sel?.focusNode
      const data = node?.nodeType === 3 ? (node as Text).data : ''
      return caretFits(s.expect, data, sel?.focusOffset ?? 0)
    }
    const check = (s: any) => {
      const kept =
        s.kind === 'history' && probe.caret !== null
          ? caretContext() === probe.caret
          : null
      s.paint = {
        ok: paintOk(s),
        collapsed: getSelection()?.isCollapsed ?? false,
        caretKept: kept,
        backward: backwardOf(),
      }
    }
    // The post-paint mark: the frame's callbacks, then a message after the frame.
    const nextPaint = (fn: () => void) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = fn
        channel.port2.postMessage(0)
      })
    // A history key reaches the editor through the keybinding round trip, so its first group may show
    // a frame or more after the key's own paint: re-checked per paint until it shows (at most 120).
    // Task 733 C1: the frame that shows the first group is timed by its rAF callback (the frame's start, a
    // lower bound of presentation), not by the `MessageChannel` mark that input and replay tasks starve.
    const watchVisible = (s: any, frames: number) =>
      requestAnimationFrame((frameAt) => {
        if (showsFit(s.expect)) s.visibleAt = frameAt
        else if (frames > 0) watchVisible(s, frames - 1)
      })
    const afterPaint = (s: any, mark: boolean) =>
      nextPaint(() => {
        if (mark) s.postPaint = performance.now()
        check(s)
        if (!mark || s.kind !== 'history' || !s.expect) return
        if (s.paint.ok) s.visibleAt = s.postPaint
        else watchVisible(s, 120)
      })
    // ---- 036 core C10 (P0, T1, T2, T3): what a frame presents, read in its ResizeObserver callback ----
    const blockOf = (node: Node | null): Element | null => {
      let n = node
      while (n && n.parentNode !== root()) n = n.parentNode
      return n instanceof Element ? n : null
    }
    /** One selection endpoint as its top-level block index and its text offset in that block. */
    const endpoint = (node: Node | null, offset: number) => {
      const block = blockOf(node)
      if (!node || !block) return null
      const range = document.createRange()
      range.setStart(block, 0)
      range.setEnd(node, offset)
      return {
        block: Array.prototype.indexOf.call(root().children, block),
        offset: range.toString().length,
      }
    }
    const caretNow = () => {
      const sel = getSelection()
      if (!sel?.anchorNode) return null
      return {
        anchor: endpoint(sel.anchorNode, sel.anchorOffset),
        focus: endpoint(sel.focusNode, sel.focusOffset),
      }
    }
    // T1: design 2.7 rule 1 for one endpoint: the offset moves by (count of `hide` before it) x (show - hide);
    // inside a hunk it goes to the hunk start (Undo) or end (Redo).
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page probe code must live inside `installProbe` (injected whole), which deepens its nesting
    function mapEndpoint(
      p: { block: number; offset: number } | null,
      show: string,
      hide: string,
      redo: boolean,
    ) {
      if (!p) return null
      const block = root().children[p.block]
      const text = block ? (block.textContent ?? '') : ''
      const delta = show.length - hide.length
      let shift = 0
      let at = text.indexOf(hide)
      while (at >= 0 && at + hide.length <= p.offset) {
        shift += delta
        at = text.indexOf(hide, at + hide.length)
      }
      // Inside a hunk: its start for Undo, its end for Redo.
      const inside = at >= 0 && at < p.offset
      const offset = inside
        ? at + shift + (redo ? show.length : 0)
        : p.offset + shift
      return { block: p.block, offset }
    }
    // T1, evicted move: the change site, the start of the first hunk in document order.
    const changeSite = (hide: string) => {
      const blocks = root().children
      for (let i = 0; i < blocks.length; i++) {
        const at = (blocks[i].textContent ?? '').indexOf(hide)
        if (at >= 0) return { block: i, offset: at }
      }
      return null
    }
    const sameEndpoint = (a: any, b: any) =>
      a !== null && b !== null && a.block === b.block && a.offset === b.offset
    // T2: the intended group's leaf: the innermost unit element holding `needle`, nearest the caret's block.
    const LEAF = 'li, p, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote'
    /** The innermost unit elements holding `needle`. */
    const leavesWith = (needle: string): Element[] =>
      Array.from(root().querySelectorAll(LEAF)).filter(
        (el) =>
          (el.textContent ?? '').includes(needle) &&
          !Array.from(el.querySelectorAll(LEAF)).some((inner) =>
            (inner.textContent ?? '').includes(needle),
          ),
      )
    const topIndex = (el: Element): number => {
      const top = blockOf(el)
      return top ? Array.prototype.indexOf.call(root().children, top) : 0
    }
    const pathOf = (el: Element): number[] => {
      const path: number[] = []
      for (let n: Node = el; n !== root(); n = n.parentNode as Node)
        path.unshift(
          Array.prototype.indexOf.call((n.parentNode as Node).childNodes, n),
        )
      return path
    }
    const groupPath = (needle: string): number[] | null => {
      const focus = getSelection()?.focusNode ?? null
      const caretBlockIndex = endpoint(focus, 0)?.block ?? 0
      let best: Element | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const el of leavesWith(needle)) {
        const distance = Math.abs(topIndex(el) - caretBlockIndex)
        if (distance < bestDistance) {
          best = el
          bestDistance = distance
        }
      }
      return best ? pathOf(best) : null
    }
    const atPath = (path: number[]): Node | null => {
      let n: Node | null = root()
      for (const i of path) n = n?.childNodes[i] ?? null
      return n
    }
    /** The caret a history move must leave (T1), from the caret at its key. */
    const mappedCaret = (show: string, hide: string, redo: boolean) => {
      if (probe.nonReplay)
        return { anchor: changeSite(hide), focus: changeSite(hide) }
      const pre = caretNow()
      if (!pre) return null
      return {
        anchor: mapEndpoint(pre.anchor, show, hide, redo),
        focus: mapEndpoint(pre.focus, show, hide, redo),
      }
    }
    // Q-275: only a group on screen at the key is gated; an off-screen one is recorded as such.
    const onScreen = (leaf: Node): boolean => {
      if (!(leaf instanceof Element)) return false
      const rect = leaf.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < window.innerHeight
    }
    /** At a history key: its mapped caret and its group's expected text (every hide shown). */
    const prepareHistory = (s: any) => {
      if (!s.expect) return
      const [show, hide] = s.expect as [string, string]
      s.mapped = mappedCaret(show, hide, /^Control\+y$/i.test(s.key))
      const needle = probe.groups.shift()
      const path = needle ? groupPath(needle) : null
      const leaf = path ? atPath(path) : null
      s.groupPath = path
      s.groupText =
        leaf && onScreen(leaf)
          ? (leaf.textContent ?? '').replaceAll(hide, show)
          : null
      s.groupOnScreen = s.groupText !== null
    }
    const caretOkOf = (s: any): number => {
      const now = caretNow()
      if (!s.mapped || !now) return -1
      return sameEndpoint(now.anchor, s.mapped.anchor) &&
        sameEndpoint(now.focus, s.mapped.focus)
        ? 1
        : 0
    }
    const groupOkOf = (s: any): number => {
      if (s.groupText === null || s.groupText === undefined) return -1
      const leaf = s.groupPath ? atPath(s.groupPath) : null
      return (leaf?.textContent ?? null) === s.groupText ? 1 : 0
    }
    /** One sample's snapshot in `frame`, for 120 frames after its input. */
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page probe code must live inside `installProbe` (injected whole), which deepens its nesting
    const snapSample = (s: any, index: number, frame: number) => {
      const age = s.snapFrom === undefined ? -1 : frame - s.snapFrom
      if (age <= 0 || age > 120) return
      if (s.kind === 'history')
        probe.snaps.push([frame, index, caretOkOf(s), groupOkOf(s), -1])
      else
        probe.snaps.push([
          frame,
          index,
          -1,
          -1,
          s.expect ? (paintOk(s) ? 1 : 0) : -1,
        ])
    }
    const snapshot = () => {
      probe.frameNo++
      const frame = probe.frameNo
      performance.mark(`p0-${frame}`)
      const open =
        (window as any).__vmdeModelShadowStats?.replay?.budget?.open === true
          ? 1
          : 0
      const last = probe.budgetOpen[probe.budgetOpen.length - 1]
      if (!last || last[1] !== open)
        probe.budgetOpen.push([performance.now(), open])
      const end = (window as any).__vmdeE2EReplayEnd
      if (end && end !== probe.lastEnd) {
        probe.lastEnd = end
        probe.ends.push([end.sequence, end.at])
      }
      probe.samples.forEach((s: any, index: number) => {
        snapSample(s, index, frame)
      })
    }
    const open = (kind: string, key: string, stamp: number) => {
      const s = {
        kind,
        key,
        stamp,
        seen: false,
        refused: null as boolean | null,
        endAt: -1,
        postPaint: -1,
        visibleAt: -1,
        paint: null,
        expect:
          (kind === 'history' ? probe.shows.shift() : probe.expects.shift()) ??
          null,
      }
      probe.samples.push(s)
      probe.current = s
      if (kind === 'history') prepareHistory(s)
      ;(s as any).snapFrom = probe.frameNo
      afterPaint(s, true)
      return s
    }
    // After the event's task: a refused sample ends here.
    const settle = (s: any, refused: () => boolean) =>
      setTimeout(() => {
        s.refused = refused()
        if (s.refused) s.endAt = performance.now()
      }, 0)
    const MODIFIERS = ['Control', 'Shift', 'Meta', 'Alt']
    const guardedDeletes = (): number =>
      (window as any).__vmdeModelShadowStats?.replay?.deletes ?? 0
    const isHistory = (ev: KeyboardEvent) =>
      (ev.ctrlKey || ev.metaKey) && ['KeyZ', 'KeyY'].includes(ev.code)
    const keyName = (ev: KeyboardEvent) =>
      (ev.ctrlKey || ev.metaKey ? 'Control+' : '') + ev.key
    window.addEventListener(
      'keydown',
      (ev) => {
        if (!probe.armed || MODIFIERS.includes(ev.key)) return
        const history = isHistory(ev)
        if (history && ev.code === 'KeyZ' && probe.zStamp < 0)
          probe.zStamp = ev.timeStamp
        const s = open(history ? 'history' : 'key', keyName(ev), ev.timeStamp)
        // H2 fix design rev2 (D3.3): a key the replay guard turned into its one guarded deletion is
        // cancelled too, but it is not refused. The counter is read after the key's task only.
        settle(s, () => {
          const deletes = guardedDeletes()
          const deleted = deletes > probe.deletes
          probe.deletes = deletes
          return !history && !s.seen && ev.defaultPrevented && !deleted
        })
      },
      true,
    )
    document.addEventListener(
      'keydown',
      (ev) => {
        if (probe.current?.stamp === ev.timeStamp) probe.current.seen = true
      },
      true,
    )
    // An IME commit has no keydown: its sample opens at `compositionstart`, and the guard's refusal
    // shows as a `beforeinput` that reaches the window but not the document.
    window.addEventListener(
      'compositionstart',
      (ev) => {
        if (probe.armed) open('ime', 'IME', ev.timeStamp)
      },
      true,
    )
    window.addEventListener(
      'beforeinput',
      (ev) => {
        const s = probe.current
        if (!probe.armed || s?.kind !== 'ime') return
        // R2.1: the IME sample's input time is its committing event's.
        const type = (ev as InputEvent).inputType
        if (
          type === 'insertCompositionText' ||
          type === 'insertFromComposition'
        )
          s.commitStamp = ev.timeStamp
        settle(s, () => !s.seen)
      },
      true,
    )
    document.addEventListener(
      'beforeinput',
      () => {
        if (probe.current?.kind === 'ime') probe.current.seen = true
      },
      true,
    )
    document.addEventListener(
      'input',
      () => {
        const s = probe.current
        if (probe.armed && s && s.kind !== 'history') afterPaint(s, false)
      },
      true,
    )
    // P1: the selection when the first history move is dispatched, compared by node and offset with the
    // selection at arm (O(1), inside the window). Task 733 C1: with the IR-owned keys (D-18) the move runs
    // inside the chord's keydown and no command arrives, so the keydown (capture, before the ownership
    // guard) is the dispatch point; with ownership off the command message is.
    const holdsNow = () => {
      const sel = getSelection()
      const placed = probe.placed
      return (
        placed !== null &&
        sel?.anchorNode === placed[0] &&
        sel.anchorOffset === placed[1] &&
        sel.focusNode === placed[2] &&
        sel.focusOffset === placed[3]
      )
    }
    window.addEventListener(
      'keydown',
      (ev) => {
        if (!probe.armed || probe.dispatchHolds !== null) return
        if (!(ev.ctrlKey || ev.metaKey) || !['KeyZ', 'KeyY'].includes(ev.code))
          return
        probe.dispatchHolds = holdsNow()
      },
      true,
    )
    window.addEventListener(
      'message',
      (ev) => {
        if (!probe.armed || probe.dispatchHolds !== null) return
        if (ev.data?.command !== 'trigger-toolbar-hotkey') return
        const sel = getSelection()
        const placed = probe.placed
        probe.dispatchHolds =
          placed !== null &&
          sel?.anchorNode === placed[0] &&
          sel.anchorOffset === placed[1] &&
          sel.focusNode === placed[2] &&
          sel.focusOffset === placed[3]
      },
      true,
    )
    // Bubble phase on the window: runs after the editor's own Cut handler wrote the clipboard data.
    window.addEventListener('cut', (ev) => {
      if (!probe.armed) return
      probe.cut = {
        prevented: ev.defaultPrevented,
        text: ev.clipboardData?.getData('text/plain') ?? null,
      }
    })
    probe.arm = ({
      expects,
      shows,
      floor,
      groups,
      nonReplay,
    }: {
      expects: unknown[]
      shows: unknown[]
      floor: boolean
      groups: Array<string | null>
      nonReplay: boolean
    }) => {
      probe.expects = expects
      probe.shows = shows
      probe.groups = groups
      probe.nonReplay = nonReplay
      // P0: a 1x1 element toggled by the probe's own animation-frame loop (first in every frame, started
      // before any key); its ResizeObserver callback runs in the rendering steps just before paint.
      const marker = document.createElement('div')
      marker.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;contain:strict;pointer-events:none'
      document.body.appendChild(marker)
      new ResizeObserver(snapshot).observe(marker)
      const toggle = () => {
        if (!probe.armed) return
        marker.style.width = marker.style.width === '1px' ? '2px' : '1px'
        requestAnimationFrame(toggle)
      }
      requestAnimationFrame(toggle)
      probe.deletes = guardedDeletes()
      probe.caret = caretContext()
      const sel = getSelection()
      probe.placed = sel?.anchorNode
        ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset]
        : null
      probe.armed = true
      probe.armAt = performance.mark('h036-arm').startTime
      new MutationObserver(() => {
        probe.lastRender = performance.now()
      }).observe(root(), {
        childList: true,
        characterData: true,
        subtree: true,
      })
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          probe.tasks.push([e.startTime, e.duration])
      }).observe({ type: 'longtask', buffered: false })
      // Task 733 C1: long frames with their blocking time, recorded so a stall without main-thread work
      // is visible as such (not gated; Chromium-only entry type, absent elsewhere).
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as any[])
            probe.frames.push([e.startTime, e.duration, e.blockingDuration])
        }).observe({ type: 'long-animation-frame', buffered: false } as any)
      } catch {
        // No long-animation-frame support: nothing recorded.
      }
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          probe.events.push({
            name: e.name,
            start: e.startTime,
            duration: e.duration,
            processingEnd: (e as PerformanceEventTiming).processingEnd,
          })
      }).observe({
        type: 'event',
        durationThreshold: 16,
        buffered: false,
      } as PerformanceObserverInit)
      // The baseline only: frame gaps over 20 ms, as the floor's task lengths below the longtask threshold.
      if (!floor) return
      let last = performance.now()
      const tick = (now: number) => {
        if (now - last > 20) probe.gaps.push([last, now - last])
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }
  }

  /** Opens `none` on `content` with the probe installed before the page's scripts. */
  async function hOpen(
    page: Page,
    content: string,
    exactReplyDelayMs = 0,
    refuseExact = false,
    ownershipOff = false,
  ) {
    await installHostStub(page, {
      content,
      options: {
        showToolbar: true,
        defaultMode: 'ir',
        ...(ownershipOff ? { undoRedoKeys: { inEditor: false } } : {}),
      },
      exactReplyDelayMs,
      refuseExact,
    })
    await page.addInitScript(installProbe)
    // VS Code's webview preload blocks the browser default of Ctrl+Z and Ctrl+Y.
    await page.addInitScript(() => {
      window.addEventListener('keydown', (event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          [90, 89].includes(event.keyCode)
        )
          event.preventDefault()
      })
    })
    await page.goto('/smoke/none.html')
    await page.waitForFunction(
      () =>
        ((window as any).__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        (window as any).vditor?.getCurrentMode?.() === 'ir',
      undefined,
      { timeout: 15_000 },
    )
    // P2: Select All reaches the editor as VS Code's `vmde.selectAll` command (native select-all is
    // guarded on the surface; the webview entry registers the `select-all` runner).
    await page.evaluate(
      (commands) => (window as any).__installKeybindingShim(commands),
      [...HISTORY_COMMANDS, 'vmde.selectAll'],
    )
    await expect
      .poll(() => shadow(page), { timeout: 300_000 })
      .toEqual({ state: 'live', mode: 'ir' })
  }

  /**
   * Clicks the action until it reaches the stub: Replace All until the stub holds the expected text,
   * Replace One until a rebind was answered. At x4 and x16 a click while the scaled search is still
   * counting can be lost; a repeated Replace All after the replacement finds no match and posts nothing.
   */
  async function hClickUntilLanded(
    page: Page,
    widget: Locator,
    action: 'replace' | 'replace-all',
  ) {
    // A repeated Replace One could replace a second match, so it gets one retry only.
    const attempts = action === 'replace-all' ? 5 : 2
    for (let attempt = 0; attempt < attempts; attempt++) {
      const before = await hostStubCounters(page)
      await widget.locator(`[data-action="${action}"]`).click()
      const landed = await page
        .waitForFunction(
          ({ whole, rebinds, accepted }) => {
            const w = window as any
            const s = w.__vmdeHostStub
            return whole
              ? s.text === w.__h036Expected
              : s.rebinds > rebinds && s.accepted > accepted
          },
          {
            whole: action === 'replace-all',
            rebinds: before.rebinds,
            accepted: before.accepted,
          },
          { polling: 500, timeout: 60_000 },
        )
        .then(
          () => true,
          () => false,
        )
      if (landed) return
    }
    throw new Error(`${action} did not reach the stub after ${attempts} clicks`)
  }

  /** One Find action over a large text; Replace All needs its `expected` text (compared in the page). */
  async function hFind(
    page: Page,
    action: 'replace' | 'replace-all',
    find: string,
    replace: string,
    expected?: string,
  ) {
    const widget = await openFind(page, find, replace)
    // Setup only, outside every window: the expected text is compared in the page.
    if (expected !== undefined)
      await page.evaluate((t) => {
        ;(window as any).__h036Expected = t
      }, expected)
    const caseButton = widget.locator('[data-action="case"]')
    if ((await caseButton.getAttribute('aria-checked')) !== 'true')
      await caseButton.click()
    await hClickUntilLanded(page, widget, action)
    // The answer to a large rebind keeps the page busy for seconds: Escape is retried until the widget
    // closes.
    await expect
      .poll(
        async () => {
          await widget.locator('[data-find]').click()
          await page.keyboard.press('Escape')
          return widget.isHidden()
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true)
  }

  /**
   * Selects `length` characters from `offset` into the first or last occurrence of `needle` in the IR
   * surface; `backward` puts the focus at the start. Runs in the page.
   */
  function hSelect([needle, offset, length, last, backward]: readonly [
    string,
    number,
    number,
    boolean,
    boolean,
  ]) {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node as Text)
    const all = nodes.map((node) => node.data).join('')
    const at = last ? all.lastIndexOf(needle) : all.indexOf(needle)
    if (at < 0) throw new Error('needle not in the surface')
    const locate = (target: number): [Text, number] => {
      let rest = target
      for (const node of nodes) {
        if (rest <= node.data.length) return [node, rest]
        rest -= node.data.length
      }
      throw new Error('offset past the end')
    }
    root.focus()
    const [startNode, startOffset] = locate(at + offset)
    const [endNode, endOffset] = locate(at + offset + length)
    const selection = getSelection() as Selection
    if (backward)
      selection.setBaseAndExtent(endNode, endOffset, startNode, startOffset)
    else selection.setBaseAndExtent(startNode, startOffset, endNode, endOffset)
  }

  /**
   * P1: the placement's two points in the IR surface, scrolled into view, as viewport coordinates of a
   * click that lands the caret there, and their offsets in the surface text. Runs in the page.
   */
  function hPlacePoints([needle, offset, length, last, backward]: readonly [
    string,
    number,
    number,
    boolean,
    boolean,
  ]) {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node as Text)
    const all = nodes.map((node) => node.data).join('')
    const at = last ? all.lastIndexOf(needle) : all.indexOf(needle)
    if (at < 0) throw new Error('needle not in the surface')
    const locate = (target: number): [Text, number] => {
      let rest = target
      for (const node of nodes) {
        if (rest < node.data.length) return [node, rest]
        rest -= node.data.length
      }
      throw new Error('offset past the end')
    }
    const start = at + offset
    const end = at + offset + length
    // A point before a character is clicked at that character's left edge; the point after the last
    // selected character at its right edge.
    const pointOf = (target: number, after: boolean) => {
      const [node, o] = locate(after ? target - 1 : target)
      const range = document.createRange()
      range.setStart(node, o)
      range.setEnd(node, o + 1)
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return {
        x: after ? rect.right - 1 : rect.left + 1,
        y: rect.top + rect.height / 2,
      }
    }
    locate(start)[0].parentElement?.scrollIntoView({ block: 'center' })
    const from = pointOf(start, false)
    const to = length > 0 ? pointOf(end, true) : from
    return backward
      ? { first: to, second: from, anchor: end, focus: start }
      : { first: from, second: to, anchor: start, focus: end }
  }

  /** P1: the selection's anchor and focus as offsets in the IR surface text. Runs in the page. */
  function hSelectionOffsets(): { anchor: number; focus: number } | null {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const sel = getSelection()
    if (!sel?.anchorNode || !sel.focusNode) return null
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode))
      return null
    const offsetOf = (node: Node, offset: number) => {
      const range = document.createRange()
      range.setStart(root, 0)
      range.setEnd(node, offset)
      return range.toString().length
    }
    return {
      anchor: offsetOf(sel.anchorNode, sel.anchorOffset),
      focus: offsetOf(sel.focusNode, sel.focusOffset),
    }
  }

  /**
   * P1: places the case's selection by gesture, as a user does: a click at the first point, then a
   * Shift+click at the second. A gesture ends any armed caret intent (`caret.ts`, the invalidation
   * listeners), which a scripted `setBaseAndExtent` does not: the intent's next frame put the caret
   * back at the Find match. `script` keeps that scripted placement (the failing setup, reported).
   * Returns the intended offsets.
   */
  async function hPlace(
    page: Page,
    place: NonNullable<HCase['place']>,
    by: 'gesture' | 'script',
  ): Promise<{ anchor: number; focus: number }> {
    const points = await page.evaluate(hPlacePoints, place)
    if (by === 'script') await page.evaluate(hSelect, place)
    else {
      await page.mouse.click(points.first.x, points.first.y)
      if (place[2] > 0) {
        // Read again after the click: the caret's block can reveal its markers and move the text.
        const second = (await page.evaluate(hPlacePoints, place)).second
        await page.keyboard.down('Shift')
        await page.mouse.click(second.x, second.y)
        await page.keyboard.up('Shift')
      }
    }
    return { anchor: points.anchor, focus: points.focus }
  }

  /** `text` with `insert` put `offset` characters into the first (or last) `needle`. */
  const hInsert = (
    text: string,
    needle: string,
    offset: number,
    insert: string,
    last = false,
  ) => {
    const at = (last ? text.lastIndexOf(needle) : text.indexOf(needle)) + offset
    return text.slice(0, at) + insert + text.slice(at)
  }
  const nextFrame = (page: Page) =>
    page.evaluate(
      () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    )

  interface HContext {
    page: Page
    cdp: CDPSession
  }
  interface HCase {
    name: string
    /** Task 733 C1 (core plan R1.3): open with `undoRedoKeys.inEditor: false`, the recorded K8 control. */
    ownershipOff?: true
    replace?: string
    /** The stub answers a replayed `history-exact` this late (0: before the first slice). */
    lateReply?: boolean
    /** Find actions before the measured one; `text` is the host text after the measured Find action. */
    before?: (page: Page, factor: number, text: string) => Promise<void>
    /** Run after the earlier history so the measured Undo pops the intended entry. */
    undoFirst?: number
    /** The caret or selection before Z: needle, offset, length, last occurrence, backward. */
    place?: readonly [string, number, number, boolean, boolean]
    /** P1: `script` keeps the scripted placement the caret intent overwrites (the failing setup). */
    placeBy?: 'gesture' | 'script'
    /** Paint checks for the keys `act` types, in order. */
    expects?: HExpect[]
    /**
     * Paint checks for the history keys (Z first); default: the restored `ncjw`, not the replacement.
     * Null: no check (a move the next key supersedes before it renders).
     */
    shows?: Array<HShows | null>
    act?: (h: HContext) => Promise<void>
    /**
     * 036 core C10 (T2): the intended first group of each history key, as a needle naming its fixture unit
     * (resolved at the key to the unit's leaf nearest the caret); default `hGroups`.
     */
    groups?: Array<string | null>
    /**
     * 036 core C10 (T7): at x16 the case expects the K6 refusal (042): `history-exact` 1, one abandon and one
     * resync, and the host holding the Replace All text with only the earlier word Undo applied.
     */
    x16K6?: true
    /** 036 core C10 (R2.1): the first typed key is displayed before the second key's input. */
    enterAlone?: true
    /** The host text at the end, from the scaled text and the text after the Find action. */
    expected: (scaled: string, after: string) => string
    /** The clipboard's `text/plain` after the window. */
    clipboard?: string
    /**
     * H2 fix design rev2 (D3.3): a Cut whose selection a scripted placement can lose. The system clipboard
     * then holds the sentinel with the host unchanged, or the bytes of a proven cut (the selection or the
     * caret's line) with the host missing exactly those bytes; `expected` is not used.
     */
    cutOutcome?: true
    exact?: number
    historyEdits?: number
  }

  const EIGHT = [
    'Lcwtnw',
    'dekwcgteyw',
    'fdbwyk',
    'srzwcsnwb',
    'yddqjm',
    'Iswyb',
    'Gtyjw',
    'Kntnjk',
  ]
  // Replace One at x16 posts nothing (H finding 2, outside 036): the x16 setups replace whole words.
  const hWordAction = async (
    page: Page,
    factor: number,
    text: string,
    word: string,
    replace: string,
  ) => {
    if (factor === 16)
      await hFind(
        page,
        'replace-all',
        word,
        replace,
        text.replaceAll(word, replace),
      )
    else await hFind(page, 'replace', word, replace)
    return factor === 16 ? text.replaceAll(word, replace) : text
  }
  const typeAfterFrame =
    (key: string) =>
    async ({ page }: HContext) => {
      await nextFrame(page)
      await page.keyboard.press(key)
    }
  /** Task 733 C1 (core plan R1.3): the tagged-Find cases of H3 item 1, gated at x16 for correctness. */
  const H4_TAGGED_FIND = [
    'one character one frame after Z',
    'Enter one frame after Z, then a character',
    'a key in a pending unit',
  ]
  const H_CASES: HCase[] = [
    {
      name: 'shorter replacement',
      replace: 'ZZ',
      shows: [['ncjw', 'ZZ']],
      expected: (s) => s,
    },
    {
      name: 'longer replacement',
      replace: 'ZZZZZZZZZZ',
      shows: [['ncjw', 'ZZZZZZZZZZ']],
      expected: (s) => s,
    },
    { name: 'reply before the first slice', expected: (s) => s },
    {
      name: 'reply after the last slice',
      lateReply: true,
      expected: (s) => s,
    },
    {
      name: 'backward selection',
      place: [H_TOP, 0, 6, false, true],
      expected: (s) => s,
    },
    {
      name: 'IME commit one frame after Z',
      place: [H_TOP, 6, 0, false, false],
      expects: [{ prev: 'ü' }],
      act: async ({ page, cdp }) => {
        await nextFrame(page)
        await cdp.send('Input.imeSetComposition', {
          text: 'ü',
          selectionStart: 1,
          selectionEnd: 1,
        })
        await cdp.send('Input.insertText', { text: 'ü' })
      },
      expected: (s) => hInsert(s, H_TOP, 6, 'ü'),
    },
    {
      name: 'eviction',
      before: async (page, factor, text) => {
        let t = text
        for (const word of EIGHT)
          t = await hWordAction(page, factor, t, word, word.toUpperCase())
      },
      undoFirst: 8,
      expected: (s) => s,
      exact: 0,
      historyEdits: 1,
    },
    {
      name: 'one character one frame after Z',
      place: [H_TOP, 6, 0, false, false],
      expects: [{ prev: 'q' }],
      act: typeAfterFrame('q'),
      expected: (s) => hInsert(s, H_TOP, 6, 'q'),
    },
    {
      name: 'Enter one frame after Z, then a character',
      place: [H_TOP, 6, 0, false, false],
      expects: [{ next: 'nzw' }, { prev: 'q', k7: true }],
      act: async (h) => {
        await typeAfterFrame('Enter')(h)
        await h.page.keyboard.press('q')
      },
      // K7 (core plan 3.3): Enter after earlier history publishes one U+00A0 (dev defect, 038); the
      // expected bytes carry it until 038 lands.
      expected: (s) => hInsert(s, H_TOP, 6, '\n\nq\u00a0'),
    },
    {
      // 036 core C10 (R2.1): the spaced variant: one presented frame between Enter and q, which must show
      // Enter alone (Enter's own sample is decided before q's input).
      name: 'Enter one frame after Z, a frame, then a character',
      place: [H_TOP, 6, 0, false, false],
      expects: [{ next: 'nzw' }, { prev: 'q', k7: true }],
      act: async (h) => {
        await typeAfterFrame('Enter')(h)
        await nextFrame(h.page)
        await nextFrame(h.page)
        await h.page.keyboard.press('q')
      },
      expected: (s) => hInsert(s, H_TOP, 6, '\n\nq\u00a0'),
      enterAlone: true,
    },
    {
      name: 'a key in a pending unit',
      place: [H_PENDING, 4, 0, true, false],
      expects: [{ prev: 'q' }],
      act: typeAfterFrame('q'),
      expected: (s) => hInsert(s, H_PENDING, 4, 'q', true),
    },
    {
      name: 'Select All then Delete',
      place: [H_TOP, 6, 0, false, false],
      expects: [null, { emptyRoot: true }],
      act: async (h) => {
        // P2: the IR ladder selects the block, then the document; Ctrl+A repeats (each a sample with no
        // paint check) until the selection's endpoints are the surface root's, then Backspace runs the
        // whole-document delete over those root endpoints.
        // 036 core C10 (T4): each press is a host-routed editor action; the ladder waits until the
        // selection changed before it tests the root and decides on another press.
        const pressAndWait = async (press: () => Promise<void>) => {
          const key = await h.page.evaluate(hSelectionKey)
          await press()
          await expect
            .poll(() => h.page.evaluate(hSelectionKey), { timeout: 2000 })
            .not.toBe(key)
            .catch(() => undefined)
        }
        await pressAndWait(() => typeAfterFrame('Control+KeyA')(h))
        for (let press = 1; press < 4; press++) {
          if (await h.page.evaluate(hRootCovered)) break
          await h.page.evaluate(() =>
            (window as any).__h036.expects.unshift(null),
          )
          await pressAndWait(() => h.page.keyboard.press('Control+KeyA'))
        }
        expect(
          await h.page.evaluate(hRootCovered),
          'Select All covers the surface root',
        ).toBe(true)
        await h.page.keyboard.press('Backspace')
      },
      expected: () => '',
      // H2 fix design rev2 (D3.3): a deletion never writes the clipboard.
      clipboard: H_SENTINEL,
    },
    {
      name: 'Cut over pending text',
      place: [H_CUT, 0, H_CUT.length, true, false],
      expects: [{ next: ' tr wumyslsn' }],
      act: typeAfterFrame('Control+KeyX'),
      expected: (s) => {
        const at = s.lastIndexOf(H_CUT)
        return s.slice(0, at) + s.slice(at + H_CUT.length)
      },
      clipboard: H_CUT,
    },
    {
      // P1: the failing setup kept beside the corrected one: the scripted range the caret intent
      // collapses before Z (reported; the window still runs).
      name: 'Cut over pending text, scripted placement',
      place: [H_CUT, 0, H_CUT.length, true, false],
      placeBy: 'script',
      expects: [null],
      act: typeAfterFrame('Control+KeyX'),
      expected: (s) => s,
      cutOutcome: true,
    },
    {
      // H2 fix design rev2 (D3.2): an element caret has no byte proof; the Cut is refused (or, with the
      // separate guard task, cuts one proven block).
      name: 'collapsed Cut at an element caret',
      place: [H_CUT, 0, 0, true, false],
      expects: [null],
      act: async (h) => {
        await nextFrame(h.page)
        await h.page.evaluate(() => {
          const surface = (window as any).vditor.vditor.ir
            .element as HTMLElement
          getSelection()?.setBaseAndExtent(surface, 1, surface, 1)
        })
        await h.page.keyboard.press('Control+KeyX')
      },
      expected: (s) => s,
      cutOutcome: true,
    },
    {
      name: 'second Undo',
      before: async (page, factor, text) => {
        await hWordAction(page, factor, text, EIGHT[0], 'LCWTNWX')
      },
      shows: [
        [EIGHT[0], 'LCWTNWX'],
        ['ncjw', 'ZZZZ'],
      ],
      // T2: the first move's group is the unit holding the Replace One result.
      groups: ['LCWTNWX', 'Cwlcwtnw WrldkhNdpwc.Fggf'],
      x16K6: true,
      act: typeAfterFrame('Control+KeyZ'),
      expected: (s) => s,
      exact: 2,
    },
    {
      name: 'Undo then Redo at once',
      shows: [null, ['ZZZZ', 'ncjw']],
      act: async ({ page }) => page.keyboard.press('Control+KeyY'),
      expected: (_s, after) => after,
      exact: 2,
    },
  ]

  const hWrite = (record: unknown) => {
    const out = process.env.H036_OUT
    if (out) appendFileSync(out, `${JSON.stringify(record)}\n`)
    test
      .info()
      .annotations.push({ type: 'h036', description: JSON.stringify(record) })
  }

  const IME_EVENTS = [
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'beforeinput',
    'input',
  ]
  /** The longest Event Timing entry that belongs to `s` (its keydown, or its IME events). */
  const sampleEntry = (s: HSample, entries: HEvent[]): HEvent | undefined => {
    const names = s.kind === 'ime' ? IME_EVENTS : ['keydown']
    let best: HEvent | undefined
    for (const e of entries)
      if (
        names.includes(e.name) &&
        e.start >= s.stamp - 1 &&
        (s.kind === 'ime' || Math.abs(e.start - s.stamp) < 1) &&
        (best === undefined || e.duration > best.duration)
      )
        best = e
    return best
  }
  const round1 = (v: number) => Math.round(v * 10) / 10
  /**
   * Task 733 C1: the G2 duration of a sample, from input creation (Event Timing `startTime`) to the next
   * paint, rounded by Chromium to 8 ms. 56 or more is a miss (at least 52 ms). 40 or less passes. A 48 ms
   * sample (44-52 ms) passes only with a same-run presentation trace, which this harness does not record:
   * it fails as unresolved (null) unless its unrounded processing end already proves it over 50 ms. The
   * post-paint mark (a `MessageChannel` task that input and replay frames starve) is recorded only.
   */
  const resolveDuration = (
    reported: number,
    lowerMs: number | null,
    _paintMs: number | null,
  ): number | null => {
    if (reported !== 48) return reported
    if (lowerMs !== null && lowerMs > 50) return lowerMs
    return null
  }
  /** A sample's end: the refusal, or the stub's application of its post (null when neither came). */
  function hSampleEnd(s: HSample, ops: HostStubOp[]): number | null {
    if (s.refused === true) return Math.round(s.endAt - s.stamp)
    const applied = ops.find(
      (o) =>
        (o.outcome === 'applied' || o.outcome === 'replayed') &&
        o.at >= s.stamp &&
        ['edit', 'edit-delta', 'history-delta', 'history-exact'].includes(
          o.kind,
        ),
    )
    return applied ? Math.round(applied.at + applied.ms - s.stamp) : null
  }
  /** One sample's paint checks: the first paint, and for a history key when its first group showed. */
  const hSamplePaint = (s: HSample) => ({
    paintOk: s.paint?.ok ?? null,
    visibleMs:
      s.kind === 'history' && s.visibleAt >= 0
        ? round1(s.visibleAt - s.stamp)
        : null,
    caretKept: s.paint?.caretKept ?? null,
    backwardAtPaint: s.paint?.backward ?? null,
  })
  /** One sample's G2 record. */
  function hSampleRecord(s: HSample, probe: HProbe, ops: HostStubOp[]) {
    const entry = sampleEntry(s, probe.events)
    const reported = entry?.duration ?? 0
    const lowerMs = entry ? round1(entry.processingEnd - entry.start) : null
    const paintMs = s.postPaint < 0 ? null : round1(s.postPaint - s.stamp)
    return {
      kind: s.kind,
      key: s.key,
      stampMs: s.stamp,
      eventTimingMs: reported,
      processingEndMs: lowerMs,
      postPaintMs: paintMs,
      resolvedMs: resolveDuration(reported, lowerMs, paintMs),
      refused: s.refused,
      ...hSamplePaint(s),
      endMs: hSampleEnd(s, ops),
    }
  }

  /** The replay counters and budget account (kinds and numbers only), read outside every window. */
  const hReplayStats = (page: Page) =>
    page.evaluate(() => {
      const w = window as any
      const replay = w.__vmdeModelShadowStats?.replay ?? {}
      return {
        whole: (replay.whole ?? 0) + (w.__vmdeSlicedRestore?.whole ?? 0),
        unbounded: replay.unbounded ?? 0,
        caretFallback: replay.caretFallback ?? 0,
        atomics: replay.atomics ?? 0,
        frames: replay.frames ?? 0,
        budget: (replay.budget ?? null) as null | {
          budgetMisses: number
          carriedMs: number
          open: boolean
          marks: number
          maxTaskMs: number
          classes: Record<string, unknown>
          missK14: number
          missOther: number
          missLogDropped: number
          missLog: unknown[]
        },
      }
    })

  /**
   * One measured window: arms the probe, presses Z (unless `noUndo`: then `act` alone opens it), runs
   * `act`, waits for the window to close, and returns the record. Reads no host text and no product
   * state before it closes.
   */
  async function hWindow(
    page: Page,
    act: ((h: HContext) => Promise<void>) | undefined,
    arm: {
      expects: HExpect[]
      shows: Array<HShows | null>
      floor: boolean
      groups?: Array<string | null>
      nonReplay?: boolean
    },
    noUndo: boolean,
  ) {
    const cdp = await page.context().newCDPSession(page)
    const before = await hostStubCounters(page)
    const statsBefore = await hReplayStats(page)
    // 036 core C10 (T8, R2.1): the window is traced from arm to its end.
    const endTrace = await startTrace(cdp)
    await page.evaluate((a) => (window as any).__h036.arm(a), {
      groups: [],
      nonReplay: false,
      ...arm,
    })
    if (!noUndo) await page.keyboard.press('Control+KeyZ')
    if (act) await act({ page, cdp })
    const closed = await hWaitClosed(page, before, noUndo)
    const trace = await endTrace()
    await cdp.detach()
    const accountClosed = await hAccountClosed(page)
    const probe = await hReadProbe(page)
    const backwardAtEnd = await page.evaluate(hBackward)
    const after = await hostStubCounters(page)
    const statsAfter = await hReplayStats(page)
    const timing = hTiming(probe, before, after, noUndo)
    const links = traceFrameLinks(trace)
    const presented = probe.samples.map((s, index) =>
      hPresentedOf(s, index, probe, links, trace),
    )
    return {
      closed,
      accountClosed,
      ...timing,
      samples: timing.samples.map((s, i) => ({ ...s, ...presented[i] })),
      tracedFrames: links.size,
      catchUp: hCatchUp(probe, before, after, statsAfter),
      backwardAtEnd,
      dispatchHolds: probe.dispatchHolds,
      cut: probe.cut,
      replay: hReplayOf(statsBefore, statsAfter),
      g3: hG3(before, after, statsBefore, statsAfter),
    }
  }

  /**
   * Waits until the window closes: the action reached the stub, every posted replay operation is
   * acknowledged (or the stub resynchronized), and nothing rendered, was posted or was acknowledged for
   * `H_QUIET_MS`. Reads stub counters and probe timestamps only. False on timeout.
   */
  const hWaitClosed = (page: Page, before: HostStubCounters, typed: boolean) =>
    page
      .waitForFunction(
        ({ ops, resyncs, accepted, quietMs, typed: byKey }) => {
          const w = window as any
          const s = w.__vmdeHostStub
          const p = w.__h036
          const started = byKey
            ? s.accepted > accepted
            : s.historyOps > ops || s.resyncs > resyncs
          const acknowledged =
            s.resyncs > resyncs || s.lastAckOp >= s.lastReplayOp
          const last = Math.max(p.lastRender, s.lastOpAt, s.lastAckAt)
          return started && acknowledged && performance.now() - last >= quietMs
        },
        {
          ops: before.historyOps,
          resyncs: before.resyncs,
          accepted: before.accepted,
          quietMs: H_QUIET_MS,
          typed,
        },
        { polling: 50, timeout: 240_000 },
      )
      .then(
        () => true,
        () => false,
      )

  /** After the window: the replay account is closed (every marked deferred callback has run). */
  const hAccountClosed = (page: Page) =>
    page
      .waitForFunction(
        () =>
          !(
            (window as any).__vmdeModelShadowStats?.replay?.budget?.open ??
            false
          ),
        undefined,
        { polling: 500, timeout: 60_000 },
      )
      .then(
        () => true,
        () => false,
      )

  const hReadProbe = async (page: Page) =>
    (await page.evaluate(() => {
      const p = (window as any).__h036
      return {
        armAt: p.armAt,
        zStamp: p.zStamp,
        lastRender: p.lastRender,
        samples: p.samples.map(({ expect: _e, ...s }: any) => s),
        tasks: p.tasks,
        frames: p.frames,
        events: p.events,
        gaps: p.gaps,
        cut: p.cut,
        dispatchHolds: p.dispatchHolds,
        snaps: p.snaps,
        budgetOpen: p.budgetOpen,
        ends: p.ends,
      }
    })) as HProbe

  /** 036 core C10 (Q-275), in the page: scrolls the caret's block into view; the selection is unchanged. */
  function hCaretIntoView(): void {
    const node = getSelection()?.focusNode
    const el = node instanceof Element ? node : node?.parentElement
    el?.scrollIntoView({ block: 'center' })
  }

  /** 036 core C10 (T4), in the page: the selection's endpoints as one comparable key (no text). */
  function hSelectionKey(): string {
    const range = getSelection()?.rangeCount
      ? getSelection()?.getRangeAt(0)
      : null
    if (!range) return 'none'
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const index = (n: Node) => {
      const path: number[] = []
      for (let x: Node | null = n; x && x !== root; x = x.parentNode)
        path.unshift(
          x.parentNode
            ? Array.prototype.indexOf.call(x.parentNode.childNodes, x)
            : -1,
        )
      return path.join('.')
    }
    return `${index(range.startContainer)}:${range.startOffset}-${index(range.endContainer)}:${range.endOffset}`
  }

  /** In the page: the selection's endpoints are the IR surface root's own (O(1)). */
  function hRootCovered(): boolean {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const range = getSelection()?.rangeCount
      ? getSelection()?.getRangeAt(0)
      : null
    return (
      !!range &&
      range.startContainer === root &&
      range.startOffset === 0 &&
      range.endContainer === root &&
      range.endOffset === root.childNodes.length
    )
  }

  /** In the page: the selection is backward (anchor after focus); null when collapsed or absent. */
  function hBackward(): boolean | null {
    const sel = getSelection()
    if (!sel?.anchorNode || !sel.focusNode || sel.isCollapsed) return null
    if (sel.anchorNode === sel.focusNode)
      return sel.anchorOffset > sel.focusOffset
    return (
      (sel.anchorNode.compareDocumentPosition(sel.focusNode) &
        Node.DOCUMENT_POSITION_PRECEDING) !==
      0
    )
  }

  /** G1 and the window's timestamps: its end is the later of the last render and the last acknowledgement. */
  function hTiming(
    probe: HProbe,
    before: HostStubCounters,
    after: HostStubCounters,
    typed: boolean,
  ) {
    const ops = after.ops.slice(before.ops.length)
    const opened = typed ? (probe.samples[0]?.stamp ?? -1) : probe.zStamp
    const lastApplied = ops
      .filter((o) => o.outcome !== 'recorded')
      .reduce((m, o) => Math.max(m, o.at + o.ms), -1)
    const lastRender = probe.lastRender > opened ? probe.lastRender : -1
    const lastAck = after.lastAckAt > opened ? after.lastAckAt : -1
    const windowEnd = Math.max(lastRender, lastAck, lastApplied)
    const overlapping = probe.tasks.filter(
      ([start, duration]) => start < windowEnd && start + duration > opened,
    )
    return {
      // The floor as the profiled baseline counted it: long tasks over 50 ms in the 1.6 s after opening.
      over50Within1600Ms: probe.tasks.filter(
        ([start, duration]) =>
          duration > 50 && start < opened + 1600 && start + duration > opened,
      ).length,
      windowMs: Math.round(windowEnd - opened),
      g1LongestMs: Math.round(
        overlapping.reduce((m, [, duration]) => Math.max(m, duration), 0),
      ),
      longFrames: probe.frames
        .filter(([start, d]) => start < windowEnd && start + d > opened)
        .map(([start, d, b]) => ({
          atMs: Math.round(start - opened),
          ms: Math.round(d),
          blockingMs: Math.round(b ?? -1),
        })),
      g1Over50: overlapping
        .filter(([, d]) => d > 50)
        .map(([start, duration]) => ({
          atMs: Math.round(start - opened),
          ms: Math.round(duration),
          hostMs: round1(
            ops
              .filter((o) => o.at >= start && o.at < start + duration)
              .reduce((m, o) => m + o.ms, 0),
          ),
        })),
      // Frame gaps over 20 ms inside the window (baseline only).
      floorGapsMs: probe.gaps
        .filter(([start, gap]) => start < windowEnd && start + gap > opened)
        .map(([, gap]) => Math.round(gap)),
      samples: probe.samples.map((s) => hSampleRecord(s, probe, ops)),
      // No mutation of the surface after the key: nothing was left to render (a superseded move).
      renderCatchUpMs: lastRender < 0 ? 0 : Math.round(lastRender - opened),
      rendered: lastRender >= 0,
      ackMs: lastAck < 0 ? null : Math.round(lastAck - opened),
    }
  }

  /**
   * 036 core C10 (R2.1): one sample's G2 at presentation. The first displayed snapshot that shows the
   * expected state decides: a history key's group with its mapped caret (T1, T2), a typed key's character
   * at the caret (T3). Its displayed time less the input time is the G2 value. A displayed frame showing
   * the group with another caret fails ('caret'), unless the next input came first ('superseded': the next
   * sample proves the caret intent, design 2.7(c)). A deciding frame without a unique presentation link
   * fails ('ambiguous'); a state never displayed is 'unresolved', a failure. `traceMs` is the unrounded
   * `EventTiming` trace duration (T8); null when no trace event matched, also a failure.
   */
  type HVerdict = 'pass' | 'caret' | 'superseded' | 'ambiguous' | 'unresolved'
  type HDecision = {
    verdict: HVerdict
    displayedMs: number | null
    frame: number | null
  }
  /** One shown snapshot's decision; undefined when its frame was not presented (the next one decides). */
  function hJudge(
    s: HSample,
    frame: number,
    caretOk: number,
    link: FrameLink | undefined,
    inputAt: number,
    next: HSample | undefined,
  ): HDecision | undefined {
    if (!link || link.state === 'ambiguous')
      return { verdict: 'ambiguous', displayedMs: null, frame }
    if (link.state === 'not-presented') return undefined
    const displayedMs = round1(link.displayedAt - inputAt)
    if (s.kind !== 'history' || caretOk !== 0)
      return { verdict: 'pass', displayedMs, frame }
    const superseded = next !== undefined && next.stamp < link.displayedAt
    return { verdict: superseded ? 'superseded' : 'caret', displayedMs, frame }
  }
  /** Sample `index` was snapshot against an expected state (a typed key's `typedOk` is not -1). */
  const hasExpectation = (probe: HProbe, index: number): boolean =>
    probe.snaps.some(([, i, , , typedOk]) => i === index && typedOk !== -1)
  /** A snapshot shows the sample: Q-275, with no gated group (off screen) the mapped caret decides. */
  const hShown = (
    kind: string,
    caretOk: number,
    groupOk: number,
    typedOk: number,
  ): boolean =>
    kind === 'history'
      ? groupOk === 1 || (groupOk === -1 && caretOk !== 0)
      : typedOk !== 0
  /** The deciding displayed snapshot of sample `index` (see `hPresentedOf`). */
  function hDecide(
    s: HSample,
    index: number,
    probe: HProbe,
    links: Map<number, FrameLink>,
    inputAt: number,
  ): HDecision {
    const next = probe.samples[index + 1]
    // A typed key with no expected state (a refused or invisible action) has nothing to display: Event
    // Timing still ends at the next paint opportunity, but no presented frame follows. Only its trace
    // duration (T8) gates it.
    if (s.kind !== 'history' && !hasExpectation(probe, index))
      return { verdict: 'pass', displayedMs: null, frame: null }
    for (const [frame, i, caretOk, groupOk, typedOk] of probe.snaps) {
      if (i !== index || !hShown(s.kind, caretOk, groupOk, typedOk)) continue
      const decided = hJudge(s, frame, caretOk, links.get(frame), inputAt, next)
      if (decided) return decided
    }
    const superseded = s.kind === 'history' && next !== undefined
    return {
      verdict: superseded ? 'superseded' : 'unresolved',
      displayedMs: null,
      frame: null,
    }
  }
  function hPresentedOf(
    s: HSample,
    index: number,
    probe: HProbe,
    links: Map<number, FrameLink>,
    trace: TraceEvent[],
  ) {
    const inputAt = s.kind === 'ime' ? s.commitStamp : s.stamp
    const types = s.kind === 'ime' ? ['beforeinput', 'input'] : ['keydown']
    const traceMs =
      inputAt === undefined ? null : traceEventMs(trace, inputAt, types)
    const decided = hDecide(s, index, probe, links, inputAt ?? s.stamp)
    return {
      traceMs: traceMs === null ? null : round1(traceMs),
      presentation: decided.verdict,
      displayedMs: decided.displayedMs,
      displayedFrame: decided.frame,
    }
  }

  /**
   * 036 core C10 (T6a, R2.2, C10 review item 2): the measured move's completion, matched to its own posted
   * `history-exact.sequence` in the per-move records of `__vmdeE2EReplayEnd` (a later move adds its own
   * record, never overwrites). Without its record: 'superseded' when a later `history-exact` was posted
   * (the catch-up runs to that move's completion), 'recovered' on a resync, else 'missing' (a failure).
   * Null when the window posted no `history-exact`.
   */
  const hCatchUpOutcome = (
    own: boolean,
    later: boolean,
    resynced: boolean,
  ): string => {
    if (own) return 'completed'
    if (later) return 'superseded'
    return resynced ? 'recovered' : 'missing'
  }
  function hCatchUp(
    probe: HProbe,
    before: HostStubCounters,
    after: HostStubCounters,
    statsAfter: HStats,
  ) {
    const posts = after.exactPosts.slice(before.exactPosts.length)
    const move = posts[0]
    if (!move) return null
    const endOf = (sequence: number) =>
      probe.ends.find(([seq, at]) => seq === sequence && at >= move.at)
    const own = endOf(move.sequence)
    const later = posts.find((p) => p.sequence !== move.sequence)
    const end = own ?? (later ? endOf(later.sequence) : undefined)
    const outcome = hCatchUpOutcome(
      own !== undefined,
      later !== undefined,
      after.resyncs > before.resyncs,
    )
    return {
      sequence: move.sequence,
      outcome,
      ms:
        end === undefined || probe.zStamp < 0
          ? null
          : Math.round(end[1] - probe.zStamp),
      accountOpenAtEnd: statsAfter.budget?.open ?? null,
    }
  }

  type HStats = Awaited<ReturnType<typeof hReplayStats>>
  /** The replay account after the window: per-class atomic costs and the longest replay work of one task. */
  function hReplayOf(statsBefore: HStats, statsAfter: HStats) {
    const budget = statsAfter.budget
    return {
      atomics: statsAfter.atomics - statsBefore.atomics,
      frames: statsAfter.frames - statsBefore.frames,
      maxTaskMs: budget ? round1(budget.maxTaskMs) : null,
      carriedMs: budget ? round1(budget.carriedMs) : null,
      marks: budget?.marks ?? null,
      classes: budget?.classes ?? null,
      // 036 core C10 (R2.5): the window's miss records (numbers and class names only).
      missLog: budget
        ? budget.missLog.slice(statsBefore.budget?.missLog.length ?? 0)
        : null,
    }
  }

  /** 036 core C10 (R2.5): the window's K14 classification (differences of the budget counters). */
  function hK14Of(statsBefore: HStats, statsAfter: HStats) {
    const d = (
      key: 'missK14' | 'missOther' | 'missLogDropped' | 'budgetMisses',
    ) => (statsAfter.budget?.[key] ?? 0) - (statsBefore.budget?.[key] ?? 0)
    const missK14 = d('missK14')
    const missOther = d('missOther')
    return {
      missK14,
      missOther,
      k14Exempt:
        missOther === 0 &&
        missK14 + missOther === d('budgetMisses') &&
        d('missLogDropped') === 0,
    }
  }
  const kindCount = (kinds: string[], kind: string) =>
    kinds.filter((k) => k === kind).length
  /** The G3 counts of the window (differences of the stub's and the replay's counters). */
  function hG3(
    before: HostStubCounters,
    after: HostStubCounters,
    statsBefore: HStats,
    statsAfter: HStats,
  ) {
    const kinds = (kind: string) =>
      kindCount(after.kinds, kind) - kindCount(before.kinds, kind)
    const delta = (key: 'whole' | 'unbounded' | 'caretFallback') =>
      statsAfter[key] - statsBefore[key]
    return {
      historyExact: kinds('history-exact'),
      historyEdits: after.historyEdits - before.historyEdits,
      abandons: kinds('replay-abandon'),
      unknownStatuses: after.unknownStatuses - before.unknownStatuses,
      resyncs: after.resyncs - before.resyncs,
      replayWhole: delta('whole'),
      replayUnbounded: delta('unbounded'),
      budgetMiss:
        (statsAfter.budget?.budgetMisses ?? 0) -
        (statsBefore.budget?.budgetMisses ?? 0),
      ...hK14Of(statsBefore, statsAfter),
      caretFallback: delta('caretFallback'),
    }
  }

  /**
   * Undoes `count` entries, each after the previous move was answered and its replay operations were
   * acknowledged. Returns the number of Undos that were answered (fewer than `count` when the history
   * was lost on the way).
   */
  async function hUndoFirst(page: Page, count: number): Promise<number> {
    for (let i = 0; i < count; i++) {
      const before = await hostStubCounters(page)
      const answered = before.accepted + before.exactReplays + before.resyncs
      await page.keyboard.press('Control+KeyZ')
      await page.waitForFunction(
        (ops) => {
          const w = window as any
          const s = w.__vmdeHostStub
          return (
            s.accepted + s.exactReplays + s.resyncs > ops &&
            s.lastAckOp >= s.lastReplayOp &&
            !(w.__vmdeModelShadowStats?.replay?.budget?.open ?? false)
          )
        },
        answered,
        { polling: 100, timeout: 120_000 },
      )
      const now = await hostStubCounters(page)
      if (now.resyncs > before.resyncs) return i
    }
    return count
  }

  type HRecord = Awaited<ReturnType<typeof hWindow>>
  /** The gate, as soft assertions so every failing value is listed. */
  function hAssert(
    record: HRecord,
    c: HCase,
    factor: number,
    bytesExact: boolean,
    clipboard: string | null,
  ) {
    expect.soft(record.closed, 'window closed').toBe(true)
    expect.soft(record.accountClosed, 'replay account closed').toBe(true)
    // Task 733 C1 (core plan R1.3): x16 timing is recorded (K5); correctness is gated at every factor.
    // Owner decision Q-273 (K15): the evicted Find Undo is timing exempt (G1, G2 duration) at x1 and x4;
    // its route, bytes, caret and history stay gated.
    const k15 = c.exact === 0
    const timed = factor < 16 && !k15
    if (k15)
      hWrite({
        factor,
        case: c.name,
        known: 'K15',
        g1LongestMs: record.g1LongestMs,
      })
    if (timed)
      expect.soft(record.g1LongestMs, 'G1 longest task').toBeLessThanOrEqual(50)
    hAssertSamples(
      record.samples,
      timed,
      c.placeBy !== 'script',
      factor,
      c.name,
    )
    if (c.enterAlone) {
      const typed = record.samples.filter((s) => s.kind === 'key')
      const [enter, key] = typed
      expect
        .soft(
          enter?.presentation === 'pass' &&
            key !== undefined &&
            enter.displayedMs !== null &&
            enter.displayedMs + enter.stampMs < key.stampMs,
          'Enter is displayed alone before the next key',
        )
        .toBe(true)
    }
    if (c.place?.[4]) {
      expect
        .soft(record.samples[0]?.backwardAtPaint, 'backward at Z paint')
        .toBe(true)
      expect.soft(record.backwardAtEnd, 'backward after the move').toBe(true)
    }
    if (c.clipboard !== undefined)
      expect.soft(clipboard, 'clipboard text/plain').toBe(c.clipboard)
    hAssertCounts(record, c, factor, bytesExact)
  }
  // 036 core C10 (R2.1, T1-T3, T5, T8): G2 from the trace duration and the first displayed frame that shows
  // the expected state. Scripted placement (T5) records the caret only; at x16 timing is recorded (K5) and
  // the caret at a displayed frame stays gated.
  function hAssertTimed(
    s: HRecord['samples'][number],
    caretGated: boolean,
    factor: number,
    name: string,
  ) {
    const verdict = s.presentation
    expect.soft(s.traceMs, `G2 ${s.key} trace duration`).not.toBeNull()
    const displayed =
      verdict === 'pass' ||
      verdict === 'superseded' ||
      (verdict === 'caret' && !caretGated)
    expect.soft(displayed, `G2 ${s.key} displayed (${verdict})`).toBe(true)
    const over =
      (s.traceMs ?? 999) > 50 || (s.displayedMs !== null && s.displayedMs > 50)
    if (!over) return
    // C10 pass rule: a known limit is recorded, not failed, only within its exact class evidence.
    const known = s.traceMs === null ? null : hKnownClass(s, factor)
    if (known) {
      hWrite({
        factor,
        case: name,
        key: s.key,
        known,
        traceMs: s.traceMs,
        displayedMs: s.displayedMs,
      })
      return
    }
    expect
      .soft(s.traceMs ?? 999, `G2 ${s.key} duration`)
      .toBeLessThanOrEqual(50)
    if (s.displayedMs !== null)
      expect
        .soft(s.displayedMs, `G2 ${s.key} displayed within 50 ms`)
        .toBeLessThanOrEqual(50)
  }
  function hAssertSamples(
    samples: HRecord['samples'],
    timed: boolean,
    caretGated: boolean,
    factor = 1,
    name = '',
  ) {
    for (const s of samples) {
      const caretWrong = s.presentation === 'caret' && caretGated
      expect
        .soft(caretWrong, `G2 ${s.key} caret at the displayed frame`)
        .toBe(false)
      if (timed) hAssertTimed(s, caretGated, factor, name)
      if (s.kind !== 'history')
        expect.soft(s.refused, `G2 ${s.key} refused`).toBe(false)
    }
  }
  /** The exact, abandon, resync and unbounded counts; K6 (T7) expects one refusal and records `unbounded`. */
  function hAssertRefusalCounts(g3: HRecord['g3'], k6: boolean, exact: number) {
    expect.soft(g3.historyExact, 'G3 history-exact').toBe(k6 ? 1 : exact)
    expect.soft(g3.abandons, 'G3 replay-abandon').toBe(k6 ? 1 : 0)
    expect.soft(g3.resyncs, 'G3 resyncs').toBe(k6 ? 1 : 0)
    if (!k6) expect.soft(g3.replayUnbounded, 'G3 replay-unbounded').toBe(0)
  }
  /** The catch-up limit: Q-270's for a window with typing or the collapsed Cut, else the plain one. */
  const hCatchUpLimit = (record: HRecord, c: HCase, factor: number): number =>
    (c.name === 'collapsed Cut at an element caret' ||
    record.samples.some((x) => x.kind !== 'history')
      ? H_CATCH_UP_TYPED_MS
      : H_CATCH_UP_MS)[factor]
  function hAssertCounts(
    record: HRecord,
    c: HCase,
    factor: number,
    bytesExact: boolean,
  ) {
    const g3 = record.g3
    // 036 core C10 (T7): the x16 second Undo is the K6 refusal (one abandon, one resync).
    hAssertRefusalCounts(g3, c.x16K6 === true && factor === 16, c.exact ?? 1)
    expect
      .soft(g3.historyEdits, 'G3 edit with history')
      .toBe(c.historyEdits ?? 0)
    expect.soft(g3.unknownStatuses, 'G3 replay-status unknown').toBe(0)
    expect.soft(g3.replayWhole, 'G3 replay-whole').toBe(0)
    // Task 733 C1: the replay budget and the catch-up are timing: gated at x1/x4, recorded at x16 (K5).
    // 036 core C10 (R2.5, K14): a miss is exempt only when every miss of the window is a K14 miss and no
    // miss record was overwritten.
    if (factor < 16)
      expect
        .soft(
          g3.budgetMiss === 0 || g3.k14Exempt,
          `G3 budget-miss ${g3.budgetMiss} (K14 ${g3.missK14}, other ${g3.missOther})`,
        )
        .toBe(true)
    expect.soft(g3.caretFallback, 'G3 caret-fallback').toBe(0)
    expect.soft(bytesExact, 'G3 host bytes').toBe(true)
    // 036 core C10 (T6a): catch-up ends at the measured move's own completion; a window with no
    // `history-exact` keeps the render measure.
    if (factor < 16)
      expect
        .soft(
          (record.catchUp ? record.catchUp.ms : record.renderCatchUpMs) ??
            Number.POSITIVE_INFINITY,
          `G3 render catch-up (${record.catchUp?.outcome ?? 'render'})`,
        )
        .toBeLessThanOrEqual(hCatchUpLimit(record, c, factor))
  }

  /**
   * The setup before the measured window: the Find action, any earlier history and Undos. Returns the
   * text after the measured Find action, or a setup failure (recorded and failed by the caller).
   */
  async function hPrepare(
    page: Page,
    factor: number,
    scaled: string,
    c: HCase,
  ): Promise<{ after: string } | { failed: string }> {
    const replace = c.replace ?? 'ZZZZ'
    const replaced = scaled.replaceAll('ncjw', replace)
    await hFind(page, 'replace-all', 'ncjw', replace, replaced)
    const failed = await (
      c.before?.(page, factor, replaced) ?? Promise.resolve()
    ).then(
      () => undefined,
      (error: unknown) =>
        String(error)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the terminal colors of an assertion message
          .replace(/\u001b\[[0-9;]*m/g, '')
          .split('\n')[0],
    )
    if (failed !== undefined)
      return { failed: `earlier Find actions: ${failed}` }
    const after = c.before ? await stubText(page) : replaced
    const undone = await hUndoFirst(page, c.undoFirst ?? 0)
    // The measured entry is no longer on the history when an earlier Undo resynchronized.
    if (undone < (c.undoFirst ?? 0))
      return {
        failed: `Undo ${undone + 1} of ${c.undoFirst} before Z resynchronized`,
      }
    return { after }
  }

  /** Where the host bytes first differ from the expected bytes (synthetic fixture text only). */
  const hBytesDiff = (want: string, host: string) => {
    let at = 0
    while (at < want.length && want[at] === host[at]) at++
    return {
      at,
      wantLength: want.length,
      hostLength: host.length,
      want: JSON.stringify(want.slice(Math.max(0, at - 12), at + 24)),
      host: JSON.stringify(host.slice(Math.max(0, at - 12), at + 24)),
    }
  }

  /** Seeds the system clipboard with the sentinel a refusal keeps. */
  const hSeedClipboard = (page: Page) =>
    page.evaluate((text) => navigator.clipboard.writeText(text), H_SENTINEL)

  /** H2 fix design rev2 (D3.3): always the system clipboard, never the event's data (a refusal writes none). */
  const hClipboard = async (page: Page) =>
    page.evaluate(() => navigator.clipboard.readText())

  /**
   * The host after a `cutOutcome` case: unchanged with the sentinel, else without the proven cut bytes at
   * the occurrence where the host first differs (the fixture repeats, so the cut line has many copies).
   */
  const hCutOutcome = (
    s: string,
    host: string,
    clip: string | null,
  ): string | null => {
    if (clip === H_SENTINEL) return s
    const line = clip?.endsWith('\n') === true
    let differs = 0
    while (differs < s.length && s[differs] === host[differs]) differs++
    const at = clip ? s.lastIndexOf(clip, differs) : -1
    // A cut is the selection (`H_CUT`) or a whole line with its terminator.
    if (
      !clip ||
      at < 0 ||
      (clip !== H_CUT && !(line && (at === 0 || s[at - 1] === '\n')))
    )
      return null
    return s.slice(0, at) + s.slice(at + clip.length)
  }

  /** A setup failure: recorded with the last post kinds, and failed. */
  async function hSetupFailed(
    page: Page,
    factor: number,
    c: HCase,
    failed: string,
  ) {
    const counters = await hostStubCounters(page)
    hWrite({
      factor,
      case: c.name,
      setupFailed: failed,
      kinds: counters.kinds.slice(-6),
    })
    expect(failed, 'setup').toBeUndefined()
  }

  /** Writes a case's record with the host bytes and clipboard checks, and returns those checks. */
  async function hReport(
    page: Page,
    factor: number,
    c: HCase,
    record: HRecord & { placement?: unknown },
    expected: string,
    scaled: string,
  ) {
    const clipboard =
      c.clipboard === undefined && !c.cutOutcome ? null : await hClipboard(page)
    const host = await stubText(page)
    const outcome = c.cutOutcome
      ? hCutOutcome(scaled, host, clipboard)
      : expected
    const want = outcome ?? expected
    const bytesExact = host === want
    hWrite({
      factor,
      case: c.name,
      ...record,
      clipboard,
      clipboardOk: c.cutOutcome
        ? outcome !== null
        : c.clipboard === undefined
          ? null
          : clipboard === c.clipboard,
      g3: { ...record.g3, bytesExact },
      bytesDiff: bytesExact ? null : hBytesDiff(want, host),
    })
    return { bytesExact, clipboard, outcomeOk: outcome !== null }
  }

  /** One matrix case: the setup, the measured window, the record and the gate. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the clipboard seed, setup, window, report and gate run in this order for every case
  async function hRunCase(
    page: Page,
    factor: number,
    c: HCase,
    recordOnly = false,
  ) {
    const scaled = Array.from({ length: factor }, () => LARGE).join('\n')
    const clipped = c.clipboard !== undefined || c.cutOutcome === true
    if (clipped)
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'])
    await hOpen(
      page,
      scaled,
      c.lateReply ? H_LATE_REPLY_MS[factor] : 0,
      false,
      c.ownershipOff === true,
    )
    if (clipped) await hSeedClipboard(page)
    const prepared = await hPrepare(page, factor, scaled, c)
    if ('failed' in prepared) {
      // 036 core C10 (R2.3): the x16 eviction setup refusal (K6) holds a known state: the Replace All
      // text with the first six EIGHT words replaced, and the webview model equal to the host.
      if (c.name === 'eviction' && factor === 16) {
        let state = scaled.replaceAll('ncjw', 'ZZZZ')
        for (const word of EIGHT.slice(0, 6))
          state = state.replaceAll(word, word.toUpperCase())
        const atState = (await stubText(page)) === state
        const matches = await modelMatchesStub(page)
        expect.soft(atState, 'x16 eviction setup: state 6').toBe(true)
        expect.soft(matches, 'model digest equals the host').toBe(true)
        // C10 pass rule: the setup refusal is K6 (042), recorded, only with that exact evidence.
        if (atState && matches) {
          hWrite({
            factor,
            case: c.name,
            known: 'K6',
            setupFailed: prepared.failed,
          })
          return
        }
      }
      await hSetupFailed(page, factor, c, prepared.failed)
      return
    }
    const after = prepared.after
    const placement = await hPlaceForCase(page, factor, c)
    if (placement === 'failed') return
    const record = await hWindow(
      page,
      c.act,
      {
        expects: c.expects ?? [],
        shows: c.shows ?? [['ncjw', c.replace ?? 'ZZZZ']],
        floor: false,
        groups: c.groups ?? hGroups(c),
        nonReplay: c.exact === 0,
      },
      false,
    )
    const { bytesExact, clipboard, outcomeOk } = await hReport(
      page,
      factor,
      c,
      { ...record, placement },
      c.x16K6 && factor === 16
        ? scaled.replaceAll('ncjw', 'ZZZZ')
        : c.expected(scaled, after),
      scaled,
    )
    // Task 733 C1: the ownership-off K8 control is recorded only.
    if (recordOnly) return
    hAssert(record, c, factor, bytesExact, clipboard)
    if (c.x16K6 && factor === 16)
      expect
        .soft(await modelMatchesStub(page), 'K6: model digest equals the host')
        .toBe(true)
    if (c.cutOutcome)
      expect
        .soft(outcomeOk, 'clipboard holds the sentinel or a proven cut')
        .toBe(true)
    // P1: the selection checked at arm is still the selection when Z's command reaches the editor.
    if (placement?.by === 'gesture')
      expect
        .soft(record.dispatchHolds, 'P1 placement at the Z command dispatch')
        .toBe(true)
  }

  /** 036 core C10 (T2): the unit near the case's caret: the H_PENDING paragraph, else the line-350 list item. */
  const H_DEFAULT_GROUP = 'Cwlcwtnw WrldkhNdpwc.Fggf'
  const hGroups = (c: HCase): Array<string | null> => {
    const needle =
      c.place?.[0] === H_PENDING || c.place?.[0] === H_CUT
        ? H_PENDING
        : H_DEFAULT_GROUP
    const shows: Array<HShows | null> = c.shows ?? [['ncjw', 'ZZZZ']]
    return shows.map((show) => (show ? needle : null))
  }

  /**
   * P1: places the case's selection, waits 3 s and checks it at arm. A gesture placement that does not
   * hold is a setup failure (recorded and failed), not a product result: 'failed'.
   */
  async function hPlaceForCase(page: Page, factor: number, c: HCase) {
    const by = c.placeBy ?? 'gesture'
    const intended = c.place ? await hPlace(page, c.place, by) : null
    // 036 core C10 (Q-275): the caret is on screen before the history key, as a user's would be.
    await page.evaluate(hCaretIntoView)
    await page.waitForTimeout(3000)
    const placement = await hPlacementAtArm(page, intended, by)
    if (placement?.holds !== false || by !== 'gesture') return placement
    await hSetupFailed(
      page,
      factor,
      c,
      `placement did not hold at arm: ${JSON.stringify(placement)}`,
    )
    return 'failed' as const
  }

  /** P1: the selection at arm against the intended placement (offsets in the surface text). */
  async function hPlacementAtArm(
    page: Page,
    intended: { anchor: number; focus: number } | null,
    by: 'gesture' | 'script',
  ) {
    if (!intended) return null
    const atArm = await page.evaluate(hSelectionOffsets)
    return {
      by,
      intended,
      atArm,
      holds:
        atArm !== null &&
        atArm.anchor === intended.anchor &&
        atArm.focus === intended.focus,
    }
  }

  /**
   * The span is reported, not gated (fix design 4.2 and 6, H2); the bytes are gated (Task 733 C1, core plan
   * R1.3). The span in which typed keys are refused while the
   * recovery after a refused replay writes the host text. `q` is pressed once per frame from Z until a
   * key is accepted after the refusal; the span runs from the refusal (the stub's resynchronization) to
   * that key's keydown.
   */
  async function hRefusedSpan(page: Page, factor: number) {
    const scaled = Array.from({ length: factor }, () => LARGE).join('\n')
    await hOpen(page, scaled, 0, true)
    await hFind(
      page,
      'replace-all',
      'ncjw',
      'ZZZZ',
      scaled.replaceAll('ncjw', 'ZZZZ'),
    )
    await hPlace(page, [H_TOP, 6, 0, false, false], 'gesture')
    await page.waitForTimeout(3000)
    const before = await hostStubCounters(page)
    await page.evaluate((a) => (window as any).__h036.arm(a), {
      expects: [],
      shows: [],
      floor: false,
    })
    await page.keyboard.press('Control+KeyZ')
    // A key typed before the Undo arrives would be a typing entry the Undo pops first.
    await page.waitForFunction(
      (ops) => (window as any).__vmdeHostStub.historyOps > ops,
      before.historyOps,
      { polling: 'raf', timeout: 60_000 },
    )
    const limitAt = Date.now() + (factor === 16 ? 180_000 : 60_000)
    // Task 733 C1 (core plan R1.3): the shown keys are counted in the DOM at each key's frame. A refused key
    // must never appear (refused before mutation); every shown key must reach the host.
    const qCount = () =>
      page.evaluate(
        () =>
          (
            (
              (window as any).vditor.vditor.ir.element.textContent as string
            ).match(/q/g) ?? []
          ).length,
      )
    // Baselines read before any key: the editor's text and the host's source count `q` differently.
    const domBaseQ = await qCount()
    const baseQ = ((await stubText(page)).match(/q/g) ?? []).length
    let acceptedAfterRefusal = false
    let appearedWhileRefused = 0
    while (!acceptedAfterRefusal && Date.now() < limitAt) {
      await page.keyboard.press('q')
      const frame = await page.evaluate(
        (resyncs) =>
          new Promise<{ accepted: boolean; refused: boolean; shown: number }>(
            (resolve) =>
              requestAnimationFrame(() => {
                const w = window as any
                const last = w.__h036.samples.at(-1)
                const text = w.vditor.vditor.ir.element.textContent as string
                resolve({
                  accepted:
                    w.__vmdeHostStub.resyncs > resyncs &&
                    last?.refused === false,
                  refused: last?.refused === true,
                  shown: (text.match(/q/g) ?? []).length,
                })
              }),
          ),
        before.resyncs,
      )
      acceptedAfterRefusal = frame.accepted
      const acceptedSoFar = (
        (await page.evaluate(() =>
          (window as any).__h036.samples.map((x: any) => x.refused),
        )) as Array<boolean | null>
      ).filter((r) => r === false).length
      if (frame.refused && frame.shown - domBaseQ > acceptedSoFar)
        appearedWhileRefused++
    }
    await page.waitForTimeout(SETTLE_MS)
    const probe = (await page.evaluate(() => ({
      samples: (window as any).__h036.samples.map(
        ({ expect: _e, ...s }: any) => s,
      ),
      tasks: (window as any).__h036.tasks,
    }))) as Pick<HProbe, 'samples' | 'tasks'>
    const after = await hostStubCounters(page)
    const record = {
      factor,
      case: 'input during the recovery after a refusal',
      ...hRefusedRecord(probe, before, after),
    }
    const shownKeys = probe.samples.filter(
      (x) => x.kind === 'key' && x.refused === false,
    ).length
    const host = await stubText(page)
    const hostQ = (host.match(/q/g) ?? []).length - baseQ
    const domQ = (await qCount()) - domBaseQ
    hWrite({ ...record, appearedWhileRefused, shownKeys, hostQ, domQ })
    expect(record.refusalAtMs, 'the replay was refused').not.toBeNull()
    expect(
      record.inputRefusedSpanMs,
      'a key was accepted after the refusal',
    ).not.toBeNull()
    // Task 733 C1 (core plan R1.3), gated at every factor: refused keys never showed; every shown key is in
    // the host bytes; the host holds the expected document plus exactly the shown keys.
    expect.soft(appearedWhileRefused, 'a refused key appeared').toBe(0)
    expect.soft(domQ, 'shown keys in the editor').toBe(shownKeys)
    expect.soft(hostQ, 'shown keys in the host bytes').toBe(shownKeys)
    // 036 core C10 (T7): the exact bytes, no character filtered out: the refused document with the shown
    // keys at the caret, and the webview model equal to the host.
    expect
      .soft(
        host ===
          hInsert(
            scaled.replaceAll('ncjw', 'ZZZZ'),
            H_TOP,
            6,
            'q'.repeat(shownKeys),
          ),
        'host bytes: the refused document plus the shown keys at the caret',
      )
      .toBe(true)
    expect
      .soft(await modelMatchesStub(page), 'model digest equals the host')
      .toBe(true)
  }

  /** The refusal (the stub's resynchronization) and the keys refused before and after it. */
  function hRefusedRecord(
    probe: Pick<HProbe, 'samples' | 'tasks'>,
    before: HostStubCounters,
    after: HostStubCounters,
  ) {
    const refusal = after.ops
      .slice(before.ops.length)
      .find((o) => o.outcome === 'resync')
    const keys = probe.samples.filter((s) => s.kind === 'key')
    const longestTaskMs = Math.round(
      probe.tasks.reduce((m, [, d]) => Math.max(m, d), 0),
    )
    const resyncs = after.resyncs - before.resyncs
    if (!refusal)
      return {
        refusalAtMs: null,
        refusedBeforeRefusal: null,
        refusedAfterRefusal: null,
        inputRefusedSpanMs: null,
        longestTaskMs,
        resyncs,
      }
    const accepted = keys.find(
      (s) => s.stamp >= refusal.at && s.refused === false,
    )
    return {
      refusalAtMs: Math.round(refusal.at - probe.samples[0].stamp),
      refusedBeforeRefusal: keys.filter(
        (s) => s.stamp < refusal.at && s.refused,
      ).length,
      refusedAfterRefusal: keys.filter(
        (s) => s.stamp >= refusal.at && s.refused,
      ).length,
      inputRefusedSpanMs: accepted
        ? Math.round(accepted.stamp - refusal.at)
        : null,
      longestTaskMs,
      resyncs,
    }
  }

  for (const factor of [1, 4, 16]) {
    test(`H x${factor} baseline: one typed key, no replay (reported, not gated)`, async ({
      page,
    }) => {
      test.setTimeout(900_000)
      const scaled = Array.from({ length: factor }, () => LARGE).join('\n')
      await hOpen(page, scaled)
      await hPlace(page, [H_TOP, 6, 0, false, false], 'gesture')
      await page.waitForTimeout(3000)
      const record = await hWindow(
        page,
        async ({ page: p }) => p.keyboard.press('q'),
        { expects: [{ prev: 'q' }], shows: [], floor: true },
        true,
      )
      hWrite({ factor, case: 'baseline', ...record })
      expect(record.closed).toBe(true)
      expect((await stubText(page)) === hInsert(scaled, H_TOP, 6, 'q')).toBe(
        true,
      )
    })

    test(`H x${factor} input during the recovery after a refusal (span reported, bytes gated)`, async ({
      page,
    }) => {
      test.setTimeout(900_000)
      await hRefusedSpan(page, factor)
    })

    for (const c of H_CASES)
      test(`H x${factor} ${c.name}: G1, G2 and G3 within the gate`, async ({
        page,
      }) => {
        test.setTimeout(factor === 16 ? 1_800_000 : 900_000)
        await hRunCase(page, factor, c)
      })

    // Task 733 C1 (core plan R1.3): the three tagged-Find cases of H3 item 1 also run once with ownership
    // off, as the recorded K8 control (no gate). With ownership on they run in the loop above.
    for (const c of H_CASES.filter((x) => H4_TAGGED_FIND.includes(x.name)))
      test(`H x${factor} ${c.name} (ownership off, recorded K8 control)`, async ({
        page,
      }) => {
        test.setTimeout(factor === 16 ? 1_800_000 : 900_000)
        await hRunCase(page, factor, { ...c, ownershipOff: true }, true)
      })
  }

  // 036 S5.2 (S5 design rev 2 sections 2 and 3): the x16 eviction setup once, with the route of each of
  // Undo 1-8 recorded: the engine or the sliced restore, the counted route to the sliced restore, the
  // dry-run state at the key, and why a sliced restore failed. Edits inside loose lists still refuse at
  // plan time, so only what holds now is asserted: the counters are published, and the host bytes are
  // exact after every Undo the engine took. Counters hold kinds and numbers only.
  test.describe('036 S5', () => {
    /** The session and sliced-restore counters, read between moves (no document text). */
    const s5Counters = (page: Page) =>
      page.evaluate(() => {
        const w = window as any
        const replay = w.__vmdeModelShadowStats?.replay ?? {}
        const sliced = w.__vmdeSlicedRestore ?? null
        return {
          engine: (replay.engine ?? 0) as number,
          whole: (replay.whole ?? 0) as number,
          unplannable: (replay.unplannable ?? 0) as number,
          mismatch: (replay.mismatch ?? 0) as number,
          unbounded: (replay.unbounded ?? 0) as number,
          route: (replay.route ?? null) as Record<string, number> | null,
          dryRun: (replay.dryRun ?? null) as Record<string, number> | null,
          lastDryRun: (replay.lastDryRun ?? null) as Record<
            string,
            unknown
          > | null,
          lastRefusal: (replay.lastRefusal ?? null) as Record<
            string,
            unknown
          > | null,
          sliced: sliced as null | {
            sliced: number
            whole: number
            slices: number
            failed?: Record<string, number>
          },
        }
      })
    type S5Counters = Awaited<ReturnType<typeof s5Counters>>
    /** The counts that changed between two reads, by kind. */
    const s5Delta = (
      before: Record<string, number> | null | undefined,
      after: Record<string, number> | null | undefined,
    ) => {
      const out: Record<string, number> = {}
      for (const [kind, n] of Object.entries(after ?? {}))
        if (n !== (before?.[kind] ?? 0)) out[kind] = n - (before?.[kind] ?? 0)
      return out
    }
    const s5Route = (before: S5Counters, after: S5Counters) => ({
      engine: after.engine - before.engine,
      sliced: after.whole - before.whole,
      unplannable: after.unplannable - before.unplannable,
      mismatch: after.mismatch - before.mismatch,
      unbounded: after.unbounded - before.unbounded,
      route: s5Delta(before.route, after.route),
      dryRunAtKey: s5Delta(before.dryRun, after.dryRun),
      lastDryRun: after.lastDryRun,
      lastRefusal: after.lastRefusal,
      slicedRestores:
        (after.sliced?.sliced ?? 0) - (before.sliced?.sliced ?? 0),
      slices: (after.sliced?.slices ?? 0) - (before.sliced?.slices ?? 0),
      slicedFailed: s5Delta(before.sliced?.failed, after.sliced?.failed),
    })

    /** One Undo after the previous move settled: its route, recorded, with the checks that hold now. */
    async function s5Undo(
      page: Page,
      factor: number,
      undo: number,
      want: string,
    ) {
      const before = await s5Counters(page)
      const stubBefore = await hostStubCounters(page)
      const answered = await hUndoFirst(page, 1)
      const after = await s5Counters(page)
      const stubAfter = await hostStubCounters(page)
      const route = s5Route(before, after)
      const host = await stubText(page)
      const record = {
        factor,
        case: 'S5 eviction route',
        undo,
        answered: answered === 1,
        ...route,
        historyExact: stubAfter.exactReplays - stubBefore.exactReplays,
        historyEdits: stubAfter.historyEdits - stubBefore.historyEdits,
        resyncs: stubAfter.resyncs - stubBefore.resyncs,
        bytesExact: host === want,
        bytesDiff: host === want ? null : hBytesDiff(want, host),
      }
      hWrite(record)
      expect.soft(after.route, `Undo ${undo}: route counters`).not.toBeNull()
      expect.soft(after.dryRun, `Undo ${undo}: dry-run counters`).not.toBeNull()
      // The sliced-restore counters exist once a sliced restore ran.
      if (route.sliced > 0)
        expect
          .soft(
            after.sliced?.failed ?? null,
            `Undo ${undo}: sliced failure counters`,
          )
          .not.toBeNull()
      if (route.engine > 0 && record.resyncs === 0)
        expect.soft(record.bytesExact, `Undo ${undo}: engine bytes`).toBe(true)
      return record
    }

    test('x16 eviction: Undo 1-8 routes, dry-run state at the key and sliced-restore failure (recorded)', async ({
      page,
    }) => {
      test.setTimeout(1_800_000)
      const factor = 16
      const scaled = Array.from({ length: factor }, () => LARGE).join('\n')
      await hOpen(page, scaled)
      // The eviction case's setup: the measured Find action, then eight more (the first record is evicted).
      const texts = [scaled.replaceAll('ncjw', 'ZZZZ')]
      await hFind(page, 'replace-all', 'ncjw', 'ZZZZ', texts[0])
      for (const word of EIGHT)
        texts.push(
          await hWordAction(
            page,
            factor,
            texts.at(-1) ?? '',
            word,
            word.toUpperCase(),
          ),
        )
      const records: unknown[] = []
      for (let undo = 1; undo <= 8; undo++) {
        const record = await s5Undo(page, factor, undo, texts[8 - undo])
        records.push(record)
        // A resynchronized history no longer holds the later entries.
        if (!record.answered || record.resyncs > 0) break
      }
      expect(records.length, 'Undo moves recorded').toBeGreaterThan(0)
    })
  })

  // Task 733 / 036 D-18 (design rev 4.1 R41.5, with the accepted review changes): the IR editor owns its
  // Undo/Redo chords at keydown. The probe is registered before boot, so its window-capture listener sees
  // every chord before the owned path consumes it. Per chord it records the keydown time, the post-paint
  // mark of the first frame after it (a `requestAnimationFrame` callback, then a `MessageChannel` message:
  // the same presentation proxy as the H matrix) and the post-paint mark after the first change of the IR
  // surface. It counts `trigger-toolbar-hotkey` Undo/Redo commands: an owned press posts none. The 50 ms
  // operation limit gates x1 and x4 and is recorded at x16; the 15 ms replay limit is read from the replay
  // budget counters and recorded as an overrun at every factor (H3 measured 31.3 ms at x16, tracked
  // separately). With `D18_OUT` set, each case is appended to that file as one JSON line (no text).
  test.describe('036 D-18 owned keys', () => {
    const D18_OP_MS = 50
    const D18_REPLAY_MS = 15
    const D18_TOKEN = 'ncjw'
    const D18_PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
    const scaledLarge = (factor: number) =>
      Array.from({ length: factor }, () => LARGE).join('\n')

    async function installD18Probe(page: Page) {
      await page.addInitScript(() => {
        const probe = {
          commands: 0,
          keys: [] as Array<{
            code: string
            at: number
            repeat: boolean
            firstPaint: number
            changedPaint: number
          }>,
          // Task 733 C1: Event Timing keydown entries (startTime is input creation) and long frames.
          events: [] as Array<{
            start: number
            duration: number
            processingEnd: number
          }>,
          frames: [] as Array<{
            start: number
            duration: number
            blocking: number
          }>,
        }
        ;(window as any).__d18 = probe
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as PerformanceEventTiming[])
            if (e.name === 'keydown')
              probe.events.push({
                start: e.startTime,
                duration: e.duration,
                processingEnd: e.processingEnd,
              })
        }).observe({
          type: 'event',
          durationThreshold: 16,
          buffered: true,
        } as PerformanceObserverInit)
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as any[])
              probe.frames.push({
                start: e.startTime,
                duration: e.duration,
                blocking: e.blockingDuration,
              })
          }).observe({
            type: 'long-animation-frame',
            buffered: true,
          } as PerformanceObserverInit)
        } catch {
          // No long-animation-frame support: nothing recorded.
        }
        const postPaint = (fn: (at: number) => void) =>
          requestAnimationFrame(() => {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => fn(performance.now())
            channel.port2.postMessage(0)
          })
        window.addEventListener('message', (event) => {
          const data = event.data
          if (
            data?.command === 'trigger-toolbar-hotkey' &&
            (data.name === 'undo' || data.name === 'redo')
          )
            probe.commands++
        })
        window.addEventListener(
          'keydown',
          (event) => {
            const history =
              (event.ctrlKey || event.metaKey) &&
              (event.code === 'KeyZ' || event.code === 'KeyY')
            if (!history) return
            const sample = {
              code: event.code,
              at: event.timeStamp,
              repeat: event.repeat,
              firstPaint: -1,
              changedPaint: -1,
            }
            probe.keys.push(sample)
            postPaint((at) => {
              sample.firstPaint = at
            })
            const root = (window as any).vditor?.vditor?.ir?.element as
              | HTMLElement
              | undefined
            if (!root) return
            const observer = new MutationObserver(() => {
              observer.disconnect()
              postPaint((at) => {
                sample.changedPaint = at
              })
            })
            observer.observe(root, {
              childList: true,
              subtree: true,
              characterData: true,
            })
            setTimeout(() => observer.disconnect(), 10_000)
          },
          true,
        )
      })
    }

    // 036 core C10 (T8): each D-18 case is traced from open to its report.
    const d18Traces = new WeakMap<Page, () => Promise<TraceEvent[]>>()
    async function openD18(
      page: Page,
      content: string,
      refuseExact = false,
      attribution = false,
    ) {
      await installD18Probe(page)
      await openSourceSet(page, 'none', content, {}, false, refuseExact)
      await live(page)
      const cdp = await page.context().newCDPSession(page)
      d18Traces.set(page, await startTrace(cdp, attribution))
    }

    /** The probe, the owned counters, both stacks, the caret and the replay budget (numbers only). */
    const d18State = (page: Page) =>
      page.evaluate(() => {
        const win = window as any
        const inner = win.vditor.vditor
        const selection = getSelection()
        const focus = selection?.focusNode
        const budget = win.__vmdeModelShadowStats?.replay?.budget
        return {
          probe: win.__d18 as {
            commands: number
            keys: Array<{
              code: string
              at: number
              repeat: boolean
              firstPaint: number
              changedPaint: number
            }>
            events: Array<{
              start: number
              duration: number
              processingEnd: number
            }>
            frames: Array<{ start: number; duration: number; blocking: number }>
          },
          owned: { ...(win.__vmdeOwnedHistory ?? {}) } as Record<
            string,
            number
          >,
          depth: win.__vmdeUnitHistory?.depth?.(inner) as
            | { undo: number; redo: number }
            | undefined,
          caret: {
            inRoot: focus ? inner.ir.element.contains(focus) : false,
            collapsed: selection?.isCollapsed ?? false,
            offset: selection?.focusOffset ?? -1,
          },
          budget: budget
            ? {
                maxTaskMs: budget.maxTaskMs as number,
                misses: budget.budgetMisses as number,
                open: budget.open as boolean,
                // 036 core C10 (R2.5): every miss attributed to K14, none overwritten.
                k14Exempt: budget.k14Exempt === true,
                missK14: (budget.missK14 ?? 0) as number,
                missOther: (budget.missOther ?? 0) as number,
                // The miss records (numbers and class names only), recorded.
                missLog: (budget.missLog ?? []) as unknown[],
              }
            : null,
        }
      })

    /**
     * 036 core C10 (T8): one owned keydown's duration is the unrounded `EventTiming` trace event matched by
     * `timeStamp` (within 0.1 ms); it passes at 50 ms or less. No matching trace event: unresolved (null),
     * a failure. The rounded Event Timing entry is recorded beside it. Without a trace (`traceMs`
     * undefined, the untraced L1 block) the C1 rule stays: 48 is unresolved unless its processing end
     * proves it over 50 ms.
     */
    const d18Untraced = (
      entry:
        | { duration: number; processingEnd: number; start: number }
        | undefined,
    ): { reportedMs: number | null; resolvedMs: number | null } => {
      if (!entry) return { reportedMs: null, resolvedMs: null }
      if (entry.duration !== 48)
        return { reportedMs: entry.duration, resolvedMs: entry.duration }
      const lower = entry.processingEnd - entry.start
      return { reportedMs: 48, resolvedMs: lower > D18_OP_MS ? lower : null }
    }
    const d18Resolve = (
      entry:
        | { duration: number; processingEnd: number; start: number }
        | undefined,
      traceMs?: number | null,
    ): { reportedMs: number | null; resolvedMs: number | null } => {
      if (traceMs === undefined) return d18Untraced(entry)
      return {
        reportedMs: entry?.duration ?? null,
        resolvedMs: traceMs === null ? null : round1(traceMs),
      }
    }

    /**
     * One owned keydown's record: the trace-resolved duration (T8) and, Q-276 (S-1), a slow sample's
     * browser-message task with no editor script, recorded and taken off the gated value as a
     * test-environment cost.
     */
    const d18Sample = (
      k: {
        code: string
        at: number
        repeat: boolean
        firstPaint: number
        changedPaint: number
      },
      events: Array<{ start: number; duration: number; processingEnd: number }>,
      trace: TraceEvent[],
    ) => {
      const entry = events.find((e) => Math.abs(e.start - k.at) < 1)
      const resolved = d18Resolve(entry, traceEventMs(trace, k.at, ['keydown']))
      const slow =
        resolved.resolvedMs !== null && resolved.resolvedMs > D18_OP_MS
      const envTaskMs = slow ? round1(traceEnvTaskMs(trace, k.at)) : 0
      return {
        code: k.code,
        repeat: k.repeat,
        ...resolved,
        envTaskMs,
        gatedMs:
          resolved.resolvedMs === null
            ? null
            : round1(resolved.resolvedMs - envTaskMs),
        // The queue-starved post-paint marks, recorded only.
        firstPaintMs: k.firstPaint < 0 ? null : k.firstPaint - k.at,
        changedPaintMs: k.changedPaint < 0 ? null : k.changedPaint - k.at,
      }
    }

    /**
     * Records the case and gates it: zero commands, every operation id acknowledged; at x1/x4 the Event
     * Timing gate and the replay budget (`budgetMisses > 0` or `maxTaskMs > 15` fails); x16 timing is
     * recorded only. The budget is read after the replay account closed.
     */
    async function d18Report(
      page: Page,
      name: string,
      factor: number,
      ownedPresses: number,
    ) {
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as any).__vmdeModelShadowStats?.replay?.budget?.open ??
                false,
            ),
          { timeout: 120_000, message: 'replay account closed' },
        )
        .toBe(false)
      const state = await d18State(page)
      const counters = await hostStubCounters(page)
      const endTrace = d18Traces.get(page)
      d18Traces.delete(page)
      const trace = endTrace ? await endTrace() : []
      const samples = state.probe.keys.map((k) =>
        d18Sample(k, state.probe.events, trace),
      )
      // C10 pass rule: in the x4 repeat case a pop of typing outside a replay is K1 up to 52 ms and an
      // unattributed late sample K4 up to 72 ms (core plan 3.3); recorded, not failed. Anything else fails.
      const knownOf = (ms: number | null): 'K1' | 'K4' | null => {
        if (name !== 'repeat-x8' || factor !== 4 || ms === null) return null
        if (ms <= 52) return 'K1'
        return ms <= 72 ? 'K4' : null
      }
      const known = samples
        .filter((k) => k.gatedMs !== null && k.gatedMs > D18_OP_MS)
        .map((k) => ({ ms: k.gatedMs, known: knownOf(k.gatedMs) }))
      const gateFailures = samples.filter(
        (k) =>
          k.gatedMs === null ||
          (k.gatedMs > D18_OP_MS && knownOf(k.gatedMs) === null),
      ).length
      // 036 core C10 (R2.5): a miss is exempt only when every miss is an attributed K14 miss.
      const replayOverrun =
        state.budget !== null &&
        (state.budget.maxTaskMs > D18_REPLAY_MS || state.budget.misses > 0) &&
        !state.budget.k14Exempt
      const first = state.probe.keys[0]?.at ?? 0
      const record = {
        case: name,
        factor,
        commands: state.probe.commands,
        owned: state.owned,
        depth: state.depth,
        caret: state.caret,
        samples,
        gateFailures,
        known,
        replay: state.budget,
        replayOverrun,
        longFrames: state.probe.frames
          .filter((f) => f.start >= first - 100)
          .map((f) => ({
            atMs: Math.round(f.start - first),
            ms: Math.round(f.duration),
            blockingMs: Math.round(f.blocking ?? -1),
          })),
        lastReplayOp: counters.lastReplayOp,
        lastAckOp: counters.lastAckOp,
        resyncs: counters.resyncs,
      }
      const out = process.env.D18_OUT
      if (out) appendFileSync(out, `${JSON.stringify(record)}\n`)
      console.log(`[d18] ${JSON.stringify(record)}`)
      expect(state.probe.commands, 'owned presses post no command').toBe(0)
      expect(
        (state.owned.ownedUndo ?? 0) + (state.owned.ownedRedo ?? 0),
        'owned presses',
      ).toBe(ownedPresses)
      expect(counters.lastAckOp, 'every replay operation acknowledged').toBe(
        counters.lastReplayOp,
      )
      if (factor < 16) {
        expect
          .soft(gateFailures, `owned keydown to paint over ${D18_OP_MS} ms`)
          .toBe(0)
        expect
          .soft(replayOverrun, `replay task over ${D18_REPLAY_MS} ms`)
          .toBe(false)
      }
      return record
    }

    /** The text is `base` with exactly one `key` inserted. */
    const oneInserted = (text: string, base: string, key: string) => {
      if (text.length !== base.length + key.length) return false
      let i = 0
      while (i < base.length && text[i] === base[i]) i++
      return (
        text.slice(i, i + key.length) === key &&
        text.slice(i + key.length) === base.slice(i)
      )
    }

    for (const factor of [1, 4, 16])
      test(`x${factor}: Save during an owned sliced replay replies with the undone host bytes`, async ({
        page,
      }) => {
        const scaled = scaledLarge(factor)
        // Q-276: the Save case traces task attribution too (S-1).
        await openD18(page, scaled, false, true)
        const after = scaled.replaceAll(D18_TOKEN, 'ZZZZ')
        await findAction(page, 'replace-all', D18_TOKEN, 'ZZZZ', after, {
          timeout: factor > 1 ? 120_000 : 5000,
        })
        await caretIn(page, D18_PARAGRAPH, 4)
        await page.keyboard.press('Control+KeyZ')
        await requestFlush(page, 'd18-save')
        await expect
          .poll(async () => (await hostStubState(page)).flushReplies.length, {
            timeout: 60_000,
          })
          .toBe(1)
        await expect
          .poll(async () => (await stubText(page)) === scaled, {
            timeout: 60_000,
          })
          .toBe(true)
        const state = await hostStubState(page)
        expect(state.flushRequests).toEqual(['d18-save'])
        expect(state.flushReplies[0].requestId).toBe('d18-save')
        // The reply comes after the replay's own posts: the bytes Save writes are the undone text.
        expect(state.flushReplies[0].text === scaled, 'Save bytes').toBe(true)
        expect(state.resyncs).toBe(0)
        const record = await d18Report(page, 'save-during-replay', factor, 1)
        expect(record.depth?.redo).toBe(1)
      })

    test('x1: a refused owned replay resynchronizes once, and the editor shows the host text', async ({
      page,
    }) => {
      await openD18(page, DOC, true)
      const after = DOC.replaceAll('item', 'ZZZZ')
      await findAction(page, 'replace-all', 'item', 'ZZZZ', after)
      await caretIn(page, 'Tail para.', 4)
      await page.keyboard.press('Control+KeyZ')
      await expect.poll(async () => (await hostStubState(page)).resyncs).toBe(1)
      await expect.poll(() => editorShows(page, 'ZZZZ')).toBe(true)
      expect(await kindsOf(page, 'history-exact')).toBe(1)
      await d18Report(page, 'resync-during-replay', 1, 1)
    })

    for (const factor of [1, 4, 16])
      test(`x${factor}: Ctrl+Z held for eight repeats over eight typed entries and a replay ends at the original bytes`, async ({
        page,
      }) => {
        const scaled = scaledLarge(factor)
        await openD18(page, scaled)
        const after = scaled.replaceAll(D18_TOKEN, 'ZZZZ')
        await findAction(page, 'replace-all', D18_TOKEN, 'ZZZZ', after, {
          timeout: factor > 1 ? 120_000 : 5000,
        })
        await caretIn(page, D18_PARAGRAPH, 4)
        // Task 733 C1: eight real entries. Each key is 1,200 ms after the previous one (over the 800 ms entry
        // window), and each checkpoint is verified: the undo depth grows by one per key.
        const depthNow = () =>
          page.evaluate(
            () =>
              (
                (window as any).__vmdeUnitHistory.depth(
                  (window as any).vditor.vditor,
                ) as { undo: number; redo: number }
              ).undo,
          )
        const startDepth = await depthNow()
        for (let i = 0; i < 8; i++) {
          await page.keyboard.type('k')
          await page.waitForTimeout(1200)
          await expect
            .poll(depthNow, { message: `checkpoint ${i + 1}` })
            .toBe(startDepth + i + 1)
        }
        expect(await depthNow(), 'seeded depth: base, Find, 8 typed').toBe(10)
        await expect
          .poll(async () =>
            oneInserted(await stubText(page), after, 'kkkkkkkk'),
          )
          .toBe(true)
        // Nine keydowns of one held key (real auto-repeat: `keyboard.down` again before the release).
        await page.keyboard.down('Control')
        for (let i = 0; i < 9; i++) await page.keyboard.down('KeyZ')
        await page.keyboard.up('KeyZ')
        await page.keyboard.up('Control')
        await expect
          .poll(async () => (await stubText(page)) === scaled, {
            timeout: 60_000,
          })
          .toBe(true)
        expect((await hostStubState(page)).resyncs).toBe(0)
        const record = await d18Report(page, 'repeat-x8', factor, 9)
        expect(
          record.samples.map((k) => k.repeat),
          'the first keydown and eight repeats',
        ).toEqual([false, true, true, true, true, true, true, true, true])
        expect(record.depth?.redo).toBe(9)
      })

    test('x16: keys typed right after an owned Ctrl+Z over pending typing are kept', async ({
      page,
    }) => {
      const scaled = scaledLarge(16)
      await openD18(page, scaled)
      await caretIn(page, D18_PARAGRAPH, 4)
      await page.keyboard.type('abc', { delay: 0 })
      await page.keyboard.press('Control+KeyZ', { delay: 0 })
      await page.keyboard.type('q', { delay: 0 })
      await expect
        .poll(async () => oneInserted(await stubText(page), scaled, 'q'), {
          timeout: 60_000,
        })
        .toBe(true)
      await page.waitForTimeout(SETTLE_MS)
      expect(oneInserted(await stubText(page), scaled, 'q')).toBe(true)
      const record = await d18Report(page, 'pending-typing', 16, 1)
      expect(record.caret.inRoot).toBe(true)
      expect(record.caret.collapsed).toBe(true)
    })

    for (const factor of [1, 16])
      test(`x${factor}: Ctrl+Z then q with no delay keeps q and undoes the Find entry`, async ({
        page,
      }) => {
        const scaled = scaledLarge(factor)
        await openD18(page, scaled)
        const after = scaled.replaceAll(D18_TOKEN, 'ZZZZ')
        await findAction(page, 'replace-all', D18_TOKEN, 'ZZZZ', after, {
          timeout: factor > 1 ? 120_000 : 5000,
        })
        await caretIn(page, D18_PARAGRAPH, 4)
        await page.keyboard.press('Control+KeyZ', { delay: 0 })
        await page.keyboard.press('KeyQ', { delay: 0 })
        await expect
          .poll(async () => oneInserted(await stubText(page), scaled, 'q'), {
            timeout: 60_000,
          })
          .toBe(true)
        await page.waitForTimeout(SETTLE_MS)
        expect(oneInserted(await stubText(page), scaled, 'q')).toBe(true)
        expect(await kindsOf(page, 'history-exact')).toBe(1)
        const record = await d18Report(page, 'undo-then-q', factor, 1)
        // The typed key is a new entry after the Undo: it cleared Redo.
        expect(record.depth?.redo).toBe(0)
        expect(record.caret.collapsed).toBe(true)
      })

    // ---- 036 core C3 (L1): the replay yields to an input; presses at the start and with no move ----
    test.describe('036 core L1', () => {
      /**
       * The L1 gate: each owned keydown from input creation to paint. No Event Timing entry means the key
       * took under the 16 ms observer threshold, a pass; otherwise the D-18 rounding rule applies. The
       * replay budget is recorded here and gated by the D-18 block.
       */
      async function l1Report(page: Page, name: string, factor: number) {
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (window as any).__vmdeModelShadowStats?.replay?.budget
                    ?.open ?? false,
              ),
            { timeout: 120_000 },
          )
          .toBe(false)
        const state = await d18State(page)
        // 036 core C10 (T8): the same-run trace resolves each owned keydown; no trace event is unresolved.
        const endTrace = d18Traces.get(page)
        d18Traces.delete(page)
        const trace = endTrace ? await endTrace() : []
        const samples = state.probe.keys.map((k) => {
          const entry = state.probe.events.find(
            (e) => Math.abs(e.start - k.at) < 1,
          )
          return d18Resolve(entry, traceEventMs(trace, k.at, ['keydown']))
            .resolvedMs
        })
        console.log(
          `[l1] ${JSON.stringify({ case: name, factor, samples, replay: state.budget })}`,
        )
        expect(state.probe.commands, 'owned presses post no command').toBe(0)
        for (const ms of samples)
          expect(
            ms,
            `owned keydown to paint over ${D18_OP_MS} ms`,
          ).not.toBeNull()
        expect(
          samples.filter((ms) => ms !== null && ms > D18_OP_MS).length,
          `owned keydown to paint over ${D18_OP_MS} ms`,
        ).toBe(0)
      }

      for (const factor of [1, 4])
        test(`x${factor}: the start press of an owned replay is gated from input creation`, async ({
          page,
        }) => {
          const scaled = scaledLarge(factor)
          await openD18(page, scaled)
          const after = scaled.replaceAll(D18_TOKEN, 'ZZZZ')
          await findAction(page, 'replace-all', D18_TOKEN, 'ZZZZ', after, {
            timeout: factor > 1 ? 120_000 : 5000,
          })
          await caretIn(page, D18_PARAGRAPH, 4)
          await page.keyboard.press('Control+KeyZ')
          await expect
            .poll(async () => (await stubText(page)) === scaled, {
              timeout: 60_000,
            })
            .toBe(true)
          await l1Report(page, 'l1-start-press', factor)
        })

      for (const factor of [1, 4])
        test(`x${factor}: a zero-move press while the history is held busy posts nothing and is gated`, async ({
          page,
        }) => {
          const scaled = scaledLarge(factor)
          await openD18(page, scaled)
          await caretIn(page, D18_PARAGRAPH, 4)
          const before = await hostStubCounters(page)
          // The forced busy flag holds the history busy with no replay live (e2e only).
          // 036 core C10: the unit history has claimed the editor (an owned key needs it; before the claim the
          // press takes the command path by design, D-18 rev 4.1), so the press is owned.
          await expect
            .poll(() =>
              page.evaluate(() => {
                const w = window as any
                return (
                  w.__vmdeUnitHistory?.ownsHistoryNow?.(w.vditor?.vditor) ===
                  true
                )
              }),
            )
            .toBe(true)
          await page.evaluate(() => {
            ;(window as any).__vmdeE2EForceBusy = true
          })
          await page.keyboard.press('Control+KeyZ')
          await page.waitForTimeout(SETTLE_MS)
          await page.evaluate(() => {
            delete (window as any).__vmdeE2EForceBusy
          })
          // Edit and history posts only (the reading-position saves are not edits).
          const kinds = (await hostStubCounters(page)).kinds
            .slice(before.kinds.length)
            .filter((k) => /edit|history|replay/u.test(k))
          expect(kinds, 'no post for a refused press').toEqual([])
          expect(await stubText(page)).toBe(scaled)
          await l1Report(page, 'l1-zero-move', factor)
        })

      for (const factor of [1, 4])
        test(`x${factor}: a key during the held first slice is kept and the replay ends exact`, async ({
          page,
        }) => {
          const scaled = scaledLarge(factor)
          await openD18(page, scaled)
          const after = scaled.replaceAll(D18_TOKEN, 'ZZZZ')
          await findAction(page, 'replace-all', D18_TOKEN, 'ZZZZ', after, {
            timeout: factor > 1 ? 120_000 : 5000,
          })
          await caretIn(page, D18_PARAGRAPH, 4)
          await page.evaluate(() => {
            ;(window as any).__vmdeE2EReplayHold = true
          })
          await page.keyboard.press('Control+KeyZ')
          await page.keyboard.press('KeyQ')
          // releaseFirstSlice()
          await page.evaluate(() => {
            delete (window as any).__vmdeE2EReplayHold
          })
          await expect
            .poll(async () => oneInserted(await stubText(page), scaled, 'q'), {
              timeout: 60_000,
            })
            .toBe(true)
          expect(await kindsOf(page, 'history-exact')).toBe(1)
          await l1Report(page, 'l1-first-slice-hold', factor)
        })
    })
  })

  // ---- 036 core R1 (frozen-core plan): mutations during a replay and at a mode switch are posted ----
  test.describe('036 core R1', () => {
    const R1_TOKEN = 'ncjw'
    const R1_PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
    /** The kinds the stub received, each with the edit mode Vditor showed when it was posted. */
    const recordPostModes = (page: Page) =>
      page.evaluate(() => {
        const win = window as any
        const kinds = win.__vmdeHostStub.kinds as string[]
        const modes: string[] = []
        win.__r1PostModes = modes
        const push = kinds.push.bind(kinds)
        kinds.push = (...items: string[]) => {
          for (const item of items)
            modes.push(`${item}@${win.vditor.vditor.currentMode}`)
          return push(...items)
        }
      })
    /** 'exact', 'replacement' (the undone Find text came back), or the first differing offset (numbers only). */
    const r1Compare = (text: string, expected: string): string => {
      if (text === expected) return 'exact'
      if (text.includes('ZZZZ')) return 'replacement'
      let d = 0
      while (d < text.length && text[d] === expected[d]) d++
      return `other at ${d} of ${expected.length}, length ${text.length - expected.length}`
    }
    const postModes = (page: Page) =>
      page.evaluate(() => [...((window as any).__r1PostModes as string[])])

    for (const path of ['toolbar', 'chord'] as const)
      test(`mode-switch-visible-insertion (${path}): an insertValue then a switch in the same task posts one delta first`, async ({
        page,
      }) => {
        await openSourceSet(page, 'none', DOC)
        await live(page)
        await caretIn(page, 'Tail para.', 4)
        await recordPostModes(page)
        await page.evaluate((how) => {
          const v = (window as any).vditor
          v.insertValue('Q')
          if (how === 'toolbar') {
            v.vditor.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
              new MouseEvent('click', { bubbles: true }),
            )
            document
              .querySelector<HTMLButtonElement>('button[data-mode="sv"]')
              ?.click()
          } else {
            // The chord path: Vditor's own edit-mode chord, sent as the contained untrusted keydown the
            // editor's actions send (`runVditorChord`).
            const root = v.vditor.ir.element as HTMLElement
            const event = new KeyboardEvent('keydown', {
              key: '9',
              code: 'Digit9',
              altKey: true,
              ctrlKey: true,
              bubbles: true,
              cancelable: true,
            })
            root.dispatchEvent(event)
          }
        }, path)
        await expect(page.locator('.vditor-sv')).toBeVisible()
        const expected = typedInto('Tail para.', 4, 'Q')
        await expect
          .poll(async () => (await stubText(page)) === expected)
          .toBe(true)
        await page.waitForTimeout(SETTLE_MS)
        // One delta, posted while Vditor still showed IR; the later flush (onModeChange) posted nothing.
        const modes = await postModes(page)
        expect(modes.filter((m) => m.startsWith('edit-delta'))).toEqual([
          'edit-delta@ir',
        ])
        expect(modes.filter((m) => m.startsWith('edit@'))).toEqual([])
        expect((await hostStubState(page)).resyncs).toBe(0)
        expect(await stubText(page)).toBe(expected)
      })

    // Plain paragraphs: Vditor's Source text of them is byte-exact, so the stub (which applies a whole
    // `edit` as sent, with no host writeback minimization) shows exactly what the switch handed over.
    const LARGE_BODY = Array.from({ length: 60 }, (_, n) =>
      n === 30 ? R1_PARAGRAPH : `Para ${n} ${R1_TOKEN} text ${n}.`,
    ).join('\n\n')
    /** Opens the plain-paragraph fixture, Replace All, caret in the given paragraph, owned Ctrl+Z with the first slice held. */
    async function heldReplay(page: Page, needle: string, offset: number) {
      const content = `${LARGE_BODY}\n`
      await openSourceSet(page, 'none', content)
      await live(page)
      const after = content.replaceAll(R1_TOKEN, 'ZZZZ')
      await findAction(page, 'replace-all', R1_TOKEN, 'ZZZZ', after)
      await caretIn(page, needle, offset)
      await page.evaluate(() => {
        ;(window as any).__vmdeE2EReplayHold = true
      })
      await page.keyboard.press('Control+KeyZ')
      return content
    }
    const releaseFirstSlice = (page: Page) =>
      page.evaluate(() => {
        delete (window as any).__vmdeE2EReplayHold
      })
    const replayDone = (page: Page) =>
      expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as any).__vmdeModelShadowStats?.replay?.budget?.open ??
                false,
            ),
          { timeout: 60_000 },
        )
        .toBe(false)

    test('paste without input: a script write during a held replay is posted at its delivery, exact bytes', async ({
      page,
    }) => {
      const content = await heldReplay(page, R1_PARAGRAPH, 4)
      // A write with no `input` event, as Vditor's paste helper makes.
      await page.evaluate((needle) => {
        const root = (window as any).vditor.vditor.ir.element as HTMLElement
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n as Text
          if (text.data.includes(needle)) {
            text.data = `${text.data}P`
            return
          }
        }
      }, R1_PARAGRAPH)
      await releaseFirstSlice(page)
      const at = content.indexOf(R1_PARAGRAPH) + R1_PARAGRAPH.length
      const expected = `${content.slice(0, at)}P${content.slice(at)}`
      await expect
        .poll(async () => r1Compare(await stubText(page), expected), {
          timeout: 30_000,
        })
        .toBe('exact')
      await replayDone(page)
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

    test('type then Undo during a held replay: the typing op, the reservation, then the history delta, host equal to the editor', async ({
      page,
    }) => {
      const content = await heldReplay(page, R1_PARAGRAPH, 4)
      const before = (await hostStubCounters(page)).kinds.length
      await page.keyboard.type('k')
      await page.keyboard.press('Control+KeyZ')
      await releaseFirstSlice(page)
      await replayDone(page)
      const kinds = (await hostStubCounters(page)).kinds
        .slice(before)
        .filter((k) => /edit-delta|replay-reserve|history-delta/u.test(k))
      expect(kinds).toEqual(['edit-delta', 'replay-reserve', 'history-delta'])
      // The Undo pops the typed key: the editor no longer shows it, and the host holds the same bytes.
      expect(await editorShows(page, 'Pzwrk'), 'the typed key is undone').toBe(
        false,
      )
      const expected = content
      await expect
        .poll(async () => r1Compare(await stubText(page), expected), {
          timeout: 30_000,
        })
        .toBe('exact')
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

    test('programmatic-insert-unproven-unit: insertValue into a pending unit is refused before it shows, or posted exact', async ({
      page,
    }) => {
      const content = await heldReplay(page, 'Para 10 ', 2)
      const refusedBefore = await page.evaluate(
        () =>
          (window as any).__vmdeModelShadowStats?.replay?.replayInputRefused ??
          0,
      )
      await page.evaluate(() => (window as any).vditor.insertValue('Q'))
      const shownAtOnce = await editorShows(page, 'PaQra')
      const refused =
        (await page.evaluate(
          () =>
            (window as any).__vmdeModelShadowStats?.replay
              ?.replayInputRefused ?? 0,
        )) - refusedBefore
      await releaseFirstSlice(page)
      await replayDone(page)
      const at = content.indexOf('Para 10 ') + 2
      const posted = `${content.slice(0, at)}Q${content.slice(at)}`
      const text = await stubText(page)
      if (refused > 0) {
        expect(shownAtOnce, 'a refused insert never shows').toBe(false)
        expect(r1Compare(text, content)).toBe('exact')
      } else expect(r1Compare(text, posted)).toBe('exact')
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

    for (const [name, ending] of [
      ['source-handoff-after-replay', '\n'],
      ['source-handoff-eof-none', ''],
      ['source-handoff-eof-two', '\n\n'],
    ] as const)
      test(`${name}: a switch to Source during a held replay opens with L; the next Source publication is exact`, async ({
        page,
      }) => {
        // Q-268: the Source publication normalizes the file ending without a replay too.
        test.fixme(
          ending !== '\n',
          'known limit K13, task 044 (pre-existing Source publication end-of-file normalization)',
        )
        const content = LARGE_BODY + ending
        await openSourceSet(page, 'none', content)
        await live(page)
        const after = content.replaceAll(R1_TOKEN, 'ZZZZ')
        await findAction(page, 'replace-all', R1_TOKEN, 'ZZZZ', after)
        await caretIn(page, R1_PARAGRAPH, 4)
        // The replay's first slice is held, so the Find groups stay pending in the IR DOM.
        await page.evaluate(() => {
          ;(window as any).__vmdeE2EReplayHold = true
        })
        await page.keyboard.press('Control+KeyZ')
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as any).__vmdeModelShadowStats?.replay?.budget?.open ===
                true,
            ),
          )
          .toBe(true)
        await page.keyboard.type('k')
        expect(await editorShows(page, 'ZZZZ'), 'groups still pending').toBe(
          true,
        )
        await page.evaluate(() => {
          const v = (window as any).vditor
          v.vditor.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          )
          document
            .querySelector<HTMLButtonElement>('button[data-mode="sv"]')
            ?.click()
          // releaseFirstSlice(): the switch ended the replay; nothing is held any more.
          delete (window as any).__vmdeE2EReplayHold
        })
        await expect(page.locator('.vditor-sv')).toBeVisible()
        const at = content.indexOf(R1_PARAGRAPH)
        const withK = `${content.slice(0, at + 4)}k${content.slice(at + 4)}`
        await expect
          .poll(async () => (await stubText(page)) === withK, {
            timeout: 30_000,
          })
          .toBe(true)
        // The Source surface settles its own caret after the switch; the key goes in after that.
        await page.waitForTimeout(SETTLE_MS)
        await caretIn(
          page,
          `${R1_PARAGRAPH.slice(0, 4)}k${R1_PARAGRAPH.slice(4, 10)}`,
          0,
        )
        await page.keyboard.type('q')
        const expected = `${withK.slice(0, at)}q${withK.slice(at)}`
        await expect
          .poll(async () => r1Compare(await stubText(page), expected), {
            timeout: 30_000,
          })
          .toBe('exact')
        expect(await kindsOf(page, 'history-exact')).toBe(1)
      })
  })
  // ---- 036 core IME (frozen-core C5, R34.3, R35.3): a real Chromium IME during a held replay ----
  test.describe('036 core IME', () => {
    const IME_TOKEN = 'ncjw'
    const IME_PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
    const IME_BODY = Array.from({ length: 60 }, (_, n) =>
      n === 30 ? IME_PARAGRAPH : `Para ${n} ${IME_TOKEN} text ${n}.`,
    ).join('\n\n')
    const CONTENT = `${IME_BODY}\n`
    /** Replace All, caret after `Pzwr`, owned Ctrl+Z with the replay's first slice held. */
    async function heldImeReplay(page: Page) {
      await openSourceSet(page, 'none', CONTENT)
      await live(page)
      const after = CONTENT.replaceAll(IME_TOKEN, 'ZZZZ')
      await findAction(page, 'replace-all', IME_TOKEN, 'ZZZZ', after)
      await caretIn(page, IME_PARAGRAPH, 4)
      await page.evaluate(() => {
        ;(window as any).__vmdeE2EReplayHold = true
      })
      await page.keyboard.press('Control+KeyZ')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).__vmdeModelShadowStats?.replay?.budget?.open ===
              true,
          ),
        )
        .toBe(true)
      return page.context().newCDPSession(page)
    }
    const releaseSlice = (page: Page) =>
      page.evaluate(() => {
        delete (window as any).__vmdeE2EReplayHold
      })
    const imeDone = (page: Page) =>
      expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as any).__vmdeModelShadowStats?.replay?.budget?.open ??
                false,
            ),
          { timeout: 60_000 },
        )
        .toBe(false)
    const withText = (text: string) => {
      const at = CONTENT.indexOf(IME_PARAGRAPH) + 4
      return `${CONTENT.slice(0, at)}${text}${CONTENT.slice(at)}`
    }
    const imeCounter = (page: Page, name: string) =>
      page.evaluate(
        (key) =>
          ((window as any).__vmdeModelShadowStats?.replay?.[key] as number) ??
          0,
        name,
      )

    test('ime commit during a held replay: the committed bytes reach the host exactly', async ({
      page,
    }) => {
      const cdp = await heldImeReplay(page)
      await cdp.send('Input.imeSetComposition', {
        text: 'に',
        selectionStart: 1,
        selectionEnd: 1,
      })
      await cdp.send('Input.insertText', { text: 'に' })
      await releaseSlice(page)
      await imeDone(page)
      await expect
        .poll(async () => (await stubText(page)) === withText('に'), {
          timeout: 30_000,
        })
        .toBe(true)
      expect((await hostStubState(page)).resyncs).toBe(0)
      expect(await imeCounter(page, 'compositionForced')).toBe(0)
    })

    test('ime cancel during a held replay: nothing is posted, the host holds the undone bytes', async ({
      page,
    }) => {
      const cdp = await heldImeReplay(page)
      const before = (await hostStubCounters(page)).kinds.length
      await cdp.send('Input.imeSetComposition', {
        text: 'に',
        selectionStart: 1,
        selectionEnd: 1,
      })
      await cdp.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      })
      await releaseSlice(page)
      await imeDone(page)
      await page.waitForTimeout(SETTLE_MS)
      const kinds = (await hostStubCounters(page)).kinds.slice(before)
      expect(kinds.filter((k) => k === 'edit-delta')).toEqual([])
      expect(await stubText(page)).toBe(CONTENT)
      expect(await editorShows(page, 'ZZZZ')).toBe(false)
    })

    test('ime trailing-space commit: the host bytes equal the editor serialization, not the event data', async ({
      page,
    }) => {
      const cdp = await heldImeReplay(page)
      await cdp.send('Input.imeSetComposition', {
        text: 'に ',
        selectionStart: 2,
        selectionEnd: 2,
      })
      await cdp.send('Input.insertText', { text: 'に ' })
      await releaseSlice(page)
      await imeDone(page)
      await page.waitForTimeout(SETTLE_MS)
      const serialized = await page.evaluate(() =>
        (window as any).vditor.getValue(),
      )
      expect(serialized).toContain('Pzwrに')
      expect(await stubText(page)).toBe(serialized)
      expect((await hostStubState(page)).resyncs).toBe(0)
    })

    test('ime external update before compositionend: deferred, the old-epoch op first, then the update; the host keeps the text', async ({
      page,
    }) => {
      const cdp = await heldImeReplay(page)
      await cdp.send('Input.imeSetComposition', {
        text: 'に',
        selectionStart: 1,
        selectionEnd: 1,
      })
      // An out-of-order replay op makes the stub refuse the epoch: it answers with a resync `update`.
      await page.evaluate(() => {
        const stub = (window as any).__vmdeHostStub
        ;(window as any).acquireVsCodeApi().postMessage({
          command: 'edit-delta',
          epoch: stub.epoch,
          replayOp: 999,
          sequence: 999,
          changes: [],
        })
      })
      await expect.poll(async () => (await hostStubState(page)).resyncs).toBe(1)
      await page.waitForTimeout(200)
      // The update waits for the composition: no recovery started, the composing text is in the editor.
      expect(
        await page.evaluate(
          () =>
            (window as any).__vmdeModelShadowStats?.replay?.recovery?.started ??
            0,
        ),
      ).toBe(0)
      expect(await editorShows(page, 'Pzwrに')).toBe(true)
      await cdp.send('Input.insertText', { text: 'に' })
      await releaseSlice(page)
      await expect
        .poll(async () => (await stubText(page)) === withText('に'), {
          timeout: 60_000,
        })
        .toBe(true)
      expect(await imeCounter(page, 'compositionForced')).toBe(0)
      expect(await editorShows(page, 'Pzwrに')).toBe(true)
    })
  })

  // ---- 036 core Save (frozen-core C6, S1, S2): Save during a replay ----
  test.describe('036 core Save', () => {
    const SAVE_TOKEN = 'ncjw'
    const SAVE_PARAGRAPH = 'Pzwr wfsnnsra tr wumyslsn'
    const SAVE_TASK_MS = 50
    /** Replace All over `factor` copies of LARGE, caret after `Pzwr`, owned Ctrl+Z with the first slice held. */
    async function heldSaveReplay(page: Page, factor: number) {
      const scaled = Array.from({ length: factor }, () => LARGE).join('\n')
      await openSourceSet(page, 'none', scaled)
      await live(page)
      const after = scaled.replaceAll(SAVE_TOKEN, 'ZZZZ')
      await findAction(page, 'replace-all', SAVE_TOKEN, 'ZZZZ', after, {
        timeout: factor > 1 ? 120_000 : 5000,
      })
      await caretIn(page, SAVE_PARAGRAPH, 4)
      await page.evaluate(() => {
        ;(window as any).__vmdeE2EReplayHold = true
        // Long tasks from here on (input to reply), numbers only.
        const longTasks: number[] = []
        ;(window as any).__saveLongTasks = longTasks
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        }).observe({ type: 'longtask' })
      })
      await page.keyboard.press('Control+KeyZ')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).__vmdeModelShadowStats?.replay?.budget?.open ===
              true,
          ),
        )
        .toBe(true)
      return scaled
    }
    const releaseSaveSlice = (page: Page) =>
      page.evaluate(() => {
        delete (window as any).__vmdeE2EReplayHold
      })
    const longTasks = (page: Page) =>
      page.evaluate(() => [...((window as any).__saveLongTasks as number[])])
    const typedAt = (scaled: string, text: string) => {
      const at = scaled.indexOf(SAVE_PARAGRAPH) + 4
      return `${scaled.slice(0, at)}${text}${scaled.slice(at)}`
    }

    for (const factor of [1, 4])
      test(`x${factor}: Save mid-replay with typing replies once with the typed bytes, no task over 50 ms`, async ({
        page,
      }) => {
        const scaled = await heldSaveReplay(page, factor)
        await page.keyboard.type('k')
        await requestFlush(page, `core-save-${factor}`)
        await expect
          .poll(async () => (await hostStubState(page)).flushReplies.length, {
            timeout: 30_000,
          })
          .toBe(1)
        const state = await hostStubState(page)
        expect(state.flushReplies[0].requestId).toBe(`core-save-${factor}`)
        // Everything shown is posted before the reply: the Save bytes hold the typed key.
        expect(
          state.flushReplies[0].text === typedAt(scaled, 'k'),
          'Save bytes',
        ).toBe(true)
        expect(
          (await longTasks(page)).filter((ms) => ms >= SAVE_TASK_MS),
        ).toEqual([])
        await releaseSaveSlice(page)
        await expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (window as any).__vmdeModelShadowStats?.replay?.budget
                    ?.open ?? false,
              ),
            { timeout: 60_000 },
          )
          .toBe(false)
        expect(await stubText(page)).toBe(typedAt(scaled, 'k'))
        expect((await hostStubState(page)).resyncs).toBe(0)
        expect(
          await page.evaluate(
            () =>
              (window as any).__vmdeModelShadowStats?.replay?.saveUnproven ?? 0,
          ),
        ).toBe(0)
      })

    test('x1: Save during a composition in a replay waits for the commit, then replies with its bytes', async ({
      page,
    }) => {
      const scaled = await heldSaveReplay(page, 1)
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.imeSetComposition', {
        text: 'に',
        selectionStart: 1,
        selectionEnd: 1,
      })
      await requestFlush(page, 'core-save-ime')
      await page.waitForTimeout(300)
      expect((await hostStubState(page)).flushReplies).toHaveLength(0)
      await cdp.send('Input.insertText', { text: 'に' })
      await expect
        .poll(async () => (await hostStubState(page)).flushReplies.length, {
          timeout: 30_000,
        })
        .toBe(1)
      const state = await hostStubState(page)
      expect(state.flushReplies[0].text === typedAt(scaled, 'に')).toBe(true)
      await releaseSaveSlice(page)
    })
  })
})
