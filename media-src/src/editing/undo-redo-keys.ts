// Task 733 / 036 D-18 — the Undo/Redo chords the IR editor owns at keydown (settings
// `vmde.editor.undoRedoKeys.undo`/`.redo`). The values come from settings.json and are validated
// here, not trusted: a non-array or non-string entry, an unknown token, an unknown platform prefix, a
// chord without Ctrl/Alt/Meta, or more than 8 entries are dropped and counted. The matcher is one
// frozen object, swapped whole on init and on every setting change, so a keydown reads one reference.
// O(1) per keydown; it allocates nothing on the keydown path.

export type HistoryKind = 'undo' | 'redo'
export type KeyPlatform = 'mac' | 'win' | 'linux'

interface Chord {
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
  /** Lowercase ASCII letter or digit, or a named key (`home`, `f2`, ...). */
  readonly key: string
  readonly named: boolean
}

export interface UndoRedoMatcher {
  readonly inEditor: boolean
  readonly undo: readonly Chord[]
  readonly redo: readonly Chord[]
  /** Entries dropped by validation (counted, never logged as text). */
  readonly invalid: number
}

const MAX_CHORDS = 8
const DEFAULT_UNDO_KEYS: readonly string[] = ['mod+z']
const DEFAULT_REDO_KEYS: readonly string[] = ['mod+shift+z', '!mac:ctrl+y']

const PREFIXES: Record<string, (p: KeyPlatform) => boolean> = {
  mac: (p) => p === 'mac',
  win: (p) => p === 'win',
  linux: (p) => p === 'linux',
  '!mac': (p) => p !== 'mac',
  '!win': (p) => p !== 'win',
  '!linux': (p) => p !== 'linux',
}

// Named keys: `event.key` values (lowercased) and the `event.code` that also names them.
const NAMED_KEYS: Record<string, readonly string[]> = {
  backspace: ['backspace'],
  delete: ['delete'],
  insert: ['insert'],
  home: ['home'],
  end: ['end'],
  pageup: ['pageup'],
  pagedown: ['pagedown'],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, [`f${i + 1}`]]),
  ),
}

export function keyPlatform(nav: Pick<Navigator, 'platform'>): KeyPlatform {
  const p = nav.platform.toLowerCase()
  if (p.includes('mac')) return 'mac'
  if (p.includes('win')) return 'win'
  return 'linux'
}

type Parsed = Chord | 'skip' | 'invalid'

/** One entry: an optional platform prefix, then `+`-separated modifiers and exactly one key. */
export function parseChord(entry: unknown, platform: KeyPlatform): Parsed {
  if (typeof entry !== 'string') return 'invalid'
  const body = withoutPlatformPrefix(entry.trim().toLowerCase(), platform)
  if (body === 'skip' || body === 'invalid') return body
  const chord = { ctrl: false, shift: false, alt: false, meta: false }
  const keys: string[] = []
  for (const token of body.split('+').map((t) => t.trim())) {
    const modifier = modifierOf(token, platform)
    if (modifier) chord[modifier] = true
    else if (isKeyToken(token)) keys.push(token)
    else return 'invalid'
  }
  const key = keys[0]
  if (keys.length !== 1 || key === undefined) return 'invalid'
  if (!(chord.ctrl || chord.alt || chord.meta)) return 'invalid'
  return { ...chord, key, named: key.length > 1 }
}

const isKeyToken = (token: string): boolean =>
  /^[a-z0-9]$/.test(token) || Object.hasOwn(NAMED_KEYS, token)

/** The chord text after an optional platform prefix; `skip` for another platform. */
function withoutPlatformPrefix(
  text: string,
  platform: KeyPlatform,
): string | 'skip' | 'invalid' {
  const colon = text.indexOf(':')
  if (colon < 0) return text
  const test = PREFIXES[text.slice(0, colon).trim()]
  if (!test) return 'invalid'
  return test(platform) ? text.slice(colon + 1) : 'skip'
}

const MODIFIER_TOKENS: Record<string, 'ctrl' | 'shift' | 'alt' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
}

function modifierOf(
  token: string,
  platform: KeyPlatform,
): 'ctrl' | 'shift' | 'alt' | 'meta' | undefined {
  if (token === 'mod') return platform === 'mac' ? 'meta' : 'ctrl'
  return Object.hasOwn(MODIFIER_TOKENS, token)
    ? MODIFIER_TOKENS[token]
    : undefined
}

const chordId = (c: Chord) =>
  `${c.ctrl ? 'c' : ''}${c.shift ? 's' : ''}${c.alt ? 'a' : ''}${c.meta ? 'm' : ''}+${c.key}`

