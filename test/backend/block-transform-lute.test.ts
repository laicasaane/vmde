import { fileURLToPath } from 'node:url'
import {
  beforeAll,
  describe as vitestDescribe,
  expect,
  it as vitestIt,
} from 'vitest'
import {
  blockTransform,
  fenceParagraphBody,
  type BlockType,
} from '../../media-src/src/editing/block-transform'
import { prewarmLute, renderForMode } from '../../src/lute/lute-host'
import {
  isLuteArtifactBuilt,
  waitForLuteWarm,
  warnLuteArtifactMissing,
} from './lute-artifact'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// task 476: these tests boot the real Lute build artifact. Before `node build.mjs` (a fresh clone,
// or the unit-test step of the Azure pipelines) it does not exist, so skip loudly instead of
// failing the suite in the beforeAll below.
const LUTE_BUILT = isLuteArtifactBuilt(ROOT)
if (!LUTE_BUILT)
  warnLuteArtifactMissing('block-transform-lute (shipped Lute parser)', ROOT)
const describe = LUTE_BUILT ? vitestDescribe : vitestDescribe.skip
const it = LUTE_BUILT ? vitestIt : vitestIt.skip

beforeAll(async () => {
  if (!LUTE_BUILT) return
  prewarmLute(ROOT)
  await waitForLuteWarm()
})

describe('Task 298 source outputs in the shipped Lute parser', () => {
  const cases: Array<[BlockType, RegExp]> = [
    ['h2', /<h2\b/u],
    ['quote', /<blockquote\b/u],
    ['bullet', /<ul\b/u],
    ['ordered', /<ol\b/u],
    ['task', /type="checkbox"/u],
    ['callout', /<blockquote\b/u],
  ]
  for (const [type, tag] of cases) {
    it(`renders paragraph → ${type} as the requested block`, () => {
      const result = blockTransform('alpha **beta**', { type }, 8, 8)
      expect(result.status).toBe('changed')
      const html = renderForMode(ROOT, result.markdown, 'ir')
      expect(html).toMatch(tag)
      expect(html).toContain('beta')
    })
  }
})

it('declines fence-to-paragraph when the raw body is a setext heading in shipped Lute', () => {
  const source = '```md\nalpha\n===\n```'
  const html = renderForMode(ROOT, 'alpha\n===', 'ir')
  expect(html).toMatch(/<h1\b/u)
  const result = blockTransform(source, { type: 'paragraph' }, 9, 9)
  expect(result).toMatchObject({ status: 'unsupported', markdown: source })
})

it('exposes only a shipped-Lute single-paragraph fence body for confirmation', () => {
  const body = fenceParagraphBody('```md\nalpha **bold**\n```')
  expect(body).toBe('alpha **bold**')
  for (const mode of ['ir', 'wysiwyg'] as const) {
    const detached = renderForMode(ROOT, body!, mode)
    expect(detached).toMatch(/<p\b/u)
    expect(detached).not.toMatch(/<(?:h[1-6]|ul|ol|blockquote)\b/u)
  }
  expect(fenceParagraphBody('```md\n# heading\n```')).toBeNull()
  expect(fenceParagraphBody('```md\nalpha\n===\n```')).toBeNull()
})
