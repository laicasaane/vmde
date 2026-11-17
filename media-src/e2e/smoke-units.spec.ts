import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { definitionHeavyMarkdown } from '../../test/vscode-e2e/definition-heavy-markdown'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'
import {
  hostStubState,
  installHostStub,
  releaseRebind,
} from './helpers/host-stub'
import { tableHeavyMarkdown } from '../../test/vscode-e2e/table-heavy-markdown'

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
): Promise<void> {
  await installHostStub(page, {
    content,
    options: { showToolbar: true, defaultMode: 'ir', ...options },
    holdRebind,
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
