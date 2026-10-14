import { expect, test } from './coverage-fixture'

async function openEditor(page: import('@playwright/test').Page) {
  await page.addInitScript(installCaretReader)
  await page.goto('/block-transform.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function chooseCaret(
  page: import('@playwright/test').Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
  needle: string,
) {
  await page.locator('body').evaluate(
    (_body, args) => {
      const [currentMode, text] = args as [string, string]
      const root = (window as any).vditor.vditor[currentMode]
        .element as HTMLElement
      root.focus()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + 2)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`missing ${text} in ${currentMode}`)
    },
    [mode, needle],
  )
}

function getValue(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => (window as any).vditor.getValue())
}

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Page = import('@playwright/test').Page

function undoDepth(page: Page, mode: Mode): Promise<number> {
  return page.evaluate(
    (m) => (window as any).vditor.vditor.undo[m].undoStack.length,
    mode,
  )
}

function redoDepth(page: Page, mode: Mode): Promise<number> {
  return page.evaluate(
    (m) => (window as any).vditor.vditor.undo[m].redoStack.length,
    mode,
  )
}

async function switchMode(page: Page, mode: 'wysiwyg' | 'sv') {
  await page.evaluate((m) => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>(`button[data-mode="${m}"]`)
      ?.click()
  }, mode)
  await expect(page.locator(`.vditor-${mode}`)).toBeVisible()
}

/** Open the harness in `mode` on the shared three-paragraph document, with its opening snapshot recorded. */
async function openSettled(page: Page, mode: Mode) {
  await openEditor(page)
  if (mode !== 'ir') {
    await switchMode(page, mode)
    await page.evaluate(() =>
      (window as any).vditor.setValue('before\n\nalpha **beta**\n\nafter\n'),
    )
  }
  await expect.poll(() => undoDepth(page, mode)).toBe(1)
}

/** Page-side reader (installed before the page's scripts): the block text just before and just
 * after the caret (the selection start), and whether the selection is collapsed. */
function installCaretReader() {
  ;(window as any).__readCaret = () => {
    const selection = getSelection()!
    const empty = { collapsed: true, before: '', after: '' }
    if (!selection.rangeCount) return empty
    const range = selection.getRangeAt(0)
    const container =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement
    const block = container?.closest(
      'p, h1, h2, h3, h4, h5, h6, pre, .vditor-reset > div',
    )
    if (!block) return { ...empty, collapsed: selection.isCollapsed }
    const head = document.createRange()
    head.setStart(block, 0)
    head.setEnd(range.startContainer, range.startOffset)
    const before = head.toString()
    return {
      collapsed: selection.isCollapsed,
      before,
      after: (block.textContent ?? '').slice(before.length),
    }
  }
}

/** One Undo or Redo through Vditor's engine; the caret is read in the same task. The harness has
 * no caret-invalidation listener, so a later frame could replay Turn Into's armed caret request
 * over the restored caret (production drops it on the Ctrl+Z keydown). */
async function stepHistory(page: Page, action: 'undo' | 'redo') {
  await page.evaluate((name) => {
    const inner = (window as any).vditor.vditor
    inner.undo[name](inner)
    ;(window as any).__caretAfterStep = (window as any).__readCaret()
  }, action)
}

const undoOnce = (page: Page) => stepHistory(page, 'undo')
const redoOnce = (page: Page) => stepHistory(page, 'redo')

/** The caret read right after the last `undoOnce` / `redoOnce`. */
function caretAfterStep(
  page: Page,
): Promise<{ collapsed: boolean; before: string; after: string }> {
  return page.evaluate(() => (window as any).__caretAfterStep)
}

/** Count and keep every exact post the harness makes (it assigns `__postedBlockSource` per post). */
function recordHostPosts(page: Page) {
  return page.evaluate(() => {
    const posts: string[] = []
    ;(window as any).__hostPosts = posts
    Object.defineProperty(window, '__postedBlockSource', {
      configurable: true,
      get: () => posts.at(-1),
      set: (value: string) => {
        posts.push(value)
      },
    })
  })
}

test('IR source-derived choice converts one block, posts exact once, and uses one undo step', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options.currentType).toBe('paragraph')
  expect(
    options.targets.find((target: any) => target.type === 'h2')?.status,
  ).toBe('changed')
  const before = await getValue(page)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('## alpha **beta**')
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toContain('## alpha **beta**')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('a stale token and confirm-required target never mutate source or history', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  const before = await getValue(page)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'fence' }),
      options.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toBe(before)
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toBeUndefined()

  const stale = await page.evaluate(() => (window as any).__blockOptions())
  await page.evaluate(() => (window as any).vditor.setValue('external edit\n'))
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'quote' }),
      stale.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toContain('external edit')
})

