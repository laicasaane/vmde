import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const VENDOR = fileURLToPath(
  new URL('../../media-src/vendor/markmap/', import.meta.url),
)
const source = JSON.parse(readFileSync(`${VENDOR}source.json`, 'utf8'))
const js = readFileSync(`${VENDOR}markmap.min.js`, 'utf8')

const CHILD_PROBE = String.raw`
const { readFileSync } = require('node:fs')
const { JSDOM } = require('jsdom')
const bundle = readFileSync(process.argv[1], 'utf8')
const count = Number(process.argv[2])
const dom = new JSDOM('', { runScripts: 'outside-only' })
dom.window.eval(bundle)
const transformer = new dom.window.markmap.Transformer()
transformer.transform('# warm\n\nmailto:warm@example.invalid')
const markdown = '# security probe\n\nmailto:' + 'a'.repeat(count) + '@example.invalid'
const started = performance.now()
const result = transformer.transform(markdown)
const elapsed = performance.now() - started
process.stdout.write(JSON.stringify({ elapsed, content: result.root.content.length }))
`

// Each probe boots a fresh JSDOM and the bundle in a child process (~1.2 s idle). The elapsed time
// asserted below is measured inside the child, so these ceilings only absorb CI scheduling load.
const PROBE_PROCESS_TIMEOUT_MS = 30_000
const PROBE_TEST_TIMEOUT_MS = 90_000

function measureEmailLocalPart(count: number): number {
  const result = spawnSync(
    process.execPath,
    ['-e', CHILD_PROBE, `${VENDOR}markmap.min.js`, String(count)],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      timeout: PROBE_PROCESS_TIMEOUT_MS,
    },
  )
  expect(result.error, result.stderr.toString()).toBeUndefined()
  expect(result.status, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString()).elapsed
}

describe('vendored Markmap linkification security', () => {
  it('records the immutable Markmap 0.18.12 source commit', () => {
    expect(source.build?.sourceCommit).toBe(
      '205367a24603dc187f67da1658940c6cade20dce',
    )
  })

  it('records linkify-it 5.0.2 as an exact nested component', () => {
    expect(source.components).toContainEqual({
      ecosystem: 'npm',
      name: 'linkify-it',
      version: '5.0.2',
    })
  })

  it('does not contain the affected unbounded email-name expression', () => {
    expect(js).not.toContain(
      `re.src_email_name = '[\\\\-;:&=\\\\+\\\\$,\\\\.a-zA-Z0-9_][\\\\-;:&=\\\\+\\\\$,\\\\"\\\\.a-zA-Z0-9_]*'`,
    )
  })

  it(
    'keeps long mailto linkification bounded',
    () => {
      const fourThousand = measureEmailLocalPart(4_000)
      const eightThousand = measureEmailLocalPart(8_000)
      expect(eightThousand).toBeLessThan(1_000)
      expect(eightThousand / Math.max(fourThousand, 0.1)).toBeLessThan(3.5)
    },
    PROBE_TEST_TIMEOUT_MS,
  )
})
