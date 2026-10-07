import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 603 item 2 (Amendment 3) — Undo and Redo in the webview's own text fields (Find, Replace,
// the WYSIWYG popover inputs) run a VMDE-owned per-field history, never `document.execCommand`.
// Chromium keeps ONE undo stack per frame, so `execCommand('undo')` with a field focused popped
// the editor's top step instead whenever the field had nothing left: Vditor recorded a same-text
// history entry (IR, SV), SV text changed and posted a host `edit`, a typed IR character could
// vanish silently (R1: type, focus Find within the 220 ms respin settle, Undo), and in WYSIWYG
// and SV a Redo moved focus into the editor (R2). No event guard can stop those: the DOM change
// and the focus move happen inside `execCommand`. This runs the REAL webview entry (main.ts, as
// external-update-undo-base.spec.ts does), so the real message router, Find widget and
// source-patched Vditor take part; the host's Undo route is the `trigger-toolbar-hotkey` message
// that `vmde.format.undo`/`redo` post. Real-VS-Code acceptance with OS keys is
// test/vscode-e2e/undo-routing-hygiene.spec.ts.
//
// Granularity: Chromium makes every typed character, every Backspace and every replacement its own
// native undo step in a text field (probed 2026-10-08: "abc" takes three presses, a pause changes
// nothing), and the VMDE history records one entry per edit, so the key counts match.

type Mode = 'ir' | 'wysiwyg' | 'sv'

const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\n```js\nconst a = 1\n```\n\nIndia juliet kilo lima.\n'
// Longer than Vditor's 800 ms undo delay plus the 250 ms edit sync and IR's 220 ms settle.
const QUIET_MS = 1400

async function open(page: Page, mode: Mode) {
  const init = {
    command: 'update',
    type: 'init',
    content: DOC,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: mode },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.addInitScript((message) => {
    const win = window as any
    win.__posted = []
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        win.__posted.push(posted)
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    (target) => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === target
      )
    },
    mode,
    { timeout: 15_000 },
  )
  // Vditor's own first snapshot (after undoDelay), before any selection is placed.
  await page.waitForFunction(
    () => {
      const inner = (window as any).vditor.vditor
      return inner.undo[inner.currentMode].undoStack.length >= 1
    },
    undefined,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(400)
}

// Bare modifier presses around the programmatic selection end any caret request still armed.
async function placeCaret(page: Page, needle: string, offset: number) {
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, 0] as const)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(100)
}

const FIND = '.vmde-find-replace [data-find]'
const REPLACE = '.vmde-find-replace [data-replace]'

async function openFind(page: Page) {
  await page.evaluate(() =>
    window.postMessage({ command: 'open-find-replace', mode: 'find' }, '*'),
  )
  await page.waitForFunction(
    (selector) => document.activeElement?.matches(selector),
    FIND,
    { timeout: 5_000 },
  )
  await page.waitForTimeout(300)
}

// The seed is a programmatic value (no native history). Clear it the same way, so typed text is
// the field's only history.
const clearFind = (page: Page) =>
  page.evaluate((selector) => {
    const find = document.querySelector<HTMLInputElement>(selector)!
    find.value = ''
    find.dispatchEvent(new Event('input', { bubbles: true }))
  }, FIND)

// The Undo/Redo route of VS Code's keys: the keydown reaches the webview, then `vmde.format.undo`
// posts this message.
async function route(page: Page, name: 'undo' | 'redo') {
  await page.keyboard.down('Control')
  await page.evaluate((command) => {
    window.postMessage(
      { command: 'trigger-toolbar-hotkey', name: command },
      '*',
    )
  }, name)
  await page.keyboard.up('Control')
  await page.waitForTimeout(150)
}

