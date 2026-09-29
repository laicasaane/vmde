import { createHash } from 'node:crypto'
import { errors } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import {
  FIXTURE,
  FIXTURE_SHA256,
  literalMatches,
} from '../../test/vscode-e2e/find-replace-fixture-helpers'
import {
  installTurnIntoProbe,
  type TurnIntoProbeResult,
} from '../../test/vscode-e2e/turn-into-probe'

type Page = import('@playwright/test').Page
type Mode = 'ir' | 'wysiwyg' | 'sv'
type Span = { start: number; end: number; caret: number }
const TOKEN = 'mtnnwcr'
const SMALL = 'target paragraph\n'
const NORMALIZING = '|a|b|\n|---|---|\n|x|y|\n\ntarget paragraph\n'
const HISTORY_TIMEOUT = 5_000
// Node derives offsets; the browser receives text only as source or a locator needle.
const lines = FIXTURE.split('\n')
let cursor = 0
const starts = lines.map((line) => {
  const start = cursor
  cursor += line.length + 1
  return start
})
const lineSpan = (first: number, last = first): Span => ({
  start: starts[first - 1],
  end: starts[last - 1] + lines[last - 1].length,
  caret: starts[first - 1] + Math.floor(lines[first - 1].length / 2),
})
const farMatches = literalMatches(FIXTURE, TOKEN, false)
const targets = {
  near: lineSpan(208),
  far: lineSpan(1297),
  emphasized: lineSpan(24),
  multi: lineSpan(16, 17),
  pair: lineSpan(24, 27),
  table: lineSpan(3, 14),
  farToken: { ...farMatches[1], caret: farMatches[1]?.start },
}
const nearPlan = `${FIXTURE.slice(0, targets.near.start)}## ${FIXTURE.slice(targets.near.start)}`
const farPlan = `${FIXTURE.slice(0, targets.far.start)}## ${FIXTURE.slice(targets.far.start)}`
const shiftedFar = {
  start: targets.far.start + 3,
  end: targets.far.end + 3,
  caret: targets.far.caret + 3,
}
const nearFarPlan = `${nearPlan.slice(0, shiftedFar.start)}## ${nearPlan.slice(shiftedFar.start)}`

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}
async function boot(page: Page, mode: Mode = 'ir') {
  await page.addInitScript(() => {
    ;(window as any).__vmdeBlockHandleCacheMetrics = {
      indexBuilds: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
    }
  })
  await page.goto(`/turn-into-exact.html?mode=${mode}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.mouse.move(0, 0)
  await page.evaluate(installTurnIntoProbe)
}
async function setSource(page: Page, source = FIXTURE) {
  await page.mouse.move(0, 0)
  await page.evaluate((value) => {
    const w = window as any
    w.__turnIntoFindEvidence?.stop()
    delete w.__turnIntoFindEvidence
    w.__setValue(value)
  }, source)
  await frames(page)
  expect(
    await page.evaluate((value) => (window as any).__exact() === value, source),
  ).toBe(true)
}
async function switchMode(page: Page, mode: Mode) {
  await page.evaluate((next) => (window as any).__switchMode(next), mode)
  await page.waitForFunction((next) => (window as any).__mode() === next, mode)
  await frames(page)
}
async function choose(page: Page, span: Span, token?: string) {
  expect(
    await page.evaluate(
      ({ span, token }) => (window as any).__select(span, token),
      { span, token },
    ),
  ).toBe(true)
  await frames(page)
}

async function pollExact(page: Page, expected: string) {
  await expect
    .poll(
      () =>
        page.evaluate((value) => (window as any).__exact() === value, expected),
      { timeout: HISTORY_TIMEOUT },
    )
    .toBe(true)
}

async function rememberTransform(page: Page, span: Span, expected: string) {
  expect(
    await page.evaluate(
      ({ span, expected }) => {
        const w = window as any
        w.__transformBefore = w.__diagnosticPlan(span)
        return (
          w.__transformBefore.exactPlan === expected &&
          w.__transformBefore.renderedPlan !== null &&
          w.__transformBefore.before !== w.__transformBefore.beforeRendered
        )
      },
      { span, expected },
    ),
  ).toBe(true)
}

async function expectUndoBaseline(page: Page, source: string) {
  const history = await historyAction(page, 'undo')
  expect(history.callbackObserved).toBe(true)
  await pollExact(page, source)
  expect(
    await page.evaluate(() => {
      const w = window as any
      return w.__getValue() === w.__transformBefore.beforeRendered
    }),
  ).toBe(true)
}

// C5's JSON values are exclusively numbers/booleans. Entry/kind indices use the orders below;
// the shared probe retains named kinds for other consumers, and never returns input strings.
function numericWork(work: TurnIntoProbeResult) {
  const { luteCalls, ...rest } = work
  return {
    ...rest,
    luteCalls: luteCalls.map((call) => ({
      entry: [
        'Md2VditorIRDOM',
        'Md2VditorDOM',
        'VditorIRDOM2Md',
        'VditorDOM2Md',
      ].indexOf(call.entry),
      kind: ['liveRoot', 'exact', 'rendered', 'largeOther', 'fragment'].indexOf(
        call.kind,
      ),
      inputLength: call.inputLength,
    })),
  }
}
function numericOnly(value: unknown): boolean {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'boolean' ||
        Boolean(
          value &&
            typeof value === 'object' &&
            Object.values(value).every(numericOnly),
        )
}
function numericRecorder(report: Record<string, unknown>) {
  return (key: string, value: unknown) => {
    report[key] = value
    console.log(JSON.stringify({ [key]: value }))
  }
}
async function measure<T>(page: Page, action: () => Promise<T>) {
  await page.evaluate(() => (window as any).__vmdeTurnIntoProbe.start())
  try {
    const value = await action()
    await page.evaluate(() => (window as any).__vmdeTurnIntoProbe.endWorkload())
    await frames(page)
    const work: TurnIntoProbeResult = await page.evaluate(() =>
      (window as any).__vmdeTurnIntoProbe.stop(),
    )
    return { value, work: numericWork(work) }
  } catch (error) {
    await page.evaluate(() => (window as any).__vmdeTurnIntoProbe.stop())
    throw error
  }
}
async function observeFindRange(page: Page) {
  return page.evaluate(
    ({ span, needle, token }) => {
      const w = window as any
      w.__turnIntoFindEvidence?.stop()
      // Resolve the target outside the armed window: __target snapshots exact source.
      const target = w.__target(span) as HTMLElement
      const root = w.__root() as HTMLElement
      const text = target.textContent ?? ''
      const expectedStart = text.indexOf(needle)
      const unique =
        expectedStart >= 0 && text.indexOf(needle, expectedStart + 1) < 0
      const readRange = () => {
        const selection = getSelection()
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null
        const inside = Boolean(
          range &&
            target.contains(range.startContainer) &&
            target.contains(range.endContainer),
        )
        let offset = -1
        if (range && inside) {
          const prefix = document.createRange()
          prefix.selectNodeContents(target)
          prefix.setEnd(range.startContainer, range.startOffset)
          offset = prefix.toString().length
        }
        const rangeMatchesToken = range?.toString().toLowerCase() === token
        return {
          rangeCount: selection?.rangeCount ?? 0,
          selectionMatchesToken: selection?.toString().toLowerCase() === token,
          rangeMatchesToken,
          rangeWithinTarget:
            unique &&
            inside &&
            rangeMatchesToken &&
            offset >= expectedStart &&
            offset + token.length <= expectedStart + needle.length,
          findFocused: Boolean(
            document.activeElement?.closest('.vmde-find-replace'),
          ),
        }
      }
      let focusoutCount = 0
      let atFocusout = readRange()
      const onFocusout = (event: FocusEvent) => {
        if (
          !(event.target instanceof Node) ||
          !root.contains(event.target) ||
          !(event.relatedTarget instanceof Element) ||
          !event.relatedTarget.closest('.vmde-find-replace')
        )
          return
        focusoutCount++
        atFocusout = readRange()
      }
      document.addEventListener('focusout', onFocusout, true)
      w.__turnIntoFindEvidence = {
        read: () => ({ current: readRange(), focusoutCount, atFocusout }),
        stop: () => document.removeEventListener('focusout', onFocusout, true),
      }
      return unique
    },
    {
      span: targets.far,
      needle: FIXTURE.slice(targets.far.start, targets.far.end),
      token: TOKEN,
    },
  )
}

async function findFar(page: Page) {
  await page.evaluate(() => (window as any).__openFind())
  const input = page.getByRole('textbox', { name: 'Find', exact: true })
  await input.fill(TOKEN)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('.vmde-find-replace [data-status]')
            ?.textContent === '1 of 2',
      ),
    )
    .toBe(true)
  expect(await observeFindRange(page)).toBe(true)
  const moved = await measure(page, () => input.press('Enter'))
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector('.vmde-find-replace [data-status]')
            ?.textContent === '2 of 2' &&
          document.activeElement ===
            document.querySelector('.vmde-find-replace [data-find]'),
      ),
    )
    .toBe(true)
  const selectionBeforeRequest = await page.evaluate(() => {
    const evidence = (window as any).__turnIntoFindEvidence
    evidence.stop()
    return evidence.read()
  })
  // Find intentionally restores input focus. Selection.toString() can then describe the input;
  // prove the DOM range at focus transfer or now, and check restoration again at the command.
  console.log(JSON.stringify({ findNavigation: selectionBeforeRequest }))
  expect(
    selectionBeforeRequest.current.rangeWithinTarget ||
      (selectionBeforeRequest.focusoutCount > 0 &&
        selectionBeforeRequest.atFocusout.rangeWithinTarget),
  ).toBe(true)
  return {
    selectionBeforeRequest,
    focusWork: moved.work,
    captureWasDeferred:
      moved.work.blockTransformCaptureCalls === 0 &&
      moved.work.editSyncSnapshotCalls === 0,
  }
}
async function request(page: Page, span: Span, token = '') {
  return page.evaluate(
    ({ span, token }) => {
      const w = window as any
      const selection = getSelection()
      const live = Boolean(
        selection?.rangeCount &&
          w.__root().contains(selection.getRangeAt(0).startContainer),
      )
      const options = w.__blockOptions()
      const restored = getSelection()
      const restoredRange = restored?.rangeCount ? restored.getRangeAt(0) : null
      const findState = w.__turnIntoFindEvidence?.read().current
      const outcome = {
        optionsReturned: Boolean(options),
        token: options?.token ?? 0,
        currentTypeIsParagraph: options?.currentType === 'paragraph',
        // Status code: absent 0, changed 1, unsupported 2, noop 3, confirmation 4.
        h2Status: [
          'absent',
          'changed',
          'unsupported',
          'noop',
          'confirm-required',
        ].indexOf(
          options?.targets.find((t: any) => t.type === 'h2')?.status ??
            'absent',
        ),
        h2Changed:
          options?.targets.some(
            (t: any) => t.type === 'h2' && t.status === 'changed',
          ) ?? false,
        spanEqualsOracle:
          options?.span.start === span.start && options?.span.end === span.end,
        liveSelectionInEditorAtRequest: live,
        restoredMatchesToken: Boolean(
          token && restoredRange?.toString().toLowerCase() === token,
        ),
        findRangeEvidenceAvailable: Boolean(findState),
        restoredRangeWithinTarget: Boolean(findState?.rangeWithinTarget),
        selectionPresentationMatchesToken: Boolean(
          token && restored?.toString().toLowerCase() === token,
        ),
        indexEntrySurvived: w.__indexSurvived(),
      }
      w.__vmdeTurnIntoProbe?.endWorkload()
      return outcome
    },
    { span, token },
  )
}
async function hoverPosition(page: Page, span: Span) {
  const coordinates = await page.evaluate((value) => {
    const p = (window as any).__target(value) as HTMLElement
    p.scrollIntoView({ block: 'center' })
    const rect = p.getBoundingClientRect()
    return {
      x: rect.left + Math.min(20, rect.width / 2),
      y: rect.top + Math.min(8, rect.height / 2),
    }
  }, span)
  await frames(page)
  return coordinates
}
async function hover(page: Page, coordinates: { x: number; y: number }) {
  await page.mouse.move(coordinates.x, coordinates.y)
  await frames(page)
  return page.evaluate(() => {
    const handle =
      document.querySelector<HTMLButtonElement>('.vmde-block-handle')
    return Boolean(
      handle && !handle.hidden && handle.getBoundingClientRect().width > 0,
    )
  })
}
async function handleRoute(page: Page, span: Span) {
  const coordinates = await hoverPosition(page, span)
  const hovered = await measure(page, () => hover(page, coordinates))
  if (!hovered.value)
    return {
      handleVisible: false,
      menuAttempted: false,
      hoverWork: hovered.work,
    }
  const action = await measure(page, async () => {
    await page.locator('.vmde-block-handle').click()
    await page
      .locator('.vmde-block-handle-menu [data-action="turnInto"]')
      .click()
    return page.evaluate((expected) => {
      const options = (window as any).__lastOptions
      return {
        optionsReturned: Boolean(options),
        spanEqualsOracle:
          options?.span.start === expected.start &&
          options?.span.end === expected.end,
      }
    }, span)
  })
  return {
    handleVisible: true,
    menuAttempted: true,
    hoverWork: hovered.work,
    ...action,
  }
}

// Fixture and source-target preconditions apply to every acceptance and diagnostic case.
test.beforeEach(() => {
  expect(
    createHash('sha256').update(FIXTURE).digest('hex') === FIXTURE_SHA256,
  ).toBe(true)
  expect(
    Buffer.byteLength(FIXTURE) === 174527 && FIXTURE.length === 174517,
  ).toBe(true)
  expect(
    farMatches.length === 2 &&
      farMatches[1].start >= targets.far.start &&
      farMatches[1].end <= targets.far.end,
  ).toBe(true)
  expect(
    !/[`*_[\]<>\\|~#]/u.test(
      FIXTURE.slice(targets.near.start, targets.near.end),
    ),
  ).toBe(true)
})
for (const mode of ['ir', 'wysiwyg'] as const) {
  for (const viaFind of [false, true]) {
    const caseId =
      mode === 'ir' ? (viaFind ? 'C3' : 'C1') : viaFind ? 'C4' : 'C2'
    test(`${caseId} ${mode} ${viaFind ? 'Find' : 'selection'} preserves exact bytes through Heading 2, Undo and Redo`, async ({
      page,
    }) => {
      test.setTimeout(90_000)
      await boot(page)
      await setSource(page)
      if (mode === 'wysiwyg') await switchMode(page, mode)
      if (viaFind) await findFar(page)
      else await choose(page, targets.near)
      const span = viaFind ? targets.far : targets.near
      const plan = viaFind ? farPlan : nearPlan
      await rememberTransform(page, span, plan)
      const options = await request(page, span, viaFind ? TOKEN : '')
      if (viaFind) {
        console.log(JSON.stringify({ findCommand: options }))
        expect(
          options.restoredMatchesToken && options.restoredRangeWithinTarget,
        ).toBe(true)
      }
      expect(options.optionsReturned).toBe(true)
      expect(
        options.currentTypeIsParagraph &&
          options.h2Changed &&
          options.spanEqualsOracle,
      ).toBe(true)
      const applied = await applyChoice(page, span, options.token)
      expectAppliedExact(applied)
      expect(applied.postedCount).toBe(1)
      await pollExact(page, plan)
      await expectUndoBaseline(page, FIXTURE)
      expect((await historyAction(page, 'redo')).callbackObserved).toBe(true)
      await pollExact(page, plan)
    })
  }

  test(`${mode === 'ir' ? 'C1w' : 'C2w'} ${mode} warm capture keeps its index and serialization budget`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    await boot(page, mode)
    await setSource(page)
    expect(
      await page.evaluate(() => (window as any).__readIndex().returned),
    ).toBe(true)
    expect(await page.evaluate(() => (window as any).__rememberIndex())).toBe(
      true,
    )
    await choose(page, targets.near)
    const captured = await measure(page, () => request(page, targets.near))
    expect(
      captured.value.optionsReturned &&
        captured.value.h2Changed &&
        captured.value.spanEqualsOracle,
    ).toBe(true)
    expect(
      captured.work.cacheMetricsInstrumented &&
        captured.work.snapshotsInstrumented,
    ).toBe(true)
    expect(captured.work.indexBuilds).toBe(0)
    expect(captured.work.fullGetValueCalls).toBeLessThanOrEqual(1)
    expect(captured.work.rootLuteCalls).toBeLessThanOrEqual(2)
    expect(captured.work.markerInsertions).toBe(0)
    expect(captured.value.indexEntrySurvived).toBe(true)
    expect(await page.evaluate(() => (window as any).__indexSurvived())).toBe(
      true,
    )
  })
}

