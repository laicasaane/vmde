// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { spinCellHtml } from '../bridge/unit-lute'
import { createRealLute } from '../testing/real-lute'
import { fakeLanes, costClock } from '../testing/budget-harness'
import type { LiveUnit } from '../util/unit-changes'
import { spinUnit, type UnitSpinDeps, type UnitSpinResult } from './unit-spin'

// Task 733 / 017-T1 (task 017 sections 6.4, 6.7, 6.8, 6.12): unit spins of `definition` and `footnote`
// units, definition context in cell spins, and the context strip (B-D3). Fails before 017-I1/I2: the
// spin rules for the new kinds do not exist (the root block is refused), `spinCellHtml` ignores a
// context, and `B/definition-units.ts`, `B/definition-index.ts` and `U/background-budget.ts` are
// missing (loaded at run time so the file fails by assertion).

interface DefinitionContext {
  readonly html: string
  readonly blocks: number
}
interface FootnoteInfo {
  readonly number: number
  readonly tooltip: string
}
interface Helpers {
  spinDefinitionHtml(lute: unknown, defOuterHtml: string): UnitSpinResult
  spinFootnoteHtml(
    lute: unknown,
    shellOpenTag: string,
    defOuterHtml: string,
    context?: DefinitionContext,
  ): UnitSpinResult
  stripDefinitionContext(
    html: string,
    context: DefinitionContext,
    footnoteOf: (label: string) => FootnoteInfo | undefined,
  ): string | undefined
  createDefinitionIndex(deps: Record<string, unknown>): {
    contextFor(source: string): DefinitionContext | undefined
    footnoteOf(label: string): FootnoteInfo | undefined
  }
  createBackgroundScheduler(deps: unknown): unknown
}

const UNITS_MODULE = '../bridge/definition-units'
const INDEX_MODULE = '../bridge/definition-index'
const BUDGET_MODULE = '../util/background-budget'
let helpers: Helpers | undefined
let lute: {
  SpinVditorIRDOM(html: string): string
  Md2VditorIRDOM(md: string): string
}
beforeAll(async () => {
  const real = createRealLute('ir')
  patchLuteGapRepair(real.lute)
  lute = real.lute
  try {
    const units = await import(/* @vite-ignore */ UNITS_MODULE)
    const index = await import(/* @vite-ignore */ INDEX_MODULE)
    const budget = await import(/* @vite-ignore */ BUDGET_MODULE)
    helpers = { ...units, ...index, ...budget } as Helpers
  } catch {
    helpers = undefined
  }
})

const need = (): Helpers => {
  expect(
    helpers,
    'B/definition-units.ts, B/definition-index.ts (017-I1) and U/background-budget.ts exist',
  ).toBeDefined()
  return helpers as Helpers
}

/** An index over `markdown` (top-level blocks become units), with its reference job run to the end. */
function indexOver(markdown: string) {
  const h = need()
  const root = document.createElement('div')
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  const blocks = markdown.split(/\n{2,}/u)
  const units: LiveUnit[] = []
  const bytes = new Map<HTMLElement, string>()
  let source = 0
  for (const child of Array.from(root.children) as HTMLElement[]) {
    const notes = child.getAttribute('data-type') === 'footnotes-block'
    const members = notes
      ? (Array.from(child.children) as HTMLElement[])
      : [child]
    for (const el of members) {
      const type = el.getAttribute('data-type')
      const kind =
        type === 'link-ref-defs-block'
          ? 'definition'
          : type === 'footnotes-def'
            ? 'footnote'
            : 'paragraph'
      units.push({
        el,
        members: [el],
        kind: kind as LiveUnit['kind'],
        top: child,
      })
      bytes.set(el, blocks[source++] ?? '')
    }
  }
  const lanes = fakeLanes(costClock())
  const index = h.createDefinitionIndex({
    units: () => units,
    bytesOf: (el: HTMLElement) => bytes.get(el),
    rerender: () => true,
    setFootnoteTooltip: () => undefined,
    scheduler: h.createBackgroundScheduler(lanes),
  })
  for (let i = 0; i < 200; i++) lanes.runIdle(8)
  return index
}

const DEFS = '[spec]: https://example.com/spec\n\n[^a]: First.\n\n[^b]: Second.'

function rootWith(html: string): HTMLElement {
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.innerHTML = html
  document.body.replaceChildren(root)
  return root
}

const baseDeps = (unit: LiveUnit | undefined) => ({
  liveUnitOf: () => unit,
  spinCell: () => ({ kind: 'refused', reason: 'shape' }) as UnitSpinResult,
  spinListItem: () => ({ kind: 'refused', reason: 'shape' }) as UnitSpinResult,
  spinListItems: () => ({ kind: 'refused', reason: 'shape' }) as UnitSpinResult,
  isSettleRespin: () => false,
  listItemSpin: true,
  isModelLive: () => true,
})

