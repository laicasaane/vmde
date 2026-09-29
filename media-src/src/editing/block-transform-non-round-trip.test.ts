// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createEditSync } from '../bridge/edit-sync'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { alignText } from './find-align'
import { hasRenderedPlanFor, renderedPlanFor } from './find-map'
import * as blockTransform from './block-transform'
import {
  applyBlockTransformChoice,
  bindBlockTransformSource,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
  requestBlockTransformOptionsAtSource,
} from './block-transform-command'
import { describeBlockAt, planBlockTransform } from './block-transform'
import { recordRewrapDocumentHistory } from './rewrap-command'
import { proveSelectionSource } from './selection-source-proof'

const fixtureBytes = readFileSync(
  'test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
)
const fixture = fixtureBytes.toString('utf8')
const fixtureHash =
  'a4a39d6f6c605eb82b0e03a236f67388bceeae9a85450b0d4285053b28299f65'
const normalizing = '|a|b|\n|---|---|\n|x|y|\n\ntarget paragraph\n'
const token = 'mtnnwcr'
type Mode = 'ir' | 'wysiwyg'
type Span = { start: number; end: number }

let lutes: Record<Mode, RealLute>
let dispose: (() => void) | undefined
beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  delete (window as any).__vmdeBlockHandleCacheMetrics
  delete (window as any).vditor
})

function linesOf(source: string) {
  return [...source.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)]
    .filter((match) => match[0].length > 0)
    .map((match) => ({
      text: match[1],
      start: match.index!,
      end: match.index! + match[1].length,
    }))
}

