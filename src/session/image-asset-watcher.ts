import * as NodePath from 'node:path'
import * as vscode from 'vscode'

// Task 513 — an image replaced ON DISK under an unchanged path kept showing its OLD bytes in the
// open editor. Measured in real VS Code (test/vscode-e2e/image-swap-refresh-probe.spec.ts): the
// bytes change, but the webview's `https://file+.vscode-resource…/<path>` URL is served from
// Chromium's HTTP cache — even a BRAND NEW <img> element with the same src gets the stale bytes, so
// no amount of re-rendering in the webview can fix it. Only a different URL, or an explicit
// revalidation of that URL, refetches.
//
// The host half is here: work out which local image files the open document references, watch
// exactly those, and tell the webview when one changes. The webview half (links/image-refresh.ts)
// does the revalidation — deliberately WITHOUT touching the `src` attribute, so nothing can leak
// into the serialized markdown.

// Markdown `![alt](path "title")` plus raw HTML `<img src="path">`. The `<…>` form is the one
// that may contain spaces, so it needs its own branch.
const MD_IMAGE =
  /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g
const HTML_IMAGE = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi
const FENCE = /^ {0,3}(`{3,}|~{3,})[^`~]*$/
const DEFINITION = /^ {0,3}\[([^\]\r\n]+)\]:[ \t]*(.*)$/

// Everything the webview can already load without the file system: remote, inline and
// webview-internal URLs. Only real files on disk can go stale behind a cached URL.
const NON_FILE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

function closingBracket(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === ']' && !isEscaped(text, i)) return i
  }
  return -1
}

function codeFreeMarkdown(markdown: string): string {
  let fence = ''
  return markdown
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === '\n' || part === '\r\n') return part
      const opening = FENCE.exec(part)
      if (fence) {
        const closing = new RegExp(
          `^ {0,3}${fence[0]}{${fence.length},}\\s*$`,
        ).test(part)
        if (closing) fence = ''
        return ' '.repeat(part.length)
      }
      if (opening) {
        fence = opening[1]
        return ' '.repeat(part.length)
      }
      if (/^(?: {4}|\t)/.test(part)) return ' '.repeat(part.length)
      return part.replace(/(`+)(?:[^`]|`(?!\1))*\1/g, (code) =>
        ' '.repeat(code.length),
      )
    })
    .join('')
}

function definitionPaths(codeFreeMarkdown: string): Map<string, string> {
  const definitions = new Map<string, string>()
  for (const line of codeFreeMarkdown.split(/\r?\n/)) {
    const match = DEFINITION.exec(line)
    if (!match) continue
    const label = normalizeReferenceLabel(match[1])
    if (!label || definitions.has(label)) continue
    const tail = match[2].trimStart()
    const destination = tail.startsWith('<')
      ? /^<([^>]+)>/.exec(tail)?.[1]
      : /^(\S+)/.exec(tail)?.[1]
    if (destination) definitions.set(label, destination)
  }
  return definitions
}

function referenceImagePaths(safe: string): string[] {
  const definitions = definitionPaths(safe)
  const paths: string[] = []
  for (let i = 0; i < safe.length; i++) {
    if (safe[i] !== '!' || safe[i + 1] !== '[' || isEscaped(safe, i)) continue
    const labelClose = closingBracket(safe, i + 1)
    if (labelClose < 0 || safe[labelClose + 1] === '(') continue
    let reference = safe.slice(i + 2, labelClose)
    if (safe[labelClose + 1] === '[') {
      const referenceClose = closingBracket(safe, labelClose + 1)
      if (referenceClose < 0) continue
      reference = safe.slice(labelClose + 2, referenceClose) || reference
      i = referenceClose
    } else {
      i = labelClose
    }
    const destination = definitions.get(normalizeReferenceLabel(reference))
    if (destination) paths.push(destination)
  }
  return paths
}

/**
 * The distinct local image paths a markdown document references, as they appear in the source
 * (relative to the document, or absolute). Pure — the caller resolves them against the doc.
 */
export function extractLocalImagePaths(markdown: string): string[] {
  const out = new Set<string>()
  const safe = codeFreeMarkdown(markdown)
  for (const re of [MD_IMAGE, HTML_IMAGE]) {
    re.lastIndex = 0
    let m = re.exec(safe)
    while (m) {
      const raw = (m[1] ?? m[2])?.trim()
      if (raw && !NON_FILE.test(raw) && !raw.startsWith('#')) {
        // A query/fragment is not part of the file name on disk.
        out.add(raw.replace(/[?#].*$/, ''))
      }
      m = re.exec(safe)
    }
  }
  for (const raw of referenceImagePaths(safe)) {
    if (raw && !NON_FILE.test(raw) && !raw.startsWith('#'))
      out.add(raw.replace(/[?#].*$/, ''))
  }
  return [...out]
}

/** Resolve the extracted paths against the document's own directory. */
export function resolveImagePaths(
  docFsPath: string,
  paths: string[],
): string[] {
  const dir = NodePath.dirname(docFsPath)
  const out = new Set<string>()
  for (const p of paths) {
    const decoded = (() => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })()
    out.add(NodePath.resolve(dir, decoded))
  }
  return [...out]
}

// A document can reference an unbounded number of images; one watcher each would be a silly cost
// for a 500-image gallery. Watch the first N distinct paths — the case this exists for (a handful
// of screenshots in a README) sits far below it.
const MAX_WATCHED = 100

/**
 * Watches the local image files a document references and reports the ones that change on disk.
 * `refresh()` is idempotent for an unchanged path set, so it is safe to call on every keystroke.
 */
export class ImageAssetWatcher {
  private watchers: vscode.Disposable[] = []
  private watchedKey = ''

  constructor(
    private readonly notify: (paths: string[]) => void,
    private readonly log?: (message: string) => void,
  ) {}

  refresh(docFsPath: string, markdown: string): void {
    const paths = resolveImagePaths(
      docFsPath,
      extractLocalImagePaths(markdown),
    ).slice(0, MAX_WATCHED)
    const key = paths.join('\n')
    if (key === this.watchedKey) return
    this.watchedKey = key
    this.disposeWatchers()
    for (const p of paths) {
      // An absolute-path RelativePattern watches a single file, inside the workspace or outside it
      // (a README can point at an image above the workspace root).
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(NodePath.dirname(p)),
        NodePath.basename(p),
      )
      const w = vscode.workspace.createFileSystemWatcher(pattern)
      const fire = () => {
        this.log?.(`[image-watch] changed ${p}`)
        this.notify([p])
      }
      this.watchers.push(w, w.onDidChange(fire), w.onDidCreate(fire))
    }
  }

  private disposeWatchers(): void {
    for (const w of this.watchers) w.dispose()
    this.watchers = []
  }

  dispose(): void {
    this.disposeWatchers()
    this.watchedKey = ''
  }
}
