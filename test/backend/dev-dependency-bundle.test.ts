import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The text-model property tests use fast-check and @codemirror/state as development dependencies.
// This test proves no input of the shipped webview bundle comes from them (D-4: no new runtime
// dependency).
const FORBIDDEN = [
  'node_modules/fast-check/',
  'node_modules/pure-rand/',
  'node_modules/@codemirror/',
  'node_modules/@marijn/',
]

interface Metafile {
  inputs?: Record<string, unknown>
}

/** Input paths of the metafile that come from a development-only package. */
function forbiddenInputs(meta: Metafile): string[] {
  return Object.keys(meta.inputs ?? {}).filter((input) =>
    FORBIDDEN.some((marker) => input.replaceAll('\\', '/').includes(marker)),
  )
}

const metaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../media/dist/main.meta.json',
)
const built = existsSync(metaPath)

describe('development dependencies stay out of the webview bundle', () => {
  it('detects a forbidden input in a synthetic metafile', () => {
    const meta = {
      inputs: {
        'media-src/src/boot/main.ts': {},
        '../node_modules/fast-check/lib/fast-check.js': {},
        '../node_modules/@codemirror/state/dist/index.js': {},
      },
    }
    expect(forbiddenInputs(meta)).toEqual([
      '../node_modules/fast-check/lib/fast-check.js',
      '../node_modules/@codemirror/state/dist/index.js',
    ])
    expect(
      forbiddenInputs({ inputs: { 'media-src/src/boot/main.ts': {} } }),
    ).toEqual([])
  })

  it.skipIf(!built)(
    'has no forbidden input in media/dist/main.meta.json',
    () => {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Metafile
      expect(forbiddenInputs(meta)).toEqual([])
    },
  )

  it.skipIf(built)(
    'skipped: media/dist/main.meta.json is absent (run node build.mjs first)',
    () => {
      expect(built).toBe(false)
    },
  )
})
