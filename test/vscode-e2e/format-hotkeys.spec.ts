import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { settle, wf } from './webview-helpers'

// Task 505 — "one owner per key, one source of truth" rewrite of task 492 Phase 4's original spec.
// Root cause fixed here: Vditor's OWN hotkey table (media-src/node_modules/vditor/src/ts/util/
// Options.ts) drove the toolbar tooltip/aria-label AND its own bubble-phase keydown handler, so a
// `contributes.keybindings` entry alone (Phase 4's fix) left Vditor's table untouched — stale
// tooltips, and (for undo/redo) a second live handler. The fix: every promoted key gets
// `hotkey: ''` in toolbar.ts (Vditor's own handler can never see it — see hotKey.ts's
// matchHotKey), tooltips are rebuilt from the SAME shared table (src/shared/editor-shortcuts.ts) the
// command registration reads. Task 580 CP2-3 binds undo/redo to VS Code's own Undo/Redo keys
// (Ctrl+Z; Ctrl+Y and Ctrl+Shift+Z), so their keypresses also run one VS Code command each.
// Task 580 CP3-1 ships the VMDE-only formatting commands unbound except Bold and Italic (the
// Owner's convention keys) and Indent/Outdent (VS Code's indentLines/outdentLines keys): the freed
// keys must do nothing in the editor, and their commands still run through `executeCommand`.
//
// A real keypress (not `executeCommand`) is used throughout, exactly like Phase 4's original
// tests, because `executeCommand` cannot exercise whichever path(s) actually resolve a keydown in
// real VS Code — the double-fire and native-browser-default risks are keydown-level, not
// command-level. Test A's bold case additionally caught a NEW defect this task discovered mid-
// implementation: removing Vditor's own `preventDefault()` (via `hotkey: ''`) also removes the
// side effect that used to suppress the BROWSER's native contenteditable execCommand for Ctrl+B/
// I/U — measured without a fix as `Hello ****world.` (corrupted) instead of `Hello **world**.`.
// The fix is `media-src/src/editing/format-hotkey-guard.ts`, a capture-phase preventDefault-ONLY
// listener (no action) — Test A's bold/italic/code cases are the regression net for it.

const getValue = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (
          window as unknown as { vditor?: { getValue?: () => string } }
        ).vditor?.getValue?.() ?? '',
    ) as Promise<string>

// Selects the exact text `needle` (start/end within the same text node) inside `surface`, mirroring
// list-normalize.spec.ts's caretAt but with a non-collapsed range — formatting hotkeys act on the
// current SELECTION, not just the caret. Also used to place a collapsed-equivalent caret for
// line-prefix items (list/quote/headings/indent/outdent act on the current line, not the selected
// text itself).
async function selectWord(
  frame: ReturnType<typeof wf>,
  needle: string,
  surface = '.vditor-ir',
) {
  await frame
    .locator(surface)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    (_el, args) => {
      const [word, sel] = args as [string, string]
      const root = document.querySelector(sel) as HTMLElement | null
      if (!root) throw new Error(`no ${sel}`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        const idx = text.indexOf(word)
        if (idx === -1) continue
        const r = document.createRange()
        r.setStart(node as Text, idx)
        r.setEnd(node as Text, idx + word.length)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
        ;(node.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`selection anchor "${word}" not found in ${sel}`)
    },
    [needle, surface] as [string, string],
  )
}

// Places a COLLAPSED caret `offset` chars INTO the first text node containing `needle` (offset
// relative to the needle's own start, so it survives the DOM changing when the word gets wrapped:
// "Hello world." as one node vs `**world**` with "world" as its own node). Task 506 needs it: the
// word-under-caret behaviour only exists when NOTHING is selected.
async function caretInWord(
  frame: ReturnType<typeof wf>,
  needle: string,
  offset: number,
  surface = '.vditor-ir',
) {
  await frame
    .locator(surface)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    (_el, args) => {
      const [n, off, sel] = args as [string, number, string]
      const root = document.querySelector(sel) as HTMLElement | null
      if (!root) throw new Error(`no ${sel}`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        const idx = text.indexOf(n)
        if (idx === -1) continue
        const r = document.createRange()
        r.setStart(node as Text, idx + off)
        r.collapse(true)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
        ;(node.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`anchor ${n} not found in ${sel}`)
    },
    [needle, offset, surface] as [string, number, string],
  )
}

