import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, waitForE2EReadiness, wf } from './webview-helpers'

// Task 573: diagnostic measurements, not a latency gate. Keep the private source out of tests;
// the synthetic fixture preserves word lengths and syntax workload. Each run boots real VS Code.
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

// Same privacy-safe small block-handle document used by block-handle.spec.ts.
const SMALL_BLOCK_HANDLE_FIXTURE = [
  'alpha',
  '',
  `${String.fromCharCode(96).repeat(3)}ts`,
  'const x = 1',
  String.fromCharCode(96).repeat(3),
  '',
  'omega',
  '',
].join('\n')

test('large synthetic document opening and pointer/scroll workload @probe', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const original = readFileSync(FIXTURE, 'utf8')
  const file = path.join(baseDir, 'large-document-probe.md')
  writeFileSync(file, original)
  await workbox.context().addInitScript(() => {
    const win = window as any
    const metrics = {
      phase: 'open',
      phases: {} as Record<
        string,
        {
          serializations: number
          serializationMs: number
          headerReads: number
          gaps: number[]
          longTasks: number[]
        }
      >,
    }
    win.__vmdeLargeDocumentProbe = metrics
    const sample = () =>
      (metrics.phases[metrics.phase] ??= {
        serializations: 0,
        serializationMs: 0,
        headerReads: 0,
        gaps: [],
        longTasks: [],
      })
    // Vditor is assigned before its asynchronous after() initialization. Wrapping the instance
    // here includes the initial-caret getValue call without changing any returned Markdown.
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
            const current = sample()
            current.serializations++
            current.serializationMs += performance.now() - started
          }
        }
      },
    })
    const getRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () {
      if (this.tagName === 'TH') sample().headerReads++
      return getRect.call(this)
    }
    new PerformanceObserver((list) => {
      sample().longTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      )
    }).observe({ type: 'longtask', buffered: true })
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
  const started = Date.now()
  await evaluateInVSCode(
    async (vscode, [uri]) => {
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
      message: 'large synthetic fixture did not become ready',
    },
  )
  const openToReadyMs = Date.now() - started
  // A bounded observation window records post-open work; this is not a readiness sleep.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const shape = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      mode: (window as any).vditor.getCurrentMode(),
      contentVisibility: document.body.classList.contains('vmde-large-doc'),
      blocks: root.children.length,
      tables: root.querySelectorAll('table').length,
      headers: root.querySelectorAll('th').length,
      codeBlocks: root.querySelectorAll('[data-type="code-block"]').length,
    }
  })
  expect(shape.tables).toBe(11)
  expect(shape.codeBlocks).toBe(36)
  const setPhase = (phase: string, targetFrame = frame) =>
    targetFrame.locator('body').evaluate((_body, label) => {
      const probe = (window as any).__vmdeLargeDocumentProbe
      probe.phase = label
      if (probe.sampling) return
      probe.sampling = true
      // The webview's boot-time document replacement can cancel an init-script rAF loop.
      // Begin sampling after mounting so missing samples can never masquerade as smooth frames.
      let last = performance.now()
      let previousPhase = label
      const tick = (now: number) => {
        if (!probe.sampling) return
        probe.phases[probe.phase] ??= {
          serializations: 0,
          serializationMs: 0,
          headerReads: 0,
          gaps: [],
          longTasks: [],
        }
        const current = probe.phases[probe.phase]
        if (previousPhase === probe.phase) current.gaps.push(now - last)
        previousPhase = probe.phase
        last = now
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, phase)

  await setPhase('pure-scroll')
  await frame.locator('body').evaluate(async () => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    for (let index = 0; index < 100; index++) {
      root.scrollTop = index * 500
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
    }
    root.scrollTop = 0
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  const box = (await frame.locator('.vditor-ir > .vditor-reset').boundingBox())!
  await setPhase('first-pointer')
  await workbox.mouse.move(box.x + box.width / 2, box.y + 180)
  await frame.locator('body').evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await setPhase('repeated-pointer-wheel')
  const pointerStarted = Date.now()
  for (let index = 0; index < 12; index++) {
    await workbox.mouse.move(
      box.x + box.width / 2 + (index % 2) * 12,
      box.y + 180 + (index % 3) * 10,
    )
    await workbox.mouse.wheel(0, 250)
    // Fixed input cadence is the workload, not a wait for product readiness.
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  await frame.locator('body').evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  const repeatedPointerWheelMs = Date.now() - pointerStarted
  const collectPhases = (targetFrame = frame) =>
    targetFrame.locator('body').evaluate(() => {
      const probe = (window as any).__vmdeLargeDocumentProbe
      const result = Object.fromEntries(
        Object.entries(probe.phases).map(([name, value]: [string, any]) => {
          const gaps = [...value.gaps].sort((a: number, b: number) => a - b)
          return [
            name,
            {
              serializations: value.serializations,
              serializationMs: Math.round(value.serializationMs),
              headerReads: value.headerReads,
              frames: gaps.length,
              p95GapMs: gaps.length
                ? Math.round(gaps[Math.floor(gaps.length * 0.95)])
                : null,
              maxGapMs: gaps.length ? Math.round(gaps.at(-1)) : null,
              longTasks: value.longTasks.length,
              longestTaskMs: Math.round(Math.max(0, ...value.longTasks)),
            },
          ]
        }),
      )
      probe.sampling = false
      probe.phase = 'after-measurement'
      return result
    })
  const phases = await collectPhases(frame)
  expect(phases['pure-scroll'].frames).toBeGreaterThan(90)
  expect(phases['repeated-pointer-wheel'].frames).toBeGreaterThan(0)
  // Boolean equality keeps fixture text out of assertion diffs and test reports.
  expect((await docText(evaluateInVSCode, file)) === original).toBe(true)
  expect(readFileSync(file, 'utf8') === original).toBe(true)

  // Close the large editor before opening the small control so wf() has one webview to target.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  })

  // Use the existing small block-handle document as a control for cold and warmed hover.
  // Report measurements only; the fixture text never appears in logs or assertion diffs.
  const smallFile = path.join(baseDir, 'small-block-handle-control.md')
  writeFileSync(smallFile, SMALL_BLOCK_HANDLE_FIXTURE)
  const smallOpenStarted = Date.now()
  await evaluateInVSCode(
    async (vscode, [uri]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [smallFile] as [string],
  )
  const smallFrame = wf(workbox)
  await waitForE2EReadiness(
    smallFrame,
    (state) => state.editorEpoch > 0 && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'small block-handle control readiness',
    },
  )
  const smallOpenToReadyMs = Date.now() - smallOpenStarted
  const smallShape = await smallFrame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    return {
      mode: (window as any).vditor.getCurrentMode(),
      contentVisibility: document.body.classList.contains('vmde-large-doc'),
      blocks: root.children.length,
      tables: root.querySelectorAll('table').length,
      headers: root.querySelectorAll('th').length,
      codeBlocks: root.querySelectorAll('[data-type="code-block"]').length,
    }
  })
  expect(smallShape.mode).toBe('ir')
  expect(smallShape.contentVisibility).toBe(false)
  const smallBlocks = smallFrame.locator('.vditor-ir .vditor-reset > p')
  const firstSmallBlock = await smallBlocks.nth(0).boundingBox()
  const secondSmallBlock = await smallBlocks.nth(1).boundingBox()
  expect(firstSmallBlock).not.toBeNull()
  expect(secondSmallBlock).not.toBeNull()
  await setPhase('small-first-pointer', smallFrame)
  await workbox.mouse.move(
    firstSmallBlock!.x + firstSmallBlock!.width / 2,
    firstSmallBlock!.y + firstSmallBlock!.height / 2,
  )
  await smallFrame.locator('body').evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await setPhase('small-repeated-pointer-wheel', smallFrame)
  const smallPointerStarted = Date.now()
  for (let index = 0; index < 12; index++) {
    const box = index % 2 ? secondSmallBlock! : firstSmallBlock!
    await workbox.mouse.move(
      box.x + box.width / 2 + (index % 2) * 6,
      box.y + box.height / 2,
    )
    await workbox.mouse.wheel(0, 50)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const smallPointerWheelMs = Date.now() - smallPointerStarted
  const smallPhases = await collectPhases(smallFrame)
  expect(smallPhases['small-repeated-pointer-wheel'].frames).toBeGreaterThan(0)
  expect(
    (await docText(evaluateInVSCode, smallFile)) === SMALL_BLOCK_HANDLE_FIXTURE,
  ).toBe(true)
  expect(readFileSync(smallFile, 'utf8') === SMALL_BLOCK_HANDLE_FIXTURE).toBe(
    true,
  )

  console.log(
    '[large-document]',
    JSON.stringify({
      large: { openToReadyMs, shape, repeatedPointerWheelMs, phases },
      smallControl: {
        openToReadyMs: smallOpenToReadyMs,
        shape: smallShape,
        pointerWheelMs: smallPointerWheelMs,
        phases: smallPhases,
      },
    }),
  )
})
