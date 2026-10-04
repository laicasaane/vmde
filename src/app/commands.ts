import * as vscode from 'vscode'
import type { HeadingItem } from '../markdown/outline-tree'
import {
  activeSourceReveal,
  findTabForUri,
  getCommandTarget,
  isDiffContextForUri,
  isSupportedMarkdownUri,
} from '../platform/tab-targeting'
import { ExtensionId, MarkdownEditorViewType } from '../shared/product-identity'
import { EDITOR_SHORTCUTS, type PanelRoute } from '../shared/editor-shortcuts'

// What the commands need from extension.ts, injected so this module needn't import
// (and cycle with) the provider or the module-level logger/reveal helpers.
interface CommandDeps {
  debug: (...args: unknown[]) => void
  showError: (msg: string) => void
  revealCaretInSource: (
    panel: vscode.WebviewPanel,
    docUri: vscode.Uri,
    viewColumn: vscode.ViewColumn,
  ) => Promise<void>
  findPanelForUri: (
    uri: vscode.Uri,
  ) => { panel: vscode.WebviewPanel; ready?: boolean } | undefined
}

// The open* commands share this target-resolve + guard prologue. The guard SET varies by
// command (openEditor/openInSplit reject diff + require a supported md uri; openTextEditor
// only needs a target; openSourceToSide requires a supported uri but tolerates diff), so
// the two optional guards are toggled by flags — the check order (not-found → diff →
// supported) and error messages are preserved exactly. Returns undefined (after showing the
// matching error) when a guard fails, so the caller bails.
function resolveOpenTarget(
  uri: vscode.Uri | undefined,
  deps: CommandDeps,
  opts: { rejectDiff?: boolean; requireSupported?: boolean },
): vscode.Uri | undefined {
  const target = getCommandTarget(uri)
  if (!target) {
    deps.showError(`Cannot find markdown file!`)
    return undefined
  }
  if (opts.rejectDiff && isDiffContextForUri(target)) {
    deps.showError(`Markdown editor is unavailable in diff editors.`)
    return undefined
  }
  if (opts.requireSupported && !isSupportedMarkdownUri(target)) {
    deps.showError(`Markdown editor can only open local markdown files.`)
    return undefined
  }
  return target
}

// Resolve the panel for the active editor's document — shared by the host-triggered commands
// below (paste-plain and every shared-table panel route) that have no view
// of the live caret/selection themselves: they just forward their trigger to whichever panel is
// showing the active editor's document, same target-resolve pattern as `vmde.pastePlain`'s
// original comment describes. Task 502 — jscpd flagged 4 near-identical copies of this
// uri-then-panel resolve (differing only in which `command` each then posts).
function resolveActivePanel(
  deps: CommandDeps,
): { panel: vscode.WebviewPanel; uri: vscode.Uri } | undefined {
  const target = resolveOpenTarget(undefined, deps, {})
  if (!target) return undefined
  const entry = deps.findPanelForUri(target)
  return entry ? { ...entry, uri: target } : undefined
}

// openEditor and openInSplit resolve their target with the exact same debug+guard call
// (reject diff editors, require a supported markdown uri) before diverging on which
// `vscode.openWith` variant to run. Task 502 — jscpd flagged the byte-identical copy.
function resolveSupportedEditorTarget(
  uri: vscode.Uri | undefined,
  args: unknown[],
  deps: CommandDeps,
): vscode.Uri | undefined {
  deps.debug('command', uri, args)
  return resolveOpenTarget(uri, deps, {
    rejectDiff: true,
    requireSupported: true,
  })
}

async function openNewVisualWithReveal(
  target: vscode.Uri,
  deps: CommandDeps,
  viewColumn?: vscode.ViewColumn,
): Promise<void> {
  const reveal = activeSourceReveal(target)
  const priorPanel = deps.findPanelForUri(target)?.panel
  await vscode.commands.executeCommand(
    'vscode.openWith',
    target,
    MarkdownEditorViewType,
    ...(viewColumn === undefined ? [] : [viewColumn]),
  )
  if (reveal) await postRevealWhenPanelReady(target, reveal, deps, priorPanel)
}