const read = (page: Page) =>
  page.evaluate(
    ([findSelector, replaceSelector]) => {
      const win = window as any
      const inner = win.vditor.vditor
      const slot = inner.undo[inner.currentMode]
      const find = document.querySelector<HTMLInputElement>(findSelector)
      const replace = document.querySelector<HTMLInputElement>(replaceSelector)
      const edits = (
        win.__posted as { command?: string; content?: string }[]
      ).filter((message) => message.command === 'edit')
      const active = document.activeElement
      return {
        depth: `${slot.undoStack.length}/${slot.redoStack.length}`,
        value: win.vditor.getValue() as string,
        find: find?.value ?? null,
        replace: replace?.value ?? null,
        status:
          document.querySelector('.vmde-find-replace [data-status]')
            ?.textContent ?? null,
        focus:
          active === find
            ? 'find'
            : active === replace
              ? 'replace'
              : inner[inner.currentMode].element.contains(active)
                ? 'editor'
                : String(active?.tagName),
        edits: edits.length,
        lastEdit: (edits.at(-1)?.content ?? null) as string | null,
      }
    },
    [FIND, REPLACE] as const,
  )

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test.describe(`${mode}: text field history (Task 603 item 2)`, () => {
    test('Undo and Redo in an empty Find field change nothing in the document', async ({
      page,
    }) => {
      await open(page, mode)
      await placeCaret(page, 'bravo', 2)
      await page.keyboard.type('X')
      await page.waitForTimeout(QUIET_MS)
      await openFind(page)
      const before = await read(page)
      expect(before.value).toContain('brXavo')

      for (const name of ['undo', 'redo', 'undo'] as const) {
        await route(page, name)
        await page.waitForTimeout(QUIET_MS)
        const after = await read(page)
        expect(after, `${name} in the empty field`).toEqual(before)
      }
    })

    test('an editor step newer than the Find typing: Undo and Redo change only the Find text', async ({
      page,
    }) => {
      await open(page, mode)
      await placeCaret(page, 'bravo', 2)
      await page.keyboard.type('X')
      await page.waitForTimeout(QUIET_MS)
      await openFind(page)
      await clearFind(page)
      await page.keyboard.type('e', { delay: 20 })
      await page.waitForTimeout(500)
      const typedFind = await read(page)
      expect(typedFind.find).toBe('e')
      // An editor step that is newer than the Find typing, then back to the field.
      await placeCaret(page, 'charlie', 3)
      await page.keyboard.type('Z')
      await page.waitForTimeout(QUIET_MS)
      await page.click(FIND)
      await page.waitForTimeout(200)
      const base = await read(page)
      expect(base.value).toContain('chaZrlie')
      expect(base.focus).toBe('find')

      const sameDocument = (state: Awaited<ReturnType<typeof read>>) => ({
        value: state.value,
        depth: state.depth,
        edits: state.edits,
        lastEdit: state.lastEdit,
        focus: state.focus,
      })
      await route(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const undone = await read(page)
      expect(undone.find, 'Undo reverts the Find typing').toBe('')
      expect(sameDocument(undone)).toEqual(sameDocument(base))
      expect(undone.status).not.toBe(typedFind.status)

      await route(page, 'redo')
      await page.waitForTimeout(QUIET_MS)
      const redone = await read(page)
      expect(redone.find, 'Redo restores the Find typing').toBe('e')
      expect(redone.status).toBe(typedFind.status)
      expect(sameDocument(redone)).toEqual(sameDocument(base))

      // The Find history is exhausted after one more Undo and one more press; the document stays.
      await route(page, 'undo')
      await route(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const exhausted = await read(page)
      expect(exhausted.find).toBe('')
      expect(sameDocument(exhausted)).toEqual(sameDocument(base))
    })

    test('typed characters are one Undo step each, in the Replace field too', async ({
      page,
    }) => {
      await open(page, mode)
      await openFind(page)
      await clearFind(page)
      await page.keyboard.type('abc', { delay: 20 })
      await page.waitForTimeout(300)
      const states: (string | null)[] = []
      for (const name of ['undo', 'undo', 'undo', 'undo'] as const) {
        await route(page, name)
        states.push((await read(page)).find)
      }
      // Chromium's own granularity: one native step per character; the fourth press has nothing.
      expect(states).toEqual(['ab', 'a', '', ''])
      for (const expected of ['a', 'ab', 'abc', 'abc']) {
        await route(page, 'redo')
        expect((await read(page)).find).toBe(expected)
      }
      expect((await read(page)).focus).toBe('find')

      // A new edit after an Undo clears the Redo stack.
      await route(page, 'undo')
      await page.keyboard.type('Q', { delay: 20 })
      await route(page, 'redo')
      expect((await read(page)).find).toBe('abQ')

      // The Replace field has its own history.
      await page.click('.vmde-find-replace [data-action="toggle-replace"]')
      await page.click(REPLACE)
      await page.keyboard.type('xy', { delay: 20 })
      await route(page, 'undo')
      const replaceUndone = await read(page)
      expect(replaceUndone.replace).toBe('x')
      expect(replaceUndone.find).toBe('abQ')
      expect(replaceUndone.focus).toBe('replace')
    })

    test('reopening Find with a seed equal to the last typed text starts a fresh history', async ({
      page,
    }) => {
      await open(page, mode)
      await openFind(page)
      await clearFind(page)
      await page.keyboard.type('a', { delay: 20 })
      expect((await read(page)).find).toBe('a')
      await page.evaluate(() =>
        window.postMessage(
          { command: 'find-widget-action', action: 'close' },
          '*',
        ),
      )
      await page.waitForTimeout(300)
      // Select the one `a` of "Alpha": the seed equals the text typed before, so the value the app
      // writes is identical to the last recorded one and no value drift reveals it.
      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['Alpha', 4, 1] as const)
      await page.keyboard.press('Shift')
      await page.waitForTimeout(100)
      await openFind(page)
      const seeded = await read(page)
      expect(seeded.find).toBe('a')
      await route(page, 'undo')
      await route(page, 'undo')
      expect(
        (await read(page)).find,
        'the seed starts an empty history; Undo changes nothing',
      ).toBe('a')
      await route(page, 'redo')
      expect((await read(page)).find).toBe('a')
    })

    test('a value written by the app starts a new base: Undo does not restore older typing', async ({
      page,
    }) => {
      await open(page, mode)
      await openFind(page)
      await clearFind(page)
      await page.keyboard.type('zz', { delay: 20 })
      // Close Find, select a word and reopen: Find is seeded with it, a programmatic value.
      await page.evaluate(() =>
        window.postMessage(
          { command: 'find-widget-action', action: 'close' },
          '*',
        ),
      )
      await page.waitForTimeout(300)
      await page.keyboard.press('Shift')
      await page.evaluate(selectEditorText, ['bravo', 0, 5] as const)
      await page.keyboard.press('Shift')
      await page.waitForTimeout(100)
      await openFind(page)
      const seeded = await read(page)
      expect(seeded.find).toBe('bravo')
      await route(page, 'undo')
      await route(page, 'undo')
      expect((await read(page)).find, 'the seed is the field base').toBe(
        'bravo',
      )
    })
  })
}