// The caret's absolute character offset within the IR editor (every text node, markers included).
// Task 506 asserts RELATIVE deltas from this — the whole-document baseline (heading markers, etc.)
// is irrelevant; what matters is that the wrap shifts the caret by exactly the marker length.
const caretOffsetOf = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('.vditor-ir')
    .first()
    .evaluate((ed) => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return -1
      const r = sel.getRangeAt(0)
      if (!(ed as HTMLElement).contains(r.startContainer)) return -1
      const before = document.createRange()
      before.selectNodeContents(ed as Node)
      before.setEnd(r.startContainer, r.startOffset)
      return before.toString().length
    }) as Promise<number>

async function openDoc(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  frame: ReturnType<typeof wf>,
  docPath: string,
  content: string,
) {
  writeFileSync(docPath, content)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: unknown) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file((args as string[])[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // task 512: retain — pre-input native-hotkey and undo-stack sequencing guard
  await settle(frame, 1500)
}

// Runs one VMDE command the way the Command Palette (or a user keybinding) does.
async function runCommand(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  command: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: unknown) => {
      await vscode.commands.executeCommand((args as string[])[0])
    },
    [command] as [string],
  )
}

test('Bold/Italic keys act exactly once, the freed formatting keys do nothing, and every formatting command still runs — incl. the native-execCommand guard for Ctrl+B/I/U', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)

  const docPath = path.join(baseDir, 'format-hotkeys-kept.md')
  const original = [
    '# doc',
    '',
    'Hello boldword.',
    '',
    'Hello italicword.',
    '',
    'Hello strikeword.',
    '',
    'Hello inlineword.',
    '',
    'list indexline here',
    '',
    'quote pointline here',
    '',
    'ordered numword here',
    '',
    'check taskword here',
    '',
    'Hello codeword.',
    '',
  ].join('\n')
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  // Ctrl+B — the exact defect Task 505 discovered mid-implementation: without the native-
  // execCommand guard, Chrome's built-in contenteditable bold ran alongside the VS Code command,
  // producing `Hello ****world.` A single, uncorrupted `**boldword**` proves both: no double-fire
  // AND the browser default was suppressed.
  await selectWord(frame, 'boldword')
  await workbox.keyboard.press('Control+b')
  await settle(frame, 900)
  expect(await getValue(frame), 'Ctrl+B').toContain('**boldword**')

  // Ctrl+I — same native-execCommand family as Ctrl+B.
  await selectWord(frame, 'italicword')
  await workbox.keyboard.press('Control+i')
  await settle(frame, 900)
  expect(await getValue(frame), 'Ctrl+I').toContain('*italicword*')

  // The freed keys: each one leaves the document unchanged (Ctrl+G opens VS Code's own Go to Line,
  // closed again here), then the command it used to run still formats the same word. Ctrl+U runs
  // last: it is also the browser's native underline chord (the other half of the guard's regression
  // net), and wrapping a mid-sentence word in a fence reflows the paragraph.
  const freed: [string, string, string, RegExp][] = [
    ['Control+d', 'strikeword', 'vmde.format.strike', /~~strikeword~~/],
    ['Control+g', 'inlineword', 'vmde.format.inlineCode', /`inlineword`/],
    [
      'Control+l',
      'indexline',
      'vmde.format.list',
      /^[*-]\s+list indexline here$/m,
    ],
    [
      'Control+Semicolon',
      'pointline',
      'vmde.format.quote',
      /^>\s*quote pointline here$/m,
    ],
    [
      'Control+Shift+7',
      'numword',
      'vmde.format.orderedList',
      /^1\.\s+ordered numword here$/m,
    ],
    [
      'Control+Shift+9',
      'taskword',
      'vmde.format.check',
      /^[*-]\s+\[ \]\s+check taskword here$/m,
    ],
    ['Control+u', 'codeword', 'vmde.format.code', /```[^`]*codeword[^`]*```/],
  ]
  for (const [key, word, command, formatted] of freed) {
    await selectWord(frame, word)
    const before = await getValue(frame)
    await workbox.keyboard.press(key)
    await settle(frame, 900)
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen')
    })
    expect(await getValue(frame), `${key} must not format`).toBe(before)
    await selectWord(frame, word)
    await runCommand(evaluateInVSCode, command)
    await settle(frame, 900)
    expect(await getValue(frame), command).toMatch(formatted)
  }
})

