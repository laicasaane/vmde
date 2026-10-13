import * as NodePath from 'node:path'
import * as vscode from 'vscode'
import { ConfigurationRoot } from '../shared/product-identity'
import { wikiKeysForRelativePath } from '../shared/wiki-core'

export { normalizeWikiLookupKey } from '../shared/wiki-core'

const SupportedMarkdownExtensions = new Set(['.md', '.markdown'])

export interface WikiDocumentContext {
  enabled: boolean
  rootLabel?: string
}

// `uri` (task 295): both wiki settings are resource-scoped, so one root can be a notes vault with
// wiki links on while another stays a plain docs repo. getWikiRoot already resolves the document's
// workspace folder, so the config read has to follow the same document or the two disagree.
function getWikiConfig(uri?: vscode.Uri) {
  const cfg = vscode.workspace.getConfiguration(
    `${ConfigurationRoot}.wiki`,
    uri,
  )
  const enabled = cfg.get<boolean>('enabled') !== false
  const rootPath = cfg.get<string>('root') ?? ''
  return { enabled, rootPath }
}

export function isWikiFile(uri: vscode.Uri | undefined) {
  return Boolean(uri && isSupportedMarkdownUri(uri) && getWikiRoot(uri))
}

export function getWikiDocumentContext(
  uri: vscode.Uri | undefined,
): WikiDocumentContext {
  const root = uri ? getWikiRoot(uri) : undefined
  if (!root) {
    return { enabled: false }
  }
  return {
    enabled: true,
    rootLabel: vscode.workspace.asRelativePath(root, false),
  }
}

export function getWikiRoot(uri: vscode.Uri) {
  if (uri.scheme !== 'file' || !isSupportedMarkdownUri(uri)) {
    return undefined
  }
  const { enabled, rootPath } = getWikiConfig(uri)
  if (!enabled) return undefined

  const folder = vscode.workspace.getWorkspaceFolder(uri)
  if (!folder) return undefined

  // Explicit root → that subfolder. Empty root → workspace root.
  return rootPath ? vscode.Uri.joinPath(folder.uri, rootPath) : folder.uri
}

function isSupportedMarkdownUri(uri: vscode.Uri) {
  return SupportedMarkdownExtensions.has(
    NodePath.extname(uri.path).toLowerCase(),
  )
}

export function getWikiKeys(root: vscode.Uri, candidate: vscode.Uri) {
  const relativePath = NodePath.relative(root.fsPath, candidate.fsPath).replace(
    /\\/g,
    '/',
  )
  return wikiKeysForRelativePath(relativePath)
}

// The files.exclude entries that name a plain glob (`true`). A `{ when }` entry depends on a sibling
// file existing, which one search glob cannot express, so it is not applied.
function configuredFilesExclude(root: vscode.Uri): string[] {
  const configured: Record<string, boolean | { when?: string }> | undefined =
    vscode.workspace.getConfiguration('files', root).get('exclude')
  return Object.entries(configured ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([glob]) => glob)
}

// files.exclude globs are relative to the workspace folder, but findFiles matches an exclude glob
// against the path relative to the SEARCH BASE (the wiki root). With a wiki root below the folder
// (`vmde.wiki.root` = `docs`) a key must therefore be rebased: `docs/drafts/**` becomes
// `drafts/**`, a key outside the root (`build/**`, `drafts/**`) cannot match inside it and is
// dropped, and a `**/`-prefixed key matches at any depth so it stays as is.
function rebaseExcludeToRoot(
  root: vscode.Uri,
  glob: string,
): string | undefined {
  if (glob.startsWith('**/')) return glob
  const folder = vscode.workspace.getWorkspaceFolder(root)
  if (!folder) return glob
  const rootPrefix = NodePath.relative(folder.uri.fsPath, root.fsPath).replace(
    /\\/g,
    '/',
  )
  if (!rootPrefix) return glob
  return glob.startsWith(`${rootPrefix}/`)
    ? glob.slice(rootPrefix.length + 1)
    : undefined
}

// Task 636 — the wiki page set honours the user's files.exclude and always skips node_modules.
// workspace.findFiles treats an explicit exclude glob as a REPLACEMENT for files.exclude (undefined
// applies the setting, null applies nothing), so the setting's own globs are merged in here.
function wikiSearchExclude(root: vscode.Uri): string {
  const globs = new Set(['**/node_modules/**'])
  for (const glob of configuredFilesExclude(root)) {
    const rebased = rebaseExcludeToRoot(root, glob)
    if (rebased) globs.add(rebased)
  }
  return `{${Array.from(globs).join(',')}}`
}

// The search glob is case-sensitive but the wiki treats `Page.MD` / `Notes.Markdown` as pages (the
// old directory walk lowercased the extension), so each extension is listed as written and as
// character classes (`md` -> `[mM][dD]`).
const WikiSearchExtensions = Array.from(SupportedMarkdownExtensions, (ext) =>
  ext.slice(1),
).flatMap((ext) => [
  ext,
  Array.from(
    ext,
    (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`,
  ).join(''),
])
const WikiSearchGlob = `**/*.{${WikiSearchExtensions.join(',')}}`

// Task 636 — one workspace search under the wiki root instead of a serial directory walk: the walk
// cost one round trip per directory (tens of thousands in a large workspace, mostly in ignored build
// folders), the search runs in the editor's file-search service and prunes excluded folders. A root
// that is missing, or a search that fails or is cancelled, gives no pages.
export async function collectWikiMarkdownFiles(
  root: vscode.Uri,
  token?: vscode.CancellationToken,
): Promise<vscode.Uri[]> {
  try {
    return await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, WikiSearchGlob),
      wikiSearchExclude(root),
      undefined,
      token,
    )
  } catch {
    return []
  }
}

export async function createWikiPage(
  root: vscode.Uri,
  key: string,
): Promise<vscode.Uri> {
  const newFileName = `${key.replace(/\//g, '-')}.md`
  const newFileUri = vscode.Uri.joinPath(root, newFileName)
  const heading = key
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
  await vscode.workspace.fs.writeFile(newFileUri, Buffer.from(`# ${heading}\n`))
  return newFileUri
}
