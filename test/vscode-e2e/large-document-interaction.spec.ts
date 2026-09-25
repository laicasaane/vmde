import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import type { FrameLocator, Page } from '@playwright/test'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

interface Task573Metrics {
  getValueCalls: number
  getValueMs: number
  blockHandleSnapshotCalls: number
  blockTransformCaptureCalls: number
}

async function resetTask573Metrics(frame: FrameLocator): Promise<void> {
  await frame.locator('body').evaluate(() => {
    const metrics = (window as any).__vmdeBlockHandleCacheMetrics
    metrics.getValueCalls = 0
    metrics.getValueMs = 0
    metrics.blockHandleSnapshotCalls = 0
    metrics.blockTransformCaptureCalls = 0
  })
}

async function readTask573Metrics(
  frame: FrameLocator,
): Promise<Task573Metrics> {
  return frame.locator('body').evaluate(() => {
    const metrics = (window as any).__vmdeBlockHandleCacheMetrics
    return {
      getValueCalls: metrics.getValueCalls as number,
      getValueMs: Math.round(metrics.getValueMs as number),
      blockHandleSnapshotCalls: metrics.blockHandleSnapshotCalls as number,
      blockTransformCaptureCalls: metrics.blockTransformCaptureCalls as number,
    }
  })
}

async function readTask573Markdown(frame: FrameLocator): Promise<string> {
  return frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
}

async function observeTask573WysiwygMutations(
  frame: FrameLocator,
): Promise<void> {
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.wysiwyg.element as HTMLElement
    const state = { relevant: 0 }
    const record = (records: MutationRecord[]) => {
      for (const mutation of records) {
        if (mutation.type === 'attributes') {
          const name = mutation.attributeName ?? ''
          if (
            [
              'class',
              'style',
              'data-vmde-foldable',
              'data-vmde-list-foldable',
            ].includes(name) ||
            name.startsWith('aria-')
          )
            continue
        }
        state.relevant++
      }
    }
    const observer = new MutationObserver(record)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    ;(window as any).__vmdeTask573WysiwygObserver = { observer, record, state }
  })
}

async function drainTask573WysiwygMutations(
  frame: FrameLocator,
): Promise<number> {
  return frame.locator('body').evaluate(() => {
    const probe = (window as any).__vmdeTask573WysiwygObserver
    probe.record(probe.observer.takeRecords())
    const relevant = probe.state.relevant as number
    probe.state.relevant = 0
    return relevant
  })
}

async function waitTask573FramePaints(frame: FrameLocator): Promise<void> {
  await frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
}

