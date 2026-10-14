import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 609 — a Vditor undo checkpoint restores the caret through the caret authority. A caret at the
// start of a heading's visible content shares its flat position with the end of the hidden `# `
// marker; the restore must pick the content start. A caret inside the editable fence info line is a
// marker position on purpose and must stay there (backward affinity from the capture).
// Built on the undo-restore-caret harness: IR from source (so the undo capture patch applies), the
// caret authority bridge installed, `undoDelay` 800 ms. Its document opens with `# Probe` and a
// ```js fence.

const call = <T>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([fn, rest]) => (window as any)[fn as string](...(rest as unknown[])),
    [name, args] as const,
  ) as Promise<T>
const value = (page: Page) => call<string>(page, '__value')
const stack = (page: Page) =>
  call<{ undo: number; redo: number }>(page, '__stack')

interface Anchor {
  text: string | null
  offset: number
  inMarker: boolean
  inHeading: boolean
}
const anchor = (page: Page) =>
  page.evaluate((): Anchor => {
    const selection = window.getSelection()
    const node = selection?.anchorNode ?? null
    const element = node instanceof Element ? node : node?.parentElement
    return {
      text: node instanceof Text ? node.data : null,
      offset: selection?.anchorOffset ?? -1,
      inMarker: !!element?.closest('.vditor-ir__marker'),
      inHeading: !!element?.closest('h1,h2,h3,h4,h5,h6'),
    }
  })

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

async function open(page: Page) {
  await page.goto('/undo-restore-caret.html?mode=ir&doc=small')
  await page.waitForFunction(() => (window as any).__ready === true)
  // Wait for Vditor's first undo snapshot before placing any selection.
  await expect.poll(async () => (await stack(page)).undo).toBeGreaterThan(0)
}

// Acceptance 1: the opening checkpoint restores a caret at the heading's content start to the
// content start (not the end of the hidden marker), and the next key lands in the heading content.
test('IR heading: a checkpoint restore keeps the caret at the content start', async ({
  page,
}) => {
  await open(page)
  const start = await value(page)
  expect(start.startsWith('# Probe\n')).toBe(true)
  expect(await call<boolean>(page, '__place', 'Probe', 0)).toBe(true)
  expect(await anchor(page)).toMatchObject({ text: 'Probe', offset: 0 })

  // The checkpoint Vditor takes after its debounce: capture the caret, restore it through the bridge.
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.addToUndoStack(inner)
  })
  await frames(page)

  expect(await anchor(page)).toEqual({
    text: 'Probe',
    offset: 0,
    inMarker: false,
    inHeading: true,
  })
  // A live intent re-asserts for several frames; the landing must hold.
  for (let i = 0; i < 20; i++) await frames(page)
  expect(await anchor(page)).toMatchObject({
    text: 'Probe',
    offset: 0,
    inMarker: false,
  })

  await page.keyboard.type('x')
  await expect
    .poll(() => value(page))
    .toBe(start.replace('# Probe', '# xProbe'))
})

// Acceptance 2: typing in the fence info line is typing into marker source; an 800 ms checkpoint
// must leave the caret at the end of the info text, not move it into the code.
test('IR fence info: typing survives the 800 ms checkpoint', async ({
  page,
}) => {
  await open(page)
  expect(await call<boolean>(page, '__place', 'js', 2)).toBe(true)
  expect(await anchor(page)).toMatchObject({ inMarker: true })
  const before = (await stack(page)).undo
  await page.keyboard.type('x')
  await expect
    .poll(async () => (await stack(page)).undo, { timeout: 5_000 })
    .toBe(before + 1)
  for (let i = 0; i < 20; i++) await frames(page)

  const landed = await anchor(page)
  expect(landed.inMarker).toBe(true)
  expect(landed.text).toContain('jsx')
  expect(landed.offset).toBe(landed.text!.length)

  await page.keyboard.type('y')
  await expect.poll(() => value(page)).toContain('```jsxy\n')
})