async function captureRoute(
  page: Page,
  span: Span,
  route: 'caret' | 'range' | 'find',
  source = FIXTURE,
) {
  await setSource(page, source)
  const focus = route === 'find' ? await findFar(page) : undefined
  if (route !== 'find')
    await choose(page, span, route === 'range' ? TOKEN : undefined)
  const lengths = await page.evaluate(() => (window as any).__lengths())
  const visual = await page.evaluate(() => (window as any).__mode() !== 'sv')
  // Locating/scrolling snapshots exact source, so keep it outside both action windows.
  const coordinates = visual ? await hoverPosition(page, span) : undefined
  await page.evaluate(() => (window as any).__rememberIndex())
  const captured = await measure(page, () =>
    request(page, span, route === 'caret' ? '' : TOKEN),
  )
  const afterHover = coordinates
    ? await measure(page, () => hover(page, coordinates))
    : undefined
  const mappings = await page.evaluate(() => (window as any).__mapping())
  const unchanged = await page.evaluate(
    (value) => (window as any).__exact() === value,
    source,
  )
  return {
    ...lengths,
    ...captured.value,
    work: captured.work,
    ...mappings,
    ...(focus ?? {}),
    hoverMeasured: visual,
    ...(afterHover
      ? {
          postRequestHoverIndexBuilds: afterHover.work.indexBuilds,
          hoverWork: afterHover.work,
        }
      : {}),
    exactAuthorityUnchanged: unchanged,
  }
}
async function oracleApply(page: Page, span: Span) {
  const token = await page.evaluate((value) => {
    const w = window as any
    w.__transformBefore = w.__diagnosticPlan(value)
    return w.__oracleOptionsAt(value.start, value.end)?.token ?? 0
  }, span)
  if (!token) return { oracleReturned: false, applied: false }
  return { oracleReturned: true, ...(await applyChoice(page, span, token)) }
}

