// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type MovableBlock,
  scanMovableBlocks,
} from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { definitionHeavyMarkdown } from '../../../test/vscode-e2e/definition-heavy-markdown'
import { domKind } from '../nav/unit-pairing'
import { createRealLute } from '../testing/real-lute'
import { createTextModel } from './text-model'
import { createUnitDom } from './unit-dom'
import type { UnitLute } from './unit-lute'

// Task 733 / 017 (Q-130): DEFINITION_UNITS ships false until the definition path is proven in VS Code;
// these tests prove that path, so they read the constant as true (the guard-off cases pass `false`).
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  DEFINITION_UNITS: true,
}))

// Task 733 / 017-T1 (task 017 sections 6.2, 6.8, 6.12): the model-only kinds `definition`, `footnote`
// and `toc`. The first block pins the vendored Lute facts the design rests on (they pass today). The
// others fail before 017-I1: the module `B/definition-units.ts` does not exist (loaded at run time so
// the file fails by assertion, not by an import error), and the model over a document with
// definitions turns off with 'unit-without-kind'.

const MODULE = './definition-units'
interface DefinitionUnitsModule {
  scanModelBlocks(
    text: string,
    options: { toc: boolean; definitionUnits?: boolean },
  ): MovableBlock[]
  unitKindOf(element: HTMLElement, definitionUnits?: boolean): string | null
  normalizeLabel(label: string): string
  referencedLabels(source: string):
    | {
        readonly links: readonly string[]
        readonly footnotes: readonly string[]
      }
    | undefined
  serializeFootnoteHtml(
    lute: UnitLute,
    shellOpenTag: string,
    defOuterHtml: string,
  ): string
}
let loaded: DefinitionUnitsModule | undefined
let lute: UnitLute & {
  SetToC(on: boolean): void
  SpinVditorIRDOM(html: string): string
}

beforeAll(async () => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  real.lute.SetToC(true)
  lute = real.lute
  try {
    loaded = await import(/* @vite-ignore */ MODULE)
  } catch {
    loaded = undefined
  }
})

const units = (): DefinitionUnitsModule => {
  expect(loaded, 'B/definition-units.ts exists (017-I1)').toBeDefined()
  return loaded as DefinitionUnitsModule
}

/** Top-level element types of an IR render, in DOM order. */
function topTypes(html: string): string[] {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return Array.from(
    holder.children,
    (child) => child.getAttribute('data-type') ?? child.tagName.toLowerCase(),
  )
}

const kindsOf = (text: string, blocks: readonly MovableBlock[]) =>
  blocks.map((block) => [block.kind, text.slice(block.start, block.end)])

describe('vendored Lute facts (pinned, section 6.1 and 6.12)', () => {
  it('render keeps definitions and footnotes in source position, one div per definition line', () => {
    const html = lute.Md2VditorIRDOM(
      'a\n\n[x]: http://x\n[y]: http://y\n\nb\n\n[^1]: one\n\n[^2]: two\n\nc\n\n[^3]: three\n',
    )
    expect(topTypes(html)).toEqual([
      'p',
      'link-ref-defs-block',
      'link-ref-defs-block',
      'p',
      'footnotes-block',
      'p',
      'footnotes-block',
    ])
    const holder = document.createElement('div')
    holder.innerHTML = html
    expect(holder.querySelectorAll('[data-type="footnotes-def"]').length).toBe(
      3,
    )
  })

  it('spin moves the definitions of its input after its other blocks (6.12 item 1)', () => {
    const spun = lute.SpinVditorIRDOM(
      '<p data-block="0">a</p><div data-block="0" data-type="link-ref-defs-block">[d]: http://d\n</div><p data-block="0">b<wbr></p>',
    )
    expect(topTypes(spun)).toEqual(['p', 'p', 'link-ref-defs-block'])
  })

  it('one footnote definition serializes cleanly in its block shell; [toc] serializes lower case', () => {
    const html = lute.Md2VditorIRDOM('[^2]: two')
    expect(lute.VditorIRDOM2Md(html).trim()).toBe('[^2]: two')
    expect(lute.VditorIRDOM2Md(lute.Md2VditorIRDOM('[TOC]')).trim()).toBe(
      '[toc]',
    )
  })

  it('a reference renders as a link-ref only when its label is defined', () => {
    expect(lute.Md2VditorIRDOM('See [x][d].')).not.toContain('link-ref')
    expect(lute.Md2VditorIRDOM('See [x][d].\n\n[d]: http://d')).toContain(
      'data-type="link-ref"',
    )
  })
})

