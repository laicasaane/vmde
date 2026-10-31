import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { alignText } from '../../media-src/src/editing/find-align'
import { FIXTURE } from './find-replace-fixture-helpers'
import {
  SMALL,
  TOKEN,
  far,
  near,
  selectTarget,
  modeMeasurements,
  openFixture,
  readLengths,
  record,
  registerReportHooks,
  selectionRoute,
  smallHistoryControl,
  smallTarget,
  startReport,
  switchMode,
  trustedEditControl,
  unchanged,
} from './turn-into-non-round-trip-helpers'

registerReportHooks()

test.describe('Task 604 real VS Code measurements @probe', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the isolated Xvfb/Openbox XTEST session',
  )

  test('R0 A @probe measures IR, WYSIWYG and switched SV', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(420_000)
    startReport('s6-r0-a', 'cp2')
    const ctx = await openFixture(args, FIXTURE, 'ir', 'large-a')
    record('scope', {
      diagnosticAtSourceLegRun: false,
      largeNonRoundTripUndoMeasured: false,
      smallHistoryControlInBootC: true,
    })
    await modeMeasurements(ctx, 'ir')
    for (const mode of ['wysiwyg', 'sv'] as const) {
      await switchMode(ctx, mode)
      await modeMeasurements(ctx, mode)
    }
    await unchanged(ctx)
  })

  test('R0 B @probe measures direct SV and its round-trip control', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(300_000)
    startReport('s6-r0-b', 'cp2')
    const ctx = await openFixture(args, FIXTURE, 'sv', 'large-b')
    await modeMeasurements(ctx, 'sv_direct')
    const small = await openFixture(args, SMALL, 'sv', 'small-sv')
    record('sv_small_lengths', await readLengths(small))
    record(
      'sv_small_selection',
      await selectionRoute(small, smallTarget, 'caret'),
    )
    await unchanged(small)
  })

  test('R0 C @probe checks the real apply/Undo ceiling and trusted-edit control', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    const args = { workbox, electronApp, evaluateInVSCode, baseDir }
    test.setTimeout(540_000)
    startReport('s6-r0-c', 'cp2')
    const small = await openFixture(args, SMALL, 'ir', 'small-ir')
    await smallHistoryControl(small)
    await unchanged(small)
    const addRange = await openFixture(
      args,
      FIXTURE,
      'ir',
      'trusted-edit-add-range',
    )
    const addRangeResult = await trustedEditControl(addRange, 'addRange')
    await unchanged(addRange)
    const requestCaret = await openFixture(
      args,
      FIXTURE,
      'ir',
      'trusted-edit-request-caret',
    )
    const requestCaretResult = await trustedEditControl(
      requestCaret,
      'requestCaret',
      true,
    )
    await unchanged(requestCaret)
    record('trusted_edit_setup_comparison', {
      addRange: addRangeResult,
      requestCaret: requestCaretResult,
    })
    expect(
      addRangeResult.quickPickOpened &&
        addRangeResult.currentTypeIsParagraph &&
        requestCaretResult.quickPickOpened &&
        requestCaretResult.currentTypeIsParagraph &&
        requestCaretResult.heading2Applied &&
        requestCaretResult.hostOutsideBlockMeasured,
    ).toBe(true)
  })
})

// Task 605 S1: privacy-safe SV text/alignment measurements. Only lengths, 32-bit hash prefixes,
// offsets and booleans are recorded; no document content is ever printed or stored.
type Ctx = Awaited<ReturnType<typeof openFixture>>
type Span = { start: number; end: number }
const S1_FILE = path.resolve(__dirname, '../../tmp/605/s1/r0-d.json')
const s1Data: Record<string, unknown> = (() => {
  try {
    return JSON.parse(readFileSync(S1_FILE, 'utf8'))
  } catch {
    return {}
  }
})()
function s1(name: string, value: unknown) {
  s1Data[name] = value
  mkdirSync(path.dirname(S1_FILE), { recursive: true })
  writeFileSync(S1_FILE, `${JSON.stringify(s1Data, null, 2)}\n`)
  record(name, value)
}
const digest = (text: string) =>
  Number.parseInt(
    createHash('sha256').update(text).digest('hex').slice(0, 8),
    16,
  )
