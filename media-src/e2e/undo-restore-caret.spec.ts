import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 597 — Undo/Redo restoring a snapshot without a usable caret marker. Vditor writes a `<wbr>`
// caret marker into a snapshot only when the live selection is inside the editor; a snapshot taken
// while focus sits in another input (the Find widget) has none, and a selection collapsed on the
// editable root records a root-level marker. Restoring either left the selection outside the
// editable blocks, so the next key was dropped. These cases build such snapshots for real (the
// debounced checkpoint fires while focus or the selection is elsewhere) and check the next key.

type Away = 'external' | 'root' | 'preview'

const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([fn, rest]) => (window as any)[fn as string](...(rest as unknown[])),
    [name, args] as const,
  ) as Promise<T>
const value = (page: Page) => call<string>(page, '__value')
const stack = (page: Page) =>
  call<{ undo: number; redo: number }>(page, '__stack')
const selection = (page: Page) =>
  call<{
    inBlock: boolean
    collapsed: boolean
    measurable: boolean
    focused: boolean
  }>(page, '__selection')

// VS Code resolves the Undo/Redo key itself, but its keydown is dispatched in the webview document
// first, where the caret authority's gesture listener drops an intent still armed by the last
// checkpoint. A bare modifier press models that keydown without editing or moving the selection.
async function history(page: Page, action: 'undo' | 'redo') {
  await page.keyboard.press('Shift')
  return call<string | null>(page, action === 'undo' ? '__undo' : '__redo')
}

async function open(page: Page, mode: string, doc = 'small'): Promise<void> {
  await page.goto(`/undo-restore-caret.html?mode=${mode}&doc=${doc}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  // Wait for Vditor's first undo snapshot before placing any selection.
  await expect.poll(async () => (await stack(page)).undo).toBeGreaterThan(0)
}

// Type `text` at the start of `needle`, optionally move focus or the selection away before the
// debounced checkpoint fires, and wait for that checkpoint by its stack growth.
async function snapshotEdit(
  page: Page,
  needle: string,
  text: string,
  away?: Away,
): Promise<void> {
  const before = (await stack(page)).undo
  expect(await call<boolean>(page, '__place', needle, 0)).toBe(true)
  await page.keyboard.type(text)
  if (away === 'external') await page.focus('#external')
  else if (away === 'root') await call(page, '__collapseAtRoot')
  else if (away === 'preview')
    expect(await call<boolean>(page, '__place', 'kilo', 0, true)).toBe(true)
  await expect
    .poll(async () => (await stack(page)).undo, { timeout: 5_000 })
    .toBe(before + 1)
  if (away === 'external')
    expect(await call<boolean>(page, '__lastTextHasMarker')).toBe(false)
}

// The restored caret must be a collapsed, measurable caret inside an editable block, and the
// restore must not add a history step of its own.
async function expectUsableCaret(page: Page): Promise<void> {
  expect(await selection(page)).toEqual({
    inBlock: true,
    collapsed: true,
    measurable: true,
    focused: true,
  })
  const settled = await stack(page)
  await page.waitForTimeout(1_000)
  expect(await stack(page)).toEqual(settled)
}

// The first edit's checkpoint is recorded with focus or the selection `away`; an ordinary second
// edit follows. Returns the value an Undo of the second edit restores.
async function twoSnapshots(
  page: Page,
  away: Away,
  first = 'bravo',
  second = 'echo',
): Promise<string> {
  await snapshotEdit(page, first, 'X', away)
  const restored = await value(page)
  await snapshotEdit(page, second, 'Y')
  return restored
}

// After a restore: the exact restored value, a usable caret, and the next key at `expected`.
async function expectNextKey(
  page: Page,
  restored: string,
  expected: string,
): Promise<void> {
  expect(await value(page)).toBe(restored)
  await expectUsableCaret(page)
  await page.keyboard.type('Q')
  await expect.poll(() => value(page)).toBe(expected)
}

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: Undo to a snapshot taken while an external input had focus keeps the next key`, async ({
    page,
  }) => {
    await open(page, mode)
    const restored = await twoSnapshots(page, 'external')
    expect(await history(page, 'undo')).toBeNull()
    // Undo lands at the start of the change: where `Y` was removed.
    await expectNextKey(page, restored, restored.replace('echo', 'Qecho'))
  })

  test(`${mode}: Redo to a snapshot taken while an external input had focus keeps the next key`, async ({
    page,
  }) => {
    await open(page, mode)
    await snapshotEdit(page, 'bravo', 'X', 'external')
    const redone = await value(page)
    expect(await history(page, 'undo')).toBeNull()
    expect(await value(page)).not.toContain('Xbravo')
    expect(await history(page, 'redo')).toBeNull()
    // Redo lands at the end of the change: after the re-inserted `X`.
    await expectNextKey(page, redone, redone.replace('Xbravo', 'XQbravo'))
  })
}