const fixtureLines = linesOf(fixture)
const firstTable = fixtureLines.findIndex((line) => line.text.startsWith('|'))
const nearLine = fixtureLines.find(
  (line, index) =>
    index > firstTable &&
    line.text.length > 0 &&
    fixtureLines[index - 1]?.text === '' &&
    fixtureLines[index + 1]?.text === '' &&
    !/[`*_[\]<>\\|~#]/u.test(line.text) &&
    !/^\s|^\d+[.)] |^[-+>]/u.test(line.text),
)!
const matches = [...fixture.matchAll(/mtnnwcr/giu)]
const farLine = fixtureLines.find(
  (line) =>
    line.start <= matches[1]?.index &&
    line.end >= matches[1]?.index + token.length,
)!
const near = { start: nearLine.start, end: nearLine.end }
const emphasized = {
  start: fixtureLines[23].start,
  end: fixtureLines[23].end,
}
const far = { start: farLine.start, end: farLine.end }

function mount(mode: Mode, source: string) {
  const real = lutes[mode]
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = real.render(source)
  document.body.append(root)
  const inner = {
    currentMode: mode,
    lute: real.lute,
    [mode]: { element: root },
    options: { undoDelay: 800 },
  }
  const posted: string[] = []
  const outer = {
    vditor: inner,
    getCurrentMode: () => mode,
    getValue: () => real.serialize(root.innerHTML),
    setValue: (markdown: string) => {
      root.innerHTML = real.render(markdown)
    },
  }
  ;(window as any).vditor = outer
  const sync = createEditSync({
    isSuppressed: () => false,
    docMode: { cvActive: false, streamActive: false, docChars: source.length },
    initialMarkdown: source,
  })
  // Anchor the same exact/rendered pair that production EditSync gives the command.
  const pair = sync.snapshotPair()
  expect(pair.exact === source).toBe(true)
  expect(pair.rendered === outer.getValue()).toBe(true)
  dispose = configureBlockTransformCommand({
    snapshotExactMarkdown: sync.snapshotExactMarkdown,
    snapshotRevision: sync.snapshotRevision,
    setApplying: () => undefined,
    postExact: (markdown) => posted.push(markdown),
    onError: () => undefined,
  })
  const commandDispose = dispose
  const readPair = vi.fn(sync.snapshotPair)
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: currentBlockProjection,
    snapshotPair: readPair,
    snapshotRevision: sync.snapshotRevision,
    resolveUnits: (element, exact, rendered) =>
      resolveBlockHandleUnits(
        element,
        exact,
        rendered,
        currentBlockProjection(),
      ),
  })
  const unbindSource = bindBlockTransformSource({
    index,
    snapshotPair: readPair,
  })
  dispose = () => {
    commandDispose()
    unbindSource()
    index.dispose()
    sync.dispose()
  }
  return { real, root, source, sync, posted, index, readPair }
}

type Mounted = ReturnType<typeof mount>
function pointInText(element: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (offset <= length) return { node, offset }
    offset -= length
  }
  throw new Error('target DOM point missing')
}

function selectParagraph(context: Mounted, span: Span, rangeToken = false) {
  const template = document.createElement('div')
  template.innerHTML = context.real.render(
    context.source.slice(span.start, span.end),
  )
  const targetText = template.querySelector('p')?.textContent
  const paragraphs = Array.from(
    context.root.querySelectorAll<HTMLElement>(':scope > p'),
  ).filter((paragraph) => paragraph.textContent === targetText)
  expect(paragraphs.length === 1).toBe(true)
  const text = paragraphs[0].textContent ?? ''
  const start = rangeToken
    ? text.toLowerCase().indexOf(token)
    : Math.floor(text.trimEnd().length / 2)
  expect(start >= 0).toBe(true)
  const first = pointInText(paragraphs[0], start)
  const last = pointInText(
    paragraphs[0],
    rangeToken ? start + token.length : start,
  )
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return range
}

function selectAcross(first: HTMLElement, last: HTMLElement): Range {
  const range = document.createRange()
  const start = pointInText(first, 0)
  const end = pointInText(last, last.textContent?.length ?? 0)
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return range
}

function focusOut(context: Mounted): void {
  context.root.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }),
  )
}

function focusSentinel(context: Mounted): void {
  const sentinel = document.createRange()
  sentinel.setStart(context.root, 0)
  sentinel.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(sentinel)
  document.dispatchEvent(new Event('selectionchange'))
}

function selectIrMarker(context: Mounted): Range {
  const marker = context.root.querySelector('.vditor-ir__marker')!
  const text = document
    .createTreeWalker(marker, NodeFilter.SHOW_TEXT)
    .nextNode()!
  const range = document.createRange()
  range.setStart(text, 1)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return range
}

function expectParagraphOptions(
  source: string,
  caret: number,
  options: ReturnType<typeof requestBlockTransformOptions>,
) {
  const oracle = describeBlockAt(source, caret, caret)
  expect(options !== null).toBe(true)
  expect(options?.currentType === 'paragraph').toBe(true)
  expect(
    options?.span.start === oracle?.span.start &&
      options?.span.end === oracle?.span.end,
  ).toBe(true)
  expect(
    options?.targets.find((item) => item.type === 'h2')?.status === 'changed',
  ).toBe(true)
}

it('P0 fixes the fixture, normalization and exact-source paragraph oracles', () => {
  expect(
    createHash('sha256').update(fixtureBytes).digest('hex') === fixtureHash,
  ).toBe(true)
  expect(fixtureBytes.length === 174_527 && fixture.length === 174_517).toBe(
    true,
  )
  expect(firstTable >= 0 && Boolean(nearLine) && Boolean(farLine)).toBe(true)
  expect(matches.length === 2).toBe(true)
  expect(nearLine === fixtureLines[207]).toBe(true)
  expect(farLine === fixtureLines[1296]).toBe(true)
  expect(/[*_]/u.test(fixture.slice(emphasized.start, emphasized.end))).toBe(
    true,
  )
  for (const mode of ['ir', 'wysiwyg'] as const) {
    const real = lutes[mode]
    expect(real.serialize(real.render(fixture)) !== fixture).toBe(true)
    for (const span of [near, far]) {
      const caret = span.start + Math.floor((span.end - span.start) / 2)
      const oracle = describeBlockAt(fixture, caret, caret)
      expect(oracle?.currentType === 'paragraph').toBe(true)
      expect(
        oracle?.span.start === span.start && oracle?.span.end === span.end,
      ).toBe(true)
      expect(
        oracle?.targets.find((item) => item.type === 'h2')?.status ===
          'changed',
      ).toBe(true)
      const plan = planBlockTransform(
        fixture,
        span,
        { type: 'h2' },
        caret,
        caret,
      )
      expect(
        plan.markdown ===
          `${fixture.slice(0, span.start)}## ${fixture.slice(span.start)}`,
      ).toBe(true)
    }
  }
})

