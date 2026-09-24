export type LinkPopoverTargetKind = 'link' | 'image'

export interface LinkPopoverDestinationSpan {
  start: number
  end: number
  kind: LinkPopoverTargetKind
}

export type LinkPopoverAction =
  | { kind: 'edit'; destination: string }
  | { kind: 'unlink' }

export type LinkPopoverPlan =
  | {
      status: 'changed'
      markdown: string
      target: LinkPopoverTargetKind
      destination: string
      sourceReplacement: string
    }
  | { status: 'rejected'; reason: string }

interface InlineTarget {
  kind: LinkPopoverTargetKind
  syntaxStart: number
  syntaxEnd: number
  labelStart: number
  labelEnd: number
  destinationStart: number
  destinationEnd: number
  destination: string
  angleBracketed: boolean
}

interface FenceRange {
  start: number
  end: number
}

function isEscaped(markdown: string, offset: number): boolean {
  let count = 0
  for (let index = offset - 1; index >= 0 && markdown[index] === '\\'; index--)
    count++
  return count % 2 === 1
}

function lineFence(
  line: string,
): { character: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  if (!match) return null
  if (match[1][0] === '`' && line.slice(match[0].length).includes('`'))
    return null
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
  }
}

function fenceRanges(markdown: string): FenceRange[] {
  const ranges: FenceRange[] = []
  let open: (FenceRange & { character: '`' | '~'; length: number }) | null =
    null
  let start = 0
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start)
    const next = newline < 0 ? markdown.length : newline + 1
    let lineEnd = newline < 0 ? markdown.length : newline
    if (lineEnd > start && markdown[lineEnd - 1] === '\r') lineEnd--
    const fence = lineFence(markdown.slice(start, lineEnd))
    if (!open && fence) {
      open = { start, end: markdown.length, ...fence }
    } else if (
      open &&
      fence?.character === open.character &&
      fence.length >= open.length
    ) {
      ranges.push({ start: open.start, end: next })
      open = null
    }
    start = next
  }
  if (open) ranges.push({ start: open.start, end: open.end })
  return ranges
}

function backtickRun(markdown: string, start: number): number {
  let end = start
  while (markdown[end] === '`') end++
  return end - start
}

function skipCodeSpan(markdown: string, start: number): number | null {
  const run = backtickRun(markdown, start)
  for (let index = start + run; index < markdown.length; ) {
    if (markdown[index] !== '`') {
      index++
      continue
    }
    const nextRun = backtickRun(markdown, index)
    if (nextRun === run) return index + nextRun
    index += nextRun
  }
  return null
}

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

function htmlCommentEnd(markdown: string, start: number): number {
  const end = markdown.indexOf('-->', start + 4)
  return end < 0 ? markdown.length : end + 3
}

function htmlTagAt(markdown: string, start: number): RegExpExecArray | null {
  return /^<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/u.exec(markdown.slice(start))
}

function htmlTagEnd(
  markdown: string,
  start: number,
  prefixLength: number,
): number {
  let quote = ''
  for (let index = start + prefixLength; index < markdown.length; index++) {
    const char = markdown[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index + 1
    }
  }
  return markdown.length
}

function htmlClosingTagEnd(
  markdown: string,
  tagName: string,
  start: number,
): number {
  const closing = new RegExp(`<\\/\\s*${tagName}\\s*>`, 'iu').exec(
    markdown.slice(start),
  )
  return closing ? start + closing.index + closing[0].length : markdown.length
}

