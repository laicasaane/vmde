/** Exact authored reference definition; offsets are UTF-16 indices into Markdown. */
export interface ReferenceDefinition {
  label: string
  normalizedLabel: string
  destination: string
  destinationStart: number
  destinationEnd: number
  angleBracketed: boolean
  title: string | null
  titleStart: number | null
  titleEnd: number | null
  titleDelimiter: '"' | "'" | '(' | null
  start: number
  end: number
}

export type ReferenceEditResult =
  | { status: 'changed'; markdown: string; replacement: string }
  | { status: 'rejected'; reason: string }

interface SourceLine {
  text: string
  start: number
  end: number
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  for (const match of markdown.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/gu)) {
    if (!match[0]) break
    lines.push({
      text: match[1],
      start: match.index,
      end: match.index + match[1].length,
    })
    if (!match[2]) break
  }
  return lines
}

/** Pinned Lute keeps source backslashes in reference keys while folding case and whitespace. */
export function normalizeReferenceLabel(label: string): string | null {
  const normalized = label
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replace(/ς/gu, 'σ')
  return normalized && normalized.length <= 999 ? normalized : null
}

function labelEnd(text: string, start: number): number | null {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === '[') return null
    if (text[index] === ']') return index
  }
  return null
}

function skipSpaces(text: string, start: number): number {
  let index = start
  while (text[index] === ' ' || text[index] === '\t') index++
  return index
}

function angleDestinationEnd(text: string, start: number): number | null {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === '<') return null
    if (text[index] === '>') return index
  }
  return null
}

function bareDestinationEnd(text: string, start: number): number | null {
  let index = start
  while (index < text.length && text[index] !== ' ' && text[index] !== '\t') {
    if (text[index] === '\\') {
      if (index + 1 >= text.length) return null
      index += 2
      continue
    }
    if (text[index] === '<' || text[index] === '>' || text[index] === ')')
      return null
    index++
  }
  // Pinned Lute accepts an unmatched bare opener but rejects a bare closer,
  // even when balanced. Angle brackets or escaping preserve both parentheses.
  return index > start ? index : null
}

function titleEnd(text: string, start: number): number | null {
  const opener = text[start]
  if (opener !== '"' && opener !== "'" && opener !== '(') return null
  const closer = opener === '(' ? ')' : opener
  let depth = 1
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (opener === '(' && text[index] === '(') depth++
    else if (text[index] === closer && --depth === 0) return index + 1
  }
  return null
}

function definitionAt(line: SourceLine): ReferenceDefinition | null {
  const text = line.text
  const indentation = /^ {0,3}/u.exec(text)![0].length
  if (text[indentation] !== '[') return null
  const close = labelEnd(text, indentation)
  if (close === null || text[close + 1] !== ':') return null
  const label = text.slice(indentation + 1, close)
  const normalizedLabel = normalizeReferenceLabel(label)
  if (!normalizedLabel) return null
  let cursor = skipSpaces(text, close + 2)
  const angleBracketed = text[cursor] === '<'
  const destinationStart = cursor + (angleBracketed ? 1 : 0)
  const stop = angleBracketed
    ? angleDestinationEnd(text, cursor)
    : bareDestinationEnd(text, cursor)
  if (stop === null || stop === destinationStart) return null
  const destination = text.slice(destinationStart, stop)
  const destinationSyntaxEnd = stop + (angleBracketed ? 1 : 0)
  cursor = skipSpaces(text, destinationSyntaxEnd)
  if (cursor === destinationSyntaxEnd && cursor < text.length) return null
  let title: string | null = null
  let titleStart: number | null = null
  let titleEndOffset: number | null = null
  let titleDelimiter: ReferenceDefinition['titleDelimiter'] = null
  if (cursor < text.length) {
    const endTitle = titleEnd(text, cursor)
    if (endTitle === null || skipSpaces(text, endTitle) !== text.length)
      return null
    title = text.slice(cursor, endTitle)
    titleStart = line.start + cursor
    titleEndOffset = line.start + endTitle
    titleDelimiter = text[cursor] as ReferenceDefinition['titleDelimiter']
  }
  return {
    label,
    normalizedLabel,
    destination,
    destinationStart: line.start + destinationStart,
    destinationEnd: line.start + stop,
    angleBracketed,
    title,
    titleStart,
    titleEnd: titleEndOffset,
    titleDelimiter,
    start: line.start,
    end: line.end,
  }
}

