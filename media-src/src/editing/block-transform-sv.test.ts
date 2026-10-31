// @vitest-environment jsdom
// Task 605 S2a (RED): Turn Into in SV must offer only source-proven targets and apply them as an
// exact-source edit. The SV editor text differs from the exact bytes (an appended trailing newline
// and U+200B in direct SV, the Lute serialization after a mode switch, dropped carriage returns),
// so every case drives the real command against a real-Lute SV rendering. Until the SV proof
// exists, SV declines everything; the control request in each case therefore fails first.
import fs, { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createEditSync } from '../bridge/edit-sync'
import { createRealLute, type RealLute } from '../testing/real-lute'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
} from './block-transform-command'
import { describeBlockAt } from './block-transform'
import { recordRewrapDocumentHistory } from './rewrap-command'
import { planSvEdit } from './sv-source-proof'

const fixture = readFileSync(
  'test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  'utf8',
)
const SMALL = 'before\n\ntarget paragraph\n\nafter\n'
const TARGET = 'target paragraph'
const ZWSP = String.fromCodePoint(0x200b)
// The large-fixture cases render and align a 174,517-character SV document in jsdom; a loaded
// parallel run exceeds the 5 s default.
vi.setConfig({ testTimeout: 30_000 })
type Route = 'direct' | 'ir' | 'wysiwyg'

let sv: any
let lutes: Record<'ir' | 'wysiwyg', RealLute>
let dispose: (() => void) | undefined
beforeAll(() => {
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync('media-src/vendor/lute/lute.min.js', 'utf8'),
    sandbox,
    { filename: 'lute.min.js' },
  )
  sv = (sandbox as { Lute: { New(): any } }).Lute.New()
  sv.SetVditorSV(true)
  sv.SetSpin(true)
  sv.SetSanitize(true)
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.restoreAllMocks()
  getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  delete (window as any).vditor
})

interface MountOptions {
  /** Markdown the SV editor shows when it is not the exact source (a switched mode). */
  display?: string
  /** Direct SV appends U+200B after the document (measured in S1). */
  zwsp?: boolean
  exactMarkdown?: () => string | null
}

/** One SV editor over `exact`, rendered like Vditor's `setValue` (wrapper plus Lute SV spans). */
function mountSv(exact: string, options: MountOptions = {}) {
  const root = document.createElement('pre')
  root.className = 'vditor-sv vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = `<div data-block="0">${sv.SpinVditorSVDOM(options.display ?? exact)}</div>`
  if (options.zwsp) root.append(document.createTextNode(ZWSP))
  document.body.append(root)
  const inner: Record<string, any> = {
    currentMode: 'sv',
    lute: sv,
    sv: { element: root },
    options: { undoDelay: 800 },
  }
  const getValue = () =>
    `${root.textContent}\n`.replace(/\n\n$/u, '\n').replaceAll(' ', ' ')
  ;(window as any).vditor = {
    vditor: inner,
    getCurrentMode: () => 'sv',
    getValue,
    setValue: vi.fn(),
  }
  const sync = createEditSync({
    isSuppressed: () => false,
    docMode: { cvActive: false, streamActive: false, docChars: exact.length },
    initialMarkdown: exact,
  })
  const posted: string[] = []
  dispose = () => {
    commandDispose()
    sync.dispose()
  }
  const commandDispose = configureBlockTransformCommand({
    snapshotExactMarkdown: options.exactMarkdown ?? sync.snapshotExactMarkdown,
    acquireExactAuthority: () => sync.acquireExactAuthority(),
    snapshotRevision: sync.snapshotRevision,
    setApplying: () => undefined,
    postExact: (markdown) => {
      posted.push(markdown)
    },
    onError: () => undefined,
  })
  return { root, inner, exact, posted, text: () => root.textContent ?? '' }
}
type Mounted = ReturnType<typeof mountSv>

function pointAt(root: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (offset <= length) return { node, offset }
    offset -= length
  }
  throw new Error('SV text offset outside the editor')
}

/** Select SV editor text offsets `[from, to)`; equal offsets make a caret. */
function selectText(mounted: Mounted, from: number, to = from): Range {
  const start = pointAt(mounted.root, from)
  const end = pointAt(mounted.root, to)
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return range
}

