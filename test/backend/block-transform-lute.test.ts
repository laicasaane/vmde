import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  blockTransform,
  type BlockType,
} from '../../media-src/src/editing/block-transform'
import { prewarmLute, renderForMode } from '../../src/lute/lute-host'
import { waitForLuteWarm } from './lute-artifact'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

beforeAll(async () => {
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
