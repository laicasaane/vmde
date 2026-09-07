import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const read = (rel: string) => readFileSync(resolve(rel), 'utf8')

interface Entry {
  emoji: string
  group: string
  keywords: string[]
  name: string
}

const emojiTest = read('../../media-src/vendor/emoji/emoji-test-17.0.txt')
const annotationsText = read('../../media-src/vendor/emoji/cldr-47-annotations-en.json')
const annotations = JSON.parse(annotationsText).annotations.annotations
const catalog = JSON.parse(read('../../media/emoji/emoji-catalog.json')) as {
  cldr47Sha256: string
  entries: Entry[]
  unicode17Sha256: string
}
const source = JSON.parse(read('../../media-src/vendor/emoji/source.json')) as {
  cldrAnnotations: { sha256: string; version: string }
  unicodeEmoji: { sha256: string; version: string }
}

const officialSequences = emojiTest
  .split(/\r?\n/u)
  .flatMap((line) => {
    const match = /^([0-9A-F ]+)\s+; fully-qualified\s+#/u.exec(line)
    return match
      ? [String.fromCodePoint(...match[1].trim().split(/\s+/u).map((hex) => Number.parseInt(hex, 16)))]
      : []
  })

describe('Emoji 17.0 catalog (task 566)', () => {
  it('contains precisely the pinned fully-qualified Unicode 17.0 repertoire', () => {
    expect(source.unicodeEmoji.version).toBe('17.0.0')
    expect(createHash('sha256').update(emojiTest).digest('hex')).toBe(source.unicodeEmoji.sha256)
    expect(catalog.unicode17Sha256).toBe(source.unicodeEmoji.sha256)
    expect(catalog.entries.map((entry) => entry.emoji)).toEqual(officialSequences)
    expect(new Set(officialSequences).size).toBe(3944)
  })

  it('retains CLDR annotations, groups, modifiers, flags, keycaps, ZWJ sequences, and Emoji 17 additions', () => {
    expect(source.cldrAnnotations.version).toBe('47.0.0')
    expect(createHash('sha256').update(annotationsText).digest('hex')).toBe(source.cldrAnnotations.sha256)
    expect(catalog.cldr47Sha256).toBe(
      createHash('sha256').update(JSON.stringify({ annotations })).digest('hex'),
    )
    for (const expected of ['🫪', '🫯', '🫈', '🫍', '🛘', '🧑🏻‍🩰', '🇺🇳', '#️⃣', '👨‍👩‍👧‍👦']) {
      expect(catalog.entries.find((entry) => entry.emoji === expected)).toMatchObject({
        emoji: expected,
        name: expect.any(String),
        keywords: expect.any(Array),
      })
    }
    expect(new Set(catalog.entries.map((entry) => entry.group))).toEqual(
      new Set([
        'Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink',
        'Travel & Places', 'Activities', 'Objects', 'Symbols', 'Flags',
      ]),
    )
  })
})
