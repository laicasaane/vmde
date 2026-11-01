import { describe, expect, it } from 'vitest'
import {
  STREAM_CHUNK_CHARS,
  buildDefMap,
  chunkize,
  definedIn,
  externalDefsFor,
  usedIn,
} from './stream-chunk'

// chunkize is the one safety-critical pure function: wrong boundaries would either
// lose/duplicate content (corruption) or split a code fence (the tail of the doc
// rendered as one giant code block). The full DOM-assembly correctness (assembled IR
// === monolithic) is validated separately by bench-refs-chunking.mjs.

const prose = (kb: number) =>
  'lorem ipsum dolor sit amet consectetur adipiscing elit\n\n'.repeat(
    Math.ceil((kb * 1024) / 55),
  )

const fenceCount = (s: string) => (s.match(/^```/gm) || []).length

describe('chunkize', () => {
  it('returns the doc unchanged as a single chunk when within the cap', () => {
    const md = prose(2) // < 4 KB
    expect(md.length).toBeLessThanOrEqual(STREAM_CHUNK_CHARS)
    expect(chunkize(md)).toEqual([md])
  })

  it('is lossless — concatenating the chunks reproduces the input exactly', () => {
    for (const md of [prose(50), prose(200), prose(13)]) {
      expect(chunkize(md).join('')).toBe(md)
    }
  })

  it('splits large docs into multiple chunks', () => {
    expect(chunkize(prose(50)).length).toBeGreaterThan(1)
  })

  it('never emits an empty chunk', () => {
    for (const chunk of chunkize(prose(60))) {
      expect(chunk.length).toBeGreaterThan(0)
    }
  })

  it('never leaves a chunk with a dangling (odd) code fence', () => {
    const block = `\`\`\`js\n${'const x = 1\n'.repeat(20)}\`\`\`\n\n`
    const md = block.repeat(40) // well over the cap, fences everywhere
    const chunks = chunkize(md)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(md) // still lossless
    for (const chunk of chunks) {
      expect(fenceCount(chunk) % 2).toBe(0) // balanced fences in every chunk
    }
  })

  it('handles a single line longer than the cap without looping or losing data', () => {
    const md = 'x'.repeat(STREAM_CHUNK_CHARS * 2 + 123) // no newline to cut on
    const chunks = chunkize(md)
    expect(chunks.join('')).toBe(md)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('never splits a loose list run across chunks', () => {
    const prefix = `${prose(3)}Outside paragraph before the list.\n\n`
    const list = Array.from(
      { length: 45 },
      (_, index) =>
        `- item ${index + 1} ${'list continuation words '.repeat(3)}\n\n  detail ${index + 1}`,
    ).join('\n\n')
    const suffix = `\n\nOutside paragraph after the list.\n\n${prose(3)}`
    const markdown = prefix + list + suffix
    const chunks = chunkize(markdown)

    expect(chunks.join('')).toBe(markdown)
    expect(chunks.filter((chunk) => chunk.includes('- item '))).toHaveLength(1)
    expect(chunks.find((chunk) => chunk.includes('- item '))).toContain(list)
  })

  it('keeps lazy continuation and blockquoted list runs intact', () => {
    const prefix = `${prose(3)}Boundary lead.\n\n`
    const list = Array.from(
      { length: 40 },
      (_, index) =>
        `> - quoted item ${index + 1}\n> lazy continuation ${index + 1}\n\n>   indented detail ${index + 1}`,
    ).join('\n\n')
    const markdown = `${prefix}${list}\n\nOutside after a blank.\n\n${prose(3)}`
    const chunks = chunkize(markdown)

    expect(chunks.join('')).toBe(markdown)
    expect(
      chunks.filter((chunk) => chunk.includes('> - quoted item')),
    ).toHaveLength(1)
    expect(chunks.find((chunk) => chunk.includes('> - quoted item'))).toContain(
      list,
    )
  })
})

// Task 643: full Preview chunks at 16,000 characters; the edit modes keep the 4,000 default.
describe('chunkize size parameter', () => {
  it('defaults to STREAM_CHUNK_CHARS', () => {
    const md = prose(60)
    expect(chunkize(md)).toEqual(chunkize(md, STREAM_CHUNK_CHARS))
  })

  it('is lossless at a larger size and yields fewer, larger chunks', () => {
    const md = prose(80)
    const large = chunkize(md, 16_000)
    expect(large.join('')).toBe(md)
    expect(large.length).toBeGreaterThan(1)
    expect(large.length).toBeLessThan(chunkize(md).length)
    for (const chunk of large) expect(chunk.length).toBeLessThanOrEqual(16_000)
  })

  it('never leaves a dangling code fence at a larger size', () => {
    const block = '```ts\nconst value = 1\n```\n\n'
    const md = (prose(1) + block).repeat(40)
    const chunks = chunkize(md, 16_000)
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeGreaterThan(
      STREAM_CHUNK_CHARS,
    )
    for (const chunk of chunks) expect(fenceCount(chunk) % 2).toBe(0)
  })

  it('keeps a list run whole at a larger size', () => {
    const list = Array.from(
      { length: 500 },
      (_, index) => `- item ${index}`,
    ).join('\n')
    const md = `${prose(14)}${list}\n\n${prose(14)}`
    const chunks = chunkize(md, 16_000)
    expect(chunks.join('')).toBe(md)
    expect(chunks.filter((chunk) => chunk.includes('- item '))).toHaveLength(1)
    expect(chunks.length).toBeLessThan(chunkize(md).length)
  })
})

describe('reference-definition extraction', () => {
  const doc = [
    'Uses [a link][ref1] and a footnote[^fn1].',
    '',
    '[ref1]: https://example.com/1',
    '[^fn1]: footnote body',
    '    with a continuation line.',
    '',
    'A [Collapsed][] ref and a SHORTCUT-style.',
    '',
    '[collapsed]: https://example.com/c',
  ].join('\n')

  it('maps link and footnote defs (footnotes keyed with ^, continuation captured)', () => {
    const map = buildDefMap(doc)
    expect(map.get('ref1')).toBe('[ref1]: https://example.com/1')
    expect(map.get('collapsed')).toBe('[collapsed]: https://example.com/c')
    expect(map.get('^fn1')).toBe(
      '[^fn1]: footnote body\n    with a continuation line.',
    )
  })

  it('normalizes labels case-insensitively for use vs definition', () => {
    expect(usedIn('see [x][Ref1] here')).toContain('ref1')
    expect(definedIn('[REF1]: https://example.com/1')).toContain('ref1')
  })

  it('externalDefsFor injects only cited defs not defined in the chunk', () => {
    const map = buildDefMap(doc)
    // chunk cites ref1 + fn1 but defines neither → both are external
    const ext = externalDefsFor('Uses [a link][ref1] and a note[^fn1].', map)
    expect(ext.linkLabels).toEqual(new Set(['ref1']))
    expect(ext.fnLabels).toEqual(new Set(['^fn1']))
    expect(ext.text).toContain('[ref1]: https://example.com/1')
    expect(ext.text).toContain('[^fn1]: footnote body')
  })

  it('does not inject a def the chunk already defines itself', () => {
    const map = buildDefMap(doc)
    const ext = externalDefsFor(
      'Uses [a link][ref1].\n\n[ref1]: https://example.com/1',
      map,
    )
    expect(ext.text).toBe('')
    expect(ext.linkLabels.size).toBe(0)
  })
})
