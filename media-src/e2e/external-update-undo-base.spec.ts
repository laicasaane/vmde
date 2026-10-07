import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 603 item 3 — an external change starts one webview history base, and no caret-only undo
// entry follows it. Vditor's `setValue(content, true)` clears the history and takes the base at
// once (a root-level caret marker, or none: the caret is restored afterwards), and it leaves its
// delayed after-render record armed, which added a second entry with the same text 800 ms later;
// the second Ctrl+Z then moved the caret without changing text. The router now keeps that clear
// and turns off the record's undo entry. This runs the REAL webview entry (main.ts, as
// shortcut-negative-harness.ts), so the real message router, caret restore, history wrapper, Task
// 597's restore and the source-patched Vditor all take part; the host's `update` is posted as a
// window message. Real-VS-Code acceptance (the same sequence with a WorkspaceEdit) is
// test/vscode-e2e/undo-routing-hygiene.spec.ts.
//
// A base holding the restored caret was tried and rejected: the Undo that returns to the base then
// puts the caret where it stood when the update arrived (for example the document start) instead of
// where the edit was undone. With a root-level marker, Task 597's restore places the caret at the
// change site.

type Mode = 'ir' | 'wysiwyg' | 'sv'

// Round-trips exactly through every mode. The update changes the last paragraph, away from the caret.
const HEAD_DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const HEAD_DOC_UPDATED =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia JULIET kilo lima.\n'
// No heading, so no Task 173 fold decoration separates the live DOM from the history base.
const FLAT_DOC =
  'Alpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const FLAT_DOC_UPDATED =
  'Alpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia JULIET kilo lima.\n'
// A heading, then 60 paragraphs: the viewport scrolls, so Undo jumping to the document start shows.
const LONG_PARAGRAPHS = Array.from(
  { length: 60 },
  (_, index) =>
    `Paragraph number ${index + 1} holds filler words for scrolling.`,
)
const LONG_DOC = `# Long\n\n${LONG_PARAGRAPHS.join('\n\n')}\n`
const LONG_DOC_UPDATED = LONG_DOC.replace('number 30 ', 'number THIRTY ')

// Longer than Vditor's 800 ms undo delay plus the 250 ms edit sync and IR's 220 ms settle.
const QUIET_MS = 1400

async function open(page: Page, mode: Mode, content: string) {
  const init = {
    command: 'update',
    type: 'init',
    content,
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

// The caret goes inside `needle` at `offset`, with bare modifier presses around it so a leftover
// caret request from the open or the update cannot move it back (editing/caret.ts invalidates on a
// real gesture).
async function placeCaret(page: Page, needle: string, offset: number) {
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, 0] as const)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(100)
}

// The host's external change, as the router receives it.
const postUpdate = (page: Page, content: string) =>
  page.evaluate((text) => {
    const win = window as any
    win.__posted.length = 0
    win.postMessage({ command: 'update', content: text }, '*')
  }, content)

// The Undo/Redo route of VS Code's keys: the keydown reaches the webview (a gesture, which drops a
// caret request still armed), then `vmde.format.undo` posts this message.
async function postHistory(page: Page, name: 'undo' | 'redo') {
  await page.keyboard.down('Control')
  await page.evaluate((command) => {
    window.postMessage(
      { command: 'trigger-toolbar-hotkey', name: command },
      '*',
    )
  }, name)
  await page.keyboard.up('Control')
}

