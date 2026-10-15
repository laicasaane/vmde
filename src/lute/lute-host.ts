// Host-side Lute pre-render (perf: warm-open masking).
//
// The webview's first content paint is gated on loading + running the 3.8 MB
// GopherJS Lute runtime ($init ≈150 ms) IN EVERY new webview realm — measured as
// the dominant cost of opening a fresh file. We can't shrink that per-realm cost
// (it's the Go runtime bootstrap, not the markdown work — rendering itself is
// ~1 ms warm), but the extension host is a SINGLE long-lived Node process, so we
// can pay the Lute $init there exactly ONCE and reuse it.
//
// On open, the host renders the document to Vditor's IR DOM (the same
// `Md2VditorIRDOM` the webview's Lute would call — byte-identical output) and
// inlines it as a static, read-only overlay in the initial HTML. That paints
// during HTML parse, before main.js even runs; the live Vditor builds underneath
// and the overlay is removed once it's ready (see media-src/src/main.ts). Because
// both renders come from the same Lute, the swap is visually seamless.
//
// Loaded in an isolated `vm` context so the GopherJS blob never pollutes the
// shared extension-host global (`global.Lute` stays undefined elsewhere).

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vm from 'node:vm'
import {
  repairIrBlocks,
  repairWysiwygBlocks,
} from '../shared/lute-block-repair'
import { repairWysiwygDom, restoreCellGaps } from '../shared/lute-gap-repair'
import { escapeTableSpanPipes } from '../markdown/table-pipe-escape'
import { newWikiLinkPattern, parseWikiPayload } from '../shared/wiki-core'
import type { MarkdownExtensionOptions } from '../shared/protocol'

const LUTE_REL = 'media/vditor/dist/js/lute/lute.min.js'

// Hard cap on how much markdown we pre-render. renderIR runs SYNCHRONOUSLY on the
// extension-host thread, and Lute's render time grows super-linearly: fast at a
// few KB but seconds for large docs (a 189 KB table-heavy file measured ~26 s),
// which would freeze the whole host and stall the webview open. So we never feed
// Lute more than this many chars: a small doc renders whole; a LONG doc renders
// only a clean prefix (~the first viewport, see prerenderPrefix) for the overlay,
// while the live editor loads the FULL document underneath and swaps in. Either
// way the host render is bounded to the same small, safe budget.
//
// Chosen from `npm run bench:prerender` (median of 9 warm Md2VditorIRDOM runs).
// The render BLOCKS first paint, so the cap is a first-paint budget sized for the
// worst realistic content ("mixed": tables + code + lists + wiki links):
//
//      cap     prose   tables   mixed
//      4 KB    15 ms   15 ms    19 ms
//     10 KB   ~24 ms  ~38 ms   ~55 ms   ← chosen
//     16 KB    38 ms   61 ms    91 ms
//     32 KB    91 ms  108 ms   222 ms
//    256 KB   596 ms 1263 ms  8760 ms   (super-linear blow-up the cap exists to avoid)
//
// 10 KB renders most small/medium wiki pages WHOLE (so the overlay matches the full
// doc, seamless even if you scroll during the swap) while keeping the worst-case
// first-paint cost ≈55 ms. There's a ~15 ms fixed Lute per-call floor regardless of
// size, so smaller caps save little; past ~16 KB the cost climbs fast for marginal
// benefit (a non-scrolling open only ever shows the first screen anyway). The
// one-time Lute $init (~150–250 ms) is paid once per session regardless of this cap.
const MAX_PRERENDER_CHARS = 10_000

export type EditorMode = 'ir' | 'wysiwyg' | 'sv'

let lute:
  | {
      Md2VditorIRDOM(md: string): string
      Md2VditorDOM(md: string): string
      VditorIRDOM2Md(html: string): string
      Md2HTML(md: string): string
      SetHeadingID(b: boolean): void
      SetToC(b: boolean): void
      SetMark(b: boolean): void
      SetSup(b: boolean): void
      SetSub(b: boolean): void
    }
  | undefined
let loadFailed = false

// Task 641 fix 4 — V8 code cache for the Lute script. Compiling and initializing the 3.7 MB
// GopherJS script costs about 200 ms of host CPU on every extension-host start, before the first
// editor can resolve. With a code cache, measured in plain Node, the compile drops from about
// 70 ms to under 10 ms and the run from about 125 ms to about 70 ms. The cache lives only in the
// extension's global storage. Its file name is a hash of everything that makes a cache valid
// (extension version, Lute script bytes, V8/Node/Electron versions), so any change starts a fresh
// cache. Every disk failure falls back to the plain compile; Lute's behaviour does not change.
const LUTE_CODE_CACHE_DIR = 'lute-code-cache'
// A real cache is about 3 MB; anything far larger is not ours and is replaced, never read.
const LUTE_CODE_CACHE_MAX_BYTES = 64 * 1024 * 1024
// The cache is produced well after the load, off the editor-open path. Producing it later also
// captures the functions the first renders compiled.
const LUTE_CODE_CACHE_WRITE_DELAY_MS = 5000