async function applyChoice(page: Page, span: Span, token: number) {
  const measured = await measure(page, () =>
    page.evaluate(
      (value) => (window as any).__blockApply(value, { type: 'h2' }),
      token,
    ),
  )
  const fidelity = await page.evaluate((value) => {
    const w = window as any
    const expected = w.__transformBefore
    const post = w.__posted()
    return {
      postedCount: post.count,
      errors: post.errors,
      postMatchesExactPlan: post.markdown === expected.exactPlan,
      postDiffersFromRenderedPlan: post.markdown !== expected.renderedPlan,
      outsideBytesUnchanged:
        typeof post.markdown === 'string' &&
        post.markdown.slice(0, value.start) ===
          expected.before.slice(0, value.start) &&
        post.markdown.slice(value.start + 3) ===
          expected.before.slice(value.start),
      exactMatchesPlan: w.__exact() === expected.exactPlan,
    }
  }, span)
  return {
    applied: measured.value,
    work: measured.work,
    ...fidelity,
  }
}

function expectAppliedExact(result: Awaited<ReturnType<typeof applyChoice>>) {
  expect(result.applied).toBe(true)
  expect(result.errors).toBe(0)
  expect(
    result.postMatchesExactPlan &&
      result.postDiffersFromRenderedPlan &&
      result.outsideBytesUnchanged &&
      result.exactMatchesPlan,
  ).toBe(true)
}
async function oracleHistory(page: Page) {
  await setSource(page)
  const first = await oracleApply(page, targets.near)
  await page.evaluate(() => (window as any).__undo())
  await frames(page)
  const undo = await page.evaluate(() => {
    const w = window as any
    return {
      exactRestored: w.__exact() === w.__transformBefore.before,
      renderedRestored: w.__getValue() === w.__transformBefore.beforeRendered,
    }
  })
  await page.evaluate(() => (window as any).__redo())
  await frames(page)
  const redo = await page.evaluate(
    () =>
      (window as any).__exact() === (window as any).__transformBefore.exactPlan,
  )
  await setSource(page)
  const twiceFirst = await oracleApply(page, targets.near)
  const shift = twiceFirst.applied ? 3 : 0
  const twiceSecond = await oracleApply(page, {
    start: targets.far.start + shift,
    end: targets.far.end + shift,
    caret: targets.far.caret + shift,
  })
  await page.evaluate(() => (window as any).__undo())
  await frames(page)
  await page.evaluate(() => (window as any).__undo())
  await frames(page)
  const twoUndos = await page.evaluate(
    (value) => (window as any).__exact() === value,
    FIXTURE,
  )
  return {
    first,
    undo,
    redoRestored: redo,
    twiceFirst,
    twiceSecond,
    twoUndosRestored: twoUndos,
  }
}

