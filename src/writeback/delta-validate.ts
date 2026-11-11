// Task 733 — host-side validation of an `edit-delta` message, before any document write (SR-1).
//
// Pure and dependency-free. The caller passes the shape-checked message; this module checks every
// field itself because the wire gives no type guarantee. It accepts no field that names a document:
// a delta addresses only the document of the session that receives it.
//
// Performance (SR-6): the document is read only through `lineText`, and only for the lines the
// ranges name (each at most once). No per-character allocation, no regular expression over a text.

export interface DeltaDocument {
  readonly lineCount: number
  /** The text of a line without its line break. */
  lineText(line: number): string
}

export type DeltaRefusal =
  | 'not-integer'
  | 'empty'
  | 'too-many-changes'
  | 'too-long'
  | 'change-shape'
  | 'range'
  | 'order'
  | 'surrogate-edge'
  | 'noop-change'

interface DeltaPosition {
  line: number
  character: number
}

export interface ValidDeltaChange {
  start: DeltaPosition
  end: DeltaPosition
  oldText: string
  text: string
}

export type DeltaValidation =
  | { ok: true; changes: ValidDeltaChange[] }
  | { ok: false; refusal: DeltaRefusal }

const MAX_CHANGES = 256
const MAX_TOTAL_LENGTH = 4_000_000

const fail = (refusal: DeltaRefusal): DeltaValidation => ({
  ok: false,
  refusal,
})

function isPosition(value: unknown): value is DeltaPosition {
  if (typeof value !== 'object' || value === null) return false
  const { line, character } = value as Record<string, unknown>
  return Number.isSafeInteger(line) && Number.isSafeInteger(character)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isNonNegativeInteger(value: unknown, min: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min
}

function isChangeShape(raw: unknown): raw is ValidDeltaChange {
  if (typeof raw !== 'object' || raw === null) return false
  const c = raw as Record<string, unknown>
  return (
    isPosition(c.start) &&
    isPosition(c.end) &&
    typeof c.oldText === 'string' &&
    typeof c.text === 'string' &&
    !c.oldText.includes('\r') &&
    !c.text.includes('\r')
  )
}

const before = (a: DeltaPosition, b: DeltaPosition): boolean =>
  a.line < b.line || (a.line === b.line && a.character < b.character)

/** Shape of every change and the total text length: a refusal, or null. */
function checkShapesAndLength(changes: unknown[]): DeltaRefusal | null {
  let total = 0
  for (const raw of changes) {
    if (!isChangeShape(raw)) return 'change-shape'
    total += raw.oldText.length + raw.text.length
  }
  return total > MAX_TOTAL_LENGTH ? 'too-long' : null
}

/** Reads a line at most once, and only when a range names it. */
function createLineReader(doc: DeltaDocument) {
  const cache = new Map<number, string>()
  return (line: number): string => {
    let text = cache.get(line)
    if (text === undefined) {
      text = doc.lineText(line)
      cache.set(line, text)
    }
    return text
  }
}

function checkRanges(
  changes: ValidDeltaChange[],
  doc: DeltaDocument,
  lineOf: (line: number) => string,
): DeltaRefusal | null {
  const inside = (p: DeltaPosition): boolean =>
    p.line >= 0 &&
    p.line < doc.lineCount &&
    p.character >= 0 &&
    p.character <= lineOf(p.line).length
  for (const { start, end } of changes) {
    if (!inside(start) || !inside(end) || before(end, start)) return 'range'
  }
  return null
}

function isEmpty(c: ValidDeltaChange): boolean {
  return !before(c.start, c.end)
}

function checkOrder(changes: ValidDeltaChange[]): DeltaRefusal | null {
  for (let i = 1; i < changes.length; i++) {
    const prev = changes[i - 1]
    if (before(changes[i].start, prev.end)) return 'order'
    // Two insertions at one point: their order is not defined across splice and VS Code.
    if (
      isEmpty(prev) &&
      isEmpty(changes[i]) &&
      !before(prev.end, changes[i].start)
    )
      return 'order'
  }
  return null
}

function splitsSurrogatePair(text: string, character: number): boolean {
  return (
    character > 0 &&
    character < text.length &&
    isHighSurrogate(text.charCodeAt(character - 1)) &&
    isLowSurrogate(text.charCodeAt(character))
  )
}

function checkSurrogateEdges(
  changes: ValidDeltaChange[],
  lineOf: (line: number) => string,
): DeltaRefusal | null {
  for (const { start, end } of changes) {
    if (
      splitsSurrogatePair(lineOf(start.line), start.character) ||
      splitsSurrogatePair(lineOf(end.line), end.character)
    ) {
      return 'surrogate-edge'
    }
  }
  return null
}

export function validateDelta(
  message: { epoch: unknown; sequence: unknown; changes: unknown[] },
  doc: DeltaDocument,
): DeltaValidation {
  const { epoch, sequence, changes } = message
  if (!isNonNegativeInteger(epoch, 0) || !isNonNegativeInteger(sequence, 1)) {
    return fail('not-integer')
  }
  if (!Array.isArray(changes) || changes.length === 0) return fail('empty')
  if (changes.length > MAX_CHANGES) return fail('too-many-changes')
  const shapeRefusal = checkShapesAndLength(changes)
  if (shapeRefusal) return fail(shapeRefusal)

  // Copies only the four known fields: nothing else the sender attached is carried on.
  const valid = (changes as ValidDeltaChange[]).map((c) => ({
    start: { line: c.start.line, character: c.start.character },
    end: { line: c.end.line, character: c.end.character },
    oldText: c.oldText,
    text: c.text,
  }))
  const lineOf = createLineReader(doc)
  const refusal =
    checkRanges(valid, doc, lineOf) ??
    checkOrder(valid) ??
    checkSurrogateEdges(valid, lineOf) ??
    (valid.some((c) => c.oldText === c.text) ? 'noop-change' : null)
  return refusal ? fail(refusal) : { ok: true, changes: valid }
}
