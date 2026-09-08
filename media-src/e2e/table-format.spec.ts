import { expect, test } from './coverage-fixture'

test('source table formatting preserves surrounding bytes, caret, and one undo step', async ({
  page,
}) => {
  await page.goto('/rewrap.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  const beforeTable = '|a| longer |\r\n|:-|---:|\r\n|x\\|y|全角|'
  const afterTable =
    '| a   | longer |\r\n| :-- | -----: |\r\n| x\\|y |   全角 |'
  const source = [
    ...Array.from({ length: 40 }, (_, index) => `before ${index}`),
    '',
    beforeTable,
    '',
    ...Array.from({ length: 40 }, (_, index) => `after ${index}`),
    '',
  ].join('\r\n')
  const formatted = source.replace(beforeTable, afterTable)
  const result = await page.evaluate(
    ({ source }) => {
      const harness = (window as any).__tableFormat
      harness.editor.setValue(source)
      harness.setExactMarkdown(source)
      const root = harness.editor.vditor.sv.element as HTMLElement
      const offset = source.replace(/\r\n/g, '\n').indexOf('longer') + 2
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let remaining = offset
      let text: Text | null = null
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        if (remaining <= node.data.length) {
          text = node
          break
        }
        remaining -= node.data.length
      }
      if (!text) throw new Error('source caret target not found')
      const range = document.createRange()
      range.setStart(text, remaining)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return {
        result: harness.run(),
        raw: harness.editor.getValue(),
        text: root.textContent,
        selection: (() => {
          const active = getSelection()!.getRangeAt(0)
          const before = active.cloneRange()
          before.selectNodeContents(root)
          before.setEnd(active.startContainer, active.startOffset)
          return before.toString().length
        })(),
      }
    },
    { source },
  )

  expect(result.result).toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__tableFormat.state().exacts),
    )
    .toBe(1)
  expect(
    await page.evaluate(() => (window as any).__tableFormat.editor.getValue()),
  ).toBe(formatted.replace(/\r\n/g, '\n'))
  expect(
    await page.evaluate(() => (window as any).__tableFormat.state().lastExact),
  ).toBe(formatted)
  expect(
    await page.evaluate(() => (window as any).__tableFormat.state().caretText),
  ).toBe('longer')
  expect(result.selection).toBe(
    formatted.replace(/\r\n/g, '\n').indexOf('longer') + 2,
  )

  await page.evaluate(() => {
    const root = (window as any).__tableFormat.editor.vditor.sv
      .element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__tableFormat.editor.getValue()),
    )
    .toBe(`${source.replace(/\r\n/g, '\n')}\n`)
})

test('source table formatting retains a source caret after focus leaves the webview', async ({
  page,
}) => {
  await page.goto('/rewrap.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  const source = '|a| longer |\n|:-|---:|\n|x|全角|\n'
  const formatted = '| a | longer |\n| :- | -----: |\n| x |   全角 |\n'
  const result = await page.evaluate(
    ({ source }) => {
      const harness = (window as any).__tableFormat
      harness.editor.setValue(source)
      harness.setExactMarkdown(source)
      const root = harness.editor.vditor.sv.element as HTMLElement
      const text = document
        .createTreeWalker(root, NodeFilter.SHOW_TEXT)
        .nextNode() as Text
      const range = document.createRange()
      range.setStart(text, text.data.indexOf('longer') + 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus()
      const captured = harness.capture()
      // VS Code can replace the Range with Vditor's first-text start sentinel after it crosses focus.
      const focusLossRange = document.createRange()
      focusLossRange.setStart(text, 0)
      focusLossRange.collapse(true)
      root.blur()
      selection.removeAllRanges()
      selection.addRange(focusLossRange)
      document.dispatchEvent(new Event('selectionchange'))
      return { captured, result: harness.run() }
    },
    { source },
  )

  expect(result).toEqual({ captured: true, result: true })
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__tableFormat.state().lastExact),
    )
    .toBe(formatted)
})

test('source table formatting rejects a retained caret once its exact snapshot is stale', async ({
  page,
}) => {
  await page.goto('/rewrap.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  const source = '|a| longer |\n|:-|---:|\n|x|全角|\n'
  const result = await page.evaluate(
    ({ source }) => {
      const harness = (window as any).__tableFormat
      harness.editor.setValue(source)
      harness.setExactMarkdown(source)
      const root = harness.editor.vditor.sv.element as HTMLElement
      const text = document
        .createTreeWalker(root, NodeFilter.SHOW_TEXT)
        .nextNode() as Text
      const range = document.createRange()
      range.setStart(text, text.data.indexOf('longer') + 2)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      root.focus()
      document.dispatchEvent(new Event('selectionchange'))
      const beforeText = root.textContent
      harness.setExactMarkdown(`${source}host update\n`)
      selection.removeAllRanges()
      root.blur()
      return {
        result: harness.run(),
        beforeText,
        text: root.textContent,
        exacts: harness.state().exacts,
      }
    },
    { source },
  )

  expect(result.result).toBe(false)
  expect(result.exacts).toBe(0)
  expect(result.text).toBe(result.beforeText)
})