async function applyHistorySelection(page: Page, span: Span, plan: string) {
  await choose(page, span)
  await rememberTransform(page, span, plan)
  const options = await request(page, span)
  expect(
    options.optionsReturned && options.spanEqualsOracle && options.h2Changed,
  ).toBe(true)
  expectAppliedExact(await applyChoice(page, span, options.token))
  await pollExact(page, plan)
}

async function historyAction(
  page: Page,
  action: 'undo' | 'redo',
  count = 1,
  readImmediately = false,
) {
  const beforeCalls = await page.evaluate(
    () => (window as any).__historyInputs().calls as number,
  )
  const immediate = await page.evaluate(
    ({ action, count, readImmediately }) => {
      const w = window as any
      for (let i = 0; i < count; i++)
        w[action === 'undo' ? '__undo' : '__redo']()
      if (!readImmediately)
        return { immediateReadRendered: false, immediateReadExact: false }
      // This deliberate early read is P2's revocation probe; P1 never enters this branch.
      const exact = w.__exact()
      return {
        immediateReadRendered: exact === w.__transformBefore.beforeRendered,
        immediateReadExact: exact === w.__transformBefore.before,
      }
    },
    { action, count, readImmediately },
  )
  let callbackObserved = false
  try {
    await page.waitForFunction(
      (calls) => (window as any).__historyInputs().calls > calls,
      beforeCalls,
      { timeout: HISTORY_TIMEOUT },
    )
    callbackObserved = true
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error
  }
  const history = await page.evaluate(() => (window as any).__historyInputs())
  return {
    callbacks: history.calls - beforeCalls,
    callbackObserved,
    transitionSeen: history.transitionSeen as boolean,
    recovered: history.recovered as boolean,
    ...(readImmediately ? immediate : {}),
  }
}

