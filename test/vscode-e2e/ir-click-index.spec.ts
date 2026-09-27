/** Task 578 Checkpoint 1: attribution and deliberately red work-count gates; no product fix.
 * All fixture comparisons are booleans or hashes so failing assertions cannot print source. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { FIXTURE_SHA256 } from './find-replace-fixture-helpers'
import {
  installFindReplaceProbe,
  type FindReplaceProbeResult,
} from './find-replace-probe'
import { createXtestInput } from './helpers/xtest-input'
import {
  installIrClickMutationRecorder,
  type ClickMutationResult,
  type ClickSourceIdentity,
} from './ir-click-mutation-recorder'
import { docText, settle, waitForE2EReadiness, wf } from './webview-helpers'

type Mode = 'ir' | 'wysiwyg'
type Frame = ReturnType<typeof wf>
type Measurement = {
  mutations: ClickMutationResult
  counters: FindReplaceProbeResult
  linkActions: {
    visible: boolean
    editEnabled: boolean | null
    unlinkEnabled: boolean | null
  }
}
type Absent = {
  mode: Mode
  target: string
  offset: number
  present: false
  reason: string
}
type Unavailable = {
  mode: Mode
  target: string
  offset: number
  present: true
  unavailable: string
  interrupted: Measurement | null
}
type MatrixRow = Phase | Absent | Unavailable
type TargetPlan = {
  mode: Mode
  target: string
  offset: number
  selector: string
  optional: boolean
  candidateCount: number
  eligibleCount: number
  paintedCount: number
  selectedIndex: number | null
  status: 'ready' | 'deferred' | 'notPresent' | 'unavailable'
  reason: string
  samples: {
    nodeName: string
    className: string
    dataType: string | null
    textLen: number
    rectCount: number
  }[]
}
type Phase = Measurement & {
  mode: Mode
  target: string
  offset: number
  present: true
  warmVerified: boolean
  warmChecks: Measurement[]
  before: ClickSourceIdentity
  after: ClickSourceIdentity
  sourceUnchanged: boolean
}

const TARGETS = [
  {
    name: 'plain',
    ir: 'p[data-block="0"]',
    wysiwyg: 'p[data-block="0"]',
    text: true,
  },
  { name: 'heading', ir: 'h2.vditor-ir__node', wysiwyg: 'h2', text: true },
  { name: 'list', ir: 'ol > li', wysiwyg: 'ol > li', text: true },
  { name: 'bold', ir: '[data-type="strong"] > strong', wysiwyg: 'strong' },
  {
    name: 'italic',
    ir: '[data-type="em"] > em',
    wysiwyg: 'em',
    optional: true,
  },
  {
    name: 'inline-code',
    ir: 'p [data-type="code"] > code',
    wysiwyg: 'p code:not([data-type="html-inline"])',
  },
  {
    name: 'table',
    ir: 'table[data-block="0"] tbody td',
    wysiwyg: 'table tbody td',
    text: true,
  },
  {
    name: 'fenced-code',
    ir: '[data-type="code-block"] .vditor-ir__preview',
    wysiwyg: '[data-type="code-block"] pre.vditor-wysiwyg__preview > code',
    text: true,
  },
  {
    name: 'html-inline',
    ir: '[data-type="html-inline"]',
    wysiwyg: '[data-type="html-inline"]',
    optional: true,
  },
  {
    name: 'link',
    ir: '[data-type="a"] > .vditor-ir__link',
    wysiwyg: 'a[href]',
  },
  {
    name: 'post-link-plain',
    ir: 'p[data-block="0"]',
    wysiwyg: 'p[data-block="0"]',
    text: true,
  },
  {
    name: 'math-diagram',
    ir: '[data-type*="math"], code:is(.language-mermaid, .language-plantuml, .language-d2, .language-graphviz)',
    wysiwyg:
      '[data-type*="math"], code:is(.language-mermaid, .language-plantuml, .language-d2, .language-graphviz)',
    optional: true,
  },
] as const

function guardPredicateDrift(): void {
  const slice = (source: string) => {
    const start = source.indexOf('function relevantMutations(')
    expect(start).toBeGreaterThanOrEqual(0)
    return source
      .slice(start)
      .match(/^function relevantMutations\([\s\S]*?\n\s*}/)![0]
      .replace(/\s+/g, '')
  }
  const product = readFileSync(
    path.join(__dirname, '../../media-src/src/nav/source-block-index.ts'),
    'utf8',
  )
  const recorder = readFileSync(
    path.join(__dirname, 'ir-click-mutation-recorder.ts'),
    'utf8',
  )
  expect(slice(recorder), 'test recorder admission predicate drift').toBe(
    slice(product),
  )
}

async function start(frame: Frame, label: string): Promise<void> {
  await frame.locator('body').evaluate((_body, name) => {
    const win = window as any
    win.__vmdeIrClickRecorder.start(name)
    win.__vmdeFindReplaceProbe.start()
  }, label)
}

async function stop(frame: Frame): Promise<Measurement> {
  return frame.locator('body').evaluate(async () => {
    const win = window as any
    const counters = win.__vmdeFindReplaceProbe.stop()
    const mutations = await win.__vmdeIrClickRecorder.stop()
    // Task 578 part B compares whether click-time binding still enables source
    // actions. Read only the public UI state after counting; never log a URL or
    // marker text. A hidden panel is unmeasured, not evidence of a null span.
    const panel = document.querySelector<HTMLElement>('.vmde-link-popover')
    const visible = Boolean(panel && !panel.hidden)
    const edit = panel?.querySelector<HTMLButtonElement>('[data-action="edit"]')
    const unlink = panel?.querySelector<HTMLButtonElement>(
      '[data-action="unlink"]',
    )
    const linkActions = {
      visible,
      editEnabled: visible && edit ? !edit.disabled : null,
      unlinkEnabled: visible && unlink ? !unlink.disabled : null,
    }
    return { counters, mutations, linkActions }
  })
}

async function identity(frame: Frame): Promise<ClickSourceIdentity> {
  return frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeIrClickRecorder.sourceIdentity())
}

async function textFreeAction<T>(
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    // Playwright's actionability log embeds resolved element text. Preserve the operation and
    // error category, but never forward that message/stack or attach it as an Error cause.
    const category =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'failure'
    throw new Error(
      `${label}: ${category}; element-bearing Playwright details withheld`,
    )
  }
}

async function quiesce(frame: Frame, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await start(frame, `${label}/idle-${attempt}`)
    // Negative-observation window: require 600 ms containing no mutation and no getValue.
    await settle(frame, 600)
    const result = await stop(frame)
    if (
      result.mutations.records.length === 0 &&
      result.counters.fullGetValueCalls === 0
    )
      return
  }
  throw new Error(`${label}: no 600 ms mutation/getValue quiescence window`)
}

function targetSelector(
  mode: Mode,
  target: (typeof TARGETS)[number],
  offset: number,
): string {
  if (target.name !== 'fenced-code' || offset !== 2) return target[mode]
  // Both modes hide the preview and reveal a separate editable source on the first click.
  // Offset 2 must address that source, not the preview selected during preflight.
  return mode === 'ir'
    ? '[data-type="code-block"] pre.vditor-ir__marker--pre > code'
    : '[data-type="code-block"] pre.vditor-wysiwyg__pre > code'
}

function plannedLocator(frame: Frame, plan: TargetPlan): Locator {
  return frame
    .locator(`.vditor-${plan.mode} .vditor-reset`)
    .first()
    .locator(plan.selector)
    .nth(plan.selectedIndex!)
}

async function inspectTarget(
  frame: Frame,
  mode: Mode,
  target: (typeof TARGETS)[number],
  offset: number,
): Promise<TargetPlan> {
  const selector = targetSelector(mode, target, offset)
  const deferred = target.name === 'fenced-code' && offset === 2
  const summary = await frame
    .locator(`.vditor-${mode} .vditor-reset`)
    .first()
    .locator(selector)
    .evaluateAll(
      (elements, options) => {
        const candidates = elements.map((element, index) => {
          const plain =
            options.target === 'plain' || options.target === 'post-link-plain'
          const special =
            options.mode === 'ir'
              ? '.vditor-ir__node'
              : 'a,strong,em,code,[data-type]'
          const eligible =
            !plain ||
            (!element.querySelector(special) &&
              (element.textContent?.length ?? 0) >= 40)
          const rectCount = Array.from(element.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          ).length
          const visibility = getComputedStyle(element).visibility
          return {
            index,
            eligible,
            painted:
              rectCount > 0 &&
              visibility !== 'hidden' &&
              visibility !== 'collapse',
            nodeName: element.nodeName,
            className: element.getAttribute('class') ?? '',
            dataType: element.getAttribute('data-type'),
            textLen: element.textContent?.length ?? 0,
            rectCount,
          }
        })
        const eligible = candidates.filter((candidate) => candidate.eligible)
        const painted = eligible.filter((candidate) => candidate.painted)
        // The second fenced-code click deliberately targets a source half hidden until click 1.
        const selected =
          painted[0] ?? (options.deferred ? eligible[0] : undefined)
        return {
          candidateCount: candidates.length,
          eligibleCount: eligible.length,
          paintedCount: painted.length,
          selectedIndex: selected?.index ?? null,
          samples: candidates
            .slice(0, 3)
            .map(({ nodeName, className, dataType, textLen, rectCount }) => ({
              nodeName,
              className,
              dataType,
              textLen,
              rectCount,
            })),
        }
      },
      { mode, target: target.name, deferred },
    )
  const plan: TargetPlan = {
    ...summary,
    mode,
    target: target.name,
    offset,
    selector,
    optional: 'optional' in target && target.optional,
    status:
      summary.selectedIndex === null
        ? 'notPresent'
        : deferred
          ? 'deferred'
          : 'ready',
    reason:
      summary.selectedIndex === null
        ? summary.candidateCount === 0
          ? 'no DOM candidates'
          : 'no painted eligible click target'
        : deferred
          ? 'source geometry checked after the collapsed preview click'
          : 'painted target',
  }
  if (plan.status === 'ready') {
    try {
      // Read-only preflight: resolve BOTH offset geometries before any editor click in this mode.
      await clickPosition(plannedLocator(frame, plan), target, offset)
    } catch {
      plan.status = 'unavailable'
      plan.reason = 'painted target has no usable click geometry'
    }
  }
  return plan
}

async function preflightMode(
  frame: Frame,
  mode: Mode,
  recordPlan: (plan: TargetPlan) => void,
): Promise<TargetPlan[]> {
  const plans: TargetPlan[] = []
  for (const target of TARGETS) {
    for (const offset of [1, 2]) {
      const plan = await inspectTarget(frame, mode, target, offset)
      plans.push(plan)
      recordPlan(plan)
      console.log('[Task 578 preflight]', JSON.stringify(plan))
    }
  }
  return plans
}

async function clickPosition(
  locator: Locator,
  target: (typeof TARGETS)[number],
  offset: number,
) {
  return locator.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one serialized page callback walks visible text rects while excluding IR marker text.
    (element, options) => {
      const box = element.getBoundingClientRect()
      if (!options.text) {
        // A wrapped inline's union box can contain sibling list items or whitespace. Keep the
        // handoff's 30%/70% offsets on its first painted fragment. Do not reject the pre-hover
        // hit: Playwright scrolls this precise point (and retries scroll alignment for sticky
        // overlays) before checking actionability. A document-only hit test runs too early.
        const rects = Array.from(element.getClientRects()).filter(
          (rect) => rect.width > 0 && rect.height > 0,
        )
        const ratio = options.offset === 1 ? 0.3 : 0.7
        const summarize = (node: Element | null) =>
          node
            ? {
                nodeName: node.nodeName,
                className: node.getAttribute('class') ?? '',
              }
            : null
        const unionHit = document.elementFromPoint(
          box.left + box.width * ratio,
          box.top + box.height / 2,
        )
        for (const rect of rects) {
          const x = rect.left + rect.width * ratio
          const y = rect.top + rect.height / 2
          const hit = document.elementFromPoint(x, y)
          return {
            x: x - box.left,
            y: y - box.top,
            geometry: {
              target: options.name,
              offset: options.offset,
              rectCount: rects.length,
              unionHit: summarize(unionHit),
              preHoverFragmentHit: summarize(hit),
              preHoverFragmentReceivesPointer: !!hit && element.contains(hit),
            },
          }
        }
        throw new Error(`Task 578 ${options.name}: no nonempty inline fragment`)
      }
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        if (
          node.parentElement?.closest('[class*="vditor-ir__marker"]') &&
          options.name !== 'fenced-code'
        )
          continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = Array.from(range.getClientRects()).find(
          (line) => line.width > 0 && line.height > 0,
        )
        if (!rect) continue
        const minimum = options.name === 'heading' ? box.left + 60 : rect.left
        if (minimum >= rect.right) continue
        const x =
          minimum +
          (rect.right - minimum) * (options.offset === 1 ? 0.25 : 0.75)
        return { x: x - box.left, y: rect.top + rect.height / 2 - box.top }
      }
      throw new Error(
        `Task 578 ${options.name}: no visible first-line text rect`,
      )
    },
    { name: target.name, text: 'text' in target && target.text, offset },
  )
}

async function measureClick(
  frame: Frame,
  workbox: Page,
  mode: Mode,
  target: (typeof TARGETS)[number],
  offset: number,
  locator: Locator,
): Promise<Phase> {
  const label = `${mode}/${target.name}/${offset}`
  await textFreeAction(`${label}/scroll`, () =>
    locator.scrollIntoViewIfNeeded({ timeout: 5_000 }),
  )
  const chosen = await clickPosition(locator, target, offset)
  const position = { x: chosen.x, y: chosen.y }
  if ('geometry' in chosen)
    console.log(
      '[Task 578 inline geometry]',
      JSON.stringify({ label, ...chosen.geometry }),
    )
  await textFreeAction(`${label}/hover`, () =>
    locator.hover({ position, timeout: 5_000 }),
  )
  await quiesce(frame, label)
  const warmChecks: Measurement[] = []
  let warmVerified = false
  for (let attempt = 0; attempt < 2; attempt++) {
    await start(frame, `${label}/warm-${attempt}`)
    await textFreeAction(`${label}/warm-hover`, () =>
      locator.hover({
        timeout: 5_000,
        position: {
          x: position.x + (attempt === 0 ? 1 : 0),
          y: position.y,
        },
      }),
    )
    // Negative-observation window: detect deferred builds and admitted mutations.
    await settle(frame, 300)
    const warm = await stop(frame)
    warmChecks.push(warm)
    warmVerified =
      warm.counters.indexBuildsInstrumented &&
      warm.counters.indexBuilds === 0 &&
      !warm.mutations.records.some((record) => record.admitted)
    if (warmVerified) break
  }
  const before = await identity(frame)
  const clickBox = await locator.boundingBox()
  if (!clickBox) throw new Error(`${label}: target has no click box`)
  await start(frame, label)
  await textFreeAction(`${label}/click`, () =>
    locator.click({ position, timeout: 5_000 }),
  )
  // Negative-observation windows include marker dwell, rAF writers, Details settle and
  // the trailing hover read that exposes an invalidated but as-yet-unconsumed index.
  await settle(frame, 500)
  // Clicks can hide an IR preview or reveal markers; move from the actual mouse point
  // rather than asking Playwright to make the old locator actionable again.
  await workbox.mouse.move(clickBox.x + position.x + 1, clickBox.y + position.y)
  await settle(frame, 300)
  const measured = await stop(frame)
  const after = await identity(frame)
  return {
    ...measured,
    mode,
    target: target.name,
    offset,
    present: true,
    warmVerified,
    warmChecks,
    before,
    after,
    sourceUnchanged:
      before.utf16Length === after.utf16Length &&
      before.utf8Bytes === after.utf8Bytes &&
      before.sha256 === after.sha256,
  }
}

async function collectTarget(
  frame: Frame,
  workbox: Page,
  plan: TargetPlan,
): Promise<MatrixRow> {
  const { mode, target, offset } = plan
  if (plan.status === 'notPresent')
    return {
      mode,
      target,
      offset,
      present: false,
      reason: `notPresent: ${plan.reason}`,
    }
  if (plan.status === 'unavailable')
    return {
      mode,
      target,
      offset,
      present: true,
      unavailable: plan.reason,
      interrupted: null,
    }
  const definition = TARGETS.find((candidate) => candidate.name === target)!
  try {
    return await textFreeAction(`${mode}/${target}/${offset}/measurement`, () =>
      measureClick(
        frame,
        workbox,
        mode,
        definition,
        offset,
        plannedLocator(frame, plan),
      ),
    )
  } catch (error) {
    // A failed target must not lose later targets or leave the probes armed. Keep interrupted
    // counts distinct from a completed phase, and fail the collected setup gate at the end.
    const armed = await frame
      .locator('body')
      .evaluate(() => (window as any).__vmdeIrClickRecorder.armed)
    const interrupted = armed ? await stop(frame) : null
    return {
      mode,
      target,
      offset,
      present: true,
      unavailable: (error as Error).message,
      interrupted,
    }
  }
}

async function collectMode(
  frame: Frame,
  workbox: Page,
  mode: Mode,
  record: (row: MatrixRow) => void,
  recordPlan: (plan: TargetPlan) => void,
): Promise<void> {
  if (mode !== 'ir') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: 'Task 578 WYSIWYG readiness',
    })
  }
  const plans = await preflightMode(frame, mode, recordPlan)
  for (const plan of plans) {
    const row = await collectTarget(frame, workbox, plan)
    record(row)
    console.log('[Task 578 phase]', JSON.stringify(row))
  }
}

test.describe('Task 578 warm click source index attribution', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('unchanged warm clicks build and serialize nothing in IR', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }, testInfo) => {
    test.setTimeout(420_000)
    guardPredicateDrift()
    const fixture = readFileSync(
      path.join(__dirname, 'fixtures/large-observable-models-synthetic.md'),
    )
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const initial = fixture.toString('utf8')
    const file = path.join(baseDir, 'ir-click-index-synthetic.md')
    writeFileSync(file, fixture)
    const host = async () =>
      (await docText(evaluateInVSCode as never, file)) as string
    await workbox.context().addInitScript(() => {
      ;(window as any).__vmdeBlockHandleCacheMetrics = {
        blockHandleSnapshotCalls: 0,
      }
    })
    await evaluateInVSCode(async (vscode) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', 'ir', true)
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
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
      {
        timeout: 90_000,
        message: 'Task 578 fixture readiness',
      },
    )
    await expect.poll(async () => (await host()) === initial).toBe(true)
    await frame.locator('body').evaluate(installIrClickMutationRecorder)
    await frame.locator('body').evaluate(installFindReplaceProbe)
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await xtest.activateAndFocus()
    // No keyboard steps are needed for this pointer-only journey. Any added key step must use xtest.
    const rows: MatrixRow[] = []
    const preflight: TargetPlan[] = []
    const artifact = testInfo.outputPath('ir-click-index-evidence.json')
    const persistPartial = () =>
      writeFileSync(
        artifact,
        JSON.stringify(
          {
            complete: false,
            phases: rows.filter((row) => 'counters' in row),
            absent: rows.filter((row) => !row.present),
            unavailable: rows.filter((row) => 'unavailable' in row),
            preflight,
            integrity: null,
          },
          null,
          2,
        ),
      )
    persistPartial()
    try {
      for (const mode of ['ir', 'wysiwyg'] as const) {
        await collectMode(
          frame,
          workbox,
          mode,
          (row) => {
            rows.push(row)
            // Preserve completed phases even when a later locator or readiness step fails.
            persistPartial()
          },
          (plan) => {
            preflight.push(plan)
            persistPartial()
          },
        )
      }
    } catch (error) {
      await testInfo.attach('Task 578 partial text-free evidence', {
        path: artifact,
        contentType: 'application/json',
      })
      throw error
    }
    const phases = rows.filter((row): row is Phase => 'counters' in row)
    const absent = rows.filter((row): row is Absent => !row.present)
    const unavailable = rows.filter(
      (row): row is Unavailable => 'unavailable' in row,
    )
    const hostText = await host()
    const disk = readFileSync(file)
    const hostState = await evaluateInVSCode(
      async (vscode, [uri]: [string]) => {
        const document = vscode.workspace.textDocuments.find(
          (doc) => doc.uri.fsPath === uri,
        )
        return {
          found: !!document,
          dirty: document?.isDirty,
          version: document?.version,
        }
      },
      [file] as [string],
    )
    const integrity = {
      hostUnchanged: hostText === initial,
      diskUnchanged: disk.equals(fixture),
      host: {
        utf16Length: hostText.length,
        utf8Bytes: Buffer.byteLength(hostText, 'utf8'),
        sha256: createHash('sha256').update(hostText).digest('hex'),
      },
      disk: {
        utf8Bytes: disk.length,
        sha256: createHash('sha256').update(disk).digest('hex'),
      },
      hostState,
    }
    console.log('[Task 578 identity]', JSON.stringify(integrity))
    const evidence = {
      complete:
        unavailable.length === 0 &&
        preflight.every(
          (plan) => plan.status !== 'notPresent' || plan.optional,
        ),
      phases,
      absent,
      unavailable,
      preflight,
      integrity,
    }
    writeFileSync(artifact, JSON.stringify(evidence, null, 2))
    await testInfo.attach('Task 578 text-free evidence', {
      path: artifact,
      contentType: 'application/json',
    })
    const key = (phase: Phase) =>
      `${phase.mode}/${phase.target}/${phase.offset}`
    const warmIr = phases.filter(
      (phase) => phase.mode === 'ir' && phase.warmVerified,
    )
    const failures = {
      indexBuilds: warmIr
        .filter((phase) => phase.counters.indexBuilds !== 0)
        .map(key),
      fullGetValueCalls: warmIr
        .filter((phase) => phase.counters.fullGetValueCalls !== 0)
        .map(key),
      rootLuteCalls: warmIr
        .filter((phase) => phase.counters.rootLuteCalls !== 0)
        .map(key),
    }
    console.log('[Task 578 red counts]', JSON.stringify(failures))
    expect(
      phases.filter((phase) => !phase.sourceUnchanged).map(key),
      'source identity',
    ).toEqual([])
    expect(integrity.hostUnchanged, 'host byte identity').toBe(true)
    expect(integrity.diskUnchanged, 'disk byte identity').toBe(true)
    expect(
      unavailable.map((row) => `${row.mode}/${row.target}/${row.offset}`),
      'unmeasured targets',
    ).toEqual([])
    expect(
      preflight
        .filter((plan) => plan.status === 'notPresent' && !plan.optional)
        .map((plan) => `${plan.mode}/${plan.target}/${plan.offset}`),
      'missing required targets',
    ).toEqual([])
    expect(
      failures,
      'warm IR click work counts (red until Checkpoint 2)',
    ).toEqual({
      indexBuilds: [],
      fullGetValueCalls: [],
      rootLuteCalls: [],
    })
  })
})