describe('scanModelBlocks (section 6.2)', () => {
  it('splits definition lines and keeps the rest of the paragraph as its own block', () => {
    const text = '[a]: http://a\n[b]: http://b\n\n[d]: http://d\nmid para\n'
    expect(kindsOf(text, units().scanModelBlocks(text, { toc: true }))).toEqual(
      [
        ['definition', '[a]: http://a'],
        ['definition', '[b]: http://b'],
        ['definition', '[d]: http://d'],
        ['paragraph', 'mid para'],
      ],
    )
  })

  it('gives each footnote definition its own block and a [toc] line the toc kind when the option is on', () => {
    const text = '[toc]\n\n[^1]: one\n    more\n\n[^2]: two\n'
    expect(kindsOf(text, units().scanModelBlocks(text, { toc: true }))).toEqual(
      [
        ['toc', '[toc]'],
        ['footnote', '[^1]: one\n    more'],
        ['footnote', '[^2]: two'],
      ],
    )
    expect(units().scanModelBlocks(text, { toc: false })[0].kind).toBe(
      'paragraph',
    )
  })

  it.each([
    ['a definition in a list item', '- item\n\n  [d]: http://d\n'],
    ['a definition in a quote', '> [d]: http://d\n'],
    [
      'a definition with its title on the next line',
      '[d]: http://d\n"title"\n',
    ],
    ['a multi-paragraph footnote', '[^1]: one\n\n    more\n'],
  ])('declines %s', (_name, text) => {
    expect(units().scanModelBlocks(text, { toc: true })).toEqual([])
  })

  it('B-D4: with the guard off it equals scanMovableBlocks', () => {
    const text = definitionHeavyMarkdown(1)
    expect(
      units().scanModelBlocks(text, { toc: true, definitionUnits: false }),
    ).toEqual(scanMovableBlocks(text))
  })
})

describe('unitKindOf (section 6.2)', () => {
  const first = (markdown: string, selector?: string): HTMLElement => {
    const holder = document.createElement('div')
    holder.innerHTML = lute.Md2VditorIRDOM(markdown)
    return (
      selector ? holder.querySelector(selector) : holder.firstElementChild
    ) as HTMLElement
  }

  it('names the three model-only kinds and keeps domKind for the others', () => {
    const { unitKindOf } = units()
    expect(unitKindOf(first('[d]: http://d'))).toBe('definition')
    expect(unitKindOf(first('[^1]: one', '[data-type="footnotes-def"]'))).toBe(
      'footnote',
    )
    expect(unitKindOf(first('[toc]'))).toBe('toc')
    expect(unitKindOf(first('para'))).toBe('paragraph')
  })

  it('a definitions div holding several lines (a Vditor merge) has no kind', () => {
    const merged = document.createElement('div')
    merged.setAttribute('data-block', '0')
    merged.setAttribute('data-type', 'link-ref-defs-block')
    merged.textContent = '[a]: http://a\n[b]: http://b\n'
    expect(units().unitKindOf(merged)).toBeNull()
  })

  it('B-D4: with the guard off it equals domKind', () => {
    const element = first('[d]: http://d')
    expect(units().unitKindOf(element, false)).toBe(domKind(element))
    expect(domKind(element)).toBeNull()
  })
})

describe('labels (sections 6.3 and OQ-5)', () => {
  it('normalizes case and white space; lower case of upper case folds ß', () => {
    const { normalizeLabel } = units()
    expect(normalizeLabel('  Foo \n Bar ')).toBe('foo bar')
    expect(normalizeLabel('Straße')).toBe(normalizeLabel('STRASSE'))
  })

  it('lists the referenced link and footnote labels, or undefined for none', () => {
    const { referencedLabels } = units()
    const found = referencedLabels(
      'See [x][Guide] and [spec] and a note[^note].',
    )
    expect(found?.links).toEqual(expect.arrayContaining(['guide', 'spec']))
    expect(found?.footnotes).toEqual(['note'])
    expect(referencedLabels('plain text only')).toBeUndefined()
  })

  it('serializes one footnote definition in its block shell', () => {
    const holder = document.createElement('div')
    holder.innerHTML = lute.Md2VditorIRDOM('[^1]: one\n\n[^2]: two')
    const block = holder.firstElementChild as HTMLElement
    const shell = block.outerHTML.slice(0, block.outerHTML.indexOf('>') + 1)
    const second = block.children[1] as HTMLElement
    expect(
      units().serializeFootnoteHtml(lute, shell, second.outerHTML).trim(),
    ).toBe('[^2]: two')
  })
})

describe('model over the definitions fixture (sections 6.2 and 6.8)', () => {
  const build = (markdown: string) => {
    const root = document.createElement('div')
    root.className = 'vditor-reset vditor-ir'
    root.innerHTML = lute.Md2VditorIRDOM(markdown)
    document.body.append(root)
    const unitDom = createUnitDom(root, lute)
    const scan = loaded
      ? (text: string) => loaded!.scanModelBlocks(text, { toc: true })
      : scanMovableBlocks
    const model = createTextModel(unitDom, scan)
    model.build(markdown)
    return { model, root }
  }

  it('stays live and lists the three kinds in source order', () => {
    const { model } = build(definitionHeavyMarkdown(1))
    expect(model.offReason).toBeUndefined()
    const kinds = model.units.map((unit) => unit.kind as string)
    expect(kinds).toContain('toc')
    expect(kinds.filter((kind) => kind === 'definition')).toHaveLength(2)
    expect(kinds.filter((kind) => kind === 'footnote')).toHaveLength(3)
    // The mid-document definition stays after the second paragraph, not at the end.
    expect(kinds.indexOf('definition')).toBeLessThan(kinds.indexOf('table'))
  })

  it('proves every definition, footnote and toc unit', () => {
    const { model } = build(definitionHeavyMarkdown(1))
    expect(model.offReason).toBeUndefined()
    for (const unit of model.units) {
      if (!['definition', 'footnote', 'toc'].includes(unit.kind as string))
        continue
      expect(model.prove(unit), `${unit.kind} proof`).toBe('proven')
    }
  })

  it('a multi-paragraph footnote keeps the model off (scan-declined)', () => {
    const { model } = build('para [^1]\n\n[^1]: one\n\n    more\n')
    expect(model.offReason).toBe('scan-declined')
  })
})
