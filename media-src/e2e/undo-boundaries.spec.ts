import { expect, test } from './coverage-fixture'

type Page = import('@playwright/test').Page

const value = (page: Page) =>
  page.evaluate(() => (window as any).__value() as string)
const undo = (page: Page) => page.evaluate(() => (window as any).__undo())

// These cases group edits on an established history: they wait out Vditor's first snapshot.
test.describe('settled history', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/undo-boundaries.html')
    await page.waitForFunction(() => (window as any).__ready === true)
    await page.waitForTimeout(900)
    await page.evaluate(() => (window as any).__focusEnd())
  })

  test('ordinary quick typing remains one undo group', async ({ page }) => {
    await page.keyboard.type('alpha')
    await page.waitForTimeout(100)
    await page.keyboard.type(' beta')
    await page.waitForTimeout(900)
    expect(await value(page)).toContain('alpha beta')
    await undo(page)
    expect((await value(page)).trim()).toBe('')
  })

  test('Enter is isolated from typing on both sides', async ({ page }) => {
    await page.keyboard.type('before')
    await page.keyboard.press('Enter')
    await page.keyboard.type('after')
    await page.waitForTimeout(900)
    expect(await value(page)).toContain('before\n\nafter')

    await undo(page)
    expect(await value(page)).not.toContain('after')
    await undo(page)
    expect((await value(page)).trim()).toBe('before')
    await undo(page)
    expect((await value(page)).trim()).toBe('')
  })

  test('paste is isolated from typing on both sides', async ({ page }) => {
    await page.keyboard.type('before')
    await page.waitForTimeout(100)
    await page.evaluate(() => (window as any).__paste(' PASTED '))
    await page.keyboard.type('after')
    await page.waitForTimeout(900)

    await undo(page)
    expect(await value(page)).toContain('before')
    expect(await value(page)).toContain('PASTED')
    expect(await value(page)).not.toContain('after')
    await undo(page)
    expect(await value(page)).toContain('before')
    expect(await value(page)).not.toContain('PASTED')
    await undo(page)
    expect((await value(page)).trim()).toBe('')
  })

  test('one undo after heading promotion returns to the literal marker', async ({
    page,
  }) => {
    await page.keyboard.type('# ')
    await page.waitForTimeout(100)
    expect(await page.locator('.vditor-ir h1').count()).toBe(1)
    await undo(page)
    expect((await value(page)).trim()).toBe('#')
    expect(await page.locator('.vditor-ir h1').count()).toBe(0)
    expect(
      await page.locator('.vditor-ir [data-block]').first().textContent(),
    ).toBe('# ')
  })

  test('a toolbar format command is isolated from surrounding typing', async ({
    page,
  }) => {
    await page.keyboard.type('word')
    expect(
      await page.evaluate(() => (window as any).__selectText('word')),
    ).toBe(true)
    await page.locator('.vditor-toolbar button[data-type="bold"]').click()
    await page.evaluate(() => (window as any).__focusEnd())
    await page.keyboard.type('tail')
    await page.waitForTimeout(900)

    await undo(page)
    expect((await value(page)).trim()).toBe('**word**')
    await undo(page)
    expect((await value(page)).trim()).toBe('word')
    await undo(page)
    expect((await value(page)).trim()).toBe('')
  })
})