async function postRevealWhenPanelReady(
  target: vscode.Uri,
  reveal: { line: number; lineText: string },
  deps: CommandDeps,
  excludedPanel?: vscode.WebviewPanel,
): Promise<boolean> {
  for (let waitedMs = 0; waitedMs <= 2000; waitedMs += 50) {
    const entry = deps.findPanelForUri(target)
    if (entry && entry.panel !== excludedPanel && entry.ready !== false) {
      const posted = await entry.panel.webview.postMessage({
        command: 'reveal-line',
        ...reveal,
      })
      if (posted) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function focusExistingVisualWithReveal(
  target: vscode.Uri,
  viewColumn: vscode.ViewColumn,
  deps: CommandDeps,
): Promise<void> {
  const reveal = activeSourceReveal(target)
  await vscode.commands.executeCommand(
    'vscode.openWith',
    target,
    MarkdownEditorViewType,
    {
      viewColumn,
    },
  )
  if (reveal) await postRevealWhenPanelReady(target, reveal, deps)
}

// Task 580 CP3-1 — the host half of every shared-table command whose work happens in the webview:
// post the row's route to the active VMDE panel, which owns the caret and selection. The rows of
// src/shared/editor-shortcuts.ts are the only list, so the registrations, package.json (checked
// by test/backend/format-hotkeys.test.ts) and the webview's whitelists cannot drift apart. The two
// `host` rows (Paste as Plain Text, Edit in Text Editor) are registered by hand below.
export function registerPanelRouteCommand(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
  command: string,
  route: PanelRoute,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(command, () =>
      resolveActivePanel(deps)?.panel.webview.postMessage(route),
    ),
  )
}

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
) {
  for (const { command, route } of EDITOR_SHORTCUTS)
    if (route !== 'host')
      registerPanelRouteCommand(context, deps, command, route)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'vmde.openEditor',
      async (uri?: vscode.Uri, ...args) => {
        const target = resolveSupportedEditorTarget(uri, args, deps)
        if (!target) return
        // Reveal an existing VMDE tab for this file instead of opening a
        // duplicate (task 36): target its own column so VS Code focuses it.
        const existing = findTabForUri(target, 'custom')
        if (existing) {
          await focusExistingVisualWithReveal(
            target,
            existing.group.viewColumn,
            deps,
          )
          return
        }
        await openNewVisualWithReveal(target, deps)
      },
    ),
    vscode.commands.registerCommand(
      'vmde.openInSplit',
      async (uri?: vscode.Uri, ...args) => {
        const target = resolveSupportedEditorTarget(uri, args, deps)
        if (!target) return
        // Open the visual editor beside the current view (task 10).
        await openNewVisualWithReveal(target, deps, vscode.ViewColumn.Beside)
      },
    ),
    vscode.commands.registerCommand(
      'vmde.openTextEditor',
      async (uri?: vscode.Uri, ...args) => {
        deps.debug('command', uri, args)
        const target = resolveOpenTarget(uri, deps, {})
        if (!target) return
        // Task 580 CP2-8 — the command takes the old webview Ctrl+Alt+E behavior (the toolbar's
        // `edit-in-vscode` path): with a VMDE panel for the target, open the source in the active
        // column and select the caret's line. Without one (Explorer, a text editor), it only
        // reopens the target with the default editor, as before.
        const panelEntry = deps.findPanelForUri(target)
        if (panelEntry) {
          await deps.revealCaretInSource(
            panelEntry.panel,
            target,
            vscode.ViewColumn.Active,
          )
          return
        }
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          'default',
        )
      },
    ),
    vscode.commands.registerCommand(
      'vmde.openSourceToSide',
      async (uri?: vscode.Uri, ...args) => {
        deps.debug('command', uri, args)
        const target = resolveOpenTarget(uri, deps, { requireSupported: true })
        if (!target) return
        // Reuse an existing source tab (focus it in its column); otherwise open
        // the text view in the adjacent column (task 36). When this is invoked
        // from a live VMDE editor for the same file, also jump to the caret's
        // line (task 16) — one button does both: open source to the side AND
        // reveal the cursor.
        const existing = findTabForUri(target, 'text')
        const viewColumn = existing
          ? existing.group.viewColumn
          : vscode.ViewColumn.Beside
        const panelEntry = deps.findPanelForUri(target)
        if (panelEntry) {
          await deps.revealCaretInSource(panelEntry.panel, target, viewColumn)
        } else {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            target,
            'default',
            { viewColumn },
          )
        }
      },
    ),
    // Task 287 — paste as plain text. Driven from the HOST, not a webview handler, for a reason
    // that is not stylistic: a webview cannot read the system clipboard synchronously, and VS
    // Code's own bridge answers Ctrl+V through a host round-trip anyway. The host CAN read it, so
    // it does. Task 580 CP3-1: VMDE-only, so it ships unbound (formerly Ctrl/Cmd+Shift+V).
    vscode.commands.registerCommand('vmde.pastePlain', async () => {
      // The custom editor's document is not an activeTextEditor, so resolve the panel from the
      // active tab instead — the same path the outline/reveal commands use.
      const entry = resolveActivePanel(deps)
      if (!entry) return
      const text = await vscode.env.clipboard.readText()
      if (!text) return
      entry.panel.webview.postMessage({ command: 'paste-plain', text })
    }),
    vscode.commands.registerCommand('vmde.openSettings', async () => {
      // Open the Settings UI filtered to this extension's options.
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${ExtensionId}`,
      )
    }),
    vscode.commands.registerCommand(
      'vmde.outlineReveal',
      (item: HeadingItem) => {
        const panel = deps.findPanelForUri(item.documentUri)
        if (panel) {
          panel.panel.webview.postMessage({
            command: 'scroll-to-heading',
            index: item.index,
          })
          panel.panel.reveal?.(undefined, false)
        } else {
          // No open VMDE webview — fall back to revealing the source line.
          void vscode.window.showTextDocument(item.documentUri).then((ed) => {
            const pos = new vscode.Position(item.line, 0)
            ed.selection = new vscode.Selection(pos, pos)
            ed.revealRange(
              new vscode.Range(pos, pos),
              vscode.TextEditorRevealType.AtTop,
            )
          })
        }
      },
    ),
  )
}