async function measureTask573WysiwygPointerCache(
  frame: FrameLocator,
  workbox: Page,
): Promise<Record<string, unknown>> {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'large-document WYSIWYG block-handle readiness',
  })
  let lastSurfaceState: unknown = null
  try {
    await expect
      .poll(
        async () => {
          const state = await frame.locator('body').evaluate(() => {
            const inner = (window as any).vditor.vditor
            const activeRoot = inner.wysiwyg.element as HTMLElement | undefined
            const selectedRoot = document.querySelector<HTMLElement>(
              '.vditor-wysiwyg .vditor-reset',
            )
            const visibleBlocks = selectedRoot
              ? Array.from(
                  selectedRoot.querySelectorAll<HTMLElement>(
                    ':scope > [data-block]',
                  ),
                ).filter((block) => block.getClientRects().length > 0).length
              : 0
            return {
              mode: inner.currentMode as string,
              activeRootConnected: Boolean(activeRoot?.isConnected),
              activeRootMatchesSelector: activeRoot === selectedRoot,
              activeRootChildren: activeRoot?.children.length ?? 0,
              selectedRootChildren: selectedRoot?.children.length ?? 0,
              visibleBlocks,
            }
          })
          lastSurfaceState = state
          return (
            state.mode === 'wysiwyg' &&
            state.activeRootMatchesSelector &&
            state.visibleBlocks > 0
          )
        },
        { timeout: 90_000, message: 'large WYSIWYG surface population' },
      )
      .toBe(true)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `large WYSIWYG surface population; last=${JSON.stringify(lastSurfaceState)}; ${reason}`,
    )
  }
  const source = await readTask573Markdown(frame)
  await observeTask573WysiwygMutations(frame)
  await resetTask573Metrics(frame)
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))
  const idle = await readTask573Metrics(frame)
  expect(idle.getValueCalls).toBe(0)
  expect(idle.blockHandleSnapshotCalls).toBe(0)
  expect(idle.blockTransformCaptureCalls).toBe(0)
  expect((await readTask573Markdown(frame)) === source).toBe(true)
  const idleMutations = await drainTask573WysiwygMutations(frame)

  const paragraphs = frame.locator('#app .vditor-wysiwyg .vditor-reset > p')
  const first = paragraphs.nth(0)
  const second = paragraphs.nth(1)
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()
  await resetTask573Metrics(frame)
  const coldStarted = Date.now()
  await first.hover()
  const coldMs = Date.now() - coldStarted
  const cold = await readTask573Metrics(frame)
  expect(cold.blockHandleSnapshotCalls).toBeGreaterThan(0)
  expect((await readTask573Markdown(frame)) === source).toBe(true)
  const coldMutations = await drainTask573WysiwygMutations(frame)

  const settle: Array<Task573Metrics & { relevantMutations: number }> = []
  const settleStarted = Date.now()
  let quiet = 0
  for (let index = 0; index < 40 && quiet < 3; index++) {
    await resetTask573Metrics(frame)
    await frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
    await waitTask573FramePaints(frame)
    const metrics = await readTask573Metrics(frame)
    expect((await readTask573Markdown(frame)) === source).toBe(true)
    const relevantMutations = await drainTask573WysiwygMutations(frame)
    settle.push({ ...metrics, relevantMutations })
    if (
      metrics.blockHandleSnapshotCalls === 0 &&
      metrics.blockTransformCaptureCalls === 0 &&
      relevantMutations === 0
    )
      quiet++
    else quiet = 0
  }
  expect(quiet).toBeGreaterThanOrEqual(3)
  const settleMs = Date.now() - settleStarted
  const settleSummary = settle.reduce(
    (total, sample) => ({
      getValueCalls: total.getValueCalls + sample.getValueCalls,
      getValueMs: total.getValueMs + sample.getValueMs,
      blockHandleSnapshotCalls:
        total.blockHandleSnapshotCalls + sample.blockHandleSnapshotCalls,
      blockTransformCaptureCalls:
        total.blockTransformCaptureCalls + sample.blockTransformCaptureCalls,
      relevantMutations: total.relevantMutations + sample.relevantMutations,
    }),
    {
      getValueCalls: 0,
      getValueMs: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
      relevantMutations: 0,
    },
  )

  await resetTask573Metrics(frame)
  expect(await drainTask573WysiwygMutations(frame)).toBe(0)
  const warmStarted = Date.now()
  for (let index = 0; index < 30; index++)
    await (index % 2 === 0 ? first : second).hover()
  for (let index = 0; index < 12; index++) await workbox.mouse.wheel(0, 1)
  const warmMs = Date.now() - warmStarted
  const warm = await readTask573Metrics(frame)
  const warmMutations = await drainTask573WysiwygMutations(frame)
  expect((await readTask573Markdown(frame)) === source).toBe(true)
  expect(warm.blockHandleSnapshotCalls).toBe(0)
  expect(warm.blockTransformCaptureCalls).toBe(0)
  expect(warm.getValueCalls).toBe(0)
  expect(warmMutations).toBe(0)
  await frame.locator('body').evaluate(() => {
    ;(window as any).__vmdeTask573WysiwygObserver.observer.disconnect()
  })
  return {
    idle,
    idleMutations,
    coldMs,
    cold,
    coldMutations,
    settleIntervals: settle.length,
    settleMs,
    settle: settleSummary,
    warmMousemoves: 30,
    warmWheelEvents: 12,
    warmMs,
    warm,
    warmMutations,
    sourceUnchanged: true,
  }
}