// Ctrl+H belongs to Replace on Win/Linux; Headings (unbound, Task 580 CP3-1) runs by command.
test('Ctrl+H opens Replace, never Headings, and the Headings command opens the level panel', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-headings.md')
  const frame = wf(workbox)
  await openDoc(
    evaluateInVSCode,
    frame,
    docPath,
    '# doc\n\nheading titleline here\n',
  )

  await selectWord(frame, 'titleline')
  await workbox.keyboard.press('Control+h')
  const panel = frame
    .locator('.vditor-toolbar [data-type="headings"]')
    .locator('..')
    .locator('.vditor-hint')
  const widget = frame.locator('.vmde-find-replace')
  await expect(widget).toBeVisible({
    timeout: 5_000,
  })
  await expect(widget.locator('[data-find]')).toBeFocused()
  await expect(panel, 'Ctrl+H must not open Headings').toBeHidden()
  await workbox.keyboard.press('Escape')
  await expect(widget).toBeHidden()
  await workbox.keyboard.press('Control+h')
  await expect(widget).toBeVisible()
  const editor = frame.locator('.vditor-ir .vditor-reset').first()
  await editor.click({ position: { x: 8, y: 8 } })
  await expect(editor).toBeFocused()
  await workbox.keyboard.press('Escape')
  await expect(widget).toBeHidden()
  await selectWord(frame, 'titleline')
  // Vditor's toolbar highlight is debounced (200 ms) and only runs on real input events; the
  // programmatic selection above leaves the Headings button "current" from the earlier caret in
  // `# doc`, and a click on a current Headings button removes the heading instead of opening the
  // panel (Vditor's Headings.ts). Wait for the highlight to describe the paragraph. This was the
  // intermittent "Headings panel" failure of this step.
  await frame.locator('.vditor-ir').first().press('Shift')
  await settle(frame, 400)
  await runCommand(evaluateInVSCode, 'vmde.format.headings')
  await expect(
    panel,
    'the Headings command must open the level panel',
  ).toBeVisible({
    timeout: 5_000,
  })
  await panel.locator('button[data-tag="h2"]').click()
  await settle(frame, 900)
  expect(await getValue(frame), 'Headings command -> H2').toMatch(
    /^##\s+heading titleline here$/m,
  )
})

test('Ctrl+]/[ (indent/outdent) act on a list item IMMEDIATELY — no 200ms highlight-debounce wait (task 506 follow-up)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-indent-immediate.md')
  const original = '# doc\n\n- parent item\n- child item\n'
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  // Caret inside "child item", Ctrl+] IMMEDIATELY (no settle) — the user-report repro. Before the
  // fix, Vditor's highlightToolbarIR 200ms debounce left the indent button DISABLED (caret not yet
  // settled in a list), and the hotkey's synthetic click no-oped on the disabled button. The
  // remapped-rows test above masks this by selecting the word first (its IPC round-trip outlasts
  // the debounce); a real collapsed caret does not. Deliberately NO settle here.
  await caretInWord(frame, 'child', 2)
  await workbox.keyboard.press('Control+]')
  await settle(frame, 900)
  const indented = await getValue(frame)
  expect(indented, 'Ctrl+] must nest a list item immediately').toContain(
    '  - child item',
  )

  // Ctrl+[ immediately un-nests it again (same disabled-window hazard on the outdent button). The
  // caret is still where the indent left it (inside "child item", which Vditor has split at the
  // caret into "ch"|"ild item" — re-placing it would need a split-aware search, and the whole
  // point is that the caret survives across the two keypresses).
  await workbox.keyboard.press('Control+[')
  await settle(frame, 900)
  expect(
    await getValue(frame),
    'Ctrl+[ must un-nest a list item immediately',
  ).toBe(original)
})

