import { test, expect } from './coverage-fixture'

async function selectText(
  page: import('@playwright/test').Page,
  needle: string,
  backward = false,
  surface = '.vditor-ir',
) {
  await page.locator(surface).click({ position: { x: 8, y: 8 } })
  await page.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: finds a text-node selection across Vditor's rendered inline DOM while retaining reverse-selection coverage.
    (_body, args) => {
      const [text, reverse, selector] = args as [string, boolean, string]
      const root = document.querySelector(selector)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        const node = next as Text
        const start = node.data.indexOf(text)
        if (start < 0) continue
        const selection = getSelection()
        if (!selection) throw new Error('no selection')
        selection.removeAllRanges()
        if (selection.setBaseAndExtent) {
          selection.setBaseAndExtent(
            reverse ? node : node,
            reverse ? start + text.length : start,
            node,
            reverse ? start : start + text.length,
          )
        } else {
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + text.length)
          selection.addRange(range)
        }
        ;(node.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`missing ${text}`)
    },
    [needle, backward, surface] as [string, boolean, string],
  )
}

async function placeCaret(
  page: import('@playwright/test').Page,
  needle: string,
  surface = '.vditor-ir',
) {
  await selectText(page, needle, false, surface)
  await page.locator('body').evaluate(() => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!selection || !range) throw new Error('selection missing')
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  })
}

async function activateGithubInlineMath(page: import('@playwright/test').Page) {
  await page.locator('[data-type="math"]').click()
  await page.locator('[data-type="math-inline-github"]').click()
}

async function activateGithubFencedMath(page: import('@playwright/test').Page) {
  await page.locator('[data-type="math"]').click()
  await page.locator('[data-type="math-block"]').click()
}

const value = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)

const markerLeaks = (page: import('@playwright/test').Page) =>
  page.locator('body').evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    )
    const leaks: string[] = []
    for (let next = walker.nextNode(); next; next = walker.nextNode())
      if ((next.textContent ?? '').includes('VMDE_MATH_'))
        leaks.push(
          JSON.stringify({
            node: (next.parentElement?.outerHTML ?? '').slice(0, 400),
            preview: next.parentElement
              ?.closest('.vditor-ir__preview, .vditor-wysiwyg__preview')
              ?.outerHTML.slice(0, 400),
            parent: next.parentElement
              ?.closest('.vditor-ir__node')
              ?.outerHTML.slice(0, 700),
          }),
        )
    return leaks
  })

const armPostCheckpointFailure = (page: import('@playwright/test').Page) =>
  page.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const mode = inner.currentMode
    const slot = inner.undo[mode]
    const addToUndoStack = inner.undo.addToUndoStack.bind(inner.undo)
    let checkpoints = 0
    ;(window as any).__mathRollbackSavepoint = undefined
    inner.undo.addToUndoStack = (owner: unknown) => {
      checkpoints++
      if (checkpoints === 2) {
        ;(window as any).__mathRollbackSavepoint = {
          mode,
          slot,
          undoStack: [...slot.undoStack],
          redoStack: [...slot.redoStack],
          lastText: slot.lastText,
          hasUndo: slot.hasUndo,
          scrollTop:
            document.querySelector<HTMLElement>('.vditor-ir')?.scrollTop,
        }
        throw new Error('task-551 forced post-checkpoint failure')
      }
      return addToUndoStack(owner)
    }
  })

const rollbackState = (page: import('@playwright/test').Page) =>
  page.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const saved = (window as any).__mathRollbackSavepoint
    const slot = inner.undo[inner.currentMode]
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const sameItems = (left: unknown[], right: unknown[]) =>
      left.length === right.length &&
      left.every((item, index) => item === right[index])
    return {
      captured: Boolean(saved),
      sameMode: saved?.mode === inner.currentMode,
      sameSlot: saved?.slot === slot,
      sameUndo: saved && sameItems(slot.undoStack, saved.undoStack),
      sameRedo: saved && sameItems(slot.redoStack, saved.redoStack),
      sameLastText: saved && Object.is(slot.lastText, saved.lastText),
      sameHasUndo: saved && Object.is(slot.hasUndo, saved.hasUndo),
      sameScroll:
        saved?.scrollTop ===
        document.querySelector<HTMLElement>('.vditor-ir')?.scrollTop,
      resurrected: JSON.stringify({
        undoStack: slot.undoStack,
        redoStack: slot.redoStack,
        lastText: slot.lastText,
      }).includes('Action $`target`$ and'),
      selection: {
        text: selection?.toString(),
        backward:
          selection?.anchorNode === range?.endContainer &&
          selection?.anchorOffset === range?.endOffset,
      },
    }
  })

