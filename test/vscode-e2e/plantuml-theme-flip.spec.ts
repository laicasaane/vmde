import { wf } from './webview-helpers'
// REGRESSION — a live theme flip must re-render PlantUML ONCE, not twice. Real VS Code.
//
// User report: switching the theme on a PlantUML-heavy doc left the diagrams spinning "forever" and
// blank. Measured cause (tmp/all-diagrams-demo.md, 13 blocks): the reThemeMono foreground poll fired
// reRenderPlantuml TWICE per flip — once per intermediate foreground value during the content-theme
// settle (`vditor--dark` class first, then the content `<link>`). Each pass clears + re-renders every
// block, and the second pass clearing blocks MID-render thrashed the TeaVM engine (each stdlib block
// re-preprocesses its ~2000-line library): ~57s of spinner-then-blank, `calls:2 panesReRendered:26`.
// The fix debounces the poll to the SETTLED colour (diagram-retheme.ts reThemeOnForegroundChange) →
// one pass, ~5s, `calls:1 panesReRendered:<blocks>`.
//
// This asserts the contract on a small fixture: after a workbench light→dark flip, every plantuml
// block is re-rendered in the new theme's colour, and reRenderPlantuml fired EXACTLY ONCE.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-theme-flip.md')
async function pumlState(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const els = Array.from(
      document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
    )
    const rendered = els.filter((el) => el.querySelector('svg')).length
    const firstText = els[0]?.querySelector('svg text')
    const foreground = getComputedStyle(document.body).color
    const channels = foreground.match(/\d+/g)?.slice(0, 3).map(Number) ?? []
    return {
      total: els.length,
      rendered,
      textFill: (firstText?.getAttribute('fill') ?? 'NONE').toLowerCase(),
      foreground:
        channels.length === 3
          ? `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
          : foreground.toLowerCase(),
      stats:
        (window as unknown as { __vmdePumlRethemeStats?: unknown })
          .__vmdePumlRethemeStats ?? null,
    }
  })
}

test('a theme flip re-renders every PlantUML block ONCE in the new colour', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(150_000)
  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.workspace
        .getConfiguration('vmde')
        .update('theme.content', 'auto', true)
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', 'Default Light Modern', true)
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
    .locator('.vditor-ir__preview .language-plantuml svg')
    .nth(2)
    .waitFor({ timeout: 60_000 })
  await expect
    .poll(
      async () => {
        const current = await pumlState(frame)
        return (
          current.total === 3 &&
          current.rendered === 3 &&
          current.textFill === current.foreground
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const before = await pumlState(frame)
  expect(before.total, 'all three plantuml blocks present').toBe(3)
  expect(before.rendered, 'all rendered before the flip').toBe(3)
  expect(before.textFill, 'starts in the live light-theme foreground').toBe(
    before.foreground,
  )

  // The workbench colour-theme flip (set-theme → reThemeMono → reRenderPlantuml).
  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', 'Default Dark Modern', true)
  })

  // Poll until the diagrams have re-themed to the dark colour (the re-render is debounced ~250ms then
  // async), with a generous budget — a FAILURE is either "stuck blank" or "never recoloured".
  let after = before
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    after = await pumlState(frame)
    if (
      after.rendered === after.total &&
      after.textFill === after.foreground &&
      after.textFill !== before.textFill
    )
      break
    await frame
      .locator('body')
      .evaluate(() => new Promise((r) => setTimeout(r, 500)))
  }
  // Let any late second settle land, so a double-fire (if it regressed) is counted before we assert.
  // task 512: retain — this is the observation window for the delayed second effect the test exists
  // to reject; a first-true render/colour poll would miss a later duplicate redraw.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 3000)))
  after = await pumlState(frame)
  // eslint-disable-next-line no-console
  console.log(`[puml-flip] ${JSON.stringify(after)} in ${Date.now() - start}ms`)

  expect(after.rendered, 'every block re-rendered (not stuck blank)').toBe(
    after.total,
  )
  expect(after.textFill, 're-rendered in the live dark-theme foreground').toBe(
    after.foreground,
  )
  expect(after.textFill, 'the flip changed the baked PlantUML colour').not.toBe(
    before.textFill,
  )
  // The double-fire guard (task 411): no block gets cleared + redrawn TWICE in one flip — that was
  // the ~57s spinner-then-blank regression (see this file's own header comment). Task 411 originally
  // pinned this via `stats.calls === 1`, because at the time `reThemeMono` called `reRenderPlantuml`
  // exactly ONCE per flip and that one call batch-redrew every visible block internally. Task 412
  // (2026-07-30) restructured that dispatch to be GATED PER DIAGRAM — `gateAndRender`'s callback now
  // calls `reRenderPlantuml` once per un-gated candidate, so `calls` legitimately became "how many
  // blocks were visible", not "how many flips happened" (3 calls for this fixture's 3 always-visible
  // blocks, correctly, not a regression — task 475 audit, 2026-07-31). `calls === 1` stopped being
  // the right proxy for the invariant task 411 actually cares about; assert that invariant directly
  // instead: every block that got cleared was redrawn EXACTLY once, i.e. `panesReRendered` (one
  // clear+redraw per pane) equals the block count, not some multiple of it.
  const stats = after.stats as { calls: number; panesReRendered: number } | null
  expect(stats, 'plantuml re-theme stats exposed').not.toBeNull()
  expect(
    stats?.panesReRendered,
    'each block cleared + redrawn exactly once, not twice (no double-fire)',
  ).toBe(after.total)
})
