import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 580 CP2-14 — the negative shortcut sweep (handoff §2.12). shortcut-negative-harness.ts runs
// the REAL webview entry (main.ts) with Vditor built from source, so every VMDE keydown handler and
// every CP2-10 Vditor source patch is live as shipped. With no keybinding shim installed nothing
// maps a key to a VMDE command, which is what a key that VS Code does not bind (or binds elsewhere)
// reaches: pressing any former webview chord, or any default key of a contributed command, must
// change nothing. With the shim (emulation of VS Code's keybinding service, not evidence), the
// default keys and user keys act. Real-key acceptance is Checkpoint 4 in test/vscode-e2e.

type Mode = 'ir' | 'wysiwyg' | 'sv'

const DOC = [
  '# Title',
  '',
  'Para text and a [link](https://example.com/) here.',
  '',
  '- [ ] task item',
  '',
  '> quoted line',
  '',
  '| a | b |',
  '| - | - |',
  '| cellA | cellB |',
  '',
  '```js',
  'let code = 1',
  '```',
  '',
  '## Second',
  '',
  'Tail para',
  '',
].join('\n')

// Webview→host posts that would mean a VMDE action ran (a host-side action, a fold or a mode switch
// persisted). Bookkeeping posts (log, cursor-offset, reading position) are ignored, and so is `edit`:
// the retained keydown undo boundary (undo-boundaries.ts: Enter with any modifier, Ctrl/Cmd+E/K/M)
// re-posts the unchanged document, and a real edit shows in the Markdown comparison.
const EFFECT_POSTS = new Set([
  'edit-in-vscode',
  'open-link',
  'open-code-ref',
  'open-wikilink',
  'request-block-action',
  'apply-block-action',
  'request-outline-section-move',
  'apply-outline-section-move',
  'request-rewrap-document',
  'block-transform-options',
  'save-fold-state',
  'save-options',
  'save',
  'upload',
  'copy-markdown',
  'copy-html',
  'copy-code',
  'copy-link-url',
  'toggle-preview-task-checkbox',
])

async function openEditor(page: Page, mode: Mode, content = DOC) {
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
    // VS Code's webview preload (webview/browser/pre/index.html handleInnerKeydown, a window bubble
    // listener) blocks the browser default of Ctrl/Cmd+Z/Y/F/S/P and, on Electron, Ctrl/Cmd+C/V/X;
    // the workbench handles those keys. It runs no VMDE command, so it is not the keybinding shim.
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if ([90, 89, 70, 83, 80, 67, 86, 88].includes(event.keyCode))
        event.preventDefault()
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
  await page.waitForTimeout(400)
}

const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

/** Focus the active surface and select `length` characters (0 = a caret) from `offset` into the
 *  first occurrence of `needle` (see editor-selection.ts). */