test('WYSIWYG and SV use the same source-derived paragraph transformation', async ({
  page,
}) => {
  await openEditor(page)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>('button[data-mode="wysiwyg"]')
      ?.click()
  })
  await expect(page.locator('.vditor-wysiwyg')).toBeVisible()
  await chooseCaret(page, 'wysiwyg', 'beta')
  const wys = await page.evaluate(() => (window as any).__blockOptions())
  expect(wys?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'quote' }),
      wys.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('> alpha **beta**')

  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
    ;(window as any).vditor.setValue('before\n\nalpha **beta**\n\nafter\n')
  })
  await expect(page.locator('.vditor-sv')).toBeVisible()
  await chooseCaret(page, 'sv', 'beta')
  const sv = await page.evaluate(() => (window as any).__blockOptions())
  expect(sv?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'bullet' }),
      sv.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('- alpha **beta**')
})

test('palette focus sentinel preserves the prior source-verified caret', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const focusCapture = await page.evaluate(() => {
    const metrics = { blockTransformCaptureCalls: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    // Native palette focus leaves the editor before its root-zero sentinel appears. Exercise
    // that capture: selectionchange alone deliberately performs no source serialization.
    const palette = document.createElement('input')
    document.body.append(palette)
    palette.focus()
    return {
      paletteFocused: document.activeElement === palette,
      captures: metrics.blockTransformCaptureCalls,
    }
  })
  expect(focusCapture).toEqual({ paletteFocused: true, captures: 1 })
  await page.evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const range = document.createRange()
    range.setStart(root, 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options?.currentType).toBe('paragraph')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toContain('## alpha **beta**')
})

