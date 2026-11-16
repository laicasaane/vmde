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
