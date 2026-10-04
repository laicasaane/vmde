// Task 580 §2.12 — a test-only stand-in for VS Code's keybinding service in the Chromium
// harnesses. Real VS Code forwards a keydown the webview did not stop to the workbench, resolves
// it to a contributed command and posts that command's message back to the webview. This shim
// imitates that with a window bubble-phase listener that maps the shared table's default keys
// (src/shared/editor-shortcuts.ts) to their routes. It is emulation, not evidence: real-key
// acceptance stays in test/vscode-e2e.
//
// A spec enables the commands it exercises. The shim reads the same rows that package.json's
// keybindings are checked against, so a key the table leaves unbound (for example the formatting
// defaults that Task 580 CP3-1 freed) maps to nothing here, as in VS Code. The shim does not
// evaluate `when` clauses; the caller enables a command only where its context holds.
import {
  EDITOR_SHORTCUTS,
  type PanelRoute,
} from '../../src/shared/editor-shortcuts'

export type ShimPlatform = 'win-linux' | 'mac'

export interface KeybindingShimOptions {
  /** The commands the shim may run. */
  commands: readonly string[]
  platform: ShimPlatform
  /** Runs a matched command's route, for example through the harness's message router. */
  dispatch: (route: PanelRoute, command: string) => void
  /** Keys a user binds in keybindings.json, as key → command. They give an unbound command a key
   *  (or a bound one an extra key); the command must also be enabled in `commands`. */
  userKeys?: Readonly<Record<string, string>>
}

type ChordEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>

const MODIFIER_ORDER: Record<ShimPlatform, readonly string[]> = {
  'win-linux': ['ctrl', 'shift', 'alt', 'meta'],
  mac: ['ctrl', 'shift', 'alt', 'cmd'],
}

// `KeyboardEvent.code` names for the non-letter, non-digit keys the table uses. Matching on
// `code` keeps Shift+[ as `[` rather than the layout's shifted `{`.
const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Equal: '=',
  Minus: '-',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  Escape: 'escape',
  PageUp: 'pageup',
  PageDown: 'pagedown',
}

function baseKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase()
  return CODE_KEYS[code] ?? null
}

/** One chord part in VS Code notation with modifiers in VS Code's order, e.g. `ctrl+shift+[`. */
export function chordOf(
  event: ChordEvent,
  platform: ShimPlatform,
): string | null {
  const base = baseKey(event.code)
  if (!base) return null
  const held: Record<string, boolean> = {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: platform === 'win-linux' && event.metaKey,
    cmd: platform === 'mac' && event.metaKey,
  }
  return [...MODIFIER_ORDER[platform].filter((m) => held[m]), base].join('+')
}

function canonicalKey(key: string, platform: ShimPlatform): string {
  return key
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      const segments = part.split('+')
      const base = segments.pop() ?? ''
      const mods = MODIFIER_ORDER[platform].filter((m) => segments.includes(m))
      return [...mods, base].join('+')
    })
    .join(' ')
}

/** Install the shim on `win`; the returned function removes it. */
export function installKeybindingShim(
  win: Window,
  options: KeybindingShimOptions,
): () => void {
  const enabled = new Set(options.commands)
  const bindings = new Map<string, { command: string; route: PanelRoute }>()
  for (const row of EDITOR_SHORTCUTS) {
    if (row.route === 'host') continue
    if (!enabled.has(row.command)) continue
    const route = row.route
    const defaults =
      row.keys === 'unbound'
        ? []
        : options.platform === 'mac'
          ? row.keys.mac
          : row.keys.winLinux
    const user = Object.entries(options.userKeys ?? {})
      .filter(([, command]) => command === row.command)
      .map(([key]) => key)
    for (const key of [...defaults, ...user])
      bindings.set(canonicalKey(key, options.platform), {
        command: row.command,
        route,
      })
  }
  const prefixes = new Set(
    [...bindings.keys()]
      .filter((key) => key.includes(' '))
      .map((key) => key.split(' ')[0]),
  )
  // The first part of a two-part chord (`ctrl+k ctrl+l`) waits for the next keydown, as VS Code's
  // chord mode does.
  let pendingPrefix: string | null = null

  const onKeydown = (event: KeyboardEvent): void => {
    const chord = chordOf(event, options.platform)
    if (!chord) return
    const key = pendingPrefix ? `${pendingPrefix} ${chord}` : chord
    pendingPrefix = null
    const binding = bindings.get(key)
    if (binding) {
      event.preventDefault()
      options.dispatch(binding.route, binding.command)
      return
    }
    if (prefixes.has(chord)) {
      event.preventDefault()
      pendingPrefix = chord
    }
  }
  win.addEventListener('keydown', onKeydown)
  return () => win.removeEventListener('keydown', onKeydown)
}

interface HistoryEngineWindow {
  vditor?: {
    vditor?: { undo?: Record<string, ((inner: unknown) => void) | undefined> }
  }
}

/**
 * Task 580 CP2-3 — Undo/Redo as real VS Code runs them: the table's default keys run
 * `vmde.format.undo`/`redo`, whose `trigger-toolbar-hotkey` route calls the shared history engine
 * exactly as message-router.ts does. The harness's Vditor toolbar must give undo/redo
 * `hotkey: ''` (as chrome/toolbar.ts does); otherwise Vditor's own toolbar-hotkey fallback runs
 * the engine a second time for Ctrl/Cmd+Z and +Y.
 */
export function installHistoryKeybindingShim(
  win: Window & HistoryEngineWindow,
): () => void {
  return installKeybindingShim(win, {
    commands: ['vmde.format.undo', 'vmde.format.redo'],
    platform: win.navigator.platform.toLowerCase().includes('mac')
      ? 'mac'
      : 'win-linux',
    dispatch: (route) => {
      if (route.command !== 'trigger-toolbar-hotkey') return
      const inner = win.vditor?.vditor
      inner?.undo?.[route.name]?.(inner)
    },
  })
}
