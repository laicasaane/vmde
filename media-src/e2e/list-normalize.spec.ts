import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

/**
 * Task 255 — "Fix list numbering" (caret-scoped) / "Renormalize all lists" (whole doc). Exercises
 * the real DOM-mutating half of list-normalize.ts (execAfterRender / undo / caret restore) against
 * a real Vditor+Lute instance — the part list-normalize.test.ts's header documents as not
 * unit-testable (needs a working Lute + near-complete IVditor). test/vscode-e2e/list-normalize.spec.ts
 * covers the host-command → postMessage wiring on top of this; here the two functions are called
 * directly (same as message-router.ts's handlers do), so a wiring bug wouldn't fail here.
 *
 * Staleness is injected via `__removeListItem` (a raw `<li>.remove()`, no Lute spin), NOT by
 * loading source with wrong numbers — Vditor's own initial parse already renumbers on load (Lute
 * normalizes on spin, including the first render), so a merely-mis-numbered fixture would already
 * read back correct by the time a spec could observe it. A raw removal reproduces the real bug
 * (task 65 #9 — "IR editing doesn't renumber": deleting an item leaves the survivors' `data-marker`
 * stale) without faking a whole drag/Backspace gesture.
 */
async function gotoList(
  page: Page,
  list: 'stale' | 'staleAll' | 'svStale',
  auto = false,
  mode: 'ir' | 'wysiwyg' | 'sv' = 'ir',
) {
  await page.goto(
    `/list.html?list=${list}${auto ? '&auto=1' : ''}&mode=${mode}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
}

const getValue = (page: Page) =>
  page.evaluate(
    () => (window as any).vditor.getValue() as string,
  ) as Promise<string>

function removeListItem(page: Page, needle: string) {
  return page.evaluate(
    (needle) => (window as any).__removeListItem(needle),
    needle,
  )
}

function selectListItem(page: Page, needle: string, contents = false) {
  return page.evaluate(
    ({ target, contents }) => {
      const outer = (window as any).vditor
      const editor = outer.vditor[outer.getCurrentMode()].element as HTMLElement
      const item = Array.from(editor.querySelectorAll<HTMLElement>('li')).find(
        (candidate) => candidate.textContent?.includes(target),
      )
      if (!item) throw new Error(`list item ${target} not found`)
      const range = document.createRange()
      if (contents) range.selectNodeContents(item)
      else range.selectNode(item)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
    },
    { target: needle, contents },
  )
}

// Collapse the caret into the first text node of the element (anywhere under the active editor, not
// just an <li> — the "outside a list" test needs a plain paragraph) whose OWN text starts with
// `needle`, at `offset` characters in.
async function caretAt(page: Page, needle: string, offset = 0) {
  await page.evaluate(
    ({ needle, offset }) => {
      const outer = (window as any).vditor
      const root = outer.vditor[outer.getCurrentMode()].element as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let text: Text | undefined
      let n: Node | null
      // biome-ignore lint/suspicious/noAssignInExpressions: TreeWalker's own idiom
      while ((n = walker.nextNode())) {
        const match = n.textContent?.indexOf(needle) ?? -1
        if (match >= 0) {
          text = n as Text
          offset += match
          break
        }
      }
      if (!text) throw new Error(`${needle} not found`)
      const r = document.createRange()
      r.setStart(text, Math.min(offset, text.length))
      r.collapse(true)
      const s = getSelection()
      s?.removeAllRanges()
      s?.addRange(r)
      text.parentElement?.focus()
    },
    { needle, offset },
  )
}

function fixListNumbering(page: Page) {
  return page.evaluate(() => (window as any).__fixListNumbering() as boolean)
}

function renormalizeAllLists(page: Page) {
  return page.evaluate(() => (window as any).__renormalizeAllLists() as number)
}

// Vditor's own undo push is DEBOUNCED (vditor.options.undoDelay, default 800ms —
// ir/process.ts's processAfterRender schedules `undo.addToUndoStack` on a `setTimeout` it
// clears/reschedules on every subsequent call, same as normal typing coalesces into one undo
// entry). A test that wants an ISOLATED undo entry for one action must wait it out before doing
// anything else, or a following action cancels the pending snapshot and merges the two.
const UNDO_DEBOUNCE_MS = 900

// Call Vditor's own undo engine directly — `vditor.undo.undo(vditor)`, the exact call
// undo-keybind.ts's runVditorHistory makes for a real Ctrl/Cmd+Z. Bypasses this bare harness's
// keyboard-hotkey routing (unlike the production webview, it isn't wired through our own capture-
// phase listener) so the assertion is about the undo STACK CONTENTS (list-normalize.ts's actual
// contract), not about hotkey plumbing this module doesn't own.
function undoOnce(page: Page) {
  return page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
}

test.describe('Fix list numbering — caret-scoped (task 255)', () => {
  test('renumbers a stale top-level list, including a stale nested sublist', async ({
    page,
  }) => {
    await gotoList(page, 'stale')
    // Deleting "beta" and "nested-x" directly (no Lute spin) leaves the survivors' data-marker
    // stale: alpha=1, gamma=3 (was 3, should now be 2), delta=4 (should be 3); nested: nested-y=2
    // (should be 1).
    await removeListItem(page, 'beta')
    await removeListItem(page, 'nested-x')
    const stale = await getValue(page)
    expect(stale, 'sanity: removal alone leaves stale numbering').toMatch(
      /3\.\s+gamma/,
    )

    await caretAt(page, 'gamma', 2)
    const handled = await fixListNumbering(page)
    expect(handled).toBe(true)

    const after = await getValue(page)
    expect(after).toMatch(/1\.\s+alpha/)
    expect(after).toMatch(/2\.\s+gamma/)
    expect(after).toMatch(/3\.\s+delta/)
    expect(after).toMatch(/1\.\s+nested-y/)
    expect(after).not.toContain('beta')
  })

  test('is a no-op outside any list (returns false, document unchanged)', async ({
    page,
  }) => {
    await gotoList(page, 'staleAll')
    const before = await getValue(page)
    await caretAt(page, 'plain paragraph', 3)

    const handled = await fixListNumbering(page)
    expect(handled).toBe(false)
    expect(await getValue(page)).toBe(before)
  })

  test('keeps the caret in the fixed item (setRangeByWbr survives the outerHTML swap)', async ({
    page,
  }) => {
    await gotoList(page, 'stale')
    await removeListItem(page, 'beta')
    await caretAt(page, 'gamma', 2) // caret between "ga" and "mma"

    await fixListNumbering(page)

    // Typing now must land INSIDE "gamma" (at the same offset), not at document start/end —
    // the only way to observe where a live DOM caret actually is without relying on the host's
    // own undo/hotkey plumbing.
    await page.keyboard.type('X', { delay: 20 })
    expect(await getValue(page)).toMatch(/gaXmma/)
  })

  test('one undo step reverts the whole fix (nested renumbering included)', async ({
    page,
  }) => {
    await gotoList(page, 'stale')
    await removeListItem(page, 'beta')
    await removeListItem(page, 'nested-x')
    const before = await getValue(page)
    await page.waitForTimeout(UNDO_DEBOUNCE_MS) // let the removals' own pending snapshot settle

    await caretAt(page, 'gamma', 2)
    await fixListNumbering(page)
    const after = await getValue(page)
    expect(after).not.toBe(before)
    await page.waitForTimeout(UNDO_DEBOUNCE_MS) // let the fix's snapshot settle before undoing

    await undoOnce(page)
    expect(await getValue(page)).toBe(before)
  })
})

test.describe('Renormalize all lists — whole document (task 255)', () => {
  test('renumbers every stale top-level list and leaves everything else byte-identical', async ({
    page,
  }) => {
    await gotoList(page, 'staleAll')
    await removeListItem(page, 'first')
    const before = await getValue(page)
    expect(before, 'sanity: removal leaves stale numbering').toMatch(
      /3\.\s+third/,
    )

    const count = await renormalizeAllLists(page)
    // Only the second root is stale after removing `first`; the already-canonical alpha/beta root
    // is deliberately skipped by Task 284's idempotent normalization authority.
    expect(count).toBe(1)

    const after = await getValue(page)
    expect(after).toMatch(/1\.\s+alpha/)
    expect(after).toMatch(/2\.\s+beta/)
    expect(after).toMatch(/1\.\s+second/)
    expect(after).toMatch(/2\.\s+third/)
    // The heading and the plain paragraph between the two lists are untouched.
    expect(after).toContain('## Notes')
    expect(after).toContain(
      'A plain paragraph that must stay untouched by the whole-document command.',
    )
    // Nothing OTHER than the two lists' numbering changed (normalize every digit-marker to "N"
    // on both sides, then diff — isolates "did anything besides the numbers move").
    const numbersErased = (s: string) => s.replace(/^(\s*)\d+([.)])/gm, '$1N$2')
    expect(numbersErased(after)).toBe(numbersErased(before))
  })

  test('is a no-op on a document with no lists at all (returns 0, nothing to undo)', async ({
    page,
  }) => {
    await page.goto('/list.html?list=ops')
    await page.waitForFunction(() => (window as any).__ready === true)
    // "ops" fixture has task/bullet lists — swap to a listless doc via setValue directly.
    await page.evaluate(() => {
      ;(window as any).vditor.setValue('Just a paragraph, no lists here.\n')
    })
    const before = await getValue(page)

    const count = await renormalizeAllLists(page)
    expect(count).toBe(0)
    expect(await getValue(page)).toBe(before)
  })

  test('one undo step for the whole batch, regardless of how many lists changed', async ({
    page,
  }) => {
    await gotoList(page, 'staleAll')
    await removeListItem(page, 'first')
    // Vditor's own undo restore (renderDiff) falls back to `getSelection().getRangeAt(0)` when
    // the just-restored HTML has no `<wbr>` — which throws if NOTHING is selected at all (an
    // artificial-test-only state; a real session always has a live caret). Give it one, same as
    // the caret-scoped test above, even though renormalizeAllLists's own no-caret path is what's
    // under test.
    await caretAt(page, 'alpha')
    const before = await getValue(page)
    await page.waitForTimeout(UNDO_DEBOUNCE_MS)

    await renormalizeAllLists(page)
    expect(await getValue(page)).not.toBe(before)
    await page.waitForTimeout(UNDO_DEBOUNCE_MS)

    await undoOnce(page)
    expect(await getValue(page)).toBe(before)
  })
})

test.describe('Source-mode explicit list normalization — task 495', () => {
  test('renumbers the containing source root, preserves surrounding bytes, and keeps the restored caret editable', async ({
    page,
  }) => {
    await gotoList(page, 'svStale', false, 'sv')
    const before = await getValue(page)
    await caretAt(page, 'nested stale', 3)

    expect(await fixListNumbering(page)).toBe(true)
    const after = await getValue(page)
    expect(after).toContain(
      '3. alpha\n4. beta\n   4. nested\n   5. nested stale\n5. gamma',
    )
    expect(after.replace(/^\s*\d+[.)]/gmu, 'N')).toBe(
      before.replace(/^\s*\d+[.)]/gmu, 'N'),
    )
    await page.keyboard.type('X')
    expect(await getValue(page)).toContain('nesXted stale')
  })

  test('renormalizes every source root from a prose caret and makes the next invocation a no-op', async ({
    page,
  }) => {
    await gotoList(page, 'svStale', false, 'sv')
    await caretAt(page, 'before', 2)

    expect(await renormalizeAllLists(page)).toBe(1)
    const after = await getValue(page)
    expect(after).toContain(
      '3. alpha\n4. beta\n   4. nested\n   5. nested stale\n5. gamma',
    )
    expect(await renormalizeAllLists(page)).toBe(0)
    expect(await getValue(page)).toBe(after)
  })

  test('batches two stale source roots and declines a stale retained selection', async ({ page }) => {
    await gotoList(page, 'svAll', false, 'sv')
    await page.evaluate(() => {
      ;(window as any).__setSourceRaw('3. first\n9. stale first\n\nprose\n\n4) second\n9) stale second\n')
    })
    await caretAt(page, 'prose', 2)
    expect(await renormalizeAllLists(page)).toBe(2)
    expect(await getValue(page)).toContain('3. first\n4. stale first\n\nprose\n\n4) second\n5) stale second')

    await gotoList(page, 'svStale', false, 'sv')
    await caretAt(page, 'nested stale', 2)
    expect(await page.evaluate(() => (window as any).__staleSourceListCommand())).toBe(false)
  })
})

test.describe('Auto-renumber structural edits — task 284', () => {
  test('IR native pointer drag moves and renumbers a selected ordered item', async ({
    page,
  }) => {
    await gotoList(page, 'staleAll', true, 'ir')
    await selectListItem(page, 'alpha', true)
    const source = page.locator('.vditor-ir li').filter({ hasText: 'alpha' })
    const target = page.locator('.vditor-ir li').filter({ hasText: 'first' })
    await source.dragTo(target)

    await expect
      .poll(() => getValue(page))
      .toMatch(/1\.\s+first\n2\.\s+alpha\n3\.\s+second\n4\.\s+third/)
    expect(await getValue(page)).toMatch(/1\.\s+beta/)
  })

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode}: real cut already renumbers through Vditor's structural path`, async ({
      page,
    }) => {
      await gotoList(page, 'stale', false, mode)
      await selectListItem(page, 'beta')
      await page.keyboard.press('Control+x')

      await expect.poll(() => getValue(page)).toMatch(/2\.\s+gamma/)
      expect(await getValue(page)).not.toContain('beta')
    })

    test(`${mode}: selection Delete already renumbers through Vditor's structural path`, async ({
      page,
    }) => {
      await gotoList(page, 'stale', false, mode)
      await selectListItem(page, 'beta')
      await page.keyboard.press('Delete')

      await expect.poll(() => getValue(page)).toMatch(/2\.\s+gamma/)
      expect(await getValue(page)).not.toContain('beta')
    })

    test(`${mode}: renumbers both local roots after a cross-list drag move`, async ({
      page,
    }) => {
      await gotoList(page, 'staleAll', true, mode)
      await page.evaluate(() => {
        ;(window as any).__moveListItem('alpha', 'first')
      })

      await expect
        .poll(() => getValue(page))
        .toMatch(/1\.\s+alpha\n2\.\s+first\n3\.\s+second\n4\.\s+third/)
      expect(await getValue(page)).toMatch(/1\.\s+beta/)
      expect(
        await page.evaluate(() => (window as any).__listAutoCounts()),
      ).toEqual({ spins: 2 })
    })

    test(`${mode}: ordinary typing performs no extra list-normalization spin`, async ({
      page,
    }) => {
      await gotoList(page, 'stale', true, mode)
      await caretAt(page, 'alpha', 2)
      await page.evaluate(() => (window as any).__resetListAutoCounts())
      await page.keyboard.type('X')
      await expect.poll(() => getValue(page)).toMatch(/1\.\s+alXpha/)
      await page.waitForTimeout(300)

      expect(
        await page.evaluate(() => (window as any).__listAutoCounts()),
      ).toEqual({ spins: 1 })
    })
  }
})
