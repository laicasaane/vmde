import { explicitHardBreaks } from './rewrap-markdown'

interface LineBreakLute {
  Md2VditorIRDOM(markdown: string): string
  Md2VditorDOM(markdown: string): string
  VditorIRDOM2Md(html: string): string
  VditorDOM2Md(html: string): string
  SpinVditorIRDOM(html: string): string
  SpinVditorDOM(html: string): string
  SpinVditorSVDOM(markdown: string): string
}

interface MarkerReplacement {
  marker: string
  markdown: string
  html: string
}

const wrappedLutes = new WeakSet<object>()
const HARD_MARKER_BASE = '\uE301VMDE_HARD_BREAK'
const EXCLUDED_DOM =
  'pre, code, table, [data-type*="code"], [data-type*="html"], [data-type*="math"]'
const FLOW_ROOTS = 'p, li'

const MARKER_END = '\uE30F'
const MARKER_COUNTER = /\uE301VMDE_HARD_BREAK_(\d+)\uE30F/gu
// A marker in the parsed text needs its first character, U+E301, which the HTML can only hold
// literally or as a numeric character reference (any case, leading zeros, optional semicolon;
// there is no named reference for it). Every other marker character may be spelled any way.
const MARKER_START = '\uE301'
const MARKER_START_REFERENCE = /&#(?:x0*e301|0*58113)(?![0-9a-f])/iu

function markerAt(base: string, counter: number): string {
  return `${base}_${counter}${MARKER_END}`
}

/** Counters of the markers that already occur in the parsed root, or `undefined` when none can. */
function usedMarkerCounters(
  html: string,
  root: HTMLElement,
): Set<number> | undefined {
  if (!html.includes(MARKER_START) && !MARKER_START_REFERENCE.test(html))
    return undefined
  const used = new Set<number>()
  for (const match of root.innerHTML.matchAll(MARKER_COUNTER))
    used.add(Number(match[1]))
  return used
}

function htmlRoot(html: string): HTMLDivElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

function eligibleFlowRoots(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FLOW_ROOTS)).filter(
    (flowRoot) => !flowRoot.closest(EXCLUDED_DOM),
  )
}

function renderIdentityDom(html: string, markdown: string): string {
  const root = htmlRoot(html)
  const suffixes = explicitHardBreaks(markdown).map((entry) => entry.suffix)
  const hardBreaks = eligibleFlowRoots(root).flatMap((flowRoot) =>
    Array.from(flowRoot.querySelectorAll<HTMLBRElement>('br')).filter(
      (br) => !br.closest(EXCLUDED_DOM) && br.closest(FLOW_ROOTS) === flowRoot,
    ),
  )
  // A raw-HTML `<br>` or another context-sensitive shape makes source↔DOM ordering ambiguous.
  // Fail closed: leave the entire render untouched instead of tagging the wrong break.
  if (hardBreaks.length !== suffixes.length) return html
  hardBreaks.forEach((br, index) => {
    br.dataset.vmdeHardBreak = encodeURIComponent(suffixes[index])
  })
  return root.innerHTML
}

function renderSvIdentityDom(html: string, markdown: string): string {
  const root = htmlRoot(html)
  const newlines = Array.from(
    root.querySelectorAll<HTMLElement>('[data-type="newline"]'),
  )
  const entries = explicitHardBreaks(markdown)
  if (entries.some((entry) => !newlines[entry.line])) return html
  for (const entry of entries) {
    newlines[entry.line].before(document.createTextNode(entry.suffix))
  }
  return root.innerHTML
}

function encodeIdentityDom(html: string): {
  html: string
  replacements: MarkerReplacement[]
} {
  const root = htmlRoot(html)
  const replacements: MarkerReplacement[] = []
  // Task 733 / 009: uniqueness is decided once per call, not by serializing the root per break.
  // Markers placed in this call never collide with each other (one counter per break).
  const used = usedMarkerCounters(html, root)
  let counter = 0
  for (const hardBreak of root.querySelectorAll<HTMLElement>(
    'br[data-vmde-hard-break]',
  )) {
    const encoded = hardBreak.dataset.vmdeHardBreak
    if (!encoded) continue
    const suffix = decodeURIComponent(encoded)
    while (used?.has(counter)) counter++
    const marker = markerAt(HARD_MARKER_BASE, counter)
    counter++
    replacements.push({
      marker,
      markdown: `${suffix}\n`,
      html: `<br data-vmde-hard-break="${encoded}">`,
    })
    hardBreak.replaceWith(document.createTextNode(marker))
  }
  return { html: root.innerHTML, replacements }
}

function decodeMarkdown(
  markdown: string,
  replacements: MarkerReplacement[],
): string {
  let result = markdown
  for (const replacement of replacements) {
    result = result.split(replacement.marker).join(replacement.markdown)
  }
  return result
}

function decodeHtml(html: string, replacements: MarkerReplacement[]): string {
  let result = html
  for (const replacement of replacements) {
    result = result.split(replacement.marker).join(replacement.html)
  }
  return result
}

export function wrapLiveLineBreakIdentity(lute: LineBreakLute): void {
  if (wrappedLutes.has(lute)) return
  wrappedLutes.add(lute)

  for (const key of ['Md2VditorIRDOM', 'Md2VditorDOM'] as const) {
    const original = lute[key].bind(lute)
    lute[key] = (markdown: string) => {
      const html = original(markdown)
      return renderIdentityDom(html, markdown)
    }
  }
  for (const key of ['VditorIRDOM2Md', 'VditorDOM2Md'] as const) {
    const original = lute[key].bind(lute)
    lute[key] = (html: string) => {
      if (!html.includes('data-vmde-')) return original(html)
      const encoded = encodeIdentityDom(html)
      return decodeMarkdown(original(encoded.html), encoded.replacements)
    }
  }
  for (const key of ['SpinVditorIRDOM', 'SpinVditorDOM'] as const) {
    const original = lute[key].bind(lute)
    lute[key] = (html: string) => {
      if (!html.includes('data-vmde-')) return original(html)
      const encoded = encodeIdentityDom(html)
      return decodeHtml(original(encoded.html), encoded.replacements)
    }
  }
  const originalSvSpin = lute.SpinVditorSVDOM.bind(lute)
  lute.SpinVditorSVDOM = (markdown: string) =>
    renderSvIdentityDom(originalSvSpin(markdown), markdown)
}
