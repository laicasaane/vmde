import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { LARGE_MIXED_TARGET, largeMixedMarkdown } from './large-mixed-markdown'
import { wf } from './webview-helpers'

const COLUMN = 48
// Short enough that the typed edit is still unpublished when the auto-wrap fires (the proof maps
// that edit onto the host bytes), long enough that the first read finishes before it fires.
const DELAY_MS = 800
const TYPED = 'z'
// The counter watches only inputs that are a whole large document, as the Chromium case does.
const FULL_DOCUMENT_HTML_CHARS = 50_000

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of [
      'editor.wrapColumn',
      'editor.autoWrap',
      'editor.autoWrapDelay',
      'editor.defaultMode',
    ]) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    }
  })
})

// Task 672: proof-only auto-wrap keeps its two source-fidelity proofs, each of which serializes the
// whole IR document once (the exact-byte rebase proof in edit-sync and the live-DOM check in the
// source index). This pins that cost in production and records the long tasks of one firing.
test('proof-only auto-wrap on a large IR document serializes the full document twice, only after the delay', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const docPath = path.join(baseDir, 'auto-wrap-proof-cost.md')
  const initial = largeMixedMarkdown()
  writeFileSync(docPath, initial)
  await evaluateInVSCode(
    async (vscode, args: [string, number, number]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      const settings: Record<string, unknown> = {
        'editor.wrapColumn': args[1],
        'editor.autoWrap': false,
        'editor.autoWrapDelay': args[2],
        'editor.defaultMode': 'ir',
      }
      for (const [key, value] of Object.entries(settings))
        await config.update(key, value, vscode.ConfigurationTarget.Global)
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath, COLUMN, DELAY_MS] as [string, number, number],
  )

  const frame = wf(workbox)
  const surface = frame.locator('.vditor-ir').first()
  await surface.waitFor({ timeout: 60_000 })
  const docText = () =>
    evaluateInVSCode(
      async (vscode, args: [string]) =>
        vscode.workspace.textDocuments
          .find((doc) => doc.uri.fsPath === args[0])
          ?.getText() ?? '',
      [docPath] as [string],
    ) as Promise<string>
  const currentValue = () =>
    frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      return outer?.vditor?.lute ? outer.getValue() : null
    }) as Promise<string | null>
  await expect
    .poll(() => frame.locator('.language-mermaid svg').count(), {
      timeout: 60_000,
    })
    .toBe(4)
  await expect.poll(currentValue, { timeout: 30_000 }).toBe(initial)

  const placeCaretAfter = async (text: string) => {
    const block = frame
      .locator('.vditor-ir [data-block]', { hasText: text })
      .first()
    await block.scrollIntoViewIfNeeded()
    await block.click()
    await surface.evaluate((root, needle) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(needle)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + needle.length)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        ;(window as any).__vmdeRequestCaret?.({
          node: range.startContainer,
          offset: range.startOffset,
        })
        return
      }
      throw new Error(`${needle} not found in IR`)
    }, text)
  }

  // The first edit of a freshly opened document does its own cold work; take it with auto-wrap
  // off, as the other large-document spec does, so only the measured firing is counted.
  await placeCaretAfter(LARGE_MIXED_TARGET)
  await workbox.keyboard.type('w')
  await expect
    .poll(docText, { timeout: 20_000 })
    .toBe(initial.replace(LARGE_MIXED_TARGET, `${LARGE_MIXED_TARGET}w`))

  await frame.locator('body').evaluate((_body, threshold) => {
    const inner = (window as any).vditor.vditor
    const state = { fullIr: 0, longTasks: [] as number[] }
    const original = inner.lute.VditorIRDOM2Md.bind(inner.lute)
    inner.lute.VditorIRDOM2Md = (html: string) => {
      if (html.length > threshold) state.fullIr++
      return original(html)
    }
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        state.longTasks.push(Math.round(entry.duration))
    }).observe({ type: 'longtask' })
    ;(window as any).__task672 = state
  }, FULL_DOCUMENT_HTML_CHARS)
  const readState = () =>
    frame.locator('body').evaluate(() => (window as any).__task672) as Promise<{
      fullIr: number
      longTasks: number[]
    }>

  // Wait until the whole-document count stops moving between two reads.
  const untilCountSettles = async (interval: number) => {
    let previous = -1
    await expect
      .poll(
        async () => {
          const { fullIr } = await readState()
          const quiet = fullIr === previous
          previous = fullIr
          return quiet
        },
        { intervals: [interval], timeout: 30_000 },
      )
      .toBe(true)
  }

  // Positive control: the counter must fire on a whole-document serialization and ignore a small
  // one, otherwise a later zero or two proves nothing.
  const control = await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    const state = (window as any).__task672
    inner.lute.VditorIRDOM2Md('<p data-block="0">small</p>')
    const afterSmall = state.fullIr
    inner.lute.VditorIRDOM2Md(inner.ir.element.innerHTML)
    const afterWhole = state.fullIr
    state.fullIr = 0
    state.longTasks.length = 0
    return { afterSmall, afterWhole }
  })
  expect(control).toEqual({ afterSmall: 0, afterWhole: 1 })

  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.autoWrap', true, vscode.ConfigurationTarget.Global)
  })
  await placeCaretAfter(`${LARGE_MIXED_TARGET}w`)
  // Turning auto-wrap on and clicking into the block run their own whole-document work (measured:
  // one serialization after the setting change, two after the click). Wait until the count stops
  // moving, then count from zero so only the typing and the firing remain.
  await untilCountSettles(750)
  await frame.locator('body').evaluate(() => {
    const state = (window as any).__task672
    state.fullIr = 0
    state.longTasks.length = 0
  })
  await workbox.keyboard.type(TYPED)

  // Typing performs no whole-document serialization; the auto-wrap delay has not elapsed yet.
  const duringTyping = await readState()
  expect(duringTyping.fullIr).toBe(0)
  await frame
    .locator('body')
    .evaluate(() => ((window as any).__task672.longTasks.length = 0))
  // The firing: wait for the first whole-document serialization, then until the count stops moving.
  await expect
    .poll(async () => (await readState()).fullIr, { timeout: 30_000 })
    .toBeGreaterThan(0)
  await untilCountSettles(1500)
  const after = await readState()
  // Acceptance (Task 672): the measured cost is two whole-document serializations, both after the
  // delay. The long tasks of the firing are printed as the decision basis. Whether the wrapped
  // text reaches the host on this fixture is a separate question and is not asserted here.
  const hostText = await docText()
  const wrapped = !hostText.includes(`${LARGE_MIXED_TARGET}w${TYPED}`)
  console.log(
    `Task 672 proof-only auto-wrap: fullIr=${after.fullIr}, long tasks after the delay (ms)=${JSON.stringify(after.longTasks)}, host text changed by the wrap=${wrapped}`,
  )
  expect(after.fullIr).toBe(2)
})
