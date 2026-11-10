// Task 725 — the `yaml`-dependent half of front-matter editing: the table model with its edit rows
// and the whole-document edit. Imported only by the lazy parser bundle (front-matter-entry.ts) and
// by tests, so the `yaml` package stays out of the eager media/dist/main.js; the eager table and
// edit modules use the types only. Pure: no DOM.
import {
  type FrontMatterParseResult,
  type FrontMatterRow,
  frontMatterYaml,
  parseFrontMatterProperties,
} from '../../../src/shared/front-matter'
import {
  appendFrontMatterPlaceholder,
  editFrontMatterValue,
  type FrontMatterEntry,
  type FrontMatterEntryKind,
  mapFrontMatterEntries,
  moveFrontMatterEntry,
  removeFrontMatterEntry,
  renameFrontMatterKey,
} from '../../../src/shared/front-matter-edit'

/** What one table row needs to be edited. `rows[i]` of the table shows `edit[i]`. */
export interface FrontMatterEditRow {
  index: number
  kind: FrontMatterEntryKind
  duplicate: boolean
  /** The text the name editor opens with (decoded; '' for a placeholder). */
  key: string
  /** The text the value editor opens with: the decoded scalar, or the YAML source of the value. */
  value: string
  /** The value is edited as YAML source in a text box (list, map, multi-line, alias, tag). */
  yaml: boolean
}

type FrontMatterEditableTable = Extract<
  FrontMatterParseResult,
  { status: 'table' }
> & { edit: FrontMatterEditRow[] }

/** A parse result for the table; a table that can be edited byte-exactly carries `edit`. */
export type FrontMatterTableResult =
  | FrontMatterParseResult
  | FrontMatterEditableTable

export type FrontMatterEditOp =
  | { kind: 'value'; index: number; text: string }
  | { kind: 'key'; index: number; text: string }
  | { kind: 'remove'; index: number }
  | { kind: 'move'; index: number; to: number }
  | { kind: 'append' }

/** One row for an entry the whole-text parse cannot show (placeholder or duplicate-key text). */
function entryRow(yamlText: string, entry: FrontMatterEntry): FrontMatterRow {
  // The entry alone, its key replaced by a fixed one, so the value renders as the table does.
  const probe = parseFrontMatterProperties(
    `k${yamlText.slice(entry.keyEnd, entry.end)}`,
  )
  const row = probe.status === 'table' ? probe.rows[0] : undefined
  return {
    key: entry.key,
    keyCopy: entry.key,
    value: row?.value ?? { kind: 'text', text: entry.valueText },
    valueCopy: row?.valueCopy ?? entry.valueText,
  }
}

/**
 * The table for `yamlText`. A text whose top-level entries map to exact source ranges gets edit
 * rows, also when its only errors are empty-key placeholders and duplicate keys (Task 725 D1,
 * D2): those rows then render one by one instead of the malformed-YAML warning. Any other text
 * keeps the read-only result of `parseFrontMatterProperties`.
 */
export function parseFrontMatterTable(
  yamlText: string,
): FrontMatterTableResult {
  const parsed = parseFrontMatterProperties(yamlText)
  const mapped = mapFrontMatterEntries(yamlText)
  if (mapped.status !== 'entries' || mapped.entries.length === 0) return parsed
  const { entries } = mapped
  const rows =
    parsed.status === 'table' && parsed.rows.length === entries.length
      ? parsed.rows
      : entries.map((entry) => entryRow(yamlText, entry))
  return {
    status: 'table',
    rows,
    edit: entries.map((entry) => ({
      index: entry.index,
      kind: entry.kind,
      duplicate: entry.duplicate,
      key: entry.key,
      value: entry.valueText,
      yaml: entry.verbatim,
    })),
  }
}

function moveTo(yamlText: string, index: number, to: number): string | null {
  let text: string | null = yamlText
  let at = index
  while (text !== null && at !== to) {
    const delta = to > at ? 1 : -1
    text = moveFrontMatterEntry(text, at, delta)
    at += delta
  }
  return text
}

function applyOp(yamlText: string, op: FrontMatterEditOp): string | null {
  switch (op.kind) {
    case 'value':
      return editFrontMatterValue(yamlText, op.index, op.text)
    case 'key':
      return renameFrontMatterKey(yamlText, op.index, op.text)
    case 'remove':
      return removeFrontMatterEntry(yamlText, op.index)
    case 'move':
      return moveTo(yamlText, op.index, op.to)
    case 'append':
      return appendFrontMatterPlaceholder(yamlText)
  }
}

/**
 * Applies one table edit to the whole document. The new YAML text replaces exactly the old one
 * between the fences; every other byte of `markdown` stays (Task 725 requirement 1). Null when
 * the document has no closed front matter or the edit does not apply.
 */
export function editFrontMatterDocument(
  markdown: string,
  op: FrontMatterEditOp,
): string | null {
  const yamlText = frontMatterYaml(markdown)
  if (yamlText === null) return null
  // `frontMatterYaml` found the opening fence on the first line; the text starts on the next one.
  const start = markdown.indexOf('\n') + 1
  if (start <= 0 || !markdown.startsWith(yamlText, start)) return null
  const next = applyOp(yamlText, op)
  if (next === null) return null
  const end = start + yamlText.length
  let tail = markdown.slice(end)
  // An empty block (`---` right after `---`) has no line break left for the closing fence.
  if (next !== '' && !/^\r?\n/.test(tail)) {
    tail = (markdown.slice(0, start).endsWith('\r\n') ? '\r\n' : '\n') + tail
  }
  return markdown.slice(0, start) + next + tail
}
