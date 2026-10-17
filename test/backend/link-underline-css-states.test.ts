import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Task 662: the link underline (Task 647) must not depend on link state. A visited link cannot be
// produced or observed in the webview, so the proof is structural: no shipped author rule is
// scoped to `:visited`/`:link`/`:any-link`, and nothing opts out of forced-colours adjustment.
// The scanner lives here (no source module); the Vditor link-card `a:visited` rule is generated
// output, is not scanned, and only recolours a child of a link card (no decoration).

const root = resolve(__dirname, '../..')
const themesDir = join(root, 'media/markdown-themes')
const sources = [
  join(root, 'media-src/src/main.css'),
  ...readdirSync(themesDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => join(themesDir, f)),
]

interface Rule {
  selector: string
  body: string
}

// Index just past the `}` that closes the block opened at `open`.
function blockEnd(src: string, open: number): number {
  let depth = 1
  let j = open + 1
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') depth--
    j++
  }
  return j
}

// Flattens a stylesheet (comments stripped, at-rule blocks descended into) to style rules.
function scanRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open === -1) break
    const end = blockEnd(src, open)
    const head = src.slice(i, open).trim()
    const inner = src.slice(open + 1, end - 1)
    if (!head.startsWith('@')) rules.push({ selector: head, body: inner })
    else if (/^@(media|supports|layer|container|scope)\b/.test(head))
      rules.push(...scanRules(inner))
    i = end
  }
  return rules
}

const STATE = /:(visited|link|any-link)\b/
const UNDERLINE_TARGET = /a\[href\]|span\[data-type/

function violations(css: string): string[] {
  const out: string[] = []
  for (const r of scanRules(css)) {
    if (/:visited\b/.test(r.selector))
      out.push(`:visited selector: ${r.selector}`)
    if (/forced-color-adjust/.test(r.body))
      out.push(`forced-color-adjust in: ${r.selector}`)
    if (
      /text-decoration-line\s*:\s*underline/.test(r.body) &&
      UNDERLINE_TARGET.test(r.selector) &&
      STATE.test(r.selector)
    )
      out.push(`state-scoped underline: ${r.selector}`)
  }
  return out
}

describe('link underline CSS is state independent (Task 662)', () => {
  it('scans real sources (not vacuous)', () => {
    expect(sources.length).toBeGreaterThan(5)
    const main = scanRules(readFileSync(sources[0], 'utf8'))
    expect(
      main.some(
        (r) =>
          /text-decoration-line\s*:\s*underline/.test(r.body) &&
          UNDERLINE_TARGET.test(r.selector),
      ),
    ).toBe(true)
  })

  it.each(sources.map((s) => [s.slice(root.length + 1), s]))(
    'no :visited rule, no forced-color-adjust, no state-scoped underline in %s',
    (_name, file) => {
      expect(violations(readFileSync(file, 'utf8'))).toEqual([])
    },
  )

  it('detects a synthetic violation', () => {
    const bad = `
      a:visited { text-decoration: none }
      .x { forced-color-adjust: none }
      @media (forced-colors: active) {
        .vditor-reset a[href]:link { text-decoration-line: underline }
      }
    `
    expect(violations(bad)).toEqual([
      ':visited selector: a:visited',
      'forced-color-adjust in: .x',
      'state-scoped underline: .vditor-reset a[href]:link',
    ])
  })
})
