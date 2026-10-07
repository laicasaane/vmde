// Host→webview message handling (task 399, split out of main.ts). One handler per
// `command`, keyed by the HostMessage discriminant so adding a command is a compile
// error until a handler exists (exhaustive) and each handler receives its narrowed
// variant — no `any`, so a field rename in protocol.ts breaks here at compile time
// (task 151). Reads/writes the fields of sessionState it shares with vditor-init.ts;
// state that's purely internal to message handling (lastDiffChanges,
// inlineInitedContent) stays local to this module.
import {
  firstShapeViolation,
  type RequiredField,
} from '../../../src/shared/message-shape'
import type {
  FindWidgetAction,
  HostMessage,
  VmdeConfigOptions,
} from '../../../src/shared/protocol'
import { TOOLBAR_COMMAND_NAMES } from '../../../src/shared/editor-shortcuts'
import type { InitPayload } from '../boot/init-payload'
import {
  setEmojiPickerCloseOnSelect,
  setEmojiPickerRecentState,
} from '../editing/emoji-picker'
import { invalidateEmojiInsertion } from '../editing/emoji-insertion'
import {
  beginE2EActivity,
  markE2EError,
  markRouterReady,
} from '../testing/e2e-readiness'
// Task 460 phase 3 — the last remaining cycle (boot -> bridge -> boot). These 3 lines are
// TYPE-only imports (erase at compile time, same as the InitPayload import above), used purely
// to spell out MessageRouterDeps below via `typeof`. The VALUES come from main.ts (the
// composition root, already in boot/) via configureMessageRouter — see that type's own comment.
import type {
  applyBodyOptions,
  applyPreviewReflowSetting,
  effectivePreviewReflow,
  swapStyle,
  initOnlyChanged,
} from '../boot/live-config'
import type { sessionState } from '../boot/editor-session-state'
import type { initVditor, renderCacheThemeKey } from '../boot/vditor-init'
import type { DiffChange } from '../chrome/diff-markers'
import { logToHost, reportError } from '../util/webview-log'
import { saveVditorOptions } from '../chrome/toolbar-actions'
import { d2ConfigFromOptions, setD2Config } from '../diagram-kit/d2-config'
import {
  setRenderCacheConfig,
  applyCacheHits,
} from '../diagrams/render-cache-client'
import { runCaretGestureHandlers } from '../util/caret-gesture'
import { applyCodeRefResolution } from '../links/code-ref-resolve'
import { rethemeDiagrams } from '../diagrams/diagram-retheme'
import { applyLinkOpenSetting } from '../links/link-open-policy'
import { applyPasteUrlSetting } from '../links/link-url'
import { applyPasteCsvSetting } from '../clipboard/paste-table'
import { applySlugifyModeSetting } from '../links/same-doc-anchor'
import {
  finishPreviewTaskCheckboxOutcome,
  isPendingPreviewTaskCheckboxHistoryUpdate,
  setPreviewTaskCheckboxesEnabled,
} from '../editing/preview-task-checkboxes'
import {
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from '../editing/rewrap-command'
import { refreshVisiblePreviewAfterHostUpdate } from '../editing/preview-state'
import { stripAnsi } from '../clipboard/paste-transform'
import { renderDiffMarkers, clearDiffMarkers } from '../chrome/diff-markers'
import { invalidateCaret } from '../editing/caret'
import { preserveCaretAndScroll } from '../editing/caret-preserve'
import { restoreEditorCaretIfLost } from '../editing/editor-caret'
import {
  discardCommandSelection,
  refusesBlocklessInlineFormat,
  restoreCommandSelection,
} from '../editing/format-hotkey-guard'
import { clickToolbarHotkeyButton } from '../editing/format-hotkey-context'
import { applyThemeKind, themeMode } from '../util/theme-kind'
import {
  activeModeElement,
  getCursorSourceOffset,
  lineAndTextForOffset,
} from '../util/source-map'
import {
  fixAllListNumbering,
  fixListNumberingAtCaret,
} from '../editing/list-normalize'
import { runSourceListCommand } from '../editing/list-normalize-source-command'
import {
  applyBlockTransformChoice,
  cancelBlockTransformChoice,
  requestBlockTransformOptions,
} from '../editing/block-transform-command'
import {
  prepareBlockAction,
  finishBlockAction,
} from '../editing/block-action-client'
import { refreshChangedImages } from '../links/image-refresh'
import { revealSourceLine, scrollToHeadingIndex } from '../nav/outline'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import {
  openFindReplace,
  runFindWidgetAction,
} from '../editing/selection-scope'
import { toggleFoldAtCaret } from '../nav/section-fold'
import { noteExplicitReadingPositionReveal } from '../nav/reading-position'
import { exitHoistForFind } from '../nav/section-hoist'
import { uploadedMarkup } from '../clipboard/upload-handler'
import {
  diagramConfigDelta,
  rethemeFlagsFor,
} from '../diagram-kit/diagram-config-delta'
import { announce } from '../util/screen-reader'
import {
  focusedTextInput,
  isEditorAction,
  runEditorAction,
} from './editor-actions'
import { answerFlushForSave } from './save-flush'

// Task 460 phase 3 — the boot-layer symbols this module used to import as VALUES (closing the
// last cycle: boot/main.ts -> bridge/message-router.ts -> boot/{live-config,editor-session-state,
// vditor-init}.ts). main.ts is the composition root — it already imports the real
// live-config/editor-session-state/vditor-init modules for its own use — so it builds one of
// these and hands it in via configureMessageRouter() before the first message can be dispatched
// (main.ts calls it immediately before installMessageRouter(window); handleUpdate's own direct
// call further down main.ts happens after that, so it's covered too). Every handler below reads
// these off `routerDeps`, never off a direct import.
type MessageRouterDeps = {
  applyBodyOptions: typeof applyBodyOptions
  applyPreviewReflowSetting: typeof applyPreviewReflowSetting
  effectivePreviewReflow: typeof effectivePreviewReflow
  swapStyle: typeof swapStyle
  initOnlyChanged: typeof initOnlyChanged
  sessionState: typeof sessionState
  initVditor: typeof initVditor
  renderCacheThemeKey: typeof renderCacheThemeKey
  runRewrap: () => void
  runFormatTable: () => void
  shiftHeadingLevel: (direction: -1 | 1, section?: boolean) => void
  prepareRewrapDocument: () => void
  runRewrapDocument: (markdown: string) => void
  runOutlineSectionMove: (
    source: { start: number; level: number },
    target: { start: number; level: number },
    placement: 'before' | 'after',
  ) => void
  prepareOutlineSectionMove: (
    message: Extract<HostMessage, { command: 'prepare-outline-section-move' }>,
  ) => void
  finishOutlineSectionMove: (
    message: Extract<HostMessage, { command: 'outline-section-move-outcome' }>,
  ) => void
  applyAutoWrapConfig: (
    options: VmdeConfigOptions | undefined,
    rerender: boolean,
  ) => void
  cancelAutoWrap: () => void
}

let routerDeps: MessageRouterDeps | undefined

export function configureMessageRouter(deps: MessageRouterDeps): void {
  routerDeps = deps
}

function getRouterDeps(): MessageRouterDeps {
  if (!routerDeps) {
    throw new Error(
      '[message-router] configureMessageRouter() must run before any host message is handled',
    )
  }
  return routerDeps
}

// Git-gutter diff markers for the current document (tasks 15/16).
let lastDiffChanges: DiffChange[] = []
// Task 38: the content we already booted Vditor from via the inlined `#vmark-init` payload (null when
// we didn't inline-init). The host still posts `init` after `ready`; that echo with identical content
// is no-op'd in handleUpdate so it doesn't re-mount (which would reset caret/scroll). Set by
// markInlineInited, called from main.ts's bootstrap right after it drives the inline payload through
// handleUpdate directly (so that first call isn't itself skipped by the still-null guard below).
let inlineInitedContent: string | null = null

export function markInlineInited(content: string): void {
  inlineInitedContent = content
}

type UpdateMessage = Extract<HostMessage, { command: 'update' }>
type CheckboxHistory = NonNullable<UpdateMessage['previewTaskCheckboxHistory']>

interface OwnedCheckboxHistory {
  history: CheckboxHistory
  inner: InnerVditor
  mode: string
  nativeSlot: { undoStack: unknown[] }
}

function ownedCheckboxHistory(msg: UpdateMessage): OwnedCheckboxHistory | null {
  const history = msg.previewTaskCheckboxHistory
  if (
    !history ||
    history.before === history.after ||
    history.renderedAfter !== msg.content ||
    !isPendingPreviewTaskCheckboxHistoryUpdate(
      history.requestId,
      history.before,
      history.after,
    )
  )
    return null
  const inner = innerVditor()
  const mode = inner?.currentMode
  const nativeSlot = mode
    ? ((inner?.undo as any)?.[mode] as { undoStack?: unknown[] } | undefined)
    : undefined
  if (
    !inner ||
    !mode ||
    !Array.isArray(nativeSlot?.undoStack) ||
    typeof inner.undo?.addToUndoStack !== 'function' ||
    getRouterDeps().sessionState.editSync?.snapshotExactMarkdown() !==
      history.before
  )
    return null
  return {
    history,
    inner,
    mode,
    nativeSlot: nativeSlot as { undoStack: unknown[] },
  }
}

function setHostUpdateValue(
  content: string,
  owned: OwnedCheckboxHistory | null,
): void {
  const beforeRendered = owned ? vditor.getValue() : undefined
  preserveCaretAndScroll(window.vditor, () => {
    if (owned) checkpointEditorUndo(owned.inner)
    // Only a pending, exact-source checkbox transaction keeps native history.
    // Ordinary external updates continue to clear it.
    vditor.setValue(content, !owned)
    if (!owned) return
    checkpointEditorUndo(owned.inner)
    const nativeState = owned.nativeSlot.undoStack.at(-1)
    if (!nativeState) return
    recordRewrapDocumentHistory({
      owner: owned.inner,
      mode: owned.mode,
      nativeState,
      beforeRendered: beforeRendered ?? owned.history.before,
      beforeExact: owned.history.before,
      afterRendered: vditor.getValue(),
      afterExact: owned.history.after,
    })
  })
}

export function handleUpdate(msg: UpdateMessage) {
  // Even a same-content init identifies a new accepted host update boundary. A picker opened
  // against the preceding editor/session must fail closed before the inline-init early return.
  invalidateEmojiInsertion()
  if (msg.type === 'init') {
    setEmojiPickerCloseOnSelect(msg.options?.emojiPickerCloseOnSelect !== false)
    setEmojiPickerRecentState(msg.emojiRecents)
    // Task 38: the host re-sends `init` after `ready` even when we already inline-inited. If this echo
    // carries the same content we booted from `#vmark-init`, skip the re-mount (it would reset
    // caret/scroll). Cleared either way so a genuine re-init (content changed mid-open) still runs.
    if (inlineInitedContent !== null && msg.content === inlineInitedContent) {
      inlineInitedContent = null
      return
    }
    inlineInitedContent = null
    // A fresh editor: drop any stale gutter bars from a previous instance.
    lastDiffChanges = []
    clearDiffMarkers()
    document.body.setAttribute('data-wiki-file', msg.wiki?.enabled ? '1' : '0')
    getRouterDeps().applyBodyOptions(msg.options)
    getRouterDeps().applyAutoWrapConfig(msg.options, false)
    getRouterDeps().applyPreviewReflowSetting(
      getRouterDeps().effectivePreviewReflow(msg.options),
    )
    try {
      getRouterDeps().initVditor(msg)
    } catch (error) {
      // Init failed with the saved options — log it to the Output channel (not the
      // hidden webview console, task 151 item 3) and retry with content only.
      reportError(error, 'initVditor failed; retrying with content only')
      getRouterDeps().initVditor({ content: msg.content })
      saveVditorOptions()
    }
  } else if (getRouterDeps().sessionState.streaming) {
    // A large doc is still streaming in; getValue() is partial. Don't diff/setValue
    // against it (would clobber the stream with a monolithic re-render). The content
    // being streamed is already this init's content; external changes re-fire later.
    return
  } else if (vditor.getValue() !== msg.content) {
    const ownedHistory = ownedCheckboxHistory(msg)
    getRouterDeps().cancelAutoWrap()
    getRouterDeps().sessionState.applyingExtensionUpdate = true
    try {
      // setValue rebuilds the DOM and would drop the caret/scroll to the top (#1912).
      // For an external update landing while the user edits, keep them put.
      setHostUpdateValue(msg.content, ownedHistory)
      // The DOM was rebuilt wholesale. Replace the stale cache from the host-canonical
      // snapshot in bounded post-paint batches; an ineligible update just invalidates.
      getRouterDeps().sessionState.editSync?.reseed(
        msg.incrementalSeed,
        ownedHistory?.history.after ?? msg.content,
      )
      getRouterDeps().sessionState.editSync?.reportDocMode()
      // The host replaced the active edit DOM, so an older Preview commit cannot be reused.
      // Reseed the exact host source before refreshing a visible Preview/SV pane; the matching
      // source-render callback is the only event that can unlock source-owned controls.
      const refreshedPreview = refreshVisiblePreviewAfterHostUpdate(
        ownedHistory?.history.after ?? msg.content,
      )
      if (!refreshedPreview)
        (window as any).__vmdeInvalidatePreview?.('content')
    } finally {
      setTimeout(() => {
        getRouterDeps().sessionState.applyingExtensionUpdate = false
        // setValue re-rendered the blocks → re-apply the gutter bars.
        if (window.vditor && lastDiffChanges.length) {
          renderDiffMarkers(window.vditor, lastDiffChanges)
        }
      }, 0)
    }
  }
}

function handleSetTheme(msg: Extract<HostMessage, { command: 'set-theme' }>) {
  ;(window as any).__vmdeInvalidatePreview?.('config')
  const themeKind = msg.themeKind ?? msg.theme
  applyThemeKind(themeKind)
  // Live re-theme without re-initialising (keeps cursor/scroll). Chrome colors
  // already follow via --vscode-* CSS vars.
  const theme = themeMode(msg.theme)
  // Keep the mode current so the D2 'auto' theme picks the right light/dark palette when D2
  // re-renders below. Set BEFORE rethemeDiagrams.
  setD2Config({ mode: theme, themeKind })
  // …and the render cache's key too (task 436). A workbench flip arrives as `set-theme` and NOTHING
  // else — the host posts only this one command (editor-session.ts, onDidChangeActiveColorTheme) —
  // while `themeKey` is `mode|contentTheme|fontSize`. Without this, a flip that moves the mode left
  // the key at the PRE-flip mode: every render PUT afterwards was filed under the wrong mode, and a
  // later open in that mode could be served those SVGs — wrong colours out of the cache, not merely
  // a miss. It also makes the cache-first re-theme lookup below possible at all, since that hashes
  // with whatever key is current. BEFORE rethemeDiagrams, for the same reason config-changed does.
  // (A content theme that pins its own light/dark keeps `effectiveThemeKind` stable, so those
  // themes never drifted — only `auto` did.)
  setRenderCacheConfig({
    themeKey: getRouterDeps().renderCacheThemeKey({
      ...(getRouterDeps().sessionState.lastInitMsg ?? { content: '' }),
      theme,
      themeKind,
    } as InitPayload),
    mode: theme,
  })
  // A VS Code theme flip re-themes EVERYTHING — route through the single authority with all flags on.
  rethemeDiagrams({
    theme,
    code: true,
    mermaid: true,
    echarts: true,
    smiles: true,
    flowchart: true,
    vega: true,
    monoGroup: true,
    geo: true,
    d2: true,
  })
}

function handleEmojiRecents(
  msg: Extract<HostMessage, { command: 'emoji-recents' }>,
) {
  setEmojiPickerRecentState(msg.state)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: applies a live config-changed message across every reload-without-reinit vs constructor-only-option branch; pre-existing (task 469 baseline)
function handleConfigChanged(
  msg: Extract<HostMessage, { command: 'config-changed' }>,
) {
  setEmojiPickerCloseOnSelect(msg.options?.emojiPickerCloseOnSelect !== false)
  setPreviewTaskCheckboxesEnabled(
    msg.options?.interactivePreviewCheckboxes === true,
  )
  ;(window as any).__vmdeInvalidatePreview?.('config')
  // Live config reload (task 26): body-attr / CSS-var options apply without
  // touching Vditor. Constructor-only options (toolbar, word count, …) can't
  // — re-init Vditor with the merged options, preserving the current content.
  getRouterDeps().applyBodyOptions(msg.options)
  getRouterDeps().applyAutoWrapConfig(msg.options, true)
  getRouterDeps().applyPreviewReflowSetting(
    getRouterDeps().effectivePreviewReflow(msg.options),
  )
  // Link-open policy is a plain runtime flag — apply it live (no re-init needed).
  applyLinkOpenSetting(msg.options?.linkOpenWithModifier)
  // Task 392 — paste-a-URL-as-a-link, on by default and switchable off.
  applyPasteUrlSetting(msg.options?.pasteUrlAsLink)
  // Task 218 — a change to vmde.paste.csvFormat must take effect without a reopen, exactly like
  // the URL-paste toggle above.
  applyPasteCsvSetting(msg.options?.pasteCsvAsTable)
  // Task 243 — which heading-slug flavor `#fragment` anchor links resolve against.
  applySlugifyModeSetting(msg.options?.slugifyMode)
  // Task 184 — the cache themeKey is plain runtime state; apply live. A live theme/engine change
  // (below) also re-renders diagrams, which re-populates the cache under the new key.
  const effectiveTheme =
    typeof msg.theme === 'string'
      ? msg.theme
      : (getRouterDeps().sessionState.lastInitMsg?.theme ?? 'light')
  const effectiveThemeKind =
    msg.themeKind ??
    getRouterDeps().sessionState.lastInitMsg?.themeKind ??
    effectiveTheme
  applyThemeKind(effectiveThemeKind)
  const mergedOptions = {
    ...getRouterDeps().sessionState.lastInitMsg?.options,
    ...msg.options,
  }
  // Task 408 — themeKey is now only the GLOBAL fragment (mode/contentTheme/fontSize — see the
  // reduced renderCacheThemeKey in vditor-init.ts); per-engine settings (mermaidTheme, d2Layout,
  // …) feed hashOf's per-lang fragment instead (render-cache-client.ts's engineCacheKeyFragment,
  // driven by `options` below), so a single engine's setting change no longer invalidates every
  // other engine's cached SVGs.
  setRenderCacheConfig({
    themeKey: getRouterDeps().renderCacheThemeKey({
      ...(getRouterDeps().sessionState.lastInitMsg ?? { content: '' }),
      options: mergedOptions,
      theme: effectiveTheme,
      themeKind: effectiveThemeKind,
    } as InitPayload),
    options: mergedOptions,
    // Keep the native-miss offscreen re-render on the current theme (cdn is init-stable).
    mode: themeMode(effectiveTheme),
  })
  // Task 408 — replaces the 8 hand-written `xxxChanged` comparisons that used to live here with a
  // pure, engine-registry-driven diff (diagramConfigDelta) + a generic per-strategy dispatcher
  // (rethemeFlagsFor). See diagram-config-delta.ts for the exhaustiveness net (every
  // VmdeConfigOptions key is either an engine's own configKey or explicitly classified
  // non-diagram) and message-router.test.ts's "task 408 pin" describe block, which asserts this
  // dispatches identically to the old hand-written code for every single-setting case.
  const delta = diagramConfigDelta(
    getRouterDeps().sessionState.lastInitMsg?.options,
    msg.options,
  )
  const contentThemeChanged = delta.changed.has('contentTheme')
  const codeThemeChanged = delta.changed.has('codeTheme')
  // Keep the D2 + geo config current so a re-render uses the new engine/theme/basemap (set before any
  // re-render).
  setD2Config(d2ConfigFromOptions(msg.options))
  ;(window as any).__vmdeAllowRemoteImages = msg.options?.allowRemoteImages
  // Mode rides on a config message for both content-theme pairing and ordinary VS Code theme
  // flips. A non-theme config change carries no msg.theme.
  if (typeof msg.theme === 'string' || typeof msg.themeKind === 'string')
    setD2Config({
      mode: themeMode(msg.theme ?? effectiveTheme),
      themeKind: effectiveThemeKind,
    })
  // Rendering theme (task 82): a GitHub theme pins the editor's light/dark mode to
  // its own (so content + code blocks are themed, not VS Code-dark). The host sends
  // the new effective mode in msg.theme; re-theme live so the content follows it.
  // (contentThemeChanged was computed above, from `delta` — task 408.)
  // Hoisted once: `getRouterDeps()` was called fresh at every access below, so strictNullChecks
  // couldn't carry a `lastInitMsg` truthy-check across separate calls (each is a distinct
  // expression to the compiler, even though the getter is a stable singleton within one
  // synchronous handler invocation). One `deps` const, and a `lastInitMsg` const in each branch
  // right after its own guard, are what let the existing narrowing actually apply — no other
  // behaviour change (task 499's untested-router caveat — kept this fix as literal as possible).
  const deps = getRouterDeps()
  if (
    deps.sessionState.lastInitMsg &&
    deps.initOnlyChanged(deps.sessionState.lastInitMsg.options, msg.options)
  ) {
    const lastInitMsg = deps.sessionState.lastInitMsg
    const content =
      window.vditor && !deps.sessionState.applyingExtensionUpdate
        ? vditor.getValue()
        : lastInitMsg.content
    const wiki = lastInitMsg.wiki
      ? {
          ...lastInitMsg.wiki,
          enabled: msg.options?.wikiEnabled ?? lastInitMsg.wiki.enabled,
        }
      : lastInitMsg.wiki
    deps.initVditor({
      ...lastInitMsg,
      content,
      theme: msg.theme ?? lastInitMsg.theme,
      themeKind: msg.themeKind ?? lastInitMsg.themeKind,
      options: {
        ...lastInitMsg.options,
        ...msg.options,
      },
      wiki,
    })
    return
  }
  if (!deps.sessionState.lastInitMsg || !window.vditor) return
  const lastInitMsg = deps.sessionState.lastInitMsg
  const modeChanged =
    typeof msg.theme === 'string' && msg.theme !== lastInitMsg.theme
  const themeKindChanged =
    typeof msg.themeKind === 'string' && msg.themeKind !== lastInitMsg.themeKind
  lastInitMsg.options = {
    ...lastInitMsg.options,
    ...msg.options,
  }
  // Keep the mermaid-layout global current (task 112) so the initialize wrapper injects the new
  // `config.layout` and rethemeDiagrams' signature reflects it. Read from the MERGED options, not the
  // (possibly partial) config-change subset, so an unrelated setting change never clears it.
  ;(window as any).__vmdeMermaidLayout = lastInitMsg.options?.mermaidLayout
  // A content-theme or workbench-theme switch flips the effective light/dark mode — adopt the
  // host's effective mode so the re-theme below uses it. The github <link>/markdown-body class
  // toggle is handled by applyBodyOptions.
  if (typeof msg.theme === 'string') {
    lastInitMsg.theme = msg.theme
  }
  if (typeof msg.themeKind === 'string') lastInitMsg.themeKind = msg.themeKind
  // Live re-theme through the single authority (task 152 item 3) — each renderer gated by what
  // actually changed. rethemeFlagsFor (task 408) derives the 8 diagram flags from `delta`: a
  // group flips on contentThemeChanged (global — every engine reacts to a palette/mode flip) OR
  // its OWN engine(s)' configKeys changing (mermaidTheme/mermaidLayout for mermaid,
  // d2Layout/d2Theme/d2Sketch for d2, geoBasemap for geo, echartsTheme for echarts/mindmap;
  // flowchart/vega/smiles/mono have no own setting, so contentTheme is their only trigger, same
  // as before). `code` (hljs) isn't a diagram engine, so it stays a direct comparison here.
  const flags = rethemeFlagsFor(delta)
  rethemeDiagrams({
    theme: lastInitMsg.theme === 'dark' ? 'dark' : 'light',
    code:
      codeThemeChanged ||
      contentThemeChanged ||
      modeChanged ||
      themeKindChanged,
    mermaid: flags.mermaid || modeChanged || themeKindChanged,
    echarts: flags.echarts || modeChanged || themeKindChanged,
    flowchart: flags.flowchart || modeChanged || themeKindChanged,
    vega: flags.vega || modeChanged || themeKindChanged,
    smiles: flags.smiles || modeChanged || themeKindChanged,
    monoGroup: flags.monoGroup || modeChanged || themeKindChanged,
    geo: flags.geo || modeChanged || themeKindChanged,
    d2: flags.d2 || modeChanged || themeKindChanged,
  })
}

function handleReloadCss(msg: Extract<HostMessage, { command: 'reload-css' }>) {
  ;(window as any).__vmdeInvalidatePreview?.('config')
  // Live CSS swap (tasks 12/26): replace the customCss or external-CSS <style>
  // node in place.
  getRouterDeps().swapStyle(msg.id, msg.css)
}

// Task 513 — a local image was replaced on disk under the same path; its cached URL still serves
// the OLD bytes, so revalidate it. Fire-and-forget: nothing downstream waits on the repaint.
function handleAssetsChanged(
  msg: Extract<HostMessage, { command: 'assets-changed' }>,
) {
  void refreshChangedImages(document, msg.paths)
}

function handleGetCursorOffset(
  msg: Extract<HostMessage, { command: 'get-cursor-offset' }>,
) {
  // Reveal-in-Source (task 16): report the caret position so the host can select
  // the matching line. Restore the last in-editor caret first (the toolbar button
  // blurs the iframe and collapses the live selection). Reply with the line number
  // AND that line's text — both measured against vditor.getValue() — so the host
  // can match by content in the on-disk doc (which may differ by Vditor's on-load
  // reflow) rather than a raw offset that drifts across the two text spaces. Always
  // reply (line -1 when unresolved) so the host's awaited round-trip never hangs.
  let line = -1
  let lineText = ''
  if (window.vditor) {
    restoreEditorCaretIfLost()
    const offset = getCursorSourceOffset(window.vditor)
    if (offset >= 0) {
      const res = lineAndTextForOffset(window.vditor.getValue(), offset)
      line = res.line
      lineText = res.lineText
    }
  }
  vscode.postMessage({
    command: 'cursor-offset',
    requestId: msg.requestId,
    line,
    lineText,
  })
}

function handleDiffInfo(msg: Extract<HostMessage, { command: 'diff-info' }>) {
  // Git gutters (task 17): stash + render the change bars.
  lastDiffChanges = (msg.changes || []) as DiffChange[]
  if (window.vditor) renderDiffMarkers(window.vditor, lastDiffChanges)
}

function handleUploaded(msg: Extract<HostMessage, { command: 'uploaded' }>) {
  // Which markup a given uploaded kind gets is upload-handler's table (uploadedMarkup), not this
  // dispatcher's business — see the comment there.
  for (const f of msg.files) vditor.insertValue(uploadedMarkup(f))
}

// Scroll the webview to the Nth heading (the native-outline tree click, task 78, and — since
// task 243 — the host's resolution of a cross-doc `file.md#frag` anchor link too). Headings
// render in document order across IR/WYSIWYG/SV, so the source-parsed ordinal lines up with the
// Nth <h1-6> in the active editor element. The scroll+flash itself lives in outline.ts
// (scrollToHeadingIndex) so the webview's own same-doc `#fragment` click handling can call the
// SAME function in-process, without a host round-trip.
function handleScrollToHeading(
  msg: Extract<HostMessage, { command: 'scroll-to-heading' }>,
) {
  noteExplicitReadingPositionReveal()
  scrollToHeadingWithRetry(msg.index)
}

function handleRevealLine(
  msg: Extract<HostMessage, { command: 'reveal-line' }>,
) {
  noteExplicitReadingPositionReveal()
  revealLineWithRetry(msg.line, msg.lineText, beginE2EActivity('reveal-line'))
}

function handleOpenFindReplace(
  msg: Extract<HostMessage, { command: 'open-find-replace' }>,
) {
  if (msg.mode !== 'find' && msg.mode !== 'replace') {
    logToHost('[main] invalid open-find-replace mode — dropped')
    return
  }
  // Task 580 CP2-13: any Find trigger arrives here, so a hoisted view exits before Find opens.
  exitHoistForFind()
  openFindReplace(msg.mode)
}

const FIND_WIDGET_ACTIONS = {
  next: true,
  previous: true,
  'toggle-case': true,
  'toggle-whole-word': true,
  'replace-one': true,
  'replace-all': true,
  close: true,
} satisfies Record<FindWidgetAction, true>

function handleFindWidgetAction(
  msg: Extract<HostMessage, { command: 'find-widget-action' }>,
) {
  if (!Object.hasOwn(FIND_WIDGET_ACTIONS, msg.action)) {
    logToHost('[main] invalid find-widget-action action — dropped')
    return
  }
  runFindWidgetAction(msg.action)
}

function handleEditorAction(
  msg: Extract<HostMessage, { command: 'editor-action' }>,
) {
  // Task 580 — checked against the dispatcher's own action table before it runs, so a drifted or
  // forged name is logged and dropped, the same contract as Task 579's Find actions above.
  if (!isEditorAction(msg.action)) {
    logToHost('[main] invalid editor-action action — dropped')
    return
  }
  runEditorAction(msg.action)
}

function handleToggleSectionFold() {
  toggleFoldAtCaret()
}

// Task 468 debugging — real-VS-Code evidence (repeatable, not intermittent) showed the HOST side
// of a cross-doc `file.md#frag` open doing everything right (target index resolved, panel found,
// `postMessage` awaited) while the webview never scrolled. Root cause: a freshly-opened panel's
// `scroll-to-heading` can arrive before Vditor has finished rendering the document into the DOM —
// `window.vditor` is assigned synchronously in vditor-init.ts, but heading elements only exist
// once Vditor's own (not guaranteed-synchronous) content render has run; `vditor-init.ts`'s
// `after()` callback is the documented "fully mounted" signal, and nothing here was waiting for
// it. `scrollToHeadingIndex` silently returns `false` when the DOM isn't ready yet (no headings
// to scroll to), and — unlike the host's own `findPanelForUri` poll for the analogous "not
// registered yet" race in asset-link-actions.ts — nothing retried: the message landed and did
// nothing, forever. Poll on the SAME 50ms/2s budget the host already uses for its half of this
// race; the common case (doc already open, outline-tree click) still succeeds on attempt #1.
const SCROLL_RETRY_INTERVAL_MS = 50
const SCROLL_RETRY_BUDGET_MS = 2000
function scrollWithRetry(
  label: string,
  attempt: (quiet: boolean) => boolean,
  waitedMs = 0,
  complete: () => void = () => {
    /* no E2E activity ledger for ordinary heading scrolls */
  },
): void {
  // Only the FIRST attempt logs through scrollToHeadingIndex's own trace line; a worst-case
  // give-up would otherwise emit ~40 near-identical Output-channel lines (one per 50ms poll
  // tick) for what's meant to be a rare edge case, not the common path. This function logs its
  // own one-line summary instead once the retry loop actually has something to say.
  const quiet = waitedMs > 0
  let succeeded = false
  try {
    succeeded = attempt(quiet)
  } catch (error) {
    if (waitedMs >= SCROLL_RETRY_BUDGET_MS) {
      markE2EError(label, error)
      reportError(error, label)
      complete()
      return
    }
    setTimeout(
      () =>
        scrollWithRetry(
          label,
          attempt,
          waitedMs + SCROLL_RETRY_INTERVAL_MS,
          complete,
        ),
      SCROLL_RETRY_INTERVAL_MS,
    )
    return
  }
  if (succeeded) {
    if (quiet) {
      logToHost(`[${label}] succeeded after ${waitedMs}ms of retry`)
    }
    complete()
    return
  }
  if (waitedMs >= SCROLL_RETRY_BUDGET_MS) {
    logToHost(`[${label}] gave up after ${waitedMs}ms — target never rendered`)
    markE2EError(label, 'gave-up')
    complete()
    return
  }
  setTimeout(
    () =>
      scrollWithRetry(
        label,
        attempt,
        waitedMs + SCROLL_RETRY_INTERVAL_MS,
        complete,
      ),
    SCROLL_RETRY_INTERVAL_MS,
  )
}

function scrollToHeadingWithRetry(index: number): void {
  scrollWithRetry('scroll-to-heading', (quiet) =>
    Boolean(window.vditor && scrollToHeadingIndex(window.vditor, index, quiet)),
  )
}

function revealLineWithRetry(
  line: number,
  lineText: string,
  complete: () => void,
): void {
  scrollWithRetry(
    'reveal-line',
    () =>
      Boolean(window.vditor && revealSourceLine(window.vditor, line, lineText)),
    0,
    complete,
  )
}

// Task 287 — paste as PLAIN text (Ctrl+Shift+V). The host read the clipboard and sent the text; all
// that is left is inserting it as markdown SOURCE. `insertValue` is exactly that path — it spins the
// string through Lute as markdown and never touches text/html, which is what makes this chord
// different from Ctrl+V (whose whole job is converting rich HTML). Typora-compatible semantics: a
// literal `# x` in the clipboard still becomes a heading, because the SOURCE is what was pasted.
//
// Composition with the sibling paste tasks, per 287's own scope: the ANSI strip (task 242) still
// applies — invisible control bytes are never wanted, plain or not — but the TSV/CSV table
// conversion (task 218) is deliberately BYPASSED, because "plain" is an explicit instruction not to
// reformat. That is why this calls stripAnsi directly rather than transformPastedText.
function handlePastePlain(
  msg: Extract<HostMessage, { command: 'paste-plain' }>,
) {
  if (!window.vditor || typeof msg.text !== 'string' || !msg.text) return
  window.vditor.insertValue(stripAnsi(msg.text), true)
}

// Task 255 — `vmde.fixListNumbering` / `vmde.renormalizeAllLists`. Both are silent no-ops
// when there's nothing to do (no list at the caret / no list in the document at all) — same
// "declined, don't eat the trigger" contract as activate-link-at-caret's dispatch above.
function handleFixListNumbering() {
  const editor = window.vditor && activeModeElement(window.vditor)
  if (!editor) return
  if (window.vditor?.vditor.currentMode === 'sv') {
    runSourceListCommand(window, 'caret')
    return
  }
  fixListNumberingAtCaret(window.vditor.vditor as never, editor)
}

function handleRenormalizeAllLists() {
  const editor = window.vditor && activeModeElement(window.vditor)
  if (!editor) return
  if (window.vditor?.vditor.currentMode === 'sv') {
    runSourceListCommand(window, 'all')
    return
  }
  fixAllListNumbering(window.vditor.vditor as never, editor)
}

// Task 505 — one of the `vmde.format.*` VS Code commands fired. There is no dedupe check here
// any more (task 492 Phase 4's `toolbar-hotkey-dedupe.ts`, now deleted): every toolbar item a
// command clicks has `hotkey: ''` in toolbar.ts, so Vditor's own in-webview handler never sees its
// key — nothing competes with this handler for any name.
//
// `undo`/`redo` call the undo engine directly — see inner-vditor.ts's `undo` field for why (the
// toolbar button's disabled state lags the undo stack by Vditor's `undoDelay` debounce). Task 580
// CP2-3 makes this the keyboard path too: VS Code's Undo/Redo keys run `vmde.format.undo`/`redo`,
// which post this message (editing/undo-keybind.ts header). The branch runs before the command
// selection restore, so Undo keeps the live selection. Task 603 item 2: when a text field (Find,
// Replace, link popover) has focus, Undo/Redo runs that field's own native history instead of the
// document engine.
//
// Every other name dispatches a click on the toolbar item's own button (`children[0]`), the
// exact call Vditor's baked-in hotkey handler makes on itself (editorCommonEvent.ts's
// `vditor.toolbar.elements[name].children[0].dispatchEvent(...)`) — so this reuses the SAME
// formatting logic, never a second implementation. `cancelable: true` matters: MenuItem.ts's own
// click handler calls `event.preventDefault()`.
function handleTriggerToolbarHotkey(
  msg: Extract<HostMessage, { command: 'trigger-toolbar-hotkey' }>,
) {
  // Task 580 — only the toolbar names of the shared table's `vmde.format.*` commands. Before this
  // check the handler clicked any toolbar item a message named (for example `preview` or `upload`).
  if (!TOOLBAR_COMMAND_NAMES.has(msg.name)) {
    logToHost('[main] invalid trigger-toolbar-hotkey name — dropped')
    return
  }
  if (msg.name === 'undo' || msg.name === 'redo') {
    // Undo keeps the live selection, but its chord's snapshot is consumed here, not left for a
    // later chord-less command to restore.
    discardCommandSelection()
    // Task 597: drop any caret request still live from an earlier undo checkpoint or restore (it
    // stays armed for up to 5 s). A Palette or menu Undo reaches here with no webview key or
    // pointer to invalidate it, and it would pull the caret this Undo restores back to the older
    // position. The restore's own fallback (undo-restore-caret.ts) arms a fresh request.
    invalidateCaret()
    // Task 603 item 2: VS Code routes its Undo/Redo keys here even while the webview's Find,
    // Replace or link-popover field has focus, where the user expects the field's own typing
    // undone, not the document. `execCommand` acts on the focused field's native history. Return
    // even when it reports false (empty field history), so a field with nothing left to undo does
    // not fall through and undo the document instead. The editor-focused case is untouched: the
    // engine runs exactly once (Tasks 463/580).
    if (focusedTextInput()) {
      document.execCommand(msg.name)
      return
    }
    const inner = innerVditor()
    inner?.undo?.[msg.name]?.(inner)
    return
  }
  // Task 580 policy 7: restore the originating chord's selection (any key, any binding); a
  // Palette route has no chord and keeps the live selection.
  restoreCommandSelection()
  // Task 600 B2: refuse blockless IR inline formats and list toggles before Task 596's gate.
  if (refusesBlocklessInlineFormat(msg.name)) return
  // Task 596: act on the LIVE selection. Vditor's click reads the button's disabled/current
  // classes, which lag the selection by its 200 ms highlight debounce (measured ~200 ms, up to
  // ~0.9 s on the large fixture) and are never refreshed for programmatic selections or in SV. The
  // gate recomputes both classes from the live range on this one button and clicks it, replacing
  // Task 506's strip of the disabled class on indent/outdent/list-family buttons. 'Blocked' (full
  // Preview, read-only, no editor) clicks nothing.
  clickToolbarHotkeyButton(msg.name)
}

type HostMessageHandlers = {
  [K in HostMessage['command']]: (
    msg: Extract<HostMessage, { command: K }>,
  ) => void
}

// Task 148 item 3 (second half): TypeScript's HostMessage union checks internal callers, not what
// actually arrives on the wire — a malformed or drifted message reached its handler as-is and
// failed as a runtime shape error INSIDE the handler rather than a rejection at this seam.
// Lightweight discriminant + required-field check per command, listing only fields a handler
// unconditionally reads (see each `handleXxx` above) — deliberately no schema library for a
// trusted-ish same-process seam; the value is turning silent shape drift into a logToHost signal,
// which is why a failure here is routed through the SAME logToHost the unhandled-command branch
// below already uses, never thrown.
const REQUIRED_HOST_MESSAGE_FIELDS: Partial<
  Record<HostMessage['command'], RequiredField[]>
> = {
  update: [['content', 'string']],
  'set-theme': [['theme', 'string']],
  'config-changed': [], // options is read via optional chaining throughout handleConfigChanged
  'reload-css': [
    ['id', 'string'],
    ['css', 'string'],
  ],
  'assets-changed': [['paths', 'array']],
  'get-cursor-offset': [['requestId', 'string']],
  'diff-info': [['changes', 'array']],
  uploaded: [['files', 'array']],
  announce: [['message', 'string']],
  'scroll-to-heading': [['index', 'number']],
  'reveal-line': [
    ['line', 'number'],
    ['lineText', 'string'],
  ],
  'open-find-replace': [['mode', 'string']],
  'find-widget-action': [['action', 'string']],
  'toggle-section-fold': [],
  'paste-plain': [['text', 'string']],
  'activate-link-at-caret': [],
  'fix-list-numbering': [],
  'renormalize-all-lists': [],
  'request-block-transform-options': [],
  'apply-block-transform-choice': [['token', 'number']],
  'cancel-block-transform-choice': [['token', 'number']],
  'format-table': [],
  'rewrap-selection': [],
  'shift-heading-level': [
    ['direction', 'number'],
    ['section', 'boolean'],
  ],
  'prepare-rewrap-document': [],
  'rewrap-document': [['content', 'string']],
  'move-outline-section': [],
  'prepare-block-action': [
    ['requestId', 'string'],
    ['before', 'string'],
    ['after', 'string'],
  ],
  'block-action-outcome': [
    ['requestId', 'string'],
    ['status', 'string'],
  ],
  'preview-task-checkbox-outcome': [
    ['requestId', 'string'],
    ['status', 'string'],
    ['source', 'string'],
  ],
  'trigger-toolbar-hotkey': [['name', 'string']],
  'editor-action': [['action', 'string']],
  'flush-for-save': [['requestId', 'string']],
  'wiki-update': [['pageKeys', 'array']],
  'diagram-cache-hits': [['requestId', 'string']],
  'code-refs-resolved': [
    ['requestId', 'string'],
    ['existing', 'array'],
  ],
}

// Task 580 policy 7 ("selection capture follows the command's message"): a command that acts on
// the caret or the selection first restores the selection its originating chord saw (any key, any
// binding), as the formatting (`trigger-toolbar-hotkey`) and `editor-action` routes do. A chord's
// own keydown can move the live selection before its command arrives: Vditor's first keydown
// after load (`recordFirstPosition`) splits the caret's text node and leaves a non-collapsed
// Range, which a caret-gesture then refuses. A Command Palette route has no chord snapshot and
// keeps the live selection, and the restore never pulls focus out of another VMDE widget. Find
// widget actions are excluded: the Find widget owns its own input focus and seed.
function withChordSelection<M extends HostMessage>(
  handler: (message: M) => void,
): (message: M) => void {
  return (message) => {
    restoreCommandSelection(window, { focusEditor: false })
    handler(message)
  }
}

const messageHandlers: HostMessageHandlers = {
  update: handleUpdate,
  'set-theme': handleSetTheme,
  'emoji-recents': handleEmojiRecents,
  'config-changed': handleConfigChanged,
  'reload-css': handleReloadCss,
  'assets-changed': handleAssetsChanged,
  'get-cursor-offset': handleGetCursorOffset,
  'diff-info': handleDiffInfo,
  uploaded: handleUploaded,
  announce: (message) => announce(message.message),
  'scroll-to-heading': handleScrollToHeading,
  'reveal-line': handleRevealLine,
  'open-find-replace': handleOpenFindReplace,
  'find-widget-action': handleFindWidgetAction,
  'toggle-section-fold': withChordSelection(handleToggleSectionFold),
  'paste-plain': withChordSelection(handlePastePlain),
  // Task 457/459 — `vmde.activateLinkAtCaret`'s trigger for the shared caret-gesture dispatch
  // (util/caret-gesture.ts); since Task 580 CP2-8 it is the only one (no webview Ctrl/Cmd+Enter
  // listener). The message name (`activate-link-at-caret`) predates task 459's unification — kept
  // as-is (see src/app/commands.ts's comment) since renaming would touch a passing e2e spec for no
  // functional gain; what it triggers is no longer link-only, it's whatever the caret is on.
  'activate-link-at-caret': withChordSelection(() => {
    runCaretGestureHandlers()
  }),
  'fix-list-numbering': withChordSelection(handleFixListNumbering),
  'renormalize-all-lists': handleRenormalizeAllLists,
  'request-block-transform-options': withChordSelection(() => {
    const options = requestBlockTransformOptions(window)
    if (!options) return
    vscode.postMessage({
      command: 'block-transform-options',
      token: options.token,
      currentType: options.currentType,
      fenceLanguage: options.fenceLanguage,
      targets: options.targets,
    })
  }),
  'apply-block-transform-choice': (message) => {
    if (!message.target || typeof message.target.type !== 'string') return
    applyBlockTransformChoice(
      window,
      message.token,
      message.target,
      message.confirmed === true,
    )
  },
  'cancel-block-transform-choice': (message) => {
    cancelBlockTransformChoice(message.token)
  },
  'format-table': withChordSelection(() => getRouterDeps().runFormatTable()),
  'rewrap-selection': withChordSelection(() => getRouterDeps().runRewrap()),
  'shift-heading-level': withChordSelection((message) => {
    if (message.direction !== -1 && message.direction !== 1) return
    getRouterDeps().shiftHeadingLevel(message.direction, message.section)
  }),
  'prepare-rewrap-document': () => getRouterDeps().prepareRewrapDocument(),
  'rewrap-document': (message) =>
    getRouterDeps().runRewrapDocument(message.content),
  'prepare-block-action': (message) => prepareBlockAction(message),
  'block-action-outcome': (message) => finishBlockAction(message),
  'preview-task-checkbox-outcome': (message) =>
    finishPreviewTaskCheckboxOutcome(message),
  'move-outline-section': (message) => {
    const identity = (
      value: unknown,
    ): value is { start: number; level: number } =>
      typeof value === 'object' &&
      value !== null &&
      Number.isSafeInteger((value as { start?: unknown }).start) &&
      Number.isSafeInteger((value as { level?: unknown }).level)
    if (
      (message.placement !== 'before' && message.placement !== 'after') ||
      !identity(message.source) ||
      !identity(message.target)
    )
      return
    getRouterDeps().runOutlineSectionMove(
      message.source,
      message.target,
      message.placement,
    )
  },
  'prepare-outline-section-move': (message) =>
    getRouterDeps().prepareOutlineSectionMove(message),
  'outline-section-move-outcome': (message) =>
    getRouterDeps().finishOutlineSectionMove(message),
  'trigger-toolbar-hotkey': handleTriggerToolbarHotkey,
  'editor-action': handleEditorAction,
  // Task 580 CP2-12 — the host's will-save flush; see save-flush.ts.
  'flush-for-save': (msg) => {
    const editSync = getRouterDeps().sessionState.editSync
    answerFlushForSave(
      msg.requestId,
      editSync ? () => editSync.flush() : undefined,
      (reply) => vscode.postMessage(reply),
    )
  },
  'wiki-update': (msg) => {
    if (!Array.isArray(msg.pageKeys)) return
    getRouterDeps().sessionState.wikiKnownPages.clear()
    for (const k of msg.pageKeys)
      getRouterDeps().sessionState.wikiKnownPages.add(k)
    getRouterDeps().sessionState.wikiDisplayNames.clear()
    if (Array.isArray(msg.displayNames)) {
      for (const n of msg.displayNames)
        getRouterDeps().sessionState.wikiDisplayNames.add(n)
    }
  },
  // Task 184 — the host's reply with cached diagram SVGs: paint hits, unblock misses.
  'diagram-cache-hits': (msg) => applyCacheHits(msg.requestId, msg.svgByHash),
  // Task 229 — the host's reply to `resolve-code-refs`: chip the now-known-to-exist paths.
  'code-refs-resolved': (msg) =>
    applyCodeRefResolution(msg.requestId, msg.existing),
}

// Task 148 item 3 (origin check — WARN-ONLY, deliberately never drops). Empirically measured
// (2026-07-28, test/vscode-e2e/webview-message-origin-probe.spec.ts) in desktop VS Code under
// xvfb: the `vscode-webview://<token>` origin's TOKEN is per-VS-Code-launch random (three
// different tokens across three separate launches) — never hardcode it — but the origin is
// STABLE within one running instance across multiple messages, a fully disposed-and-recreated
// panel for the same doc, and a second independent panel (24/24 captured messages, one origin,
// one `e.source` shape). That would support a SCHEME-level pattern check (`vscode-webview://…`,
// not the token) safely — IN DESKTOP VS CODE.
//
// But VMDE's own `package.json` declares `"extensionKind": ["workspace"]` and
// `"virtualWorkspaces": { "supported": "limited" }` — so it also runs in BROWSER-HOSTED VS Code
// (Codespaces, github.dev-style hosts), an environment this repo's e2e harness cannot launch or
// measure. There, the webview is served from a real browser tab and the origin is NOT
// `vscode-webview://` at all — it's an `https://…vscode-cdn.net`-family origin instead. A DROP
// based on the desktop-only pattern would silently reject EVERY host→webview message in that
// untested environment — no error, no render, no config, no content, ever — the exact
// catastrophic-silent-failure this task has been parked on all session, just relocated somewhere
// this repo can't see it happen. So: log an unexpected origin ONCE per webview session (never
// per-message — that would flood the Output channel) and ALWAYS dispatch regardless. Tighten this
// to a drop only once the warning has been observed quiet across real desktop + remote +
// Codespaces usage — see tasks/148-webview-security-hardening.md for the full write-up.
const VSCODE_WEBVIEW_ORIGIN_RE = /^vscode-webview:\/\//

// Wire the host→webview message listener. Called once from main.ts.
export function installMessageRouter(win: Window): void {
  // Scoped to this call (one webview session), not module-level — so a page load gets exactly
  // one warning, not zero after the first ever webview instance in the process.
  let warnedUnexpectedOrigin = false
  win.addEventListener('message', (e) => {
    const msg = e.data as HostMessage | undefined
    if (!msg || typeof msg.command !== 'string') return
    if (!VSCODE_WEBVIEW_ORIGIN_RE.test(e.origin) && !warnedUnexpectedOrigin) {
      warnedUnexpectedOrigin = true
      logToHost(
        `[main] unexpected message origin "${e.origin}" (expected vscode-webview://…) — dispatching anyway, warn-only (task 148 item 3; see tasks/148-webview-security-hardening.md)`,
      )
    }
    // Indexed through a string record because TS can't prove `handler` matches
    // `msg` once the discriminant is a runtime string — the map type above already
    // guarantees each entry is sound, so the per-call narrowing is safe to bridge.
    const handler = (
      messageHandlers as Record<string, ((m: HostMessage) => void) | undefined>
    )[msg.command]
    if (!handler) {
      logToHost(`[main] unhandled host message: ${msg.command}`)
      return
    }
    const badField = firstShapeViolation(
      REQUIRED_HOST_MESSAGE_FIELDS,
      msg as unknown as Record<string, unknown>,
      msg.command,
    )
    if (badField) {
      logToHost(
        `[main] malformed host message "${msg.command}": missing/invalid field "${badField}" — dropped, not dispatched`,
      )
      return
    }
    handler(msg)
  })
  markRouterReady()
}