async function selectIn(page: Page, needle: string, offset = 1, length = 0) {
  // Focus first and let a frame pass: focusing the editor restores its last caret, which would
  // otherwise land on top of the selection set below.
  await page.evaluate(async () => {
    const v = (window as any).vditor
    ;(v.vditor[v.getCurrentMode()].element as HTMLElement).focus()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  // A command leaves a live caret intent (editing/caret.ts) that re-places its caret every frame
  // until a real gesture; a programmatic selection is not one. A bare Shift press is, and does
  // nothing else.
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [needle, offset, length] as const)
  // A key-up after the move, as a real caret move has, refreshes Vditor's toolbar state (a stale
  // "bold is current" state would make Bold remove instead of add).
  await page.keyboard.press('Shift')
  await page.waitForTimeout(80)
}

// Caret presentation, not document state: Vditor's IR keyup (expandMarker) and its Arrow keydown
// (processKeydown's issue-358 branch) re-mark which inline nodes show their markers after ANY key.
const CARET_PRESENTATION_CLASSES =
  / ?vditor-ir__node--(?:expand|hidden)| ?vmde-caret-inside/g

/** Everything a key could change: the Markdown, the active surface's DOM (native formatting, folds),
 *  the mode, the Find widget and the effect posts since the last snapshot. */
async function snapshot(page: Page) {
  const state = await page.evaluate(
    (effects) => {
      const win = window as any
      const v = win.vditor
      const mode = v.getCurrentMode()
      const root = v.vditor[mode].element as HTMLElement
      const posted = (win.__posted as { command?: string }[])
        .splice(0)
        .filter((message) => effects.includes(message?.command ?? ''))
      const find = document.querySelector<HTMLElement>('.vmde-find-replace')
      return {
        markdown: v.getValue() as string,
        dom: root.innerHTML,
        mode,
        findOpen: Boolean(find && !find.hidden),
        posted,
      }
    },
    [...EFFECT_POSTS],
  )
  return {
    ...state,
    dom: state.dom.replace(CARET_PRESENTATION_CLASSES, ''),
  }
}

/** What a key changed between two snapshots; empty when it did nothing. */
function changes(
  before: Awaited<ReturnType<typeof snapshot>>,
  after: Awaited<ReturnType<typeof snapshot>>,
): string[] {
  const found: string[] = []
  if (after.markdown !== before.markdown)
    found.push(`markdown became ${JSON.stringify(after.markdown)}`)
  if (after.dom !== before.dom) {
    let at = 0
    while (after.dom[at] === before.dom[at]) at++
    found.push(
      `DOM changed at ${JSON.stringify(after.dom.slice(Math.max(0, at - 60), at + 80))}`,
    )
  }
  if (after.mode !== before.mode) found.push(`mode became ${after.mode}`)
  if (after.findOpen !== before.findOpen) found.push('Find widget opened')
  for (const message of after.posted) found.push(`posted ${message.command}`)
  return found
}

interface Context {
  /** Where the caret (or selection) goes before each key. */
  at: string
  offset?: number
  length?: number
  keys: readonly string[]
}

// The former webview chords (task record inventory W1–W9, V1–V8, V10 and the freed FORMAT keys)
// and the default keys of every contributed command, each pressed where it used to act.
const GENERAL_KEYS = [
  'Control+KeyD',
  'Control+KeyH',
  'Control+KeyL',
  'Control+KeyG',
  'Control+Semicolon',
  'Control+Shift+Digit7',
  'Control+Shift+Digit9',
  'Control+Shift+KeyV',
  'Control+Alt+KeyE',
  'Control+KeyE',
  'Control+KeyA',
  'Control+KeyF',
  'Control+BracketLeft',
  'Control+BracketRight',
  'Shift+Alt+ArrowRight',
  'Shift+Alt+ArrowLeft',
  'Alt+ArrowUp',
  'Alt+ArrowDown',
  'Control+Shift+Semicolon',
  'Control+Shift+KeyJ',
  'Control+Enter',
  'Control+Alt+Enter',
  'F3',
  'Shift+F3',
  'Alt+KeyC',
  'Alt+KeyW',
  'Control+Shift+Digit1',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Control+Alt+Digit${n}`),
]
const FORMAT_GUARD_KEYS = ['Control+KeyB', 'Control+KeyI', 'Control+KeyU']
const HEADING_KEYS = [
  'Control+Equal',
  'Control+Minus',
  'Control+Shift+BracketLeft',
  'Control+Shift+BracketRight',
  'Control+Alt+Shift+BracketLeft',
  'Control+Alt+Shift+BracketRight',
  'Control+Alt+BracketLeft',
  'Control+Alt+BracketRight',
  'Alt+KeyQ',
  'Alt+ArrowUp',
  'Alt+ArrowDown',
  ...[1, 2, 3, 4, 5, 6].map((n) => `Control+Alt+Digit${n}`),
]
const TABLE_KEYS = [
  'Control+Shift+KeyL',
  'Control+Shift+KeyC',
  'Control+Shift+KeyR',
  'Control+Shift+KeyF',
  'Control+Shift+KeyG',
  'Control+Shift+Equal',
  'Control+Shift+Minus',
  'Control+Equal',
  'Control+Minus',
  'Control+Shift+BracketLeft',
  'Control+Shift+BracketRight',
  'Control+Shift+PageUp',
  'Control+Shift+PageDown',
  'Control+KeyA',
  'Alt+ArrowUp',
  'Alt+ArrowDown',
]

const EDGE_KEYS = [
  'Alt+ArrowUp',
  'Alt+ArrowDown',
  'Shift+Alt+ArrowRight',
  'Shift+Alt+ArrowLeft',
]

const CONTEXTS: readonly Context[] = [
  // Undo and Redo first, while the two setup edits are the top of the history: the retained keydown
  // boundaries pressed later (Enter with a modifier, Ctrl+E/K) may stack identical steps on top.
  {
    at: 'Para text',
    keys: ['Control+KeyZ', 'Control+KeyY', 'Control+Shift+KeyZ'],
  },
  { at: 'Para text', keys: [...GENERAL_KEYS, 'Alt+KeyQ'] },
  // B/I/U with a selection: the native guard must keep Chromium's execCommand formatting out.
  { at: 'Para text', offset: 0, length: 4, keys: FORMAT_GUARD_KEYS },
  { at: 'Para text', offset: 0, length: 4, keys: ['Control+KeyA', 'Alt+KeyQ'] },
  { at: 'link', keys: ['Control+Enter', 'Control+KeyL'] },
  { at: 'Title', keys: HEADING_KEYS },
  { at: 'Title', keys: ['Control+KeyK', 'Control+KeyL'] },
  { at: 'task item', keys: ['Control+Shift+KeyJ', 'Control+Enter'] },
  { at: 'quoted line', keys: ['Alt+Enter', 'Control+Alt+Enter'] },
  { at: 'cellB', keys: TABLE_KEYS },
  {
    at: 'let code',
    keys: [
      'Control+Shift+KeyU',
      'Control+Shift+KeyD',
      'Control+Shift+KeyX',
      'Control+KeyA',
    ],
  },
  // The block edges, where Vditor's arrow handling leaves a table or code block (inserting an
  // empty paragraph between two such blocks); the build keeps modified arrows out of it
  // (patchModifiedArrowBlockEscape, media-src/esbuild-shared.mjs).
  { at: 'let code = 1', offset: 12, keys: EDGE_KEYS },
  { at: 'let code', offset: 0, keys: EDGE_KEYS },
  { at: 'cellB', offset: 5, keys: EDGE_KEYS },
  { at: 'cellA', offset: 0, keys: EDGE_KEYS },
]

// Long enough for a key's deferred work (Vditor's render timers, the 250 ms edit sync) to land
// before the next snapshot.
const KEY_SETTLE_MS = 350

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: without the keybinding shim, no former chord or default key acts`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await openEditor(page, mode)
    // Two edits through the Bold and Italic command routes give Undo a step to take (the first
    // edit's own Undo is a known no-op, Task 598), so the sweep's Ctrl+Z proves no route ran.
    for (const [at, name] of [
      ['Tail para', 'bold'],
      ['Second', 'italic'],
    ] as const) {
      await selectIn(page, at, 0, 4)
      await page.evaluate(
        (format) =>
          window.postMessage(
            { command: 'trigger-toolbar-hotkey', name: format },
            '*',
          ),
        name,
      )
      await page.waitForTimeout(1200)
    }
    const edited = await getValue(page)
    expect(edited).toContain('**Tail**')
    expect(edited).toMatch(/\*Seco\*|_Seco_/)
    const acted: string[] = []
    for (const context of CONTEXTS) {
      for (const key of context.keys) {
        await selectIn(page, context.at, context.offset, context.length)
        const before = await snapshot(page)
        await page.keyboard.press(key)
        await page.waitForTimeout(KEY_SETTLE_MS)
        const where = `${key} at "${context.at}"${context.length ? ' (selection)' : ''}`
        for (const change of changes(before, await snapshot(page)))
          acted.push(`${where}: ${change}`)
      }
    }
    expect(acted).toEqual([])
    expect(await getValue(page)).toBe(edited)
    // The history the sweep's Undo keys left alone is real: the Undo route takes it, after any
    // identical steps the retained boundaries stacked on top.
    let undone = false
    for (let step = 0; step < 8 && !undone; step++) {
      await page.evaluate(() =>
        window.postMessage(
          { command: 'trigger-toolbar-hotkey', name: 'undo' },
          '*',
        ),
      )
      await page.waitForTimeout(300)
      undone = (await getValue(page)) !== edited
    }
    expect(undone).toBe(true)
  })
}

