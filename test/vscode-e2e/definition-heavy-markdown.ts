// Synthetic fixture for Task 733 / 017: the table-heavy fixture plus link reference definitions,
// footnotes and a table of contents, so the definition units, their dependents and the counted
// budget tests run on one document. Pure and deterministic (no random source, no date). It holds a
// mid-document definition and tail definitions (one titled), references in a paragraph, a list item
// and a table cell, two footnote runs separated by a paragraph, and a `[toc]` line after the front
// matter (a table of contents only when the ToC option is on).
import { tableHeavyMarkdown } from './table-heavy-markdown'

/** The definition, footnote and TOC lines the fixture adds, in document order. */
export const DEFINITION_LINES = {
  toc: '[toc]',
  guide: '[guide]: https://example.com/guide',
  spec: '[spec]: https://example.com/spec "Spec title"',
  note: '[^note]: The first note.',
  two: '[^two]: The second note.',
  three: '[^three]: The third note.',
} as const

/** Paragraph texts the fixture adds or rewrites; each one references a definition or a footnote. */
export const REFERENCE_TEXTS = {
  first:
    'First paragraph of the synthetic document, with a few words of plain text. See [the guide][guide] and a note[^note].',
  item: '- list item 1 with [spec]',
  cell: '| see [spec] |',
  closing: 'Closing paragraph cites [^two] and [^three].',
  between: 'A paragraph between the footnote runs.',
} as const

function replaceOnce(text: string, find: string | RegExp, by: string): string {
  const next = text.replace(find, by)
  if (next === text)
    throw new Error(`definition fixture: anchor not found: ${String(find)}`)
  return next
}

/** `tableHeavyMarkdown(factor)` with the definitions, footnotes and the TOC line of this fixture. */
export function definitionHeavyMarkdown(factor: 1 | 4 | 16): string {
  let text = tableHeavyMarkdown(factor)
  text = replaceOnce(
    text,
    '\n\n# Overview',
    `\n\n${DEFINITION_LINES.toc}\n\n# Overview`,
  )
  text = replaceOnce(
    text,
    'First paragraph of the synthetic document, with a few words of plain text.',
    REFERENCE_TEXTS.first,
  )
  text = replaceOnce(
    text,
    /(Second paragraph, a little longer than the first one, still plain prose\.)/u,
    `$1\n\n${DEFINITION_LINES.guide}`,
  )
  text = replaceOnce(text, /^- list item 1$/mu, REFERENCE_TEXTS.item)
  text = replaceOnce(text, '| text 2 |', REFERENCE_TEXTS.cell)
  const tail = [
    REFERENCE_TEXTS.closing,
    DEFINITION_LINES.spec,
    `${DEFINITION_LINES.note}\n\n${DEFINITION_LINES.two}`,
    REFERENCE_TEXTS.between,
    DEFINITION_LINES.three,
  ]
  return `${text}\n${tail.join('\n\n')}\n`
}