function htmlSpanEnd(markdown: string, start: number): number | null {
  if (markdown.startsWith('<!--', start)) return htmlCommentEnd(markdown, start)
  const tag = htmlTagAt(markdown, start)
  if (!tag) {
    const end = markdown.indexOf('>', start + 1)
    return end < 0 ? null : end + 1
  }
  const end = htmlTagEnd(markdown, start, tag[0].length)
  const closingTag = tag[0][1] === '/'
  const selfClosing = /\/$/u.test(markdown.slice(start, end - 1))
  if (closingTag || selfClosing || HTML_VOID_ELEMENTS.has(tag[1].toLowerCase()))
    return end
  return htmlClosingTagEnd(markdown, tag[1], end)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bracket depth and backslash parity must be tracked together to reject malformed labels.
function bracketEnd(markdown: string, start: number): number | null {
  let depth = 0
  for (let index = start; index < markdown.length; index++) {
    const char = markdown[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === '\r' || char === '\n') return null
    if (char === '[') depth++
    else if (char === ']') {
      depth--
      if (depth === 0) return index
      if (depth < 0) return null
    }
  }
  return null
}

function skipWhitespace(markdown: string, start: number): number {
  let index = start
  while (index < markdown.length && /[\t\r\n ]/u.test(markdown[index])) index++
  return index
}

function angleDestinationEnd(markdown: string, start: number): number | null {
  for (let index = start + 1; index < markdown.length; index++) {
    if (markdown[index] === '\r' || markdown[index] === '\n') return null
    if (markdown[index] === '>' && !isEscaped(markdown, index))
      return index > start + 1 ? index : null
  }
  return null
}

interface DestinationStep {
  end: number
  depth: number
  stop: boolean
}

function bareDestinationStep(
  markdown: string,
  index: number,
  depth: number,
): DestinationStep | null {
  const char = markdown[index]
  if (char === '\\')
    return index + 1 < markdown.length
      ? { end: index + 2, depth, stop: false }
      : null
  if (char === '\r' || char === '\n' || char === '<') return null
  if (/[\t ]/u.test(char))
    return depth === 0 ? { end: index, depth, stop: true } : null
  if (char === ')')
    return depth === 0
      ? { end: index, depth, stop: true }
      : { end: index + 1, depth: depth - 1, stop: false }
  return {
    end: index + 1,
    depth: char === '(' ? depth + 1 : depth,
    stop: false,
  }
}

function bareDestinationEnd(markdown: string, start: number): number | null {
  let depth = 0
  let end = start
  for (let index = start; index < markdown.length; ) {
    const step = bareDestinationStep(markdown, index, depth)
    if (!step) return null
    if (step.stop) break
    depth = step.depth
    end = step.end
    index = step.end
  }
  return end > start && depth === 0 ? end : null
}

function destinationEnd(markdown: string, start: number): number | null {
  return markdown[start] === '<'
    ? angleDestinationEnd(markdown, start)
    : bareDestinationEnd(markdown, start)
}

function quotedTitleEnd(
  markdown: string,
  start: number,
  quote: '"' | "'",
): number | null {
  for (let index = start + 1; index < markdown.length; index++) {
    if (markdown[index] === '\\\\') {
      index++
      continue
    }
    if (markdown[index] === '\\r' || markdown[index] === '\\n') return null
    if (markdown[index] === quote) return index + 1
  }
  return null
}

function parenthesizedTitleEnd(markdown: string, start: number): number | null {
  let depth = 1
  for (let index = start + 1; index < markdown.length; index++) {
    const char = markdown[index]
    if (char === '\\\\') {
      index++
      continue
    }
    if (char === '\\r' || char === '\\n') return null
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index + 1
  }
  return null
}

function titleEnd(markdown: string, start: number): number | null {
  const opener = markdown[start]
  if (opener === '(') return parenthesizedTitleEnd(markdown, start)
  if (opener === '"' || opener === "'")
    return quotedTitleEnd(markdown, start, opener)
  return null
}

function targetAt(markdown: string, labelStart: number): InlineTarget | null {
  const kind: LinkPopoverTargetKind =
    labelStart > 0 &&
    markdown[labelStart - 1] === '!' &&
    !isEscaped(markdown, labelStart - 1)
      ? 'image'
      : 'link'
  const close = bracketEnd(markdown, labelStart)
  if (close === null || markdown[close + 1] !== '(') return null
  let cursor = skipWhitespace(markdown, close + 2)
  const angleBracketed = markdown[cursor] === '<'
  const destinationStart = cursor + (angleBracketed ? 1 : 0)
  const destinationStop = destinationEnd(markdown, cursor)
  if (destinationStop === null) return null
  const destinationFinish = destinationStop
  cursor = destinationStop + (angleBracketed ? 1 : 0)
  cursor = skipWhitespace(markdown, cursor)
  if (markdown[cursor] !== ')') {
    const endTitle = titleEnd(markdown, cursor)
    if (endTitle === null) return null
    cursor = skipWhitespace(markdown, endTitle)
  }
  if (markdown[cursor] !== ')') return null
  return {
    kind,
    syntaxStart: kind === 'image' ? labelStart - 1 : labelStart,
    syntaxEnd: cursor + 1,
    labelStart: labelStart + 1,
    labelEnd: close,
    destinationStart,
    destinationEnd: destinationFinish,
    destination: markdown.slice(destinationStart, destinationFinish),
    angleBracketed,
  }
}

function skipWikiLink(markdown: string, start: number): number {
  const wikiEnd = markdown.indexOf(']]', start + 2)
  return wikiEnd < 0 ? markdown.length : wikiEnd + 2
}

function skippedInlineRegion(markdown: string, start: number): number | null {
  if (markdown[start] === '`') {
    const end = skipCodeSpan(markdown, start)
    return end ?? start + backtickRun(markdown, start)
  }
  if (markdown[start] === '<') return htmlSpanEnd(markdown, start)
  return null
}

function inlineTargets(markdown: string): InlineTarget[] {
  const targets: InlineTarget[] = []
  const fences = fenceRanges(markdown)
  let fenceIndex = 0
  let index = 0
  while (index < markdown.length) {
    const fence = fences[fenceIndex]
    if (fence && index >= fence.start) {
      index = fence.end
      fenceIndex++
      continue
    }
    const skip = skippedInlineRegion(markdown, index)
    if (skip !== null) {
      index = skip
      continue
    }
    if (markdown[index] !== '[' || isEscaped(markdown, index)) {
      index++
      continue
    }
    if (markdown[index + 1] === '[') {
      index = skipWikiLink(markdown, index)
      continue
    }
    const target = targetAt(markdown, index)
    if (target) {
      targets.push(target)
      index = target.syntaxEnd
    } else {
      index++
    }
  }
  return targets
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function encodeDestination(
  destination: string,
  angleBracketed: boolean,
): string | null {
  const value = destination.trim()
  if (!value || hasControlCharacters(value) || value !== destination.trim())
    return null
  if (angleBracketed) return /[<>]/u.test(value) ? null : value
  if (/[\s<>]/u.test(value)) return null
  let depth = 0
  let encoded = ''
  for (const char of value) {
    if (char === '(') depth++
    else if (char === ')') {
      if (depth === 0) {
        encoded += '\\)'
        continue
      }
      depth--
    }
    encoded += char
  }
  if (depth > 0) {
    let remaining = depth
    encoded = [...encoded]
      .reverse()
      .map((char) => {
        if (char === '(' && remaining > 0) {
          remaining--
          return '\\('
        }
        return char
      })
      .reverse()
      .join('')
  }
  return encoded
}

/** Apply one edit to the exact inline-link/image destination proven by a DOM-mapped source span. */
export function planLinkPopoverAction(
  markdown: string,
  span: LinkPopoverDestinationSpan,
  action: LinkPopoverAction,
): LinkPopoverPlan {
  if (
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 0 ||
    span.end <= span.start ||
    span.end > markdown.length
  )
    return { status: 'rejected', reason: 'stale-destination' }
  const matches = inlineTargets(markdown).filter(
    (target) =>
      target.destinationStart === span.start &&
      target.destinationEnd === span.end &&
      target.kind === span.kind,
  )
  if (matches.length !== 1)
    return {
      status: 'rejected',
      reason: matches.length
        ? 'ambiguous-destination'
        : 'unsupported-destination',
    }
  const target = matches[0]
  if (action.kind === 'edit') {
    const replacement = encodeDestination(
      action.destination,
      target.angleBracketed,
    )
    if (replacement === null)
      return { status: 'rejected', reason: 'invalid-destination' }
    if (replacement === target.destination)
      return { status: 'rejected', reason: 'unchanged-destination' }
    return {
      status: 'changed',
      markdown:
        markdown.slice(0, target.destinationStart) +
        replacement +
        markdown.slice(target.destinationEnd),
      target: target.kind,
      destination: action.destination.trim(),
      sourceReplacement: replacement,
    }
  }
  const replacement = markdown.slice(target.labelStart, target.labelEnd)
  return {
    status: 'changed',
    markdown:
      markdown.slice(0, target.syntaxStart) +
      replacement +
      markdown.slice(target.syntaxEnd),
    target: target.kind,
    destination: target.destination,
    sourceReplacement: replacement,
  }
}
