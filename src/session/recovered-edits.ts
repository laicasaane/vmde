// Task 733 / 036 (E2, fix design 3.6, Q-I (a)): the untitled document "Recovered edits". Replay operations
// the host could not apply after a refusal, and that the webview could not reapply with a proven base and
// position, are written here, so the text survives closing the source (VS Code hot exit keeps an untitled
// document; no extension storage holds document text). The text goes nowhere else: no log, no message.
import * as vscode from 'vscode'

/** One unresolved replay operation as the host received it (positions, old and new text). */
export interface RecoveredEdit {
  readonly epoch: number
  readonly replayOp: number
  readonly changes?: readonly unknown[]
  readonly content?: string
}

/** The untitled document every panel appends to; one per window while it stays open. */
export const RECOVERED_EDITS_URI = 'untitled:Recovered edits'

interface ChangeView {
  line?: number
  character?: number
  oldText?: string
  text?: string
}

/** The fields of one received change that the document shows; anything malformed is left out. */
const changeView = (raw: unknown): ChangeView => {
  if (typeof raw !== 'object' || raw === null) return {}
  const change = raw as Record<string, unknown>
  const start = change.start as Record<string, unknown> | undefined
  const view: ChangeView = {}
  if (Number.isSafeInteger(start?.line)) view.line = start?.line as number
  if (Number.isSafeInteger(start?.character))
    view.character = start?.character as number
  if (typeof change.oldText === 'string') view.oldText = change.oldText
  if (typeof change.text === 'string') view.text = change.text
  return view
}

/** A backtick fence longer than any backtick run in `text`, so the block shows `text` as it is. */
const fenced = (text: string): string => {
  let longest = 0
  for (const run of text.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}text\n${text}${text.endsWith('\n') || text === '' ? '' : '\n'}${fence}`
}

/** The Markdown of one write: a heading naming the source, then each entry with its position and text. */
export function formatRecoveredEdits(
  source: string,
  entries: readonly RecoveredEdit[],
): string {
  const parts = [
    `# Recovered edits: ${source}`,
    'These edits were not applied to the document, because it changed before they reached it. Apply them by hand where they still fit.',
  ]
  for (const entry of entries) {
    if (entry.content !== undefined) {
      parts.push(
        `## Edit ${entry.epoch}.${entry.replayOp}: whole document`,
        fenced(entry.content),
      )
      continue
    }
    const changes = (entry.changes ?? []).map(changeView)
    parts.push(`## Edit ${entry.epoch}.${entry.replayOp}`)
    for (const change of changes) {
      const at =
        change.line === undefined
          ? 'unknown position'
          : `line ${change.line + 1}, column ${(change.character ?? 0) + 1}`
      parts.push(`At ${at}, replaced:`, fenced(change.oldText ?? ''))
      parts.push('with:', fenced(change.text ?? ''))
    }
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * 036 core C7 (R33.4): appends `text` to the untitled "Recovered edits" document (opened, or the one already
 * open). Success means the text is in the document; the caller marks its entries written then, so a later
 * presentation failure never inserts it twice. The document is dirty and untitled, so closing the source
 * leaves it open, and VS Code asks before it is discarded.
 */
export async function insertRecoveredEdits(text: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(RECOVERED_EDITS_URI),
  )
  const existing = document.getText().length
  const end = document.positionAt(existing)
  const edit = new vscode.WorkspaceEdit()
  edit.replace(
    document.uri,
    new vscode.Range(end, end),
    existing > 0 ? `\n${text}` : text,
  )
  if (!(await vscode.workspace.applyEdit(edit)))
    throw new Error('recovered edits not applied')
}

/** 036 core C7 (R33.4): shows "Recovered edits" pinned, not as a preview, without focus, as Markdown. */
export async function presentRecoveredEdits(): Promise<void> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(RECOVERED_EDITS_URI),
  )
  await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: true,
  })
  if (document.languageId !== 'markdown')
    await vscode.languages.setTextDocumentLanguage(document, 'markdown')
}