const history = (page: Page) =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page reader of the history, caret, scroll and posts
  page.evaluate(() => {
    const win = window as any
    const inner = win.vditor.vditor
    const mode = inner.currentMode
    const slot = inner.undo[mode]
    const base = slot.undoStack[0]?.[0]?.diffs?.[0]?.[1] as string | undefined
    const selection = getSelection()!
    const root = inner[mode].element as HTMLElement
    let caret: number | null = null
    let caretVisible = false
    if (selection.rangeCount && root.contains(selection.anchorNode)) {
      const range = document.createRange()
      range.selectNodeContents(root)
      range.setEnd(selection.anchorNode!, selection.anchorOffset)
      caret = range.toString().length
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      caretVisible = rect.bottom > 0 && rect.top < window.innerHeight
    }
    let scroller: HTMLElement | null = root
    while (
      scroller &&
      !(
        /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
        scroller.scrollHeight > scroller.clientHeight
      )
    )
      scroller = scroller.parentElement
    const wbrAt = base
      ? base.search(/<wbr>|<span class="vditor-wbr"><\/span>/)
      : -1
    return {
      undo: slot.undoStack.length as number,
      redo: slot.redoStack.length as number,
      // The base's caret marker with its surroundings, or null when the base has none.
      baseMarker:
        base && wbrAt >= 0
          ? base
              .slice(Math.max(0, wbrAt - 12), wbrAt + 12)
              .replace(/<span class="vditor-wbr"><\/span>/, '<wbr>')
          : null,
      // Whether the marker sits inside a text run ("Alpha br<wbr>avo"), not on the editable root.
      baseCaretOnText: !!base && /[A-Za-z]<wbr>[A-Za-z]/.test(base),
      value: win.vditor.getValue() as string,
      caret,
      caretVisible,
      scrollTop: Math.round(
        (scroller ?? document.scrollingElement)?.scrollTop ?? 0,
      ),
      undoDisabled:
        !!inner.toolbar.elements.undo?.children[0]?.classList.contains(
          'vditor-menu--disabled',
        ),
      bases: (win.__posted as { command?: string }[]).filter(
        (message) => message.command === 'history-base',
      ).length,
      transitions: (win.__posted as { command?: string }[]).filter(
        (message) => message.command === 'history-transition',
      ).length,
    }
  })

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test.describe(`${mode}: external update history base (Task 603 item 3)`, () => {
    test('one base, no caret-only entry 800 ms later, the live caret kept', async ({
      page,
    }) => {
      await open(page, mode, HEAD_DOC)
      await placeCaret(page, 'bravo', 2)
      const before = await history(page)
      await postUpdate(page, HEAD_DOC_UPDATED)
      await page.waitForTimeout(80)
      const early = await history(page)
      await page.waitForTimeout(QUIET_MS)
      const late = await history(page)

      expect(before.undo).toBe(1)
      expect(late.value).toContain('JULIET')
      // The history holds exactly the update's base: taken by Vditor's clear before the caret is
      // restored, so its marker is on the root (or absent), not on text.
      expect(early.undo).toBe(1)
      expect(early.baseCaretOnText, JSON.stringify(early.baseMarker)).toBe(
        false,
      )
      // 800 ms later the delayed render record has added nothing: no caret-only second entry, so
      // Undo stays disabled and the base is unchanged.
      expect(late.undo, 'a caret-only entry was added').toBe(1)
      expect(late.undoDisabled).toBe(true)
      expect(late.baseMarker).toBe(early.baseMarker)
      // The live caret is restored where it was.
      expect(late.caret).toBe(before.caret)
      // Task 602: one `history-base` for the new base (before edit-sync reseeds).
      expect(late.bases).toBe(1)
    })

    test('an edit typed after the 800 ms window: Undo puts the caret at the edit, a second Undo changes nothing', async ({
      page,
    }) => {
      await open(page, mode, HEAD_DOC)
      await placeCaret(page, 'bravo', 2)
      const before = await history(page)
      await postUpdate(page, HEAD_DOC_UPDATED)
      await page.waitForTimeout(QUIET_MS)
      await page.keyboard.type('Y')
      await page.waitForTimeout(QUIET_MS)
      const edited = await history(page)
      expect(edited.value).toContain('brYavo')
      // The base and the typed edit, nothing between.
      expect(edited.undo).toBe(2)

      await postHistory(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const first = await history(page)
      expect(first.value).not.toContain('Y')
      expect(first.value).toContain('JULIET')
      expect(first.undo).toBe(1)
      expect(first.redo).toBe(1)
      // Task 597's restore: the caret lands where the edit was undone (`br|avo`).
      expect(first.caret).toBe(before.caret)

      await postHistory(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const second = await history(page)
      // The history starts at the external change: nothing left to undo, so neither the text nor
      // the caret moves, and the host hears of no further transition.
      expect(second.value).toBe(first.value)
      expect(second.caret).toBe(first.caret)
      expect(second.undo).toBe(1)
      expect(second.redo).toBe(1)
      expect(second.transitions).toBe(first.transitions)
    })

    test('an edit typed inside the 800 ms window still gets its own step', async ({
      page,
    }) => {
      await open(page, mode, HEAD_DOC)
      await placeCaret(page, 'bravo', 2)
      const before = await history(page)
      await postUpdate(page, HEAD_DOC_UPDATED)
      // Well inside the window: the update's own render record is still armed.
      await page.waitForTimeout(120)
      await page.keyboard.type('Y')
      await page.waitForTimeout(QUIET_MS)
      const edited = await history(page)
      expect(edited.value).toContain('brYavo')
      expect(edited.undo, 'the quick edit lost its checkpoint').toBe(2)

      await postHistory(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const undone = await history(page)
      expect(undone.value).not.toContain('Y')
      expect(undone.value).toContain('JULIET')
      expect(undone.undo).toBe(1)
      expect(undone.caret).toBe(before.caret)
    })

    test('the first key after the update moves the base caret to where the user was, where the DOM still equals the base', async ({
      page,
    }) => {
      // Vditor's recordFirstPosition rewrites the base's caret on the first keydown, but only while
      // the history holds the base alone and the live DOM is the base's DOM apart from the caret.
      // Before Task 603 item 3 the caret-only entry (800 ms after the update) made the stack two
      // deep, so it never ran after that. The document has no heading, so no fold decoration
      // separates the DOM from the base; SV adds a trailing gap paragraph after the base is taken
      // (as before the fix), which keeps the base's root marker there.
      await open(page, mode, FLAT_DOC)
      await placeCaret(page, 'bravo', 2)
      await postUpdate(page, FLAT_DOC_UPDATED)
      await page.waitForTimeout(QUIET_MS)
      const settled = await history(page)
      expect(settled.undo).toBe(1)
      expect(settled.baseCaretOnText, JSON.stringify(settled.baseMarker)).toBe(
        false,
      )
      // The user moves elsewhere without typing (a bare modifier ends the programmatic selection),
      // then types: the base gets the new caret before the edit.
      await placeCaret(page, 'JULIET', 3)
      await page.keyboard.type('Y')
      const first = await history(page)
      expect(first.undo).toBe(1)
      if (mode === 'sv') {
        expect(first.baseCaretOnText, JSON.stringify(first.baseMarker)).toBe(
          false,
        )
      } else {
        expect(first.baseMarker, 'recordFirstPosition').toContain('JUL<wbr>IET')
      }
    })

    test('a heading document, the update at the idle document-start caret: click elsewhere, type, Undo returns to the edit', async ({
      page,
    }) => {
      // The task's measured case: the caret sat at the document start when the update arrived. A
      // base holding that caret sent Undo back to `# |Long`, scrolling to the top.
      await open(page, mode, LONG_DOC)
      await placeCaret(page, 'Long', 0)
      await postUpdate(page, LONG_DOC_UPDATED)
      await page.waitForTimeout(QUIET_MS)
      const settled = await history(page)
      expect(settled.undo).toBe(1)
      expect(settled.value).toContain('number THIRTY ')

      // Place the caret in a paragraph far from the top, then bring it into view, as a click there
      // would (selectEditorText focuses the root, which resets the scroll).
      await placeCaret(page, 'Paragraph number 45', 12)
      await page.evaluate(() => {
        const node = getSelection()?.anchorNode
        const element = node instanceof Element ? node : node?.parentElement
        element?.scrollIntoView({ block: 'center' })
      })
      await page.waitForTimeout(100)
      const placed = await history(page)
      expect(placed.scrollTop, 'the document scrolled').toBeGreaterThan(200)
      await page.keyboard.type('Y')
      await page.waitForTimeout(QUIET_MS)
      const edited = await history(page)
      expect(edited.value).toContain('Paragraph nuYmber 45')
      expect(edited.undo).toBe(2)

      await postHistory(page, 'undo')
      await page.waitForTimeout(QUIET_MS)
      const undone = await history(page)
      expect(undone.value).not.toContain('nuYmber')
      expect(undone.undo).toBe(1)
      // Task 597's restore puts the caret at the edit, and the viewport stays there.
      expect(undone.caret, 'the caret returned to the edit').toBe(placed.caret)
      expect(undone.caretVisible).toBe(true)
      expect(
        Math.abs(undone.scrollTop - placed.scrollTop),
        'the view jumped',
      ).toBeLessThan(120)
    })
  })
}