test('nonempty large document opens without caret-admission serialization', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const original = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'large-document-caret-admission.md')
  writeFileSync(file, original)

  await workbox.context().addInitScript(() => {
    const win = window as any
    const metrics = { getValueCalls: 0, innerTextReads: 0 }
    win.__vmdeInitialCaretAdmissionProbe = metrics

    const innerTextDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'innerText',
    )
    if (!innerTextDescriptor?.get)
      throw new Error('HTMLElement.innerText getter missing')
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        if (this.tagName === 'CODE') metrics.innerTextReads++
        return innerTextDescriptor.get!.call(this)
      },
      set(value: string) {
        innerTextDescriptor.set?.call(this, value)
      },
    })

    // The extension assigns Vditor before its asynchronous after() initialization.
    // Wrap that instance so the admission path is measured without changing its return value.
    let editor: any
    Object.defineProperty(win, 'vditor', {
      configurable: true,
      get: () => editor,
      set(value) {
        editor = value
        if (!value?.getValue) return
        const getValue = value.getValue.bind(value)
        value.getValue = (...args: unknown[]) => {
          metrics.getValueCalls++
          return getValue(...args)
        }
      },
    })
  })

  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
    await vscode.workspace
      .getConfiguration('vmde')
      .update('restorePosition', false, true)
  })

  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )

  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'large synthetic fixture editor readiness',
    },
  )
  // Observe the complete post-ready init window; this is not used to accept readiness.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))

  const result = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      getValueCalls: (window as any).__vmdeInitialCaretAdmissionProbe
        .getValueCalls as number,
      innerTextReads: (window as any).__vmdeInitialCaretAdmissionProbe
        .innerTextReads as number,
      mode: (window as any).vditor.getCurrentMode() as string,
      contentVisibility: document.body.classList.contains('vmde-large-doc'),
      blocks: root.children.length,
      tables: root.querySelectorAll('table').length,
      headers: root.querySelectorAll('th').length,
      codeBlocks: root.querySelectorAll('[data-type="code-block"]').length,
    }
  })

  expect(result.mode).toBe('ir')
  expect(result.contentVisibility).toBe(true)
  expect(result.blocks).toBe(265)
  expect(result.tables).toBe(11)
  expect(result.headers).toBe(27)
  expect(result.codeBlocks).toBe(36)
  expect(result.getValueCalls).toBe(0)
  expect(result.innerTextReads).toBe(0)

  // Vditor places copy controls in its Preview render. Compare only booleans so failures never print the fixture.
  await frame.locator('.vditor-toolbar [data-type="preview"]').click()
  const copyButton = frame
    .locator('.vditor-preview .vditor-copy [data-vmde-copy-code]')
    .first()
  await copyButton.waitFor({ state: 'attached' })
  await copyButton.locator('xpath=ancestor::pre[1]').hover()
  const copyTextarea = copyButton.locator('xpath=../textarea')
  const expectedCopy = (await copyTextarea.inputValue())
    .split(String.fromCharCode(0x200b))
    .join('')
  const sourceBeforeCopy = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  await copyButton.click()
  await expect
    .poll(
      async () =>
        (await evaluateInVSCode(async (vscode: typeof import('vscode')) =>
          vscode.env.clipboard.readText(),
        )) === expectedCopy,
    )
    .toBe(true)
  const sourceAfterCopy = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  expect(sourceAfterCopy === sourceBeforeCopy).toBe(true)
  const innerTextReadsAfterCopy = await frame
    .locator('body')
    .evaluate(
      () =>
        (window as any).__vmdeInitialCaretAdmissionProbe
          .innerTextReads as number,
    )
  expect(innerTextReadsAfterCopy).toBe(0)

  // Equality checks report only a boolean so a failure cannot print fixture Markdown.
  expect((await docText(evaluateInVSCode, file)) === original).toBe(true)
  expect(readFileSync(file, 'utf8') === original).toBe(true)
})