const count = (text: string, char: string) => text.split(char).length - 1
function firstDifference(a: string, b: string) {
  const shortest = Math.min(a.length, b.length)
  let index = 0
  while (index < shortest && a.charCodeAt(index) === b.charCodeAt(index))
    index++
  return index === a.length && index === b.length ? -1 : index
}

async function svSnapshot(ctx: Ctx) {
  return ctx.frame
    .locator('#app .vditor-sv')
    .first()
    .evaluate((root) => {
      const w = window as any
      const nodes: Text[] = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node as Text)
      const text = nodes.map((node) => node.data).join('')
      const exact = w.__vmdeE2EExactMarkdown?.()
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const offsetOf = (node: Node, offset: number) => {
        if (node.nodeType !== 3) return -1
        let total = 0
        for (const item of nodes) {
          if (item === node) return total + offset
          total += item.data.length
        }
        return -1
      }
      return {
        exact: typeof exact === 'string' ? (exact as string) : null,
        text,
        textContent: root.textContent ?? '',
        rendered: w.vditor.getValue() as string,
        textNodeCount: nodes.length,
        selection: range
          ? {
              collapsed: range.collapsed,
              startKind: range.startContainer.nodeType,
              endKind: range.endContainer.nodeType,
              startParentIsEditor: range.startContainer.parentElement === root,
              startOffset: offsetOf(range.startContainer, range.startOffset),
              endOffset: offsetOf(range.endContainer, range.endOffset),
            }
          : null,
      }
    })
}

const tailCodes = (value: string) =>
  Array.from(value.slice(-4), (char) => char.charCodeAt(0))

/** Equal-run starts, unmapped exact offsets, and the text-minus-exact drift at each run start. */
function alignmentBreaks(
  alignment: ReturnType<typeof alignText>,
  exactLength: number,
) {
  const deltas: number[] = []
  let runs = 0
  let unmapped = 0
  let firstUnmapped = -1
  let lastUnmapped = -1
  let previous: number | null = null
  for (let offset = 0; offset <= exactLength; offset++) {
    const mapped = alignment.toRendered(offset, 'start')
    if (mapped === null) {
      unmapped++
      if (firstUnmapped < 0) firstUnmapped = offset
      lastUnmapped = offset
    } else if (previous === null || mapped !== previous + 1) {
      runs++
      if (deltas.length < 40) deltas.push(mapped - offset)
    }
    previous = mapped
  }
  return { runs, unmapped, firstUnmapped, lastUnmapped, deltas }
}

function analyse(
  ctx: Ctx,
  snapshot: Awaited<ReturnType<typeof svSnapshot>>,
  spans: Record<string, Span>,
) {
  const exact = snapshot.exact ?? ctx.source
  const { text, rendered } = snapshot
  const started = performance.now()
  const alignment = alignText(exact, text)
  const buildMs = performance.now() - started
  const breaks = alignmentBreaks(alignment, exact.length)
  const spanResults: Record<string, boolean | number> = {}
  for (const [name, span] of Object.entries(spans)) {
    const start = alignment.toRendered(span.start, 'start')
    const end = alignment.toRendered(span.end, 'end')
    spanResults[`${name}Mapped`] = start !== null && end !== null
    spanResults[`${name}Verbatim`] =
      start !== null &&
      end !== null &&
      text.slice(start, end) === exact.slice(span.start, span.end)
    spanResults[`${name}RenderedStart`] = start ?? -1
  }
  const trailing = (value: string) => value.length - value.trimEnd().length
  const metrics = {
    exactAvailable: snapshot.exact !== null,
    exactLength: exact.length,
    textLength: text.length,
    textContentEqualsText: snapshot.textContent === text,
    renderedLength: rendered.length,
    exactHash: digest(exact),
    textHash: digest(text),
    renderedHash: digest(rendered),
    textEqualsExact: text === exact,
    renderedEqualsExact: rendered === exact,
    renderedEqualsText: rendered === text,
    textMinusExact: text.length - exact.length,
    firstDifferenceExactVsText: firstDifference(exact, text),
    firstDifferenceExactVsRendered: firstDifference(exact, rendered),
    textNodeCount: snapshot.textNodeCount,
    alignBuildMsNode: Math.round(buildMs),
    alignEqualRunBreaks: breaks.runs,
    alignUnmappedExactOffsets: breaks.unmapped,
    alignFirstUnmapped: breaks.firstUnmapped,
    alignLastUnmapped: breaks.lastUnmapped,
    alignBreakDeltas: breaks.deltas,
    exactIsPrefixOfText: text.startsWith(exact),
    textTailCodes: tailCodes(text),
    exactTailCodes: tailCodes(exact),
    exactTrailingWhitespace: trailing(exact),
    textTrailingWhitespace: trailing(text),
    exactCr: count(exact, '\r'),
    textCr: count(text, '\r'),
    renderedCr: count(rendered, '\r'),
    exactNbsp: count(exact, '\u00a0'),
    textNbsp: count(text, '\u00a0'),
    renderedNbsp: count(rendered, '\u00a0'),
    ...spanResults,
  }
  return { alignment, metrics, exact }
}

