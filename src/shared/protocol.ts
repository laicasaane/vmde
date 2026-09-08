// Single source of truth for the host↔webview message contract (task 151).
//
// WHY this lives in `src/` (the host tree) and not `media-src/`: both seams must
// import the SAME types or the union silently drifts from the wire (the bug this
// task fixes — `config-changed.theme` / `wiki-update.displayNames` had drifted out).
// The host imports it directly (`./protocol`); the webview reaches across the tree
// (`../../src/protocol`) — the exact pattern already used for `mermaid-palettes` /
// `echarts-theme`. Typing BOTH directions here makes a command/field rename a
// COMPILE error on both sides instead of a runtime no-op.

import type { IncrementalSeedPayload } from './incremental-admission'

export type ThemeKind =
  | 'dark'
  | 'light'
  | 'high-contrast'
  | 'high-contrast-light'

// Task 282 — the editor's three real modes plus the read-only Preview overlay. Declared here
// (not in default-mode.ts, which imports it) so this stays the one place both `defaultMode`
// below and default-mode.ts's `resolveDefaultMode` agree on the literal set.
export type OpenMode = 'ir' | 'wysiwyg' | 'sv' | 'preview'

// The three opt-in Lute parser switches must travel together anywhere the host
// renders or reserializes Markdown. Required booleans make callers explicitly
// restore the disabled state on the shared host Lute instance between resources.
export interface MarkdownExtensionOptions {
  toc: boolean
  mark: boolean
  supSub: boolean
}

// The config payload the host computes (`collectConfigOptions`) and the webview
// reads (`vditor-options` / `live-config`). Every field mirrors a `vmde.*`
// setting; all optional because `WorkspaceConfiguration.get<T>()` returns
// `T | undefined`. `outlineWidth` is transient (drag-resize, not a setting).
export interface VmdeConfigOptions {
  emojiPickerCloseOnSelect?: boolean
  contentTheme?: string
  useVscodeThemeColor?: boolean
  markdownPreviewFontFamily?: string
  enableFullWidth?: boolean
  codeBlockLineNumbers?: boolean
  mermaidTheme?: string
  mermaidLayout?: string
  echartsTheme?: string
  d2Layout?: string
  d2Theme?: string
  d2Sketch?: boolean
  geoBasemap?: string
  // Task 184 — per-build engine-version stamp folded into the cache hash key so a re-pin of
  // any diagram engine invalidates old cached SVGs. Reuses the extension version (see
  // collectConfigOptions); the webview computes the hash, so this rides the init options.
  assetsVersion?: string
  showToolbar?: boolean
  highlightHeadings?: boolean
  showHeadingMarkers?: boolean
  fontSize?: string
  outlinePosition?: string
  showOutlineByDefault?: boolean
  outlineHighlight?: boolean
  codeTheme?: string
  findMatchColor?: string
  findMatchOpacity?: number
  findCurrentMatchColor?: string
  findCurrentMatchOpacity?: number
  reflowLineBreaks?: boolean
  markdownToc?: boolean
  markdownMark?: boolean
  markdownSupSub?: boolean
  wrapColumn?: number
  autoWrap?: boolean
  autoWrapDelay?: number
  streamLargeFiles?: boolean
  contentVisibility?: boolean
  restorePosition?: boolean
  linkOpenWithModifier?: boolean
  pasteUrlAsLink?: boolean
  imageFormat?: string
  imageQuality?: number
  imageMaxWidth?: number
  allowRemoteImages?: boolean
  wikiEnabled?: boolean
  // Task 282 — the mode this document opens in, ALREADY RESOLVED host-side (the flat setting, any
  // matching `defaultModeByGlob` entry, and the workspace-relative path all live there). Absent
  // means "remember" — keep the session-persisted mode, which is the pre-282 behaviour.
  defaultMode?: OpenMode
  // Task 218 — `tsv` (default) | `always` | `off`: which delimiter is trusted when converting a
  // pasted spreadsheet block into a markdown table.
  pasteCsvAsTable?: string
  // Task 243 — `github` (default) | `gitlab`: which heading-slug flavor `#fragment` anchor
  // links (and, per its own scope, task 253's TOC / task 32's anchor completion) resolve
  // against. See src/heading-slug.ts's `SlugifyMode`.
  slugifyMode?: string
  // Transient (drag-resized outline width, not from collectConfigOptions).
  outlineWidth?: number
}