test('paragraph to callout composes Task 527 source marker with one undo', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const before = await getValue(page)
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    options?.targets.find((item: any) => item.type === 'callout')?.status,
  ).toBe('changed')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'callout' }),
      options.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toContain('> [!NOTE]\n> alpha **beta**')
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toContain('> [!NOTE]\n> alpha **beta**')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('IR selection transforms two source-owned paragraphs atomically with one undo', async ({
  page,
}) => {
  await openEditor(page)
  const before = await getValue(page)
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const paragraphs = root.querySelectorAll(':scope > p')
    const first = paragraphs[0].firstChild!
    const second = paragraphs[1].firstChild!
    const range = document.createRange()
    range.setStart(first, 2)
    range.setEnd(second, 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(root as HTMLElement).focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options).toMatchObject({
    currentType: 'paragraph',
    spans: [
      { start: 0, end: 6 },
      { start: 8, end: 22 },
    ],
  })
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toBe('## before\n\n## alpha **beta**\n\nafter\n')
  expect(await page.evaluate(() => (window as any).__postedBlockSource)).toBe(
    '## before\n\n## alpha **beta**\n\nafter\n',
  )
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('one confirmed fence proposal applies exactly once and cancellation leaves no edit', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const before = await getValue(page)
  const canceled = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    canceled.targets.find((item: any) => item.type === 'fence'),
  ).toMatchObject({
    status: 'confirm-required',
    losses: ['markdown-becomes-literal'],
  })
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'fence' }),
      canceled.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toBe(before)
  const accepted = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'fence' }, true),
      accepted.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toBe('before\n\n```\nalpha **beta**\n```\n\nafter\n')
  expect(await page.evaluate(() => (window as any).__postedBlockSource)).toBe(
    'before\n\n```\nalpha **beta**\n```\n\nafter\n',
  )
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('a new source selection invalidates a retained Turn Into token without a source edit', async ({
  page,
}) => {
  await openEditor(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  const before = await getValue(page)
  await chooseCaret(page, 'ir', 'before')
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toBe(before)
  expect(
    await page.evaluate(() => (window as any).__postedBlockSource),
  ).toBeUndefined()
})

test('two consecutive Turn Into transactions each consume one Vditor undo step', async ({
  page,
}) => {
  await openEditor(page)
  const before = await getValue(page)
  // Task 611: the opening snapshot is the base entry; each Turn Into then adds exactly one.
  await expect.poll(() => undoDepth(page, 'ir')).toBe(1)
  await chooseCaret(page, 'ir', 'beta')
  const first = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      first.token,
    ),
  ).toBe(true)
  const afterFirst = 'before\n\n## alpha **beta**\n\nafter\n'
  await expect.poll(() => getValue(page)).toBe(afterFirst)
  expect(await undoDepth(page, 'ir')).toBe(2)
  await chooseCaret(page, 'ir', 'alpha')
  const second = await page.evaluate(() => {
    const options = (window as any).__blockOptions()
    return {
      currentType: options?.currentType,
      status: options?.targets.find((item: any) => item.type === 'quote')
        ?.status,
      applied: (window as any).__blockApply(options.token, { type: 'quote' }),
    }
  })
  expect(second).toMatchObject({
    currentType: 'h2',
    status: 'changed',
    applied: true,
  })
  await expect
    .poll(() => getValue(page))
    .toBe('before\n\n> alpha **beta**\n\nafter\n')
  expect(await undoDepth(page, 'ir')).toBe(3)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(afterFirst)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('same-type Code Fence language choice changes info only with one undo', async ({
  page,
}) => {
  await openEditor(page)
  const before = '```js\nalpha\n```\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  await chooseCaret(page, 'ir', 'alpha')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options).toMatchObject({ currentType: 'fence', fenceLanguage: 'js' })
  expect(
    options.targets.find((item: any) => item.type === 'fence').status,
  ).toBe('noop')
  expect(
    await page.evaluate(
      (token) =>
        (window as any).__blockApply(token, { type: 'fence', language: 'ts' }),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toBe('```ts\nalpha\n```\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('callout removal requires one consent and one undo', async ({ page }) => {
  await openEditor(page)
  const callout = '> [!NOTE]- Title\n> body **exact**\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    callout,
  )
  await chooseCaret(page, 'ir', 'body')
  const calloutOptions = await page.evaluate(() =>
    (window as any).__blockOptions(),
  )
  expect(calloutOptions.currentType).toBe('callout')
  expect(
    calloutOptions.targets.find((item: any) => item.type === 'quote'),
  ).toMatchObject({
    status: 'confirm-required',
    losses: ['callout-type/title/fold-marker-removed'],
  })
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'quote' }, true),
      calloutOptions.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toBe('> body **exact**\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(callout)
})

test('a risky two-block fence batch records one aggregate proposal and undo', async ({
  page,
}) => {
  await openEditor(page)
  const before = await getValue(page)
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const blocks = root.querySelectorAll(':scope > p')
    const range = document.createRange()
    range.setStart(blocks[0].firstChild!, 2)
    range.setEnd(blocks[1].firstChild!, 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(root as HTMLElement).focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options?.spans).toHaveLength(2)
  expect(
    options.targets.find((item: any) => item.type === 'fence'),
  ).toMatchObject({
    status: 'confirm-required',
    losses: ['markdown-becomes-literal', 'markdown-becomes-literal'],
  })
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'fence' }, true),
      options.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toBe('```\nbefore\n```\n\n```\nalpha **beta**\n```\n\nafter\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('WYSIWYG multi-block selection uses the shared source-owned batch planner', async ({
  page,
}) => {
  await openEditor(page)
  const before = await getValue(page)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector<HTMLButtonElement>('button[data-mode="wysiwyg"]')
      ?.click()
  })
  await expect(page.locator('.vditor-wysiwyg')).toBeVisible()
  await page.locator('.vditor-wysiwyg .vditor-reset').evaluate((root) => {
    ;(root as HTMLElement).focus()
    const blocks = root.querySelectorAll(':scope > p')
    const textIn = (block: Element, needle: string) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      )
        if (node.data.includes(needle)) return node
      throw new Error(`WYS block ${needle} missing`)
    }
    const range = document.createRange()
    range.setStart(textIn(blocks[0], 'before'), 2)
    range.setEnd(textIn(blocks[1], 'alpha'), 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options?.spans).toHaveLength(2)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  await expect
    .poll(() => getValue(page))
    .toBe('## before\n\n## alpha **beta**\n\nafter\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('SV multi-block source range uses the same atomic planner and one undo', async ({
  page,
}) => {
  await openEditor(page)
  await page.evaluate(() => {
    const toolbar = (window as any).vditor.vditor.toolbar
    toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await expect(page.locator('.vditor-sv')).toBeVisible()
  const before = await getValue(page)
  await page.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.focus()
    const find = (needle: string) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const index = node.data.indexOf(needle)
        if (index >= 0) return { node, index }
      }
      throw new Error(`SV source ${needle} missing`)
    }
    const first = find('before')
    const second = find('alpha')
    const range = document.createRange()
    range.setStart(first.node, first.index + 2)
    range.setEnd(second.node, second.index + 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options?.spans).toHaveLength(2)
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)
  const exactAfter = before
    .replace('before', '## before')
    .replace('alpha **beta**', '## alpha **beta**')
  expect(await page.evaluate(() => (window as any).__postedBlockSource)).toBe(
    exactAfter,
  )
  await expect.poll(() => getValue(page)).toBe(exactAfter)
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)
})