/** The SV text offset of a source fragment, which must appear once and verbatim. */
function textOffsetOf(mounted: Mounted, fragment: string): number {
  const text = mounted.text()
  const at = text.indexOf(fragment)
  expect(at >= 0 && at === text.lastIndexOf(fragment)).toBe(true)
  return at
}

function spanOf(source: string, fragment: string) {
  const start = source.indexOf(fragment)
  expect(start >= 0 && start === source.lastIndexOf(fragment)).toBe(true)
  return { start, end: start + fragment.length }
}

function headingPlan(source: string, span: { start: number }) {
  return `${source.slice(0, span.start)}## ${source.slice(span.start)}`
}

function expectOffered(
  mounted: Mounted,
  fragment: string,
  options: ReturnType<typeof requestBlockTransformOptions>,
) {
  const span = spanOf(mounted.exact, fragment)
  const oracle = describeBlockAt(mounted.exact, span.start + 1, span.start + 1)
  expect(options).not.toBeNull()
  expect(options?.currentType).toBe('paragraph')
  expect(options?.span).toEqual(oracle?.span)
  expect(options?.targets.find((item) => item.type === 'h2')?.status).toBe(
    'changed',
  )
}

function switchedDisplay(route: 'ir' | 'wysiwyg', source: string): string {
  const real = lutes[route]
  return real.serialize(real.render(source))
}

function mountRoute(route: Route, source: string): Mounted {
  return route === 'direct'
    ? mountSv(source, { zwsp: true })
    : mountSv(source, { display: switchedDisplay(route, source) })
}

