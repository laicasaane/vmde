import { readFileSync } from 'node:fs'
import NodePath from 'node:path'
import type { EmojiRecentState } from '../shared/protocol'

export const EmojiRecentsVersion = 1
export const EmojiRecentsLimit = 24

const catalogByExtensionPath = new Map<
  string,
  ReadonlySet<string> | undefined
>()

/** Reads the shipped, pinned catalog rather than accepting arbitrary webview text as history. */
export function pinnedEmojiSequences(
  extensionPath: string,
): ReadonlySet<string> | undefined {
  if (catalogByExtensionPath.has(extensionPath))
    return catalogByExtensionPath.get(extensionPath)
  try {
    const parsed = JSON.parse(
      readFileSync(
        NodePath.join(extensionPath, 'media', 'emoji', 'emoji-catalog.json'),
        'utf8',
      ),
    ) as { entries?: unknown }
    if (!Array.isArray(parsed.entries)) throw new Error('missing entries')
    const sequences = new Set(
      parsed.entries.flatMap((entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { emoji?: unknown }).emoji === 'string'
          ? [(entry as { emoji: string }).emoji]
          : [],
      ),
    )
    if (!sequences.size) throw new Error('empty entries')
    catalogByExtensionPath.set(extensionPath, sequences)
    return sequences
  } catch {
    // A damaged extension asset must not turn an untrusted bridge payload into persisted data.
    catalogByExtensionPath.set(extensionPath, undefined)
    return undefined
  }
}

export function normalizeEmojiRecentState(
  value: unknown,
  knownSequences: ReadonlySet<string>,
): EmojiRecentState {
  if (!value || typeof value !== 'object')
    return { version: EmojiRecentsVersion, sequences: [] }
  const state = value as { version?: unknown; sequences?: unknown }
  if (state.version !== EmojiRecentsVersion || !Array.isArray(state.sequences))
    return { version: EmojiRecentsVersion, sequences: [] }
  const sequences: string[] = []
  const seen = new Set<string>()
  for (const sequence of state.sequences) {
    if (
      typeof sequence !== 'string' ||
      !knownSequences.has(sequence) ||
      seen.has(sequence)
    )
      continue
    sequences.push(sequence)
    seen.add(sequence)
    if (sequences.length === EmojiRecentsLimit) break
  }
  return { version: EmojiRecentsVersion, sequences }
}

/** Returns undefined for an unpinned sequence so rejected/stale selections cannot enter history. */
export function promoteEmojiRecent(
  current: unknown,
  sequence: unknown,
  knownSequences: ReadonlySet<string>,
): EmojiRecentState | undefined {
  if (typeof sequence !== 'string' || !knownSequences.has(sequence))
    return undefined
  const normalized = normalizeEmojiRecentState(current, knownSequences)
  return {
    version: EmojiRecentsVersion,
    sequences: [
      sequence,
      ...normalized.sequences.filter((item) => item !== sequence),
    ].slice(0, EmojiRecentsLimit),
  }
}
