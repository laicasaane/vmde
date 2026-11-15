import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { type BuildOptions, build, type Plugin } from 'esbuild'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 733 / 012-16 B-14 (D-13 design sections 2, 5.2, 11.3 and 12.2): the caret after the IR Enter
// paths that V-3a changes, and after Undo and Redo, with the guard constant
// `VDITOR_SINGLE_SELECTION_WRITE` on and off. Vendored Vditor runs only in a browser, so this is the
// caret proof of the patch. The page runs the real webview entry (main.ts) with Vditor built from
// source and the build patches applied (the shortcut-negative harness).
//
// - Guard on: the registered `/shortcut-negative.html` page, bundled by the e2e server.
// - Guard off: the same harness bundled here with the constant set to `false` in
//   `util/selection-write.ts`, served through `page.route` (no change to the harness registry).
//
// Cases: a code block Enter (the V-3a path) puts the caret at the start of the new line and
// mutates no live Range with the guard on; a table cell Enter (V-3b dropped: the unpatched path in
// both builds) puts the caret right after the inserted `br`; a cell, item, paragraph and code block
// Undo and Redo put the caret where the unpatched path (guard off) puts it.

type Guard = 'on' | 'off'

const DOC = [
  'Alpha bravo charlie.',
  '',
  '- item one',
  '- item two',
  '',
  '| a | b |',
  '| - | - |',
  '| cellA | cellB |',
  '',
  '```js',
  'const echo = 1',
  'const foxtrot = 2',
  '```',
  '',
  'Tail para.',
  '',
].join('\n')

const CODE = 'pre.vditor-ir__marker--pre code'
const OFF_PAGE = '/ir-enter-caret-off.html'
const OFF_SCRIPT = '/ir-enter-caret-off.js'
// Undo and Redo are VS Code commands: the keybinding shim posts their routes as the host would.
const HISTORY_COMMANDS = ['vmde.format.undo', 'vmde.format.redo']
// Vditor's IR undo checkpoint and the unit engine's record run after the typing settles.
const SETTLE_MS = 1000

/** Rewrites the guard constant to `false` in `util/selection-write.ts`; fails when it is missing. */
const guardOff: Plugin = {
  name: 'single-selection-write-off',
  setup(builder) {
    builder.onLoad(
      { filter: /[\\/]util[\\/]selection-write\.ts$/ },
      async (args) => {
        const code = await readFile(args.path, 'utf8')
        const anchor =
          /export const VDITOR_SINGLE_SELECTION_WRITE(?:\s*:\s*boolean)?\s*=\s*true\b/
        if (!anchor.test(code))
          throw new Error(
            'VDITOR_SINGLE_SELECTION_WRITE = true not found in util/selection-write.ts',
          )
        return {
          contents: code.replace(anchor, (match) =>
            match.replace(/true$/, 'false'),
          ),
          loader: 'ts',
        }
      },
    )
  },
}

let offBundle: Promise<string> | undefined
function guardOffBundle(): Promise<string> {
  // The shared config is an ES module (it reads `import.meta`), so it is loaded dynamically; it is
  // plain JavaScript, whose inferred types are wider than esbuild's options.
  offBundle ??= import('../esbuild-shared.mjs').then(async (module) => {
    const shared = module.vditorSourceConfig as unknown as BuildOptions
    const result = await build({
      ...shared,
      plugins: [guardOff, ...(shared.plugins ?? [])],
      entryPoints: [path.join(__dirname, 'shortcut-negative-harness.ts')],
      bundle: true,
      format: 'iife',
      write: false,
      outdir: __dirname,
    })
    const script = result.outputFiles?.find((file) => file.path.endsWith('.js'))
    if (!script) throw new Error('no script in the guard-off bundle')
    return script.text
  })
  return offBundle
}

