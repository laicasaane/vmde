import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { LARGE_MIXED_TARGET, largeMixedMarkdown } from './large-mixed-markdown'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const STRESS = [
  '',
  '# Task 535 stress heading',
  '',
  '- parent stress item',
  '  - nested stress item',
  '- peer stress item',
  '',
  '',
  '| Stress | Value |',
  '| ------ | ----- |',
  '| alpha  | beta  |',
  '',
  '```d2',
  'client -> server',
  '```',
  '',
  '```wavedrom',
  '{ "signal": [{ "name": "clk", "wave": "p..." }] }',
  '```',
  '',
].join('\n')
const INITIAL = `${largeMixedMarkdown()}${STRESS}`
const HELPER_NAMES = [
  'section-fold-surface',
  'section-fold-app',
  'responsive-tables',
  'diagram-zoom',
  'diagram-controls',
  'custom-diagrams',
  'render-cache',
] as const

type ImpactStats = {
  rawCallbacks: number
  rawRecords: number
  helpers: Record<
    string,
    {
      callbacks: number
      records: number
      full: number
      local: number
      skipped: number
      blocks: number
    }
  >
}

test('large mixed edits stay mutation-local and preserve exact host state', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'mutation-local-helpers.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady &&
      state.editorEpoch > 0 &&
      state.mode === 'ir' &&
      Object.values(state.pending).every((count) => count === 0),
    { message: 'mutation-local large document readiness' },
  )
  await frame.locator('.language-d2 svg').last().waitFor({ timeout: 60_000 })
  await frame.locator('.language-mermaid svg').last().waitFor({
    timeout: 60_000,
  })

  const resetStats = () =>
    frame.locator('body').evaluate(() => {
      const stats = (window as any).__vmdeMutationImpactStats as ImpactStats
      stats.rawCallbacks = 0
      stats.rawRecords = 0
      stats.helpers = {}
    })
  const readStats = () =>
    frame
      .locator('body')
      .evaluate(() => (window as any).__vmdeMutationImpactStats as ImpactStats)
  const flushFrames = () =>
    frame
      .locator('body')
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
  const placeAtEnd = async (selector: string, needle: string) => {
    await frame.locator('.vditor-ir').click({ position: { x: 8, y: 8 } })
    const placed = await frame.locator('body').evaluate(
      (_body, args: [string, string]) => {
        const candidates = Array.from(
          document.querySelectorAll<HTMLElement>(args[0]),
        )
        const target = candidates.find((element) =>
          element.textContent?.includes(args[1]),
        )
        if (!target) return false
        target.scrollIntoView({ block: 'center' })
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.parentElement?.closest(
              '.vditor-ir__marker, .vditor-ir__preview, [data-render]',
            )
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT
          },
        })
        let text: Text | null = null
        let next = walker.nextNode() as Text | null
        while (next) {
          text = next
          next = walker.nextNode() as Text | null
        }
        if (!text) return false
        target.focus({ preventScroll: true })
        const range = document.createRange()
        range.setStart(text, text.data.length)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return true
      },
      [selector, needle] as [string, string],
    )
    expect(placed, `could not place caret at ${needle}`).toBe(true)
  }
  const expectNoFullPass = async () => {
    await flushFrames()
    const stats = await readStats()
    expect(stats.rawCallbacks).toBeGreaterThan(0)
    expect(stats.rawRecords).toBeGreaterThan(0)
    for (const name of HELPER_NAMES) {
      const helper = stats.helpers[name]
      expect(helper, `${name} stats`).toBeDefined()
      expect(helper.callbacks, `${name} callbacks`).toBeGreaterThan(0)
      expect(helper.records, `${name} records`).toBeGreaterThan(0)
      expect(helper.full, `${name} full passes`).toBe(0)
    }
    for (const name of [
      'diagram-zoom',
      'diagram-controls',
      'custom-diagrams',
      'render-cache',
    ])
      expect(stats.helpers[name].local, `${name} local passes`).toBeGreaterThan(
        0,
      )
    return stats
  }
  const replaceDocument = (content: string) =>
    evaluateInVSCode(
      async (vscode, args: [string, string]) => {
        const document = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === args[0],
        )!
        const last = document.lineAt(document.lineCount - 1)
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          document.uri,
          new vscode.Range(0, 0, last.range.end.line, last.range.end.character),
          args[1],
        )
        await vscode.workspace.applyEdit(edit)
      },
      [file, content] as [string, string],
    )

  await placeAtEnd('.vditor-ir p', LARGE_MIXED_TARGET)
  const beforeViewport = await frame
    .locator('.vditor-ir > .vditor-reset')
    .evaluate((surface) => surface.scrollTop)
  await resetStats()
  await frame.locator('body').evaluate(() => {
    const state = { blockingMs: 0, maxGapMs: 0, running: true }
    ;(window as any).__task535Timing = state
    let previous = performance.now()
    const tick = () => {
      const now = performance.now()
      const gap = now - previous
      previous = now
      if (gap > 20) {
        state.blockingMs += gap - 16.7
        state.maxGapMs = Math.max(state.maxGapMs, gap)
      }
      if (state.running) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await workbox.keyboard.type('ABCDEFGH', { delay: 15 })
  for (let index = 0; index < 8; index++)
    await workbox.keyboard.press('Backspace')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  const proseStats = await expectNoFullPass()
  expect(proseStats.rawRecords).toBeLessThan(1_044)
  const interaction = await frame.locator('body').evaluate(() => {
    const timing = (window as any).__task535Timing
    timing.running = false
    const selection = getSelection()
    const target = selection?.anchorNode?.parentElement?.closest('p') ?? null
    const caretRange = document.createRange()
    if (target && selection?.anchorNode) {
      caretRange.selectNodeContents(target)
      caretRange.setEnd(selection.anchorNode, selection.anchorOffset)
    }
    return {
      blockingMs: timing.blockingMs as number,
      maxGapMs: timing.maxGapMs as number,
      focused: document.activeElement?.closest('.vditor-ir') !== null,
      caretInTarget:
        target?.textContent?.includes('TARGET alpha beta') === true,
      caretOffset: target ? caretRange.toString().length : -1,
      targetLength: target?.textContent?.length ?? -1,
    }
  })
  const afterViewport = await frame
    .locator('.vditor-ir > .vditor-reset')
    .evaluate((surface) => surface.scrollTop)
  expect(interaction.focused).toBe(true)
  expect(interaction.caretInTarget).toBe(true)
  expect(interaction.caretOffset).toBe(interaction.targetLength)
  expect(Math.abs(afterViewport - beforeViewport)).toBeLessThan(160)
  console.log(
    `[task535] rawRecords=${proseStats.rawRecords} blockingMs=${interaction.blockingMs.toFixed(1)} maxGapMs=${interaction.maxGapMs.toFixed(1)}`,
  )

  for (const [selector, needle] of [
    ['.vditor-ir li', 'peer stress item'],
    ['.vditor-ir td', 'beta'],
  ] as const) {
    await placeAtEnd(selector, needle)
    await resetStats()
    await workbox.keyboard.type('X')
    await workbox.keyboard.press('Backspace')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
    await expectNoFullPass()
  }

  await placeAtEnd('.vditor-ir li', 'peer stress item')
  await resetStats()
  const itemCount = await frame.locator('.vditor-ir li').count()
  await workbox.keyboard.press('Enter')
  await expect(frame.locator('.vditor-ir li')).toHaveCount(itemCount + 1)
  await flushFrames()
  const splitStats = await readStats()
  expect(splitStats.rawRecords).toBeGreaterThan(0)
  expect(splitStats.helpers['section-fold-surface']).toBeDefined()
  expect(splitStats.helpers['section-fold-surface'].local).toBeGreaterThan(0)
  expect(splitStats.helpers['responsive-tables']).toBeDefined()
  expect(splitStats.helpers['responsive-tables'].full).toBe(0)
  expect(splitStats.helpers['responsive-tables'].skipped).toBeGreaterThan(0)
  for (const name of [
    'diagram-zoom',
    'diagram-controls',
    'custom-diagrams',
    'render-cache',
  ]) {
    expect(splitStats.helpers[name], `${name} split stats`).toBeDefined()
    expect(splitStats.helpers[name].full, `${name} split full passes`).toBe(0)
    expect(
      splitStats.helpers[name].local,
      `${name} split local passes`,
    ).toBeGreaterThan(0)
  }
  await resetStats()
  await workbox.keyboard.press('Backspace')
  await expect(frame.locator('.vditor-ir li')).toHaveCount(itemCount)
  await flushFrames()
  const mergeStats = await readStats()
  expect(mergeStats.rawRecords).toBeGreaterThan(0)
  expect(mergeStats.helpers['section-fold-surface']).toBeDefined()
  expect(mergeStats.helpers['section-fold-surface'].full).toBeGreaterThan(0)
  expect(mergeStats.helpers['responsive-tables']).toBeDefined()
  expect(mergeStats.helpers['responsive-tables'].full).toBe(0)
  expect(mergeStats.helpers['responsive-tables'].skipped).toBeGreaterThan(0)
  for (const name of [
    'diagram-zoom',
    'diagram-controls',
    'custom-diagrams',
    'render-cache',
  ]) {
    const helper = mergeStats.helpers[name]
    expect(helper, `${name} merge stats`).toBeDefined()
    expect(helper.callbacks, `${name} merge callbacks`).toBeGreaterThan(0)
    expect(helper.records, `${name} merge records`).toBeGreaterThan(0)
    expect(
      helper.full + helper.local,
      `${name} merge routed passes`,
    ).toBeGreaterThan(0)
  }
  await replaceDocument(`${INITIAL}\n`)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(`${INITIAL}\n`)
  await replaceDocument(INITIAL)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(() => (window as any).__vmdeIncrementalSeedStats?.state),
      { timeout: 60_000 },
    )
    .toBe('ready')

  await placeAtEnd('.vditor-ir p', LARGE_MIXED_TARGET)
  await workbox.keyboard.type('Z')
  await expect
    .poll(() => docText(evaluateInVSCode, file))
    .toContain(`${LARGE_MIXED_TARGET}Z`)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)

  await resetStats()
  await placeAtEnd('.vditor-ir h1', 'Task 535 stress heading')
  await workbox.keyboard.type('!')
  const EDITED = INITIAL.replace(
    '# Task 535 stress heading',
    '# Task 535 stress heading!',
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EDITED)
  await flushFrames()
  const headingStats = await readStats()
  expect(
    headingStats.helpers['section-fold-surface']?.full ?? 0,
  ).toBeGreaterThan(0)
  expect(headingStats.helpers['section-fold-app']?.full ?? 0).toBe(0)

  const EXTERNAL = `${EDITED}\nExternal replacement paragraph.\n`
  await resetStats()
  await replaceDocument(EXTERNAL)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EXTERNAL)
  await expect(
    frame.locator('.vditor-ir p').filter({ hasText: 'External replacement' }),
  ).toHaveCount(1)
  await flushFrames()
  const externalStats = await readStats()
  expect(externalStats.rawRecords).toBeGreaterThan(0)
  expect(externalStats.helpers['section-fold-surface']).toBeDefined()
  expect(externalStats.helpers['section-fold-surface'].full).toBeGreaterThan(0)
  expect(externalStats.helpers['responsive-tables']).toBeDefined()
  // The host update is applied by units, so the table helper gets no whole pass.
  expect(externalStats.helpers['responsive-tables'].full).toBe(0)
  for (const name of [
    'diagram-zoom',
    'diagram-controls',
    'custom-diagrams',
    'render-cache',
  ]) {
    expect(externalStats.helpers[name], `${name} external stats`).toBeDefined()
    expect(
      externalStats.helpers[name].full,
      `${name} external full passes`,
    ).toBeGreaterThan(0)
  }
  await replaceDocument(EDITED)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(EDITED)

  await resetStats()
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'mutation-local WYSIWYG rebuild readiness',
  })
  await flushFrames()
  const modeStats = await readStats()
  expect(modeStats.helpers['section-fold-app']).toBeDefined()
  expect(modeStats.helpers['section-fold-app'].full).toBeGreaterThan(0)
  expect(modeStats.helpers['responsive-tables']).toBeDefined()
  expect(modeStats.helpers['responsive-tables'].full).toBeGreaterThan(0)
  for (const name of [
    'diagram-zoom',
    'diagram-controls',
    'custom-diagrams',
    'render-cache',
  ]) {
    expect(modeStats.helpers[name], `${name} mode stats`).toBeDefined()
    expect(
      modeStats.helpers[name].full,
      `${name} mode full passes`,
    ).toBeGreaterThan(0)
  }

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(EDITED)
})