export interface EmojiRecentState {
  version: number
  sequences: string[]
}

// The persisted Vditor preview blob (`saveVditorOptions`) spread into the init
// payload's `options` on top of the config. Kept loose — its `preview` shape is
// Vditor-owned and only re-merged authoritatively in vditor-options.ts.
interface SavedVditorOptions {
  theme?: string
  mode?: string
  preview?: unknown
}

// Wiki context carried on the init `update` message and refreshed by `wiki-update`.
interface WikiInit {
  enabled: boolean
  pageKeys?: string[]
  displayNames?: string[]
}

export interface SectionFoldState {
  headings: Array<{ id?: string; text: string; level: number }>
  lists: Array<{ path: number[]; text: string }>
}

export interface BlockAnchor {
  hash: string
  index: number
  headingPath: string[]
}

export interface ReadingPositionState {
  anchor: BlockAnchor
  scrollOffset: number
  caret?: {
    anchor: BlockAnchor
    path: number[]
    offset: number
  }
}

/** Task 538 E2E-only renderer timings. Omitted from every production edit message. */
export interface RendererEditPerf {
  id: string
  callbackKind: 'idle' | 'flush'
  schedules: number
  totalWaitMs: number
  quietWaitMs: number
  serializeMs: number
  payloadBytes: number
  postMessageMs?: number
}

// One uploaded image: base64 bytes + the (timestamped, sanitised) target name.
interface UploadFile {
  base64: string
  name: string
}