async function openEditor(page: Page, guard: Guard): Promise<void> {
  const init = {
    command: 'update',
    type: 'init',
    content: DOC,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: 'ir' },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.addInitScript((message) => {
    const win = window as any
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
    // VS Code's webview preload blocks the browser default of Ctrl+Z and Ctrl+Y (the workbench owns them).
    window.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if ([90, 89].includes(event.keyCode)) event.preventDefault()
    })
    // Counts `extractContents` on a Range that the Selection handed out (its live Range); a clone is
    // not counted. The V-3a path mutates only a clone.
    const live = new WeakSet<Range>()
    const getRangeAt = Selection.prototype.getRangeAt
    Selection.prototype.getRangeAt = function (index: number) {
      const range = getRangeAt.call(this, index)
      live.add(range)
      return range
    }
    const extract = Range.prototype.extractContents
    win.__liveExtracts = 0
    Range.prototype.extractContents = function () {
      if (live.has(this)) win.__liveExtracts++
      return extract.call(this)
    }
  }, init)
  if (guard === 'off') {
    const script = await guardOffBundle()
    const html = (
      await readFile(path.join(__dirname, 'shortcut-negative.html'), 'utf8')
    ).replace('/shortcut-negative.js', OFF_SCRIPT)
    await page.route(`**${OFF_PAGE}`, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    )
    await page.route(`**${OFF_SCRIPT}`, (route) =>
      route.fulfill({ contentType: 'text/javascript', body: script }),
    )
  }
  await page.goto(guard === 'on' ? '/shortcut-negative.html' : OFF_PAGE)
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
  await page.waitForTimeout(400)
  await page.evaluate(
    (commands) => (window as any).__installKeybindingShim(commands),
    HISTORY_COMMANDS,
  )
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

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++)
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

/** The caret as the text of its unit before it, plus whether the selection is collapsed. */
function caretInUnit(page: Page, selector: string) {
  return page.evaluate((unitSelector) => {
    const selection = getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const anchor = selection.anchorNode as Node
    const element = anchor instanceof Element ? anchor : anchor.parentElement
    const unit = element?.closest(unitSelector)
    if (!unit) return null
    const before = document.createRange()
    before.setStart(unit, 0)
    before.setEnd(anchor, selection.anchorOffset)
    return { collapsed: selection.isCollapsed, before: before.toString() }
  }, selector)
}

