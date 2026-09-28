import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installCompositionState } from '../src/util/caret-gesture'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import { installCaretInvalidation, invalidateCaret } from '../src/editing/caret'
import { installEscapeToolbar } from '../src/editing/escape-toolbar'
import { activeModeElement } from '../src/util/source-map'
import {
  configureFindReplaceActions,
  installFindReplace,
  installStructuralSelection,
  openFindReplace,
  runFindWidgetAction,
} from '../src/editing/selection-scope'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
  requestBlockTransformOptionsAtSource,
} from '../src/editing/block-transform-command'
import {
  captureRewrapSourceRange,
  hasRewrapDocumentHistoryTransition,
  takeRewrapDocumentHistorySync,
} from '../src/editing/rewrap-command'
import {
  describeBlockAt,
  planBlockTransform,
  type BlockTarget,
} from '../src/editing/block-transform'
import {
  type BlockHandleUnit,
  type BlockProjection,
  currentBlockProjection,
  installBlockHandleLayer,
  pairRenderedSpans,
  resolveBlockHandleUnits,
} from '../src/nav/block-handle'
import { createSourceBlockIndex } from '../src/nav/source-block-index'
import { scanMovableBlocks } from '../../src/shared/block-move'
import { alignText, type OffsetAlignment } from '../src/editing/find-align'
import { findMapperFor } from '../src/editing/find-map'
import { createFindSourceTracker } from '../src/editing/find-source'

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Span = { start: number; end: number; caret?: number }
function timed<T>(read: () => T) {
  const begin = performance.now()
  const value = read()
  return { value, ms: performance.now() - begin }
}
function firstDifferingBoundary(
  span: Span | undefined,
  alignment: OffsetAlignment,
): number {
  if (!span) return -1
  for (let n = span.start; n < span.end; n++)
    if (alignment.toRendered(n, 'start') !== alignment.toRendered(n, 'end'))
      return n
  return -1
}
function paragraphSpans(source: string) {
  const found = new Map<number, Span>()
  for (const match of source.matchAll(/(?:^|\n\n)([^\n])/gu)) {
    const offset = match.index + match[0].length - 1
    const described = describeBlockAt(source, offset, offset)
    if (described?.currentType === 'paragraph')
      found.set(described.span.start, described.span)
  }
  return found
}
function memberHtml(members: HTMLElement[]): string {
  const wrapper = document.createElement('div')
  let listOwner: HTMLElement | null = null
  let list: HTMLElement | null = null
  for (const member of members) {
    if (member.tagName !== 'LI') {
      wrapper.append(member.cloneNode(true))
      listOwner = list = null
      continue
    }
    if (listOwner !== member.parentElement) {
      listOwner = member.parentElement!
      list = listOwner.cloneNode(false) as HTMLElement
      wrapper.append(list)
    }
    list!.append(member.cloneNode(true))
  }
  return wrapper.innerHTML
}
function fragmentMismatches(
  source: string,
  units: BlockHandleUnit[],
  spans: Array<[number, number]>,
  proof: BlockProjection,
) {
  const counts: Record<string, number> = {}
  units.forEach((unit, index) => {
    const projected = proof.serialize(
      proof.render(source.slice(...spans[index])),
    )
    const live = proof.serialize(memberHtml(unit.members))
    if (projected !== live) counts[unit.kind] = (counts[unit.kind] ?? 0) + 1
  })
  return counts
}
function unitCounts(units: BlockHandleUnit[] | null) {
  return {
    renderedUnits: units?.length ?? 0,
    groupedUnits: units?.filter((unit) => unit.members.length > 1).length ?? 0,
  }
}
function blockAlignments(
  source: string,
  rendered: string,
  targets: Record<string, Span>,
  units: BlockHandleUnit[],
  pairs: Array<[number, number]>,
) {
  return Object.fromEntries(
    Object.entries(targets).map(([name, span]) => {
      let alignMs = 0
      const mapped = (offset: number, bias: 'start' | 'end') => {
        const at = pairs.findIndex(([a, b]) => a <= offset && offset <= b)
        if (at < 0) return false
        const block = timed(() =>
          alignText(
            source.slice(...pairs[at]),
            rendered.slice(units[at].start, units[at].end),
          ),
        )
        alignMs += block.ms
        return block.value.toRendered(offset - pairs[at][0], bias) !== null
      }
      const startMapped = mapped(span.start, 'start')
      const endMapped = mapped(span.end, 'end')
      return [name, { startMapped, endMapped, alignMs }]
    }),
  )
}
const win = window as any
const initial = 'target paragraph\n'
const requestedMode = new URLSearchParams(location.search).get('mode')
const mode: Mode =
  requestedMode === 'sv' || requestedMode === 'wysiwyg' ? requestedMode : 'ir'