function caretIn(node: Node, offset = 0): Range {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  return range
}

const typed = new InputEvent('input', { inputType: 'insertText', data: 'x' })

describe('spinUnit for a definition unit (rule 1 branch, section 6.4)', () => {
  it('spins the definitions div alone when the upstream widening made the root the block', () => {
    const root = rootWith(
      '<p data-block="0">a</p><div data-block="0" data-type="link-ref-defs-block">[d]: http://d<wbr>\n</div>',
    )
    const div = root.children[1] as HTMLElement
    const unit: LiveUnit = {
      el: div,
      members: [div],
      kind: 'definition' as LiveUnit['kind'],
      top: div,
    }
    const spun: string[] = []
    const deps = {
      ...baseDeps(unit),
      spinDefinition: (html: string): UnitSpinResult => {
        spun.push(html)
        return {
          kind: 'spun',
          html: '<div data-block="0" data-type="link-ref-defs-block">[d]: http://dx<wbr>\n</div>',
        }
      },
    }
    expect(
      spinUnit(
        deps as UnitSpinDeps,
        caretIn(div.firstChild as Text, 5),
        root,
        typed,
      ),
    ).toBe(true)
    expect(spun).toHaveLength(1)
    expect(root.children[1].textContent).toContain('http://dx')
    expect(root.children[0].textContent).toBe('a')
  })

  it('a shape refusal lets the whole-root spin run', () => {
    const root = rootWith(
      '<div data-block="0" data-type="link-ref-defs-block">[d]: http://d "t"<wbr>\n</div>',
    )
    const div = root.children[0] as HTMLElement
    const unit = {
      el: div,
      members: [div],
      kind: 'definition',
      top: div,
    } as unknown as LiveUnit
    const deps = {
      ...baseDeps(unit),
      spinDefinition: (): UnitSpinResult => ({
        kind: 'refused',
        reason: 'shape',
      }),
    }
    expect(
      spinUnit(
        deps as UnitSpinDeps,
        caretIn(div.firstChild as Text, 3),
        root,
        typed,
      ),
    ).toBe(false)
  })
})

describe('spinUnit for a footnote unit (rule 3b, section 6.4)', () => {
  it('spins the footnote definition in its block shell and replaces only that definition', () => {
    const root = rootWith(
      '<div data-block="0" data-type="footnotes-block"><div data-type="footnotes-def">[^1]: <p data-block="0">one</p></div><div data-type="footnotes-def">[^2]: <p data-block="0">two<wbr></p></div></div>',
    )
    const block = root.children[0] as HTMLElement
    const def = block.children[1] as HTMLElement
    const inner = def.querySelector('p') as HTMLElement
    const unit = {
      el: def,
      members: [def],
      kind: 'footnote',
      top: block,
    } as unknown as LiveUnit
    const calls: string[][] = []
    const deps = {
      ...baseDeps(unit),
      spinFootnote: (shell: string, html: string): UnitSpinResult => {
        calls.push([shell, html])
        return {
          kind: 'spun',
          html: '<div data-type="footnotes-def">[^2]: <p data-block="0">twox<wbr></p></div>',
        }
      },
    }
    expect(
      spinUnit(
        deps as UnitSpinDeps,
        caretIn(inner.firstChild as Text, 3),
        inner,
        typed,
      ),
    ).toBe(true)
    expect(calls[0][0]).toMatch(
      /^<div data-block="0" data-type="footnotes-block">$/u,
    )
    expect(block.children).toHaveLength(2)
    expect(block.children[0].textContent).toContain('one')
    expect(block.children[1].textContent).toContain('twox')
  })
})

describe('Lute spin helpers (sections 6.1 fact 6 and 6.7)', () => {
  it('a definition spins alone; a titled definition with the caret after the title is a shape refusal', () => {
    const { spinDefinitionHtml } = need()
    expect(
      spinDefinitionHtml(
        lute,
        '<div data-block="0" data-type="link-ref-defs-block">[d]: http://d<wbr>\n</div>',
      ).kind,
    ).toBe('spun')
    expect(
      spinDefinitionHtml(
        lute,
        '<div data-block="0" data-type="link-ref-defs-block">[d]: http://d "t"<wbr>\n</div>',
      ),
    ).toEqual({ kind: 'refused', reason: 'shape' })
  })

  it('a footnote definition spins in its shell to one definition', () => {
    const result = need().spinFootnoteHtml(
      lute,
      '<div data-block="0" data-type="footnotes-block">',
      '<div data-type="footnotes-def">[^2]: <p data-block="0">two x<wbr></p></div>',
    )
    expect(result.kind).toBe('spun')
    const holder = document.createElement('div')
    holder.innerHTML = result.kind === 'spun' ? result.html : ''
    expect(holder.querySelectorAll('[data-type="footnotes-def"]')).toHaveLength(
      1,
    )
  })
})