// Diagnostic results never control the expected behavior: only fixture/harness sanity and final
// authority are asserted. Oracle calls here bypass capture exclusively to measure D5.
test('C5 records the Chromium capture matrix and diagnostics', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000)
  const report: Record<string, unknown> = {}
  const record = numericRecorder(report)
  record('capabilities', {
    hostWriteback: false,
    diskWriteback: false,
    nativeQuickPick: false,
    fullEditSync: false,
    vditorPostProcessing: true,
  })
  await boot(page)
  for (const mode of ['ir', 'wysiwyg'] as const) {
    await setSource(page)
    await switchMode(page, mode)
    record(
      `${mode}_switchLengths`,
      await page.evaluate(() => (window as any).__lengths()),
    )
    const cold = await measure(page, () =>
      page.evaluate(() => (window as any).__readIndex()),
    )
    record(`${mode}_D9`, cold)
    record(
      `${mode}_D1_D2_D3`,
      await page.evaluate(
        (spans) => (window as any).__diagnostics(spans),
        targets,
      ),
    )
    record(`${mode}_caret`, await captureRoute(page, targets.near, 'caret'))
    record(
      `${mode}_emphasized`,
      await captureRoute(page, targets.emphasized, 'caret'),
    )
    record(`${mode}_range`, await captureRoute(page, targets.far, 'range'))
    record(`${mode}_find`, await captureRoute(page, targets.far, 'find'))
    await setSource(page)
    record(`${mode}_handle`, await handleRoute(page, targets.near))
    record(`${mode}_D5`, await oracleHistory(page))
    for (const [key, source] of [
      ['roundTrip', SMALL],
      ['normalizing', NORMALIZING],
    ]) {
      const start = source.indexOf('target paragraph')
      const span = {
        start,
        end: start + 'target paragraph'.length,
        caret: start + 5,
      }
      record(
        `${mode}_${key}_selection`,
        await captureRoute(page, span, 'caret', source),
      )
      await setSource(page, source)
      record(`${mode}_${key}_handle`, await handleRoute(page, span))
    }
    await setSource(page)
    await choose(page, targets.multi)
    const before = await page.evaluate(() => ({
      length: (window as any).__root().textContent.length,
      focused: document.activeElement === (window as any).__root(),
    }))
    expect(before.focused).toBe(true)
    await page.keyboard.type('x')
    await frames(page)
    const typed = await page.evaluate(
      (length) => (window as any).__root().textContent.length === length + 1,
      before.length,
    )
    expect(typed).toBe(true)
    const revisedSpan = await page.evaluate(
      (needle) => {
        const source = (window as any).__exact() as string
        const start = source.indexOf(needle)
        return {
          start,
          end: start + needle.length,
          caret: start + Math.floor(needle.length / 2),
        }
      },
      FIXTURE.slice(targets.near.start, targets.near.end),
    )
    expect(revisedSpan.start >= 0).toBe(true)
    await choose(page, revisedSpan)
    record(
      `${mode}_trustedEdit`,
      await measure(page, () => request(page, revisedSpan)),
    )
  }
  // D6 observes direct SV and both visual-to-SV routes before any reset can erase the difference.
  for (const from of ['ir', 'wysiwyg'] as const) {
    await switchMode(page, from)
    await setSource(page)
    await switchMode(page, 'sv')
    record(
      `${from}_to_sv_D6`,
      await page.evaluate(() => (window as any).__lengths()),
    )
    // Retain the switched DOM: captureRoute's reset would turn this into a direct-SV sample.
    await choose(page, targets.near)
    record(
      `${from}_to_sv_selection`,
      await measure(page, () => request(page, targets.near)),
    )
    record(
      `${from}_to_sv_mapping`,
      await page.evaluate(() => (window as any).__mapping()),
    )
    const focus = await findFar(page)
    record(`${from}_to_sv_find`, {
      ...focus,
      ...(await measure(page, () => request(page, targets.far, TOKEN))),
    })
    await page.mouse.move(500, 100)
    record(`${from}_to_sv_handle`, {
      handleVisible: await page.evaluate(
        () =>
          !document.querySelector<HTMLElement>('.vmde-block-handle')?.hidden,
      ),
    })
  }
  await boot(page, 'sv')
  await setSource(page)
  record('sv_direct_D6', await page.evaluate(() => (window as any).__lengths()))
  record('sv_direct_selection', await captureRoute(page, targets.near, 'caret'))
  record('sv_direct_find', await captureRoute(page, targets.far, 'find'))
  const smallSpan = { start: 0, end: 'target paragraph'.length, caret: 5 }
  record('sv_roundTrip', await captureRoute(page, smallSpan, 'caret', SMALL))
  await setSource(page)
  const original = await page.evaluate(
    (value) => (window as any).__exact() === value,
    FIXTURE,
  )
  expect(original).toBe(true)
  expect(numericOnly(report)).toBe(true)
  await testInfo.attach('turn-into-cp1.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  })
})

