import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'
import { hostStubState, installHostStub } from './helpers/host-stub'

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
