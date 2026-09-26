export const EmojiRecentsVersion = 1
export const EmojiRecentsLimit = 24

export interface EmojiRecentState {
  version: number
  sequences: string[]
}

// Task 576 feedback-path pass: moved here from emoji-picker.ts (which now re-exports it) to break
// a dependency-cruiser `no-circular` finding — emoji-picker.ts only ever consumed this module as a
// value (filterRecentEmoji/normalizeRecentEmoji/recordRecentEmoji), but this module's own use of
// EmojiEntry was a type-only import running the other way, so the extraction resolver still saw a
// two-file cycle.
export interface EmojiEntry {
  emoji: string
  group: string
  keywords: readonly string[]
  name: string
}

export function normalizeRecentEmoji(
  value: unknown,
  knownSequences: ReadonlySet<string>,
): string[] {
  if (!value || typeof value !== 'object') return []
  const state = value as { version?: unknown; sequences?: unknown }
  if (state.version !== EmojiRecentsVersion || !Array.isArray(state.sequences))
    return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const sequence of state.sequences) {
    if (
      typeof sequence !== 'string' ||
      !knownSequences.has(sequence) ||
      seen.has(sequence)
    )
      continue
    result.push(sequence)
    seen.add(sequence)
    if (result.length === EmojiRecentsLimit) break
  }
  return result
}

export function recordRecentEmoji(
  current: readonly string[],
  sequence: string,
): string[] {
  return [sequence, ...current.filter((item) => item !== sequence)].slice(
    0,
    EmojiRecentsLimit,
  )
}

export function filterRecentEmoji(
  current: readonly string[],
  entries: readonly EmojiEntry[],
  query: string,
): EmojiEntry[] {
  const bySequence = new Map(entries.map((entry) => [entry.emoji, entry]))
  const recentEntries = current.flatMap((sequence) => {
    const entry = bySequence.get(sequence)
    return entry ? [entry] : []
  })
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return recentEntries
  return recentEntries.filter(
    ({ emoji, name, keywords }) =>
      emoji.includes(query) ||
      name.toLocaleLowerCase().includes(needle) ||
      keywords.some((keyword) => keyword.toLocaleLowerCase().includes(needle)),
  )
}
