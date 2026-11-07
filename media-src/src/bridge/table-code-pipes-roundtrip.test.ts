// @vitest-environment jsdom
import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createRealLute, type RealLute } from '../testing/real-lute'
import { createIncrementalMd } from './incremental-md'

// Task 704, Decision D1: inside a table row, a `|` between the backticks of a code span is part of
// the code span. These tests drive the REAL vendored Lute (no stub) through the render, spin and
// serialize calls that Vditor makes, with `patchLuteTableCodePipes` installed the way
// `media-src/src/boot/preload.ts` installs it. The patched methods are called on `lute` itself:
// `RealLute.render` / `.serialize` are bound to the unpatched originals and would skip the patch.
//
// The helper module does not exist until the implementation step. It is loaded at run time so that
// this file fails by ASSERTION before the fix (the display and the bytes are wrong) instead of by an
// import error that would hide which behaviours are covered.
const HELPER = '../../../src/shared/table-code-pipes'
type Patch = (lute: unknown) => void
let patchLute: Patch | undefined

const FIXTURE = fs.readFileSync(
  'test/vscode-e2e/fixtures/table-code-pipes.md',
  'utf8',
)
const CODE_I57 = 'Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll'
const unescapePipes = (s: string) => s.replace(/\\\|/g, '|')
// Collapse Lute's table padding so a comparison does not depend on column widths.
const squash = (s: string) => unescapePipes(s).replace(/ {2,}/g, ' ')

beforeAll(async () => {
  try {
    patchLute = (await import(/* @vite-ignore */ HELPER))
      .patchLuteTableCodePipes
  } catch {
    patchLute = undefined
  }
})

function patched(mode: 'ir' | 'wysiwyg'): RealLute {
  const real = createRealLute(mode)
  patchLute?.(real.lute)
  return real
}

function parse(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

interface RowView {
  cells: number
  cell3Code: string | null
}
const rowElement = (root: HTMLElement, id: string) =>
  Array.from(root.querySelectorAll('tr')).find(
    (row) => row.cells[0]?.textContent?.trim() === id,
  )
// The text of the first <code> in a cell, without the zero-width spaces WYSIWYG puts around it.
const codeOfCell = (root: HTMLElement, id: string, cell: number) =>
  rowElement(root, id)
    ?.cells[cell]?.querySelector('code')
    ?.textContent?.replace(/\u200b/g, '') ?? null
function rowOf(root: HTMLElement, id: string): RowView | null {
  const tr = rowElement(root, id)
  return tr
    ? { cells: tr.cells.length, cell3Code: codeOfCell(root, id, 2) }
    : null
}

const lineOf = (markdown: string, id: string) =>
  markdown
    .split('\n')
    .find((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l)) ?? ''

describe('the table code-pipe patch is installed through its shared module', () => {
  it('exports patchLuteTableCodePipes from src/shared/table-code-pipes', () => {
    expect(typeof patchLute).toBe('function')
  })
})

describe('IR render of a row whose code span holds pipes', () => {
  it('shows the I57 row with 5 cells and the full code span', () => {
    const { lute } = patched('ir')
    const root = parse(lute.Md2VditorIRDOM(FIXTURE))
    expect(rowOf(root, 'I57')).toEqual({ cells: 5, cell3Code: CODE_I57 })
    expect(root.querySelector('table')?.rows[0].cells.length).toBe(5)
  })

  it('shows the row with a backslash-escaped pipe (E1) and a double-backtick span (E2)', () => {
    const { lute } = patched('ir')
    const root = parse(lute.Md2VditorIRDOM(FIXTURE))
    expect(rowOf(root, 'E1')?.cells).toBe(5)
    expect(codeOfCell(root, 'E1', 1)).toBe('x | y')
    expect(rowOf(root, 'E2')?.cells).toBe(5)
    expect(codeOfCell(root, 'E2', 1)).toBe('a | b')
  })

  it('still separates cells at a pipe outside a code span', () => {
    const { lute } = patched('ir')
    const root = parse(
      lute.Md2VditorIRDOM('| a | b | c |\n|---|---|---|\n| `x|y` | p | q |\n'),
    )
    const tr = root.querySelectorAll('tr')[1]
    expect(tr.cells.length).toBe(3)
    expect(tr.cells[0].querySelector('code')?.textContent).toBe('x|y')
    expect(tr.cells[1].textContent).toBe('p')
  })

  it('keeps a pipe in a code span outside any table as it is', () => {
    const { lute } = patched('ir')
    const root = parse(lute.Md2VditorIRDOM('A paragraph with `a|b` in code.\n'))
    expect(root.querySelector('p code')?.textContent).toBe('a|b')
  })
})

describe('SpinVditorIRDOM keeps the cells of a code-span row', () => {
  // A hand-built IR table block, as Lute renders it: the code text holds bare pipes. The spin
  // serializes it, parses the markdown again and renders it; without the patch the pipes become
  // cell separators on the way.
  const code = (text: string) =>
    `<span data-type="code" class="vditor-ir__node"><span class="vditor-ir__marker">\`</span><code data-newline="1">${text}</code><span class="vditor-ir__marker">\`</span></span>`
  const block = (text: string) =>
    `<table data-block="0" data-type="table"><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead><tbody><tr><td>I1</td><td>${code(text)}</td><td>tail</td></tr></tbody></table>`

  it('keeps 3 cells and the full code text after the spin', () => {
    const { lute } = patched('ir')
    const root = parse(lute.SpinVditorIRDOM(block('x | y | z')))
    const tr = root.querySelectorAll('tr')[1]
    expect(tr.cells.length).toBe(3)
    expect(tr.cells[1].querySelector('code')?.textContent).toBe('x | y | z')
    expect(tr.cells[2].textContent).toBe('tail')
  })

  it('keeps the cells when the caret marker sits inside the code text', () => {
    const { lute } = patched('ir')
    const root = parse(lute.SpinVditorIRDOM(block('x <wbr>| y')))
    const tr = root.querySelectorAll('tr')[1]
    expect(tr.cells.length).toBe(3)
    expect(tr.cells[2].textContent).toBe('tail')
  })

  it('spins the rendered fixture table without losing a cell of any row', () => {
    const { lute } = patched('ir')
    const table = parse(lute.Md2VditorIRDOM(FIXTURE)).querySelector('table')
    const spun = parse(lute.SpinVditorIRDOM(table?.outerHTML ?? ''))
    expect(rowOf(spun, 'I57')).toEqual({ cells: 5, cell3Code: CODE_I57 })
    expect(codeOfCell(spun, 'E1', 1)).toBe('x | y')
  })
})

describe('full VditorIRDOM2Md of a document with code-span pipes', () => {
  it('keeps the whole I57 row: all 5 cells, the code span, the alternative and the link', () => {
    const { lute } = patched('ir')
    const markdown = lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(FIXTURE))
    const line = squash(lineOf(markdown, 'I57'))
    expect(line).toContain(`\`${CODE_I57}\``)
    expect(line).toContain(
      'because its replay re-enters through `EnterAtAsync`.',
    )
    expect(line).toContain("The task's set, which makes every replay fail.")
    expect(line).toContain('[F11](../F11-sample-custom-kind.md) |')
  })

  it('writes every pipe of a code span in a form that renders back to the same 5 cells', () => {
    const { lute } = patched('ir')
    const markdown = lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(FIXTURE))
    const root = parse(lute.Md2VditorIRDOM(markdown))
    expect(rowOf(root, 'I57')).toEqual({ cells: 5, cell3Code: CODE_I57 })
    expect(codeOfCell(root, 'E1', 1)).toBe('x | y')
    expect(codeOfCell(root, 'E2', 1)).toBe('a | b')
  })

  it('is stable: a second render and serialize returns the same markdown', () => {
    const { lute } = patched('ir')
    const once = lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(FIXTURE))
    const twice = lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(once))
    expect(twice).toBe(once)
  })

  it('leaves the paragraph code span and the fenced table-like text alone', () => {
    const { lute } = patched('ir')
    const markdown = lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(FIXTURE))
    expect(markdown).toContain('A paragraph with `a|b` in code')
    expect(markdown).toContain(
      '```text\n| not | a | table |\n|---|---|---|\n| `a | b` | c | d |\n```',
    )
  })
})

