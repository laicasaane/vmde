// @vitest-environment jsdom

// Task 643 step 1 (RED): the pure planner behind chunked full-Preview rendering, and the invariant
// it exists for — chunked HTML equals one-pass `Md2HTML` of the same masked text, including
// reference links and footnotes whose definitions sit in another chunk.
import fs from 'node:fs'
import vm from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'
import { maskCommentsForPreview } from '../editing/html-comment'
import { maskSvgDataImagesForPreview } from '../editing/svg-data-image-adapter'
import {
  markRawHeadingsForPreview,
  markRawHtmlForPreview,
} from '../nav/preview-raw-headings'
import {
  maskPreviewSource,
  renderPreviewUnits,
} from '../editing/preview-render'
import {
  PREVIEW_FIRST_CHUNK_CHARS,
  PREVIEW_STREAM_CHUNK_CHARS,
  PREVIEW_STREAM_MIN_CHARS,
  planPreviewChunks,
  shouldStreamPreview,
} from './preview-chunk'
import { normLabel } from './stream-chunk'

interface RealLute {
  Md2HTML(markdown: string): string
  SetSoftBreak2HardBreak(enabled: boolean): void
}

// The build installs this committed pin into media/vditor; read the source so unit tests stay pre-build.
const LUTE_PATH = `${process.cwd()}/media-src/vendor/lute/lute.min.js`
let lute: RealLute

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
  vm.runInContext(fs.readFileSync(LUTE_PATH, 'utf8'), sandbox, {
    filename: 'lute.min.js',
  })
  lute = (sandbox as { Lute: { New(): RealLute } }).Lute.New()
})

// Enough distinct prose to push a document past several 16,000-character chunks.
const filler = (label: string, chars: number): string => {
  const lines: string[] = []
  for (let i = 0; lines.join('\n\n').length < chars; i++)
    lines.push(
      `${label} paragraph ${i} carries **bold**, a [link](./x.md) and enough plain words to be realistic prose.`,
    )
  return lines.join('\n\n')
}

// DOM serialization both sides pass through, so the comparison ignores void-tag spelling only.
const normalized = (html: string): string => {
  const holder = document.createElement('div')
  holder.innerHTML = html
  return holder.innerHTML
}

const onePass = (markdown: string): string => {
  lute.SetSoftBreak2HardBreak(true)
  return normalized(lute.Md2HTML(markdown))
}

const chunked = (markdown: string): { html: string; units: number } => {
  const units = renderPreviewUnits(lute, markdown)
  return { html: normalized(units.join('')), units: units.length }
}

describe('preview streaming constants', () => {
  it('streams above 50,000 characters in 16,000-character chunks', () => {
    expect(PREVIEW_STREAM_MIN_CHARS).toBe(50_000)
    expect(PREVIEW_STREAM_CHUNK_CHARS).toBe(16_000)
  })

  it('decides on a strict greater-than at the threshold', () => {
    expect(shouldStreamPreview(0)).toBe(false)
    expect(shouldStreamPreview(50_000)).toBe(false)
    expect(shouldStreamPreview(50_001)).toBe(true)
  })
})

describe('maskPreviewSource', () => {
  it('applies the comment mask, then raw-heading and raw-HTML marks, then SVG data-image masks', () => {
    const md = [
      '# Title',
      '',
      '<!-- a block comment -->',
      '',
      '<h2 id="raw">raw heading</h2>',
      '',
      '![](data:image/svg+xml;base64,PHN2Zy8+)',
      '',
    ].join('\n')
    expect(maskPreviewSource(md)).toBe(
      maskSvgDataImagesForPreview(
        markRawHtmlForPreview(
          markRawHeadingsForPreview(maskCommentsForPreview(md)),
        ),
      ),
    )
  })

  it('changes a document that has a block comment', () => {
    const md = 'before\n\n<!-- hidden -->\n\nafter\n'
    expect(maskPreviewSource(md)).not.toBe(md)
  })
})

