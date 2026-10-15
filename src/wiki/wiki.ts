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

const GlobCharacters = /[*?{}[\]]/
const isAbsoluteEntry = (text: string) =>
  text.startsWith('/') || /^[A-Za-z]:\//.test(text)

// `text` (forward slashes) relative to the workspace folder that holds the wiki root, or undefined
// when it does not lie strictly inside that folder (or the root has no folder).
function relativeToWorkspaceFolder(
  root: vscode.Uri,
  text: string,
): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(root)
  if (!folder) return undefined
  const prefix = `${folder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  // Windows paths are case-insensitive; a POSIX path is compared as written.
  const windows = /^[A-Za-z]:\//.test(prefix)
  const inside = windows
    ? text.toLowerCase().startsWith(prefix.toLowerCase())
    : text.startsWith(prefix)
  return inside && text.length > prefix.length
    ? text.slice(prefix.length)
    : undefined
}

// Task 638 — the globs for one `vmde.wiki.exclude` entry, relative to the workspace folder like
// files.exclude: a relative path, an absolute path inside the workspace folder (an absolute path
// elsewhere is ignored), or a glob. A plain path (no glob characters) names a file or a folder, so
// it also gets a `/**` twin that covers everything below a folder. Backslashes become slashes;
// empty and non-string entries give nothing.
function wikiExcludeEntryGlobs(root: vscode.Uri, entry: unknown): string[] {
  if (typeof entry !== 'string') return []
  let text = entry.trim().replace(/\\/g, '/')
  if (isAbsoluteEntry(text)) {
    const relative = relativeToWorkspaceFolder(root, text)
    if (relative === undefined) return []
    text = relative
  }
  text = text.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (!text || text === '.') return []
  return GlobCharacters.test(text) ? [text] : [text, `${text}/**`]
}

// The `vmde.wiki.exclude` entries. Read through the normal resource-scoped configuration API, so the
// most specific level (folder, then workspace, then user) wins and arrays are not merged. A value
// that is not an array gives nothing.
function configuredWikiExclude(root: vscode.Uri): unknown[] {
  const configured = vscode.workspace
    .getConfiguration(`${ConfigurationRoot}.wiki`, root)
    .get<unknown>('exclude')
  return Array.isArray(configured) ? configured : []
}

// Task 636 — the wiki page set honours the user's files.exclude and always skips node_modules.
// workspace.findFiles treats an explicit exclude glob as a REPLACEMENT for files.exclude (undefined
// applies the setting, null applies nothing), so the setting's own globs are merged in here.
// Task 638 — the `vmde.wiki.exclude` entries join the same set. A glob that does not compile is
// dropped here, so the page search (which joins the globs into one brace pattern, where one unclosed
// `{` would break every other glob) and the watcher agree: a bad entry excludes nothing.
function wikiExcludeGlobs(root: vscode.Uri): string[] {
  const globs = new Set(['**/node_modules/**'])
  const candidates = [
    ...configuredFilesExclude(root),
    ...configuredWikiExclude(root).flatMap((entry) =>
      wikiExcludeEntryGlobs(root, entry),
    ),
  ]
  for (const glob of candidates) {
    const rebased = rebaseExcludeToRoot(root, glob)
    if (rebased && globToRegExp(rebased)) globs.add(rebased)
  }
  return Array.from(globs)
}

/** A stable text for the exclude set of `root`; two equal values mean the page search is unchanged. */
export function wikiExcludeSignature(root: vscode.Uri): string {
  return JSON.stringify(wikiExcludeGlobs(root))
}

function wikiSearchExclude(root: vscode.Uri): string {
  return `{${wikiExcludeGlobs(root).join(',')}}`
}

// Task 637 — a small in-process glob matcher so the file watcher can apply the same exclusion as the
// page search without an async round trip per event. It covers what the exclude globs use: `**`,
// `*`, `?`, `{a,b}` alternation (nested) and `[...]` classes.
// A glob that does not compile (an unclosed `{`) matches nothing: a bad setting must not break the
// watcher.
function globToRegExp(glob: string): RegExp | undefined {
  let braceDepth = 0
  const rules: Array<[RegExp, (text: string) => string]> = [
    [/\*\*\//y, () => '(?:.*/)?'],
    [/\/\*\*$/y, () => '(?:/.*)?'],
    [/\*\*/y, () => '.*'],
    [/\*/y, () => '[^/]*'],
    [/\?/y, () => '[^/]'],
    [
      /\{/y,
      () => {
        braceDepth++
        return '(?:'
      },
    ],
    [
      /\}/y,
      () => {
        if (braceDepth === 0) return '\\}'
        braceDepth--
        return ')'
      },
    ],
    [/,/y, () => (braceDepth > 0 ? '|' : ',')],
    [/\[!?[^\]]+\]/y, (text) => text.replace(/^\[!/, '[^')],
    [/[\s\S]/y, (text) => text.replace(/[.+^$()|\\[\]{}]/g, '\\$&')],
  ]
  let source = ''
  for (let position = 0; position < glob.length; ) {
    for (const [pattern, render] of rules) {
      pattern.lastIndex = position
      const text = pattern.exec(glob)?.[0]
      if (text === undefined) continue
      source += render(text)
      position += text.length
      break
    }
  }
  try {
    return new RegExp(`^${source}$`)
  } catch {
    return undefined
  }
}

// Whether the page search would skip `file` (under node_modules or a files.exclude glob). Like the
// search, an exclude that matches a folder excludes everything below it, so each leading path prefix
// is tested as well as the whole path; paths are relative to the wiki root.
export function isWikiPageExcluded(
  root: vscode.Uri,
  file: vscode.Uri,
): boolean {
  const relativePath = NodePath.relative(root.fsPath, file.fsPath).replace(
    /\\/g,
    '/',
  )
  const segments = relativePath.split('/')
  const prefixes = segments.map((_, index) =>
    segments.slice(0, index + 1).join('/'),
  )
  return wikiExcludeGlobs(root).some((glob) => {
    const matcher = globToRegExp(glob)
    return matcher ? prefixes.some((prefix) => matcher.test(prefix)) : false
  })
}

// The page glob (shared by the search and the file watcher) is case-sensitive but the wiki treats
// `Page.MD` / `Notes.Markdown` as pages (the old directory walk lowercased the extension), so each
// extension is listed as written and as character classes (`md` -> `[mM][dD]`).
const WikiSearchExtensions = Array.from(SupportedMarkdownExtensions, (ext) =>
  ext.slice(1),
).flatMap((ext) => [
  ext,
  Array.from(
    ext,
    (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`,
  ).join(''),
])
export const WikiPageGlob = `**/*.{${WikiSearchExtensions.join(',')}}`

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
      new vscode.RelativePattern(root, WikiPageGlob),
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
