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
        caret: (() => {
          const node = getSelection()!.anchorNode
          if (!(node instanceof Text)) return { before: '', after: '' }
          return {
            before: node.data.slice(
              Math.max(0, getSelection()!.anchorOffset - 2),
              getSelection()!.anchorOffset,
            ),
            after: node.data.slice(
              getSelection()!.anchorOffset,
              getSelection()!.anchorOffset + 4,
            ),
          }
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
  expect(result.caret).toEqual({ before: 'lo', after: 'nger' })

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

test('source table formatting preserves a noncollapsed selection and scroll, rejects read-only or stale modes, rolls back, and leaves contextmenu native', async ({
  page,
}) => {
  await page.goto('/rewrap.html?mode=sv')
  await page.waitForFunction(() => (window as any).__ready === true)
  const source = [
    ...Array.from({ length: 40 }, (_, index) => `before ${index}`),
    '',
    '| a |longer|',
    '|---|---|',
    '| x |z|',
    '',
    ...Array.from({ length: 40 }, (_, index) => `after ${index}`),
  ].join('\n')
  const result = await page.evaluate(
    ({ source }) => {
      const harness = (window as any).__tableFormat
      harness.editor.setValue(source)
      harness.setExactMarkdown(source)
      const root = harness.editor.vditor.sv.element as HTMLElement
      const reset = () => {
        harness.editor.setValue(source)
        harness.setExactMarkdown(source)
      }
      const select = (start: number, end: number) => {
        const points: Array<{ node: Text; offset: number }> = []
        for (const target of [start, end]) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          let remaining = target
          for (
            let node = walker.nextNode() as Text | null;
            node;
            node = walker.nextNode() as Text | null
          ) {
            if (remaining <= node.data.length) {
              points.push({ node, offset: remaining })
              break
            }
            remaining -= node.data.length
          }
        }
        const range = document.createRange()
        range.setStart(points[0]!.node, points[0]!.offset)
        range.setEnd(points[1]!.node, points[1]!.offset)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        document.dispatchEvent(new Event('selectionchange'))
      }
      const start = root.textContent!.indexOf('| a |')
      const end = root.textContent!.indexOf('| x |z|') + '| x |z|'.length - 1
      root.style.height = '100px'
      root.style.overflowY = 'auto'
      harness.setScrollTop(120)
      select(start, end)
      let prevented = false
      root.addEventListener('contextmenu', (event) => {
        prevented = event.defaultPrevented
      })
      root.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      )
      const formatted = harness.run()
      const selection = getSelection()!.getRangeAt(0)
      const selectionOffset = (node: Node, offset: number) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let value = 0
        for (
          let text = walker.nextNode() as Text | null;
          text;
          text = walker.nextNode() as Text | null
        ) {
          if (text === node) return value + offset
          value += text.data.length
        }
        return -1
      }
      const retained = {
        start: selectionOffset(selection.startContainer, selection.startOffset),
        end: selectionOffset(selection.endContainer, selection.endOffset),
        selected: selection.toString(),
        scrollTop: harness.state().scrollTop,
      }

      reset()
      root.setAttribute('contenteditable', 'false')
      select(
        root.textContent!.indexOf('longer'),
        root.textContent!.indexOf('longer'),
      )
      const readOnly = harness.run()
      root.setAttribute('contenteditable', 'true')

      reset()
      const inner = harness.editor.vditor
      const originalCheckpoint = inner.undo.addToUndoStack
      let checkpoints = 0
      inner.undo.addToUndoStack = (...args: any[]) => {
        checkpoints++
        if (checkpoints === 2) throw new Error('forced rollback')
        return originalCheckpoint(...args)
      }
      select(
        root.textContent!.indexOf('longer'),
        root.textContent!.indexOf('longer'),
      )
      const beforeRollback = root.textContent
      const rollback = harness.run()
      const afterRollback = root.textContent
      inner.undo.addToUndoStack = originalCheckpoint

      reset()
      select(
        root.textContent!.indexOf('longer'),
        root.textContent!.indexOf('longer'),
      )
      const modeBefore = inner.currentMode
      inner.currentMode = 'ir'
      const mode = harness.run()
      inner.currentMode = modeBefore
      return {
        formatted,
        prevented,
        retained,
        readOnly,
        rollback,
        beforeRollback,
        afterRollback,
        mode,
        exacts: harness.state().exacts,
      }
    },
    { source },
  )

  expect(result.formatted).toBe(true)
  expect(result.prevented).toBe(false)
  expect(result.retained.start).toBeGreaterThan(0)
  expect(result.retained.end).toBeGreaterThan(result.retained.start)
  expect(result.retained.selected).toContain('longer')
  expect(result.retained.scrollTop).toBe(120)
  expect(result.readOnly).toBe(false)
  expect(result.rollback).toBe(false)
  expect(result.afterRollback).toBe(result.beforeRollback)
  expect(result.mode).toBe(false)
  expect(result.exacts).toBe(1)
})