/**
 * E2e for KaTeX error resilience (task 57). With the fixMathRender patch
 * (strict:false, throwOnError:false), a broken formula renders as KaTeX's inline
 * error (.katex-error) instead of throwing — so valid formulas around it still
 * render and the editor stays usable. .katex-error specifically proves the patch
 * is active (the unpatched code path produces a plain `vditor-reset--error`
 * message from the catch, not KaTeX's own error markup).
 */
test('a broken formula renders as an inline KaTeX error; valid math still renders', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  // Math renders asynchronously after init.
  await page.waitForSelector('.katex, .katex-error', { timeout: 5000 })

  const counts = await page.evaluate(() => ({
    katex: document.querySelectorAll('.katex').length,
    katexError: document.querySelectorAll('.katex-error').length,
  }))

  // Valid formulas rendered…
  expect(counts.katex).toBeGreaterThan(0)
  // …and the broken one rendered as a KaTeX inline error (proves throwOnError:false)…
  expect(counts.katexError).toBeGreaterThan(0)
  // …without any uncaught error tearing down the page.
  expect(errors).toEqual([])
})

test('GitHub inline math renders without its authoring backticks and retains raw copy source', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const githubMath = page.locator('[data-math="`x^2`"]')
  await githubMath.locator('.katex').waitFor()
  await expect(githubMath).toContainText('x')
  await expect(githubMath).not.toContainText('`')
})

test('the Math menu exposes the GitHub inline action', async ({ page }) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await expect(page.locator('[data-type="math"]')).toBeVisible()
  await page.locator('[data-type="math"]').click()
  await expect(page.locator('[data-type="math-inline-github"]')).toBeVisible()
  await expect(page.locator('[data-type="math-block"]')).toBeVisible()
})

test('a GitHub math fence uses KaTeX display layout while retaining its authored fence source', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await expect
    .poll(() =>
      page.locator('body').evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.language-math')]
          .map((element) => ({
            text: element.getAttribute('data-math') ?? element.textContent,
            tag: element.tagName,
            parent: element.parentElement?.tagName,
            display: element.querySelector('.katex-display') !== null,
          }))
          .some(
            (math) =>
              math.text?.trim() === '\\sum_{i=1}^{n} i' &&
              math.tag === 'CODE' &&
              math.parent === 'PRE' &&
              math.display,
          ),
      ),
    )
    .toBe(true)
  await expect
    .poll(() => value(page))
    .toContain('```math\n\\sum_{i=1}^{n} i\n```')
})

test('the Math block action wraps selected source, restores one undo step, and does not mutate Preview', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'Block action target.')
  await activateGithubFencedMath(page)
  await expect
    .poll(() => value(page))
    .toContain('```math\nBlock action target.\n```')
  await page.locator('[data-type="undo"]').click()
  await expect.poll(() => value(page)).toContain('Block action target.')
  await expect
    .poll(() => value(page))
    .not.toContain('```math\nBlock action target.\n```')

  await page.locator('[data-type="preview"]').click()
  await expect(page.locator('[data-type="math-block"]')).toBeDisabled()
  const beforePreview = await value(page)
  await page.evaluate(() =>
    document.dispatchEvent(new Event('vmde-insert-github-fenced-math')),
  )
  await expect.poll(() => value(page)).toBe(beforePreview)
})

test('the Math action wraps a backward pointer selection and actual typing replaces it', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'target', true)
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('Action $`target`$ and')
  const selection = await page.locator('body').evaluate(() => {
    const current = getSelection()
    return {
      text: current?.toString(),
      backward: Boolean(
        current &&
          current.anchorNode === current.getRangeAt(0).endContainer &&
          current.anchorOffset === current.getRangeAt(0).endOffset,
      ),
      anchor: current?.anchorNode?.textContent,
      focus: current?.focusNode?.textContent,
      anchorOffset: current?.anchorOffset,
      focusOffset: current?.focusOffset,
    }
  })
  expect(
    selection.anchorOffset,
    `selected expression endpoint: ${JSON.stringify(selection)}`,
  ).toBeGreaterThan(selection.focusOffset ?? Number.POSITIVE_INFINITY)
  expect(selection.backward).toBe(true)
  expect(selection.text, JSON.stringify(selection)).toBe('target')
  expect(await markerLeaks(page)).toEqual([])
  await page.keyboard.type('q')
  await expect.poll(() => value(page)).toContain('Action $`q`$ and')
  expect(await markerLeaks(page)).toEqual([])
})

