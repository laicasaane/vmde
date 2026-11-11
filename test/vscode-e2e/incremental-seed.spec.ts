import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { largeMixedMarkdown } from './large-mixed-markdown'
import {
  docText,
  ExtensionId,
  expectNoShadowMismatch,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

type SeedStats = {
  state: 'idle' | 'pending' | 'ready' | 'cancelled' | 'error'
  admissionReason: 'block-count' | 'nested-structure' | 'ordinary' | 'non-ir'
  sourceReason: 'source-blocks' | 'source-structure' | null
  hostMs: number
  batches: number
  maxBatchMs: number
  readyMs: number | null
  serializeCalls: number
  snapshotCalls: number
  fullFallbacks: number
  longTasks: number
  maxLongTaskMs: number
}

const SMALL = '# Small control\n\nordinary text\n'
const LARGE = largeMixedMarkdown()
const COMPLEX = readFileSync(
  path.resolve(process.cwd(), 'fixtures/large-structured-synthetic.md'),
  'utf8',
)
const complexLines = COMPLEX.split(/\r?\n/)
const targetStart = complexLines.findIndex(
  (line) =>
    line.length >= 90 && /^[A-Za-z]/.test(line) && !/[`*[\]|#]/.test(line),
)
if (targetStart < 0)
  throw new Error('structured fixture needs one long plain-text paragraph')
let targetEnd = targetStart + 1
while (targetEnd < complexLines.length && complexLines[targetEnd].trim())
  targetEnd++
const TARGET = complexLines.slice(targetStart, targetEnd).join('\n')
const TARGET_NEEDLE = complexLines[targetStart].slice(0, 60)

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of [
      'editor.autoWrap',
      'editor.autoWrapDelay',
      'editor.wrapColumn',
    ])
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
  })
})

test('complexity-aware IR seed stays off for small docs and ready before complex edits', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const smallFile = path.join(baseDir, 'incremental-small.md')
  const largeFile = path.join(baseDir, 'incremental-large.md')
  const complexFile = path.join(baseDir, 'incremental-complex.md')
  writeFileSync(smallFile, SMALL)
  writeFileSync(largeFile, LARGE)
  writeFileSync(complexFile, COMPLEX)

  const open = async (file: string) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    })
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
      { timeout: 60_000, message: `incremental seed readiness: ${file}` },
    )
    return frame
  }
  const readStats = (frame: ReturnType<typeof wf>) =>
    frame
      .locator('body')
      .evaluate(() => (window as any).__vmdeIncrementalSeedStats as SeedStats)

  let frame = await open(smallFile)
  await expect
    .poll(() => readStats(frame))
    .toMatchObject({
      state: 'idle',
      admissionReason: 'ordinary',
      sourceReason: null,
      hostMs: 0,
    })

  frame = await open(largeFile)
  await expect
    .poll(async () => (await readStats(frame)).state, { timeout: 60_000 })
    .toBe('ready')
  expect(await readStats(frame)).toMatchObject({
    admissionReason: 'block-count',
    sourceReason: 'source-blocks',
  })

  frame = await open(complexFile)
  await expect
    .poll(async () => (await readStats(frame)).state, { timeout: 60_000 })
    .toBe('ready')
  const seeded = await readStats(frame)
  expect(seeded.admissionReason).toBe('nested-structure')
  expect(seeded.sourceReason).toBe('source-structure')
  expect(seeded.batches).toBeGreaterThan(1)
  expect(seeded.maxBatchMs).toBeLessThan(50)
  expect(seeded.maxLongTaskMs).toBeLessThanOrEqual(50)
  expect(seeded.fullFallbacks).toBe(0)

  const snapshots = await frame.locator('body').evaluate(() => {
    const stats = (window as any).__vmdeIncrementalSeedStats as SeedStats
    const snapshot = (window as any).__vmdeE2ESnapshotMarkdown as () => string
    const editor = (window as any).vditor
    const beforeCalls = stats.serializeCalls
    const durations: number[] = []
    let markdown = ''
    for (let index = 0; index < 5; index++) {
      const started = performance.now()
      markdown = snapshot()
      durations.push(performance.now() - started)
    }
    return {
      exact: markdown === editor.getValue(),
      durations,
      serializeCalls: stats.serializeCalls - beforeCalls,
    }
  })
  expect(snapshots.exact).toBe(true)
  expect(snapshots.serializeCalls).toBe(0)
  expect(median(snapshots.durations)).toBeLessThanOrEqual(10)

  await frame.locator('.vditor-ir').click({ position: { x: 8, y: 8 } })
  const placed = await frame.locator('body').evaluate((_body, needle) => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir p'),
    ).find((paragraph) => paragraph.textContent?.includes(needle as string))
    if (!target) return false
    target.scrollIntoView({ block: 'center' })
    const text = target.lastChild
    if (!text) return false
    surface.focus({ preventScroll: true })
    const range = document.createRange()
    range.setStart(text, text.textContent?.length ?? 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).__task537EditLongTasks = []
    ;(window as any).__task537LuteCalls = []
    const outer = (window as any).vditor
    const inner = outer.vditor ?? outer
    const originalSerialize = inner.lute.VditorIRDOM2Md.bind(inner.lute)
    inner.lute.VditorIRDOM2Md = (html: string) => {
      const started = performance.now()
      const result = originalSerialize(html)
      ;(window as any).__task537LuteCalls.push({
        bytes: new TextEncoder().encode(html).length,
        duration: performance.now() - started,
      })
      return result
    }
    try {
      const observer = new PerformanceObserver((list) => {
        ;(window as any).__task537EditLongTasks.push(
          ...list.getEntries().map((entry) => ({
            startTime: entry.startTime,
            duration: entry.duration,
          })),
        )
      })
      observer.observe({ type: 'longtask', buffered: false })
      ;(window as any).__task537EditObserver = observer
    } catch {
      /* longtask API unavailable; seed batch metrics remain the deterministic gate */
    }
    return true
  }, TARGET_NEEDLE)
  expect(placed).toBe(true)
  const undoStackBefore = await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    return inner.undo.ir.undoStack.length as number
  })
  const edited = COMPLEX.replace(TARGET, `${TARGET}X`)
  await workbox.keyboard.type('X')
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(edited)
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const inner = (window as any).vditor.vditor
          return inner.undo.ir.undoStack.length as number
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(undoStackBefore)
  const editMetrics = await frame.locator('body').evaluate(() => {
    ;(window as any).__task537EditObserver?.disconnect()
    const entries = (window as any).__task537EditLongTasks as Array<{
      startTime: number
      duration: number
    }>
    return {
      maxLongTaskMs: entries.length
        ? Math.max(...entries.map((entry) => entry.duration))
        : 0,
      longTasks: entries,
      luteCalls: (window as any).__task537LuteCalls,
      seed: (window as any).__vmdeIncrementalSeedStats as SeedStats,
    }
  })
  expect(editMetrics.seed.state).toBe('ready')
  expect(editMetrics.seed.serializeCalls - seeded.serializeCalls).toBe(1)
  expect(editMetrics.luteCalls).toHaveLength(1)
  expect(editMetrics.luteCalls[0].bytes).toBeLessThan(5_000)
  expect(editMetrics.luteCalls[0].duration).toBeLessThanOrEqual(50)

  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(COMPLEX)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(edited)
  // Vditor's Redo arms a delayed after-render callback (`undoDelay`) whose input() schedules a
  // 250 ms debounced idle edit post. That post is legitimate and serializes dirty blocks, so let
  // it finish before measuring Preview: line below then counts Preview's own serialization.
  // No pending-edit flag is exposed to specs, so wait until serializeCalls has been unchanged
  // for longer than undoDelay + debounce + margin.
  let stableSince = Date.now()
  let lastCalls = (await readStats(frame)).serializeCalls
  await expect
    .poll(
      async () => {
        const calls = (await readStats(frame)).serializeCalls
        if (calls !== lastCalls) {
          lastCalls = calls
          stableSince = Date.now()
        }
        return Date.now() - stableSince
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(2_500)

  const beforePreviewCalls = (await readStats(frame)).serializeCalls
  await frame.locator('body').evaluate(() => {
    const snapshot = (window as any).__vmdePreviewSnapshot
    ;(window as any).__task537PreviewSnapshots = 0
    ;(window as any).__vmdePreviewSnapshot = () => {
      ;(window as any).__task537PreviewSnapshots++
      return snapshot()
    }
  })
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator('.vditor-preview')).toBeVisible()
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__task537PreviewSnapshots),
  ).toBe(1)
  expect((await readStats(frame)).serializeCalls).toBe(beforePreviewCalls)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator('.vditor-ir')).toBeVisible()
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator('.vditor-preview')).toBeVisible()
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).__task537PreviewSnapshots),
  ).toBe(1)
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  await expect(frame.locator('.vditor-ir')).toBeVisible()

  const external = `${edited}External update paragraph.\n`
  await evaluateInVSCode(
    async (vscode, args: [string, string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document) throw new Error('Task 537 document is not open')
      const edit = new vscode.WorkspaceEdit()
      edit.insert(
        document.uri,
        document.positionAt(document.getText().length),
        args[1],
      )
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error('Task 537 external update failed')
    },
    [complexFile, 'External update paragraph.\n'] as [string, string],
  )
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(external)
  await expect
    .poll(async () => (await readStats(frame)).state, { timeout: 60_000 })
    .toBe('ready')
  const afterExternal = await frame.locator('body').evaluate(() => {
    const stats = (window as any).__vmdeIncrementalSeedStats as SeedStats
    const beforeCalls = stats.serializeCalls
    const snapshot = (window as any).__vmdeE2ESnapshotMarkdown() as string
    return {
      exact: snapshot === (window as any).vditor.getValue(),
      serializeCalls: stats.serializeCalls - beforeCalls,
    }
  })
  expect(afterExternal).toEqual({ exact: true, serializeCalls: 0 })

  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.autoWrap',
      true,
      vscode.ConfigurationTarget.Global,
    )
    await config.update(
      'editor.autoWrapDelay',
      50,
      vscode.ConfigurationTarget.Global,
    )
    await config.update(
      'editor.wrapColumn',
      40,
      vscode.ConfigurationTarget.Global,
    )
  })
  await frame.locator('body').evaluate((_body, needle) => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('.vditor-ir p'),
    ).find((paragraph) => paragraph.textContent?.includes(needle as string))!
    const text = target.lastChild!
    const range = document.createRange()
    range.setStart(text, text.textContent?.length ?? 0)
    range.collapse(true)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    surface.focus({ preventScroll: true })
  }, TARGET_NEEDLE)
  const beforeAutoWrapStats = await readStats(frame)
  await workbox.keyboard.type('Y')
  const unwrappedTyped = external.replace(`${TARGET}X`, `${TARGET}XY`)
  await expect
    .poll(
      async () => {
        const current = await docText(evaluateInVSCode, complexFile)
        return current !== unwrappedTyped && current.includes('XY')
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const autoWrapped = await docText(evaluateInVSCode, complexFile)
  expect(autoWrapped).toContain('XY')
  const autoWrapSync = await readStats(frame)
  expect(
    autoWrapSync.snapshotCalls - beforeAutoWrapStats.snapshotCalls,
  ).toBeGreaterThan(0)
  expect(
    autoWrapSync.snapshotCalls - beforeAutoWrapStats.snapshotCalls,
  ).toBeLessThanOrEqual(2)
  expect(autoWrapSync.fullFallbacks).toBe(beforeAutoWrapStats.fullFallbacks)
  await evaluateInVSCode(
    async (vscode, args: [string, string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document) throw new Error('Task 537 document is not open')
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        args[1],
      )
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error('Task 537 Auto Wrap restore failed')
    },
    [complexFile, external] as [string, string],
  )
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(external)
  await expect
    .poll(async () => (await readStats(frame)).state, { timeout: 60_000 })
    .toBe('ready')

  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'Task 537 WYSIWYG readiness',
  })
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="ir"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'ir', {
    message: 'Task 537 IR return readiness',
  })
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(external)

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(complexFile, 'utf8')).toBe(external)

  frame = await open(complexFile)
  await expect(frame.locator('.vditor-ir')).toBeVisible()
  await expect.poll(() => docText(evaluateInVSCode, complexFile)).toBe(external)
  expect(readFileSync(complexFile, 'utf8')).toBe(external)

  await expectNoShadowMismatch(frame)
  console.log(
    `[task537] hostMs=${seeded.hostMs.toFixed(1)} readyMs=${seeded.readyMs?.toFixed(1)} batches=${seeded.batches} maxBatchMs=${seeded.maxBatchMs.toFixed(1)} maxSeedLongTaskMs=${seeded.maxLongTaskMs.toFixed(1)} snapshotMedianMs=${median(snapshots.durations).toFixed(2)} firstEditMaxLongTaskMs=${editMetrics.maxLongTaskMs.toFixed(1)}`,
  )
})
