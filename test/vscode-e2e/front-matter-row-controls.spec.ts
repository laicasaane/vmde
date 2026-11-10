// Task 728 — the front-matter row controls with REAL pointer input in the real VS Code webview.
// Every press, move and release goes through XTEST (xdotool on the verified VS Code X11 client), so
// the pointer passes every point a user's pointer passes; `locator.click()` jumps straight onto its
// target and hid the Task 725 defect (Task 728 reproduction). IR and WYSIWYG, from the ordinary state
// (caret in the body, no cell editor open), and once with a cell editor open:
//  - geometry: the drag handle is always visible inside the name column, 4 px from its left edge;
//    the remove button sits 4 px right of the value column, centred on its row, and stays visible
//    on every pixel of the way from the row to it and while the pointer is on it; "+ Add property"
//    sits 4 px under the table; folding hides all three (Task 724);
//  - Add writes `property_1: ""`, then `property_2: ""` (D1-D4) and opens the name selected; the
//    number never goes down in an editor session (Undo, reopen) and skips taken names; several
//    clicks in a row with the new name editor open add one row each (D5, D6); remove and a drag
//    reorder change only their own lines; each action is one Undo press that gives the exact bytes
//    back, also several presses in a row, and the table stays an editable table.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { parse as parseYaml } from 'yaml'
import { createXtestInput } from './helpers/xtest-input'
import { setConfig } from './preview-mode-helpers'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

type Evaluate = (fn: unknown, args: unknown) => Promise<unknown>
type Frame = ReturnType<typeof wf>
type Locator = ReturnType<Frame['locator']>
type Page = import('@playwright/test').Page
type ElectronApp = Parameters<typeof createXtestInput>[0]
type EditMode = 'ir' | 'wysiwyg'
type Point = { x: number; y: number }

const DOC = `---
# Document properties
title: "Hello"
author: 'Ann'
count: 3
tags:
  - a
  - b
---

# Heading

Paragraph below.
`

const SCOPE: Record<EditMode, string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
}

/** The layout contract (CSS px), each within 1 px. */
const HANDLE_INSET = 4 // handle left edge to the name column's left edge
const REMOVE_GAP = 4 // value column right edge to the remove button's left edge
const ADD_GAP = 4 // table bottom to the top of "+ Add property"

test.afterEach(async ({ evaluateInVSCode }) => {
  await setConfig(evaluateInVSCode as Evaluate, 'editor.defaultMode', undefined)
})

/** Real pointer input on the VS Code window; points are workbox page coordinates. */
async function realPointer(electronApp: ElectronApp, workbox: Page) {
  const xtest = await createXtestInput(electronApp, workbox)
  const nativeWindow = await electronApp.browserWindow(workbox)
  expect(await workbox.evaluate(() => window.devicePixelRatio)).toBe(1)
  const xdotool = (args: string[]) =>
    execFileSync('/usr/bin/xdotool', args, { timeout: 5000 })
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms))
  // No `--sync`: `mousemove --sync` never returns when the pointer already sits on the point.
  const move = async (point: Point) => {
    await xtest.activateAndFocus()
    const bounds = await nativeWindow.evaluate((win) => win.getContentBounds())
    xdotool([
      'mousemove',
      String(Math.round(bounds.x + point.x)),
      String(Math.round(bounds.y + point.y)),
    ])
  }
  return {
    move,
    async click(point: Point) {
      await move(point)
      await pause(60)
      xdotool(['mousedown', '1'])
      await pause(80)
      xdotool(['mouseup', '1'])
    },
    async drag(from: Point, to: Point, steps = 8) {
      await move(from)
      await pause(60)
      xdotool(['mousedown', '1'])
      for (let step = 1; step <= steps; step++) {
        await move({
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        })
        await pause(30)
      }
      xdotool(['mouseup', '1'])
    },
  }
}

type Pointer = Awaited<ReturnType<typeof realPointer>>