test('fence removal requires one Lute paragraph and preserves raw body through undo', async ({
  page,
}) => {
  await openEditor(page)
  const before = '```ts\nalpha **bold**\n```\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    before,
  )
  await chooseCaret(page, 'ir', 'alpha')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    options?.targets.find((item: any) => item.type === 'paragraph'),
  ).toMatchObject({
    status: 'confirm-required',
    losses: ['fence-language-removed'],
  })
  expect(
    await page.evaluate(
      (token) =>
        (window as any).__blockApply(token, { type: 'paragraph' }, true),
      options.token,
    ),
  ).toBe(true)
  await expect.poll(() => getValue(page)).toBe('alpha **bold**\n')
  await page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })
  await expect.poll(() => getValue(page)).toBe(before)

  const structural = '```md\n# heading\n```\n'
  await page.evaluate(
    (markdown) => (window as any).vditor.setValue(markdown),
    structural,
  )
  await chooseCaret(page, 'ir', 'heading')
  const rejected = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    rejected?.targets.find((item: any) => item.type === 'paragraph')?.status,
  ).toBe('unsupported')
  expect(
    await page.evaluate(
      (token) =>
        (window as any).__blockApply(token, { type: 'paragraph' }, true),
      rejected.token,
    ),
  ).toBe(false)
  expect(await getValue(page)).toBe(structural)
})

// Task 611 — Turn Into adds exactly one Undo entry. A settled edit, then a caret move into the
// target, used to leave a caret-only pre-checkpoint entry under the transform: Ctrl+Z, Ctrl+Z
// changed nothing in the text on its second press.
for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`${mode}: Turn Into adds one Undo entry; Undo and Redo keep the document and the caret`, async ({
    page,
  }) => {
    await openSettled(page, mode)
    const original = await getValue(page)
    await chooseCaret(page, mode, 'before')
    await page.keyboard.type('X')
    await expect.poll(() => undoDepth(page, mode)).toBe(2)
    const edited = await getValue(page)
    expect(edited).toContain('X')
    await chooseCaret(page, mode, 'beta')
    await recordHostPosts(page)
    const options = await page.evaluate(() => (window as any).__blockOptions())

    expect(
      await page.evaluate(
        (token) => (window as any).__blockApply(token, { type: 'h2' }),
        options.token,
      ),
    ).toBe(true)
    const transformed = edited.replace('alpha **beta**', '## alpha **beta**')
    await expect.poll(() => getValue(page)).toBe(transformed)

    // One new entry, and no delayed record lands later (Vditor's delay is 800 ms).
    expect(await undoDepth(page, mode)).toBe(3)
    await page.waitForTimeout(1200)
    expect(await undoDepth(page, mode)).toBe(3)
    expect(await page.evaluate(() => (window as any).__hostPosts)).toEqual([
      transformed,
    ])

    // One Undo restores the exact document with the caret where it was (be|ta).
    await undoOnce(page)
    await expect.poll(() => getValue(page)).toBe(edited)
    expect(await undoDepth(page, mode)).toBe(2)
    expect(await caretAfterStep(page)).toMatchObject({
      collapsed: true,
      before: expect.stringMatching(/be$/),
      after: expect.stringMatching(/^ta/),
    })

    // One Redo reapplies it; the caret sits at the content position the planner maps (be|ta).
    await redoOnce(page)
    await expect.poll(() => getValue(page)).toBe(transformed)
    expect(await undoDepth(page, mode)).toBe(3)
    expect(await caretAfterStep(page)).toMatchObject({
      collapsed: true,
      before: expect.stringMatching(/be$/),
      after: expect.stringMatching(/^ta/),
    })

    // The next Undo after the transform's own changes the text: the typed character.
    await undoOnce(page)
    await expect.poll(() => getValue(page)).toBe(edited)
    await undoOnce(page)
    await expect.poll(() => getValue(page)).toBe(original)
    expect(await undoDepth(page, mode)).toBe(1)
  })
}

test('IR: a pending edit inside the Undo delay is flushed as its own entry before the transform', async ({
  page,
}) => {
  await openSettled(page, 'ir')
  const original = await getValue(page)
  await chooseCaret(page, 'ir', 'before')
  await page.keyboard.type('X')
  // No wait: the edit's delayed record is still pending when Turn Into starts.
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)

  // Base, the typed edit, the transform: two new entries, neither of them caret-only.
  expect(await undoDepth(page, 'ir')).toBe(3)
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toContain('X')
  expect(await getValue(page)).not.toContain('## ')
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toBe(original)
})