for (const mode of ['ir', 'wysiwyg'] as const) {
  it(`${mode}: V1/V3 offers Heading 2 at the plain near caret`, {
    timeout: 60_000,
  }, () => {
    const context = mount(mode, fixture)
    selectParagraph(context, near)
    expectParagraphOptions(
      fixture,
      near.start + Math.floor((near.end - near.start) / 2),
      requestBlockTransformOptions(window),
    )
  })

  it(`${mode}: secondary emphasized paragraph keeps its exact span`, {
    timeout: 60_000,
  }, () => {
    const context = mount(mode, fixture)
    selectParagraph(context, emphasized)
    expectParagraphOptions(
      fixture,
      emphasized.start + Math.floor((emphasized.end - emphasized.start) / 2),
      requestBlockTransformOptions(window),
    )
  })

  it(`${mode}: V2/V4 restores deferred Find on the far token`, {
    timeout: 60_000,
  }, () => {
    const context = mount(mode, fixture)
    const selected = selectParagraph(context, far, true)
    expect(selected.toString().toLowerCase() === token).toBe(true)
    const widget = document.createElement('div')
    widget.className = 'vmde-find-replace'
    const input = document.createElement('input')
    widget.append(input)
    document.body.append(widget)
    context.root.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: input }),
    )
    getSelection()!.removeAllRanges()
    const options = requestBlockTransformOptions(window)
    expect(getSelection()!.toString().toLowerCase() === token).toBe(true)
    expectParagraphOptions(fixture, far.start, options)
  })

  it(`${mode}: V5 offers Heading 2 after a small normalized table`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    const span = { start, end: start + 'target paragraph'.length }
    expect(
      context.real.serialize(context.real.render(normalizing)) !== normalizing,
    ).toBe(true)
    selectParagraph(context, span)
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
  })

  it(`${mode}: V8 posts the exact large-fixture plan through the bound selection proof`, {
    timeout: 60_000,
  }, () => {
    const context = mount(mode, fixture)
    selectParagraph(context, near)
    expectExactNearHeadingPayload(context, requestBlockTransformOptions(window))
  })

  it(`${mode}: V9 declines a normalizing two-paragraph selection but offers round-trip multi-block targets`, () => {
    const changed = mount(mode, `${normalizing}\nsecond paragraph\n`)
    const paragraphs = changed.root.querySelectorAll<HTMLElement>(':scope > p')
    expect(paragraphs).toHaveLength(2)
    selectAcross(paragraphs[0], paragraphs[1])
    expect(requestBlockTransformOptions(window)).toBeNull()
    dispose?.()
    dispose = undefined
    getSelection()?.removeAllRanges()
    document.body.replaceChildren()

    const clean = mount(mode, 'first paragraph\n\nsecond paragraph\n')
    const cleanParagraphs =
      clean.root.querySelectorAll<HTMLElement>(':scope > p')
    expect(cleanParagraphs).toHaveLength(2)
    selectAcross(cleanParagraphs[0], cleanParagraphs[1])
    const options = requestBlockTransformOptions(window)
    expect(options?.spans).toHaveLength(2)
    expect(
      options?.targets.find((target) => target.type === 'h2')?.status,
    ).toBe('changed')
  })

  it(`${mode}: V10 reuses a warm entry with one pair, at most one getValue, and no markers`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    const entry = context.index.read()
    expect(entry).not.toBeNull()
    context.readPair.mockClear()
    const getValue = vi.spyOn((window as any).vditor, 'getValue')
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    const metrics = { indexBuilds: 0, blockTransformCaptureCalls: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    const options = requestBlockTransformOptions(window)
    expectParagraphOptions(normalizing, start + 5, options)
    expect(context.readPair).toHaveBeenCalledTimes(1)
    expect(getValue.mock.calls.length).toBeLessThanOrEqual(1)
    expect(insertNode).not.toHaveBeenCalled()
    expect(context.index.peek()).toBe(entry)
    expect(metrics.indexBuilds).toBe(0)
    expect(metrics.blockTransformCaptureCalls).toBe(1)
  })

  it(`${mode}: V11 eagerly captures a warm focus transfer without markers`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    renderedPlanFor(context.index.read()!)
    context.readPair.mockClear()
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    focusOut(context)
    expect(context.readPair).toHaveBeenCalledTimes(1)
    expect(insertNode).not.toHaveBeenCalled()
    focusSentinel(context)
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
    expect(context.readPair).toHaveBeenCalledTimes(1)
    expect(insertNode).not.toHaveBeenCalled()
  })

  it(`${mode}: V11 defers a warm index with a cold rendered plan`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    const entry = context.index.read()!
    expect(hasRenderedPlanFor(entry)).toBe(false)
    context.readPair.mockClear()
    const getValue = vi.spyOn((window as any).vditor, 'getValue')
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    focusOut(context)
    expect(context.readPair).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
    expect(insertNode).not.toHaveBeenCalled()
    expect(hasRenderedPlanFor(entry)).toBe(false)
    getSelection()!.removeAllRanges()
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
    expect(hasRenderedPlanFor(entry)).toBe(true)
    expect(insertNode).not.toHaveBeenCalled()
  })

  it(`${mode}: V11 defers a cold focus transfer until the request`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    expect(context.index.peek()).toBeNull()
    context.readPair.mockClear()
    const getValue = vi.spyOn((window as any).vditor, 'getValue')
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    const metrics = { indexBuilds: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    focusOut(context)
    expect(context.readPair).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
    expect(insertNode).not.toHaveBeenCalled()
    expect(metrics.indexBuilds).toBe(0)
    getSelection()!.removeAllRanges()
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
    expect(context.readPair.mock.calls.length).toBeGreaterThan(0)
    expect(metrics.indexBuilds).toBe(1)
    expect(insertNode).not.toHaveBeenCalled()
  })

  it(`${mode}: V12 retained proof trusts the same key, checks a DOM-only key once, then rejects changed exact authority`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    renderedPlanFor(context.index.read()!)
    focusOut(context)
    focusSentinel(context)
    context.readPair.mockClear()
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
    expect(context.readPair).not.toHaveBeenCalled()

    // A source-relevant attribute advances only domRevision; Lute's Markdown is unchanged.
    context.root.querySelector('p')!.setAttribute('data-s4b-revision', '1')
    expectParagraphOptions(
      normalizing,
      start + 5,
      requestBlockTransformOptions(window),
    )
    expect(context.readPair).toHaveBeenCalledTimes(1)

    // A trusted input revokes the exact pair while leaving this DOM snapshot in place.
    context.sync.markUserInput(true)
    expect(requestBlockTransformOptions(window)).toBeNull()
    expect(context.readPair).toHaveBeenCalledTimes(2)
  })

  it(`${mode}: V13 declines a pending exact-history transition before capture reads`, () => {
    const context = mount(mode, normalizing)
    const start = normalizing.indexOf('target paragraph')
    selectParagraph(context, { start, end: start + 'target paragraph'.length })
    const nativeState = {}
    const inner = (window as any).vditor.vditor
    inner.undo = { [mode]: { undoStack: [], redoStack: [nativeState] } }
    recordRewrapDocumentHistory({
      owner: inner,
      mode,
      nativeState,
      beforeRendered: context.real.serialize(context.root.innerHTML),
      beforeExact: normalizing,
      afterRendered: context.real.serialize(context.root.innerHTML),
      afterExact: normalizing,
    })
    context.readPair.mockClear()
    const getValue = vi.spyOn((window as any).vditor, 'getValue')
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    const metrics = { blockTransformCaptureCalls: 0, indexBuilds: 0 }
    ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
    expect(requestBlockTransformOptions(window)).toBeNull()
    expect(context.readPair).not.toHaveBeenCalled()
    expect(getValue).not.toHaveBeenCalled()
    expect(insertNode).not.toHaveBeenCalled()
    expect(metrics.blockTransformCaptureCalls).toBe(0)
    expect(metrics.indexBuilds).toBe(0)
  })

  it(`${mode}: V14 proves a large CRLF fixture at block scope`, {
    timeout: 60_000,
  }, () => {
    const crlf = fixture.replace(/\n/gu, '\r\n')
    const context = mount(mode, crlf)
    const line = linesOf(crlf)[207]
    const span = { start: line.start, end: line.end }
    const range = selectParagraph(context, span)
    const proof = proveSelectionSource(
      { index: context.index, snapshotPair: context.readPair },
      context.root,
      range,
    )
    expect(proof).toMatchObject({
      status: 'proven',
      roundTrip: false,
      start: { via: 'block' },
      end: { via: 'block' },
    })
    expectParagraphOptions(
      crlf,
      span.start + Math.floor((span.end - span.start) / 2),
      requestBlockTransformOptions(window),
    )
  })
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  it(`V6 ${mode} declines the first table insertion boundary without posting`, {
    timeout: 60_000,
  }, () => {
    const context = mount(mode, fixture)
    const rendered = context.real.serialize(context.root.innerHTML)
    const firstPipe = fixtureLines[firstTable].start
    const boundary =
      mode === 'ir' ? firstPipe : fixture.indexOf('|', firstPipe + 1)
    const aligned = alignText(fixture, rendered)
    expect(boundary === (mode === 'ir' ? 66 : 74)).toBe(true)
    expect(
      aligned.toRendered(boundary, 'start') !==
        aligned.toRendered(boundary, 'end'),
    ).toBe(true)
    // A pipe separator has no text node in the rendered table. The adjacent
    // element boundary is the DOM caret shape that must decline without proof.
    const row = context.root.querySelector('table thead tr')!
    const range = document.createRange()
    range.setStart(row, mode === 'ir' ? 0 : 1)
    range.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    expect(requestBlockTransformOptions(window) === null).toBe(true)
    expect(context.posted.length === 0).toBe(true)
  })
}

