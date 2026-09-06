import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// ECharts must stay responsive to a window/pane resize. echarts.init installs no resize handler, so
// without installEchartsResize the chart keeps its old pixel width when the editor widens — it stays
// anchored left while the container grows to the right ("lewa nie zmienia, prawa rozciąga się w
// prawo"). installEchartsResize (window 'resize' listener) resizes every instance to fill its
// container. We widen the editor by hiding the sidebar and assert the canvas tracks the container.
const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('echarts canvas tracks its container when the editor pane is resized', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame
    .locator('.vditor-ir__preview .language-echarts canvas')
    .first()
    .waitFor({ timeout: 45_000 })

  const measure = () =>
    frame.locator('body').evaluate(() => {
      const ech = document.querySelector(
        '.vditor-ir__preview .language-echarts',
      ) as HTMLElement
      const cv = ech.querySelector('canvas') as HTMLCanvasElement
      return {
        container: Math.round(ech.getBoundingClientRect().width),
        canvas: Math.round(cv.getBoundingClientRect().width),
      }
    })

  const near = (a: number, b: number) => Math.abs(a - b) <= 2
  // Initial render settle (was: setTimeout 3000ms): poll for the SAME near-fit the sanity
  // assertion below reads, instead of a blind wait — this is the completion signal the assertion
  // already checks, not a guess at a shorter delay.
  let before = { container: 0, canvas: 0 }
  await expect
    .poll(
      async () => {
        before = await measure()
        return near(before.canvas, before.container)
      },
      { timeout: 10_000, intervals: [300, 600, 1000, 1500] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // Sanity: the chart filled its container before the resize.
  expect.soft(near(before.canvas, before.container)).toBe(true)

  // Widen the editor pane: hide the sidebar → the webview (and the echarts container) grows.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand(
      'workbench.action.toggleSidebarVisibility',
    )
  })
  // Let the sidebar collapse animation settle, then fire a resize. A real window drag emits resize
  // events continuously (chart tracks live); the sidebar toggle animates, so we assert the
  // deterministic contract: once a resize event arrives, the visible chart fits its settled
  // container. Poll (the webview can throttle timers when backgrounded), re-firing resize each tick.
  // task 512: leave as a sleep — the thing settling here is VS Code's OWN sidebar-collapse CSS
  // transition, which carries no marker in our code. A width-stability poll ("stopped changing for
  // N reads") is exactly the geometry-quiescence-across-an-animation shape task 451 excluded
  // (`wysiwyg-parity`/`mode-switch-parity`): an eased transition can read as momentarily stable
  // mid-flight, giving a false-early poll resolution. This region was already reworked once into a
  // poll (see the "Fire ONE resize" comment below) and this 2000ms survived that pass deliberately.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 2000)))
  // Fire ONE resize after the pane has settled, then poll WITHOUT re-firing: the listener's
  // trailing timer may be clamped to ~1s while the webview is backgrounded, and re-firing every
  // poll tick would keep re-arming (resetting) it so it never elapses.
  await frame
    .locator('body')
    .evaluate(() => window.dispatchEvent(new Event('resize')))
  await expect.soft
    .poll(
      async () => {
        const m = await measure()
        // eslint-disable-next-line no-console
        console.log(`[resize] ${JSON.stringify(m)}`)
        return (
          m.container > before.container + 20 && near(m.canvas, m.container)
        )
      },
      { timeout: 15_000, intervals: [400, 600, 1000, 1500] },
    )
    .toBe(true)
  // Restore the initial pane width before the independent Preview-resize contract below.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand(
      'workbench.action.toggleSidebarVisibility',
    )
  })
  // task 512: leave — same reason as the sidebar-collapse settle above (VS Code's own CSS
  // transition, no code-level completion marker, width-stability polling is the excluded
  // geometry-quiescence-across-an-animation shape).
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 2000)))

  // A window resize that fires WHILE the full Preview overlay is shown must NOT collapse the hidden
  // IR chart to 0×0 — otherwise it stays blank after returning to edit ("po przełączeniu z preview na
  // edycję echarts się nie pojawia"). installEchartsResize skips hidden (clientWidth 0) containers.
  const irCanvas = () =>
    frame.locator('body').evaluate(() => {
      const cv = document.querySelector(
        '.vditor-ir__preview .language-echarts canvas',
      ) as HTMLCanvasElement | null
      return cv ? Math.round(cv.getBoundingClientRect().width) : -1
    })
  const wait = (ms: number) =>
    frame
      .locator('body')
      .evaluate((_b, m) => new Promise((r) => setTimeout(r, m)), ms)
  // Faithful to Vditor's Preview toolbar toggle (toolbar/Preview.ts): show preview + hide the
  // current edit mode's pane.
  const setPreview = (on: boolean) =>
    frame.locator('body').evaluate((_b, show) => {
      const v = (
        window as unknown as {
          vditor: {
            vditor: {
              currentMode: string
              preview: { element: HTMLElement; render: (x: unknown) => void }
              [mode: string]: unknown
            }
          }
        }
      ).vditor.vditor
      const editParent = (v[v.currentMode] as { element: HTMLElement }).element
        .parentElement as HTMLElement
      if (show) {
        v.preview.element.style.display = 'block'
        editParent.style.display = 'none'
        v.preview.render(v)
      } else {
        editParent.style.display = 'block'
        v.preview.element.style.display = 'none'
      }
    }, on)

  // task 512: the three `wait()` calls below all stay sleeps (rule 2) — this whole block is a
  // NEGATIVE scenario: fire a resize while the IR chart is hidden and prove it does NOT collapse
  // to 0×0. `wait(1500)` lets the preview chart's own render settle before the probing resize
  // (mirrors the initial-render settle pattern, but here nothing downstream asserts on the preview
  // chart's geometry — there's no positive floor to poll). `wait(600)` is the window in which a
  // buggy fit() would do its damage (a hidden-container collapse) before we flip back to edit —
  // shortening or polling it away would let a delayed regression slip past undetected. `wait(1500)`
  // after `setPreview(false)` guards a DELAYED post-unhide collapse (ResizeObserver firing on the
  // 0→width transition): a poll on `end > 0` would resolve the instant the canvas is first found
  // present and never wait around for a late collapse — exactly the coverage this settle exists
  // for (the `format-hotkeys` shape task 512 names).
  const start = await irCanvas()
  await setPreview(true)
  await frame
    .locator('.vditor-preview .language-echarts canvas')
    .first()
    .waitFor({ timeout: 30_000 })
  await wait(1500)
  // The resize that bit us: it arrives while the IR chart's container is display:none (width 0).
  await frame
    .locator('body')
    .evaluate(() => window.dispatchEvent(new Event('resize')))
  await wait(600)
  await setPreview(false)
  // task 512: retain — negative post-unhide observation window for a delayed canvas collapse
  await wait(1500)
  const end = await irCanvas()

  // eslint-disable-next-line no-console
  console.log(`[preview-resize] start=${start} end=${end}`)
  expect.soft(start).toBeGreaterThan(0)
  // The IR chart survived (was NOT collapsed to 0 by the in-preview resize).
  expect.soft(end).toBeGreaterThan(0)
})

