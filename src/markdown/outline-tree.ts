import * as vscode from 'vscode'
import { moveMarkdownSection, scanSourceHeadings } from '../shared/section-move'
import { findPanelForUri } from '../platform/active-panels'

export const OUTLINE_HEADING_MIME = 'application/vnd.vmde.outline-heading'

interface ParsedHeading {
  level: number
  name: string
  line: number
  index: number
  offset: number
}

// The shared scanner is also the destructive move authority. The tree retains its
// rendered ordinal for reveal, but every drag identity is bound to this exact offset.
export function parseHeadings(document: vscode.TextDocument): ParsedHeading[] {
  const markdown = document.getText()
  return scanSourceHeadings(markdown).map((heading, index) => {
    const text = markdown.slice(heading.start, heading.end)
    const firstLine = text.split(/\r\n|\n|\r/u)[0]
    const name = firstLine
      .replace(/^ {0,3}#{1,6}[\t ]*/u, '')
      .replace(/[\t ]+#+[\t ]*$/u, '')
      .trim()
    return {
      level: heading.level,
      name,
      line: (markdown.slice(0, heading.start).match(/\r\n|\n|\r/gu) ?? [])
        .length,
      index,
      offset: heading.start,
    }
  })
}

export class HeadingItem extends vscode.TreeItem {
  children: HeadingItem[] = []
  constructor(
    public readonly heading: string,
    public readonly level: number,
    public readonly line: number,
    public readonly index: number,
    public readonly offset: number,
    public readonly documentUri: vscode.Uri,
  ) {
    super(heading, vscode.TreeItemCollapsibleState.Expanded)
    this.command = {
      command: 'vmde.outlineReveal',
      title: 'Go to heading',
      arguments: [this],
    }
    this.iconPath = new vscode.ThemeIcon('symbol-string')
    this.tooltip = `H${level}: ${heading}`
  }
}

function buildTree(
  flat: ParsedHeading[],
  documentUri: vscode.Uri,
): HeadingItem[] {
  const root: HeadingItem[] = []
  const stack: Array<{ level: number; item: HeadingItem }> = []
  for (const h of flat) {
    const item = new HeadingItem(
      h.name,
      h.level,
      h.line,
      h.index,
      h.offset,
      documentUri,
    )
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    if (stack.length > 0) stack[stack.length - 1].item.children.push(item)
    else root.push(item)
    stack.push({ level: h.level, item })
  }
  return root
}

export class MarkdownOutlineProvider
  implements vscode.TreeDataProvider<HeadingItem>
{
  private _onDidChange = new vscode.EventEmitter<HeadingItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private roots: HeadingItem[] = []
  private currentUri: vscode.Uri | undefined
  private lastSig = '\0'

  refresh(document: vscode.TextDocument | undefined): void {
    const flat = document ? parseHeadings(document) : []
    // Skip the (expensive) tree re-render when nothing changed — a rapid burst
    // of refresh() calls during a file switch would otherwise rebuild the whole
    // 300+ node tree several times and freeze the VS Code UI.
    const sig = document
      ? `${document.uri.toString()}|${flat.map((h) => `${h.level}:${h.line}:${h.name}`).join('\n')}`
      : ''
    this.currentUri = document?.uri
    this.roots = document && flat.length ? buildTree(flat, document.uri) : []
    if (sig === this.lastSig) return
    this.lastSig = sig
    this._onDidChange.fire(undefined)
  }

  get uri(): vscode.Uri | undefined {
    return this.currentUri
  }

  getTreeItem(el: HeadingItem): vscode.TreeItem {
    el.collapsibleState =
      el.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    return el
  }

  getChildren(el?: HeadingItem): HeadingItem[] {
    return el ? el.children : this.roots
  }
}

interface DraggedHeading {
  uri: string
  start: number
  level: number
  version: number
}

/** Native outline DnD uses the exact same source planner as the webview. VS Code exposes no
 * half-row geometry, so an item drop is deliberately defined as "before" the target. */
export class MarkdownOutlineDragAndDropController
  implements vscode.TreeDragAndDropController<HeadingItem>
{
  readonly dragMimeTypes = [OUTLINE_HEADING_MIME]
  readonly dropMimeTypes = [OUTLINE_HEADING_MIME]

  async handleDrag(
    source: readonly HeadingItem[],
    data: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    if (source.length !== 1) return
    const item = source[0]
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === item.documentUri.toString(),
    )
    if (!document) return
    const payload: DraggedHeading = {
      uri: item.documentUri.toString(),
      start: item.offset,
      level: item.level,
      version: document.version,
    }
    data.set(
      OUTLINE_HEADING_MIME,
      new vscode.DataTransferItem(JSON.stringify(payload)),
    )
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validates every untrusted DnD identity before one model edit.
  async handleDrop(
    target: HeadingItem | undefined,
    data: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const raw = await data.get(OUTLINE_HEADING_MIME)?.asString()
    let dragged: DraggedHeading | undefined
    try {
      dragged = raw ? (JSON.parse(raw) as DraggedHeading) : undefined
    } catch {
      return
    }
    if (
      !dragged ||
      !Number.isSafeInteger(dragged.start) ||
      !Number.isSafeInteger(dragged.level) ||
      !Number.isSafeInteger(dragged.version) ||
      (target && target.documentUri.toString() !== dragged.uri)
    ) {
      return
    }
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === dragged.uri,
    )
    if (!document || document.version !== dragged.version) return
    const markdown = document.getText()
    const headings = scanSourceHeadings(markdown)
    const source = headings.find(
      (heading) =>
        heading.start === dragged!.start && heading.level === dragged!.level,
    )
    const dropTarget = target
      ? { start: target.offset, level: target.level }
      : headings.filter((heading) => heading.level === dragged.level).at(-1)
    if (!source || !dropTarget) return
    const panel = findPanelForUri(document.uri)
    if (panel?.ready && panel.moveOutlineSection) {
      panel.moveOutlineSection(source, dropTarget, target ? 'before' : 'after')
      return
    }
    const result = moveMarkdownSection(
      markdown,
      source,
      dropTarget,
      target ? 'before' : 'after',
    )
    if (result.status !== 'ok' || document.version !== dragged.version) return
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      document.uri,
      new vscode.Range(
        0,
        0,
        document.lineCount - 1,
        document.lineAt(document.lineCount - 1).range.end.character,
      ),
      result.markdown,
    )
    await vscode.workspace.applyEdit(edit)
  }
}