test('the Math action creates one native undo/redo source step', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'target')
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('Action $`target`$ and')
  await page.locator('[data-type="undo"]').click()
  await expect.poll(() => value(page)).toContain('Action target and')
  await page.locator('[data-type="redo"]').click()
  await expect.poll(() => value(page)).toContain('Action $`target`$ and')
})

test('a post-checkpoint failure restores source, backward selection, and the native history savepoint', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'target', true)
  await page.locator('.vditor-ir').evaluate((surface) => {
    surface.style.height = '40px'
    surface.style.overflowY = 'auto'
    surface.scrollTop = 24
  })
  const before = await value(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await armPostCheckpointFailure(page)
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toBe(before)
  expect(await rollbackState(page)).toEqual({
    captured: true,
    sameMode: true,
    sameSlot: true,
    sameUndo: true,
    sameRedo: true,
    sameLastText: true,
    sameHasUndo: true,
    sameScroll: true,
    resurrected: false,
    selection: { text: 'target', backward: true },
  })
  expect(await markerLeaks(page)).toEqual([])
  expect(errors).toContain('Error: task-551 forced post-checkpoint failure')
})

test('the Math action inserts an empty pair at the caret and rejects literal code and Preview', async ({
  page,
}) => {
  await page.goto('/math.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await placeCaret(page, 'empty insertion')
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('and $``$empty insertion')
  await page.keyboard.type('z')
  await expect.poll(() => value(page)).toContain('and $`z`$empty insertion')

  await selectText(page, 'code target')
  const beforeCode = await value(page)
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toBe(beforeCode)

  await page.locator('[data-type="preview"]').click()
  await expect(page.locator('[data-type="math-inline-github"]')).toBeDisabled()
  const beforePreview = await value(page)
  await page.evaluate(() =>
    document.dispatchEvent(new Event('vmde-insert-github-inline-math')),
  )
  await expect.poll(() => value(page)).toBe(beforePreview)
})

test('SV rejects an inline-code selection without changing source', async ({
  page,
}) => {
  await page.goto('/math.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'code target', false, '.vditor-sv')
  const before = await value(page)
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toBe(before)
})

test('WYSIWYG wraps selected bytes and preserves an empty-pair typing caret', async ({
  page,
}) => {
  await page.goto('/math.html?mode=wysiwyg')
  await page.waitForFunction(() => (window as any).__ready === true)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.vditor.currentMode))
    .toBe('wysiwyg')
  await selectText(page, 'target', true, '.vditor-wysiwyg')
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('Action $`target`$ and')
  await page.keyboard.type('q')
  await expect.poll(() => value(page)).toContain('Action $`q`$ and')

  await placeCaret(page, 'empty insertion', '.vditor-wysiwyg')
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('and $``$empty insertion')
  await page.keyboard.type('z')
  await expect.poll(() => value(page)).toContain('and $`z`$empty insertion')

  const sourceCode = page
    .locator('.vditor-wysiwyg code[data-type="math-inline"]')
    .filter({ hasText: '`q`' })
  await expect(sourceCode).toHaveText('\u200B`q`')
  expect(await value(page)).not.toContain('\u200B')

  await selectText(page, 'code target', false, '.vditor-wysiwyg')
  const beforeCode = await value(page)
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toBe(beforeCode)
})

test('SV authoring wraps a selection and preserves the typing source', async ({
  page,
}) => {
  await page.goto('/math.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, 'target', true, '.vditor-sv')
  await expect
    .poll(() =>
      page.locator('body').evaluate(() => ({
        selection: getSelection()?.toString(),
        source: (window as any).vditor.getValue(),
      })),
    )
    .toEqual(expect.objectContaining({ selection: 'target' }))
  await expect(page.locator('[data-type="math"]')).toBeEnabled()
  await activateGithubInlineMath(page)
  await expect.poll(() => value(page)).toContain('Action $`target`$ and')
  await page.keyboard.type('q')
  await expect.poll(() => value(page)).toContain('Action $`q`$ and')
})

test('SV preserves authored U+200B inside a selection and beside an empty pair', async ({
  page,
}) => {
  await page.goto('/math.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  await selectText(page, '\u200Btarget', false, '.vditor-sv')
  await activateGithubInlineMath(page)
  await expect
    .poll(() => value(page))
    .toContain(
      'U200B source: prefix $`\u200Btarget`$ and adjacent \u200Bempty-site.',
    )

  await placeCaret(page, 'empty-site', '.vditor-sv')
  await activateGithubInlineMath(page)
  await expect
    .poll(() => value(page))
    .toContain('adjacent \u200B$``$empty-site.')
  await page.keyboard.type('z')
  await expect
    .poll(() => value(page))
    .toContain('adjacent \u200B$`z`$empty-site.')
})
