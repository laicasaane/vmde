import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_SWITCHES,
  parseSwitchSet,
  switchSource,
} from '../../media-src/e2e/harness-switches.mjs'

// Task 733 / 024: the smoke stage bundles the Chromium harness with chosen unit switches turned on.
// The rewrite belongs to the harness build only; the product bundle keeps the shipped values.
const repo = (relative: string) =>
  fileURLToPath(new URL(`../../${relative}`, import.meta.url))
const read = (relative: string) => readFileSync(repo(relative), 'utf8')

const UNIT_CHANGES = 'media-src/src/util/unit-changes.ts'
const declaration = (name: string, value: boolean) =>
  `export const ${name}: boolean = ${value}`

describe('harness switches', () => {
  it('names the three unit switches', () => {
    expect(HARNESS_SWITCHES).toEqual({
      wysiwyg: 'WYSIWYG_UNITS',
      source: 'SOURCE_UNITS',
      definition: 'DEFINITION_UNITS',
    })
  })

  it('turns each named constant on once and leaves the others as shipped', () => {
    const code = read(UNIT_CHANGES)
    const names = Object.values(HARNESS_SWITCHES)
    for (const name of names)
      expect(code, `${name} ships off`).toContain(declaration(name, false))
    for (const name of names) {
      const result = switchSource(code, [name])
      expect(result).toContain(declaration(name, true))
      expect(result).not.toContain(declaration(name, false))
      for (const other of names.filter((n) => n !== name))
        expect(result).toContain(declaration(other, false))
    }
    const all = switchSource(code, names)
    for (const name of names) expect(all).toContain(declaration(name, true))
  })

  it('keeps a constant that is already on', () => {
    const code = `${declaration('SOURCE_UNITS', true)}\n`
    expect(switchSource(code, ['SOURCE_UNITS'])).toBe(code)
  })

  it('throws when a named constant matches zero times or twice', () => {
    const one = `${declaration('WYSIWYG_UNITS', false)}\n`
    expect(() => switchSource(one, ['SOURCE_UNITS'])).toThrow()
    expect(() => switchSource(`${one}${one}`, ['WYSIWYG_UNITS'])).toThrow()
  })

  it('accepts none and the ordered subsets only', () => {
    for (const text of [
      'none',
      'wysiwyg',
      'source',
      'definition',
      'wysiwyg+source',
      'wysiwyg+definition',
      'source+definition',
      'wysiwyg+source+definition',
    ])
      expect(parseSwitchSet(text), text).not.toBeUndefined()
    for (const text of [
      '',
      'None',
      'WYSIWYG',
      'source+wysiwyg',
      'definition+source',
      'wysiwyg+wysiwyg',
      'none+source',
      'wysiwyg+',
      '+source',
      'wysiwyg++source',
      'single',
      '../none',
    ])
      expect(parseSwitchSet(text), text).toBeUndefined()
  })

  it('stays out of the product build', () => {
    for (const file of ['build.mjs', 'media-src/esbuild-shared.mjs'])
      expect(read(file), file).not.toContain('harness-switches')
  })
})
