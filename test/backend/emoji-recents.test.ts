import { describe, expect, it } from 'vitest'
import {
  normalizeEmojiRecentState,
  promoteEmojiRecent,
} from '../../src/session/emoji-recents'

const known = new Set(['😀', '👍', '👍🏽', '👨‍👩‍👧', '🫩'])

describe('host emoji recents', () => {
  it('rejects unknown values while retaining valid persisted exact sequences', () => {
    expect(
      normalizeEmojiRecentState(
        { version: 1, sequences: ['😀', 'unknown', '😀', '👍🏽'] },
        known,
      ),
    ).toEqual({ version: 1, sequences: ['😀', '👍🏽'] })
  })

  it('promotes variants without merging them and caps the canonical history', () => {
    expect(
      promoteEmojiRecent(
        { version: 1, sequences: ['👍', '😀', '👍🏽'] },
        '👍🏽',
        known,
      ),
    ).toEqual({ version: 1, sequences: ['👍🏽', '👍', '😀'] })
    expect(promoteEmojiRecent(undefined, 'unknown', known)).toBeUndefined()
  })
})
