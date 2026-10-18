// @vitest-environment jsdom
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { maskCommentsForPreview } from '../../media-src/src/editing/html-comment'
import {
  markRawHeadingsForPreview,
  RAW_HEADING_ATTR,
} from '../../media-src/src/nav/preview-raw-headings'
import { isLuteArtifactBuilt, luteArtifactPath } from './lute-artifact'

// Task 660: end to end through the real Lute with Vditor's Preview options. The mask is what makes
// a raw top-level heading distinguishable from a Markdown heading in the Preview DOM, so this test
// pins which top-level heading elements carry the mark after the sanitiser and the HTML parser.
// jsdom gives import.meta.url a non-file scheme, so the repository root comes from the vitest root.
const ROOT = path.resolve(process.cwd())
const BUILT = isLuteArtifactBuilt(ROOT)
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

interface PreviewLute {
  Md2HTML(md: string): string
  [option: string]: unknown
}
let lute: PreviewLute

beforeAll(() => {
  if (!BUILT) return
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(luteArtifactPath(ROOT), 'utf8'), sandbox)
  const l = (sandbox as { Lute: { New(): any } }).Lute.New()
  for (const [name, value] of [
    ['SetSanitize', true],
    ['SetFootnotes', true],
    ['SetHeadingID', true],
    ['SetCallout', true],
    ['SetVditorCodeBlockPreview', true],
    ['SetVditorMathBlockPreview', true],
    ['SetGFMAutoLink', true],
  ] as const)
    l[name](value)
  lute = l
})

/** Same chain as the build patch: comment mask first, then the raw-heading mask. */
function topLevel(md: string): Element[] {
  const host = document.createElement('div')
  host.innerHTML = lute.Md2HTML(
    markRawHeadingsForPreview(maskCommentsForPreview(md)),
  )
  return [...host.children]
}
const headings = (els: Element[]) =>
  els.filter((e) => /^H[1-6]$/.test(e.tagName))
const isRaw = (e: Element) => e.hasAttribute(RAW_HEADING_ATTR)

const DOC = `---
title: <h2>fm</h2>
---
# Top

<h2>Bare</h2>

<H3 class="c" id="x">Upper</H3>

<div>
<h2>nested</h2>
</div>
<h4>continuation</h4>

para <h2>inline</h2> tail and \`<h2>code</h2>\` and \\<h2>esc</h2>

    <h2>indented code</h2>

\`\`\`html
<h2>fenced</h2>
\`\`\`

<textarea>
<h2>in textarea</h2>
</textarea>

$$
<h2>math</h2>
$$

## Real

text

<details>
<summary>s</summary>

### InDetails

</details>
`

describe.skipIf(!BUILT)(
  'Preview raw headings through the real Lute (task 660)',
  () => {
    it('top-level headings: raw ones carry the mark, Markdown ones do not', () => {
      const tops = headings(topLevel(DOC))
      const summary = tops.map((e) => [e.tagName, isRaw(e)])
      expect(summary).toEqual([
        ['H1', false], // # Top
        ['H2', true], // <h2>Bare</h2>
        ['H3', true], // uppercase tag (inline HTML hoisted by the parser)
        ['H4', true], // continuation line after </div>
        ['H2', true], // inline in a paragraph, hoisted out of the <p>
        ['H2', false], // ## Real
      ])
    })

    it('the top-level heading set without the marked ones is exactly the Markdown headings', () => {
      const md = headings(topLevel(DOC)).filter((e) => !isRaw(e))
      expect(md.map((e) => e.textContent)).toEqual(['Top', 'Real'])
    })

    it('headings nested in a div or a details element are not top level and stay unmarked', () => {
      const tops = topLevel(DOC)
      expect(
        tops.some((e) => e.textContent === 'nested' && e.tagName === 'H2'),
      ).toBe(false)
      const details = tops.find((e) => e.tagName === 'DETAILS')
      expect(details?.querySelector('h3')?.hasAttribute(RAW_HEADING_ATTR)).toBe(
        false,
      )
      expect(topLevel(DOC).some((e) => e.textContent === 'InDetails')).toBe(
        false,
      )
    })

    it('code, front matter and math text is left as literal text', () => {
      const html = lute.Md2HTML(markRawHeadingsForPreview(DOC))
      expect(html).not.toMatch(/&lt;h2[^&]*data-vmde-raw-heading/)
      expect(html).not.toContain(`<h2 ${RAW_HEADING_ATTR}="1">fm`)
    })
  },
)