it('V9 rejects metadata spanning outside the exact unit despite proven endpoints', () => {
  const context = mount('ir', normalizing)
  const start = normalizing.indexOf('target paragraph')
  const range = selectParagraph(context, {
    start,
    end: start + 'target paragraph'.length,
  })
  expect(
    proveSelectionSource(
      { index: context.index, snapshotPair: context.readPair },
      context.root,
      range,
    ).status,
  ).toBe('proven')
  const original = describeBlockAt(normalizing, start + 5, start + 5)!
  const metadata = vi.spyOn(blockTransform, 'describeBlockAt')
  // The endpoint is sound; a later owner result that widens the proposed edit is not.
  metadata.mockReturnValueOnce({
    ...original,
    spans: [original.span, { start: 0, end: original.span.end }],
  })
  expect(requestBlockTransformOptions(window)).toBeNull()
  metadata.mockReturnValueOnce({
    ...original,
    span: { start: 0, end: original.span.end },
  })
  expect(requestBlockTransformOptions(window)).toBeNull()
  expect(metadata).toHaveBeenCalledTimes(2)
  expect(context.posted).toEqual([])
})

it('V15 uses the legacy marker proof for a round-trip IR marker caret', () => {
  const context = mount('ir', '**Strong** words\n')
  const range = selectIrMarker(context)
  expect(
    proveSelectionSource(
      { index: context.index, snapshotPair: context.readPair },
      context.root,
      range,
    ),
  ).toEqual({ status: 'unprovable', roundTrip: true })
  const metrics = {
    blockTransformIndexProofs: 0,
    blockTransformLegacyProofs: 0,
  }
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  const options = requestBlockTransformOptions(window)
  expect(options?.currentType).toBe('paragraph')
  expect(metrics.blockTransformIndexProofs).toBe(0)
  expect(metrics.blockTransformLegacyProofs).toBe(1)
  expect(insertNode.mock.calls.length).toBeGreaterThan(0)
})