// Task 598 — the first edit after opening is undoable. Each case opens a fresh editor with no
// initial wait, so Vditor's first snapshot (scheduled `undoDelay` after mount) is still pending:
// the active mode's stacks are naturally empty when the first action arrives. Nothing clears,
// seeds or delays the history to manufacture that window; a case whose window has closed fails
// as "race window missed", not as a behavior result. After an edit the checkpoint is polled, never
// pre-empted by Undo (Undo before a pending checkpoint is Task 601).
test.describe('first edit after opening (Task 598)', () => {
  type Mode = 'ir' | 'wysiwyg' | 'sv'
  type Stack = { undo: number; redo: number }

  const stack = (page: Page) =>
    page.evaluate(() => (window as any).__stack() as Stack)
  const stacks = (page: Page) =>
    page.evaluate(() => (window as any).__stacks() as Record<Mode, Stack>)
  const redo = (page: Page) => page.evaluate(() => (window as any).__redo())
  const seeds = (page: Page) =>
    page.evaluate(
      () =>
        (window as any).__seeds() as {
          result: boolean
          undo: number
          redo: number
          mode: Mode
        }[],
    )
  const inputs = (page: Page) =>
    page.evaluate(() => (window as any).__inputs() as string[])
  const selection = (page: Page) =>
    page.evaluate(
      () =>
        (window as any).__selection() as {
          anchor: number
          focus: number
          text: string
        } | null,
    )

  async function open(page: Page, mode: Mode, doc: 'empty' | 'para' | 'two') {
    await page.goto(`/undo-boundaries.html?mode=${mode}&doc=${doc}`)
    await page.waitForFunction(() => (window as any).__ready === true)
    const ready = await page.evaluate(() => ({
      mode: (window as any).__mode() as Mode,
      atReady: (window as any).__readyStacks as Record<Mode, Stack>,
      now: (window as any).__stack() as Stack,
      value: (window as any).__readyValue as string,
    }))
    expect(ready.mode).toBe(mode)
    // Precondition, not behavior: the first action must reach an empty history.
    expect(
      ready.atReady[mode].undo === 0 && ready.now.undo === 0,
      'race window missed: the first snapshot landed before the first action',
    ).toBe(true)
    return ready.value
  }

  // A real Chromium IME composition before 'bravo'; the returned function commits '日本'.
  async function compose(page: Page) {
    const cdp = await page.context().newCDPSession(page)
    await page.evaluate(() => (window as any).__place('bravo', 0))
    await cdp.send('Input.imeSetComposition', {
      text: '日',
      selectionStart: 1,
      selectionEnd: 1,
    })
    return () => cdp.send('Input.insertText', { text: '日本' })
  }

  // The checkpoint of the first edit: one seed plus one edit entry.
  async function expectCheckpoint(page: Page, depth = 2) {
    await expect
      .poll(async () => (await stack(page)).undo, { timeout: 3_000 })
      .toBe(depth)
  }

  // The first seed ran on an empty stack: the action arrived before the initial snapshot.
  async function expectSeededOnEmpty(page: Page, mode: Mode) {
    const first = (await seeds(page)).find((seed) => seed.result)
    expect(first).toEqual({ result: true, undo: 0, redo: 0, mode })
  }

  // Undo restores the exact pre-edit source; a second Undo is inert; Redo restores the edit.
  async function expectRoundTrip(page: Page, before: string, after: string) {
    expect(await value(page)).toBe(after)
    await undo(page)
    expect(await value(page)).toBe(before)
    expect(await stack(page)).toEqual({ undo: 1, redo: 1 })
    await undo(page)
    expect(await value(page)).toBe(before)
    expect(await stack(page)).toEqual({ undo: 1, redo: 1 })
    await redo(page)
    expect(await value(page)).toBe(after)
    expect(await stack(page)).toEqual({ undo: 2, redo: 0 })
  }

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: typing X first in an empty document is undone exactly`, async ({
      page,
    }) => {
      const before = await open(page, mode, 'empty')
      await page.keyboard.type('X')
      await expectCheckpoint(page)
      await expectSeededOnEmpty(page, mode)
      const after = await value(page)
      expect(after.trim()).toBe('X')
      // The first real edit still publishes (VMDE's input hook serializes by itself; the patched
      // IR and WYSIWYG paths pass no Markdown) after its timer replaced the render timer.
      expect((await inputs(page)).length).toBeGreaterThan(0)
      await expectRoundTrip(page, before, after)
    })

    test(`${mode}: typing into an existing paragraph first restores source and caret`, async ({
      page,
    }) => {
      const before = await open(page, mode, 'para')
      expect(
        await page.evaluate(() => (window as any).__place('bravo', 0)),
      ).toBe(true)
      await page.keyboard.type('X')
      await expectCheckpoint(page)
      await expectSeededOnEmpty(page, mode)
      await expectRoundTrip(page, before, before.replace('bravo', 'Xbravo'))
      await undo(page)
      expect(await value(page)).toBe(before)
      // The restored caret is editable and the next key lands where the first edit did.
      await page.keyboard.type('Y')
      expect(await value(page)).toBe(before.replace('bravo', 'Ybravo'))
    })
  }

  test('ir: replacing a backward selection first is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__selectText('bravo', true))
    await page.keyboard.type('X')
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    await expectRoundTrip(page, before, before.replace('bravo', 'X'))
  })

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a toolbar Bold click first is one undo step after the seed`, async ({
      page,
    }) => {
      const before = await open(page, mode, 'para')
      await page.evaluate(() => (window as any).__selectText('bravo'))
      await page.locator('.vditor-toolbar button[data-type="bold"]').click()
      await expectCheckpoint(page)
      await expectSeededOnEmpty(page, mode)
      const after = await value(page)
      expect(after).toBe(before.replace('bravo', '**bravo**'))
      expect(
        await page.evaluate(() => (window as any).__toolbarDisabled('undo')),
      ).toBe(false)
      await expectRoundTrip(page, before, after)
    })
  }

  // The post-Task 580 command route: `trigger-toolbar-hotkey` dispatches an untrusted click on the
  // toolbar button (bridge/message-router.ts), whatever key the command is bound to.
  test('ir: the formatting command route first is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => {
      ;(window as any).__selectText('bravo')
      document
        .querySelector('.vditor-toolbar button[data-type="bold"]')!
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    })
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    await expectRoundTrip(page, before, before.replace('bravo', '**bravo**'))
  })

  test('ir: paste first keeps its grouping and is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'empty')
    await page.evaluate(() => (window as any).__paste('PASTED'))
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    // No doubled checkpoint once the paste's own render timer has run.
    await page.waitForTimeout(1_100)
    expect((await stack(page)).undo).toBe(2)
    const after = await value(page)
    expect(after.trim()).toBe('PASTED')
    await expectRoundTrip(page, before, after)
  })

  // Input.insertText delivers trusted beforeinput/input with no keydown: only the beforeinput
  // capture can seed this edit.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a native insertion without a keydown first is undone exactly`, async ({
      page,
    }) => {
      const before = await open(page, mode, 'para')
      await page.evaluate(() => (window as any).__place('bravo', 0))
      await page.keyboard.insertText('Z')
      await expectCheckpoint(page)
      await expectSeededOnEmpty(page, mode)
      await expectRoundTrip(page, before, before.replace('bravo', 'Zbravo'))
    })
  }

  test('ir: Backspace first is undone exactly', async ({ page }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__place('bravo', 0))
    await page.keyboard.press('Backspace')
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    await expectRoundTrip(page, before, before.replace(' bravo', 'bravo'))
  })

  // Vditor's cut listener copies and runs execCommand("delete"), which emits no beforeinput.
  test('ir: cut first through Vditor’s cut route is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__selectText('bravo'))
    await page.evaluate(() => (window as any).__cut())
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    await expectRoundTrip(page, before, before.replace('bravo', ''))
  })

  // An external HTML drop runs Vditor's drop listener, which inserts through its paste route.
  test('ir: an external HTML drop first is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__place('bravo', 0))
    await page.evaluate(() => (window as any).__dropHtml('<b>DROP</b>'))
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    const after = await value(page)
    expect(after).not.toBe(before)
    expect(after).toContain('DROP')
    await expectRoundTrip(page, before, after)
  })

  // A real mouse drag of a selected word into the next paragraph. Vditor's internal-text drop
  // listener schedules its render before the browser deletes and inserts the text (deleteByDrag,
  // insertFromDrop); the capture `drop` seed runs before both.
  test('ir: an internal drag and drop first is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'two')
    await page.evaluate(() => (window as any).__selectText('bravo'))
    const box = await page.evaluate(() => {
      const word = getSelection()!.getRangeAt(0).getBoundingClientRect()
      const root = (window as any).vditor.vditor.ir.element as HTMLElement
      const text = root.querySelectorAll('p')[1].firstChild as Text
      const target = document.createRange()
      const at = (text.textContent ?? '').indexOf('echo')
      target.setStart(text, at)
      target.setEnd(text, at + 1)
      const rect = target.getBoundingClientRect()
      return {
        x: word.left + word.width / 2,
        y: word.top + word.height / 2,
        tx: rect.left + 1,
        ty: rect.top + rect.height / 2,
      }
    })
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    await page.mouse.move(box.tx, box.ty, { steps: 8 })
    await page.mouse.up()
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    const after = await value(page)
    expect(after).toBe(
      before.replace(' bravo', ' ').replace('echo', 'bravoecho'),
    )
    await expectRoundTrip(page, before, after)
  })

  for (const next of ['sv', 'wysiwyg'] as const) {
    test(`ir to ${next}: the newly visited mode seeds only its own history`, async ({
      page,
    }) => {
      await open(page, 'ir', 'para')
      // Let IR take its own first snapshot so its stale render timer cannot touch the new mode.
      await expect
        .poll(async () => (await stack(page)).undo, { timeout: 3_000 })
        .toBe(1)
      const published = (await inputs(page)).length
      await page.evaluate((mode) => (window as any).__switchMode(mode), next)
      const visited = await stacks(page)
      expect(visited[next]).toEqual({ undo: 0, redo: 0 })
      // Switching the view publishes no source.
      expect((await inputs(page)).length).toBe(published)
      const before = await value(page)
      await page.evaluate(() => (window as any).__place('bravo', 0))
      await page.keyboard.type('X')
      await expectCheckpoint(page)
      await expectSeededOnEmpty(page, next)
      expect((await stacks(page)).ir).toEqual(visited.ir)
      await expectRoundTrip(page, before, before.replace('bravo', 'Xbravo'))
    })
  }

  test('excluded paths take no seed: bare modifiers, Find input, composition, pointer', async ({
    page,
  }) => {
    await open(page, 'ir', 'para')
    for (const key of ['Shift', 'Control', 'Alt', 'Meta'])
      await page.keyboard.press(key)
    await page.locator('#find-input').focus()
    await page.keyboard.type('bra')
    await page.evaluate(() => (window as any).__place('bravo', 0))
    await page.mouse.click(5, 5)
    const commit = await compose(page)
    expect(
      await page.evaluate(() =>
        document.documentElement.hasAttribute('data-vmde-composing'),
      ),
    ).toBe(true)
    expect(await seeds(page)).toEqual([])
    expect((await stack(page)).undo).toBe(0)
    await commit()
    expect(await seeds(page)).toEqual([])
  })

  // An IME first edit is never seeded (ruling Q2) and its compositionend schedules the timer that
  // publishes it. A seed-eligible key in the same window must not cancel that publication.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a key after an IME first edit keeps the edit's publication`, async ({
      page,
    }) => {
      const before = await open(page, mode, 'para')
      await (await compose(page))()
      // IR and WYSIWYG publish from the pending timer; SV publishes during compositionend.
      expect((await inputs(page)).length).toBe(mode === 'sv' ? 1 : 0)
      expect((await stack(page)).undo).toBe(0)
      await page.keyboard.press('ArrowRight')
      await expect
        .poll(async () => (await inputs(page)).length, { timeout: 3_000 })
        .toBeGreaterThan(0)
      expect((await seeds(page)).every((seed) => !seed.result)).toBe(true)
      await expectCheckpoint(page, 1)
      expect(await value(page)).toBe(before.replace('bravo', '日本bravo'))
    })
  }

  // Navigation first: the seed cancels only the initial render timer, which publishes nothing.
  test('ir: an arrow key first seeds without publishing, and the next edit still does', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__place('bravo', 0))
    await page.keyboard.press('ArrowRight')
    await expectSeededOnEmpty(page, 'ir')
    await page.waitForTimeout(1_100)
    expect(await inputs(page)).toEqual([])
    expect(await page.evaluate(() => (window as any).__addCalls())).toBe(0)
    expect((await stack(page)).undo).toBe(1)
    await page.keyboard.type('X')
    await expectCheckpoint(page)
    expect((await inputs(page)).length).toBeGreaterThan(0)
    await expectRoundTrip(page, before, before.replace('bravo', 'bXravo'))
  })

  // The Vditor method itself (the build-time patch), driven directly in each mode.
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: the seed method takes one marker snapshot, cancels the render timer and publishes nothing`, async ({
      page,
    }) => {
      await open(page, mode, 'para')
      await page.evaluate(() => (window as any).__place('bravo', 2))
      const result = await page.evaluate(() => {
        const w = window as any
        const timer = w.__pendingTimer()
        const seeded = w.__seedDirect()
        const html = w.vditor.vditor[w.__mode()].element.innerHTML as string
        return {
          timer,
          seeded,
          again: w.__seedDirect(),
          stacks: w.__stacks(),
          lastTextMatches: w.__lastText().replace('<wbr>', '') === html,
          lastTextHasMarker: w.__lastText().includes('<wbr>'),
          markerInDom: w.__markerInDom(),
          undoDisabled: w.__toolbarDisabled('undo'),
          inputs: w.__inputs().length,
        }
      })
      expect(result.timer).toBeDefined()
      expect(result.seeded).toBe(true)
      expect(result.again).toBe(false)
      expect(result.stacks[mode]).toEqual({ undo: 1, redo: 0 })
      for (const other of (['ir', 'wysiwyg', 'sv'] as const).filter(
        (m) => m !== mode,
      ))
        expect(result.stacks[other]).toEqual({ undo: 0, redo: 0 })
      expect(result.lastTextMatches).toBe(true)
      expect(result.lastTextHasMarker).toBe(true)
      expect(result.markerInDom).toBe(false)
      // A seed is one internal snapshot, not an Undo step.
      expect(result.undoDisabled).toBe(true)
      expect(result.inputs).toBe(0)
      // The cancelled initial render timer never runs: no checkpoint call and no publication.
      await page.waitForTimeout(1_100)
      expect(await page.evaluate(() => (window as any).__addCalls())).toBe(0)
      expect(await inputs(page)).toEqual([])
      expect((await stack(page)).undo).toBe(1)
      // The next real edit still publishes and schedules its own checkpoint.
      await page.keyboard.type('Q')
      await expectCheckpoint(page)
      expect((await inputs(page)).length).toBeGreaterThan(0)
    })

    test(`${mode}: the seed method refuses a nonempty stack without touching the timer`, async ({
      page,
    }) => {
      await open(page, mode, 'para')
      const results = await page.evaluate(() => {
        const w = window as any
        w.__pushPlaceholder('redoStack')
        const redoOnly = w.__seedDirect()
        w.__pushPlaceholder('undoStack')
        const both = w.__seedDirect()
        return { redoOnly, both, stack: w.__stack() }
      })
      expect(results).toEqual({
        redoOnly: false,
        both: false,
        stack: { undo: 1, redo: 1 },
      })
      // The render timer was left pending: it still calls addToUndoStack.
      await expect
        .poll(() => page.evaluate(() => (window as any).__addCalls()), {
          timeout: 3_000,
        })
        .toBeGreaterThan(0)
    })
  }

  test('ir: the seed method refuses an undo-only stack', async ({ page }) => {
    await open(page, 'ir', 'para')
    expect(
      await page.evaluate(() => {
        const w = window as any
        w.__pushPlaceholder('undoStack')
        return w.__seedDirect()
      }),
    ).toBe(false)
  })

  test('ir: a seed keeps a backward selection’s endpoints and direction', async ({
    page,
  }) => {
    await open(page, 'ir', 'para')
    await page.evaluate(() => (window as any).__selectText('bravo', true))
    const before = await selection(page)
    expect(before).toEqual({ anchor: 11, focus: 6, text: 'bravo' })
    expect(await page.evaluate(() => (window as any).__seedDirect())).toBe(true)
    expect(await selection(page)).toEqual(before)
  })

  // Tasks 613/617 mechanism: the seed's marker insert and removal left a root-level Range in place
  // but shrank Chromium's internal selection, so the first Delete removed one character.
  test('ir: a whole-document Delete as the first key empties the document and is undone exactly', async ({
    page,
  }) => {
    const before = await open(page, 'ir', 'two')
    const selected = await page.evaluate(() => (window as any).__selectRoot())
    expect(selected).toBeGreaterThan(before.trim().length - 2)
    await page.keyboard.press('Delete')
    await expectCheckpoint(page)
    await expectSeededOnEmpty(page, 'ir')
    await expectRoundTrip(page, before, '\n')
  })

  test('ir: a seed keeps a root-level selection whole', async ({ page }) => {
    await open(page, 'ir', 'two')
    const selected = await page.evaluate(() => (window as any).__selectRoot())
    expect(await page.evaluate(() => (window as any).__seedDirect())).toBe(true)
    expect(await page.evaluate(() => (window as any).__selectedLength())).toBe(
      selected,
    )
    const textLength = await page.evaluate(
      () =>
        ((window as any).vditor.vditor.ir.element as HTMLElement).textContent!
          .length,
    )
    expect(await selection(page)).toMatchObject({
      anchor: 0,
      focus: textLength,
    })
  })

  // A seed during a held pointer selection neither collapses nor re-anchors the gesture.
  test('ir: a seed during a held selection drag leaves the gesture intact', async ({
    page,
  }) => {
    await open(page, 'ir', 'para')
    const points = await page.evaluate(() => {
      const root = (window as any).vditor.vditor.ir.element as HTMLElement
      const text = root.querySelector('p')!.firstChild as Text
      const at = (offset: number) => {
        const range = document.createRange()
        range.setStart(text, offset)
        range.setEnd(text, offset + 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.left + 1, y: rect.top + rect.height / 2 }
      }
      return { start: at(0), mid: at(8), end: at(15) }
    })
    await page.mouse.move(points.start.x, points.start.y)
    await page.mouse.down()
    await page.mouse.move(points.mid.x, points.mid.y, { steps: 4 })
    const held = await selection(page)
    expect(await page.evaluate(() => (window as any).__seedDirect())).toBe(true)
    expect(await selection(page)).toEqual(held)
    await page.mouse.move(points.end.x, points.end.y, { steps: 4 })
    await page.mouse.up()
    const released = await selection(page)
    expect(released?.anchor).toBe(held?.anchor)
    expect(released!.focus).toBeGreaterThan(held!.focus)
    expect((await stack(page)).undo).toBe(1)
  })
})

// Task 601 — Undo or Redo pressed while the latest edit's checkpoint is still pending. `real=1`
// adds the production path between an edit and the host (the IR prose spin deferred to the 220 ms
// settle, a 250 ms publication sink, the shared history wrapper) and a model of VS Code's native
// history, where each published edit is one undo group. `X` gets its own settled checkpoint first;
// `W` is typed and the history runs while its checkpoint is demonstrably pending: the edit is in
// the DOM, the stack has not grown, and less than `undoDelay` has passed since the key. A case
// whose window closed fails as "pending window missed", not as a behavior result.
test.describe('pending checkpoint (Task 601)', () => {
  type Mode = 'ir' | 'wysiwyg' | 'sv'
  type Stack = { undo: number; redo: number }
  type Entry = {
    sinceKey: number
    stack: Stack
    value: string
    host: string
    sinkPending: boolean
  }

  const stack = (page: Page) =>
    page.evaluate(() => (window as any).__stack() as Stack)
  const host = (page: Page) =>
    page.evaluate(() => (window as any).__host() as string)
  const history = (page: Page, kind: 'undo' | 'redo') =>
    page.evaluate((k) => (window as any).__history(k) as Entry, kind)
  const transitions = (page: Page) =>
    page.evaluate(
      () =>
        ((window as any).__posts() as { command: string }[]).filter(
          (post) => post.command === 'history-transition',
        ).length,
    )

  // Opens the small round-tripping document and settles `X` after `delta.` as its own step.
  async function settleX(page: Page, mode: Mode) {
    await page.goto(`/undo-boundaries.html?mode=${mode}&doc=delta&real=1`)
    await page.waitForFunction(() => (window as any).__ready === true)
    const ready = await page.evaluate(
      () => (window as any).__readyValue as string,
    )
    const withX = ready.replace('delta.', 'delta.X')
    const withXW = ready.replace('delta.', 'delta.XW')
    expect(
      await page.evaluate(() => (window as any).__place('delta.', 6)),
    ).toBe(true)
    await page.keyboard.type('X')
    await expect
      .poll(() => stack(page), { timeout: 3_000 })
      .toEqual({
        undo: 2,
        redo: 0,
      })
    await expect.poll(() => host(page), { timeout: 3_000 }).toBe(withX)
    await page.waitForTimeout(500)
    return { ready, withX, withXW }
  }

  // `W` arrived and its checkpoint had not landed when the history ran.
  function expectPending(entry: Entry, withXW: string) {
    expect(
      entry.value === withXW && entry.stack.undo === 2 && entry.sinceKey < 800,
      `pending window missed: ${JSON.stringify({ ...entry, value: undefined, host: undefined })}`,
    ).toBe(true)
  }

  async function expectRoundTrip(
    page: Page,
    withX: string,
    withXW: string,
    transitionsBefore: number,
  ) {
    expect(await page.evaluate(() => (window as any).__value())).toBe(withX)
    expect(await host(page)).toBe(withX)
    expect(await stack(page)).toEqual({ undo: 2, redo: 1 })
    expect(await transitions(page)).toBe(transitionsBefore + 1)
    const redoEntry = await history(page, 'redo')
    expect(redoEntry.value).toBe(withX)
    expect(await page.evaluate(() => (window as any).__value())).toBe(withXW)
    expect(await host(page)).toBe(withXW)
    expect(await stack(page)).toEqual({ undo: 3, redo: 0 })
    // Nothing late: no old timer resurrects a source, adds an entry or posts a transition.
    await page.waitForTimeout(1_300)
    expect(await page.evaluate(() => (window as any).__value())).toBe(withXW)
    expect(await host(page)).toBe(withXW)
    expect(await stack(page)).toEqual({ undo: 3, redo: 0 })
    expect(await transitions(page)).toBe(transitionsBefore + 2)
  }

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    for (const gap of [300, 700]) {
      test(`${mode}: Undo ${gap} ms after W removes only W, and Redo restores it`, async ({
        page,
      }) => {
        const { withX, withXW } = await settleX(page, mode)
        const before = await transitions(page)
        await page.keyboard.type('W')
        await page.waitForTimeout(gap)
        const entry = await history(page, 'undo')
        expectPending(entry, withXW)
        await expectRoundTrip(page, withX, withXW, before)
      })
    }
  }

  test('ir: Undo before the 220 ms prose settle runs the deferred spin, then the checkpoint', async ({
    page,
  }) => {
    const { withX, withXW } = await settleX(page, 'ir')
    const before = await transitions(page)
    await page.keyboard.type('W')
    await page.waitForTimeout(60)
    const entry = await history(page, 'undo')
    expectPending(entry, withXW)
    expect(entry.sinceKey).toBeLessThan(220)
    await expectRoundTrip(page, withX, withXW, before)
  })

  test('wysiwyg: a checkpoint that landed with its publication still queued posts the edit first', async ({
    page,
  }) => {
    const { withX, withXW } = await settleX(page, 'wysiwyg')
    const before = await transitions(page)
    await page.keyboard.type('W')
    await expect
      .poll(() => stack(page), { timeout: 3_000 })
      .toEqual({
        undo: 3,
        redo: 0,
      })
    const entry = await history(page, 'undo')
    // No checkpoint is pending any more, but the host has not received W yet.
    expect(entry.stack.undo).toBe(3)
    expect(entry.sinkPending).toBe(true)
    expect(entry.host).toBe(withX)
    expect(await page.evaluate(() => (window as any).__value())).toBe(withX)
    expect(await host(page)).toBe(withX)
    const posts = await page.evaluate(() => (window as any).__posts())
    const last = posts.slice(-2)
    expect(last.map((post: { command: string }) => post.command)).toEqual([
      'edit',
      'history-transition',
    ])
    expect(last[0].content).toBe(withXW)
    expect(await transitions(page)).toBe(before + 1)
  })

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: the toolbar Undo button undoes a pending first edit once`, async ({
      page,
    }) => {
      await page.goto(`/undo-boundaries.html?mode=${mode}&doc=delta&real=1`)
      await page.waitForFunction(() => (window as any).__ready === true)
      const ready = await page.evaluate(
        () => (window as any).__readyValue as string,
      )
      expect(
        await page.evaluate(() => (window as any).__place('delta.', 6)),
      ).toBe(true)
      await page.keyboard.type('W')
      await page.waitForTimeout(300)
      // Precondition: the seed is the only entry, so Vditor still shows Undo disabled.
      expect(await stack(page)).toEqual({ undo: 1, redo: 0 })
      expect(
        await page.evaluate(() => (window as any).__toolbarDisabled('undo')),
      ).toBe(true)
      await page.locator('.vditor-toolbar button[data-type="undo"]').click()
      expect(await page.evaluate(() => (window as any).__value())).toBe(ready)
      expect(await host(page)).toBe(ready)
      expect(await stack(page)).toEqual({ undo: 1, redo: 1 })
      expect(await transitions(page)).toBe(1)
      await page.locator('.vditor-toolbar button[data-type="redo"]').click()
      const withW = ready.replace('delta.', 'delta.W')
      expect(await page.evaluate(() => (window as any).__value())).toBe(withW)
      expect(await host(page)).toBe(withW)
      expect(await transitions(page)).toBe(2)
    })
  }

  test('ir: two quick Undos after a pending W remove W, then X; two Redos restore both', async ({
    page,
  }) => {
    const { ready, withXW } = await settleX(page, 'ir')
    await page.keyboard.type('W')
    await page.waitForTimeout(300)
    expectPending(await history(page, 'undo'), withXW)
    await history(page, 'undo')
    expect(await page.evaluate(() => (window as any).__value())).toBe(ready)
    expect(await host(page)).toBe(ready)
    await history(page, 'redo')
    await history(page, 'redo')
    expect(await page.evaluate(() => (window as any).__value())).toBe(withXW)
    expect(await host(page)).toBe(withXW)
    expect(await stack(page)).toEqual({ undo: 3, redo: 0 })
  })

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a settled Redo keeps its branch after caret moves and source-neutral typing`, async ({
      page,
    }) => {
      const { withX, withXW } = await settleX(page, mode)
      await page.keyboard.type('W')
      await page.waitForTimeout(1_300)
      expect(await stack(page)).toEqual({ undo: 3, redo: 0 })
      await history(page, 'undo')
      expect(await page.evaluate(() => (window as any).__value())).toBe(withX)
      await page.waitForTimeout(1_000)
      // Caret movement only, then typing that leaves the source as it was, both still pending.
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.type('Q')
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(300)
      const posts = await transitions(page)
      await history(page, 'redo')
      expect(await page.evaluate(() => (window as any).__value())).toBe(withXW)
      expect(await host(page)).toBe(withXW)
      expect(await transitions(page)).toBe(posts + 1)
    })
  }

  test('ir: a real edit after Undo retires the old Redo branch', async ({
    page,
  }) => {
    const { withX, withXW } = await settleX(page, 'ir')
    await page.keyboard.type('W')
    await page.waitForTimeout(300)
    expectPending(await history(page, 'undo'), withXW)
    await page.keyboard.type('Z')
    await page.waitForTimeout(300)
    const withXZ = withX.replace('delta.X', 'delta.XZ')
    const entry = await history(page, 'redo')
    expect(entry.value).toBe(withXZ)
    expect(await page.evaluate(() => (window as any).__value())).toBe(withXZ)
    expect(await host(page)).toBe(withXZ)
    expect(await stack(page)).toEqual({ undo: 3, redo: 0 })
  })

  // The handoff's composition rule: an Undo during IME composition is refused (no engine call, no
  // drain, no publication), and nothing replays after the composition commits.
  test('ir: Undo during an IME composition is refused; after the commit it undoes the commit', async ({
    page,
  }) => {
    const { withX } = await settleX(page, 'ir')
    const cdp = await page.context().newCDPSession(page)
    expect(
      await page.evaluate(() => (window as any).__place('delta.X', 7)),
    ).toBe(true)
    await cdp.send('Input.imeSetComposition', {
      text: '日',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.hasAttribute('data-vmde-composing'),
        ),
      )
      .toBe(true)
    const before = {
      value: await page.evaluate(() => (window as any).__value()),
      stack: await stack(page),
      transitions: await transitions(page),
      edits: (await page.evaluate(() => (window as any).__posts())).length,
    }
    await history(page, 'undo')
    expect({
      value: await page.evaluate(() => (window as any).__value()),
      stack: await stack(page),
      transitions: await transitions(page),
      edits: (await page.evaluate(() => (window as any).__posts())).length,
    }).toEqual(before)
    await cdp.send('Input.insertText', { text: '日本' })
    const withIme = withX.replace('delta.X', 'delta.X日本')
    await expect
      .poll(() => page.evaluate(() => (window as any).__value()))
      .toBe(withIme)
    await page.waitForTimeout(1_300)
    expect(await transitions(page)).toBe(before.transitions)
    await history(page, 'undo')
    expect(await page.evaluate(() => (window as any).__value())).toBe(withX)
    expect(await host(page)).toBe(withX)
  })
})