test('large document keeps warmed block-handle pointer moves off the serializer in IR and WYSIWYG', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const original = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'large-document-block-handle-cache.md')
  writeFileSync(file, original)
  await workbox.context().addInitScript(() => {
    const win = window as any
    const metrics = {
      getValueCalls: 0,
      getValueMs: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
    }
    win.__vmdeBlockHandleCacheMetrics = metrics
    let editor: any
    Object.defineProperty(win, 'vditor', {
      configurable: true,
      get: () => editor,
      set(value) {
        editor = value
        if (!value?.getValue) return
        const getValue = value.getValue.bind(value)
        value.getValue = () => {
          const started = performance.now()
          try {
            return getValue()
          } finally {
            metrics.getValueCalls++
            metrics.getValueMs += performance.now() - started
          }
        }
      },
    })
  })
  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
    await vscode.workspace
      .getConfiguration('vmde')
      .update('restorePosition', false, true)
  })
  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'large synthetic fixture block-handle readiness',
    },
  )

  const modeSource = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  const paragraphs = frame.locator('#app .vditor-ir .vditor-reset > p')
  const first = paragraphs.nth(0)
  const second = paragraphs.nth(1)
  await expect(first).toBeVisible()
  await expect(second).toBeVisible()

  await frame.locator('body').evaluate(() => {
    const metrics = (window as any).__vmdeBlockHandleCacheMetrics
    metrics.getValueCalls = 0
    metrics.getValueMs = 0
    metrics.blockHandleSnapshotCalls = 0
    metrics.blockTransformCaptureCalls = 0
  })
  const coldStarted = Date.now()
  await first.hover()
  const coldMs = Date.now() - coldStarted
  const cold = await frame.locator('body').evaluate(() => ({
    getValueCalls: (window as any).__vmdeBlockHandleCacheMetrics
      .getValueCalls as number,
    getValueMs: Math.round(
      (window as any).__vmdeBlockHandleCacheMetrics.getValueMs as number,
    ),
    blockHandleSnapshotCalls: (window as any).__vmdeBlockHandleCacheMetrics
      .blockHandleSnapshotCalls as number,
    blockTransformCaptureCalls: (window as any).__vmdeBlockHandleCacheMetrics
      .blockTransformCaptureCalls as number,
  }))
  expect(cold.blockHandleSnapshotCalls).toBeGreaterThan(0)
  expect(
    (await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue())) === modeSource,
  ).toBe(true)

  await frame.locator('body').evaluate(() => {
    const metrics = (window as any).__vmdeBlockHandleCacheMetrics
    metrics.getValueCalls = 0
    metrics.getValueMs = 0
    metrics.blockHandleSnapshotCalls = 0
    metrics.blockTransformCaptureCalls = 0
  })
  const warmStarted = Date.now()
  for (let index = 0; index < 30; index++)
    await (index % 2 === 0 ? first : second).hover()
  for (let index = 0; index < 12; index++) await workbox.mouse.wheel(0, 1)
  const warmMs = Date.now() - warmStarted
  const warm = await frame.locator('body').evaluate(() => ({
    getValueCalls: (window as any).__vmdeBlockHandleCacheMetrics
      .getValueCalls as number,
    getValueMs: Math.round(
      (window as any).__vmdeBlockHandleCacheMetrics.getValueMs as number,
    ),
    blockHandleSnapshotCalls: (window as any).__vmdeBlockHandleCacheMetrics
      .blockHandleSnapshotCalls as number,
  }))
  expect(warm.blockHandleSnapshotCalls).toBe(0)
  expect(warm.getValueCalls).toBe(0)
  expect(
    (await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue())) === modeSource,
  ).toBe(true)
  const wysiwyg = await measureTask573WysiwygPointerCache(frame, workbox)

  expect((await docText(evaluateInVSCode, file)) === original).toBe(true)
  expect(readFileSync(file, 'utf8') === original).toBe(true)
  console.log(
    '[Task 573 block-handle cache]',
    JSON.stringify({
      ir: {
        coldMs,
        cold,
        warmMousemoves: 30,
        warmWheelEvents: 12,
        warmMs,
        warm,
      },
      wysiwyg,
    }),
  )
})

