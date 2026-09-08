import * as vscode from 'vscode'
import {
  MarkdownOutlineDragAndDropController,
  MarkdownOutlineProvider,
} from '../markdown/outline-tree'
import { prewarmLute } from '../lute/lute-host'
import { disposeAllCaches } from '../wiki/wiki-cache'
import {
  getCommandTarget,
  isSupportedMarkdownUri,
  updateEditorContexts,
} from '../platform/tab-targeting'
import {
  ConfigurationRoot,
  MarkdownEditorViewType,
  OutlineViewId,
  ProductDisplayName,
} from '../shared/product-identity'
import { setupStatusBar } from './status-bar'
import { registerCommands } from './commands'
import { vmdeConfig } from '../platform/editor-config'
import { debug, initLogger, showError } from '../platform/host-log'
import {
  docLargeMode,
  setOutlineRefresher,
  setStatusBarRefresher,
  webviewEditorMode,
} from '../platform/host-session-state'
import { revealCaretInSource } from '../session/reveal-caret'
import { MarkdownEditorProvider } from './markdown-editor-provider'
import { KeyOutlineWidth, KeyVditorOptions } from '../platform/state-keys'
import {
  activeEditPerf,
  clearEditPerf,
  followerEditPerf,
  snapshotEditPerf,
} from '../platform/edit-perf'

// Task 405 — EditorSession/MarkdownEditorProvider now live in their own files;
// extension.ts is activation + composition only, mirroring what task 399 did for
// media-src/src/main.ts. Re-exported here so existing test-facing imports from
// '../../src/extension' (editor-session.test.ts, extension.test.ts, font-size.test.ts,
// i18n-lang.test.ts, status-bar.test.ts, …) keep working unmodified.
export { EditorSession } from '../session/editor-session'
export {
  MarkdownEditorProvider,
  resolveVditorI18nLang,
} from './markdown-editor-provider'
export { resolveFontSize as resolveFontSizeCss } from '../shared/theme-registry'
export { docLargeMode, webviewEditorMode } from '../platform/host-session-state'

export function activate(context: vscode.ExtensionContext) {
  const logger = vscode.window.createOutputChannel(ProductDisplayName, {
    log: true,
  })
  initLogger(logger)
  context.subscriptions.push(logger)
  context.subscriptions.push({ dispose: disposeAllCaches })

  // Warm the host-side Lute now so the first file open already gets the instant
  // pre-rendered paint (see src/lute-host.ts). Deferred off the activation path.
  prewarmLute(context.extensionPath)

  const updateStatusBar = setupStatusBar(
    context,
    docLargeMode,
    webviewEditorMode,
  )
  // Let a webview's large/normal-mode report (task 69) refresh the status-bar marker.
  setStatusBarRefresher(updateStatusBar)

  // Markdown Outline tree (task 78): a sidebar TreeView, because VS Code's
  // built-in Outline does not query DocumentSymbolProvider while a custom editor
  // is active (microsoft/vscode#97095). Tracks the active VMDE/text markdown
  // document and lets a click scroll the webview to that heading.
  const outlineProvider = new MarkdownOutlineProvider()
  const outlineDragAndDrop = new MarkdownOutlineDragAndDropController()
  let lastHasOutline: boolean | undefined
  const updateOutline = () => {
    const enabled = vmdeConfig().get<boolean>('outline.tree') !== false
    const target = enabled ? getCommandTarget() : undefined
    const doc =
      target && isSupportedMarkdownUri(target)
        ? vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === target.toString(),
          )
        : undefined
    outlineProvider.refresh(doc)
    const has = !!doc
    if (has !== lastHasOutline) {
      lastHasOutline = has
      void vscode.commands.executeCommand(
        'setContext',
        `${ConfigurationRoot}.hasOutline`,
        has,
      )
    }
  }
  // Debounced — a single file switch fires many editor/tab/view-state events;
  // coalesce them so the tree rebuilds once (not 4–5×, which froze the UI).
  let outlineTimer: NodeJS.Timeout | undefined
  let outlinePerfId: string | undefined
  const scheduleOutline = (perfId?: string) => {
    if (outlineTimer) clearTimeout(outlineTimer)
    if (perfId) outlinePerfId = perfId
    outlineTimer = setTimeout(() => {
      const started = performance.now()
      updateOutline()
      followerEditPerf(outlinePerfId, {
        outlineRefreshMs: performance.now() - started,
      })
      outlinePerfId = undefined
    }, 120)
  }

  setOutlineRefresher(scheduleOutline)
  const refreshContexts = () => {
    void updateEditorContexts()
    updateStatusBar()
    scheduleOutline()
  }
  // Live reading-time on edits, debounced so it doesn't recompute per keystroke.
  let statusBarTimer: NodeJS.Timeout | undefined
  let statusPerfId: string | undefined
  const debouncedStatusBar = (perfId?: string) => {
    if (statusBarTimer) clearTimeout(statusBarTimer)
    if (perfId) statusPerfId = perfId
    statusBarTimer = setTimeout(() => {
      const started = performance.now()
      updateStatusBar()
      followerEditPerf(statusPerfId, {
        statusRefreshMs: performance.now() - started,
      })
      statusPerfId = undefined
    }, 300)
  }

  registerCommands(context, {
    debug,
    showError,
    revealCaretInSource,
    findPanelForUri: (uri) => MarkdownEditorProvider.findPanelForUri(uri),
  })

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorViewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: {
          // Always ON = instant tab switching (task 37). The user setting
          // (advanced.retainHidden) was removed 2026-07-01 — the reload on
          // re-show with it OFF proved too disruptive to ever want.
          retainContextWhenHidden: true,
          enableFindWidget: true,
        },
      },
    ),
    vscode.window.onDidChangeActiveTextEditor(refreshContexts),
    vscode.window.tabGroups.onDidChangeTabs(refreshContexts),
    vscode.workspace.onDidOpenTextDocument(refreshContexts),
    vscode.workspace.onDidCloseTextDocument(refreshContexts),
    // One text-change listener drives both the debounced reading-time/status-bar
    // refresh and the outline rebuild (was two separate onDidChangeTextDocument
    // registrations doing one concern each).
    vscode.workspace.onDidChangeTextDocument((e) => {
      const perfId = activeEditPerf()
      debouncedStatusBar(perfId)
      if (e.document.uri.toString() === outlineProvider.uri?.toString())
        scheduleOutline(perfId)
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${ConfigurationRoot}.outline.tree`))
        scheduleOutline()
    }),
    vscode.window.createTreeView(OutlineViewId, {
      treeDataProvider: outlineProvider,
      dragAndDropController: outlineDragAndDrop,
    }),
  )

  context.globalState.setKeysForSync([KeyVditorOptions, KeyOutlineWidth])
  refreshContexts()
  // Test API (task 187): the real-VS-Code suite asserts the webview→host editorMode
  // report end-to-end (sv-split.spec reads this map via extension.exports).
  return {
    webviewEditorMode,
    ...(process.env.VMDE_E2E === '1'
      ? {
          editPerf: {
            clear: clearEditPerf,
            snapshot: snapshotEditPerf,
          },
          // Narrow real-VS-Code seam: native TreeView DnD has no browser-drivable gesture,
          // so the regression invokes the registered controller rather than a duplicate.
          outlineProvider,
          outlineDragAndDrop,
        }
      : {}),
  }
}
