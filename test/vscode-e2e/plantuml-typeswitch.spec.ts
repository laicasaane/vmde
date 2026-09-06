import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// PlantUML class<->non-class type-switch — real VS Code, headless (task 178 dual-instance fix). The
// vendored TeaVM engine leaks STICKY diagram-TYPE detection across render() on a single module instance:
// once it renders a class diagram, a later VALID sequence source is misclassified as a class diagram and
// never recovers. The fix keeps TWO warm engine instances (class + non-class) and routes each diagram to
// its category, so a type switch never crosses the poisoning boundary AND never re-imports the ~7 MB
// module. This fixture interleaves class/sequence/class/sequence in render order → 3 type switches.
// Asserts: (1) each block renders as ITS OWN type — a sequence block right after a class block has NO
// class icon and no error (proves no contamination); (2) on a cold render the whole document creates
// EXACTLY 2 engine instances (one per category), not one-per-switch (the old re-import fix → >=4 here).
const FIXTURE = path.join(__dirname, 'fixtures', 'plantuml-typeswitch.md')
const N = 4

test('class<->non-class type switches render each block as its own type with only 2 engine instances (task 178)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)

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
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(N)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () =>
            (window as unknown as { __vmdePumlEngineLoads?: number })
              .__vmdePumlEngineLoads ?? 0,
        ),
    )
    .toBeLessThanOrEqual(2)

  const info = await frame.locator('body').evaluate(() => {
    const targets = Array.from(
      document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
    )
    const blocks = targets.map((t) => {
      const svg = t.querySelector('svg')
      const texts = svg
        ? Array.from(svg.querySelectorAll('text')).map((x) =>
            (x.textContent ?? '').trim(),
          )
        : []
      const joined = texts.join(' ')
      return {
        rendered: !!svg,
        cacheHit: t.getAttribute('data-vmde-cache-hit') === '1',
        // A class/object diagram draws a circled single-letter type icon (C/I/E/A); sequence has none.
        hasClassIcon: texts.some((s) => /^[CIEA]$/.test(s)),
        joined,
        errored:
          /Assumed diagram type|Syntax Error|Fatal parsing error|not supported by this release/i.test(
            joined,
          ),
      }
    })
    const loads =
      (window as unknown as { __vmdePumlEngineLoads?: number })
        .__vmdePumlEngineLoads ?? 0
    return { blocks, loads }
  })

  expect(info.blocks.length).toBe(N)
  for (const [i, b] of info.blocks.entries()) {
    expect(b.rendered, `block ${i} rendered`).toBe(true)
    expect(b.errored, `block ${i} no error`).toBe(false)
  }

  // Blocks 0 & 2 are class diagrams → circled class icon present + their class names.
  expect(info.blocks[0].hasClassIcon, 'block 0 is a class diagram').toBe(true)
  expect(info.blocks[0].joined).toContain('Alpha')
  expect(info.blocks[2].hasClassIcon, 'block 2 is a class diagram').toBe(true)
  expect(info.blocks[2].joined).toContain('Gamma')

  // Blocks 1 & 3 are sequence diagrams rendered right AFTER a class diagram — the contamination guard:
  // no class icon leaked in, and they carry their own sequence participants.
  expect(info.blocks[1].hasClassIcon, 'block 1 not contaminated as class').toBe(
    false,
  )
  expect(info.blocks[1].joined).toContain('Alice')
  expect(info.blocks[3].hasClassIcon, 'block 3 not contaminated as class').toBe(
    false,
  )
  expect(info.blocks[3].joined).toContain('Carol')

  // eslint-disable-next-line no-console
  console.log(
    `[puml-typeswitch] engineLoads=${info.loads} hits=${info.blocks.filter((b) => b.cacheHit).length}/${N}`,
  )

  // Dual-instance guarantee: at most 2 engine instances for the whole doc (one per category). On a cold
  // render it is EXACTLY 2 — the old re-import-on-switch fix would create one per switch (>=4 here). A
  // warm retry (any cache hit) can only render fewer, so relax to <=2 then.
  const anyHit = info.blocks.some((b) => b.cacheHit)
  if (anyHit) expect(info.loads).toBeLessThanOrEqual(2)
  else expect(info.loads).toBe(2)
})