// The shim gives each command its default key (or the user key below), as VS Code would.
const USER_KEYS: Readonly<Record<string, string>> = {
  'alt+shift+b': 'vmde.table.insertRowBelow',
  'ctrl+alt+shift+2': 'vmde.format.heading2',
}
const SHIM_COMMANDS = [
  'vmde.format.bold',
  'vmde.format.italic',
  'vmde.format.undo',
  'vmde.format.redo',
  'vmde.fold',
  'vmde.unfold',
  'vmde.moveBlockUp',
  'vmde.moveBlockDown',
  'vmde.selectAll',
  ...Object.values(USER_KEYS),
]

async function installShim(page: Page) {
  await page.evaluate(
    ([commands, userKeys]) =>
      (window as any).__installKeybindingShim(commands, userKeys),
    [SHIM_COMMANDS, USER_KEYS] as const,
  )
}

test('ir: with the shim, the default keys and user keys act (one per mechanism)', async ({
  page,
}) => {
  await openEditor(page, 'ir')
  await installShim(page)

  // Format (trigger-toolbar-hotkey): Bold, then Italic, then Undo through the shared history
  // engine. The first edit's own Undo is a known no-op (Task 598), so Undo is checked on the second.
  await selectIn(page, 'Para text', 0, 4)
  await page.keyboard.press('Control+KeyB')
  await expect.poll(() => getValue(page)).toContain('**Para** text')
  await page.waitForTimeout(1200)
  const bolded = await getValue(page)
  await selectIn(page, 'Tail para', 0, 4)
  await page.keyboard.press('Control+KeyI')
  await expect.poll(() => getValue(page)).toMatch(/(\*|_)Tail\1 para/)
  await page.waitForTimeout(1200)
  await page.keyboard.press('Control+KeyZ')
  await expect.poll(() => getValue(page)).toBe(bolded)
  await page.waitForTimeout(1200)

  // Select All (editor-action): the IR ladder's first stage is the caret's block.
  await selectIn(page, 'Tail para')
  await page.keyboard.press('Control+KeyA')
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe('Tail para')

  // Fold and Unfold (editor-action): the caret's heading section folds and unfolds.
  const folded = page.locator('.vditor-ir .vditor-reset > h2[data-vmde-folded]')
  await selectIn(page, 'Second')
  await page.keyboard.press('Control+Shift+BracketLeft')
  await expect(folded).toHaveCount(1)
  await page.keyboard.press('Control+Shift+BracketRight')
  await expect(folded).toHaveCount(0)

  // A table command on a user key (editor-action through the contained table route).
  await selectIn(page, 'cellB')
  await page.keyboard.press('Alt+Shift+KeyB')
  await expect
    .poll(() => getValue(page))
    .toMatch(/\| cellA \| cellB \|\n\| +\| +\|/)

  // A heading command on a user key (editor-action through the untrusted Vditor chord).
  await selectIn(page, 'Tail para')
  await page.keyboard.press('Control+Alt+Shift+Digit2')
  await expect.poll(() => getValue(page)).toMatch(/^## Tail para$/m)
})

// Move Block resolves its units against the host's exact source, which this plain document keeps
// identical to Vditor's Markdown, and asks the host for the move transaction (the stub host never
// applies it, so the request itself is the observable effect).
const MOVE_DOC = 'One para\n\nTwo para\n\nThree para\n'
const moveRequests = (page: Page) =>
  page.evaluate(() =>
    (window as any).__posted
      .filter((message: any) => message?.command === 'request-block-action')
      .map((message: any) => message.action),
  )

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: Alt+Up/Down request no Move Block without the shim, and one with it`, async ({
    page,
  }) => {
    await openEditor(page, mode, MOVE_DOC)
    for (const key of ['Alt+ArrowUp', 'Alt+ArrowDown']) {
      await selectIn(page, 'Two para')
      await page.keyboard.press(key)
    }
    await page.waitForTimeout(KEY_SETTLE_MS)
    expect(await moveRequests(page)).toEqual([])
    expect(await getValue(page)).toBe(MOVE_DOC)

    await installShim(page)
    await selectIn(page, 'Two para')
    await page.keyboard.press('Alt+ArrowDown')
    await expect
      .poll(() => moveRequests(page))
      .toEqual([
        { kind: 'move', sourceStart: 10, targetStart: 20, placement: 'after' },
      ])
  })
}

test('ir: fixed keys stay webview-local without the shim (Escape ladder, ;; snippet)', async ({
  page,
}) => {
  await openEditor(page, 'ir')
  // Escape ladder (Task 288, Owner Q3): Escape from a caret selects the caret's block.
  await selectIn(page, 'Tail para', 2)
  await page.keyboard.press('Escape')
  await expect
    .poll(() => page.evaluate(() => getSelection()?.toString()))
    .toBe('Tail para')
  // `;;` snippet trigger (a text trigger, policy 2), accepted with the hint popup's Enter.
  await selectIn(page, 'Tail para', 9)
  await page.keyboard.press('Enter')
  await page.keyboard.type(';;det')
  await expect(
    page.locator('.vditor-hint:visible button').filter({ hasText: 'Details' }),
  ).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect
    .poll(() => getValue(page))
    .toContain('<summary>Details</summary>')
})
