import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// PlantUML render cache (task 347 follow-up) — real VS Code, headless. PlantUML is the slowest engine
// (~7 MB TeaVM parse + serialised per-block render → ~7–8 s for a 5-diagram doc, EVERY open, uncached).
// It is now in the render cache as a LIVE-miss tier: we reserve each preview target (`data-processed`)
// synchronously on open — which our plantumlRender skips up front, so the engine (and the Viz.js it
// loads) NEVER runs on a reserved block (unlike graphviz, whose Vditor renderer double-invokes Viz and
// hangs). A HIT then paints the stored SVG (zero engine work, `data-vmde-cache-hit` set); a MISS
// un-reserves and re-renders live. This asserts: (1) first open renders all 5 (cold miss), (2) reopen
// serves all 5 from cache (hit marker + byte-identical svg + unchanged getValue), (3) reopen is FAR
// faster than the cold open. Uses the 5 C4/AWS/Azure fixture so it exercises stdlib + the render queue
// together with the cache. The zero-render proof is the hit marker (set only by our cache paint on a
// reserved/blocked block) AND svg byte-identity: warm re-paints the exact bytes cold stored.
const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-multiblock.md')
const N = 5

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode'), args: string[]) => Promise<void>,
    args: [string],
  ) => Promise<void>,
) {
  await evaluateInVSCode(
    async (vscode, args) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  return frame
}

async function closeActive(
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode')) => Promise<void>,
  ) => Promise<void>,
) {
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand(
      'workbench.action.revertAndCloseActiveEditor',
    )
  })
}

// Wait until all N plantuml previews hold an <svg>, then settle. Returns nothing; caller times it.
async function waitAll(frame: ReturnType<typeof wf>) {
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(N)
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1000)))
}

// Per-block snapshot of the plantuml preview targets + the whole-doc getValue.
async function snapshot(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const targets = Array.from(
      document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
    )
    const blocks = targets.map((t) => {
      const svg = t.querySelector('svg')
      const text = svg
        ? Array.from(svg.querySelectorAll('text'))
            .map((x) => x.textContent ?? '')
            .join(' ')
        : ''
      return {
        cacheHit: t.getAttribute('data-vmde-cache-hit') === '1',
        svgHTML: svg?.outerHTML ?? '',
        errored:
          /Assumed diagram type|Syntax Error|Fatal parsing error|not supported by this release/i.test(
            text,
          ),
      }
    })
    const vditor = (window as unknown as { vditor?: { getValue(): string } })
      .vditor
    return { blocks, value: vditor ? vditor.getValue() : '' }
  })
}

test('reopen serves all 5 PlantUML diagrams from cache — zero engine render, far faster (task 347 cache)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)

  // ── Cold open: empty cache → live render of all 5 (this is the ~7-8 s the cache exists to avoid). ──
  const coldStart = Date.now()
  const frame1 = await open(workbox, evaluateInVSCode)
  await waitAll(frame1)
  const coldMs = Date.now() - coldStart
  const before = await snapshot(frame1)

  expect(before.blocks.length).toBe(N)
  for (const [i, b] of before.blocks.entries()) {
    expect(b.svgHTML.length, `cold block ${i} rendered`).toBeGreaterThan(0)
    expect(b.errored, `cold block ${i} no error`).toBe(false)
    // First open is a cold miss → live render, not a cache paint.
    expect(b.cacheHit, `cold block ${i} not a hit`).toBe(false)
  }

  // ── Reopen the SAME doc: the host cache (per-uri, persists across close) should serve every block. ──
  await closeActive(evaluateInVSCode)
  await new Promise((r) => setTimeout(r, 500))
  const warmStart = Date.now()
  const frame2 = await open(workbox, evaluateInVSCode)
  await waitAll(frame2)
  const warmMs = Date.now() - warmStart
  const after = await snapshot(frame2)

  // eslint-disable-next-line no-console
  console.log(
    `[puml-cache] coldMs=${coldMs} warmMs=${warmMs} hits=${after.blocks.filter((b) => b.cacheHit).length}/${N}`,
  )

  expect(after.blocks.length).toBe(N)
  for (let i = 0; i < N; i++) {
    // Served from the host cache — marker set ONLY by our cache paint on a reserved/blocked block.
    expect(after.blocks[i].cacheHit, `warm block ${i} cache-hit`).toBe(true)
    expect(after.blocks[i].errored, `warm block ${i} no error`).toBe(false)
    // Byte-identical svg ⟹ the warm paint reused the exact bytes the cold render stored (no re-render).
    expect(after.blocks[i].svgHTML, `warm block ${i} svg reused`).toBe(
      before.blocks[i].svgHTML,
    )
  }
  // getValue() byte-identical with the cached svgs injected (data-render="1" → Lute-invisible).
  expect(after.value).toBe(before.value)
  // Headline win: reopen skips the 7 MB engine parse + the serialised renders → far faster than cold.
  expect(warmMs).toBeLessThan(coldMs / 2)
})