test('a COLLAPSED caret inside a word + Ctrl+B/I (and the Strikethrough command) wraps THAT word (task 506) — and the same trigger again toggles it off', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-word-under-caret.md')
  const original = '# doc\n\nHello world.\n'
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  // Caret INSIDE "world" with nothing selected. Without task 506 Vditor inserts open markers at the
  // caret (`Hello w**or**ld.`); the capture-phase word-expand must make it wrap the whole word.
  await caretInWord(frame, 'world', 2)
  await settle(frame, 400) // let highlightToolbarIR's 200ms debounce mark the button current
  const caretBefore = await caretOffsetOf(frame)
  await workbox.keyboard.press('Control+b')
  await settle(frame, 900)
  expect(
    await getValue(frame),
    'Ctrl+B on a caret inside a word wraps the word',
  ).toBe('# doc\n\nHello **world**.\n')
  expect(
    await caretOffsetOf(frame),
    'Ctrl+B must keep the caret at the SAME position within the word (shifted only by the opening **)',
  ).toBe(caretBefore + 2)

  // Every subsequent press reuses the caret exactly where the previous one left it — the restore
  // is what the test asserts, so re-placing the caret between steps would test nothing. The
  // settle is load-bearing for toggle-off: Vditor's highlightToolbarIR is debounced 200ms, and the
  // "current" class that selects the remove-branch is only set once it runs.
  await workbox.keyboard.press('Control+b')
  await settle(frame, 900)
  expect(await getValue(frame), 'Ctrl+B again toggles the word OFF').toBe(
    original,
  )
  expect(
    await caretOffsetOf(frame),
    'toggle-off must put the caret back at its original position',
  ).toBe(caretBefore)

  await workbox.keyboard.press('Control+i')
  await settle(frame, 900)
  expect(await getValue(frame), 'Ctrl+I wraps the word').toBe(
    '# doc\n\nHello *world*.\n',
  )
  expect(
    await caretOffsetOf(frame),
    'Ctrl+I keeps the caret in place (single-char * marker)',
  ).toBe(caretBefore + 1)

  await workbox.keyboard.press('Control+i')
  await settle(frame, 900)
  expect(await getValue(frame), 'Ctrl+I again toggles the word OFF').toBe(
    original,
  )
  expect(
    await caretOffsetOf(frame),
    'Ctrl+I toggle-off restores the original caret position',
  ).toBe(caretBefore)

  // Task 580 CP3-1 — Strikethrough is unbound; its command expands the word the same way.
  await runCommand(evaluateInVSCode, 'vmde.format.strike')
  await settle(frame, 900)
  expect(await getValue(frame), 'Strikethrough wraps the word').toBe(
    '# doc\n\nHello ~~world~~.\n',
  )
  expect(
    await caretOffsetOf(frame),
    'Strikethrough keeps the caret in place (~~ marker = 2)',
  ).toBe(caretBefore + 2)

  await runCommand(evaluateInVSCode, 'vmde.format.strike')
  await settle(frame, 900)
  expect(
    await getValue(frame),
    'Strikethrough again toggles the word OFF',
  ).toBe(original)
  expect(
    await caretOffsetOf(frame),
    'Strikethrough toggle-off restores the original caret position',
  ).toBe(caretBefore)
})

test("Indent/Outdent act exactly once at VS Code's indent/outdent keys (Ctrl+]/[)", async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-remapped.md')
  const original = ['# doc', '', '- parent item', '- child item', ''].join('\n')
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  // Ctrl+] / Ctrl+[ — indent/outdent, remapped off Vditor's ⇧⌘O/⇧⌘I onto VS Code's indentLines/outdentLines keys. Only act inside a list item
  // (Outdent.ts/Indent.ts both bail unless the range is inside an <li>) — caret in "child item".
  const beforeIndent = await getValue(frame)
  await selectWord(frame, 'child')
  await workbox.keyboard.press('Control+]')
  await settle(frame, 900)
  const afterIndent = await getValue(frame)
  expect(
    afterIndent,
    'Ctrl+] must change the document (nest "child item")',
  ).not.toBe(beforeIndent)
  const indentedLine = afterIndent
    .split('\n')
    .find((l) => l.includes('child item'))!
  const leadingWs = (s: string) => s.length - s.trimStart().length
  expect(
    leadingWs(indentedLine),
    'Ctrl+] must indent "child item" under "parent item"',
  ).toBeGreaterThan(0)

  await selectWord(frame, 'child')
  await workbox.keyboard.press('Control+[')
  await settle(frame, 900)
  const afterOutdent = await getValue(frame)
  const outdentedLine = afterOutdent
    .split('\n')
    .find((l) => l.includes('child item'))!
  expect(
    leadingWs(outdentedLine),
    'Ctrl+[ must outdent "child item" back to top level',
  ).toBe(0)
})

