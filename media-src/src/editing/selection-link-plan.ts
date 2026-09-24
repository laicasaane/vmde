import { wikiTargetFromSelection } from './selection-bubble-state'

export type SelectedLinkKind = 'link' | 'wiki'
export type SelectedLinkPlan =
  | {
      status: 'changed'
      markdown: string
      insertion: string
      caretOffset: number
    }
  | { status: 'rejected'; reason: string }

function selectionError(
  markdown: string,
  start: number,
  end: number,
  selected: string,
): string | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end > markdown.length ||
    start >= end ||
    markdown.slice(start, end) !== selected
  )
    return 'stale-selection'
  if (
    (markdown[start - 1] === '[' &&
      markdown[end] === ']' &&
      markdown[end + 1] === '(') ||
    (markdown.slice(start - 2, start) === '[[' &&
      markdown.slice(end, end + 2) === ']]')
  )
    return 'existing-link-label'
  if (markdown[start - 1] === '`' && markdown[end] === '`')
    return 'inside-inline-code'
  if (
    /[\r\n]/u.test(selected) ||
    Array.from(selected).some((char) => char.charCodeAt(0) < 32)
  )
    return 'multiline-or-control'
  return null
}

function markdownLinkInsertion(
  markdown: string,
  start: number,
  end: number,
  selected: string,
): string {
  const label = selected
    .replace(/\\/gu, '\\\\')
    .replace(/\[/gu, '\\[')
    .replace(/\]/gu, '\\]')
  const previous = start > 0 ? markdown[start - 1] : ''
  const insideFormatting = /[*_~]/u.test(previous) && markdown[end] === previous
  // The pinned toolbar adds a separator next to ordinary prose. At an existing
  // emphasis/strike marker it would add visible whitespace inside the mark.
  const leadingSpace =
    previous && !/\s/u.test(previous) && !insideFormatting ? ' ' : ''
  return `${leadingSpace}[${label}]()`
}

/** Derive one exact source replacement from a retained visual selection. */
export function planSelectedLink(
  markdown: string,
  start: number,
  end: number,
  selected: string,
  kind: SelectedLinkKind,
): SelectedLinkPlan {
  const error = selectionError(markdown, start, end, selected)
  if (error) return { status: 'rejected', reason: error }
  if (kind === 'wiki' && wikiTargetFromSelection(selected) === null)
    return { status: 'rejected', reason: 'unsafe-wiki-target' }
  if (kind === 'link' && selected.length > 256)
    return { status: 'rejected', reason: 'long-link-label' }
  const insertion =
    kind === 'wiki'
      ? `[[${selected}]]`
      : markdownLinkInsertion(markdown, start, end, selected)
  return {
    status: 'changed',
    markdown: markdown.slice(0, start) + insertion + markdown.slice(end),
    insertion,
    caretOffset: start + insertion.length - (kind === 'link' ? 1 : 0),
  }
}

/** Conservative fallback when Vditor strips marker nodes while serializing an edited ATX heading. */
export function uniqueAtxHeadingTextRange(
  markdown: string,
  selected: string,
  level: number,
): { startOffset: number; endOffset: number } | null {
  if (!selected || /[\r\n]/u.test(selected) || level < 1 || level > 6)
    return null
  const startOffset = markdown.indexOf(selected)
  if (startOffset < 0 || markdown.lastIndexOf(selected) !== startOffset)
    return null
  const lineStart = markdown.lastIndexOf('\n', startOffset - 1) + 1
  const lineBreak = markdown.indexOf('\n', startOffset)
  const lineEnd = lineBreak < 0 ? markdown.length : lineBreak
  const line = markdown.slice(lineStart, lineEnd).replace(/\r$/u, '')
  const marker = /^( {0,3})(#{1,6})[ \t]+/u.exec(line)
  if (!marker || marker[2].length !== level) return null
  const endOffset = startOffset + selected.length
  if (
    startOffset < lineStart + marker[0].length ||
    endOffset > lineStart + line.length
  )
    return null
  return { startOffset, endOffset }
}