function parseList(
  value: unknown,
  fallback: readonly string[],
  platform: KeyPlatform,
  taken: Set<string>,
  counts: { invalid: number },
): Chord[] {
  const list = value === undefined ? fallback : value
  if (!Array.isArray(list)) {
    counts.invalid++
    return []
  }
  if (list.length > MAX_CHORDS) counts.invalid += list.length - MAX_CHORDS
  const out: Chord[] = []
  for (const entry of list.slice(0, MAX_CHORDS)) {
    const parsed = parseChord(entry, platform)
    if (parsed === 'skip') continue
    if (parsed === 'invalid') {
      counts.invalid++
      continue
    }
    const id = chordId(parsed)
    // Duplicates after normalization, and a chord already given to Undo, are dropped.
    if (taken.has(id)) continue
    taken.add(id)
    out.push(Object.freeze(parsed))
  }
  return out
}

/** The matcher for a settings payload (`VmdeConfigOptions.undoRedoKeys`). */
export function buildUndoRedoMatcher(
  settings: { inEditor?: unknown; undo?: unknown; redo?: unknown } | undefined,
  platform: KeyPlatform,
): UndoRedoMatcher {
  const counts = { invalid: 0 }
  const taken = new Set<string>()
  const undo = parseList(
    settings?.undo,
    DEFAULT_UNDO_KEYS,
    platform,
    taken,
    counts,
  )
  const redo = parseList(
    settings?.redo,
    DEFAULT_REDO_KEYS,
    platform,
    taken,
    counts,
  )
  return Object.freeze({
    inEditor: settings?.inEditor !== false,
    undo: Object.freeze(undo),
    redo: Object.freeze(redo),
    invalid: counts.invalid,
  })
}

type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
> & { getModifierState?: (key: string) => boolean }

const EXCLUDED_KEYS = new Set(['Dead', 'Process', 'Unidentified'])
const KINDS = ['undo', 'redo'] as const

/** The physical key of `code` for the fallback: `KeyA`-`KeyZ`, `Digit0`-`Digit9`, or a named key. */
function codeKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const lower = code.toLowerCase()
  return Object.hasOwn(NAMED_KEYS, lower) ? lower : undefined
}

function keyMatches(chord: Chord, event: KeyEventLike): boolean {
  if (chord.named) {
    // Named keys: an explicit branch (`Home`, `F2` are ASCII strings, not single labels).
    const key = event.key.toLowerCase()
    return (
      NAMED_KEYS[chord.key]?.includes(key) === true ||
      codeKey(event.code) === chord.key
    )
  }
  // ASCII label first (AZERTY's Z is `key: 'z'`).
  if (/^[A-Za-z0-9]$/.test(event.key))
    return event.key.toLowerCase() === chord.key
  // Documented physical-key fallback: a non-ASCII label (a non-Latin layout) or a shifted symbol
  // (`!` on `Digit1`) compares the key's position.
  return codeKey(event.code) === chord.key
}

/** The history kind a keydown asks for, or undefined. O(chords), no allocation. */
export function matchUndoRedo(
  matcher: UndoRedoMatcher,
  event: KeyEventLike,
): HistoryKind | undefined {
  if (event.getModifierState?.('AltGraph')) return undefined
  if (EXCLUDED_KEYS.has(event.key)) return undefined
  for (const kind of KINDS)
    for (const chord of matcher[kind])
      if (
        chord.ctrl === event.ctrlKey &&
        chord.shift === event.shiftKey &&
        chord.alt === event.altKey &&
        chord.meta === event.metaKey &&
        keyMatches(chord, event)
      )
        return kind
  return undefined
}

/** True when the chord's key is one whose keyup Vditor's IR handler acts on (Backspace/Delete). */
export function isDeletionKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Backspace' || event.key === 'Delete'
}

// The current matcher: one frozen object, replaced in a single assignment on init and on every
// `config-changed` (boot/vditor-init.ts, bridge/message-router.ts). Defaults until the first payload.
let current: UndoRedoMatcher = buildUndoRedoMatcher(
  undefined,
  typeof navigator === 'undefined' ? 'linux' : keyPlatform(navigator),
)

/** Applies a settings payload (`VmdeConfigOptions.undoRedoKeys`): validates it and swaps the matcher. */
export function applyUndoRedoKeys(
  settings: { inEditor?: unknown; undo?: unknown; redo?: unknown } | undefined,
  platform: KeyPlatform = keyPlatform(navigator),
): void {
  current = buildUndoRedoMatcher(settings, platform)
}

export function currentUndoRedoMatcher(): UndoRedoMatcher {
  return current
}