let codeCache: { dir: string; extensionVersion: string } | undefined
let pendingCacheWrite:
  | { timer: NodeJS.Timeout; write: () => Promise<boolean> }
  | undefined

/** Task 641: where the host keeps the Lute code cache (`<global storage>/lute-code-cache`).
 *  Without a storage directory there is no cache. Call before the first Lute load. */
export function configureLuteCodeCache(
  globalStorageDir: string | undefined,
  extensionVersion: string,
): void {
  codeCache = globalStorageDir
    ? {
        dir: path.join(globalStorageDir, LUTE_CODE_CACHE_DIR),
        extensionVersion,
      }
    : undefined
}

function luteCodeCacheFile(
  cache: NonNullable<typeof codeCache>,
  src: string,
): string {
  const key = createHash('sha256')
    .update(
      [
        cache.extensionVersion,
        createHash('sha256').update(src).digest('hex'),
        process.versions.v8,
        process.versions.node,
        process.versions.electron ?? '',
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32)
  return path.join(cache.dir, `lute-${key}.bin`)
}

// A missing, unreadable, empty or oversize file is a miss. A corrupt one is passed on: V8
// rejects it (`cachedDataRejected`) and the cache is rewritten.
function readLuteCodeCache(file: string): Buffer | undefined {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return undefined
    if (stat.size > LUTE_CODE_CACHE_MAX_BYTES) return undefined
    return fs.readFileSync(file)
  } catch {
    return undefined
  }
}

// Writes through a temporary file and an atomic rename, so a reader never sees a torn cache,
// then drops entries for other keys. Best-effort: any failure leaves no cache, never an error.
async function writeLuteCodeCache(
  script: vm.Script,
  file: string,
): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    const data = script.createCachedData()
    const dir = path.dirname(file)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, file)
    const keep = path.basename(file)
    for (const name of await fs.promises.readdir(dir)) {
      if (name !== keep && name.startsWith('lute-') && name.endsWith('.bin'))
        await fs.promises.rm(path.join(dir, name), { force: true })
    }
    return true
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
    return false
  }
}

function scheduleLuteCodeCacheWrite(script: vm.Script, file: string): void {
  const write = () => {
    pendingCacheWrite = undefined
    return writeLuteCodeCache(script, file)
  }
  const timer = setTimeout(() => {
    void write()
  }, LUTE_CODE_CACHE_WRITE_DELAY_MS)
  // A pending write never keeps the extension host alive.
  timer.unref?.()
  pendingCacheWrite = { timer, write }
}

/** Test-only: run a pending code-cache write now. Resolves whether a cache was written. */
export function flushLuteCodeCacheWrite(): Promise<boolean> {
  const pending = pendingCacheWrite
  if (!pending) return Promise.resolve(false)
  clearTimeout(pending.timer)
  return pending.write()
}

// Synchronously load + $init Lute in a sandboxed context. ~250 ms of host CPU,
// once per session. Only the few globals the GopherJS scheduler needs are
// exposed; no filesystem, no host global leakage.
function loadLute(extensionFsPath: string): typeof lute {
  if (lute || loadFailed) return lute
  try {
    const src = fs.readFileSync(path.join(extensionFsPath, LUTE_REL), 'utf8')
    const cacheFile = codeCache ? luteCodeCacheFile(codeCache, src) : undefined
    const cachedData = cacheFile ? readLuteCodeCache(cacheFile) : undefined
    const sandbox: Record<string, unknown> = {
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      console,
    }
    vm.createContext(sandbox)
    const script = new vm.Script(src, { filename: 'lute.min.js', cachedData })
    script.runInContext(sandbox)
    const Lute = (sandbox as { Lute?: { New(): typeof lute } }).Lute
    if (!Lute || typeof Lute.New !== 'function') {
      loadFailed = true
      return undefined
    }
    const instance = Lute.New()
    if (!instance) {
      loadFailed = true
      return undefined
    }
    // Task 243: match the webview's live Lute (esbuild-shared.mjs patchLuteHook) so the
    // instant-paint overlay carries the same `{#custom-id}` heading ids as the real editor
    // that swaps in over it — otherwise a same-doc anchor click during the swap window would
    // resolve against a DOM that doesn't have the id yet.
    instance.SetHeadingID(true)
    lute = instance
    if (cacheFile && (!cachedData || script.cachedDataRejected))
      scheduleLuteCodeCacheWrite(script, cacheFile)
    // Warm the JIT once so the first real render isn't cold (the cold first call
    // is markedly slower). Best-effort.
    try {
      instance.Md2VditorIRDOM('# warmup\n\ntext')
    } catch {
      // Best-effort JIT warmup (see comment above) — a failure here just means
      // the first REAL render pays the cold-call cost; nothing else depends on it.
    }
    return lute
  } catch {
    loadFailed = true
    return undefined
  }
}