describe('definition context in spins (sections 6.3 and 6.4)', () => {
  it('a cell spun with its context renders its reference', () => {
    const context = indexOver(DEFS).contextFor('see [spec]')
    expect(context?.blocks).toBe(1)
    const spin = spinCellHtml as unknown as (
      l: unknown,
      html: string,
      c?: DefinitionContext,
    ) => UnitSpinResult
    const result = spin(lute, 'see [spec]<wbr>', context)
    expect(result.kind).toBe('spun')
    expect(result.kind === 'spun' ? result.html : '').toContain(
      'data-type="link-ref"',
    )
  })

  it('the strip removes the context and numbers footnote references globally', () => {
    const h = need()
    const index = indexOver(DEFS)
    const block = '<p data-block="0">see [spec] and [^b]<wbr></p>'
    const context = index.contextFor('see [spec] and [^b]') as DefinitionContext
    const stripped = h.stripDefinitionContext(
      lute.SpinVditorIRDOM(block + context.html),
      context,
      (label) => index.footnoteOf(label),
    )
    const holder = document.createElement('div')
    holder.innerHTML = stripped ?? ''
    expect(Array.from(holder.children, (c) => c.tagName)).toEqual(['P'])
    expect(holder.querySelector('[data-type="link-ref"]')).not.toBeNull()
    expect(
      holder.querySelector('sup[data-footnotes-label="^b"] [data-render]')
        ?.textContent,
    ).toBe('2')
    expect(
      holder
        .querySelector('sup[data-footnotes-label="^b"]')
        ?.getAttribute('aria-label'),
    ).toBe('Second.')
  })

  // B-D3 (section 6.8; Q-123 design 13.16): the vendored Lute keeps a definition the user typed into the
  // spun unit before the sentinel, so the strip succeeds: the typed definition stays in the unit's
  // position and the context is gone, nothing lost or duplicated.
  it.each([
    [
      'a footnote definition typed at the end of the block',
      '<p data-block="0">x [^a]</p><p data-block="0">[^c]: typed<wbr></p>',
      'x [^a]\n\n[^c]: typed',
    ],
    [
      'a link definition typed in a new paragraph of the block',
      '<p data-block="0">x [spec]</p><p data-block="0">[new]: http://n<wbr></p>',
      'x [spec]\n\n[new]: http://n',
    ],
  ])('B-D3: %s keeps the typed definition in place', (_name, block, source) => {
    const h = need()
    const index = indexOver(DEFS)
    const context = index.contextFor(source) as DefinitionContext
    expect(context).toBeDefined()
    const stripped = h.stripDefinitionContext(
      lute.SpinVditorIRDOM(block + context.html),
      context,
      (label) => index.footnoteOf(label),
    )
    expect(stripped).toBeDefined()
    const holder = document.createElement('div')
    holder.innerHTML = stripped ?? ''
    expect(holder.textContent).not.toContain('VMDEDEFINITIONCONTEXTSENTINEL')
    expect(holder.children).toHaveLength(2)
    expect(holder.children[0].tagName).toBe('P')
    const typed = holder.children[1]
    expect(typed.textContent).toContain(source.split('\n\n')[1])
    // The context's own definitions are not in the result (no duplicate).
    expect(holder.textContent).not.toContain('https://example.com/spec')
    expect(holder.textContent).not.toContain('First.')
  })

  // B-D3 refusal: a spin result whose context part does not match the context (here one context block is
  // missing) makes the strip refuse, so the patch spins again without context.
  it('B-D3: an injected mismatch after the sentinel makes the strip refuse', () => {
    const h = need()
    const index = indexOver(DEFS)
    const context = index.contextFor('x [spec] and [^a]') as DefinitionContext
    expect(context.blocks).toBe(2)
    const spun = lute.SpinVditorIRDOM(
      `<p data-block="0">x [spec] and [^a]<wbr></p>${context.html}`,
    )
    const cut = spun.lastIndexOf(
      '<div data-block="0" data-type="footnotes-block">',
    )
    expect(cut).toBeGreaterThan(0)
    expect(
      h.stripDefinitionContext(spun.slice(0, cut), context, (label) =>
        index.footnoteOf(label),
      ),
    ).toBeUndefined()
  })
})