interface Protection {
  fence: { character: string; length: number } | null
  frontMatter: boolean
  comment: boolean
  html: boolean
  math: boolean
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: each active Markdown block state must be checked before admitting a definition line.
function protectedLine(
  state: Protection,
  line: string,
  first: boolean,
): boolean {
  const text = line.trim()
  if (state.frontMatter) {
    if (text === '---') state.frontMatter = false
    return true
  }
  if (first && text === '---') {
    state.frontMatter = true
    return true
  }
  if (state.comment) {
    if (text.includes('-->')) state.comment = false
    return true
  }
  if (state.html) {
    if (!text) state.html = false
    return true
  }
  if (state.math) {
    if (text === '$$') state.math = false
    return true
  }
  if (state.fence) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1]
    if (
      close &&
      close[0] === state.fence.character &&
      close.length >= state.fence.length
    )
      state.fence = null
    return true
  }
  const open = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
  if (open) {
    state.fence = { character: open[0], length: open.length }
    return true
  }
  if (text.startsWith('<!--')) {
    state.comment = !text.includes('-->')
    return true
  }
  if (text === '$$') {
    state.math = true
    return true
  }
  if (
    /^ {0,3}<(?:div|table|script|pre|style|details|section|article)(?:\s|>)/iu.test(
      line,
    )
  ) {
    state.html = true
    return true
  }
  return false
}

/** Source-order candidates; exact winner lookup uses the first normalized label. */
export function indexReferenceDefinitions(
  markdown: string,
): ReferenceDefinition[] {
  const state: Protection = {
    fence: null,
    frontMatter: false,
    comment: false,
    html: false,
    math: false,
  }
  const definitions: ReferenceDefinition[] = []
  let paragraphOpen = false
  const lines = sourceLines(markdown)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (protectedLine(state, line.text, index === 0)) {
      paragraphOpen = false
      continue
    }
    if (!line.text.trim()) {
      paragraphOpen = false
      continue
    }
    if (/^(?: {4}|\t)/u.test(line.text) || /^ {0,3}\[\^/u.test(line.text)) {
      // Lute owns footnote definitions separately; their continuation may
      // consume following lines until a blank boundary.
      paragraphOpen = true
      continue
    }
    const definition = paragraphOpen ? null : definitionAt(line)
    if (definition) {
      definitions.push(definition)
      paragraphOpen = false
      continue
    }
    // An ATX heading closes on its own physical line, so Lute can start a
    // definition immediately afterward without an intervening blank line.
    paragraphOpen = !/^ {0,3}#{1,6}(?:[ \t]|$)/u.test(line.text)
  }
  return definitions
}

export function resolveReferenceDefinition(
  markdown: string,
  label: string,
): ReferenceDefinition | null {
  const wanted = normalizeReferenceLabel(label)
  return wanted
    ? (indexReferenceDefinitions(markdown).find(
        (definition) => definition.normalizedLabel === wanted,
      ) ?? null)
    : null
}

function validReplacement(
  destination: string,
  angleBracketed: boolean,
): boolean {
  if (!destination || destination !== destination.trim()) return false
  if (Array.from(destination).some((char) => char.charCodeAt(0) < 32))
    return false
  return angleBracketed
    ? !/[<>]/u.test(destination)
    : !/["']/u.test(destination) &&
        bareDestinationEnd(destination, 0) === destination.length
}

/** Replace only the source-proven winning destination; other uses and bytes stay exact. */
export function planReferenceDefinitionEdit(
  markdown: string,
  target: { label: string; start: number; end: number },
  destination: string,
): ReferenceEditResult {
  if (
    !Number.isSafeInteger(target.start) ||
    !Number.isSafeInteger(target.end) ||
    target.start < 0 ||
    target.end <= target.start ||
    target.end > markdown.length
  )
    return { status: 'rejected', reason: 'invalid-span' }
  const winner = resolveReferenceDefinition(markdown, target.label)
  if (
    !winner ||
    winner.destinationStart !== target.start ||
    winner.destinationEnd !== target.end
  )
    return { status: 'rejected', reason: 'stale-or-nonwinning-definition' }
  if (!validReplacement(destination, winner.angleBracketed))
    return { status: 'rejected', reason: 'invalid-destination' }
  if (destination === winner.destination)
    return { status: 'rejected', reason: 'unchanged-destination' }
  return {
    status: 'changed',
    replacement: destination,
    markdown:
      markdown.slice(0, winner.destinationStart) +
      destination +
      markdown.slice(winner.destinationEnd),
  }
}