async function centre(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

class Table {
  constructor(
    readonly frame: Frame,
    readonly workbox: Page,
    readonly pointer: Pointer,
    readonly scope: string,
    readonly host: () => Promise<string>,
  ) {}

  row(index: number) {
    return this.frame.locator(`${this.scope} tr[data-vmde-fm-index="${index}"]`)
  }

  cell(index: number, kind: 'key' | 'value') {
    return this.row(index).locator(`> [data-vmde-fm-cell="${kind}"]`)
  }

  handle(index: number) {
    return this.row(index).locator('.vmde-front-matter__handle')
  }

  remove(index: number) {
    return this.row(index).locator('.vmde-front-matter__remove')
  }

  add() {
    return this.frame.locator(`${this.scope} .vmde-front-matter__add`)
  }

  editor() {
    return this.frame.locator(`${this.scope} .vmde-front-matter__editor`)
  }

  /** The ordinary state: a real click in the body paragraph, so the table (not the source) shows. */
  async show() {
    await this.pointer.click(
      await centre(
        this.frame
          .locator(`${this.scope} p`)
          .filter({ hasText: 'Paragraph below.' }),
      ),
    )
    await expect(
      this.frame.locator(
        `${this.scope} .vmde-front-matter[data-vmde-fm-editable]`,
      ),
    ).toBeVisible({ timeout: 15_000 })
    await expect(this.editor()).toHaveCount(0)
    // WYSIWYG: Vditor's block popover (shown while the caret was in the front matter, after an
    // Undo or Redo) hides only some 200 ms after the caret leaves; until then it covers the first
    // row's drag handle (measured: `elementFromPoint` returned its icon).
    await expect
      .poll(
        () =>
          this.frame.locator('body').evaluate((_body, scope) => {
            const handle = document.querySelector(
              `${scope} tr[data-vmde-fm-index="0"] .vmde-front-matter__handle`,
            )
            if (!handle) return false
            const box = handle.getBoundingClientRect()
            return (
              document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              ) === handle
            )
          }, this.scope),
        { message: 'nothing covers the first drag handle' },
      )
      .toBe(true)
  }

  async expectHost(text: string, message: string) {
    await expect.poll(this.host, { timeout: 20_000, message }).toBe(text)
  }

  /** The table is still an editable table (no YAML warning) with these names. */
  async expectTable(names: string[], label: string) {
    await expect
      .poll(
        () =>
          this.frame.locator('body').evaluate((_body, scope) => {
            const root = document.querySelector(`${scope} .vmde-front-matter`)
            return {
              editable: root?.hasAttribute('data-vmde-fm-editable') ?? false,
              warning: !!document.querySelector(
                `${scope} .vmde-front-matter__warning`,
              ),
              placeholders:
                root?.querySelectorAll('tr[data-vmde-fm-warning]').length ?? 0,
              names: [
                ...(root?.querySelectorAll('[data-vmde-fm-cell="key"]') ?? []),
              ].map((cell) => cell.getAttribute('data-vmde-fm-text')),
            }
          }, this.scope),
        { timeout: 15_000, message: `${label}: still a table` },
      )
      .toEqual({ editable: true, warning: false, placeholders: 0, names })
  }

  /** One Ctrl+Z gives `before` exactly, one Ctrl+Y gives `after` again; back to the body. */
  async undoRedo(before: string, after: string, label: string) {
    await this.workbox.keyboard.press('Control+z')
    await this.expectHost(before, `${label}: one Undo step`)
    await this.workbox.keyboard.press('Control+y')
    await this.expectHost(after, `${label}: one Redo step`)
    await this.show()
  }

  /** Computed visibility of an element: shown only with `visibility: visible` and opacity 1. */
  shown(locator: Locator) {
    return locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return style.visibility === 'visible' && Number(style.opacity) === 1
    })
  }

  /** The geometry of the controls of row `index` and of the Add button (CSS px). */
  geometry(index: number) {
    return this.frame.locator('body').evaluate(
      (_body, args) => {
        const root = document.querySelector(
          `${args.scope} .vmde-front-matter`,
        ) as HTMLElement
        const row = root.querySelector(
          `tr[data-vmde-fm-index="${args.index}"]`,
        ) as HTMLElement
        const box = (el: Element | Range | null) => {
          if (!el) throw new Error('missing control')
          const rect = el.getBoundingClientRect()
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
        }
        const key = row.querySelector('[data-vmde-fm-cell="key"]') as Element
        const name = document.createRange()
        name.selectNodeContents(
          key.querySelector('.vmde-front-matter__content') as Element,
        )
        return {
          row: box(row),
          key: box(key),
          value: box(row.querySelector('[data-vmde-fm-cell="value"]')),
          handle: box(row.querySelector('.vmde-front-matter__handle')),
          remove: box(row.querySelector('.vmde-front-matter__remove')),
          name: box(name),
          keyCopy: box(key.querySelector('.vmde-front-matter__copy')),
          table: box(root.querySelector('.vmde-front-matter__table')),
          add: box(root.querySelector('.vmde-front-matter__add')),
        }
      },
      { scope: this.scope, index },
    )
  }
}