describe('createIncrementalMd with the patched IR serializer', () => {
  const topBlocks = (html: string): string[] =>
    Array.from(parse(html).children).map((child) => child.outerHTML)

  it('equals the full serialize after a cell edit and keeps the I57 row whole', () => {
    const { lute } = patched('ir')
    const serialize = (html: string) => lute.VditorIRDOM2Md(html) as string
    const blocks = topBlocks(lute.Md2VditorIRDOM(FIXTURE))
    const engine = createIncrementalMd(serialize)
    engine.reset(blocks)

    // The user types one character at the start of the I56 first cell: the block is edited, then
    // spun, and the spin result replaces the block (ir/input.ts).
    const tableAt = blocks.findIndex((b) => b.startsWith('<table'))
    const edited = parse(blocks[tableAt])
    const cell = Array.from(edited.querySelectorAll('td')).find(
      (td) => td.textContent === 'I56',
    )
    expect(cell).toBeDefined()
    if (cell) cell.textContent = 'QI56'
    const spun = parse(lute.SpinVditorIRDOM(edited.innerHTML)).firstElementChild
    const next = blocks.slice()
    next[tableAt] = spun?.outerHTML ?? ''

    const incremental = engine.update(next)
    const full = serialize(next.join(''))
    expect(incremental).toBe(full)
    expect(full).toContain('QI56')
    const line = squash(lineOf(full, 'I57'))
    expect(line).toContain(`\`${CODE_I57}\``)
    expect(line).toContain('[F11](../F11-sample-custom-kind.md) |')
  })
})

describe('WYSIWYG serialize is not double-escaped', () => {
  it('shows the I57 row whole in the WYSIWYG DOM', () => {
    const { lute } = patched('wysiwyg')
    const root = parse(lute.Md2VditorDOM(FIXTURE))
    expect(rowOf(root, 'I57')).toEqual({ cells: 5, cell3Code: CODE_I57 })
  })

  it('writes a code-span pipe with exactly one backslash', () => {
    const { lute } = patched('wysiwyg')
    const markdown = lute.VditorDOM2Md(lute.Md2VditorDOM(FIXTURE))
    expect(markdown).not.toContain('\\\\|')
    expect(squash(lineOf(markdown, 'I57'))).toContain(`\`${CODE_I57}\``)
    expect(lineOf(markdown, 'E1')).toContain('`x \\| y`')
    expect(lineOf(markdown, 'E2')).toContain('``a \\| b``')
  })

  it('does not apply the IR DOM escape to a WYSIWYG code element (guard)', () => {
    const { lute } = patched('wysiwyg')
    const html =
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code data-marker="`">x | y</code></td><td>c</td></tr></tbody></table>'
    expect(lute.VditorDOM2Md(html)).toContain('`x \\| y`')
    expect(lute.VditorDOM2Md(html)).not.toContain('\\\\|')
  })
})