for (const [away, label] of [
  ['root', 'at the editable root'],
  ['preview', 'inside a rendered preview'],
] as const) {
  test(`ir: a caret marker ${label} is not used for the restore`, async ({
    page,
  }) => {
    await open(page, 'ir')
    const restored = await twoSnapshots(page, away)
    expect(await history(page, 'undo')).toBeNull()
    await expectNextKey(page, restored, restored.replace('echo', 'Qecho'))
  })
}

test('ir: Undo with no selection range at all restores without throwing', async ({
  page,
}) => {
  await open(page, 'ir')
  const restored = await twoSnapshots(page, 'external')
  await page.keyboard.press('Shift')
  await call(page, '__clearSelection')
  // Upstream's no-marker branch called getRangeAt(0) here and threw before execAfterRender.
  expect(await call(page, '__undo')).toBeNull()
  await expectNextKey(page, restored, restored.replace('echo', 'Qecho'))
})

test('ir: the toolbar follows the restored caret out of inline code', async ({
  page,
}) => {
  await open(page, 'ir')
  await twoSnapshots(page, 'external')
  await page.locator('.vditor-ir [data-type="code"] code').click()
  await expect
    .poll(() => call<boolean>(page, '__toolbarDisabled', 'bold'))
    .toBe(true)
  expect(await history(page, 'undo')).toBeNull()
  // Vditor's highlightToolbar runs ~200 ms after the restore and reads the restored caret.
  await expect
    .poll(() => call<boolean>(page, '__toolbarDisabled', 'bold'), {
      timeout: 1_000,
    })
    .toBe(false)
})

test('ir: a usable caret marker keeps the upstream restore', async ({
  page,
}) => {
  await open(page, 'ir')
  await snapshotEdit(page, 'echo', 'Y')
  expect(await call<boolean>(page, '__lastTextHasMarker')).toBe(true)
  const restored = await value(page)
  await snapshotEdit(page, 'bravo', 'X')
  expect(await history(page, 'undo')).toBeNull()
  // The snapshot's own marker sits after the `Y` typed before it was recorded.
  await expectNextKey(page, restored, restored.replace('Yecho', 'YQecho'))
})

for (const [direction, first, second, scroll] of [
  ['below', 'Para 02', 'Para 57', 'top'],
  ['above', 'Para 57', 'Para 02', 'bottom'],
] as const) {
  test(`ir: Undo reveals a change site ${direction} the viewport`, async ({
    page,
  }) => {
    await open(page, 'ir', 'tall')
    const restored = await twoSnapshots(page, 'external', first, second)
    const before = await call<number>(page, '__scrollTo', scroll)
    expect(await call<boolean>(page, '__caretVisible')).toBe(false)
    expect(await history(page, 'undo')).toBeNull()
    expect(await call<boolean>(page, '__caretVisible')).toBe(true)
    expect(await call<number>(page, '__scrollTop')).not.toBe(before)
    await expectNextKey(page, restored, restored.replace(second, `Q${second}`))
  })
}

test('ir: a mouse Undo on the toolbar keeps the revealed change site above the viewport', async ({
  page,
}) => {
  await open(page, 'ir', 'tall')
  await twoSnapshots(page, 'external', 'Para 57', 'Para 02')
  await call(page, '__scrollTo', 'bottom')
  await page.locator('.vditor-toolbar [data-type="undo"]').click()
  // The toolbar scroll guard pins upward jumps for 600 ms after a toolbar click.
  await page.waitForTimeout(900)
  expect(await call<boolean>(page, '__caretVisible')).toBe(true)
})
