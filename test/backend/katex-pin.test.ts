import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const VENDOR = fileURLToPath(
  new URL('../../media-src/vendor/katex/', import.meta.url),
)
const source = JSON.parse(readFileSync(`${VENDOR}source.json`, 'utf8'))

describe('vendored KaTeX pin', () => {
  it('pins the advisory-clean 0.16.x release approved by task 518', () => {
    expect(source.version).toBe('0.18.11')
    expect(source.components).toEqual([
      { ecosystem: 'npm', name: 'katex', version: '0.18.11' },
    ])
    expect(Object.keys(source.files)).toEqual(
      expect.arrayContaining([
        'dist/katex.min.js',
        'dist/katex.min.css',
        'dist/contrib/mhchem.min.js',
      ]),
    )
  })
})
