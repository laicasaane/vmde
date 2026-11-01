import fs from 'node:fs'
import vm from 'node:vm'
import { beforeAll, describe, it, expect } from 'vitest'
import {
  applyExplicitBlock,
  isSemanticNoop,
  mergeTableBlock,
  minimalDiffWriteback,
  splitBlocks,
} from '../../src/markdown/minimal-diff-writeback'

interface PinnedLute {
  Md2VditorIRDOM(markdown: string): string
  VditorIRDOM2Md(html: string): string
  SetVditorIR(enabled: boolean): void
  SetSpin(enabled: boolean): void
  SetSanitize(enabled: boolean): void
}

let pinnedLute: PinnedLute

beforeAll(() => {
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
  vm.runInContext(
    fs.readFileSync('media-src/vendor/lute/lute.min.js', 'utf8'),
    sandbox,
    { filename: 'lute.min.js' },
  )
  pinnedLute = (sandbox as { Lute: { New(): PinnedLute } }).Lute.New()
  pinnedLute.SetVditorIR(true)
  pinnedLute.SetSpin(true)
  pinnedLute.SetSanitize(true)
})

function pinnedIrReserialize(markdown: string): string {
  return pinnedLute.VditorIRDOM2Md(pinnedLute.Md2VditorIRDOM(markdown))
}

