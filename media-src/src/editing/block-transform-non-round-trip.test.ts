// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { createEditSync } from '../bridge/edit-sync'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { alignText } from './find-align'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
  requestBlockTransformOptionsAtSource,
} from './block-transform-command'
import { describeBlockAt, planBlockTransform } from './block-transform'

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
  getSelection()?.removeAllRanges()
  document.body.replaceChildren()
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
  dispose = () => {
    commandDispose()
    sync.dispose()
  }
  return { real, root, source, sync, posted }
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
  it.fails(`${mode}: V1/V3 offers Heading 2 at the plain near caret`, () => {
    const context = mount(mode, fixture)
    selectParagraph(context, near)
    expectParagraphOptions(
      fixture,
      near.start + Math.floor((near.end - near.start) / 2),
      requestBlockTransformOptions(window),
    )
  })

  it.fails(`${mode}: secondary emphasized paragraph keeps its exact span`, () => {
    const context = mount(mode, fixture)
    selectParagraph(context, emphasized)
    expectParagraphOptions(
      fixture,
      emphasized.start + Math.floor((emphasized.end - emphasized.start) / 2),
      requestBlockTransformOptions(window),
    )
  })

  it.fails(`${mode}: V2/V4 restores deferred Find on the far token`, () => {
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

  it.fails(`${mode}: V5 offers Heading 2 after a small normalized table`, () => {
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
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  it(`V6 ${mode} declines the first table insertion boundary without posting`, () => {
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

it('V7 posts the exact large-fixture plan once through the at-source oracle', () => {
  const context = mount('ir', fixture)
  const rendered = context.real.serialize(context.root.innerHTML)
  const alignment = alignText(fixture, rendered)
  const renderedStart = alignment.toRendered(near.start, 'start')
  const renderedEnd = alignment.toRendered(near.end, 'end')
  expect(renderedStart !== null && renderedEnd !== null).toBe(true)
  const options = requestBlockTransformOptionsAtSource(
    window,
    near.start,
    near.end,
    () => true,
  )
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
})
