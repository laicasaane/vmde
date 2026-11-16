import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { tableHeavyMarkdown } from '../vscode-e2e/table-heavy-markdown'
import { wrapLiveLineBreakIdentity } from '../../media-src/src/editing/live-line-breaks'
import { createRealLute } from '../../media-src/src/testing/real-lute'
import { patchSvSplitAnyBreak } from '../../media-src/esbuild-shared.mjs'

// Task 733 / 015, run-1 repair R-1 (V-S3b): the Source DOM is split into one `data-block` div per source
// chunk only when Vditor's split regex matches the spin output. VMDE's Source spin wrapper
// (`live-line-breaks.ts`) re-serializes the spin, so its line breaks read `<br>`, which the upstream regex
// (written for Lute's `<br />`) never matches: the whole document stayed one div. The patched regex
// matches both forms. The regexes are taken from the vendored source and from the patched source, and
// run with Vditor's own replacement string on the wrapped spin of the same document.

const processSource = readFileSync(
  'media-src/node_modules/vditor/src/ts/sv/process.ts',
  'utf8',
)
// The Source spin wrapper parses HTML through `document`: a DOM for this node-environment file (the
// build-patch module needs node's file URLs, so the file cannot run in the jsdom environment).
const dom = new JSDOM('')
;(globalThis as { document?: Document }).document = dom.window.document

const SPLIT_INTO =
  '<span data-type="newline"><br /><span style="display: none">\n</span></span><span data-type="newline"><br /><span style="display: none">\n</span></span></div><div data-block="0"><'

/** The split regex of `processSpinVditorSVDOM` in `code` (its first `spinHTML.replace(` regex literal). */
function splitRegexOf(code: string): RegExp {
  const at = code.indexOf('export const processSpinVditorSVDOM')
  const literal = /spinHTML\.replace\(\/(.+?)\/g, '/u.exec(code.slice(at))
  if (!literal) throw new Error('split regex not found')
  return new RegExp(literal[1].replace(/\\\//g, '/'), 'g')
}

/** Divs of `processSpinVditorSVDOM`'s output for `spin`, built with `regex`. */
function divCount(spin: string, regex: RegExp): number {
  const root = dom.window.document.createElement('div')
  root.innerHTML = `<div data-block='0'>${spin.replace(regex, SPLIT_INTO)}</div>`
  return root.children.length
}

describe('V-S3b Source split on the wrapped spin', () => {
  const lute = createRealLute('sv').lute
  wrapLiveLineBreakIdentity(lute)

  it.each([1, 4] as const)(
    'gives one div per blank-line block at factor %i',
    (factor) => {
      const spin = lute.SpinVditorSVDOM(tableHeavyMarkdown(factor)) as string
      // The wrapper re-serialized the breaks.
      expect(spin.includes('<br />')).toBe(false)
      // Before the patch: one div for the whole document.
      expect(divCount(spin, splitRegexOf(processSource))).toBe(1)
      // After: the 15 blocks of the fixture plus the empty div a table at the end leaves.
      expect(
        divCount(spin, splitRegexOf(patchSvSplitAnyBreak(processSource))),
      ).toBe(16)
    },
    30_000,
  )

  it('asserts both regexes once and refuses a second application', () => {
    const patched = patchSvSplitAnyBreak(processSource)
    expect(() => patchSvSplitAnyBreak(patched)).toThrow(/found 0/)
  })
})
