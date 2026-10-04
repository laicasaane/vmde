import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'
import { selectEditorText } from './editor-selection'

// Task 580 CP2-10 — Vditor's hard-coded chords. The build patches Vditor so a real (trusted) key
// no longer runs them: V1 Ctrl+Alt+1–6 headings, V2 Ctrl+Alt+7–9 edit modes, V3 Ctrl+=/- heading
// size, V4 table chords, V6 Ctrl+Shift+J task toggle, V7 Ctrl+Shift+; nesting, V8 Ctrl+Shift+U/D/X
// popover move/remove and the removed V10 blockquote exits. The heading, edit-mode and task
// actions are now unbound VMDE commands; vditor-chords-harness.ts (Vditor built from source, so the
// patches apply) gives them Ctrl+Alt+Shift user keys through the keybinding shim (emulation, not
// VS Code evidence: test/vscode-e2e/vditor-chords.spec.ts is the real-key check). The V9 Alt+Enter popover hops are a fixed exception and keep working.

type Mode = 'ir' | 'wysiwyg' | 'sv'

const DOC = [
  '# Title',
  '',
  'Para text',
  '',
  '- [ ] task item',
  '',
  '> quoted line',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```js',
  'let code = 1',
  '```',
  '',
].join('\n')

async function openDoc(page: Page, mode: Mode, value = DOC) {
  await page.goto('/vditor-chords.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate((md) => (window as any).vditor.setValue(md), value)
  if (mode !== 'ir')
    await page.evaluate((target) => {
      const toolbar = (window as any).vditor.vditor.toolbar
      toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector(`button[data-mode="${target}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
  await expect.poll(() => currentMode(page)).toBe(mode)
  // Records every untrusted keydown that reaches the document or the window: VS Code's preload
  // would forward it to the workbench.
  await page.evaluate(() => {
    const leaked: string[] = []
    ;(window as any).__leakedKeys = leaked
    const record = (where: string) => (event: Event) => {
      if (!event.isTrusted)
        leaked.push(`${where}:${(event as KeyboardEvent).code}`)
    }
    document.addEventListener('keydown', record('document'))
    window.addEventListener('keydown', record('window'))
  })
}

const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)
const currentMode = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getCurrentMode() as Mode)
const leakedKeys = (page: Page) =>
  page.evaluate(() => (window as any).__leakedKeys as string[])

/** Focus the active editing surface and put a collapsed caret after `text`'s first character. */
async function caretIn(page: Page, text: string) {
  await page.evaluate(selectEditorText, [text, 1, 0] as const)
  await page.waitForTimeout(80)
}

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms)
}

// The former chords, grouped by the context each acted in.
const TABLE_CHORDS = [
  'Control+Shift+KeyF',
  'Control+Equal',
  'Control+Shift+KeyG',
  'Control+Shift+Equal',
  'Control+Minus',
  'Control+Shift+Minus',
  'Control+Shift+KeyL',
  'Control+Shift+KeyR',
]
const DIGIT_CHORDS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
  (n) => `Control+Alt+Digit${n}`,
)

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: the former Vditor chords are inert for real keys`, async ({
    page,
  }) => {
    await openDoc(page, mode)
    const before = await getValue(page)
    const press = async (text: string, chords: readonly string[]) => {
      await caretIn(page, text)
      for (const chord of chords) await page.keyboard.press(chord)
      await settle(page)
      expect(await getValue(page), `${chords.join(', ')} at ${text}`).toBe(
        before,
      )
      expect(await currentMode(page)).toBe(mode)
    }
    await press('Para text', DIGIT_CHORDS)
    await press('Title', ['Control+Equal', 'Control+Minus'])
    await press('task item', ['Control+Shift+KeyJ'])
    if (mode !== 'sv') await press('2', TABLE_CHORDS)
    if (mode === 'wysiwyg') {
      await press('Para text', ['Control+Shift+Semicolon'])
      await press('let code', [
        'Control+Shift+KeyU',
        'Control+Shift+KeyD',
        'Control+Shift+KeyX',
      ])
      // V10 is removed: neither exit adds a paragraph next to the blockquote.
      await press('quoted line', ['Alt+Enter', 'Control+Alt+Enter'])
    }
  })
}

test('the heading commands set H1–H6 in IR and Split View and toggle in WYSIWYG', async ({
  page,
}) => {
  const doc = 'Para text\n'
  await openDoc(page, 'ir', doc)
  await caretIn(page, 'Para text')
  await page.keyboard.press('Control+Alt+Shift+Digit5')
  await expect.poll(() => getValue(page)).toBe('##### Para text\n')
  await caretIn(page, 'Para text')
  await page.keyboard.press('Control+Alt+Shift+Digit1')
  await expect.poll(() => getValue(page)).toBe('# Para text\n')
  expect(await leakedKeys(page)).toEqual([])

  await openDoc(page, 'wysiwyg', doc)
  await caretIn(page, 'Para text')
  await page.keyboard.press('Control+Alt+Shift+Digit2')
  await expect.poll(() => getValue(page)).toBe('## Para text\n')
  // Vditor's WYSIWYG branch removes the heading when the chord names the current level.
  await caretIn(page, 'Para text')
  await page.keyboard.press('Control+Alt+Shift+Digit2')
  await expect.poll(() => getValue(page)).toBe('Para text\n')
  expect(await leakedKeys(page)).toEqual([])

  await openDoc(page, 'sv', doc)
  await caretIn(page, 'Para text')
  // Vditor's Split View heading inserts the marker at the caret, after a line break when the
  // caret's line has text, exactly as the former real chord did.
  await page.keyboard.press('Control+Alt+Shift+Digit6')
  await expect.poll(() => getValue(page)).toMatch(/^###### ara text$/m)
  expect(await leakedKeys(page)).toEqual([])
})

test('the edit-mode commands switch modes from every mode', async ({
  page,
}) => {
  await openDoc(page, 'ir')
  await caretIn(page, 'Para text')
  for (const [digit, mode] of [
    [7, 'wysiwyg'],
    [9, 'sv'],
    [8, 'ir'],
    [9, 'sv'],
    [7, 'wysiwyg'],
    [8, 'ir'],
  ] as const) {
    await page.keyboard.press(`Control+Alt+Shift+Digit${digit}`)
    await expect.poll(() => currentMode(page)).toBe(mode)
  }
  expect(await getValue(page)).toContain('Para text')
  expect(await leakedKeys(page)).toEqual([])
})

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: the task command toggles the caret's checkbox`, async ({
    page,
  }) => {
    await openDoc(page, mode, '- [ ] task item\n')
    await caretIn(page, 'task item')
    // Lute writes a checked box as `[X]`, and IR keeps the space it renders after the box.
    await page.keyboard.press('Control+Alt+Shift+KeyJ')
    await expect.poll(() => getValue(page)).toMatch(/^- \[X\] +task item\n$/)
    await caretIn(page, 'task item')
    await page.keyboard.press('Control+Alt+Shift+KeyJ')
    await expect.poll(() => getValue(page)).toMatch(/^- \[ \] +task item\n$/)
    expect(await leakedKeys(page)).toEqual([])
  })
}

