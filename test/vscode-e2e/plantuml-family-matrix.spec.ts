import { wf } from './webview-helpers'
// Task 429 — engine-load-count coverage across the diagram-type matrix (the `isClassSource` misread
// audit). plantuml-typeswitch.spec.ts (owned elsewhere, not edited here — see task 429's own "Extend…
// or add a sibling spec") covers exactly ONE traversal of the matrix: class <-> sequence. Task 137
// established a much wider type-coverage matrix and isClassSource's own comment calls out "exotic
// arrow forms" as the misread risk, so this sibling widens the walk to class, object, sequence,
// activity (both syntaxes), component, state, usecase, and C4 — asserting the dual-engine invariant
// (task 350) holds across all of them: `__vmdePumlEngineLoads` stays ≤ 2 for the whole document,
// and each block's RENDERED family matches the ROUTED one (no silent misread-then-recover hiding
// behind a load count that happens to still look right).
//
// Three tests, deliberately separated so a clean matrix result and each demonstrated finding don't
// blur into one number:
//   1. The family matrix itself, with labels chosen so nothing ELSE can trip the safety net — this is
//      the audit's answer for `isClassSource` across the family list the task scope asks for.
//   2. A finding this audit surfaced along the way (see plantuml-word-boundary-misread.md): the SAFETY
//      NET (`renderedIsClass`), not `isClassSource` itself, has its own false-positive mode — pinned
//      here as a regression/documentation case per task 429's "record the outcome … or the form that
//      misread". Uses the task-430 phase-timing instrument to read `engineDiscarded` directly instead
//      of re-deriving it with a second detector (the two tasks' instruments joining up, as intended).
//   3. An adversarial-review CONFIRMED finding against the `object`-keyword fix itself: a class keyword
//      at the start of a note/legend/title body, or used as a bare unquoted participant name, also
//      misrouted a non-class source — and, measured, poisoned the SAME direction as the original
//      `object` bug (visible rendering corruption on the shared `class` engine, not just a wasted
//      re-import). See plantuml-free-text-misread.md + isClassSource's own comment for the fix.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const MATRIX_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'plantuml-family-matrix.md',
)
const WORD_BOUNDARY_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'plantuml-word-boundary-misread.md',
)
const FREE_TEXT_FIXTURE = path.join(
  __dirname,
  'fixtures',
  'plantuml-free-text-misread.md',
)
const N = 9

test('diagram-family matrix (class/object/sequence/activity×2/component/state/usecase/C4) stays at ≤2 engine loads (task 429)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [MATRIX_FIXTURE] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      {
        timeout: 120_000,
      },
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
    .toBe(2)

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
        // Same detector plantuml-typeswitch.spec.ts uses (reusing renderedIsClass's own circled-icon
        // marker, per task 429's scope, rather than inventing a second one).
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

  const names = [
    'class',
    'object',
    'sequence',
    'activity (modern)',
    'activity (legacy)',
    'component',
    'state',
    'usecase',
    'C4',
  ]

  expect(info.blocks.length).toBe(N)
  for (const [i, b] of info.blocks.entries()) {
    expect(b.rendered, `${names[i]} rendered`).toBe(true)
    expect(b.errored, `${names[i]} rendered without error`).toBe(false)
  }

  // eslint-disable-next-line no-console
  console.log(
    `[puml-family-matrix] loads=${info.loads} icons=${info.blocks.map((b, i) => `${names[i]}:${b.hasClassIcon}`).join(' ')}`,
  )

  // Only block 0 (class) is expected to carry the circled type icon. Any OTHER block showing one is
  // exactly the silent-misread-then-recover signal task 429 asks this matrix to surface — record it
  // in tasks/429-plantuml-engine-load-count-coverage.md rather than silently asserting it away.
  expect(
    info.blocks[0].hasClassIcon,
    'class diagram shows the circled type icon',
  ).toBe(true)
  for (const [i, b] of info.blocks.entries()) {
    if (i === 0) continue
    expect(b.hasClassIcon, `${names[i]} does not carry a class icon`).toBe(
      false,
    )
  }

  // Dual-instance guarantee (task 350): 1 class-category load + 1 non-class-category load, however
  // many of each DIAGRAM TYPE render — the whole point is that CATEGORY, not type, decides the engine.
  expect(
    info.loads,
    'exactly 2 engine instances for 1 class + 8 non-class diagrams',
  ).toBe(2)
})

