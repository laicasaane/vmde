import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Task 733 (task 002): freeze the `:has()` rules that remain in the two style sheets.
//
// Why: a `:has()` rule whose argument holds an attribute selector or a negation re-matches on every
// DOM or attribute change below its subject. Eight such "partner" rules (state read through `:has()`
// from a descendant) made every element insertion cost a document-wide style recalculation, so
// they were replaced by sibling selectors or by state that the owning module writes (class
// `vmde-emoji-open`, attribute `data-vmde-source-pane`, `aria-expanded`, class
// `vmde-toolbar-item--collapse`). This test keeps the partner shape from coming back.
//
// How: read both style sheets, strip comments, collect every selector that contains `:has(`, and
// compare it with the exact allowlist below. The shape checks run whatever the allowlist says.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHEETS = ['media-src/src/main.css', 'media-src/src/vscode-chrome.css']

const REMEDY =
  'Task 733 task 002 replaced the partner `:has()` rules by sibling selectors or by state ' +
  'written by the owning module; see the rule comments in main.css and vscode-chrome.css.'

// The one selector that nests `:has(` inside `:not(`: static Vditor panel content, measured not to
// pair (no document-wide recalculation), out of scope by Q-6.
const EXEMPT_NOT_HAS =
  '.vditor-toolbar .vditor-panel:not(.vmde-emoji-picker):not(:has(.vditor-emojis)) button'

const ALLOWED_SELECTORS: readonly string[] = [
  // media-src/src/main.css
  '.vditor-reset .vditor-ir__node:has(> pre.vditor-ir__preview > code.vditor-linenumber) > pre.vditor-ir__marker--pre > code',
  '.vditor-reset .vditor-ir__node--expand > .vditor-ir__preview:has(> code.hljs)',
  '.vditor-reset .vditor-wysiwyg__block > pre.vditor-wysiwyg__pre:not([style*="none"]) ~ pre.vditor-wysiwyg__preview:has(> code)',
  '.vditor-reset .vditor-wysiwyg__block:has(> pre.vditor-wysiwyg__preview > code) > pre.vditor-wysiwyg__pre:not([style*="none"])',
  '.vditor-reset .vditor-ir__node:is([data-type="code-block"], [data-type="math-block"]):not(.vditor-ir__node--expand):has(> .vditor-ir__preview)::before',
  '.vditor-reset .vditor-ir__node:is([data-type="code-block"], [data-type="math-block"]):not(.vditor-ir__node--expand):has(> .vditor-ir__preview)::after',
  '.vditor-reset .vditor-ir__node:is([data-type="code-block"], [data-type="math-block"]):not(.vditor-ir__node--expand):has(> .vditor-ir__preview) > .vditor-ir__marker',
  '.vditor-reset .vditor-ir__node[data-type="html-block"]:not(.vditor-ir__node--expand):has(> .vditor-ir__preview)::before',
  '.vditor-reset .vditor-ir__node[data-type="html-block"]:not(.vditor-ir__node--expand):has(> .vditor-ir__preview)::after',
  '.vditor-reset .vditor-ir__node[data-type="html-block"]:not(.vditor-ir__node--expand):has(> .vditor-ir__preview) > .vditor-ir__marker--pre',
  '.vditor-reset :is(.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview pre):has(> :is(.language-mermaid, .language-echarts, .language-flowchart, .language-graphviz, .language-plantuml, .language-mindmap, .language-markmap, .language-abc, .language-smiles, .language-wavedrom, .language-nomnoml, .language-geojson, .language-topojson, .language-stl, .language-vega, .language-vega-lite, .language-d2, .language-math))',
  '.vditor-ir__node:has(> table.vmde-table-resized)',
  '.vditor-ir__preview:has(> .vmde-comment)',
  '.vditor-wysiwyg__preview:has(> .vmde-comment)',
  '.vditor-reset .vditor-ir__node[data-type="yaml-front-matter"]:has(> .vmde-front-matter:focus-within) > pre.vditor-ir__marker--pre',
  '.vditor-reset .vditor-ir__node[data-type="yaml-front-matter"]:has(> .vmde-front-matter:focus-within) > span.vditor-ir__marker',
  '.vditor-wysiwyg:has(.vmde-front-matter:focus-within) > .vditor-panel',
  // media-src/src/vscode-chrome.css
  '.vditor-toolbar .vditor-panel:not(.vmde-emoji-picker):not(:has(.vditor-emojis)) button',
  '.vditor-hint button:not(.vmde-emoji-picker button):has(> .vmde-menu-label)',
  '.vditor-hint button:has(> .vmde-menu-label) > svg',
]

/** Split a rule prelude at its top-level commas. */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let j = 0; j <= prelude.length; j++) {
    const c = prelude[j]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (j === prelude.length || (c === ',' && depth === 0)) {
      parts.push(prelude.slice(from, j))
      from = j + 1
    }
  }
  return parts
}