describe('planPreviewChunks', () => {
  it('returns one chunk, no footnote data and no section for a short plain document', () => {
    const md = 'one paragraph\n\nanother paragraph\n'
    const plan = planPreviewChunks(md)
    expect(plan.chunks.map((chunk) => chunk.source)).toEqual([md])
    expect(plan.chunks[0].footnoteOrder).toEqual([])
    expect(plan.footnoteNumbers.size).toBe(0)
    expect(plan.footnoteSection).toBeNull()
  })

  it('is lossless at the default 16,000-character size and splits a 50 KB document', () => {
    const md = filler('lossless', 50_000)
    const plan = planPreviewChunks(md)
    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.map((chunk) => chunk.source).join('')).toBe(md)
    for (const chunk of plan.chunks)
      expect(chunk.source.length).toBeLessThanOrEqual(
        PREVIEW_STREAM_CHUNK_CHARS,
      )
  })

  it('starts with a small first chunk so the first paint is quick', () => {
    const plan = planPreviewChunks(filler('first', 40_000))
    expect(plan.chunks[0].source.length).toBeLessThanOrEqual(
      PREVIEW_FIRST_CHUNK_CHARS,
    )
    expect(plan.chunks[1].source.length).toBeGreaterThan(
      PREVIEW_FIRST_CHUNK_CHARS,
    )
  })

  it('honours an explicit chunk size', () => {
    const md = filler('sized', 12_000)
    const small = planPreviewChunks(md, 2_000)
    expect(small.chunks.length).toBeGreaterThan(
      planPreviewChunks(md).chunks.length,
    )
    expect(small.chunks.map((chunk) => chunk.source).join('')).toBe(md)
  })

  it('keeps a list run and an unclosed-fence-safe cut intact across chunks', () => {
    const list = Array.from({ length: 400 }, (_, i) => `- item ${i}`).join('\n')
    const md = `${filler('before', 9_000)}\n\n${list}\n\n${filler('after', 9_000)}\n`
    const plan = planPreviewChunks(md, 4_000)
    const holder = plan.chunks.find((chunk) =>
      chunk.source.includes('- item 0'),
    )
    expect(holder?.source).toContain('- item 399')
    for (const chunk of plan.chunks)
      expect((chunk.source.match(/^```/gm) ?? []).length % 2).toBe(0)
  })

  describe('footnotes', () => {
    // References cite b before a; definitions are a then b then c (unused). Lute numbers by
    // DEFINITION order, so the global numbers must be a=1, b=2, c=3.
    const md = [
      'First cites [^b] early.',
      '',
      filler('gap-one', 700),
      '',
      'Second cites [^a] and [^b] again.',
      '',
      filler('gap-two', 700),
      '',
      '[^a]: Note a.',
      '[^b]: Note b.',
      '[^c]: Note c is never cited.',
      '',
    ].join('\n')

    it('numbers footnotes by definition order over the whole document', () => {
      const plan = planPreviewChunks(md, 600)
      expect(plan.chunks.length).toBeGreaterThan(2)
      expect([...plan.footnoteNumbers.entries()]).toEqual([
        ['^a', 1],
        ['^b', 2],
        ['^c', 3],
      ])
    })

    it('lists, per chunk, the footnote labels Lute will see: own definitions first, then injected ones', () => {
      const plan = planPreviewChunks(md, 600)
      for (const chunk of plan.chunks) {
        const cited = [...chunk.source.matchAll(/\[\^([^\]]+)\](?!:)/g)].map(
          (match) => `^${normLabel(match[1])}`,
        )
        const defined = [...chunk.source.matchAll(/^\[\^([^\]]+)\]:/gm)].map(
          (match) => `^${normLabel(match[1])}`,
        )
        const expected = new Set([...defined, ...cited])
        expect(new Set(chunk.footnoteOrder)).toEqual(expected)
        expect(chunk.footnoteOrder.length).toBe(expected.size)
        // Own definitions come first, in line order.
        expect(chunk.footnoteOrder.slice(0, defined.length)).toEqual(defined)
      }
    })

    it('builds a footnote section whose rendered definitions equal the one-pass definitions', () => {
      const plan = planPreviewChunks(md, 600)
      expect(plan.footnoteSection).not.toBeNull()
      const defsOf = (html: string): string => {
        const holder = document.createElement('div')
        holder.innerHTML = html
        return holder.querySelector('.footnotes-defs-div')?.outerHTML ?? ''
      }
      lute.SetSoftBreak2HardBreak(true)
      const expected = defsOf(lute.Md2HTML(md))
      expect(expected).toContain('footnotes-def-3')
      expect(defsOf(lute.Md2HTML(plan.footnoteSection ?? ''))).toBe(expected)
    })

    it('carries a link reference cited inside a footnote into the section', () => {
      const withRef = [
        'Cites [^n].',
        '',
        filler('between', 800),
        '',
        '[^n]: Footnote with [a link][r1].',
        '',
        '[r1]: https://example.com/r1',
        '',
      ].join('\n')
      const plan = planPreviewChunks(withRef, 600)
      const holder = document.createElement('div')
      lute.SetSoftBreak2HardBreak(true)
      holder.innerHTML = lute.Md2HTML(plan.footnoteSection ?? '')
      expect(
        holder.querySelector(
          '.footnotes-defs-div a[href="https://example.com/r1"]',
        ),
      ).not.toBeNull()
    })
  })
})

describe('chunked Preview HTML equals one-pass Md2HTML', () => {
  it('for plain multi-chunk prose', () => {
    const md = `${filler('plain', 40_000)}\n`
    const result = chunked(md)
    expect(result.units).toBeGreaterThan(1)
    expect(result.html).toBe(onePass(md))
  })

  it('for a reference link used in an early chunk and defined at the end', () => {
    const md = [
      'Early use of [the site][home] and a collapsed [Home][].',
      '',
      filler('refs', 40_000),
      '',
      '[home]: https://example.com/home "Home"',
      '',
    ].join('\n')
    const result = chunked(md)
    expect(result.units).toBeGreaterThan(1)
    expect(result.html).toContain('href="https://example.com/home"')
    expect(result.html).toBe(onePass(md))
  })

  it('for a footnote defined in a later chunk than its reference', () => {
    const md = [
      'Early reference[^late].',
      '',
      filler('late', 40_000),
      '',
      '[^late]: The note lives in the last chunk.',
      '',
    ].join('\n')
    const result = chunked(md)
    expect(result.units).toBeGreaterThan(1)
    expect(result.html).toBe(onePass(md))
  })

  it('for repeated references across chunks, an unused definition and a definition-order that differs from reference order', () => {
    const md = [
      'First cites [^b].',
      '',
      filler('one', 20_000),
      '',
      'Middle cites [^a] then [^b] again.',
      '',
      filler('two', 20_000),
      '',
      'Last cites [^b] a third time.',
      '',
      '[^a]: Note a.',
      '[^b]: Note b.',
      '[^c]: Note c is never cited.',
      '',
    ].join('\n')
    const result = chunked(md)
    expect(result.units).toBeGreaterThan(2)
    expect(result.html).toContain('id="footnotes-ref-2:3"')
    expect(result.html).toBe(onePass(md))
  })

  it('for a reference with no definition, which stays literal text', () => {
    const md = [
      'A dangling [text][nowhere] and [^missing] stay literal.',
      '',
      filler('dangling', 40_000),
      '',
    ].join('\n')
    const result = chunked(md)
    expect(result.html).toContain('[text][nowhere]')
    expect(result.html).toBe(onePass(md))
  })

  it('for a footnote that cites a link reference defined in another chunk', () => {
    const md = [
      'Cites [^n].',
      '',
      filler('crossref', 40_000),
      '',
      '[^n]: Footnote with [a link][r1].',
      '',
      '[r1]: https://example.com/r1',
      '',
    ].join('\n')
    const result = chunked(md)
    expect(result.html).toBe(onePass(md))
  })
})
