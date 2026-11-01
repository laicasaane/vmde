// Task 643 — Find in full Preview. Preview has no edit view and no source index, and Find there
// searches what the reader sees: the rendered document's text, not Markdown bytes. The text of the
// Preview pane is collected once per search, matched with the same literal engine as the edit modes,
// and each match is mapped back to a DOM range for the highlight painter.
import { engineLangs } from '../diagram-kit/engine-registry'
import type { FindMapper, VisibleBox } from './find-map'
import type { MarkdownMatch } from './find-engine'

interface PreviewTextSegment {
  node: Text
  /** Offsets of this node's text within the collected string. */
  start: number
  end: number
}

export interface PreviewTextSnapshot {
  text: string
  nodes: PreviewTextSegment[]
}

// Rendered diagrams, the hidden MathML copy KaTeX emits beside its visible output, code copy
// buttons, anything marked hidden, and a heavy block that has not been rendered yet (its text is
// the diagram source, which is not what the reader will see).
const SKIPPED =
  'svg, .katex-mathml, .vditor-copy, [hidden], [aria-hidden="true"]'

// Source text that a held-back block shows until its renderer replaces it: diagram and math source.
// A held-back code block is ordinary visible text and stays searchable.
const PENDING = '[data-vmde-preview-pending]'
const RAW_SOURCE = [
  '.language-math',
  ...engineLangs((engine) => engine.diagram).map((lang) => `.language-${lang}`),
].join(', ')

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
])

function isSkipped(element: HTMLElement): boolean {
  return (
    element.matches(SKIPPED) ||
    element.style.display === 'none' ||
    (element.matches(RAW_SOURCE) && element.closest(PENDING) !== null)
  )
}

/** The rendered text of `root`. A newline separates blocks and line breaks, so a single-line query
 *  never matches across them; matches may still cross inline elements such as bold or links. */
export function collectPreviewText(root: HTMLElement): PreviewTextSnapshot {
  let text = ''
  const nodes: PreviewTextSegment[] = []
  const breakLine = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data
      nodes.push({
        node: node as Text,
        start: text.length,
        end: text.length + data.length,
      })
      text += data
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (isSkipped(node)) return
    if (node.tagName === 'BR') {
      breakLine()
      return
    }
    const block = BLOCK_TAGS.has(node.tagName)
    if (block) breakLine()
    for (const child of Array.from(node.childNodes)) visit(child)
    if (block) breakLine()
  }
  for (const child of Array.from(root.childNodes)) visit(child)
  return { text, nodes }
}

// Index of the segment holding `offset`: the first whose end is past it.
function segmentAt(nodes: readonly PreviewTextSegment[], offset: number) {
  let low = 0
  let high = nodes.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (nodes[middle].end > offset) high = middle
    else low = middle + 1
  }
  return low
}

export function createPreviewFindMapper(
  snapshot: PreviewTextSnapshot,
): FindMapper {
  const range = (match: MarkdownMatch): Range | null => {
    const { nodes } = snapshot
    if (nodes.length === 0 || match.end <= match.start) return null
    const first = nodes[segmentAt(nodes, match.start)]
    const last = nodes[segmentAt(nodes, match.end - 1)]
    if (!first?.node.isConnected || !last?.node.isConnected) return null
    if (match.start < first.start || match.end > last.end) return null
    const result = document.createRange()
    result.setStart(first.node, match.start - first.start)
    result.setEnd(last.node, match.end - last.start)
    return result
  }
  return {
    range,
    visible(matches, box: VisibleBox, margin) {
      const rectOf = (index: number) =>
        range(matches[index])?.getBoundingClientRect()
      // Matches are in document order, which is vertical order: binary-search the first one that
      // ends below the top of the window, then take every one that starts above its bottom.
      let low = 0
      let high = matches.length
      while (low < high) {
        const middle = (low + high) >> 1
        const rect = rectOf(middle)
        if (rect && rect.bottom >= box.top - margin) high = middle
        else low = middle + 1
      }
      const visible: number[] = []
      for (let index = low; index < matches.length; index++) {
        const rect = rectOf(index)
        if (!rect) continue
        if (rect.top > box.bottom + margin) break
        visible.push(index)
      }
      return visible
    },
  }
}

/** The Preview pane while it is the whole view: shown, with the active edit pane hidden. Split keeps
 *  its source pane visible beside the preview and so is not this surface. */
export function fullPreviewRoot(vditor: unknown): HTMLElement | null {
  const inner = (vditor as { vditor?: any } | undefined)?.vditor
  const preview = inner?.preview
  if (!inner || preview?.element?.style.display !== 'block') return null
  const mode = inner.currentMode as string
  const edit = inner[mode]?.element as HTMLElement | undefined
  if (!edit) return null
  const hidden =
    mode === 'sv'
      ? edit.style.display === 'none'
      : edit.parentElement?.style.display === 'none'
  return hidden
    ? ((preview.previewElement as HTMLElement | undefined) ?? null)
    : null
}