// Kick off the (blocking) load off the activation critical path. Safe to call
// repeatedly — it no-ops once loaded or once it has permanently failed.
export function prewarmLute(extensionFsPath: string): void {
  if (lute || loadFailed) return
  setTimeout(() => loadLute(extensionFsPath), 0)
}

// Test-only readiness probes (task 476). Production callers never need these — they already
// treat "not warm yet" and "failed" the same way (fall back, no regression). Backend unit tests
// that call `prewarmLute` need to tell the two apart so a beforeAll can POLL for real readiness
// instead of racing a fixed sleep against the ~250 ms load (which flaked under machine load —
// the sleep lost the race and every test after it read a false `undefined`), and so a genuine
// boot failure surfaces as a loud test failure rather than silently degrading to "not warm".
export function isLuteWarm(): boolean {
  return lute !== undefined
}
export function didLuteFailToLoad(): boolean {
  return loadFailed
}

// For a document over the cap, pre-render only a clean leading slice so even long
// files get an instant top-of-document paint (toolbar + first screen) without
// feeding Lute the whole doc. The live editor still renders the FULL document and
// swaps the overlay out, so the truncation is invisible — it only needs to look
// right for the first screen. Cut on a block boundary (blank line, else newline)
// so we emit whole blocks, and drop a dangling unterminated ``` fence so the tail
// of the slice doesn't get swallowed as code. Docs within the cap pass through
// unchanged. Exported for unit tests.
export function prerenderPrefix(markdown: string): string {
  if (markdown.length <= MAX_PRERENDER_CHARS) return markdown
  let slice = markdown.slice(0, MAX_PRERENDER_CHARS)
  const blank = slice.lastIndexOf('\n\n')
  if (blank >= MAX_PRERENDER_CHARS / 2) {
    slice = slice.slice(0, blank)
  } else {
    const nl = slice.lastIndexOf('\n')
    if (nl > 0) slice = slice.slice(0, nl)
  }
  // Odd number of fence lines → the last code block is unterminated; cut from the
  // start of that last ``` line so it can't turn the rest of the overlay into one
  // code block. Count and cut use the SAME matcher (a ``` at line start, offset 0
  // included) so a doc that opens with an unterminated fence is handled too.
  const fences = [...slice.matchAll(/^```/gm)]
  if (fences.length % 2 === 1) {
    slice = slice.slice(0, fences[fences.length - 1].index)
  }
  return slice
}

function canonicalIrMarkdown(
  instance: NonNullable<typeof lute>,
  md: string,
  markdownExtensions: MarkdownExtensionOptions,
): string {
  setMarkdownExtensions(instance, markdownExtensions)
  // Normalize table-cell math/code pipes (#1904) first so this models exactly what the editor is
  // fed, then apply the same cell/block repairs as the live IR surface before serializing.
  const src = escapeTableSpanPipes(md)
  return instance.VditorIRDOM2Md(
    repairIrBlocks(
      restoreCellGaps(instance.Md2VditorIRDOM(src), () =>
        instance.Md2HTML(src),
      ),
      () => src,
    ),
  )
}

/** Candidate-A seed authority (task 537). Eligible complex documents deliberately pay any first
 * Lute load in the extension host so the renderer never performs a full cache construction. */
export function canonicalizeIrMarkdown(
  extensionFsPath: string,
  md: string,
  markdownExtensions: MarkdownExtensionOptions = {
    toc: false,
    mark: false,
    supSub: false,
  },
): string | undefined {
  const instance = loadLute(extensionFsPath)
  if (!instance) return undefined
  try {
    return canonicalIrMarkdown(instance, md, markdownExtensions)
  } catch {
    return undefined
  }
}

// Reserialize markdown the way the webview's getValue() does for IR mode:
// VditorIRDOM2Md(Md2VditorIRDOM(md)). Used by the minimal-diff write-back (task 61)
// to decide whether a source block is semantically unchanged (its reserialization
// equals the editor's output) so its ORIGINAL bytes can be preserved. Returns
// undefined when Lute isn't warm (caller falls back to a plain full write — no
// regression). Best-effort; never throws.
export function reserializeMarkdown(
  extensionFsPath: string,
  md: string,
  markdownExtensions: MarkdownExtensionOptions = {
    toc: false,
    mark: false,
    supSub: false,
  },
): string | undefined {
  if (!lute) {
    prewarmLute(extensionFsPath)
    return undefined
  }
  try {
    return canonicalIrMarkdown(lute, md, markdownExtensions)
  } catch {
    return undefined
  }
}

// Render markdown → IR DOM for the instant paint. Returns undefined (caller
// falls back to the normal webview render, no regression) when Lute isn't warm
// yet — we never block HTML generation on the 250 ms load; we only kick a
// prewarm so the NEXT open is covered.
// Render the document to the same DOM the live editor will build for `mode`, so
// the instant-paint overlay matches exactly. 'ir' and 'wysiwyg' use the parallel
// `.vditor-{mode} > pre.vditor-reset` structure (the host's Md2VditorIRDOM /
// Md2VditorDOM); 'sv' (split) is structurally different — skip it (returns
// undefined → no overlay). Mode mismatch was visible as the heading-level (H1/H2)
// gutter markers landing in the wrong place when the editor opened in WYSIWYG.
export function renderForMode(
  extensionFsPath: string,
  markdown: string,
  mode: EditorMode,
  wikiEnabled = false,
  markdownExtensions: MarkdownExtensionOptions = {
    toc: false,
    mark: false,
    supSub: false,
  },
): string | undefined {
  if (mode === 'sv') return undefined
  if (!lute) {
    prewarmLute(extensionFsPath)
    return undefined
  }
  // Long docs render only a clean prefix (bounded host cost); the live editor
  // renders the full document and swaps in. Small docs pass through whole.
  // Normalize table-cell math/code pipes (#1904) so the instant-paint overlay matches
  // the live editor (which is fed the same normalized markdown).
  const md = escapeTableSpanPipes(prerenderPrefix(markdown))
  try {
    // Task 370: both renders rewrite whitespace around inline elements (WYSIWYG invents a space in
    // front of glued inline code, IR drops one inside a table cell) and the live editor repairs
    // both — so the overlay must too, or the text shifts sideways at the swap. Oracle over `md`,
    // the same (possibly truncated) slice we rendered, not the full document: fed anything else the
    // counts wouldn't line up and the repair would bail out.
    const warm = lute as NonNullable<typeof lute>
    setMarkdownExtensions(warm, markdownExtensions)
    const html =
      mode === 'wysiwyg'
        ? repairWysiwygBlocks(
            repairWysiwygDom(warm.Md2VditorDOM(md), () => warm.Md2HTML(md)),
            () => md,
          )
        : repairIrBlocks(
            restoreCellGaps(warm.Md2VditorIRDOM(md), () => warm.Md2HTML(md)),
            () => md,
          )
    // The host Lute has no wiki custom renderer, so [[links]] come back as literal
    // text. For a wiki file, rewrite them to the same chip spans the live editor
    // emits so the instant-paint overlay shows styled chips, not raw [[…]].
    return wikiEnabled ? renderWikiChipsInHtml(html) : html
  } catch {
    return undefined
  }
}

function setMarkdownExtensions(
  instance: NonNullable<typeof lute>,
  options: MarkdownExtensionOptions,
): void {
  instance.SetToC(options.toc)
  instance.SetMark(options.mark)
  instance.SetSup(options.supSub)
  instance.SetSub(options.supSub)
}

function escapeWikiHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  )
}

// Own instance (see wiki-core.ts's newWikiLinkPattern doc comment) — isolated from the shared
// WikiLinkPattern that custom-renderer.ts / wiki-serialize.ts / wiki-core.ts's own
// extractWikiTargets also read; only renderWikiChipsInHtml below ever touches this one.
const wikiLinkPattern = newWikiLinkPattern()

// Rewrite [[wiki]] / [[wiki|label]] literals in rendered IR/DOM HTML into the chip
// spans the webview's custom renderer produces, so the prerender overlay matches the
// live editor for a wiki file. Missing/existing colouring is left to the live editor
// (we have no page index at paint time) — every chip renders as a normal link here.
// Pure string transform; exported for unit tests.
export function renderWikiChipsInHtml(html: string): string {
  wikiLinkPattern.lastIndex = 0
  return html.replace(wikiLinkPattern, (full: string, inner: string) => {
    const { target, label } = parseWikiPayload(inner)
    const display = label || target
    return (
      `<span class="wiki-link-chip" data-wiki-link="1" ` +
      `data-wiki-target="${escapeWikiHtml(target)}" ` +
      `data-wiki-source="${escapeWikiHtml(full)}" ` +
      `title="Open wiki page ${escapeWikiHtml(target)}">` +
      `${escapeWikiHtml(display)}</span>`
    )
  })
}