async function openTable(
  evaluate: Evaluate,
  workbox: Page,
  electronApp: ElectronApp,
  file: string,
  mode: EditMode,
  content: string | null = DOC,
): Promise<Table> {
  if (content !== null) writeFileSync(file, content)
  await setConfig(evaluate, 'editor.defaultMode', mode)
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    { timeout: 60_000, message: `Task 728 ${mode} readiness` },
  )
  await waitForInitialUndoSnapshot(frame)
  const pointer = await realPointer(electronApp, workbox)
  const table = new Table(frame, workbox, pointer, SCOPE[mode], () =>
    docText(evaluate, file),
  )
  await table.show()
  return table
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: real-pointer layout of the drag handle, remove button and Add`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(300_000)
    const evaluate = evaluateInVSCode as Evaluate
    const file = path.join(
      baseDir,
      `front-matter-row-controls-layout-${mode}.md`,
    )
    const t = await openTable(evaluate, workbox, electronApp, file, mode)

    // The pointer is on the body paragraph: every drag handle shows, no remove button does.
    for (let index = 0; index < 4; index++) {
      expect(await t.shown(t.handle(index)), `handle ${index} shows`).toBe(true)
      expect(await t.shown(t.remove(index)), `remove ${index} hidden`).toBe(
        false,
      )
    }
    const g = await t.geometry(1)
    // Handle inside the name column at its left edge; the name text starts after it.
    expect(
      Math.abs(g.handle.left - g.key.left - HANDLE_INSET),
    ).toBeLessThanOrEqual(1)
    expect(g.handle.right).toBeLessThanOrEqual(g.name.left)
    expect(g.name.right).toBeLessThanOrEqual(g.keyCopy.left)
    expect(g.keyCopy.right).toBeLessThanOrEqual(g.key.right)
    expect(g.handle.top).toBeGreaterThanOrEqual(g.row.top)
    expect(g.handle.bottom).toBeLessThanOrEqual(g.row.bottom)
    // Remove just outside the value column, centred on its row.
    expect(
      Math.abs(g.remove.left - g.value.right - REMOVE_GAP),
    ).toBeLessThanOrEqual(1)
    expect(
      Math.abs(
        (g.remove.top + g.remove.bottom) / 2 - (g.row.top + g.row.bottom) / 2,
      ),
    ).toBeLessThanOrEqual(1)
    // "+ Add property" close under the table.
    expect(Math.abs(g.add.top - g.table.bottom - ADD_GAP)).toBeLessThanOrEqual(
      1,
    )

    // The pointer travels right from inside the row to the remove button, one pixel at a time:
    // the button shows at every point, and while the pointer is on it.
    const y = (g.remove.top + g.remove.bottom) / 2
    const frameBox = await t.frame.locator('html').boundingBox()
    if (!frameBox) throw new Error('webview frame box')
    const hidden: number[] = []
    for (
      let x = g.value.right - 12;
      x <= (g.remove.left + g.remove.right) / 2;
      x++
    ) {
      await t.pointer.move({ x: frameBox.x + x, y: frameBox.y + y })
      if (!(await t.shown(t.remove(1)))) hidden.push(x)
    }
    expect(hidden, 'remove hidden on the way from the row').toEqual([])
    await settle(t.frame, 300)
    expect(await t.shown(t.remove(1)), 'remove with the pointer on it').toBe(
      true,
    )

    // Over the button's own region, reached from outside the table (not through the row).
    await t.pointer.move({
      x: frameBox.x + g.remove.right + 30,
      y: frameBox.y + g.table.bottom + 40,
    })
    await settle(t.frame, 200)
    expect(await t.shown(t.remove(1)), 'remove hidden away from it').toBe(false)
    await t.pointer.move({
      x: frameBox.x + (g.remove.left + g.remove.right) / 2,
      y: frameBox.y + y,
    })
    await settle(t.frame, 200)
    expect(await t.shown(t.remove(1)), 'remove over its own region').toBe(true)

    // Keyboard focus shows it too.
    await t.pointer.move(
      await centre(
        t.frame.locator(`${t.scope} p`).filter({ hasText: 'Paragraph below.' }),
      ),
    )
    await t.remove(2).evaluate((el: HTMLElement) => el.focus())
    expect(await t.shown(t.remove(2)), 'remove with keyboard focus').toBe(true)
    await t.show()

    // Folded (Task 724): the handle, the remove button and Add hide with the table.
    const fold = t.frame.locator(`${t.scope} .vmde-front-matter__fold`)
    await t.pointer.click(await centre(fold))
    await expect(
      t.frame.locator(`${t.scope} .vmde-front-matter[data-vmde-fm-folded]`),
    ).toHaveCount(1)
    await expect(t.handle(0)).toBeHidden()
    await expect(t.remove(0)).toBeHidden()
    await expect(t.add()).toBeHidden()
    await t.pointer.click(await centre(fold))
    await expect(t.add()).toBeVisible()
    expect(await t.host()).toBe(DOC)
  })

  test(`${mode}: real-pointer Add, remove and drag reorder; one Undo step each; exact saved bytes`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(300_000)
    const evaluate = evaluateInVSCode as Evaluate
    const file = path.join(baseDir, `front-matter-row-controls-${mode}.md`)
    const t = await openTable(evaluate, workbox, electronApp, file, mode)

    // Add, Undo, Add: the number does not go down; the new name opens selected.
    const a1 = DOC.replace('  - b\n', '  - b\nproperty_1: ""\n')
    await t.pointer.click(await centre(t.add()))
    await t.expectHost(a1, 'Add 1')
    await expect(
      t.cell(4, 'key').locator('.vmde-front-matter__editor'),
    ).toBeFocused()
    expect(
      await t
        .editor()
        .evaluate((input: HTMLInputElement) => [
          input.value,
          input.selectionStart,
          input.selectionEnd,
        ]),
    ).toEqual(['property_1', 0, 'property_1'.length])
    await t.show()
    await workbox.keyboard.press('Control+z')
    await t.expectHost(DOC, 'Add 1: one Undo step')
    await t.show()
    const u1 = DOC.replace('  - b\n', '  - b\nproperty_2: ""\n')
    await t.pointer.click(await centre(t.add()))
    await t.expectHost(u1, 'Add after Undo takes the next number')
    await t.show()
    await t.undoRedo(DOC, u1, 'Add 2')
    const a2 = u1.replace(
      'property_2: ""\n',
      'property_2: ""\nproperty_3: ""\n',
    )
    await t.pointer.click(await centre(t.add()))
    await t.expectHost(a2, 'Add 2')
    await t.show()
    await t.expectTable(
      ['title', 'author', 'count', 'tags', 'property_2', 'property_3'],
      'Add',
    )

    // Remove `count`: the pointer moves from the row to its button like a user's does.
    const r1 = a2.replace('count: 3\n', '')
    const removeAt = await centre(t.remove(2))
    const rowAt = await centre(t.row(2))
    for (let x = rowAt.x; x < removeAt.x; x += 2)
      await t.pointer.move({ x, y: removeAt.y })
    await t.pointer.click(removeAt)
    await t.expectHost(r1, 'remove')
    await t.expectTable(
      ['title', 'author', 'tags', 'property_2', 'property_3'],
      'remove',
    )
    await t.undoRedo(a2, r1, 'remove')

    // Drag `title` (row 0) below `tags` (row 2) by its always-visible handle.
    const d1 = r1
      .replace('title: "Hello"\n', '')
      .replace('  - b\n', '  - b\ntitle: "Hello"\n')
    const target = await t.row(2).boundingBox()
    if (!target) throw new Error('drag target')
    const from = await centre(t.handle(0))
    await t.pointer.drag(from, {
      x: from.x,
      y: target.y + target.height * 0.75,
    })
    await t.expectHost(d1, 'drag')
    await t.expectTable(
      ['author', 'tags', 'title', 'property_2', 'property_3'],
      'drag',
    )
    await t.undoRedo(r1, d1, 'drag')

    // A cell editor open with typed text: a real click on another row's remove commits the text
    // first (its own Undo step, Task 725 D13), then removes the row.
    const value = t.cell(0, 'value')
    const box = await value.boundingBox()
    if (!box) throw new Error('value cell')
    await t.pointer.click({ x: box.x + 6, y: box.y + 8 })
    await expect(value.locator('.vmde-front-matter__editor')).toBeFocused()
    await workbox.keyboard.type('Bea')
    const c1 = d1.replace("author: 'Ann'", "author: 'Bea'")
    const c2 = c1.replace('property_2: ""\n', '')
    await t.pointer.move(await centre(t.row(3)))
    await t.pointer.click(await centre(t.remove(3)))
    await t.expectHost(c2, 'commit, then remove')
    await t.show()
    await t.expectTable(
      ['author', 'tags', 'title', 'property_3'],
      'commit+remove',
    )
    await t.undoRedo(c1, c2, 'remove after commit')
    // Two Undo presses in a row, no click between: the remove, then the commit.
    await workbox.keyboard.press('Control+z')
    await t.expectHost(c1, 'first Undo press: the remove')
    await workbox.keyboard.press('Control+z')
    await t.expectHost(d1, 'second Undo press: the commit')
    await workbox.keyboard.press('Control+y')
    await t.expectHost(c1, 'first Redo press')
    await workbox.keyboard.press('Control+y')
    await t.expectHost(c2, 'second Redo press')
    await t.show()

    await evaluate(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    }, [])
    await expect
      .poll(() => readFileSync(file, 'utf8'), {
        timeout: 20_000,
        message: 'saved bytes',
      })
      .toBe(c2)
    expect(c2).toBe(`---