test('IR: a non-empty Redo stack survives the pre-checkpoint and the base entry coalesces', async ({
  page,
}) => {
  await openSettled(page, 'ir')
  const original = await getValue(page)
  await chooseCaret(page, 'ir', 'before')
  await page.keyboard.type('X')
  await expect.poll(() => undoDepth(page, 'ir')).toBe(2)
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toBe(original)
  expect(await undoDepth(page, 'ir')).toBe(1)
  expect(await redoDepth(page, 'ir')).toBe(1)

  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)

  // Depth 1 -> 2 (the base coalesced, the transform pushed); a new edit clears Redo as usual.
  expect(await undoDepth(page, 'ir')).toBe(2)
  expect(await redoDepth(page, 'ir')).toBe(0)
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toBe(original)
  expect(await undoDepth(page, 'ir')).toBe(1)
})

test('IR: a block selection (anchor and focus apart) adds one Undo entry and Undo returns the exact document', async ({
  page,
}) => {
  await openSettled(page, 'ir')
  await chooseCaret(page, 'ir', 'before')
  await page.keyboard.type('X')
  await expect.poll(() => undoDepth(page, 'ir')).toBe(2)
  const edited = await getValue(page)
  await page.locator('.vditor-ir .vditor-reset').evaluate((root) => {
    const paragraphs = root.querySelectorAll(':scope > p')
    const range = document.createRange()
    range.setStart(paragraphs[0].firstChild!, 2)
    range.setEnd(paragraphs[1].firstChild!, 2)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(root as HTMLElement).focus()
    document.dispatchEvent(new Event('selectionchange'))
  })
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(options.spans).toHaveLength(2)

  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)

  expect(await undoDepth(page, 'ir')).toBe(3)
  expect(
    await page.evaluate(() => {
      const selection = getSelection()!
      return {
        collapsed: selection.isCollapsed,
        text: selection.toString(),
      }
    }),
  ).toMatchObject({ collapsed: false })
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toBe(edited)
  expect(await caretAfterStep(page)).toMatchObject({
    collapsed: true,
    before: expect.stringMatching(/be$/),
    after: expect.stringMatching(/^Xfore/),
  })
})

test('IR: a math block in the document does not turn the pre-checkpoint into a second entry', async ({
  page,
}) => {
  await openEditor(page)
  await page.evaluate(() =>
    (window as any).vditor.setValue('$$\nx^2\n$$\n\nalpha **beta**\n'),
  )
  await expect(page.locator('.vditor-ir .katex').first()).toBeVisible()
  // Let every delayed record from the render land before measuring.
  await page.waitForTimeout(1200)
  const depth = await undoDepth(page, 'ir')
  const original = await getValue(page)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  expect(
    await page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).toBe(true)

  expect(await undoDepth(page, 'ir')).toBe(depth + 1)
  await undoOnce(page)
  await expect.poll(() => getValue(page)).toBe(original)
})

test('IR: a failed apply restores the exact Undo stacks', async ({ page }) => {
  await openSettled(page, 'ir')
  await chooseCaret(page, 'ir', 'before')
  await page.keyboard.type('X')
  await expect.poll(() => undoDepth(page, 'ir')).toBe(2)
  await chooseCaret(page, 'ir', 'beta')
  const options = await page.evaluate(() => (window as any).__blockOptions())
  const history = () =>
    page.evaluate(() => {
      const slot = (window as any).vditor.vditor.undo.ir
      return JSON.stringify({
        undo: slot.undoStack,
        redo: slot.redoStack,
        lastText: slot.lastText,
        hasUndo: slot.hasUndo,
      })
    })
  const before = await history()
  const source = await getValue(page)
  // Fail the transform's own rebuild once (after the pre-checkpoint ran); the rollback's works.
  await page.evaluate(() => {
    const editor = (window as any).vditor
    const original = editor.setValue.bind(editor)
    let failed = false
    editor.setValue = (value: string, ...rest: unknown[]) => {
      if (!failed) {
        failed = true
        throw new Error('forced rebuild failure')
      }
      return original(value, ...rest)
    }
  })

  // The harness's error hook rethrows what the apply reports after it rolled back.
  await expect(
    page.evaluate(
      (token) => (window as any).__blockApply(token, { type: 'h2' }),
      options.token,
    ),
  ).rejects.toThrow('forced rebuild failure')

  expect(await history()).toBe(before)
  expect(await getValue(page)).toBe(source)
})
