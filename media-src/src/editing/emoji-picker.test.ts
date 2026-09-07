import { describe, expect, it } from 'vitest'
import { filterEmoji, type EmojiEntry } from './emoji-picker'

const entries: EmojiEntry[] = [
  {
    emoji: '🫩',
    group: 'Smileys & Emotion',
    keywords: ['bags', 'exhausted', 'tired'],
    name: 'face with bags under eyes',
  },
  {
    emoji: '🧑‍🤝‍🧑',
    group: 'People & Body',
    keywords: ['friends', 'hold hands'],
    name: 'people holding hands',
  },
]

describe('filterEmoji', () => {
  it('finds names, CLDR keywords, and a literal complete emoji sequence without splitting it', () => {
    expect(filterEmoji(entries, 'EXHAUSTED')).toEqual([entries[0]])
    expect(filterEmoji(entries, '🧑‍🤝‍🧑')).toEqual([entries[1]])
  })

  it('returns no matches for a query absent from all names and keywords', () => {
    expect(filterEmoji(entries, 'not-a-real-emoji')).toEqual([])
  })
})
