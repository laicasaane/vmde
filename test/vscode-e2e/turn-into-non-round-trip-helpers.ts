import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { errors, type ElectronApplication, type Page } from '@playwright/test'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'
import {
  FIXTURE,
  FIXTURE_SHA256,
  literalMatches,
} from './find-replace-fixture-helpers'
import {
  installTurnIntoProbe,
  type TurnIntoProbeResult,
} from './turn-into-probe'

export type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type Fixtures = {
  workbox: Page
  electronApp: ElectronApplication
  evaluateInVSCode: Parameters<typeof docText>[0]
  baseDir: string
}
type Target = { fragment: string; start: number; end: number }
export const TOKEN = 'mtnnwcr'
export const SMALL = 'before\n\ntarget paragraph\n\nafter\n'
const SMALL_TARGET = 'target paragraph'
const fixtureLines = FIXTURE.split('\n')
const offsets = [0]
for (const line of fixtureLines) offsets.push(offsets.at(-1)! + line.length + 1)
const targetAt = (first: number, last = first): Target => {
  const start = offsets[first - 1]
  const end = offsets[last - 1] + fixtureLines[last - 1].length
  return { fragment: FIXTURE.slice(start, end), start, end }
}
export const near = targetAt(208)
export const far = targetAt(1297)
const multi = targetAt(16, 17)
const smallStart = SMALL.indexOf(SMALL_TARGET)
export const smallTarget = {
  fragment: SMALL_TARGET,
  start: smallStart,
  end: smallStart + SMALL_TARGET.length,
}
export const headingPlan = (source: string, target: Target) =>
  `${source.slice(0, target.start)}## ${source.slice(target.start)}`

function numericEvidence(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.values(value).every(numericEvidence),
  )
}
function createReport(label: string, checkpoint: 'cp1' | 'cp2') {
  const folder = path.resolve(
    __dirname,
    `../../tmp/task604-checks/${checkpoint}/vscode`,
  )
  mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `${label}.json`)
  const data: Record<string, unknown> = {}
  const record = (name: string, value: unknown) => {
    expect(numericEvidence(value)).toBe(true)
    data[name] = value
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
    console.log(JSON.stringify({ [name]: value }))
  }
  record('started', true)
  return { file, record }
}
let report: ReturnType<typeof createReport> | undefined
export function startReport(label: string, checkpoint: 'cp1' | 'cp2' = 'cp1') {
  report = createReport(label, checkpoint)
}
export const record = (name: string, value: unknown) =>
  report!.record(name, value)

export function registerReportHooks() {
  test.beforeEach(() => {
    report = undefined
    expect(
      createHash('sha256').update(FIXTURE).digest('hex') === FIXTURE_SHA256,
    ).toBe(true)
    expect(
      Buffer.byteLength(FIXTURE) === 174527 && FIXTURE.length === 174517,
    ).toBe(true)
    const matches = literalMatches(FIXTURE, TOKEN, false)
    expect(
      matches.length === 2 &&
        matches[1].start >= far.start &&
        matches[1].end <= far.end,
    ).toBe(true)
  })
  test.afterEach(async ({ workbox }, testInfo) => {
    if (!report) return
    record('runner', {
      workbenchOpen: !workbox.isClosed(),
      expectedFailure: testInfo.expectedStatus === 'failed',
      failureObserved: testInfo.status === 'failed',
      outcomeMatchesExpectation: testInfo.status === testInfo.expectedStatus,
    })
    // Durable tmp output survives passing-test cleanup; the attachment is a convenience copy.
    await testInfo.attach('task604-vscode', {
      path: report.file,
      contentType: 'application/json',
    })
  })
}

