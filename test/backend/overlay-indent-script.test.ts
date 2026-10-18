// @vitest-environment jsdom
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { installSectionIndent } from '../../media-src/src/nav/section-indent'
import type { InnerVditor } from '../../media-src/src/util/inner-vditor'
import { prewarmLute, renderForMode } from '../../src/lute/lute-host'
import {
  buildWebviewHtml,
  type HtmlBuildParams,
} from '../../src/webview-host/html-builder'
import {
  isLuteArtifactBuilt,
  waitForLuteWarm,
  warnLuteArtifactMissing,
} from './lute-artifact'

// Task 660: the first-paint overlay is marked by an inline script in html-builder.ts that copies the
// live rule of section-indent.ts (heading depth, footnote/link-ref tail blocks, and the blocks
// between a paired <details> and </details>, which start no section). The script is plain text, so
// nothing else ties the two together: this test runs the emitted script on real host Lute IR and
// WYSIWYG output and compares the marks with the live controller on the same HTML.
// jsdom gives import.meta.url a non-file scheme, so the repository root comes from the vitest root.
const ROOT = path.resolve(process.cwd())
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const BUILT = isLuteArtifactBuilt(ROOT)
if (!BUILT)
  warnLuteArtifactMissing('overlay indent script (real host Lute)', ROOT)

beforeAll(async () => {
  if (!BUILT) return
  prewarmLute(ROOT)
  await waitForLuteWarm()
})

afterEach(() => {
  document.body.innerHTML = ''
})

const DOC = `# Top

intro

<details>
<summary>S</summary>

## InDetails

body

### Deeper

deep body

</details>

after details

## After

text[^1]

<details><summary>one</summary>

#### OneBlockOpen

</details>

### Third

<details><summary>flat</summary>flat body</details>

<details>
<summary>unmatched</summary>

#### Unmatched

[^1]: note

[r]: http://x
`

function params(markdown: string, mode: 'ir' | 'wysiwyg'): HtmlBuildParams {
  return {
    toUri: (f) => `https://ext/${f}`,
    baseHref: 'https://ext/workspace/',
    cspSource: 'vscode-resource:',
    nonce: 'testNonce1234567890abcdef12345678',
    theme: 'light',
    config: {
      showToolbar: false,
      useVscodeThemeColor: true,
      contentTheme: 'auto',
      enableFullWidth: false,
      highlightHeadings: true,
      showHeadingMarkers: true,
      sectionIndent: true,
      sectionIndentSize: 24,
      markdownPreviewFontFamily: 'sans-serif',
      fontSize: '14px',
      sourceFontFamily: 'monospace',
      codeStyle: 'github',
      allowRemoteImages: false,
      customCss: '',
      externalCss: '',
    },
    preRenderedHtml: renderForMode(ROOT, markdown, mode),
    savedMode: mode,
    i18nLang: 'en_US',
  } as HtmlBuildParams
}

/** Runs the emitted marking script against the overlay and returns the marks per top-level child. */
function overlayMarks(markdown: string, mode: 'ir' | 'wysiwyg'): string[] {
  const html = buildWebviewHtml(params(markdown, mode))
  const overlay =
    /<div id="vmde-prerender"[\s\S]*?<\/pre><\/div><\/div><\/div>/.exec(html)
  const script = [
    ...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g),
  ]
    .map((m) => m[1])
    .find((s) => s.includes('data-vmde-indent-root'))
  expect(overlay, 'overlay markup').not.toBeNull()
  expect(script, 'indent script').toBeDefined()
  document.body.innerHTML = overlay![0]
  // The script is the page's own inline code; jsdom evaluates it like the webview would.
  new Function(script as string)()
  const pre = document.querySelector('#vmde-prerender pre.vditor-reset')!
  expect(pre.hasAttribute('data-vmde-indent-root')).toBe(true)
  return [...pre.children].map((c) => c.getAttribute('data-vmde-indent') ?? '0')
}

/** The live controller's marks for the same HTML on an IR or WYSIWYG surface. */
function liveMarks(markdown: string, mode: 'ir' | 'wysiwyg'): string[] {
  const surface = document.createElement('div')
  surface.className = 'vditor-reset'
  surface.innerHTML = renderForMode(ROOT, markdown, mode) as string
  document.body.append(surface)
  const inner = (mode === 'ir'
    ? { ir: { element: surface } }
    : { wysiwyg: { element: surface } }) as unknown as InnerVditor
  const controller = installSectionIndent(inner, true)
  const marks = [...surface.children].map(
    (c) => c.getAttribute('data-vmde-indent') ?? '0',
  )
  controller.dispose()
  surface.remove()
  return marks
}

describe.skipIf(!BUILT)(
  'overlay indent script vs the live rule (task 660)',
  () => {
    for (const mode of ['ir', 'wysiwyg'] as const) {
      it(`${mode}: the emitted script marks every top-level block like the live controller`, () => {
        const overlay = overlayMarks(DOC, mode)
        expect(overlay).toEqual(liveMarks(DOC, mode))
      })

      it(`${mode}: blocks between a paired details tag take the running depth, not their heading level`, () => {
        const html = renderForMode(ROOT, DOC, mode) as string
        const holder = document.createElement('div')
        holder.innerHTML = html
        const names = [...holder.children].map((c) => c.textContent ?? '')
        const marks = overlayMarks(DOC, mode)
        const mark = (text: string) =>
          marks[names.findIndex((n) => n.includes(text))]
        // `## InDetails` and `### Deeper` sit between a paired <details> and </details>: depth 0 from
        // `# Top`, not 1 and 2. The heading after the pair resumes its own level.
        expect(mark('InDetails')).toBe('0')
        expect(mark('Deeper')).toBe('0')
        expect(mark('after details')).toBe('0')
        expect(mark('After')).toBe('1')
        // A one-block pair (`<details><summary>` ... `</details>`) around a heading pairs too.
        expect(mark('OneBlockOpen')).toBe('1')
        expect(mark('Third')).toBe('2')
      })
    }
  },
)
