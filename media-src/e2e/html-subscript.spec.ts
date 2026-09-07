import { test, expect } from './coverage-fixture'

async function open(
  page: import('@playwright/test').Page,
  mode: 'ir' | 'wysiwyg' | 'sv',
  supSub = false,
) {
  await page.goto(
    `/html-subscript.html?mode=${mode}&supSub=${supSub ? '1' : '0'}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function placeCaretByPointer(
  page: import('@playwright/test').Page,
  selector: string,
  context: string,
) {
  const box = await page.locator(selector).evaluate((root, needle) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.textContent?.indexOf(needle) ?? -1
      if (offset < 0) continue
      const range = document.createRange()
      range.setStart(node, offset + needle.length)
      range.collapse(true)
      const rect = range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, height: rect.height }
    }
    throw new Error(`Could not find ${needle}`)
  }, context)
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
}

async function selectTextByPointer(
  page: import('@playwright/test').Page,
  selector: string,
  context: string,
  text: string,
  occurrence = 0,
) {
  const box = await page.locator(selector).evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: resolves a text-offset click coordinate through Vditor's inline marker DOM
    (root, target) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let matches = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const content = node.textContent ?? ''
        const contextOffset = target.context
          ? content.indexOf(target.context)
          : 0
        const offset = target.context
          ? contextOffset + target.context.length
          : content.indexOf(target.text)
        if (offset < 0) continue
        if (content.slice(offset, offset + target.text.length) !== target.text)
          continue
        if (matches++ !== target.occurrence) continue
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + target.text.length)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      throw new Error(`Could not find ${target.context}${target.text}`)
    },
    { context, text, occurrence },
  )
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + Math.max(2, box.width - 1),
    box.y + box.height / 2,
  )
  await page.mouse.up()
}

test.describe('HTML SUB presentation', () => {
  test('IR presents authored SUB semantically without changing getValue or spin', async ({
    page,
  }) => {
    await open(page, 'ir')
    const owned = page
      .locator('.vditor-ir p')
      .filter({ hasText: 'Before H' })
      .locator('sub[data-vmde-html-subscript="1"]')
    await expect(owned).toHaveCount(1)
    expect(await owned.evaluate((element) => element.tagName)).toBe('SUB')
    await expect(owned).not.toHaveAttribute('title', /.*/)
    const state = await page.evaluate(() => {
      const editor = (window as any).vditor
      const inner = editor.vditor
      const spun = inner.lute.SpinVditorIRDOM(inner.ir.element.innerHTML)
      return {
        value: editor.getValue(),
        spun: inner.lute.VditorIRDOM2Md(spun),
        canonical: (window as any).__canonical,
      }
    })
    expect(state.value).toBe(state.canonical)
    expect(state.spun).toBe(state.canonical)
    expect(
      await page
        .locator('code')
        .evaluateAll((nodes) =>
          nodes.some((node) => node.textContent === '<sub>code</sub>'),
        ),
    ).toBe(true)

    await owned.locator('strong').click()
    await expect(owned).toHaveCount(0)
    const revealed = await page.evaluate(() => {
      const markers = Array.from(
        document.querySelectorAll<HTMLElement>('[data-type="html-inline"]'),
      ).filter(
        (marker) =>
          marker.textContent?.includes('sub') &&
          marker.parentElement?.textContent?.includes('Before H'),
      )
      const selection = getSelection()
      return {
        visible: markers.every(
          (marker) =>
            getComputedStyle(marker).display !== 'none' &&
            !marker.hasAttribute('aria-hidden'),
        ),
        selectionInEditor: Boolean(
          selection?.anchorNode?.parentElement?.closest('.vditor-ir'),
        ),
        caretInOriginalTwo:
          selection?.anchorNode?.textContent === '2' &&
          selection.anchorOffset >= 0 &&
          selection.anchorOffset <= 1,
      }
    })
    expect(revealed.visible).toBe(true)
    expect(revealed.selectionInEditor).toBe(true)
    expect(revealed.caretInOriginalTwo).toBe(true)
    await page.locator('.vditor-ir p').last().click()
    await expect(owned).toHaveCount(1)
    const afterLeave = await page.evaluate(() => {
      const editor = (window as any).vditor
      const inner = editor.vditor
      return {
        value: editor.getValue(),
        spun: inner.lute.VditorIRDOM2Md(
          inner.lute.SpinVditorIRDOM(inner.ir.element.innerHTML),
        ),
        canonical: (window as any).__canonical,
      }
    })
    expect(afterLeave.value).toBe(afterLeave.canonical)
    expect(afterLeave.spun).toBe(afterLeave.canonical)
  })

  test('WYSIWYG pointer entry reveals original HTML markers and remains serializable', async ({
    page,
  }) => {
    await open(page, 'wysiwyg')
    const owned = page
      .locator('.vditor-wysiwyg p')
      .filter({ hasText: 'Before H' })
      .locator('sub[data-vmde-html-subscript="1"]')
    await expect(owned).toHaveCount(1)
    await owned.locator('strong').click()
    await expect(owned).toHaveCount(0)
    const state = await page.evaluate(() => {
      const editor = (window as any).vditor
      const inner = editor.vditor
      const spun = inner.lute.SpinVditorDOM(inner.wysiwyg.element.innerHTML)
      return {
        value: editor.getValue(),
        spun: inner.lute.VditorDOM2Md(spun),
        canonical: (window as any).__canonical,
      }
    })
    expect(state.value).toBe(state.canonical)
    expect(state.spun).toBe(state.canonical)
    const revealed = await page.evaluate(() => {
      const markers = Array.from(
        document.querySelectorAll<HTMLElement>('[data-type="html-inline"]'),
      ).filter(
        (marker) =>
          marker.textContent?.includes('sub') &&
          marker.parentElement?.textContent?.includes('Before H'),
      )
      const selection = getSelection()
      return {
        visible: markers.every(
          (marker) =>
            getComputedStyle(marker).display !== 'none' &&
            !marker.hasAttribute('aria-hidden'),
        ),
        selectionInEditor: Boolean(
          selection?.anchorNode?.parentElement?.closest('.vditor-wysiwyg'),
        ),
        caretInOriginalTwo:
          selection?.anchorNode?.textContent === '2' &&
          selection.anchorOffset >= 0 &&
          selection.anchorOffset <= 1,
      }
    })
    expect(revealed.visible).toBe(true)
    expect(revealed.selectionInEditor).toBe(true)
    expect(revealed.caretInOriginalTwo).toBe(true)
    await page.locator('.vditor-wysiwyg p').last().click()
    await expect(owned).toHaveCount(1)
    const afterLeave = await page.evaluate(() => {
      const editor = (window as any).vditor
      const inner = editor.vditor
      return {
        value: editor.getValue(),
        spun: inner.lute.VditorDOM2Md(
          inner.lute.SpinVditorDOM(inner.wysiwyg.element.innerHTML),
        ),
        canonical: (window as any).__canonical,
      }
    })
    expect(afterLeave.value).toBe(afterLeave.canonical)
    expect(afterLeave.spun).toBe(afterLeave.canonical)
  })

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode} pointer reveal keeps a caret in a plain authored SUB body`, async ({
      page,
    }) => {
      await open(page, mode)
      const plain = page
        .locator('sub[data-vmde-html-subscript="1"]')
        .filter({ hasText: '2' })
        .last()
      await plain.click()
      const caret = await page.evaluate((currentMode) => {
        const selection = getSelection()
        return {
          inEditor: Boolean(
            selection?.anchorNode?.parentElement?.closest(
              `.vditor-${currentMode}`,
            ),
          ),
          text: selection?.anchorNode?.textContent,
          offset: selection?.anchorOffset,
        }
      }, mode)
      expect(caret.inEditor).toBe(true)
      expect(caret.text).toBe('2')
      expect(caret.offset).toBeLessThanOrEqual(1)
    })
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    test(`${mode} uses a pointer selection and the one toolbar control to wrap then unwrap`, async ({
      page,
    }) => {
      await open(page, mode)
      const editor = mode === 'ir' ? '.vditor-ir' : '.vditor-wysiwyg'
      await selectTextByPointer(page, editor, 'Action H', '2')
      await expect(page.locator('[data-type="subscript"]')).toBeEnabled()
      // The pointer range selects the source character; the toolbar retains it before focus moves.
      await page.locator('[data-type="subscript"]').click()
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toContain('Action H<sub>2</sub>O.')

      const actionSubscript = page
        .locator('sub[data-vmde-html-subscript="1"]')
        .filter({ hasText: '2' })
        .last()
      await actionSubscript.click()
      await selectTextByPointer(page, editor, '', '2', 3)
      await expect(page.locator('[data-type="subscript"]')).toBeEnabled()
      await page.locator('[data-type="subscript"]').click()
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toContain('Action H2O.')
    })
  }

  test('SV uses pointer wrap/unwrap, an empty caret insertion, and toolbar Undo/Redo', async ({
    page,
  }) => {
    await open(page, 'sv')
    const editor = '.vditor-sv'
    await selectTextByPointer(page, editor, 'Action H', '2')
    await page.locator('[data-type="subscript"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('Action H<sub>2</sub>O.')

    await page.locator('[data-type="undo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('Action H2O.')
    await page.locator('[data-type="redo"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('Action H<sub>2</sub>O.')

    await selectTextByPointer(page, editor, '', '2', 3)
    await page.locator('[data-type="subscript"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('Action H2O.')

    await placeCaretByPointer(page, editor, 'Action H')
    await page.locator('[data-type="subscript"]').click()
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain('Action H<sub></sub>2O.')
  })
})

test.describe('HTML SUP presentation', () => {
  for (const mode of ['ir', 'wysiwyg'] as const) {
    for (const supSub of [false, true]) {
      test(`${mode} preserves authored SUP while generated footnote SUP stays undecorated (supSub=${supSub})`, async ({
        page,
      }) => {
        await open(page, mode, supSub)
        const editor = `.vditor-${mode}`
        const owned = page
          .locator(editor)
          .locator('sup[data-vmde-html-superscript="1"]')
        await expect(owned).toHaveCount(1)
        const state = await page.locator(editor).evaluate((root) => {
          const footnotes = Array.from(root.querySelectorAll('sup')).filter(
            (element) =>
              !element.hasAttribute('data-vmde-html-superscript') &&
              /footnote|\[\^note\]|1/u.test(element.textContent ?? ''),
          )
          return {
            footnotes: footnotes.map((element) => element.outerHTML),
            decoratedFootnotes: footnotes.filter((element) =>
              element.hasAttribute('data-vmde-html-superscript'),
            ).length,
          }
        })
        expect(state.footnotes).not.toHaveLength(0)
        expect(state.decoratedFootnotes).toBe(0)
      })
    }

    test(`${mode} toolbar wraps a new SUP selection through the shared command`, async ({
      page,
    }) => {
      await open(page, mode)
      const editor = mode === 'ir' ? '.vditor-ir' : '.vditor-wysiwyg'
      await selectTextByPointer(page, editor, 'Action H', '2')
      const superscript = page.locator('[data-type="superscript"]')
      await expect(superscript).toBeEnabled()
      await superscript.click()
      await expect
        .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
        .toContain('Action H<sup>2</sup>O.')
    })
  }
})