// C6 now exercises selection capture and delayed history recovery together. P5b retains the
// measured back-to-back Redo limitation; the positive P1-P5 cases poll for exact authority.
test('C6 measures exact history callback timing in both visual modes', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000)
  const report: Record<string, unknown> = {}
  const record = numericRecorder(report)
  try {
    for (const mode of ['ir', 'wysiwyg'] as const) {
      await boot(page, mode)
      await setSource(page)
      await applyHistorySelection(page, targets.near, nearPlan)
      const p1History = await historyAction(page, 'undo')
      if (p1History.callbackObserved) await pollExact(page, FIXTURE)
      const p1State = p1History.callbackObserved
        ? await page.evaluate((source) => {
            const w = window as any
            return {
              exactRestored: w.__exact() === source,
              renderedRestored:
                w.__getValue() === w.__transformBefore.beforeRendered,
            }
          }, FIXTURE)
        : { exactRestored: false, renderedRestored: false }
      const p1 = {
        ...p1History,
        ...p1State,
        predictionHeld: p1State.exactRestored && p1State.renderedRestored,
      }
      record(`${mode}_P1`, p1)
      expect(
        p1.callbackObserved && p1.exactRestored && p1.renderedRestored,
      ).toBe(true)

      const p3History = await historyAction(page, 'redo')
      await pollExact(page, nearPlan)
      const p3ExactMatchesPlan = await page.evaluate(
        (plan) => (window as any).__exact() === plan,
        nearPlan,
      )
      record(`${mode}_P3`, {
        ...p3History,
        exactMatchesPlan: p3ExactMatchesPlan,
        predictionHeld: p3ExactMatchesPlan,
      })

      await setSource(page)
      await applyHistorySelection(page, targets.near, nearPlan)
      const p2History = await historyAction(page, 'undo', 1, true)
      await pollExact(page, FIXTURE)
      const p2ExactRecovered = await page.evaluate(
        (source) => (window as any).__exact() === source,
        FIXTURE,
      )
      record(`${mode}_P2`, {
        ...p2History,
        exactRecovered: p2ExactRecovered,
        predictionHeld: p2History.immediateReadRendered && p2ExactRecovered,
      })

      await setSource(page)
      await applyHistorySelection(page, targets.near, nearPlan)
      await applyHistorySelection(page, shiftedFar, nearFarPlan)
      const p4FirstHistory = await historyAction(page, 'undo')
      await pollExact(page, nearPlan)
      const p4FirstMatchesNear = await page.evaluate(
        (plan) => (window as any).__exact() === plan,
        nearPlan,
      )
      const p4SecondHistory = await historyAction(page, 'undo')
      await pollExact(page, FIXTURE)
      const p4SecondRestored = await page.evaluate(
        (source) => (window as any).__exact() === source,
        FIXTURE,
      )
      record(`${mode}_P4`, {
        firstUndo: {
          ...p4FirstHistory,
          exactMatchesNearPlan: p4FirstMatchesNear,
        },
        secondUndo: {
          ...p4SecondHistory,
          exactRestored: p4SecondRestored,
        },
        predictionHeld: p4FirstMatchesNear && p4SecondRestored,
      })

      await setSource(page)
      await applyHistorySelection(page, targets.near, nearPlan)
      await applyHistorySelection(page, shiftedFar, nearFarPlan)
      const p5History = await historyAction(page, 'undo', 2)
      await pollExact(page, FIXTURE)
      const p5ExactRestored = await page.evaluate(
        (source) => (window as any).__exact() === source,
        FIXTURE,
      )
      record(`${mode}_P5`, {
        ...p5History,
        exactRestored: p5ExactRestored,
        predictionHeld: p5ExactRestored,
      })
      const p5bHistory = await historyAction(page, 'redo', 2)
      const p5bExactMatchesPlan = await page.evaluate(
        (plan) => (window as any).__exact() === plan,
        nearFarPlan,
      )
      record(`${mode}_P5b`, {
        ...p5bHistory,
        exactMatchesPlan2: p5bExactMatchesPlan,
        predictionHeld: !p5bExactMatchesPlan,
      })
    }
    expect(numericOnly(report)).toBe(true)
  } finally {
    await testInfo.attach('turn-into-c6-history.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    })
  }
})