test('a bare "A"/"C"/"I"/"E" word in a wrapped label trips renderedIsClass and forces an avoidable re-import (task 429 finding)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)

  // Task 430's instrument, armed here to read `engineDiscarded` straight off the render instead of
  // re-deriving it from the DOM a second time.
  await workbox.addInitScript(() => {
    ;(
      window as unknown as { __vmdePumlTimingEnabled?: boolean }
    ).__vmdePumlTimingEnabled = true
  })

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [WORD_BOUNDARY_FIXTURE] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThanOrEqual(2)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () =>
            (window as unknown as { __vmdePumlTimings?: unknown[] })
              .__vmdePumlTimings?.length ?? 0,
        ),
    )
    .toBeGreaterThanOrEqual(2)

  const info = await frame.locator('body').evaluate(() => {
    interface Rec {
      engineKind: string
      engineDiscarded: boolean
      engineImport: number
    }
    const w = window as unknown as { __vmdePumlTimings?: Rec[] }
    const targets = Array.from(
      document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
    )
    const errored = targets.map((t) => {
      const svg = t.querySelector('svg')
      const joined = svg
        ? Array.from(svg.querySelectorAll('text'))
            .map((x) => x.textContent ?? '')
            .join(' ')
        : ''
      return /Assumed diagram type|Syntax Error|Fatal parsing error|not supported by this release/i.test(
        joined,
      )
    })
    const loads =
      (window as unknown as { __vmdePumlEngineLoads?: number })
        .__vmdePumlEngineLoads ?? 0
    return { records: w.__vmdePumlTimings ?? [], loads, errored }
  })
  // eslint-disable-next-line no-console
  console.log(`[puml-word-boundary] ${JSON.stringify(info, null, 1)}`)

  expect(
    info.errored,
    'neither block errors — the misread costs time, never correctness',
  ).toEqual([false, false])
  expect(info.records.length).toBe(2)
  const [c4, sequence] = info.records

  // Both blocks are non-class per isClassSource (no class keyword/relation/bare-association in EITHER
  // source) — the finding is entirely in renderedIsClass's blind single-letter-text scan, not in the
  // probe this task set out to audit.
  expect(c4.engineKind).toBe('nonClass')
  expect(sequence.engineKind).toBe('nonClass')

  // THE finding: block 0's "A person" descriptor wraps to a bare "A" <text> node, which
  // renderedIsClass reads as a class-diagram type icon even though the diagram is C4/non-class —
  // discarding the (correctly routed) nonClass engine instance.
  expect(
    c4.engineDiscarded,
    'the C4 block trips the safety net purely from a wrapped "A" in its label',
  ).toBe(true)
  // …and the cost lands on the NEXT non-class block: it re-imports from scratch (engineImport is not
  // ~0 the way plantuml-phase-timing.spec.ts's back-to-back C4 pair measures a warm reuse).
  expect(
    sequence.engineImport,
    'the discard forces the following non-class block to pay a real re-import',
  ).toBeGreaterThan(50)
  // Visible even without the timing instrument: 2 non-class loads for a document with ZERO class
  // diagrams — the load count alone would misleadingly still read "≤2" (task 429's own warning that
  // the count can hide this).
  expect(
    info.loads,
    '2 engine loads, despite no class diagram anywhere in this doc',
  ).toBe(2)
})

test('a keyword in a note/legend/title body, or as a bare message participant, does not misroute or poison the class engine (task 429 adversarial-review finding)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(120_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FREE_TEXT_FIXTURE] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      () => frame.locator('.vditor-ir__preview .language-plantuml svg').count(),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(5)
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
    .toBe(2)

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
      return {
        rendered: !!svg,
        hasClassIcon: texts.some((s) => /^[CIEA]$/.test(s)),
        joined: texts.join(' '),
      }
    })
    const loads =
      (window as unknown as { __vmdePumlEngineLoads?: number })
        .__vmdePumlEngineLoads ?? 0
    return { blocks, loads }
  })

  const names = [
    'class Foo/Bar (real class, block 0)',
    'note-body "object…" (sequence, MUST route non-class)',
    'class Baz/Qux (real class, block 2 — must survive block 1 unaffected)',
    'bare "object ->" participant (sequence, MUST route non-class)',
    'Carol/Dave control (sequence)',
  ]

  // eslint-disable-next-line no-console
  console.log(
    `[puml-free-text-misread] loads=${info.loads} icons=${info.blocks.map((b, i) => `${names[i]}:${b.hasClassIcon}`).join(' | ')}`,
  )

  expect(info.blocks.length).toBe(5)
  // Blocks 0 and 2 are the only real class diagrams — they must carry the icon, and block 2 proves
  // the note-body misread (block 1) didn't leave the shared class engine unable to render a REAL
  // class diagram correctly afterward either.
  expect(info.blocks[0].hasClassIcon, names[0]).toBe(true)
  expect(info.blocks[2].hasClassIcon, names[2]).toBe(true)
  // The two false-positive shapes: neither carries the icon, and neither lost its own text (proof the
  // diagram rendered as itself, not as a wrong/blank recovery).
  expect(info.blocks[1].hasClassIcon, names[1]).toBe(false)
  expect(info.blocks[1].joined).toContain('hello')
  expect(info.blocks[1].joined).toContain('object model overview')
  expect(info.blocks[3].hasClassIcon, names[3]).toBe(false)
  expect(info.blocks[3].joined).toContain('test')
  // Control: unaffected either way.
  expect(info.blocks[4].hasClassIcon, names[4]).toBe(false)

  // 2 real class diagrams (0, 2) + 3 non-class (1, 3, 4) — still exactly 2 engine loads.
  expect(info.loads, '2 engine loads: 1 class + 1 non-class').toBe(2)
})
