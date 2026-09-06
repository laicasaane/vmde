import { wf } from './webview-helpers'
// abc + mindmap responsiveness (shrink with a narrowing window).
//   abc: abcjs renders an svg with NO viewBox → CSS max-width shrinks the svg box but the notation
//        clips (doesn't scale). abc-fit.ts adds a viewBox from its width/height attrs so it scales.
//   mindmap: the IR-pane mindmap is a snapshot canvas with NO retrievable ECharts instance, so the
//        echarts resize() handler is a no-op. echarts-fit.ts reconstructs it from data-code at the
//        new size on window resize (reconstructMindmaps).
// Real-VS-Code-only → headless via `xvfb-run -a npx playwright test diagram-resize.spec`.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

// Poll until `read()` returns the SAME nonzero value on two consecutive checks. abc's viewBox
// rescale is a single synchronous re-layout, not an eased animation — but a bare ">0" poll
// (tried first, task 512) caught a STALE narrow-viewport measurement that happened to already be
// nonzero right after a viewport widen + mode switch, before the real wide layout had landed
// (flaked `wyAbcNarrow < wyAbcWide` once in a --repeat-each=2 run: both read 21, the narrow value,
// because the "wide" baseline was captured too early). Requiring the value to repeat across an
// interval is a real completion signal that doesn't depend on knowing the fixture's exact width.
async function pollStable(
  read: () => Promise<number | null>,
  opts: { timeout: number; intervals: number[] },
): Promise<number> {
  let prev = -1
  let val = 0
  await expect
    .poll(async () => {
      val = (await read()) ?? 0
      const stable = val > 0 && val === prev
      prev = val
      return stable
    }, opts)
    .toBe(true)
    .catch(() => {
      /* best-effort — the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  return val
}

test('abc content + mindmap shrink with the window (IR and WYSIWYG)', async ({
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

  // abc: a child path's on-screen width reflects whether the CONTENT scaled (not just the svg box).
  const abcPath = (pane: string) =>
    frame.locator('body').evaluate((_el, p) => {
      const path = document.querySelector(
        `${p} .language-abc svg path, ${p} .language-abc svg g`,
      )
      return path ? Math.round(path.getBoundingClientRect().width) : null
    }, pane)
  const mmCanvas = (pane: string) =>
    frame.locator('body').evaluate((_el, p) => {
      const c = document.querySelector(`${p} .language-mindmap canvas`)
      return c ? Math.round(c.getBoundingClientRect().width) : null
    }, pane)

  // ── IR: wide → narrow ──
  // Initial render settle (was: setTimeout 4000ms): poll each wide-state value to STABILITY (see
  // pollStable) instead of a blind wait or a bare presence check.
  const irAbcWide = await pollStable(() => abcPath('.vditor-ir__preview'), {
    timeout: 15_000,
    intervals: [300, 600, 1000, 1500],
  })
  const irMmWide = await pollStable(() => mmCanvas('.vditor-ir__preview'), {
    timeout: 15_000,
    intervals: [300, 600, 1000, 1500],
  })
  await workbox.setViewportSize({ width: 700, height: 900 })
  // Narrow settle (was: setTimeout 1500ms): poll the composite the assertions below read (abc
  // shrank under its wide width, mindmap canvas dropped under 300px) — the debounced resize
  // handlers (abc-fit's CSS reflow, echarts-fit's reconstructMindmaps, TRAILING_MS 120) have
  // fired by the time this resolves.
  let irAbcNarrow = 999
  let irMmNarrow = 999
  await expect
    .poll(
      async () => {
        irAbcNarrow = (await abcPath('.vditor-ir__preview')) ?? 999
        irMmNarrow = (await mmCanvas('.vditor-ir__preview')) ?? 999
        return irAbcNarrow < irAbcWide && irMmNarrow < 300
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(
    `[IR] abc ${irAbcWide}->${irAbcNarrow}  mm ${irMmWide}->${irMmNarrow}`,
  )
  // abc notation scaled DOWN with the column (was clipped/static before the viewBox fix).
  expect(irAbcWide ?? 0).toBeGreaterThan(0)
  expect(irAbcNarrow ?? 999).toBeLessThan(irAbcWide ?? 0)
  // mindmap canvas shrank (reconstructed at the new width; resize() alone was a no-op).
  expect(irMmWide ?? 0).toBeGreaterThan(300)
  expect(irMmNarrow ?? 999).toBeLessThan(300)

  // ── WYSIWYG abc ──
  await workbox.setViewportSize({ width: 1400, height: 900 })
  // task 512: leave as a sleep — two independent reasons stack here, not just one. (1) ≤1s
  // (rule: not worth the flake risk on its own). (2) it is the settle immediately BEFORE the
  // mode-switch toolbar click below, the exact shape `block-fidelity` (task 451) had to revert
  // after a poll-based replacement passed 28/28 solo yet still flaked once inside the FAST tier
  // for an unidentified reason in the click → `setEditMode` path — do not re-attempt converting
  // a pre-mode-switch-click settle without re-reading that investigation first.
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
  // click fired (not the pre-click settle above), so it isn't the block-fidelity shape: poll the
  // abc block's WYSIWYG preview content to STABILITY (see pollStable) rather than a bare presence
  // check.
  const wyAbcWide = await pollStable(
    () => abcPath('.vditor-wysiwyg__preview'),
    { timeout: 15_000, intervals: [300, 600, 1000, 1500] },
  )
  await workbox.setViewportSize({ width: 700, height: 900 })
  // Narrow settle (was: setTimeout 1500ms): poll the same composite the assertion below reads.
  let wyAbcNarrow = 999
  await expect
    .poll(
      async () => {
        wyAbcNarrow = (await abcPath('.vditor-wysiwyg__preview')) ?? 999
        return wyAbcNarrow < wyAbcWide
      },
      { timeout: 10_000, intervals: [200, 400, 700, 1000] },
    )
    .toBe(true)
    .catch(() => {
      /* best-effort - the hard expect() right after re-reads the same state and gives real diagnostics */
    })
  // eslint-disable-next-line no-console
  console.log(`[WY] abc ${wyAbcWide}->${wyAbcNarrow}`)
  expect(wyAbcWide ?? 0).toBeGreaterThan(0)
  expect(wyAbcNarrow ?? 999).toBeLessThan(wyAbcWide ?? 0)
})