export async function openFixture(
  args: Fixtures,
  source: string,
  mode: Mode,
  name: string,
) {
  const file = path.join(args.baseDir, `task604-${name}.md`)
  writeFileSync(file, source)
  await args.workbox.context().addInitScript(() => {
    ;(window as any).__vmdeBlockHandleCacheMetrics = {
      indexBuilds: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
    }
  })
  await args.evaluateInVSCode(
    async (vscode: typeof import('vscode'), [next]: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', next, true)
    },
    [mode],
  )
  const frame = await reopenVmdeFixture(
    args.evaluateInVSCode,
    args.workbox,
    file,
    90_000,
    `.vditor-${mode}`,
  )
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    {
      timeout: 90_000,
      message: 'Task 604 live editor readiness',
    },
  )
  const host = () => docText(args.evaluateInVSCode, file)
  await expect.poll(async () => (await host()) === source).toBe(true)
  await frame.locator('body').evaluate(installTurnIntoProbe)
  const xtest = await createXtestInput(args.electronApp, args.workbox)
  await xtest.activateAndFocus()
  expect(xtest.client.visible).toBe(true)
  record(`${name}_input`, {
    mappedClient: true,
    visible: xtest.client.visible,
    pid: xtest.client.pid,
    xid: Number.parseInt(xtest.client.xid, 16),
  })
  const runtime = await args.electronApp.evaluate(({ app }) => ({
    x11LaunchArg: app.commandLine.getSwitchValue('ozone-platform') === 'x11',
    electronVersion: (process.versions.electron ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10)),
    chromiumVersion: (process.versions.chrome ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10)),
  }))
  const vscodeVersion = await args.evaluateInVSCode(
    (vscode: typeof import('vscode')) =>
      vscode.version.split('.').map((part) => Number.parseInt(part, 10)),
    [],
  )
  record(`${name}_runtime`, {
    ...runtime,
    vscodeVersion,
    displayPresent: Boolean(process.env.DISPLAY),
  })
  expect(runtime.x11LaunchArg).toBe(true)
  return { ...args, file, source, mode, frame, host, xtest }
}
type Context = Awaited<ReturnType<typeof openFixture>>
function editor(ctx: Context) {
  const selector =
    ctx.mode === 'sv'
      ? '#app .vditor-sv'
      : `#app .vditor-${ctx.mode} .vditor-reset`
  return ctx.frame.locator(selector).first()
}
const picker = (ctx: Context) =>
  ctx.workbox.locator('.quick-input-widget input').first()