// ── Host → webview ──────────────────────────────────────────────────────────
export type HostMessage =
  | {
      command: 'update'
      content: string
      type?: 'init' | 'update'
      documentName?: string
      cdn?: string
      // The init payload spreads the saved Vditor blob over the config, so it is
      // wider than VmdeConfigOptions alone.
      options?: VmdeConfigOptions & SavedVditorOptions
      theme?: ThemeKind
      themeKind?: ThemeKind
      wiki?: WikiInit
      // Real-VS-Code harness only: enables the readiness ledger. Absent in product sessions.
      e2e?: boolean
      foldState?: SectionFoldState
      readingPosition?: ReadingPositionState
      // Task 537: host-canonical IR snapshot + cheap source evidence for post-paint batched seeding.
      incrementalSeed?: IncrementalSeedPayload
      emojiRecents?: EmojiRecentState
    }
  | { command: 'set-theme'; theme: ThemeKind; themeKind?: ThemeKind }
  | { command: 'emoji-recents'; state: EmojiRecentState }
  // `theme` rides along when a content-theme switch flips the effective light/dark
  // mode (task 82) — was missing from the union though the host sends it and the
  // webview reads it (the drift this task closes).
  | {
      command: 'config-changed'
      options: VmdeConfigOptions
      theme?: ThemeKind
      themeKind?: ThemeKind
    }
  | { command: 'reload-css'; id: string; css: string }
  // Task 513 — local image files (absolute fs paths) whose bytes changed on disk under an unchanged
  // path. The webview revalidates their cached URLs; see links/image-refresh.ts for why the host has
  // to say it at all (a same-URL reload alone reads Chromium's cache).
  | { command: 'assets-changed'; paths: string[] }
  // `requestId` correlates the webview's `cursor-offset` reply with THIS request, so a
  // late reply from a previous (timed-out) reveal can't resolve the wrong await (185/3a).
  | { command: 'get-cursor-offset'; requestId: string }
  | { command: 'diff-info'; changes: unknown[] }
  | { command: 'uploaded'; files: string[] }
  | { command: 'announce'; message: string }
  | { command: 'scroll-to-heading'; index: number }
  | { command: 'reveal-line'; line: number; lineText: string }
  | { command: 'open-find-replace' }
  | { command: 'toggle-section-fold' }
  // Task 287 — the clipboard's plain text, read host-side for the Ctrl+Shift+V chord. The webview
  // inserts it as markdown SOURCE, skipping the HTML→markdown conversion Ctrl+V would do.
  | { command: 'paste-plain'; text: string }
  // Task 457/459 — the `vmde.activateLinkAtCaret` VS Code command (src/app/commands.ts),
  // registered so Ctrl/Cmd+Enter is discoverable/rebindable in the Keyboard Shortcuts UI. Same
  // underlying effect as the webview's OWN Ctrl/Cmd+Enter keydown listener
  // (util/caret-gesture.ts) — both run the same registered caret-gesture handlers (link
  // activation, callout-popover focus); this is the alternate trigger, not a second
  // implementation. Message name predates task 459's unification onto this one chord — kept
  // as-is, see src/app/commands.ts.
  | { command: 'activate-link-at-caret' }
  // Task 255 — the `vmde.fixListNumbering` / `vmde.renormalizeAllLists` VS Code commands
  // (src/app/commands.ts). Same resolve-panel-then-postMessage pattern as
  // `activate-link-at-caret` above; the webview owns the live caret/selection so the actual
  // list lookup happens there, not host-side.
  | { command: 'fix-list-numbering' }
  | { command: 'renormalize-all-lists' }
  | { command: 'rewrap-selection' }
  | { command: 'shift-heading-level'; direction: -1 | 1; section: boolean }
  | { command: 'prepare-rewrap-document' }
  | { command: 'rewrap-document'; content: string }
  | {
      command: 'move-outline-section'
      source: { start: number; level: number }
      target: { start: number; level: number }
      placement: 'before' | 'after'
    }
  // Task 492 Phase 4 — the `vmde.format.*` VS Code commands (src/app/commands.ts), one per
  // Vditor formatting hotkey (bold, italic, undo, …) promoted into `contributes.keybindings` so
  // each is discoverable/rebindable in the Keyboard Shortcuts UI. `name` is the toolbar item name
  // Vditor itself keys `vditor.toolbar.elements` by (Options.ts); the webview dispatches a click on
  // that item's button, the SAME action Vditor's own baked-in hotkey handler performs
  // (editorCommonEvent.ts) — one discriminant for all 20 rather than 20 near-identical messages.
  | { command: 'trigger-toolbar-hotkey'; name: string }
  // `displayNames` was likewise sent + read but absent from the type.
  | { command: 'wiki-update'; pageKeys: string[]; displayNames?: string[] }
  // Task 184 — reply to `diagram-cache-get`: the cached SVGs the host holds for the
  // requested hashes (misses are simply absent from the map). `requestId` correlates it
  // with the webview's request so a stale reply can't paint the wrong open.
  | {
      command: 'diagram-cache-hits'
      requestId: string
      svgByHash: Record<string, string>
    }
  // Task 229 — reply to `resolve-code-refs`: which of the requested workspace-relative paths
  // exist (a plain file, not a directory). Absent paths are simply not in `existing` — mirrors
  // `diagram-cache-hits`'s "misses are absent" shape. `requestId` correlates a reply with the
  // request that's still current (a stale reply from an earlier, superseded request must not
  // resurrect a chip for a path the user has since edited away).
  | { command: 'code-refs-resolved'; requestId: string; existing: string[] }

