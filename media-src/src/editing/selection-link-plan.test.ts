import { expect, it } from 'vitest'
import {
  planSelectedLink,
  uniqueAtxHeadingTextRange,
} from './selection-link-plan'

it('plans only the exact selected source span and keeps all surrounding bytes', () => {
  const markdown = 'prefix alpha suffix\r\n\r\nother\r\n'
  expect(planSelectedLink(markdown, 7, 12, 'alpha', 'link')).toMatchObject({
    status: 'changed',
    markdown: 'prefix [alpha]() suffix\r\n\r\nother\r\n',
  })
  expect(planSelectedLink(markdown, 7, 12, 'alpha', 'wiki')).toMatchObject({
    status: 'changed',
    markdown: 'prefix [[alpha]] suffix\r\n\r\nother\r\n',
  })
})

it('escapes link label syntax but preserves the selected visible text', () => {
  expect(planSelectedLink('A]B', 0, 3, 'A]B', 'link')).toMatchObject({
    status: 'changed',
    markdown: '[A\\]B]()',
  })
})

it('rejects stale, cross-line, empty and unsafe wiki selections without a write', () => {
  for (const [source, start, end, text, kind] of [
    ['alpha', 0, 5, 'other', 'link'],
    ['alpha', -1, 5, 'alpha', 'link'],
    ['A\nB', 0, 3, 'A\nB', 'link'],
    ['alpha', 0, 0, '', 'link'],
    ['A|B', 0, 3, 'A|B', 'wiki'],
    [' A', 0, 2, ' A', 'wiki'],
  ] as const)
    expect(planSelectedLink(source, start, end, text, kind).status).toBe(
      'rejected',
    )
})

it('keeps the existing toolbar Link leading-space rule next to prose', () => {
  expect(planSelectedLink('prefixalpha', 6, 11, 'alpha', 'link')).toMatchObject(
    {
      status: 'changed',
      markdown: 'prefix [alpha]()',
      caretOffset: 15,
    },
  )
})

it('preserves surrounding emphasis and declines an existing link label', () => {
  expect(planSelectedLink('**alpha**', 2, 7, 'alpha', 'link')).toMatchObject({
    status: 'changed',
    markdown: '**[alpha]()**',
  })
  expect(planSelectedLink('[alpha](url)', 1, 6, 'alpha', 'wiki').status).toBe(
    'rejected',
  )
  expect(planSelectedLink('[[alpha]]', 2, 7, 'alpha', 'link').status).toBe(
    'rejected',
  )
  expect(planSelectedLink('`alpha`', 1, 6, 'alpha', 'link').status).toBe(
    'rejected',
  )
})

it('maps only unique selected text inside its exact ATX heading level', () => {
  const source = '**alpha**\n\n## beta\n'
  expect(uniqueAtxHeadingTextRange(source, 'beta', 2)).toEqual({
    startOffset: source.indexOf('beta'),
    endOffset: source.indexOf('beta') + 4,
  })
  for (const [markdown, level] of [
    ['## beta\n\nbeta\n', 2],
    ['beta\n', 2],
    ['### beta\n', 2],
    ['beta\n----\n', 2],
  ] as const)
    expect(uniqueAtxHeadingTextRange(markdown, 'beta', level)).toBeNull()
})