test('sv: the task command changes nothing, as Vditor never handled the chord there', async ({
  page,
}) => {
  await openDoc(page, 'sv', '- [ ] task item\n')
  const before = await getValue(page)
  await caretIn(page, 'task item')
  await page.keyboard.press('Control+Alt+Shift+KeyJ')
  await settle(page)
  expect(await getValue(page)).toBe(before)
  expect(await leakedKeys(page)).toEqual([])
})

test('wysiwyg: Alt+Enter still hops between a code block and its language input (V9)', async ({
  page,
}) => {
  await openDoc(page, 'wysiwyg', '```js\nlet code = 1\n```\n')
  const before = await getValue(page)
  // The code source is hidden behind its rendered preview until a click shows it.
  await page.locator('.vditor-wysiwyg .vditor-wysiwyg__preview').click()
  await caretIn(page, 'let code')
  const language = page.locator('.vditor-wysiwyg .vditor-panel .vditor-input')
  await expect(language).toBeAttached()
  await page.keyboard.press('Alt+Enter')
  await expect(language).toBeFocused()
  await page.keyboard.press('Alt+Enter')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = (window as any).vditor.vditor.wysiwyg
          .element as HTMLElement
        const anchor = getSelection()?.anchorNode
        return {
          inRoot: !!anchor && root.contains(anchor),
          inputFocused:
            document.activeElement?.classList.contains('vditor-input'),
        }
      }),
    )
    .toEqual({ inRoot: true, inputFocused: false })
  expect(await getValue(page)).toBe(before)
})
