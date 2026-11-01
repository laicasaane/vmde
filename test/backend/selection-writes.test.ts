import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Task 664 guard: the caret authority (`editing/caret.ts`) tells a deliberate VMDE selection write
// from Vditor undo and spin churn only when the write goes through `writeSelection` or
// `writeSelectionKeepingIntent`. A raw Selection write anywhere else in the webview source would be
// treated as churn and overwritten while a caret intent is live, so this test fails on any such call.
// It is a text check because the installed TypeScript has no JavaScript compiler API to resolve
// receiver types. `Range.collapse(toStart)` takes one argument and is not a Selection write; the
// two-argument `Selection.collapse(node, offset)` is.

const WEBVIEW_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../media-src/src',
)

// caret.ts places its own intents; util/selection-write.ts holds the marked writes; gap-nav-fixture.ts
// is a test fixture imported only by unit tests.
const ALLOWED = new Set([
  'editing/caret.ts',
  'util/selection-write.ts',
  'editing/gap-nav-fixture.ts',
])

// Selection methods that move the selection. `modify` is the native caret/selection mover. The
// two-argument `collapse(node, offset)` is a Selection write; the one-argument `Range.collapse` is
// not. `extend` and `empty` are also ordinary property names (`options.hint.extend`), so only their
// call form counts. The argument scan allows one level of nested parentheses and spans lines.
const SELECTION_METHODS =
  /\.(addRange|setBaseAndExtent|removeAllRanges|collapseToStart|collapseToEnd|selectAllChildren|setPosition|modify)\b|\.(extend|empty)\s*\(/g
const SELECTION_COLLAPSE = /\.collapse\s*\((?:[^()]|\([^()]*\))*,/g

// Replace comments with spaces of the same length (keeping newlines) so offsets and line numbers
// stay right and a method named in prose is not a write. A `//` right after a colon is a URL.
function stripComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/g,
      (_m, lead: string, body: string) => lead + blank(body),
    )
}

/** Line numbers of raw Selection writes in `source` (comments ignored, whole-file scan). */
function rawSelectionWriteLines(source: string): number[] {
  const code = stripComments(source)
  const lines = new Set<number>()
  for (const pattern of [SELECTION_METHODS, SELECTION_COLLAPSE])
    for (const match of code.matchAll(pattern))
      lines.add(code.slice(0, match.index).split('\n').length)
  return [...lines].sort((a, b) => a - b)
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!entry.name.endsWith('.ts')) return []
    if (/\.(test|spec)\.ts$/.test(entry.name) || entry.name.endsWith('.d.ts'))
      return []
    return [full]
  })
}

describe('webview selection writes', () => {
  it("webview source writes the selection only through the caret authority's helpers", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(WEBVIEW_SRC)) {
      const rel = path.relative(WEBVIEW_SRC, file).split(path.sep).join('/')
      if (ALLOWED.has(rel)) continue
      for (const line of rawSelectionWriteLines(readFileSync(file, 'utf8')))
        offenders.push(`${rel}:${line}`)
    }
    expect(offenders).toEqual([])
  })

  // The detector itself: a line scan missed a multi-line call and the native `modify`.
  it('the detector catches a multi-line collapse(node, offset), modify and the classic writes, and ignores comments and Range.collapse', () => {
    const fixture = [
      'const r = document.createRange()',
      'r.collapse(true)', // Range.collapse: allowed
      '// sel.addRange(r) in a comment',
      '/* sel.removeAllRanges() in a block comment */',
      'const url = "https://example.test/a"',
      'sel.collapse(', // line 6: multi-line two-argument form
      '  node,',
      '  offset,',
      ')',
      "sel.modify('extend', 'forward', 'character')", // line 10
      'sel.collapse(getNode(), 3)', // line 11: nested call in the argument list
      'sel.setBaseAndExtent(a, 0, b, 1)', // line 12
    ].join('\n')
    expect(rawSelectionWriteLines(fixture)).toEqual([6, 10, 11, 12])
  })
})