test.describe('ir: IME composition in the Find field', () => {
  test('a committed composition is one Undo step', async ({ page }) => {
    await open(page, 'ir')
    await openFind(page)
    await clearFind(page)
    await page.keyboard.type('a', { delay: 20 })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', {
      text: '日',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await cdp.send('Input.imeSetComposition', {
      text: '日本',
      selectionStart: 2,
      selectionEnd: 2,
    })
    // Undo during the composition does nothing: the composition is not an entry yet.
    await route(page, 'undo')
    expect((await read(page)).find).toBe('a日本')
    await cdp.send('Input.insertText', { text: '日本' })
    await page.waitForTimeout(300)
    expect((await read(page)).find).toBe('a日本')
    await route(page, 'undo')
    expect((await read(page)).find, 'one press undoes the composition').toBe(
      'a',
    )
    await route(page, 'undo')
    expect((await read(page)).find).toBe('')
    await route(page, 'redo')
    await route(page, 'redo')
    expect((await read(page)).find).toBe('a日本')
  })
})

test.describe('ir: a typed character survives Undo in a field focused right after it (R1)', () => {
  test('type, focus Find within the respin window, Undo: the character stays', async ({
    page,
  }) => {
    await open(page, 'ir')
    await openFind(page)
    await clearFind(page)
    await placeCaret(page, 'bravo', 2)
    await page.keyboard.type('X')
    // Focus Find at once (no router flush in between), then the routed Undo.
    await page.evaluate((selector) => {
      document.querySelector<HTMLInputElement>(selector)!.focus()
    }, FIND)
    await route(page, 'undo')
    await page.waitForTimeout(QUIET_MS)
    const after = await read(page)
    expect(after.value, 'the typed character stays in the document').toContain(
      'brXavo',
    )
    expect(after.lastEdit ?? '', 'the host text keeps it').toContain('brXavo')
    // The base and the typed step, as for any typed character.
    expect(after.depth).toBe('2/0')
    expect(after.focus).toBe('find')
  })
})

test.describe('wysiwyg: Undo in a popover input (the code language)', () => {
  test('Undo reverts the language text and the document follows, as typing did', async ({
    page,
  }) => {
    await open(page, 'wysiwyg')
    await placeCaret(page, 'const a', 3)
    await page.waitForTimeout(600)
    const popoverInput = page
      .locator('.vditor-wysiwyg .vditor-panel input')
      .first()
    await popoverInput.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('py', { delay: 20 })
    await page.waitForTimeout(QUIET_MS)
    const typed = await page.evaluate(() => {
      const win = window as any
      return {
        input: (
          win.vditor.vditor.wysiwyg.popover.querySelector(
            'input',
          ) as HTMLInputElement
        ).value,
        value: win.vditor.getValue() as string,
      }
    })
    expect(typed.input).toBe('py')
    expect(typed.value).toContain('```py')

    // Ctrl+A+`p` replaced `js`; `y` was a second edit. Two presses return to `js`.
    for (let press = 0; press < 2; press++) await route(page, 'undo')
    await page.waitForTimeout(QUIET_MS)
    const undone = await page.evaluate(() => {
      const win = window as any
      const input = win.vditor.vditor.wysiwyg.popover.querySelector(
        'input',
      ) as HTMLInputElement
      return {
        input: input.value,
        value: win.vditor.getValue() as string,
        focused: document.activeElement === input,
      }
    })
    expect(undone.input).toBe('js')
    expect(undone.value).toContain('```js')
    expect(undone.focused).toBe(true)
  })
})