test('C7 IR preserves a small normalizing CRLF document through apply and Undo', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const source = NORMALIZING.replace(/\n/gu, '\r\n')
  const start = source.indexOf('target paragraph')
  const span = {
    start,
    end: start + 'target paragraph'.length,
    caret: start + 5,
  }
  const plan = `${source.slice(0, start)}## ${source.slice(start)}`
  await boot(page)
  await setSource(page, source)
  await applyHistorySelection(page, span, plan)
  expect(await page.evaluate(() => (window as any).__posted().count)).toBe(1)
  await expectUndoBaseline(page, source)
})

test('C8 a two-paragraph range on the large fixture declines without markers', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await boot(page)
  await setSource(page)
  const first = lineSpan(291, 292)
  const last = lineSpan(294, 295)
  const pair = { start: first.start, end: last.end, caret: first.caret }
  const setup = await page.evaluate(
    ({ first, last }) => {
      const w = window as any
      const firstSelected = w.__select(first)
      const firstRange = getSelection()!.getRangeAt(0).cloneRange()
      const firstProven = Boolean(w.__blockOptions())
      const lastSelected = w.__select(last)
      const lastRange = getSelection()!.getRangeAt(0).cloneRange()
      const lastProven = Boolean(w.__blockOptions())
      const firstParagraph =
        firstRange.startContainer.parentElement?.closest('p')
      const lastParagraph = lastRange.endContainer.parentElement?.closest('p')
      const range = document.createRange()
      range.setStart(firstRange.startContainer, firstRange.startOffset)
      range.setEnd(lastRange.endContainer, lastRange.endOffset)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return {
        firstSelected,
        lastSelected,
        firstProven,
        lastProven,
        expanded: !range.collapsed,
        adjacentParagraphs: Boolean(
          firstParagraph && firstParagraph.nextElementSibling === lastParagraph,
        ),
      }
    },
    { first, last },
  )
  console.log(JSON.stringify({ c8Setup: setup }))
  expect(setup).toEqual({
    firstSelected: true,
    lastSelected: true,
    firstProven: true,
    lastProven: true,
    expanded: true,
    adjacentParagraphs: true,
  })
  await frames(page)
  const captured = await measure(page, () => request(page, pair))
  expect(captured.value.optionsReturned).toBe(false)
  expect(captured.work.markerInsertions).toBe(0)
  expect(captured.work.setValueCalls).toBe(0)
  expect(
    await page.evaluate((source) => {
      const w = window as any
      return w.__posted().count === 0 && w.__exact() === source
    }, FIXTURE),
  ).toBe(true)
})
