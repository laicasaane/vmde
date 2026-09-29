import { expect, it } from 'vitest'
import { alignText } from './find-align'

/** The rendered span for an exact range, or null when it is not one unchanged run of text. */
function mapRange(exact: string, rendered: string, start: number, end: number) {
  const alignment = alignText(exact, rendered)
  const from = alignment.toRendered(start, 'start')
  const to = alignment.toRendered(end, 'end')
  if (from === null || to === null) return null
  return rendered.slice(from, to) === exact.slice(start, end)
    ? [from, to]
    : null
}

function firstInverseMismatch(
  alignment: ReturnType<typeof alignText>,
  exactLength: number,
): { offset: number; bias: 'start' | 'end'; actual: number | null } | null {
  for (let offset = 0; offset <= exactLength; offset++) {
    for (const bias of ['start', 'end'] as const) {
      const renderedOffset = alignment.toRendered(offset, bias)
      if (renderedOffset === null) continue
      const actual = alignment.toExact(renderedOffset, bias)
      if (actual !== offset) return { offset, bias, actual }
    }
  }
  return null
}

it('maps identical text one to one', () => {
  const text = 'alpha beta\ngamma\n'
  expect(mapRange(text, text, 6, 10)).toEqual([6, 10])
  expect(mapRange(text, text, 0, text.length)).toEqual([0, text.length])
  const alignment = alignText(text, text)
  for (const offset of [0, 6, 10, text.length]) {
    expect(alignment.toExact(offset, 'start')).toBe(offset)
    expect(alignment.toExact(offset, 'end')).toBe(offset)
  }
})

it('maps padding edges to the same exact offset and declines inside inserted padding', () => {
  const alignment = alignText('abcd', 'ab  cd')
  for (const renderedOffset of [2, 4]) {
    expect(alignment.toExact(renderedOffset, 'start')).toBe(2)
    expect(alignment.toExact(renderedOffset, 'end')).toBe(2)
  }
  expect(alignment.toExact(3, 'start')).toBeNull()
  expect(alignment.toExact(3, 'end')).toBeNull()
})

it('uses bias to distinguish exact offsets on opposite sides of a deletion', () => {
  const alignment = alignText('abXcd', 'abcd')
  expect(alignment.toExact(2, 'start')).toBe(3)
  expect(alignment.toExact(2, 'end')).toBe(2)
})

it('declines rendered offsets outside equal runs', () => {
  const alignment = alignText('abc', 'xabcx')
  expect(alignment.toExact(-1, 'start')).toBeNull()
  expect(alignment.toExact(0, 'start')).toBeNull()
  expect(alignment.toExact(5, 'end')).toBeNull()
  expect(alignment.toExact(6, 'end')).toBeNull()
})

it('maps text around normalized table padding and bullets, never inside the changed bytes', () => {
  const exact = [
    'Intro target',
    '',
    '|a|target|',
    '|---|---|',
    '- target item',
    'tail target',
  ].join('\n')
  const rendered = [
    'Intro target',
    '',
    '| a | target |',
    '| --- | --- |',
    '* target item',
    'tail target',
  ].join('\n')
  const find = (text: string, from = 0) => text.indexOf('target', from)
  const offsets: number[] = []
  for (let at = find(exact); at >= 0; at = find(exact, at + 1)) offsets.push(at)
  const mapped = offsets.map((start) =>
    mapRange(exact, rendered, start, start + 6),
  )
  expect(mapped.every((span) => span !== null)).toBe(true)
  expect(mapped.map((span) => rendered.slice(span![0], span![1]))).toEqual([
    'target',
    'target',
    'target',
    'target',
  ])
  // `|---|` has no identical rendered run for its dashes and pipes as a whole.
  const delimiter = exact.indexOf('|---|')
  expect(mapRange(exact, rendered, delimiter, delimiter + 5)).toBeNull()
})

it('reports a match unmappable when the rendered text inserts characters inside it', () => {
  expect(mapRange('a*b*c', 'a\\*b\\*c', 0, 5)).toBeNull()
  expect(mapRange('a*b*c', 'a\\*b\\*c', 2, 3)).toEqual([3, 4])
})

it('prefers the run that starts at a start offset and the run that ends at an end offset', () => {
  const alignment = alignText('abXcd', 'abYYcd')
  expect(alignment.toRendered(2, 'end')).toBe(2)
  expect(alignment.toRendered(3, 'start')).toBe(4)
  expect(alignment.toRendered(2, 'start')).toBe(2)
})

it('aligns a large document with many scattered normalizations', () => {
  const exactLines: string[] = []
  const renderedLines: string[] = []
  for (let index = 0; index < 3000; index++) {
    const word = `word${index}`
    exactLines.push(index % 50 === 0 ? `|${word}|x|` : `line ${word}`)
    renderedLines.push(index % 50 === 0 ? `| ${word} | x |` : `line ${word}`)
  }
  const exact = exactLines.join('\n')
  const rendered = renderedLines.join('\n')
  const target = exact.indexOf('word2999')
  expect(mapRange(exact, rendered, target, target + 8)).toEqual([
    rendered.indexOf('word2999'),
    rendered.indexOf('word2999') + 8,
  ])
  const tabled = exact.indexOf('word2950')
  expect(mapRange(exact, rendered, tabled, tabled + 8)).toEqual([
    rendered.indexOf('word2950'),
    rendered.indexOf('word2950') + 8,
  ])
  const alignment = alignText(exact, rendered)
  expect(firstInverseMismatch(alignment, exact.length)).toBeNull()
})