// ── Webview → host ──────────────────────────────────────────────────────────
export type WebviewMessage =
  | { command: 'ready' }
  | { command: 'request-rewrap-document' }
  // `explicitBlock` (task 390): the markdown of the ONE block the user changed by an explicit
  // toolbar action, when that change is semantically equivalent to what is already on disk —
  // `[https://x](https://x)` vs the bare `https://x`, which GFM autolinks to the same thing. The
  // minimal-diff write-back would otherwise correctly classify it as a no-op and keep the original
  // bytes, so a deliberate button press would leave the file untouched. Present only for such
  // actions; the host rewrites just that block and leaves every other block's bytes alone.
  | {
      command: 'edit'
      content: string
      explicitBlock?: string
      exact?: boolean
      rewrapDocument?: boolean
      perf?: RendererEditPerf
    }
  | {
      command: 'edit-perf-renderer'
      id: string
      postMessageMs: number
      state: 'posted' | 'cancelled'
    }
  | { command: 'save'; content: string }
  | { command: 'save-options'; options: SavedVditorOptions }
  | { command: 'save-outline-width'; width: number }
  | {
      command: 'docMode'
      blocks: number
      chars: number
      contentVisibility: boolean
      streaming: boolean
      incremental: boolean
    }
  // Task 187: the webview's CURRENT edit mode (posted at init + on every edit-mode
  // switch) — drives the status-bar mode label (sv must not read "WYSIWYG").
  | { command: 'editorMode'; mode: 'ir' | 'wysiwyg' | 'sv' }
  // Reply to `get-cursor-offset`; echoes its `requestId` (see the HostMessage side).
  | {
      command: 'cursor-offset'
      requestId: string
      line: number
      lineText: string
    }
  | { command: 'upload'; files: UploadFile[] }
  | { command: 'open-link'; href: string }
  | { command: 'open-wikilink'; target: string }
  // Task 229 — clickable code references (`src/foo.ts:42`). Ask the host which of these
  // workspace-relative candidate paths actually exist, so the decorator only chips resolved
  // refs ("unresolved paths stay plain — no dead-link chips"). Mirrors `diagram-cache-get`'s
  // batched-request shape.
  | { command: 'resolve-code-refs'; requestId: string; paths: string[] }
  // Ctrl+click (policy-consistent with every other link) on a resolved code-ref chip. `col` is
  // 1-based when present, matching how people write `file.ts:42:7`; absent when not written.
  | { command: 'open-code-ref'; path: string; line: number; col?: number }
  | { command: 'list-wiki-pages' }
  | { command: 'edit-in-vscode' }
  | {
      command: 'history-transition'
      kind: 'undo' | 'redo'
      before: string
      after: string
    }
  | { command: 'navigate-back' }
  | { command: 'open-settings' }
  // Observability pipe — host-side handlers exist; webview emitters are wired in
  // this task (item 3) to replace the console.* fallback.
  | { command: 'log'; text: string }
  | { command: 'info'; content: string }
  | { command: 'error'; content: string }
  | { command: 'save-fold-state'; state: SectionFoldState }
  | { command: 'save-reading-position'; state: ReadingPositionState }
  | { command: 'record-emoji-recent'; sequence: string }
  // Host side of the planned Copy-as HTML/Markdown feature (task 53). Handlers are
  // wired (onCopyToClipboard); the webview emitter lands with that task. Declared
  // here so the protocol is complete and the typed dispatch map stays valid.
  | { command: 'copy-html'; content: string }
  | { command: 'copy-markdown'; content: string }
  | { command: 'copy-code'; content: string }
  // Task 184 — persistent diagram render cache. The webview is the authority on what it
  // rendered; the host is a hash-keyed store. On open the webview asks for the cached SVGs
  // of the diagram blocks it found (`diagram-cache-get`), and after a render lands it reports
  // the finished SVG (`diagram-render-cached`). `docUri` is NOT sent — the host attaches the
  // panel's own document uri, so a webview can't pin renders under another document.
  | { command: 'diagram-cache-get'; requestId: string; hashes: string[] }
  | {
      command: 'diagram-render-cached'
      diagramId: string
      hash: string
      svg: string
    }

// The `acquireVsCodeApi()` handle, typed so every `vscode.postMessage` is checked
// against the WebviewMessage union (a bad command/field is now a compile error).
export interface VsCodeApi {
  postMessage(message: WebviewMessage): void
  getState<T = unknown>(): T | undefined
  setState<T>(state: T): T
}