// Direct width-tracking contract (narrow AND widen). Regression for the "stuck too-wide chart": the
// rendered chart's echarts instance is ORPHANED (getInstanceByDom → null), so `instance.resize()` was
// a silent no-op and the canvas never re-fit. The fix RECONSTRUCTS from source at the current width
// (echarts-fit.ts ResizeObserver → reconstructCharts). Before the fix the canvas stayed at its init
// width while the container shrank → this fails; after, it tracks both ways.
test('echarts canvas tracks the container on narrow and widen (viewport)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )
  const frame = wf(workbox)
  await frame
    .locator('.vditor-ir__preview .language-echarts canvas')
    .first()
    .waitFor({ timeout: 45_000 })

  const measure = () =>
    frame.locator('body').evaluate(() => {
      const el = document.querySelector(
        '.vditor-ir__preview .language-echarts',
      ) as HTMLElement | null
      const cv = el?.querySelector('canvas') as HTMLCanvasElement | null
      return {
        container: el ? Math.round(el.getBoundingClientRect().width) : -1,
        canvas: cv ? Math.round(cv.getBoundingClientRect().width) : -1,
      }
    })
  const fits = (m: { container: number; canvas: number }) =>
    m.canvas > 0 && Math.abs(m.canvas - m.container) <= 4

  // Initial render settle (was: setTimeout 3500ms): poll for the same `fits` condition the
  // assertion below reads.
  let initial = { container: -1, canvas: -1 }
  await expect
    .poll(
      async () => {
        initial = await measure()
        return fits(initial)
      },
      { timeout: 10_000, intervals: [300, 600, 1000, 1500] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  expect(fits(initial)).toBe(true)

  await workbox.setViewportSize({ width: 700, height: 950 })
  // Narrow settle (was: setTimeout 1600ms): poll the composite the assertions below read.
  let narrow = { container: -1, canvas: -1 }
  await expect
    .poll(
      async () => {
        narrow = await measure()
        return narrow.container < 300 && fits(narrow)
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[narrow] ${JSON.stringify(narrow)}`)
  expect(narrow.container).toBeLessThan(300)
  expect(fits(narrow)).toBe(true)

  await workbox.setViewportSize({ width: 1400, height: 950 })
  // Widen settle (was: setTimeout 1600ms): poll the composite the assertions below read.
  let wide = { container: -1, canvas: -1 }
  await expect
    .poll(
      async () => {
        wide = await measure()
        return wide.container > narrow.container && fits(wide)
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[wide] ${JSON.stringify(wide)}`)
  expect(wide.container).toBeGreaterThan(narrow.container)
  expect(fits(wide)).toBe(true)
})