test.describe('IR Enter caret with VDITOR_SINGLE_SELECTION_WRITE on and off (012-16)', () => {
  test.describe.configure({ timeout: 120_000 })

  for (const guard of ['on', 'off'] as const) {
    test(`guard ${guard}: a code block Enter puts the caret at the start of the new line`, async ({
      page,
    }) => {
      await openEditor(page, guard)
      await caretIn(page, 'const echo = 1', 'const echo = 1'.length)
      await page.evaluate(() => {
        ;(window as any).__liveExtracts = 0
      })
      await page.keyboard.press('Enter')
      await settleFrames(page)
      const caret = await caretInUnit(page, CODE)
      expect(caret).toEqual({ collapsed: true, before: 'const echo = 1\n' })
      const liveExtracts = await page.evaluate(
        () => (window as any).__liveExtracts as number,
      )
      // V-3a: with the guard on the branch works on a clone; off, Vditor mutates the live Range.
      if (guard === 'on') expect(liveExtracts).toBe(0)
      else expect(liveExtracts).toBeGreaterThan(0)
      await page.keyboard.type('Z')
      await expect
        .poll(() => getValue(page))
        .toContain('const echo = 1\nZ\nconst foxtrot = 2')
    })

    test(`guard ${guard}: a table cell Enter puts the caret right after the inserted br`, async ({
      page,
    }) => {
      // Vditor puts the caret after the br; a VMDE rewrite one to two frames later moves it before the
      // br (D-13 design section 13.1). Task 012-21 fixes it and removes this annotation.
      test.fail(
        true,
        'B-1: pre-existing caret rewrite after a table cell Enter (F-4)',
      )
      await openEditor(page, guard)
      await caretIn(page, 'cellA', 3)
      await page.keyboard.press('Enter')
      // The caret the next key types into: after the frames that follow the key.
      await settleFrames(page)
      const position = await page.evaluate(() => {
        const selection = getSelection() as Selection
        const anchor = selection.anchorNode as Node
        const cell = (
          anchor instanceof Element ? anchor : anchor.parentElement
        )?.closest('td, th')
        const brs = cell ? Array.from(cell.querySelectorAll('br')) : []
        // The inserted br is the one followed by the rest of the cell text.
        const br = brs.find((node) => node.nextSibling?.textContent === 'lA')
        if (!br?.parentNode) return null
        return {
          collapsed: selection.isCollapsed,
          atBr:
            selection.anchorNode === br.parentNode &&
            selection.anchorOffset ===
              Array.from(br.parentNode.childNodes).indexOf(br) + 1,
        }
      })
      expect(position).toEqual({ collapsed: true, atBr: true })
      await page.keyboard.type('Q')
      const typed = await page.evaluate(() => {
        const cell = Array.from(document.querySelectorAll('td')).find((td) =>
          td.textContent?.startsWith('cel'),
        )
        const br = cell?.querySelector('br')
        return br?.nextSibling?.textContent ?? null
      })
      expect(typed?.startsWith('Q')).toBe(true)
    })

    // Each unit runs on a fresh page, so its edit is the first entry and its Undo caret is the caret the
    // first key found (a programmatic caret move between entries is no checkpoint).
    const UNITS = [
      { name: 'cell', selector: 'td', needle: 'cellB', offset: 2, key: 'W' },
      { name: 'item', selector: 'li', needle: 'item two', offset: 4, key: 'W' },
      {
        name: 'paragraph',
        selector: 'p',
        needle: 'Tail para.',
        offset: 4,
        key: 'W',
      },
      {
        name: 'code block',
        selector: CODE,
        needle: 'const foxtrot = 2',
        offset: 'const foxtrot = 2'.length,
        key: 'Enter',
      },
    ] as const
    for (const unit of UNITS) {
      test(`guard ${guard}: a ${unit.name} Undo and Redo put the caret where the edit began and ended`, async ({
        page,
      }) => {
        await openEditor(page, guard)
        const initial = await getValue(page)
        await caretIn(page, unit.needle, unit.offset)
        const start = await caretInUnit(page, unit.selector)
        expect(start?.collapsed).toBe(true)
        if (unit.key === 'Enter') await page.keyboard.press('Enter')
        else await page.keyboard.type(unit.key)
        await page.waitForTimeout(SETTLE_MS)
        const edited = await caretInUnit(page, unit.selector)
        expect(await getValue(page)).not.toBe(initial)
        await page.keyboard.press('Control+KeyZ')
        await page.waitForTimeout(SETTLE_MS)
        await settleFrames(page)
        expect(await getValue(page)).toBe(initial)
        expect(await caretInUnit(page, unit.selector), 'Undo caret').toEqual(
          start,
        )
        await page.keyboard.press('Control+KeyY')
        await page.waitForTimeout(SETTLE_MS)
        await settleFrames(page)
        expect(await caretInUnit(page, unit.selector), 'Redo caret').toEqual(
          edited,
        )
      })
    }
  }

  // The serialized Markdown after each Enter and one typed key is the unpatched path's (guard off).
  test('guard on and guard off give the same Markdown after a code block Enter and a table cell Enter', async ({
    context,
  }) => {
    const values: Record<Guard, string[]> = { on: [], off: [] }
    for (const guard of ['on', 'off'] as const) {
      const page = await context.newPage()
      await openEditor(page, guard)
      await caretIn(page, 'const echo = 1', 'const echo = 1'.length)
      await page.keyboard.press('Enter')
      await page.keyboard.type('Z')
      await caretIn(page, 'cellA', 3)
      await page.keyboard.press('Enter')
      await page.keyboard.type('Q')
      await page.waitForTimeout(SETTLE_MS)
      values[guard].push(await getValue(page))
      await page.close()
    }
    expect(values.on).toEqual(values.off)
  })
})