function nearParagraph(): string {
  const lines = fixture.split('\n')
  const first = lines.findIndex((line) => line.startsWith('|'))
  const index = lines.findIndex(
    (line, at) =>
      at > first &&
      line.length > 0 &&
      lines[at - 1] === '' &&
      lines[at + 1] === '' &&
      !/[`*_[\]<>\\|~#]/u.test(line) &&
      !/^\s|^\d+[.)] |^[-+>]/u.test(line),
  )
  return lines[index]
}

const ROUTES: Route[] = ['direct', 'ir', 'wysiwyg']

it('P0 models the measured SV text: appended tail, Lute serialization, dropped CR', () => {
  const direct = mountSv(SMALL, { zwsp: true })
  // S1: F5b is 32 exact characters, 34 SV text characters (exact + newline + U+200B), 35 rendered.
  expect(direct.text()).toBe(`${SMALL}\n${ZWSP}`)
  expect((window as any).vditor.getValue().length - SMALL.length === 3).toBe(
    true,
  )
  dispose?.()
  const crlf = mountSv(SMALL.replaceAll('\n', '\r\n'))
  expect(crlf.text().includes('\r')).toBe(false)
  dispose?.()
  const nbsp = mountSv(SMALL.replace(' ', ' '))
  expect(nbsp.text().includes(' ')).toBe(true)
  expect((window as any).vditor.getValue().includes(' ')).toBe(false)
})

it('offers Heading 2 at a caret in the small round-tripping control (F5b)', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  expectOffered(mounted, TARGET, requestBlockTransformOptions(window))
})

it('applies Heading 2 on F5b: exact bytes posted, only the target text changes', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  const before = mounted.text()
  const at = textOffsetOf(mounted, TARGET)
  selectText(mounted, at + 5)
  const options = requestBlockTransformOptions(window)
  expectOffered(mounted, TARGET, options)
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(true)
  expect(mounted.posted).toEqual([headingPlan(SMALL, spanOf(SMALL, TARGET))])
  expect(mounted.text()).toBe(`${before.slice(0, at)}## ${before.slice(at)}`)
})

it.each(ROUTES)(
  '%s SV offers Heading 2 for a caret in the near paragraph of the large fixture',
  (route) => {
    const near = nearParagraph()
    const mounted = mountRoute(route, fixture)
    selectText(mounted, textOffsetOf(mounted, near) + 3)
    expectOffered(mounted, near, requestBlockTransformOptions(window))
  },
)

it.each(ROUTES)(
  '%s SV offers Heading 2 for a range inside one far paragraph of the large fixture',
  (route) => {
    const token = 'mtnnwcr'
    const second = [...fixture.matchAll(/mtnnwcr/giu)][1]!.index!
    const lineStart = fixture.lastIndexOf('\n', second) + 1
    const lineEnd = fixture.indexOf('\n', second)
    const paragraph = fixture.slice(lineStart, lineEnd)
    const mounted = mountRoute(route, fixture)
    const at = textOffsetOf(mounted, paragraph) + paragraph.indexOf(token)
    selectText(mounted, at, at + token.length)
    const options = requestBlockTransformOptions(window)
    expect(options).not.toBeNull()
    expect(options?.span).toEqual(
      describeBlockAt(fixture, second, second + token.length)?.span,
    )
  },
)

it.each(ROUTES)(
  '%s SV applies Heading 2 to the near paragraph and leaves every other exact byte',
  (route) => {
    const near = nearParagraph()
    const mounted = mountRoute(route, fixture)
    const before = mounted.text()
    const at = textOffsetOf(mounted, near)
    selectText(mounted, at + 3)
    const options = requestBlockTransformOptions(window)
    expectOffered(mounted, near, options)
    expect(
      applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
    ).toBe(true)
    expect(mounted.posted).toEqual([
      headingPlan(fixture, spanOf(fixture, near)),
    ])
    expect(mounted.text()).toBe(`${before.slice(0, at)}## ${before.slice(at)}`)
  },
)

it('declines a selection across blocks of a non-round-trip switched document', () => {
  const near = nearParagraph()
  const mounted = mountRoute('ir', fixture)
  const at = textOffsetOf(mounted, near)
  selectText(mounted, at + 3)
  expect(requestBlockTransformOptions(window)).not.toBeNull()
  const far = mounted.text().indexOf('mtnnwcr', at)
  selectText(mounted, at + 3, far + 3)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('keeps the appended trailing newline and U+200B out of every offered target', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  const text = mounted.text()
  // Before: a caret at the end of the last source paragraph is still inside its text.
  selectText(mounted, text.indexOf('after') + 5)
  expectOffered(mounted, 'after', requestBlockTransformOptions(window))
  // Inside the appended newline span and after the appended U+200B there is no exact source.
  selectText(mounted, text.length - 1)
  expect(requestBlockTransformOptions(window)).toBeNull()
  selectText(mounted, text.length)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('maps a CRLF document and posts CRLF bytes outside the target unchanged', () => {
  const exact = SMALL.replaceAll('\n', '\r\n')
  const mounted = mountSv(exact, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  const options = requestBlockTransformOptions(window)
  expectOffered(mounted, TARGET, options)
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(true)
  expect(mounted.posted).toEqual([headingPlan(exact, spanOf(exact, TARGET))])
})

it('declines a multi-line CRLF paragraph whose rendered image is not verbatim', () => {
  // The SV text has no carriage returns, so a span that contains one has no verbatim image.
  const exact = 'before\r\n\r\nline one\r\nline two\r\n\r\nafter\r\n'
  const mounted = mountSv(exact, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, 'before') + 2)
  expectOffered(mounted, 'before', requestBlockTransformOptions(window))
  selectText(mounted, textOffsetOf(mounted, 'line one') + 2)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('plans no SV edit for a replacement that carries a carriage return', () => {
  const exact = 'a\r\nb\r\n'
  const span = { start: 0, end: 1 }
  const result = { markdown: '> a\r\nb\r\n', anchor: 2, focus: 2 }
  expect(planSvEdit(exact, result, span, { start: 0, end: 1 })).not.toBeNull()
  const withCr = { markdown: '> a\r\n> x\r\nb\r\n', anchor: 2, focus: 2 }
  expect(planSvEdit(exact, withCr, span, { start: 0, end: 1 })).toBeNull()
})

it('keeps U+00A0 verbatim in the target text and the posted exact bytes', () => {
  const target = 'target paragraph'
  const exact = SMALL.replace(TARGET, target)
  const mounted = mountSv(exact, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, target) + 3)
  const options = requestBlockTransformOptions(window)
  expectOffered(mounted, target, options)
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(true)
  expect(mounted.posted).toEqual([headingPlan(exact, spanOf(exact, target))])
  expect(mounted.text().includes(`## ${target}`)).toBe(true)
})

it('declines an endpoint that is an element offset, not a text position', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  const at = textOffsetOf(mounted, TARGET) + 5
  selectText(mounted, at)
  expect(requestBlockTransformOptions(window)).not.toBeNull()
  const range = document.createRange()
  range.setStart(mounted.root.firstElementChild!, 1)
  range.collapse(true)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('declines a caret that sits on a deletion boundary between exact and SV text', () => {
  // The exact source has one more blank line before the target than the SV text: the caret at the
  // start of the target is both before and after the deleted newline, so no exact offset is provable.
  const exact = SMALL.replace('\n\ntarget', '\n\n\ntarget')
  const mounted = mountSv(exact, { display: SMALL, zwsp: true })
  const start = textOffsetOf(mounted, TARGET)
  selectText(mounted, start + 2)
  expect(requestBlockTransformOptions(window)).not.toBeNull()
  selectText(mounted, start)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('declines apply when the SV text changed after the request', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  const options = requestBlockTransformOptions(window)
  expectOffered(mounted, TARGET, options)
  const first = mounted.root.querySelector('[data-type="text"]')!.firstChild!
  ;(first as Text).data = `x${(first as Text).data}`
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(false)
  expect(mounted.posted).toEqual([])
})

it('declines apply when only the SV editor text changed after the request', () => {
  // getValue() maps U+00A0 to a space, so swapping one keeps getValue() equal and isolates the
  // editor-text gate from the rendered-value gate.
  const target = 'target\u00a0paragraph'
  const exact = SMALL.replace(TARGET, target)
  const mounted = mountSv(exact, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, target) + 3)
  const options = requestBlockTransformOptions(window)
  expectOffered(mounted, target, options)
  const before = (window as any).vditor.getValue()
  const walker = document.createTreeWalker(mounted.root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (text.data.includes('\u00a0'))
      text.data = text.data.replace('\u00a0', ' ')
  }
  expect((window as any).vditor.getValue()).toBe(before)
  expect(mounted.text()).not.toContain('\u00a0')
  expect(
    applyBlockTransformChoice(window, options!.token, { type: 'h2' }),
  ).toBe(false)
  expect(mounted.posted).toEqual([])
})

it('offers a CRLF target when the range or caret ends at the line end', () => {
  // The SV text has no carriage returns, so the character after a line-end endpoint is "\n" in the
  // editor and "\r" in the exact source; the character before it is what must match.
  const exact = SMALL.replaceAll('\n', '\r\n')
  const mounted = mountSv(exact, { zwsp: true })
  const start = textOffsetOf(mounted, TARGET)
  selectText(mounted, start, start + TARGET.length)
  expectOffered(mounted, TARGET, requestBlockTransformOptions(window))
  selectText(mounted, start + TARGET.length)
  expectOffered(mounted, TARGET, requestBlockTransformOptions(window))
})

it('declines while an exact-history Undo or Redo transition is unsettled', () => {
  const mounted = mountSv(SMALL, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  expect(requestBlockTransformOptions(window)).not.toBeNull()
  const nativeState = {}
  mounted.inner.undo = {
    sv: { undoStack: [nativeState], redoStack: [nativeState] },
  }
  recordRewrapDocumentHistory({
    owner: mounted.inner as any,
    mode: 'sv',
    nativeState,
    beforeRendered: '',
    beforeExact: '',
    afterRendered: '',
    afterExact: '',
  })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 6)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('keeps front matter out of the offered targets and offers the body paragraph', () => {
  const exact = `---\ntitle: probe\n---\n\n${SMALL}`
  const mounted = mountSv(exact, { zwsp: true })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  expectOffered(mounted, TARGET, requestBlockTransformOptions(window))
  selectText(mounted, textOffsetOf(mounted, 'title') + 2)
  expect(requestBlockTransformOptions(window)).toBeNull()
})

it('opens nothing when no exact source is owned', () => {
  let owned = true
  const mounted = mountSv(SMALL, {
    zwsp: true,
    exactMarkdown: () => (owned ? SMALL : null),
  })
  selectText(mounted, textOffsetOf(mounted, TARGET) + 5)
  expect(requestBlockTransformOptions(window)).not.toBeNull()
  owned = false
  selectText(mounted, textOffsetOf(mounted, TARGET) + 6)
  expect(requestBlockTransformOptions(window)).toBeNull()
})