it('V15 declines a marker caret on a normalizing IR document without markers', () => {
  const source = '|a|b|\n|---|---|\n|x|y|\n\n**Strong** words\n'
  const context = mount('ir', source)
  const range = selectIrMarker(context)
  expect(
    proveSelectionSource(
      { index: context.index, snapshotPair: context.readPair },
      context.root,
      range,
    ),
  ).toEqual({ status: 'unprovable', roundTrip: false })
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  expect(requestBlockTransformOptions(window)).toBeNull()
  expect(insertNode).not.toHaveBeenCalled()
})

it('V6 rejects an older token while keeping the round-trip document unchanged', () => {
  const context = mount('ir', 'target paragraph\n')
  const span = { start: 0, end: 'target paragraph'.length }
  selectParagraph(context, span)
  const first = requestBlockTransformOptions(window)
  const second = requestBlockTransformOptions(window)
  expect(first !== null && second !== null).toBe(true)
  expect(first?.token !== second?.token).toBe(true)
  expect(
    applyBlockTransformChoice(window, first!.token, { type: 'h2' }) === false,
  ).toBe(true)
  expect(context.posted.length === 0).toBe(true)
  expect(context.sync.snapshotExactMarkdown() === 'target paragraph\n').toBe(
    true,
  )
})

it('V7 posts the exact large-fixture plan once through the at-source oracle', {
  timeout: 60_000,
}, () => {
  const context = mount('ir', fixture)
  const options = requestBlockTransformOptionsAtSource(
    window,
    near.start,
    near.end,
    () => true,
  )
  expectExactNearHeadingPayload(context, options)
})

function expectExactNearHeadingPayload(
  context: Mounted,
  options: ReturnType<typeof requestBlockTransformOptions>,
) {
  const rendered = context.real.serialize(context.root.innerHTML)
  const alignment = alignText(fixture, rendered)
  const renderedStart = alignment.toRendered(near.start, 'start')
  const renderedEnd = alignment.toRendered(near.end, 'end')
  expect(renderedStart !== null && renderedEnd !== null).toBe(true)
  expect(options !== null).toBe(true)
  const exactPlan = planBlockTransform(
    fixture,
    near,
    { type: 'h2' },
    near.start,
    near.start,
  )
  const renderedPlan = planBlockTransform(
    rendered,
    { start: renderedStart!, end: renderedEnd! },
    { type: 'h2' },
    renderedStart!,
    renderedStart!,
  )
  const applied = applyBlockTransformChoice(window, options!.token, {
    type: 'h2',
  })
  expect(applied === true).toBe(true)
  expect(context.posted.length === 1).toBe(true)
  expect(context.posted[0] === exactPlan.markdown).toBe(true)
  expect(context.posted[0] !== renderedPlan.markdown).toBe(true)
}