test('large document table scroll measures only header rows visible in the real scroller', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const original = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'large-document-table-geometry.md')
  writeFileSync(file, original)
  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
    await vscode.workspace
      .getConfiguration('vmde')
      .update('restorePosition', false, true)
  })
  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'large synthetic table geometry readiness',
    },
  )
  const sourceBefore = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)
  const scrollInfo = await frame.locator('body').evaluate(() => {
    const outer = (window as any).vditor
    const root = outer.vditor.ir.element as HTMLElement
    let scroller: HTMLElement | null = root
    while (scroller && scroller !== document.body) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (
        ['auto', 'scroll', 'overlay'].includes(overflowY) &&
        scroller.scrollHeight > scroller.clientHeight + 1
      )
        break
      scroller = scroller.parentElement
    }
    if (!scroller || scroller === document.body)
      scroller =
        (document.scrollingElement as HTMLElement) || document.documentElement
    ;(window as any).__task573TableRoot = root
    ;(window as any).__task573TableScroller = scroller
    const tables = Array.from(root.querySelectorAll<HTMLTableElement>('table'))
    const eligibleTableIndex = tables.findIndex((table) => {
      const row = table.rows[0]
      if (!row?.cells.length) return false
      if (Array.from(row.cells).some((cell) => cell.tagName !== 'TH'))
        return false
      if (table.querySelector('table,[colspan],[rowspan]')) return false
      if (
        table.closest(
          '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-type="html-block"], li, blockquote',
        )
      )
        return false
      return Array.from(table.rows).every(
        (candidate) => candidate.cells.length === row.cells.length,
      )
    })
    return {
      mode: outer.getCurrentMode() as string,
      rootTag: root.tagName,
      rootClass: root.className,
      scrollerTag: scroller.tagName,
      scrollerClass: scroller.className,
      scrollerOverflowY: getComputedStyle(scroller).overflowY,
      scrollerClientHeight: scroller.clientHeight,
      scrollerScrollHeight: scroller.scrollHeight,
      scrollerIsDocument: scroller === document.scrollingElement,
      tableCount: tables.length,
      headerCount: root.querySelectorAll('table th').length,
      eligibleTableIndex,
    }
  })
  const gapTop = await frame.locator('body').evaluate(async () => {
    const root = (window as any).__task573TableRoot as HTMLElement
    const scroller = (window as any).__task573TableScroller as HTMLElement
    const headers = Array.from(root.querySelectorAll<HTMLElement>('table th'))
    const clip = () => {
      if (scroller === document.scrollingElement)
        return { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
      const rect = scroller.getBoundingClientRect()
      const left = rect.left + scroller.clientLeft
      const top = rect.top + scroller.clientTop
      return {
        left,
        right: left + scroller.clientWidth,
        top,
        bottom: top + scroller.clientHeight,
      }
    }
    const waitFrames = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    const stride = Math.max(100, Math.floor(scroller.clientHeight / 3))
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    for (let top = stride; top < maximum; top += stride) {
      scroller.scrollTop = top
      await waitFrames()
      const bounds = clip()
      const visibleHeader = headers.some((header) => {
        const rect = header.getBoundingClientRect()
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
        )
      })
      if (!visibleHeader) return top
    }
    return -1
  })
  const offscreenHeaderReads = await frame
    .locator('body')
    .evaluate(async () => {
      const scroller = (window as any).__task573TableScroller as HTMLElement
      let reads = 0
      const originalRect = HTMLElement.prototype.getBoundingClientRect
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        writable: true,
        value: function (this: HTMLElement) {
          if (this.tagName === 'TH' && this.closest('.vditor-reset table'))
            reads++
          return originalRect.call(this)
        },
      })
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        writable: true,
        value: originalRect,
      })
      return reads
    })
  expect(scrollInfo.eligibleTableIndex).toBeGreaterThanOrEqual(0)
  const eligibleTable = frame
    .locator('.vditor-ir table')
    .nth(scrollInfo.eligibleTableIndex)
  const eligibleHeader = eligibleTable.locator('th').first()
  await eligibleHeader.scrollIntoViewIfNeeded()
  await expect(eligibleHeader).toBeVisible()
  const visibleHandle = frame
    .locator('.vmde-table-resize-handle:visible')
    .first()
  await expect(visibleHandle).toBeVisible()
  const visibleGeometry = await eligibleTable.evaluate((element) => {
    const table = element as HTMLTableElement
    const right = (
      table.rows[0].cells[0] as HTMLElement
    ).getBoundingClientRect().right
    const handles = Array.from(
      document.querySelectorAll<HTMLElement>('.vmde-table-resize-handle'),
    ).filter((handle) => getComputedStyle(handle).display !== 'none')
    const alignmentError = Math.min(
      ...handles.map((handle) => {
        const rect = handle.getBoundingClientRect()
        return Math.abs(right - (rect.left + rect.width / 2))
      }),
    )
    return { visibleHandleCount: handles.length, alignmentError }
  })
  console.log(
    '[Task 573 real table scroller]',
    JSON.stringify({
      ...scrollInfo,
      gapTop,
      offscreenHeaderReads,
      ...visibleGeometry,
    }),
  )
  expect(scrollInfo.mode).toBe('ir')
  expect(scrollInfo.scrollerScrollHeight).toBeGreaterThan(
    scrollInfo.scrollerClientHeight,
  )
  expect(scrollInfo.scrollerIsDocument).toBe(false)
  expect(scrollInfo.tableCount).toBe(11)
  expect(scrollInfo.headerCount).toBe(27)
  expect(gapTop).toBeGreaterThan(0)
  expect(offscreenHeaderReads).toBe(0)
  expect(visibleGeometry.visibleHandleCount).toBeGreaterThan(0)
  expect(visibleGeometry.alignmentError).toBeLessThan(3)
  expect(
    (await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue())) === sourceBefore,
  ).toBe(true)
  expect((await docText(evaluateInVSCode, file)) === original).toBe(true)
  expect(readFileSync(file, 'utf8') === original).toBe(true)
})