// A toy "reserialize" that mimics Vditor/Lute reflow: normalizes table-cell padding
// AND reproduces the task-60 bug — a space immediately before an inline marker
// (`**`, `*`, `` ` ``, `[`, `~~`) inside a cell is trimmed. Enough to exercise the
// unchanged-block + cell-level detection without loading Lute.
function fakeReserialize(block: string): string {
  const lines = block.split('\n')
  if (lines.length && lines.every((l) => l.trim().startsWith('|'))) {
    return lines
      .map((l) => {
        const cells = l
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          // single-space padding + the task-60 marker-space trim
          .map((c) => c.trim().replace(/ (?=\*\*|\*|`|\[|~~)/g, ''))
        return `| ${cells.join(' | ')} |`
      })
      .join('\n')
  }
  return block
}

describe('splitBlocks', () => {
  it('splits on blank lines', () => {
    expect(splitBlocks('a\n\nb\n\nc')).toEqual(['a', 'b', 'c'])
  })

  it('collapses runs of blank lines', () => {
    expect(splitBlocks('a\n\n\n\nb')).toEqual(['a', 'b'])
  })

  it('keeps a fenced code block with internal blank lines intact', () => {
    const md = 'para\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    expect(splitBlocks(md)).toEqual([
      'para',
      '```js\nconst a = 1\n\nconst b = 2\n```',
      'after',
    ])
  })

  it('returns [] for whitespace-only input', () => {
    expect(splitBlocks('\n\n  \n')).toEqual([])
  })
})

describe('minimalDiffWriteback', () => {
  it('keeps original bytes for blocks that only reflow (unchanged tables)', () => {
    // Original has a hand-written unpadded table; the editor reflows it to padded.
    const original =
      'Intro paragraph.\n\n|a|b|\n|-|-|\n|1|2|\n\nOutro paragraph.\n'
    const reflowed =
      'Intro paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nOutro paragraph.\n'
    const out = minimalDiffWriteback(original, reflowed, fakeReserialize)
    // The padded table must NOT be written — the original unpadded bytes win.
    expect(out).toContain('|a|b|')
    expect(out).not.toContain('| a | b |')
    expect(out).toBe(original)
  })

  it('writes the editor form for a genuinely changed block, keeps the rest verbatim', () => {
    const original =
      'First paragraph stays.\n\n|a|b|\n|-|-|\n|1|2|\n\nThird paragraph stays.\n'
    // user edited the middle table cell 1→9; editor reflows (pads) it
    const next =
      'First paragraph stays.\n\n| a | b |\n| - | - |\n| 9 | 2 |\n\nThird paragraph stays.\n'
    const out = minimalDiffWriteback(original, next, fakeReserialize)
    expect(out).toContain('First paragraph stays.')
    expect(out).toContain('Third paragraph stays.')
    expect(out).toContain('|9|2|') // only the changed cell content takes the editor form
    // unchanged prose blocks kept verbatim (no churn)
    const lines = out.split('\n')
    expect(lines[0]).toBe('First paragraph stays.')
  })

  it('keeps an edited prose paragraph (editor form) but not the untouched ones', () => {
    const original =
      'Para A long enough to matter.\n\nPara B unchanged here.\n\nPara C unchanged here.\n'
    const next =
      'Para A long enough to matter EDITED.\n\nPara B unchanged here.\n\nPara C unchanged here.\n'
    const out = minimalDiffWriteback(original, next, fakeReserialize)
    expect(out).toBe(next) // prose doesn't reflow → equals editor output anyway
    expect(out).toContain('EDITED.')
  })

  it('falls back to the editor output when reserialize is unavailable', () => {
    const original = '|a|b|\n|-|-|\n|1|2|\n'
    const next = '| a | b |\n| - | - |\n| 1 | 2 |\n'
    const out = minimalDiffWriteback(original, next, () => undefined)
    expect(out).toBe(next)
  })

  it('preserves the original trailing-newline shape', () => {
    const original = 'one\n\ntwo' // no trailing newline
    const next = 'one\n\ntwo\n' // editor added one
    const out = minimalDiffWriteback(original, next, fakeReserialize)
    expect(out.endsWith('two')).toBe(true)
    expect(out.endsWith('two\n')).toBe(false)
  })
})

// Cell-level table merge (task 60). The space-before-marker trim lives in Lute's
// parser, so an EDIT to one cell reflows the WHOLE table block and silently drops
// `x **y**` → `x**y**` in cells the user never touched. Block-level matching can't
// help (the block legitimately changed), so we recurse one level: keep the ORIGINAL
// bytes of rows/cells that are semantically unchanged, take the editor form only for
// the cells that actually changed.
describe('mergeTableBlock (task 60 — cell-level preservation)', () => {
  it('preserves the space before a marker in an UNCHANGED row when another row is edited', () => {
    const original = '| a | b |\n| - | - |\n| x **y** | keep |\n| p | q |'
    // user edits the last row p→P; the editor trims ` **` everywhere on save
    const next = '| a | b |\n| - | - |\n| x**y** | keep |\n| P | q |'
    const out = mergeTableBlock(original, next, fakeReserialize)
    expect(out).toContain('x **y**') // untouched row keeps its space verbatim
    expect(out).toContain('| P | q |') // edited row takes the editor form
  })

  it('preserves an unchanged CELL even when a SIBLING cell in the same row is edited', () => {
    const original = '| a | b |\n| - | - |\n| x **y** | keep |'
    // user edits cell-1 keep→KEEP (same row as the marker-space cell-0)
    const next = '| a | b |\n| - | - |\n| x**y** | KEEP |'
    const out = mergeTableBlock(original, next, fakeReserialize)
    expect(out).toContain('x **y**') // cell-0 space preserved (cell-level, not row)
    expect(out).toContain('KEEP') // cell-1 takes the edit
  })

  it('keeps uneven row padding when a reflowed sibling is equivalent and its neighbor changes', () => {
    const original = '|  x **y**  |    keep   |'
    const next = '| x**y** | KEEP |'

    expect(mergeTableBlock(original, next, fakeReserialize)).toBe(
      '|  x **y**  |    KEEP   |',
    )
  })

  it('takes the editor form for a cell whose CONTENT genuinely changed', () => {
    const original = '| a |\n| - |\n| x **y** |'
    const next = '| a |\n| - |\n| x **z** |' // y→z is a real change (post-trim it differs)
    const reflowed = fakeReserialize(next) // what the editor actually emits
    const out = mergeTableBlock(original, reflowed, fakeReserialize)
    expect(out).toContain('x**z**') // genuinely-changed cell keeps the editor form
    expect(out).not.toContain('**y**')
  })

  it('preserves the diagnostic SUB row padding while replacing only its changed tag content', () => {
    const open = `<SUB data-note="a > b" title='Q'>`
    const close = '</SUB>'
    const original = [
      '| A | B |',
      '| --- | --- |',
      `|  ${open}**2** &amp;${close}     |    keep   |`,
      '| untouched  |  row |',
    ].join('\n')
    const expected = [
      '| A | B |',
      '| --- | --- |',
      '|  **2** &amp;     |    keep   |',
      '| untouched  |  row |',
    ].join('\n')
    const changedSource = original.replace(open, '').replace(close, '')
    const canonical = pinnedIrReserialize(changedSource)

    expect(minimalDiffWriteback(original, canonical, pinnedIrReserialize)).toBe(
      expected,
    )
  })

  it.each([
    [
      'optional borders and indentation',
      '  alpha  |  beta  ',
      '  alpha  |  BETA  ',
    ],
    ['tabs and an empty cell', '|\told\t|\t \t|', '|\tNEW\t|\t \t|'],
    ['repeated contents with two edits', '| x | x | x |', '| y | x | y |'],
    ['one escaped pipe', '|  a\\|b  |  c  |', '|  z\\|q  |  c  |'],
  ] as const)(
    'preserves raw row boundaries for %s',
    (_name, original, next) => {
      expect(mergeTableBlock(original, next, (block) => block)).toBe(next)
    },
  )

  it.each([
    [
      'multiple backslashes before a pipe',
      '| a\\\\|b | c |',
      '| z\\\\|q | c |',
    ],
    ['a terminal escaped pipe', '| a\\|', '| b |'],
  ] as const)(
    'falls back for ambiguous raw row boundaries: %s',
    (_name, original, next) => {
      expect(mergeTableBlock(original, next, (block) => block)).toBe(next)
    },
  )

  it('falls back to the editor output when the table shape changes (row added)', () => {
    const original = '| a |\n| - |\n| x **y** |'
    const next = '| a |\n| - |\n| x**y** |\n| new |'
    const out = mergeTableBlock(original, next, fakeReserialize)
    expect(out).toBe(next) // differing row counts → no safe cell mapping
  })

  it('falls back when the column count differs', () => {
    const original = '| a | b |\n| - | - |\n| x **y** | z |'
    const next = '| a |\n| - |\n| x**y** |'
    const out = mergeTableBlock(original, next, fakeReserialize)
    expect(out).toBe(next)
  })

  it('is wired into minimalDiffWriteback: editing one cell keeps sibling rows intact', () => {
    const original =
      'Intro.\n\n| a | b |\n| - | - |\n| x **y** | keep |\n| p | q |\n\nOutro.\n'
    const next =
      'Intro.\n\n| a | b |\n| - | - |\n| x**y** | keep |\n| P | q |\n\nOutro.\n'
    const out = minimalDiffWriteback(original, next, fakeReserialize)
    expect(out).toContain('Intro.')
    expect(out).toContain('Outro.')
    expect(out).toContain('x **y**') // table block recursed: untouched row kept
    expect(out).toContain('| P | q |') // edited row reflowed
  })
})

describe('isSemanticNoop (task 61 v2 Layer 1)', () => {
  // Fake WHOLE-DOC reserialize: collapses a loose bullet list to tight (models the IR
  // round-trip's lossy loose→tight, proven on the real Lute blob) and trims trailing
  // newlines. Idempotent, so reserialize(reserialize(x)) === reserialize(x).
  const rt = (md: string): string => {
    let prev = ''
    let s = md
    while (s !== prev) {
      prev = s
      s = s.replace(/^(- .*)\n\n(?=- )/gm, '$1\n')
    }
    return s.replace(/\n+$/, '')
  }

  it('detects an identical document as a no-op', () => {
    const d = '# H\n\ntext\n'
    expect(isSemanticNoop(d, d, rt)).toBe(true)
  })

  it('detects a reverted LOOSE list as a no-op despite the lossy round-trip', () => {
    // The dirty-after-undo case: disk has a hand-written loose list; the editor's
    // output after undo is the tight canonical form. Bytes differ, but both sides
    // collapse identically under reserialize → still a no-op → baseline restored.
    const baseline = '- a\n\n- b\n\n- c\n'
    const next = rt(baseline) // editor output (tight canonical)
    expect(next).not.toEqual(baseline) // bytes genuinely differ
    expect(isSemanticNoop(baseline, next, rt)).toBe(true)
  })

  it('returns false for a genuine edit', () => {
    expect(isSemanticNoop('- a\n\n- b\n', '- a\n\n- B\n', rt)).toBe(false)
  })

  it('ignores trailing-newline-only differences', () => {
    expect(isSemanticNoop('text', 'text\n\n', rt)).toBe(true)
  })

  it('returns false (safe fallback) when reserialize is unavailable (cold Lute)', () => {
    expect(isSemanticNoop('a', 'a', () => undefined)).toBe(false)
  })
})

describe('applyExplicitBlock (task 390 — forcing one deliberate block)', () => {
  // A "reserialize" that mimics the one property this feature turns on: GFM autolinks a bare URL,
  // so `https://x` and `[https://x](https://x)` are the SAME document. Proven against our pinned
  // Lute (both round-trip to the bracketed form); modelled here so the unit test needs no Lute.
  const autolink = (block: string) =>
    block.replace(
      /(^|[^([])(https:\/\/\S+)/g,
      (_m, pre, url) => `${pre}[${url}](${url})`,
    )

  const doc =
    '# Links\n\nSee https://example.com/a for details.\n\nUntouched *text* here.\n'

  it('writes the explicit form even though it is semantically a no-op', () => {
    const out = applyExplicitBlock(
      doc,
      'See [https://example.com/a](https://example.com/a) for details.',
      autolink,
    )
    expect(out).toContain(
      'See [https://example.com/a](https://example.com/a) for details.',
    )
  })

  it('leaves every other byte of the document alone', () => {
    // The whole reason this is a one-block operation rather than "write the editor's output":
    // blocks the user never touched must keep their exact bytes, blank lines included.
    const out = applyExplicitBlock(
      doc,
      'See [https://example.com/a](https://example.com/a) for details.',
      autolink,
    )
    expect(out.startsWith('# Links\n\n')).toBe(true)
    expect(out).toContain('\n\nUntouched *text* here.\n')
    expect(out.split('\n\n').length).toBe(doc.split('\n\n').length)
  })

  it('is a no-op when the block is already in the explicit form', () => {
    const already = '# Links\n\nSee [https://x](https://x) now.\n'
    expect(
      applyExplicitBlock(already, 'See [https://x](https://x) now.', autolink),
    ).toBe(already)
  })

  it('replaces only the FIRST canonical match', () => {
    // Two paragraphs can mean the same thing; only the one the user acted on may change, and
    // without position information the first match is the only defensible choice.
    const twice =
      'See https://example.com/a here.\n\nSee https://example.com/a here.\n'
    const out = applyExplicitBlock(
      twice,
      'See [https://example.com/a](https://example.com/a) here.',
      autolink,
    )
    expect(out.match(/\[https:\/\/example\.com\/a\]/g)?.length).toBe(1)
    expect(out).toContain('\n\nSee https://example.com/a here.\n')
  })

  it('does nothing when no block matches', () => {
    expect(
      applyExplicitBlock(doc, 'A block from another document.', autolink),
    ).toBe(doc)
  })

  it('does nothing when reserialization is unavailable (cold Lute)', () => {
    // Same contract as the rest of the write-back: undefined means "cannot decide", and the
    // safe answer is to leave the document as the normal minimization produced it.
    expect(
      applyExplicitBlock(
        doc,
        'See [https://example.com/a](https://example.com/a) for details.',
        () => undefined,
      ),
    ).toBe(doc)
  })
})

// Task 673: after an exact action (for example Format Table) the document holds bytes that the
// clean baseline does not. The current host text is passed as `preferred` so that those bytes
// win over the baseline's, wherever the editor output still matches them.
describe('minimalDiffWriteback preferred host source (Task 673)', () => {
  const unformattedTable =
    '| Name | Value |\n|:--|--:|\n| cellone |   2 |\n| celltwo| 30 |'
  const baseline = `editword paragraph before the table\n\n${unformattedTable}\n\nturnword paragraph after the table\n`

  it('keeps the host bytes of a neutral exact result when typing elsewhere (pinned Lute)', () => {
    const formatted = pinnedIrReserialize(unformattedTable).replace(/\n+$/, '')
    // Guard: the instrument only means something when the two table forms differ in bytes but
    // reserialize to the same editor output.
    expect(formatted).not.toBe(unformattedTable)
    expect(pinnedIrReserialize(formatted).replace(/\n+$/, '')).toBe(formatted)
    const host = `editword paragraph before the table\n\n${formatted}\n\nturnword paragraph after the table\n`
    const typed = host.replace('editword', 'edixtword')
    const out = minimalDiffWriteback(baseline, typed, pinnedIrReserialize, host)
    expect(out).toBe(typed)
  })

  it('without a preferred source the baseline bytes still win (today)', () => {
    const formatted = pinnedIrReserialize(unformattedTable).replace(/\n+$/, '')
    const typed = `edixtword paragraph before the table\n\n${formatted}\n\nturnword paragraph after the table\n`
    const out = minimalDiffWriteback(baseline, typed, pinnedIrReserialize)
    expect(out).toBe(
      `edixtword paragraph before the table\n\n${unformattedTable}\n\nturnword paragraph after the table\n`,
    )
  })

  it('keeps the host padding of unchanged rows when one table cell is edited', () => {
    const formatted = pinnedIrReserialize(unformattedTable).replace(/\n+$/, '')
    const host = `intro\n\n${formatted}\n\noutro\n`
    const editedTable = formatted.replace('cellone', 'celloneX')
    const typed = `intro\n\n${editedTable}\n\noutro\n`
    const out = minimalDiffWriteback(
      `intro\n\n${unformattedTable}\n\noutro\n`,
      typed,
      pinnedIrReserialize,
      host,
    )
    // The untouched row keeps the formatted padding from the host, not the baseline's.
    const keptRow = formatted.split('\n').find((row) => row.includes('celltwo'))
    expect(keptRow).toBeDefined()
    expect(out).toContain(keptRow as string)
  })

  it('does not bring back padding that a native Undo removed from the host', () => {
    const formatted = pinnedIrReserialize(unformattedTable).replace(/\n+$/, '')
    // The host holds the unpadded table again; the editor still shows the formatted one.
    const host = baseline
    const typed = `edixtword paragraph before the table\n\n${formatted}\n\nturnword paragraph after the table\n`
    const out = minimalDiffWriteback(baseline, typed, pinnedIrReserialize, host)
    expect(out).toContain(unformattedTable)
    expect(out).not.toContain(formatted)
  })

  it('pairs repeated identical blocks left to right in each source', () => {
    const host = 'same\n\nsame\n\nSAME\n'
    const baselineText = 'same\n\nsame\n\nsame\n'
    const out = minimalDiffWriteback(
      baselineText,
      'same\n\nsame\n\nSAME\n',
      (block) => (block.toLowerCase() === 'same' ? 'same' : undefined),
      host,
    )
    expect(out).toBe('same\n\nsame\n\nSAME\n')
  })

  it('takes the trailing-newline shape of the preferred source', () => {
    const out = minimalDiffWriteback(
      'one\n\ntwo\n',
      'one\n\ntwo!\n',
      (b) => b,
      'one\n\ntwo',
    )
    expect(out.endsWith('two!')).toBe(true)
    expect(out.endsWith('\n')).toBe(false)
  })
})