installCompositionState()
installCaretInvalidation()
installIrMarkerReveal()
const noop = () => undefined
let onInput: () => void = noop

const editor = new Vditor('app', {
  mode,
  value: initial,
  height: 520,
  cache: { enable: false },
  cdn: `${location.origin}/vditor`,
  input: () => onInput(),
  after() {
    win.vditor = editor
    const inner = editor.vditor
    win.vscode ??= { postMessage: () => undefined }
    installEscapeToolbar()
    installStructuralSelection()
    let exact: string | null = initial
    let anchored: string | null = null
    let revision: object = {}
    let lastPosted: string | undefined
    let postedCount = 0
    let errors = 0
    win.__vmdeBlockHandleCacheMetrics ??= {
      indexBuilds: 0,
      blockHandleSnapshotCalls: 0,
      blockTransformCaptureCalls: 0,
    }
    const metrics = win.__vmdeBlockHandleCacheMetrics
    const snapshots = { snapshotCalls: 0 }
    win.__vmdeIncrementalSeedStats = snapshots
    const root = () => activeModeElement(win.vditor)!
    const visualRoot = () => (inner.currentMode === 'sv' ? null : root())
    const takeExact = (markdown: string) => {
      exact = markdown
      anchored = null
      revision = {}
    }
    // Production SV host serialization (edit-sync.ts): authored terminal blank lines stay;
    // only Vditor's appended editable newline node and terminal zero-width padding are removed.
    const serializeSvForHost = () => {
      const clone = root().cloneNode(true) as HTMLElement
      clone
        .querySelector(
          ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
        )
        ?.remove()
      return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
    }
    const snapshotPair = () => {
      snapshots.snapshotCalls++
      const rendered =
        inner.currentMode === 'sv' ? serializeSvForHost() : editor.getValue()
      if (exact === null) return { exact: rendered, rendered }
      anchored ??= rendered
      if (anchored === rendered) return { exact, rendered }
      exact = null
      anchored = null
      revision = {}
      return { exact: rendered, rendered }
    }
    const snapshotRevision = () => revision
    const postExact = (markdown: string) => {
      lastPosted = markdown
      postedCount++
      takeExact(markdown)
    }
    onInput = () => {
      if (!hasRewrapDocumentHistoryTransition(inner)) return
      const recovered = takeRewrapDocumentHistorySync(inner, editor.getValue())
      if (recovered !== undefined) takeExact(recovered)
    }
    document.addEventListener(
      'input',
      (event) => {
        if (!event.isTrusted || !root()?.contains(event.target as Node)) return
        exact = null
        anchored = null
        revision = {}
      },
      true,
    )
    const countedPair = () => {
      metrics.blockHandleSnapshotCalls++
      return snapshotPair()
    }
    const index = createSourceBlockIndex({
      getActiveRoot: visualRoot,
      projection: currentBlockProjection,
      snapshotPair: countedPair,
      snapshotRevision,
      resolveUnits: (element, source, rendered) =>
        resolveBlockHandleUnits(
          element,
          source,
          rendered,
          currentBlockProjection(),
        ),
    })
    const tracker = createFindSourceTracker({
      index,
      mode: () => inner.currentMode,
      root,
      snapshotPair,
      snapshotRevision,
    })
    configureFindReplaceActions({
      setApplying: noop,
      postExact,
      reportState: noop,
      onError: () => {
        errors++
      },
    })
    installFindReplace(document, { index, snapshotPair, snapshotRevision })
    configureBlockTransformCommand({
      snapshotExactMarkdown: () => snapshotPair().exact,
      snapshotRevision,
      postExact,
      setApplying: noop,
      onError: () => {
        errors++
      },
    })
    const postOptions = (
      options: ReturnType<typeof requestBlockTransformOptions>,
    ) => {
      win.__lastOptions = options
      if (options)
        win.vscode.postMessage({
          command: 'block-transform-options',
          ...options,
        })
      return options
    }
    const handleTurnInto = (start: number, end: number) =>
      postOptions(
        requestBlockTransformOptionsAtSource(
          window,
          start,
          end,
          (source, rendered, element) =>
            Boolean(
              resolveBlockHandleUnits(
                element,
                source,
                rendered,
                currentBlockProjection(),
              )?.some((unit) => unit.start === start && unit.end === end),
            ),
        ),
      )
    installBlockHandleLayer(
      visualRoot,
      {
        snapshot: countedPair,
        snapshotRevision,
        turnInto: (start, end) => {
          handleTurnInto(start, end)
        },
        move: noop,
        delete: noop,
        duplicate: noop,
      },
      index,
    )

    function pointAt(
      element: Node,
      offset: number,
    ): { node: Node; offset: number } {
      const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let remaining = offset
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (remaining <= (node.textContent?.length ?? 0))
          return { node, offset: remaining }
        remaining -= node.textContent?.length ?? 0
      }
      throw new Error('target text endpoint missing')
    }
    function paragraph(span: Span): HTMLElement {
      const source = snapshotPair().exact.slice(span.start, span.end)
      if (inner.currentMode === 'sv') return root()
      const proof = currentBlockProjection()!
      const projected = document.createElement('div')
      projected.innerHTML = proof.render(source)
      const text = projected.querySelector('p')?.textContent
      const candidates = [
        ...root().querySelectorAll<HTMLElement>(':scope > p'),
      ].filter((p) => p.textContent === text)
      if (candidates.length !== 1)
        throw new Error('target paragraph is not unique')
      return candidates[0]
    }
    function select(span: Span, token?: string): boolean {
      const element = paragraph(span)
      const source = snapshotPair().exact.slice(span.start, span.end)
      const visible = element.textContent ?? ''
      const base = inner.currentMode === 'sv' ? visible.indexOf(source) : 0
      if (base < 0) return false
      const length =
        inner.currentMode === 'sv' ? source.length : visible.trimEnd().length
      const start = token
        ? visible.toLowerCase().indexOf(token.toLowerCase(), base)
        : base + Math.floor(length / 2)
      if (start < 0) return false
      const a = pointAt(element, start)
      const b = pointAt(element, token ? start + token.length : start)
      element.scrollIntoView({ block: 'center' })
      invalidateCaret()
      root().focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(a.node, a.offset)
      range.setEnd(b.node, b.offset)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
    const lengths = () => {
      const source = snapshotPair().exact
      const rendered = editor.getValue()
      const sv = inner.currentMode === 'sv'
      const textLength = root().textContent?.length ?? 0
      return {
        exactLength: source.length,
        renderedLength: rendered.length,
        exactEqualsRendered: source === rendered,
        svMode: sv,
        svTextContentLength: sv ? textLength : 0,
        svTextContentMinusExact: sv ? textLength - source.length : 0,
        svTextContentEqualsExact: sv && root().textContent === source,
        svHostSerializationEqualsExact: sv && serializeSvForHost() === source,
      }
    }
    let remembered: ReturnType<typeof index.read> = null
    Object.assign(win, {
      __blockOptions: () => postOptions(requestBlockTransformOptions(window)),
      __blockApply: (token: number, target: BlockTarget) =>
        applyBlockTransformChoice(window, token, target),
      __exact: () => snapshotPair().exact,
      __getValue: () => editor.getValue(),
      __root: root,
      __target: paragraph,
      __select: select,
      __lengths: lengths,
      __posted: () => ({ markdown: lastPosted, count: postedCount, errors }),
      __setValue: (markdown: string) => {
        runFindWidgetAction('close')
        invalidateCaret()
        getSelection()?.removeAllRanges()
        editor.setValue(markdown)
        takeExact(markdown)
        lastPosted = undefined
        win.__lastOptions = null
        postedCount = 0
        errors = 0
      },
      __mode: () => inner.currentMode,
      __switchMode: (next: Mode) => {
        if (inner.currentMode === next) return
        anchored = null
        const toggle = inner.toolbar.elements['edit-mode']
          ?.firstElementChild as HTMLElement | null
        toggle?.click()
        document
          .querySelector<HTMLButtonElement>(`button[data-mode="${next}"]`)
          ?.click()
      },
      __openFind: () => openFindReplace('find'),
      __closeFind: () => runFindWidgetAction('close'),
      __undo: () => inner.undo.undo(inner),
      __redo: () => inner.undo.redo(inner),
      __handleTurnInto: handleTurnInto,
      // Bypasses capture proof for D5 only. Acceptance cases must use __blockOptions.
      __oracleOptionsAt: (start: number, end: number) =>
        requestBlockTransformOptionsAtSource(window, start, end, () => true),
      __rememberIndex: () => {
        remembered = index.read()
        return Boolean(remembered)
      },
      __indexSurvived: () => Boolean(remembered && index.peek() === remembered),
      __readIndex: () => {
        const entry = index.read()
        return { returned: Boolean(entry), units: entry?.units?.length ?? 0 }
      },
      __mapping: () => {
        const source = snapshotPair().exact
        const rendered = editor.getValue()
        const selection = getSelection()
        const range = selection?.rangeCount
          ? selection.getRangeAt(0).cloneRange()
          : null
        const valid = range && root().contains(range.startContainer)
        const mapped = valid
          ? captureRewrapSourceRange(window, range, {
              authoritativeMarkdown: source,
              requireExactMarkdown: false,
            })
          : null
        const strict = valid
          ? captureRewrapSourceRange(window, range, {
              authoritativeMarkdown: source,
            })
          : null
        return {
          permissiveMappingReturned: Boolean(mapped),
          strictMappingReturned: Boolean(strict),
          captureMappedLength: mapped?.markdown.length ?? 0,
          captureMappedEqualsExact: mapped?.markdown === source,
          captureMappedEqualsRendered: mapped?.markdown === rendered,
        }
      },
      __diagnostics: (spans: Record<string, Span>) => diagnostics(spans),
      __diagnosticPlan: (span: Span) => {
        const pair = snapshotPair()
        const rendered = editor.getValue()
        const alignment = alignText(pair.exact, rendered)
        const a = alignment.toRendered(span.start, 'start')
        const b = alignment.toRendered(span.end, 'end')
        return {
          before: pair.exact,
          beforeRendered: rendered,
          exactPlan: planBlockTransform(
            pair.exact,
            span,
            { type: 'h2' },
            span.start,
            span.start,
          ).markdown,
          renderedPlan:
            a !== null && b !== null
              ? planBlockTransform(
                  rendered,
                  { start: a, end: b },
                  { type: 'h2' },
                  a,
                  a,
                ).markdown
              : null,
        }
      },
      __ready: true,
    })

    function diagnostics(spans: Record<string, Span>) {
      const { exact: source, rendered } = snapshotPair()
      const element = root()
      const aligned = timed(() => alignText(source, rendered))
      const alignMs = aligned.ms
      const equalSpan = (span: Span) => {
        const a = aligned.value.toRendered(span.start, 'start')
        const b = aligned.value.toRendered(span.end, 'end')
        return (
          a !== null &&
          b !== null &&
          a <= b &&
          source.slice(span.start, span.end) === rendered.slice(a, b)
        )
      }
      const findSource = tracker.source(true)!
      const mapper = timed(() => findMapperFor(findSource))
      const renderedPlanMs = mapper.ms
      const tableBoundary = firstDifferingBoundary(spans.table, aligned.value)
      const targets = { ...spans }
      if (tableBoundary >= 0)
        targets.table = {
          start: tableBoundary,
          end: tableBoundary,
          caret: tableBoundary,
        }
      const mappedTargets = Object.fromEntries(
        Object.entries(targets).map(([name, span]) => {
          const range = timed(() =>
            mapper.value.range({ ...span, line: 0, blockIndex: null }),
          )
          const blockMapMs = range.ms
          const c = span.caret ?? span.start
          const caret = mapper.value.range({
            start: c,
            end: c,
            line: 0,
            blockIndex: null,
          })
          const oracle = describeBlockAt(source, span.start, span.end)
          return [
            name,
            {
              spanMapsThroughEqualRuns: equalSpan(span),
              findForwardMatchesExact:
                range.value?.toString() === source.slice(span.start, span.end),
              findCaretReturned: Boolean(caret),
              blockMapMs,
              oracleReturned: Boolean(oracle),
              h2Changed:
                oracle?.targets.some(
                  (t) => t.type === 'h2' && t.status === 'changed',
                ) ?? false,
              quoteChanged:
                oracle?.targets.some(
                  (t) => t.type === 'quote' && t.status === 'changed',
                ) ?? false,
            },
          ]
        }),
      )
      const paragraphs = paragraphSpans(source)
      const d2 = {
        alignMs,
        renderedPlanMs,
        tableBoundary,
        targets: mappedTargets,
        mappedTopLevelParagraphs: [...paragraphs.values()].filter(equalSpan)
          .length,
        total: paragraphs.size,
        domTopLevelParagraphs: element.querySelectorAll(':scope > p').length,
      }
      const proof = currentBlockProjection()
      if (!proof) return { visual: false, d2, ...lengths() }
      const direct = resolveBlockHandleUnits(element, rendered, rendered)
      const units =
        direct ?? resolveBlockHandleUnits(element, rendered, rendered, proof)
      const pairs = units ? pairRenderedSpans(source, units) : null
      const projectionRoundTripEqualsRendered =
        proof.serialize(proof.render(source)) === rendered
      const liveSerializeEqualsRendered =
        proof.serialize(element.innerHTML) === rendered
      const exactUnits = resolveBlockHandleUnits(
        element,
        source,
        rendered,
        proof,
      )
      const mismatches =
        units && pairs && projectionRoundTripEqualsRendered && !exactUnits
          ? fragmentMismatches(source, units, pairs, proof)
          : {}
      const d3 =
        units && pairs
          ? blockAlignments(source, rendered, targets, units, pairs)
          : {}
      return {
        visual: true,
        d2,
        d3Applicable: Boolean(pairs),
        d3,
        d1: {
          exactScanBlocks: scanMovableBlocks(source).length,
          renderedScanBlocks: scanMovableBlocks(rendered).length,
          ...unitCounts(units),
          renderedUnitsNeededProof: !direct && Boolean(units),
          exactPairsRenderedUnits: Boolean(pairs),
          liveSerializeEqualsRendered,
          projectionRoundTripEqualsRendered,
          exactUnitsResolved: Boolean(exactUnits),
          mismatches,
        },
      }
    }
  },
})
