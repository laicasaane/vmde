// Task 643 — pure planning for chunked full-Preview rendering. No DOM and no Vditor imports so it
// can be unit-tested in plain Node; the DOM assembly lives in editing/preview-render.ts.
//
// Full Preview renders the document with Lute's `Md2HTML` one chunk at a time. A chunk rendered
// alone loses footnote and link definitions that sit in another chunk, and Lute numbers footnotes
// by definition order within the text it is given. The plan therefore carries what the renderer
// needs to rebuild one-pass output: each chunk's local footnote label order, the global number of
// every footnote, and one trailing section that renders the real footnote list.
import {
  buildDefMap,
  chunkize,
  definedIn,
  externalDefsFor,
  normLabel,
} from './stream-chunk'

// A single Md2HTML pass costs about 100 ms at 50,000 characters; a 16,000-character chunk renders in
// roughly 30 ms. Preview has no editable DOM, so the edit modes' 700,000-character reflow limit does
// not carry over.
export const PREVIEW_STREAM_MIN_CHARS = 50_000
export const PREVIEW_STREAM_CHUNK_CHARS = 16_000
// The first chunk is small so something is on screen quickly: Lute is slower on table- and
// reference-heavy prose (measured: a 16,000-character chunk of such text took about 100 ms, one of
// plain prose about 25 ms), and the first paint waits for the whole first chunk.
export const PREVIEW_FIRST_CHUNK_CHARS = 4_000

export function shouldStreamPreview(length: number): boolean {
  return length > PREVIEW_STREAM_MIN_CHARS
}

interface PreviewChunk {
  source: string
  /** Footnote labels (`^`-prefixed, normalized) in the order Lute numbers them for this chunk:
   *  the chunk's own definitions in line order, then the injected external ones. */
  footnoteOrder: string[]
}

export interface PreviewPlan {
  chunks: PreviewChunk[]
  /** Global footnote number of each defined label, in definition order over the whole document. */
  footnoteNumbers: Map<string, number>
  /** Markdown whose rendered `.footnotes-defs-div` equals the one-pass footnote list, or null. */
  footnoteSection: string | null
}

const REFERENCE = /\[\^([^\]]+)\](?!:)/g

// Reference occurrences outside fenced code and inline code spans, as Lute counts them.
function referenceOccurrences(markdown: string, known: Map<string, string>) {
  const labels: string[] = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(REFERENCE)) {
      const label = `^${normLabel(match[1])}`
      if (known.has(label)) labels.push(label)
    }
  }
  return labels
}

function footnoteSectionFor(
  markdown: string,
  defMap: Map<string, string>,
): string | null {
  const defs = [...defMap.entries()].filter(([label]) => label.startsWith('^'))
  if (defs.length === 0) return null
  const defsText = defs.map(([, text]) => text).join('\n')
  const citations = referenceOccurrences(markdown, defMap)
    .map((label) => `[${label}]`)
    .join(' ')
  // Link definitions that the footnote bodies cite render nothing themselves but are needed so
  // `[text][ref]` inside a footnote becomes a link here too.
  const linkDefs = externalDefsFor(defsText, defMap).text
  return `${citations}\n\n${defsText}\n\n${linkDefs}`
}

/** Plan the chunks for `markdown`, which the caller has already masked for Preview. */
export function planPreviewChunks(
  markdown: string,
  size: number = PREVIEW_STREAM_CHUNK_CHARS,
  firstChunkChars: number = PREVIEW_FIRST_CHUNK_CHARS,
): PreviewPlan {
  const defMap = buildDefMap(markdown)
  const footnoteNumbers = new Map<string, number>()
  for (const label of defMap.keys())
    if (label.startsWith('^'))
      footnoteNumbers.set(label, footnoteNumbers.size + 1)

  const first = chunkize(markdown, Math.min(size, firstChunkChars))[0] ?? ''
  const sources = first
    ? [first, ...chunkize(markdown.slice(first.length), size)]
    : []
  const chunks = sources.map((source) => {
    const own = [...definedIn(source)].filter((label) => label.startsWith('^'))
    const injected = [...externalDefsFor(source, defMap).fnLabels]
    return { source, footnoteOrder: [...own, ...injected] }
  })
  return {
    chunks,
    footnoteNumbers,
    footnoteSection: footnoteSectionFor(markdown, defMap),
  }
}
