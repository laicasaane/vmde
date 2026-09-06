import { wf } from './webview-helpers'
// markmap fits its tree to the container only at create time → when the column narrows the svg
// element shrinks but the content clips (doesn't shrink). markmap-fit.ts re-fits every visible
// markmap instance (stashed on its svg by the esbuild patch) on a debounced window resize. This
// regresses BOTH IR and WYSIWYG (the user hit it in both). Real-VS-Code-only → headless via
// `xvfb-run -a npx playwright test markmap-resize.spec`.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

test('markmap content shrinks with the window in IR and WYSIWYG', async ({
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
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })

  const info = (mode: string) =>
    frame.locator('body').evaluate((_el, m) => {
      const sel = `${m} .language-markmap svg`
      const svg = document.querySelector(sel) as SVGSVGElement | null
      const g = svg?.querySelector('g')
      return {
        svgW: svg ? Math.round(svg.getBoundingClientRect().width) : null,
        contentW: g ? Math.round(g.getBoundingClientRect().width) : null,
        hasViewBox: !!svg?.getAttribute('viewBox'),
      }
    }, mode)

  // Initial render settle (was: setTimeout 3500ms): poll for the same wide-state floor the
  // assertion below reads (content width past 300px) — markmap's initial fit-at-create-time is a
  // one-shot layout, not an animation, so "reached the floor" is a real completion signal.
  let irWide: { svgW: number | null; contentW: number | null } = {
    svgW: null,
    contentW: null,
  }
  await expect
    .poll(
      async () => {
        irWide = await info('.vditor-ir__preview')
        return (irWide.contentW ?? 0) > 300
      },
      { timeout: 15_000, intervals: [300, 600, 1000, 1500] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[IR wide] ${JSON.stringify(irWide)}`)
  await workbox.setViewportSize({ width: 700, height: 900 })
  // Narrow settle (was: setTimeout 1200ms): poll the composite the assertions below read — this
  // only goes true once the debounced `mm.fit()` (markmap-fit.ts, TRAILING_MS 120) has re-fit the
  // tree to the narrower svg.
  let irNarrow: { svgW: number | null; contentW: number | null } = {
    svgW: null,
    contentW: null,
  }
  await expect
    .poll(
      async () => {
        irNarrow = await info('.vditor-ir__preview')
        return (
          (irNarrow.svgW ?? 999) < 300 &&
          (irNarrow.contentW ?? 999) <= (irNarrow.svgW ?? 0) + 8
        )
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[IR narrow] ${JSON.stringify(irNarrow)}`)
  // IR: the svg shrank, and the content re-fit INSIDE it (didn't stay clipped at its old size).
  expect(irWide.contentW ?? 0).toBeGreaterThan(300)
  expect(irNarrow.svgW ?? 999).toBeLessThan(300)
  expect(irNarrow.contentW ?? 999).toBeLessThanOrEqual((irNarrow.svgW ?? 0) + 8)

  await workbox.setViewportSize({ width: 1400, height: 900 })
  // task 512: leave as a sleep — two reasons stack. (1) ≤1s (not worth the flake risk alone).
  // (2) it is the settle immediately BEFORE the mode-switch toolbar click below, the exact shape
  // `block-fidelity` (task 451) had to revert after a poll-based replacement passed 28/28 solo yet
  // still flaked once inside the FAST tier for an unidentified reason in the click → `setEditMode`
  // path — do not convert a pre-mode-switch-click settle without re-reading that investigation.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 800)))
  await frame.locator('body').evaluate(() => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  // Post-click render settle (was: setTimeout 3500ms) — this is the wait AFTER the mode-switch
  // click fired (not the pre-click settle above), so it isn't the block-fidelity shape: poll for
  // the markmap svg to exist in the WYSIWYG preview with real content width. `wyWide` itself is
  // only logged below, never asserted — the poll condition is what actually gates readiness here.
  let wyWide: { svgW: number | null; contentW: number | null } = {
    svgW: null,
    contentW: null,
  }
  await expect
    .poll(
      async () => {
        wyWide = await info('.vditor-wysiwyg__preview')
        return (wyWide.contentW ?? 0) > 300
      },
      { timeout: 15_000, intervals: [300, 600, 1000, 1500] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[WY wide] ${JSON.stringify(wyWide)}`)
  await workbox.setViewportSize({ width: 700, height: 900 })
  // Narrow settle (was: setTimeout 1200ms): poll the composite the assertion below reads.
  let wyNarrow: { svgW: number | null; contentW: number | null } = {
    svgW: null,
    contentW: null,
  }
  await expect
    .poll(
      async () => {
        wyNarrow = await info('.vditor-wysiwyg__preview')
        return (
          (wyNarrow.svgW ?? 999) < 300 &&
          (wyNarrow.contentW ?? 999) <= (wyNarrow.svgW ?? 0) + 8
        )
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[WY narrow] ${JSON.stringify(wyNarrow)}`)
  // WYSIWYG: same — content fits the (now narrow) svg, not clipped/overflowing at its old size.
  expect(wyNarrow.svgW ?? 999).toBeLessThan(300)
  expect(wyNarrow.contentW ?? 999).toBeLessThanOrEqual((wyNarrow.svgW ?? 0) + 8)
})