function selectionMetrics(
  analysis: ReturnType<typeof analyse>,
  snapshot: Awaited<ReturnType<typeof svSnapshot>>,
  expected: { start: number; end: number; token?: string },
) {
  const { alignment, exact } = analysis
  const selection = snapshot.selection
  if (!selection) return { selectionPresent: false }
  const at = (offset: number, bias: 'start' | 'end') =>
    offset < 0 ? null : alignment.toExact(offset, bias)
  const startA = at(selection.startOffset, 'start')
  const startB = at(selection.startOffset, 'end')
  const endA = at(selection.endOffset, 'start')
  const endB = at(selection.endOffset, 'end')
  const caret = selection.collapsed
  const exactStart = caret ? (startA ?? startB) : startA
  const exactEnd = caret ? exactStart : endB
  return {
    selectionPresent: true,
    collapsed: selection.collapsed,
    startIsText: selection.startKind === 3,
    endIsText: selection.endKind === 3,
    startParentIsEditor: selection.startParentIsEditor,
    startTextOffset: selection.startOffset,
    endTextOffset: selection.endOffset,
    startBiasAgrees: startA !== null && startA === startB,
    endBiasAgrees: endA !== null && endA === endB,
    mappedStart: exactStart ?? -1,
    mappedEnd: exactEnd ?? -1,
    mappedMatchesExpected:
      exactStart === expected.start && exactEnd === expected.end,
    mappedTokenMatches: expected.token
      ? exactStart !== null &&
        exactEnd !== null &&
        exact.slice(exactStart, exactEnd).toLowerCase() === expected.token
      : false,
  }
}

async function measureLargeSv(ctx: Ctx, label: string) {
  const midpoint = (target: { start: number; end: number }) =>
    target.start + Math.floor((target.end - target.start) / 2)
  await selectTarget(ctx, near)
  const caret = await svSnapshot(ctx)
  const analysis = analyse(ctx, caret, { near, far })
  s1(`${label}_alignment`, analysis.metrics)
  s1(
    `${label}_caret`,
    selectionMetrics(analysis, caret, {
      start: midpoint(near),
      end: midpoint(near),
    }),
  )
  await selectTarget(ctx, far, TOKEN)
  const range = await svSnapshot(ctx)
  s1(
    `${label}_range`,
    selectionMetrics(analysis, range, { start: -2, end: -2, token: TOKEN }),
  )
  await unchanged(ctx)
}