test('undo/redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, real keypresses) each undo/redo exactly ONE step — no double-fire now that toolbar-hotkey-dedupe.ts is gone', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-undo-redo.md')
  const original = '# doc\n\nHello world.\n'
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  // Two SEPARATE toolbar-driven edits, so undo/redo has two distinct steps to distinguish a
  // single real Ctrl+Z from a double-fire (which would jump both steps at once).
  await selectWord(frame, 'world')
  await workbox.keyboard.press('Control+b')
  // task 512: retain — observation window for delayed native-command double fire
  await settle(frame, 1200) // outlast Vditor's undoDelay (Options.ts, 800ms) so this lands as a step
  const afterBold = await getValue(frame)
  expect(afterBold, 'sanity: bold applied').toBe('# doc\n\nHello **world**.\n')

  await selectWord(frame, 'Hello')
  await workbox.keyboard.press('Control+i')
  // task 512: retain — observation window for delayed native-command double fire
  await settle(frame, 1200)
  const afterItalic = await getValue(frame)
  expect(afterItalic, 'sanity: italic applied on top of bold').toBe(
    '# doc\n\n*Hello* **world**.\n',
  )

  // Task 580 CP2-3 — these real keypresses run vmde.format.undo/redo through their VS Code
  // keybindings; the webview no longer matches the keys itself, so nothing races the command.
  await workbox.keyboard.press('Control+z')
  // Vditor keeps its history transition locked through undoDelay (800 ms). Observe beyond that
  // window so a second chord cannot race the first step's stack transfer.
  await settle(frame, 1200)
  expect(
    await getValue(frame),
    'one Ctrl+Z must undo only the italic edit, landing exactly on the bold-only state — a double-fire would skip straight to the original',
  ).toBe(afterBold)

  await workbox.keyboard.press('Control+z')
  await settle(frame, 1200)
  expect(await getValue(frame), 'a second Ctrl+Z reaches the original').toBe(
    original,
  )

  await workbox.keyboard.press('Control+y')
  await settle(frame, 1200)
  expect(
    await getValue(frame),
    'one Ctrl+Y must redo only the bold edit, not both',
  ).toBe(afterBold)

  await workbox.keyboard.press('Control+Shift+z')
  await settle(frame, 1200)
  expect(
    await getValue(frame),
    'Ctrl+Shift+Z must redo the italic edit on top, reaching the original two-edit state',
  ).toBe(afterItalic)
})

test('Ctrl+K is not a promoted command, so the Ctrl+K,Ctrl+S chord (Open Keyboard Shortcuts) still reaches VS Code with the VMDE editor focused', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(90_000)

  const docPath = path.join(baseDir, 'format-hotkeys-ctrlk-chord.md')
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, '# doc\n\nHello world.\n')

  const tabsBefore = await evaluateInVSCode(async (vscode) =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label)),
  )

  // A real two-part chord, exactly as VS Code's keybinding resolver detects one: the first
  // keydown, released, then the second. `Ctrl+K Ctrl+S` is VS Code's own default binding for
  // "Preferences: Open Keyboard Shortcuts" — chosen as the probe chord because it's a stock
  // default, not something this extension declares, so a NEW tab appearing is unambiguous
  // evidence the chord resolved through the workbench, not through anything VMDE registers.
  await workbox.keyboard.press('Control+k')
  await settle(frame, 200)
  await workbox.keyboard.press('Control+s')
  await expect
    .poll(
      async () => {
        const tabsAfter = await evaluateInVSCode(async (vscode) =>
          vscode.window.tabGroups.all.flatMap((g) =>
            g.tabs.map((t) => t.label),
          ),
        )
        return tabsAfter.some(
          (label) =>
            !tabsBefore.includes(label) && /keyboard shortcuts/i.test(label),
        )
      },
      {
        timeout: 10_000,
        message:
          'the Keyboard Shortcuts editor must open — proves Ctrl+K did not get consumed as a standalone binding while the VMDE editor had focus',
      },
    )
    .toBe(true)
})

// Task 580 CP3-1b: an unbound navigation chord (Ctrl+End) moves the caret natively and no VMDE
// command consumes the keydown's selection snapshot. A command that arrives shortly after without
// its own keydown (menu, VS Code toolbar, another extension's executeCommand) must act at the new
// caret. Before the keyup refresh it restored the pre-move selection and bolded `oldword`.
test('a command after an unbound Ctrl+End acts at the moved caret, not the pre-move selection', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)

  const docPath = path.join(baseDir, 'format-hotkeys-moved-caret.md')
  const original = [
    '# doc',
    '',
    'Hello oldword here.',
    '',
    'Final line',
    '',
  ].join('\n')
  const frame = wf(workbox)
  await openDoc(evaluateInVSCode, frame, docPath, original)

  await selectWord(frame, 'oldword')
  await workbox.keyboard.press('Control+End')
  const pressed = Date.now()
  // The caret must have moved natively to the end of the document.
  expect(
    await frame.locator('body').evaluate(() => {
      const selection = window.getSelection()
      return selection?.isCollapsed ? selection.toString() : 'not collapsed'
    }),
  ).toBe('')
  await runCommand(evaluateInVSCode, 'vmde.format.bold')
  expect(
    Date.now() - pressed,
    'command within 500 ms of the chord',
  ).toBeLessThan(500)
  await settle(frame, 900)

  const value = await getValue(frame)
  // A collapsed caret at the end of `line` bolds that word (Task 506's word-under-caret rule).
  expect(
    value,
    'Bold acts at the moved caret, not at the pre-move selection',
  ).toBe('# doc\n\nHello oldword here.\n\nFinal **line**\n')
})