async function frames(frame: Frame) {
  await frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
}
async function command(ctx: Context, name: string) {
  await ctx.evaluateInVSCode(
    async (vscode: typeof import('vscode'), [id]: [string]) => {
      await vscode.commands.executeCommand(id)
    },
    [name],
  )
}
export async function unchanged(ctx: Context) {
  const state = {
    hostUnchanged: (await ctx.host()) === ctx.source,
    diskUnchanged: readFileSync(ctx.file, 'utf8') === ctx.source,
  }
  record(`${ctx.mode}_unchanged`, state)
  expect(state.hostUnchanged && state.diskUnchanged).toBe(true)
  return state
}
export async function focusEditor(ctx: Context) {
  await ctx.xtest.activateAndFocus()
  await editor(ctx).focus()
  await expect(editor(ctx)).toBeFocused()
}
export async function switchMode(ctx: Context, mode: Mode) {
  await closeFind(ctx)
  await ctx.frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await ctx.frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(
    ctx.frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    {
      timeout: 60_000,
      message: 'Task 604 switched editor readiness',
    },
  )
  ctx.mode = mode
  await frames(ctx.frame)
}
async function targetLocator(ctx: Context, target: Target) {
  const index = await editor(ctx).evaluate(
    (root, { mode, fragment }) => {
      const inner = (window as any).vditor.vditor
      if (!root.isConnected || root !== inner[mode].element)
        throw new Error('target root is not live')
      if (mode === 'sv') return -1
      const parsed = document.createElement('div')
      parsed.innerHTML =
        mode === 'ir'
          ? inner.lute.Md2VditorIRDOM(fragment)
          : inner.lute.Md2VditorDOM(fragment)
      const needle = parsed.querySelector('p')?.textContent
      const matches = Array.from(root.querySelectorAll(':scope > p'))
        .map((node, position) => ({ node, position }))
        .filter((item) => item.node.textContent === needle)
      if (matches.length !== 1)
        throw new Error('target paragraph is not unique')
      return matches[0].position
    },
    { mode: ctx.mode, fragment: target.fragment },
  )
  return index < 0 ? editor(ctx) : editor(ctx).locator(':scope > p').nth(index)
}
export async function selectTarget(
  ctx: Context,
  target: Target,
  rangeToken = '',
  forTyping = false,
  caretSetup: 'addRange' | 'requestCaret' = 'requestCaret',
) {
  const targetNode = await targetLocator(ctx, target)
  await targetNode.scrollIntoViewIfNeeded()
  await focusEditor(ctx)
  const placed = await targetNode.evaluate(
    (element, args) => {
      const w = window as any
      const root = w.vditor.vditor[args.mode].element as HTMLElement
      const text = element.textContent ?? ''
      const base = args.mode === 'sv' ? text.indexOf(args.fragment) : 0
      if (base < 0) return false
      const offsetsForSelection = () => {
        const extent =
          args.mode === 'sv' ? args.fragment.length : text.trimEnd().length
        let start = base + Math.floor(extent / 2)
        if (args.typing) start = base + 1
        if (args.token) start = text.toLowerCase().indexOf(args.token, base)
        return start < 0 ? null : { start, end: start + args.token.length }
      }
      const offsets = offsetsForSelection()
      if (!offsets) return false
      const { start, end } = offsets
      const textPoint = (offset: number) => {
        const iterator = document.createNodeIterator(
          element,
          NodeFilter.SHOW_TEXT,
        )
        let leaf = iterator.nextNode() as Text | null
        while (leaf && offset > leaf.length) {
          offset -= leaf.length
          leaf = iterator.nextNode() as Text | null
        }
        if (!leaf) throw new Error('target caret endpoint missing')
        return { node: leaf, offset }
      }
      const a = textPoint(start)
      const b = textPoint(end)
      const placeCaret = () => {
        if (args.caretSetup === 'addRange') {
          const range = document.createRange()
          range.setStart(a.node, a.offset)
          range.setEnd(b.node, b.offset)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          return
        }
        const requestCaret = w.__vmdeRequestCaret
        if (typeof requestCaret !== 'function')
          throw new Error('caret authority bridge unavailable')
        const delivered = requestCaret({ anchor: a, focus: b })
        if (!delivered) throw new Error('caret authority rejected target')
      }
      placeCaret()
      const selection = getSelection()!
      const range = selection.getRangeAt(0)
      range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      document.dispatchEvent(new Event('selectionchange'))
      if (args.typing) {
        w.__task604Typed = {
          root,
          index: Array.from(root.querySelectorAll(':scope > p')).indexOf(
            element,
          ),
          expected: `${text.slice(0, start)}x${text.slice(start)}`,
        }
      }
      return true
    },
    {
      mode: ctx.mode,
      fragment: target.fragment,
      token: rangeToken,
      typing: forTyping,
      caretSetup,
    },
  )
  expect(placed).toBe(true)
  await frames(ctx.frame)
  await expect(editor(ctx)).toBeFocused()
  expect(
    await targetNode.evaluate((element, mode) => {
      const owner = (window as any).vditor.vditor[mode].element
      return element.isConnected && owner.contains(element)
    }, ctx.mode),
  ).toBe(true)
  const settled = await selectionState(ctx, rangeToken)
  expect(
    settled.liveSelectionInEditor &&
      (rangeToken
        ? settled.rangeMatchesToken && !settled.rangeCollapsed
        : settled.rangeCollapsed),
  ).toBe(true)
  return targetNode
}
export async function readLengths(ctx: Context) {
  return ctx.frame.locator('body').evaluate(() => {
    const w = window as any
    const inner = w.vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    const exact = w.__vmdeE2EExactMarkdown?.()
    const hostSerialized = w.__vmdeE2ESnapshotMarkdown?.()
    const rendered = w.vditor.getValue() as string
    const sv = inner.currentMode === 'sv'
    const textLength = root.textContent?.length ?? 0
    return {
      exactAvailable: typeof exact === 'string',
      exactLength: exact?.length ?? 0,
      renderedLength: rendered.length,
      exactEqualsRendered: exact === rendered,
      svMode: sv,
      svTextContentLength: sv ? textLength : 0,
      svTextContentMinusExact: sv ? textLength - (exact?.length ?? 0) : 0,
      svTextContentEqualsExact: sv && root.textContent === exact,
      svHostSerializationAvailable: typeof hostSerialized === 'string',
      svHostSerializationEqualsExact: sv && hostSerialized === exact,
      seededIrReady: w.__vmdeIncrementalSeedStats?.state === 'ready',
      indexBuilds: w.__vmdeBlockHandleCacheMetrics?.indexBuilds ?? 0,
      // finish-init owns the index privately; the next hover's build delta is the observable proof.
      indexEntrySurvivedObservable: false,
    }
  })
}
function numericWork(work: TurnIntoProbeResult) {
  return JSON.parse(
    JSON.stringify(work, (key, value) => {
      if (key === 'entry')
        return {
          Md2VditorIRDOM: 0,
          Md2VditorDOM: 1,
          VditorIRDOM2Md: 2,
          VditorDOM2Md: 3,
        }[value]
      if (key === 'kind')
        return {
          liveRoot: 0,
          exact: 1,
          rendered: 2,
          largeOther: 3,
          fragment: 4,
        }[value]
      return value
    }),
  )
}
async function measure<T>(ctx: Context, action: () => Promise<T>) {
  const hostSource = await ctx.host()
  await ctx.frame
    .locator('body')
    .evaluate(
      (_body, source) => (window as any).__vmdeTurnIntoProbe.start(source),
      hostSource,
    )
  const value = await action()
  await ctx.frame
    .locator('body')
    .evaluate(() => (window as any).__vmdeTurnIntoProbe.endWorkload())
  await frames(ctx.frame)
  const work = (await ctx.frame
    .locator('body')
    .evaluate(() =>
      (window as any).__vmdeTurnIntoProbe.stop(),
    )) as TurnIntoProbeResult
  return { value, work: numericWork(work) }
}
async function quickPickState(ctx: Context, observed?: boolean) {
  // CP1's negative observation stays unchanged; R0 C supplies its positive wait result.
  const visible =
    observed ??
    (await picker(ctx)
      .waitFor({ state: 'visible', timeout: 1000 })
      .then(
        () => true,
        () => false,
      ))
  return {
    quickPickOpened: visible,
    optionsReturned: visible,
    optionsInferredFromQuickPick: true,
    spanEqualsOracleObservable: false,
    currentTypeIsParagraph:
      visible &&
      (await picker(ctx).getAttribute('placeholder')) === 'Current: Paragraph',
    heading2Offered:
      visible &&
      (await ctx.workbox
        .getByRole('option', { name: /Heading 2/u })
        .first()
        .isVisible()),
  }
}
async function dismissPicker(ctx: Context) {
  if (!(await picker(ctx).isVisible())) return
  await ctx.xtest.key('Escape')
  await picker(ctx).waitFor({ state: 'hidden' })
}
async function closeFind(ctx: Context) {
  const widget = ctx.frame.locator('.vmde-find-replace')
  if (!(await widget.isVisible())) return
  const input = widget.locator('[data-find]')
  await input.focus()
  await expect(input).toBeFocused()
  await ctx.xtest.key('Escape')
  await widget.waitFor({ state: 'hidden' })
}
export async function selectionState(ctx: Context, token = '') {
  return editor(ctx).evaluate((root, query) => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    return {
      rangeCount: selection?.rangeCount ?? 0,
      liveSelectionInEditor: Boolean(
        range &&
          root.contains(range.startContainer) &&
          root.contains(range.endContainer),
      ),
      rangeCollapsed: range?.collapsed ?? false,
      rangeMatchesToken: Boolean(
        query && range?.toString().toLowerCase() === query,
      ),
      selectionMatchesToken: Boolean(
        query && selection?.toString().toLowerCase() === query,
      ),
      findFocused: Boolean(
        document.activeElement?.closest('.vmde-find-replace'),
      ),
    }
  }, token)
}
export async function findFar(ctx: Context) {
  await closeFind(ctx)
  await focusEditor(ctx)
  await ctx.xtest.key('ctrl+f')
  const widget = ctx.frame.locator('.vmde-find-replace')
  const input = widget.locator('[data-find]')
  await expect(input).toBeFocused()
  await ctx.xtest.key('ctrl+a')
  await ctx.xtest.type(TOKEN, 20)
  await expect.poll(async () => (await input.inputValue()) === TOKEN).toBe(true)
  await expect(input).toBeFocused()
  const status = widget.locator('[data-status]')
  await expect
    .poll(async () => (await status.textContent()) === '1 of 2')
    .toBe(true)
  const moved = await measure(ctx, () => ctx.xtest.key('F3').then(() => true))
  await expect
    .poll(async () => (await status.textContent()) === '2 of 2')
    .toBe(true)
  await expect(input).toBeFocused()
  return {
    focusWork: moved.work,
    selectionBeforeRequest: await selectionState(ctx, TOKEN),
    captureWasDeferred:
      moved.work.blockTransformCaptureCalls === 0 &&
      moved.work.editSyncSnapshotCalls === 0,
  }
}
async function moveOver(
  ctx: Context,
  node: Awaited<ReturnType<typeof targetLocator>>,
) {
  expect(
    await node.evaluate(
      (element) =>
        element.isConnected &&
        document.querySelector('#app')!.contains(element),
    ),
  ).toBe(true)
  await node.hover({ position: { x: 8, y: 8 } })
  await frames(ctx.frame)
  return ctx.frame.locator('body').evaluate(() => {
    const handle =
      document.querySelector<HTMLButtonElement>('.vmde-block-handle')
    return Boolean(
      handle && !handle.hidden && handle.getBoundingClientRect().width > 0,
    )
  })
}
export async function requestAndMeasure(ctx: Context) {
  return measure(ctx, async () => {
    await command(ctx, 'vmde.turnInto')
    return quickPickState(ctx)
  })
}
async function requestWithPositivePicker(ctx: Context, timeoutMs: number) {
  return measure(ctx, async () => {
    const startedAt = performance.now()
    const observed = picker(ctx)
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(
        () => ({
          visible: true,
          timeToPickerMs: performance.now() - startedAt,
        }),
        (error) => {
          if (!(error instanceof errors.TimeoutError)) throw error
          return {
            visible: false,
            timeToPickerMs: performance.now() - startedAt,
          }
        },
      )
    const [, result] = await Promise.all([
      command(ctx, 'vmde.turnInto'),
      observed,
    ])
    const immediate = await quickPickState(ctx, result.visible)
    const heading2Offered =
      result.visible && !immediate.heading2Offered
        ? await expect
            .poll(
              () =>
                ctx.workbox
                  .getByRole('option', { name: /Heading 2/u })
                  .first()
                  .isVisible(),
              { timeout: 1_000 },
            )
            .toBe(true)
            .then(
              () => true,
              () => false,
            )
        : immediate.heading2Offered
    return {
      ...immediate,
      heading2InitiallyVisible: immediate.heading2Offered,
      heading2Offered,
      timeToPickerMs: result.timeToPickerMs,
    }
  })
}
export async function selectionRoute(
  ctx: Context,
  target: Target,
  route: 'caret' | 'range' | 'find',
) {
  await closeFind(ctx)
  const node = await targetLocator(ctx, target)
  await node.scrollIntoViewIfNeeded()
  const visual = ctx.mode !== 'sv'
  if (visual) await moveOver(ctx, node)
  await ctx.workbox.mouse.move(0, 0)
  const navigation = route === 'find' ? await findFar(ctx) : undefined
  if (route !== 'find')
    await selectTarget(ctx, target, route === 'range' ? TOKEN : '')
  const before = await selectionState(ctx, route === 'caret' ? '' : TOKEN)
  const measured = await requestAndMeasure(ctx)
  const after = await selectionState(ctx, route === 'caret' ? '' : TOKEN)
  await dismissPicker(ctx)
  const nextHover = visual
    ? await measure(ctx, () => moveOver(ctx, node))
    : undefined
  const authority = await unchanged(ctx)
  return {
    ...authority,
    before,
    after,
    ...measured.value,
    work: measured.work,
    ...(navigation ?? {}),
    hoverMeasured: visual,
    ...(nextHover
      ? {
          postRequestHoverIndexBuilds: nextHover.work.indexBuilds,
          hoverWork: nextHover.work,
        }
      : {}),
  }
}
async function handleRoute(ctx: Context, target: Target) {
  await closeFind(ctx)
  const node = await targetLocator(ctx, target)
  await node.scrollIntoViewIfNeeded()
  await ctx.workbox.mouse.move(0, 0)
  const hovered = await measure(ctx, () => moveOver(ctx, node))
  if (!hovered.value)
    return {
      handleVisible: false,
      menuAttempted: false,
      hoverWork: hovered.work,
    }
  const picked = await measure(ctx, async () => {
    await ctx.frame.locator('.vmde-block-handle').click()
    await ctx.frame
      .locator('.vmde-block-handle-menu [data-action="turnInto"]')
      .click()
    return quickPickState(ctx)
  })
  await dismissPicker(ctx)
  await unchanged(ctx)
  return {
    handleVisible: true,
    menuAttempted: true,
    hoverWork: hovered.work,
    ...picked.value,
    work: picked.work,
  }
}
export async function modeMeasurements(ctx: Context, label: string) {
  const lengths = await readLengths(ctx)
  record(`${label}_lengths`, lengths)
  const node = await targetLocator(ctx, near)
  await node.scrollIntoViewIfNeeded()
  await ctx.workbox.mouse.move(0, 0)
  const cold = await measure(ctx, () => moveOver(ctx, node))
  record(`${label}_D9`, {
    preexistingBuilds: lengths.indexBuilds,
    coldBuildObserved: cold.work.indexBuilds > 0,
    ...cold,
  })
  record(`${label}_caret`, await selectionRoute(ctx, near, 'caret'))
  record(`${label}_range`, await selectionRoute(ctx, far, 'range'))
  record(`${label}_find`, await selectionRoute(ctx, far, 'find'))
  record(`${label}_handle`, await handleRoute(ctx, near))
  await unchanged(ctx)
}
export async function chooseHeading2(ctx: Context) {
  await picker(ctx).focus()
  await expect(picker(ctx)).toBeFocused()
  await ctx.xtest.key('ctrl+a')
  await ctx.xtest.type('Heading 2', 20)
  await expect
    .poll(async () => (await picker(ctx).inputValue()) === 'Heading 2')
    .toBe(true)
  await expect(picker(ctx)).toBeFocused()
  await ctx.xtest.key('Return')
  await picker(ctx).waitFor({ state: 'hidden' })
}
export async function hostEquals(ctx: Context, expected: string) {
  return expect
    .poll(async () => (await ctx.host()) === expected, { timeout: 20_000 })
    .toBe(true)
    .then(
      () => true,
      () => false,
    )
}
export async function saveAndCompare(ctx: Context, expected: string) {
  await command(ctx, 'workbench.action.files.save')
  return readFileSync(ctx.file, 'utf8') === expected
}
export async function smallHistoryControl(ctx: Context) {
  await selectTarget(ctx, smallTarget)
  const ceiling = await requestAndMeasure(ctx)
  record('small_roundTrip_ceiling', ceiling)
  expect(ceiling.value.quickPickOpened && ceiling.value.heading2Offered).toBe(
    true,
  )
  await chooseHeading2(ctx)
  const applied = await hostEquals(ctx, headingPlan(SMALL, smallTarget))
  record('small_heading2_applied', applied)
  expect(applied).toBe(true)
  await focusEditor(ctx)
  await ctx.xtest.key('ctrl+z')
  const undone = await hostEquals(ctx, SMALL)
  const disk = await saveAndCompare(ctx, SMALL)
  record('D5_small_roundTrip', {
    diagnosticAtSourceLegRun: false,
    largeNonRoundTripUndoMeasured: false,
    heading2Applied: applied,
    oneOsUndoRestoredHost: undone,
    savedDiskRestored: disk,
  })
  expect(undone && disk).toBe(true)
}
export async function trustedEditControl(
  ctx: Context,
  caretSetup: 'addRange' | 'requestCaret',
  applyHeading2 = false,
) {
  const label =
    caretSetup === 'addRange'
      ? 'trusted_edit_add_range'
      : 'trusted_edit_request_caret'
  await selectTarget(ctx, multi, '', true, caretSetup)
  const undoStackLength = () =>
    ctx.frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      return inner.undo.ir.undoStack.length as number
    })
  // The opening snapshot and typed edit use Vditor's 800 ms Undo debounce. Wait for both
  // observable checkpoints so the one Ctrl+Z below targets the acknowledged edit.
  await expect.poll(undoStackLength).toBeGreaterThan(0)
  const openingUndoStackLength = await undoStackLength()
  await ctx.xtest.type('x', 20)
  await expect
    .poll(() =>
      ctx.frame.locator('body').evaluate(() => {
        const saved = (window as any).__task604Typed
        const actual = saved.root.querySelectorAll(':scope > p')[saved.index]
        return actual?.textContent === saved.expected
      }),
    )
    .toBe(true)
  await expect.poll(async () => (await ctx.host()) !== FIXTURE).toBe(true)
  await expect
    .poll(undoStackLength, { timeout: 10_000 })
    .toBeGreaterThan(openingUndoStackLength)
  const editedUndoStackLength = await undoStackLength()
  record(`${label}_checkpoint`, {
    openingUndoStackLength,
    editedUndoStackLength,
  })
  const editedSource = await ctx.host()
  const nearNode = await selectTarget(ctx, near, '', false, caretSetup)
  const nearSelectionInTarget = await nearNode.evaluate((element) => {
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    return Boolean(
      range &&
        element.contains(range.startContainer) &&
        element.contains(range.endContainer),
    )
  })
  record(`${label}_near_selection`, { nearSelectionInTarget })
  const options = await requestWithPositivePicker(ctx, 5_000)
  record(`${label}_options`, options)
  let heading2Applied = false
  let hostOutsideBlockMeasured = false
  let hostOutsideBlockChanged = false
  let appliedSource = editedSource
  if (
    applyHeading2 &&
    options.value.quickPickOpened &&
    options.value.currentTypeIsParagraph &&
    options.value.heading2Offered
  ) {
    await chooseHeading2(ctx)
    const headingNeedle = `## ${near.fragment}`
    await expect
      .poll(async () => (await ctx.host()).includes(headingNeedle), {
        timeout: 20_000,
      })
      .toBe(true)
    appliedSource = await ctx.host()
    const beforeTargetAt = editedSource.indexOf(near.fragment)
    const headingAt = appliedSource.indexOf(headingNeedle)
    expect(
      beforeTargetAt >= 0 &&
        editedSource.lastIndexOf(near.fragment) === beforeTargetAt &&
        headingAt >= 0 &&
        appliedSource.lastIndexOf(headingNeedle) === headingAt,
    ).toBe(true)
    // Compare the exact bytes on both sides of the target, excluding its transformed text.
    hostOutsideBlockChanged =
      editedSource.slice(0, beforeTargetAt) !==
        appliedSource.slice(0, headingAt) ||
      editedSource.slice(beforeTargetAt + near.fragment.length) !==
        appliedSource.slice(headingAt + headingNeedle.length)
    hostOutsideBlockMeasured = true
    heading2Applied = true
  } else {
    await dismissPicker(ctx)
  }
  record(`${label}_apply`, {
    heading2Applied,
    hostOutsideBlockMeasured,
    hostOutsideBlockChanged,
  })
  await focusEditor(ctx)
  record(`${label}_before_undo`, {
    undoStackLength: await undoStackLength(),
  })
  await ctx.xtest.key('ctrl+z')
  let undoCount = 1
  let firstUndoRestoredEdited = false
  let firstUndoRestoredOriginal = false
  let firstUndoExactRecovered = false
  let firstUndoStackLength = 0
  let secondUndoStackLength = 0
  let secondUndoChangedHost = false
  let secondUndoRestoredEdited = false
  let secondUndoRestoredOriginal = false
  let consumedCaretCheckpoint = false
  if (heading2Applied) {
    await expect
      .poll(async () => (await ctx.host()) !== appliedSource, {
        timeout: 20_000,
      })
      .toBe(true)
    const afterFirstUndo = await ctx.host()
    firstUndoStackLength = await undoStackLength()
    firstUndoRestoredEdited = afterFirstUndo === editedSource
    firstUndoRestoredOriginal = afterFirstUndo === FIXTURE
    if (!firstUndoRestoredOriginal) {
      firstUndoExactRecovered = await expect
        .poll(
          () =>
            ctx.frame
              .locator('body')
              .evaluate(
                (_body, expected) =>
                  (window as any).__vmdeE2EExactMarkdown?.() === expected,
                afterFirstUndo,
              ),
          { timeout: 5_000 },
        )
        .toBe(true)
        .then(
          () => true,
          () => false,
        )
      await focusEditor(ctx)
      await ctx.xtest.key('ctrl+z')
      undoCount++
      await expect
        .poll(undoStackLength, { timeout: 5_000 })
        .toBeLessThan(firstUndoStackLength)
      secondUndoStackLength = await undoStackLength()
      // A caret-only checkpoint has no host edit; observe past Vditor's 800 ms input delay.
      secondUndoChangedHost = await expect
        .poll(async () => (await ctx.host()) !== afterFirstUndo, {
          timeout: 1_200,
        })
        .toBe(true)
        .then(
          () => true,
          () => false,
        )
      const afterSecondUndo = await ctx.host()
      secondUndoRestoredEdited = afterSecondUndo === editedSource
      secondUndoRestoredOriginal = afterSecondUndo === FIXTURE
      consumedCaretCheckpoint =
        !secondUndoChangedHost &&
        secondUndoRestoredEdited &&
        secondUndoStackLength === editedUndoStackLength
      record(`${label}_undo_steps`, {
        firstUndoStackLength,
        secondUndoStackLength,
        secondUndoChangedHost,
        secondUndoRestoredEdited,
        secondUndoRestoredOriginal,
        consumedCaretCheckpoint,
      })
      if (consumedCaretCheckpoint) {
        await focusEditor(ctx)
        await ctx.xtest.key('ctrl+z')
        undoCount++
      }
    }
  }
  const hostOriginal = await hostEquals(ctx, FIXTURE)
  const diskOriginal = await saveAndCompare(ctx, FIXTURE)
  record(`${label}_undo`, {
    undoCount,
    firstUndoRestoredEdited,
    firstUndoRestoredOriginal,
    firstUndoExactRecovered,
    firstUndoStackLength,
    secondUndoStackLength,
    secondUndoChangedHost,
    secondUndoRestoredEdited,
    secondUndoRestoredOriginal,
    consumedCaretCheckpoint,
    hostOriginal,
    diskOriginal,
  })
  expect(hostOriginal && diskOriginal).toBe(true)
  return {
    quickPickOpened: options.value.quickPickOpened,
    currentTypeIsParagraph: options.value.currentTypeIsParagraph,
    heading2Offered: options.value.heading2Offered,
    heading2InitiallyVisible: options.value.heading2InitiallyVisible,
    timeToPickerMs: options.value.timeToPickerMs,
    nearSelectionInTarget,
    heading2Applied,
    hostOutsideBlockMeasured,
    hostOutsideBlockChanged,
  }
}