test.describe('Task 605 S1 real VS Code SV measurements @probe', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the isolated Xvfb/Openbox XTEST session',
  )

  test('R0 D1 @probe measures direct SV on the large fixture', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    startReport('s1-r0-d1', 'cp2')
    const ctx = await openFixture(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      FIXTURE,
      'sv',
      's1-direct',
    )
    await measureLargeSv(ctx, 'direct_sv')
  })

  test('R0 D2 @probe measures IR to SV on the large fixture', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(420_000)
    startReport('s1-r0-d2', 'cp2')
    const ctx = await openFixture(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      FIXTURE,
      'ir',
      's1-ir',
    )
    await switchMode(ctx, 'sv')
    await measureLargeSv(ctx, 'ir_to_sv')
  })

  test('R0 D3 @probe measures WYSIWYG to SV on the large fixture', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(420_000)
    startReport('s1-r0-d3', 'cp2')
    const ctx = await openFixture(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      FIXTURE,
      'wysiwyg',
      's1-wysiwyg',
    )
    await switchMode(ctx, 'sv')
    await measureLargeSv(ctx, 'wysiwyg_to_sv')
  })

  const variants: Array<{
    label: string
    source: string
    target: string
  }> = [
    { label: 'f5b', source: SMALL, target: 'target paragraph' },
    {
      label: 'crlf',
      source: SMALL.replaceAll('\n', '\r\n'),
      target: 'target paragraph',
    },
    {
      label: 'nbsp',
      source: SMALL.replace('target paragraph', 'target\u00a0paragraph'),
      target: 'target\u00a0paragraph',
    },
    {
      label: 'front_matter',
      source: `---\ntitle: probe\n---\n\n${SMALL}`,
      target: 'target paragraph',
    },
  ]
  for (const variant of variants)
    test(`R0 D4 @probe measures the ${variant.label} small SV variant`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(240_000)
      startReport(`s1-r0-d4-${variant.label}`, 'cp2')
      const ctx = await openFixture(
        { workbox, electronApp, evaluateInVSCode, baseDir },
        variant.source,
        'sv',
        `s1-${variant.label}`,
      )
      const start = variant.source.indexOf(variant.target)
      const target = {
        fragment: variant.target,
        start,
        end: start + variant.target.length,
      }
      await selectTarget(ctx, target)
      const caret = await svSnapshot(ctx)
      const analysis = analyse(ctx, caret, { target })
      s1(`${variant.label}_alignment`, analysis.metrics)
      s1(
        `${variant.label}_caret`,
        selectionMetrics(analysis, caret, {
          start: start + Math.floor(variant.target.length / 2),
          end: start + Math.floor(variant.target.length / 2),
        }),
      )
      await unchanged(ctx)
    })

  test('R0 D5 @probe counts passive SV DOM mutations while a choice is pending', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(240_000)
    startReport('s1-r0-d5', 'cp2')
    const ctx = await openFixture(
      { workbox, electronApp, evaluateInVSCode, baseDir },
      SMALL,
      'sv',
      's1-pending',
    )
    const start = SMALL.indexOf('target paragraph')
    await selectTarget(
      ctx,
      { fragment: 'target paragraph', start, end: start + 16 },
      'paragraph',
    )
    const before = await svSnapshot(ctx)
    await ctx.frame
      .locator('#app .vditor-sv')
      .first()
      .evaluate((root) => {
        const w = window as any
        const stats = {
          batches: 0,
          childList: 0,
          addedText: 0,
          removedText: 0,
          characterData: 0,
          attributes: 0,
        }
        const textNodes = (nodes: NodeList) =>
          Array.from(nodes).filter((node) => node.nodeType === 3).length
        const observer = new MutationObserver((records) => {
          stats.batches++
          for (const record of records) {
            stats[record.type]++
            stats.addedText += textNodes(record.addedNodes)
            stats.removedText += textNodes(record.removedNodes)
          }
        })
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        })
        w.__task605Mutations = { stats, observer }
      })
    await ctx.evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.turnInto')
    }, [])
    const picker = ctx.workbox.locator('.quick-input-widget input').first()
    // SV declines today, so the picker is expected to stay closed: the passive mutation count
    // below is then the no-choice baseline that the Details legacy capture produces in SV.
    const pickerOpened = await picker
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(
        () => true,
        () => false,
      )
    await ctx.frame.locator('body').evaluate(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    await ctx.workbox.waitForTimeout(600)
    const pendingVisible = await picker.isVisible()
    const mutations = await ctx.frame.locator('body').evaluate(() => {
      const held = (window as any).__task605Mutations
      held.observer.takeRecords()
      held.observer.disconnect()
      return held.stats as Record<string, number>
    })
    const after = await svSnapshot(ctx)
    if (pickerOpened) {
      await ctx.xtest.key('Escape')
      await picker.waitFor({ state: 'hidden' })
    }
    s1('pending_choice_sv', {
      pickerOpened,
      pickerStillVisible: pendingVisible,
      ...mutations,
      textUnchanged: before.text === after.text,
      textNodeCountBefore: before.textNodeCount,
      textNodeCountAfter: after.textNodeCount,
      selectionOffsetsUnchanged:
        before.selection?.startOffset === after.selection?.startOffset &&
        before.selection?.endOffset === after.selection?.endOffset,
    })
    await unchanged(ctx)
  })
})
