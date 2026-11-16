import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { tableHeavyMarkdown } from '../vscode-e2e/table-heavy-markdown'
import { wrapLiveLineBreakIdentity } from '../../media-src/src/editing/live-line-breaks'
import { createRealLute } from '../../media-src/src/testing/real-lute'
import {
  patchSvSetValueSplit,
  patchSvSplitAnyBreak,
} from '../../media-src/esbuild-shared.mjs'

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

/**
 * The split regex `processSpinVditorSVDOM` in `code` uses: its first `spinHTML.replace(` argument,
 * evaluated with `win` as the page window (the patched argument reads the Source switch hook).
 */
function splitRegexOf(code: string, win: object = {}): RegExp {
  const at = code.indexOf('export const processSpinVditorSVDOM')
  const call =
    code.indexOf('spinHTML.replace(', at) + 'spinHTML.replace('.length
  const end = code.indexOf(", '<span", call)
  const argument = code.slice(call, end).replace('(window as any)', 'window')
  return new Function('window', `return ${argument}`)(win) as RegExp
}

const SWITCH_ON = { __vmdeSourceUnitsOn: () => true }
const SWITCH_OFF = { __vmdeSourceUnitsOn: () => false }

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
      const patched = patchSvSplitAnyBreak(processSource)
      // After, with the Source switch on: the 15 blocks of the fixture plus the empty div a table at
      // the end leaves.
      expect(divCount(spin, splitRegexOf(patched, SWITCH_ON))).toBe(16)
      // D-14 review A-1: with the switch off, or without the hook, Vditor's own split runs.
      expect(divCount(spin, splitRegexOf(patched, SWITCH_OFF))).toBe(1)
      expect(divCount(spin, splitRegexOf(patched))).toBe(1)
    },
    30_000,
  )

  it('asserts both regexes once and refuses a second application', () => {
    const patched = patchSvSplitAnyBreak(processSource)
    expect(() => patchSvSplitAnyBreak(patched)).toThrow(/already patched/)
  })
})

// D-14 review A-1 for V-S3: Source `setValue` builds the split DOM only while the Source switch is on.
describe('V-S3 Source setValue follows the Source switch at run time', () => {
  const indexSource = readFileSync(
    'media-src/node_modules/vditor/src/index.ts',
    'utf8',
  )

  /** The patched `setValue` Source build, evaluated with `win` as the window. */
  function setValueBuild(win: object): string {
    const patched = patchSvSetValueSplit(indexSource)
    const marker = 'this.vditor.sv.element.innerHTML = '
    const start =
      patched.indexOf(marker, patched.indexOf('public setValue(')) +
      marker.length
    const end = patched.indexOf(';\n', start)
    const expression = patched
      .slice(start, end)
      .replace('(window as any)', 'window')
    const self = {
      vditor: { lute: { SpinVditorSVDOM: (md: string) => `spin(${md})` } },
    }
    return new Function(
      'window',
      'processSpinVditorSVDOM',
      'markdown',
      `return ${expression}`,
    ).call(self, win, (md: string) => `split(${md})`, 'md') as string
  }

  it('splits with the switch on and keeps the one-div build with it off or without the hook', () => {
    expect(setValueBuild(SWITCH_ON)).toBe('split(md)')
    expect(setValueBuild(SWITCH_OFF)).toBe("<div data-block='0'>spin(md)</div>")
    expect(setValueBuild({})).toBe("<div data-block='0'>spin(md)</div>")
  })
})
