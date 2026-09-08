import { describe, expect, it } from 'vitest'
import {
  filterRecentEmoji,
  normalizeRecentEmoji,
  recordRecentEmoji,
} from './emoji-recents'

const known = new Set(['😀', '👍', '👍🏽', '👨‍👩‍👧', '🫩'])

describe('emoji recents', () => {
  it('validates persisted sequences, removes duplicates, and caps the list', () => {
    const values = Array.from({ length: 30 }, (_, index) => String(index))
    const allowed = new Set(values)
    expect(
      normalizeRecentEmoji(
        { version: 1, sequences: [...values, '0'] },
        allowed,
      ),
    ).toEqual(values.slice(0, 24))
    expect(
      normalizeRecentEmoji({ version: 2, sequences: ['😀'] }, known),
    ).toEqual([])
    expect(
      normalizeRecentEmoji(
        { version: 1, sequences: ['😀', 'bad', '😀', '👍🏽'] },
        known,
      ),
    ).toEqual(['😀', '👍🏽'])
    expect(normalizeRecentEmoji(null, known)).toEqual([])
  })

  it('moves the exact selected sequence to the front without merging variants', () => {
    expect(recordRecentEmoji(['👍', '😀', '👍🏽'], '👍🏽')).toEqual([
      '👍🏽',
      '👍',
      '😀',
    ])
    expect(recordRecentEmoji(['👍🏽', '👍'], '👨‍👩‍👧')).toEqual([
      '👨‍👩‍👧',
      '👍🏽',
      '👍',
    ])
  })

  it('filters recents with the same catalog search behavior', () => {
    const entries = [
      {
        emoji: '😀',
        group: 'Smileys & Emotion',
        keywords: ['face'],
        name: 'grinning face',
      },
      {
        emoji: '👍🏽',
        group: 'People & Body',
        keywords: ['hand'],
        name: 'thumbs up medium skin tone',
      },
    ]
    expect(filterRecentEmoji(['👍🏽', '😀'], entries, 'medium')).toEqual([
      entries[1],
    ])
    expect(filterRecentEmoji(['👍🏽', '😀'], entries, '')).toEqual([
      entries[1],
      entries[0],
    ])
  })
})