/** Preludes of all style rules (at-rule preludes skipped) in comment-free CSS. */
function rulePreludes(text: string): string[] {
  const preludes: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      const prelude = text.slice(start, i).trim()
      if (!prelude.startsWith('@')) preludes.push(prelude)
      start = i + 1
    } else if (text[i] === '}') {
      start = i + 1
    }
  }
  return preludes
}

const collapse = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .trim()

/** Selectors of every rule in `css` (comments stripped, whitespace collapsed) that contain `:has(`. */
function hasSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return rulePreludes(text)
    .flatMap(splitSelectorList)
    .map(collapse)
    .filter((s) => s.includes(':has('))
}

/** Text of each `:has(...)` argument in `selector` (balanced parentheses). */
function hasArguments(
  selector: string,
): Array<{ arg: string; before: string }> {
  const found: Array<{ arg: string; before: string }> = []
  let at = selector.indexOf(':has(')
  while (at !== -1) {
    let depth = 1
    let k = at + 5
    while (k < selector.length && depth > 0) {
      if (selector[k] === '(') depth++
      else if (selector[k] === ')') depth--
      k++
    }
    found.push({
      arg: selector.slice(at + 5, k - 1),
      before: selector.slice(0, at),
    })
    at = selector.indexOf(':has(', at + 5)
  }
  return found
}

/** True when `:has(` sits inside an open `:not(` of the text before it. */
function insideNot(before: string): boolean {
  const stack: boolean[] = []
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '(')
      stack.push(before.slice(Math.max(0, i - 4), i) === ':not')
    else if (before[i] === ')') stack.pop()
  }
  return stack.some(Boolean)
}

/** Shape violations of `selector`, empty when it is acceptable. */
function shapeViolations(selector: string): string[] {
  const problems: string[] = []
  for (const { arg, before } of hasArguments(selector)) {
    if (arg.includes('['))
      problems.push('`:has()` argument holds an attribute selector')
    if (arg.includes(':not(')) problems.push('`:has()` argument holds `:not(`')
    if (selector !== EXEMPT_NOT_HAS && insideNot(before)) {
      problems.push('`:has()` sits inside `:not(`')
    }
  }
  return problems
}

const collected = SHEETS.flatMap((sheet) =>
  hasSelectors(readFileSync(path.join(root, sheet), 'utf8')).map(
    (selector) => ({ sheet, selector }),
  ),
)

describe('remaining :has() rules (Task 733)', () => {
  it('collects the selectors of both sheets', () => {
    expect(collected.length).toBeGreaterThan(0)
  })

  it('has no :has() selector outside the allowlist', () => {
    const unknown = collected.filter(
      ({ selector }) => !ALLOWED_SELECTORS.includes(selector),
    )
    expect(
      unknown,
      `Unlisted :has() selectors:\n${unknown.map((u) => `  ${u.sheet}: ${u.selector}`).join('\n')}\n${REMEDY}`,
    ).toEqual([])
  })

  it('keeps every allowlisted selector present (the list stays exact)', () => {
    const present = new Set(collected.map((c) => c.selector))
    const missing = ALLOWED_SELECTORS.filter((s) => !present.has(s))
    expect(missing, `Allowlisted but absent: ${missing.join('\n')}`).toEqual([])
    expect(ALLOWED_SELECTORS).toHaveLength(20)
  })

  it('has no partner shape (attribute or negation in :has(), :has() inside :not())', () => {
    const bad = collected.flatMap(({ sheet, selector }) =>
      shapeViolations(selector).map(
        (p) => `  ${sheet}: ${selector}\n    -> ${p}`,
      ),
    )
    expect(
      bad,
      `Partner-shaped selectors:\n${bad.join('\n')}\n${REMEDY}`,
    ).toEqual([])
  })

  it('names the exemption: its :has() sits inside :not() on purpose', () => {
    expect(ALLOWED_SELECTORS).toContain(EXEMPT_NOT_HAS)
    expect(insideNot(hasArguments(EXEMPT_NOT_HAS)[0].before)).toBe(true)
  })

  describe('negative cases (the checker itself)', () => {
    it('rejects a new :has() selector with an attribute argument', () => {
      const found = hasSelectors('.x:has(.y[z]) { color: red; }')
      expect(found).toEqual(['.x:has(.y[z])'])
      expect(ALLOWED_SELECTORS.includes(found[0])).toBe(false)
      expect(shapeViolations(found[0])).toContain(
        '`:has()` argument holds an attribute selector',
      )
    })

    it('rejects :has() in a negation and a negation in :has()', () => {
      expect(shapeViolations('.a:not(:has(> .b))')).toContain(
        '`:has()` sits inside `:not(`',
      )
      expect(shapeViolations('.a:has(.b:not(.c))')).toContain(
        '`:has()` argument holds `:not(`',
      )
    })

    it('accepts a plain class argument and ignores comments', () => {
      expect(shapeViolations('.a:has(> .b)')).toEqual([])
      expect(hasSelectors('/* .x:has(.y[z]) */ .a { color: red; }')).toEqual([])
    })
  })
})