# Document properties
author: 'Bea'
tags:
  - a
  - b
title: "Hello"
property_3: ""
---

# Heading

Paragraph below.
`)
  })
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: three quick real-pointer Adds with the name editor open; Undo presses in a row`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(300_000)
    const evaluate = evaluateInVSCode as Evaluate
    const file = path.join(baseDir, `front-matter-row-controls-adds-${mode}.md`)
    const t = await openTable(evaluate, workbox, electronApp, file, mode)
    const rows = t.frame.locator(`${t.scope} tr[data-vmde-fm-index]`)
    const added = (count: number) =>
      DOC.replace(
        '  - b\n',
        `  - b\n${[1, 2, 3]
          .slice(0, count)
          .map((n) => `property_${n}: ""\n`)
          .join('')}`,
      )

    // D5, D6: three clicks on Add, each at the button's current place, no other input between;
    // the previous Add's name editor is open (unchanged) at every click.
    for (let click = 1; click <= 3; click++) {
      await t.pointer.click(await centre(t.add()))
      await expect(rows).toHaveCount(4 + click)
      await expect(
        t.cell(3 + click, 'key').locator('.vmde-front-matter__editor'),
      ).toBeFocused()
    }
    await t.expectHost(added(3), 'three Adds')
    await t.expectTable(
      [
        'title',
        'author',
        'count',
        'tags',
        'property_1',
        'property_2',
        'property_3',
      ],
      'three Adds',
    )
    await evaluate(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    }, [])
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 })
      .toBe(added(3))
    expect(Object.keys(parseYaml(added(3).split('---')[1]))).toEqual([
      'title',
      'author',
      'count',
      'tags',
      'property_1',
      'property_2',
      'property_3',
    ])

    // Three Undo presses in a row (Esc first: Ctrl+Z in an open cell editor is not a document
    // Undo, Task 725 D12), then three Redo presses with a click in the body between.
    await workbox.keyboard.press('Escape')
    for (const count of [2, 1, 0]) {
      await workbox.keyboard.press('Control+z')
      await t.expectHost(added(count), `Undo press to ${count} added rows`)
    }
    for (const count of [1, 2, 3]) {
      await t.show()
      await workbox.keyboard.press('Control+y')
      await t.expectHost(added(count), `Redo press to ${count} added rows`)
    }
    for (const count of [2, 1, 0]) {
      await t.show()
      await workbox.keyboard.press('Control+z')
      await t.expectHost(
        added(count),
        `Undo after a click, to ${count} added rows`,
      )
    }

    // Add, type a name, click Add again: the name commits as its own step, then one Add; the
    // number continues after the three earlier Adds.
    await t.show()
    await t.pointer.click(await centre(t.add()))
    await expect(
      t.cell(4, 'key').locator('.vmde-front-matter__editor'),
    ).toBeFocused()
    await workbox.keyboard.type('named')
    await t.pointer.click(await centre(t.add()))
    const named = DOC.replace('  - b\n', '  - b\nnamed: ""\nproperty_5: ""\n')
    await t.expectHost(named, 'rename, then Add')
    await workbox.keyboard.press('Escape')
    await workbox.keyboard.press('Control+z')
    await t.expectHost(
      DOC.replace('  - b\n', '  - b\nnamed: ""\n'),
      'Undo the second Add',
    )
    await workbox.keyboard.press('Control+z')
    await t.expectHost(
      DOC.replace('  - b\n', '  - b\nproperty_4: ""\n'),
      'Undo the rename',
    )
    await workbox.keyboard.press('Control+z')
    await t.expectHost(DOC, 'Undo the first Add')
  })

  test(`${mode}: Add numbers from the document per editor session; empty-key rows and a one-property file`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(300_000)
    const evaluate = evaluateInVSCode as Evaluate
    const file = path.join(baseDir, `front-matter-row-controls-seed-${mode}.md`)
    const seeded = DOC.replace(
      '  - b\n',
      '  - b\nproperty_1: x\nproperty_5: y\n: ""\n',
    )
    let t = await openTable(evaluate, workbox, electronApp, file, mode, seeded)
    const emptyRows = () =>
      t.frame.locator(`${t.scope} tr[data-vmde-fm-warning="empty"]`).count()
    // Task 725 D1: an existing `: ""` line still shows as an editable placeholder row.
    expect(await emptyRows()).toBe(1)
    await t.pointer.click(await centre(t.add()))
    const s1 = seeded.replace(': ""\n', ': ""\nproperty_6: ""\n')
    await t.expectHost(s1, 'first Add after the largest existing number')
    await t.show()
    expect(await emptyRows()).toBe(1)
    // Save, close and reopen the editor: a new session starts after the largest existing number.
    await evaluate(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    }, [])
    await expect
      .poll(() => readFileSync(file, 'utf8'), { timeout: 20_000 })
      .toBe(s1)
    t = await openTable(evaluate, workbox, electronApp, file, mode, null)
    await t.pointer.click(await centre(t.add()))
    const s2 = s1.replace(
      'property_6: ""\n',
      'property_6: ""\nproperty_7: ""\n',
    )
    await t.expectHost(s2, 'Add after reopening')
    await t.show()
    await workbox.keyboard.press('Control+z')
    await t.expectHost(s1, 'one Undo step')
    await t.show()

    // A front matter with one property.
    const single = `---
title: x
---

Paragraph below.
`
    const one = path.join(baseDir, `front-matter-row-controls-one-${mode}.md`)
    t = await openTable(evaluate, workbox, electronApp, one, mode, single)
    await t.pointer.click(await centre(t.add()))
    const o1 = single.replace('title: x\n', 'title: x\nproperty_1: ""\n')
    await t.expectHost(o1, 'Add to a one-property front matter')
    await t.show()
    await t.expectTable(['title', 'property_1'], 'one property + Add')
    expect(parseYaml(o1.split('---')[1])).toEqual({
      title: 'x',
      property_1: '',
    })
    await workbox.keyboard.press('Control+z')
    await t.expectHost(single, 'one Undo step')
  })
}
