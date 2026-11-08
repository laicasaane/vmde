# Task 709 — Front-matter `aliases:` and `tags:` resolution

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 207](207-frontmatter-properties-aliases.md) at its closure. Task 207 shipped the properties table; its alias and tag scope moved here unchanged.
**Severity:** medium (estimated). A page reachable in Obsidian through a declared alias shows as a missing page here, and front-matter `tags:` are invisible to any tag index.
**Tech stack:** `src/wiki.ts` (`WikiCache`), `src/shared/front-matter.ts` (the front-matter parser Task 207 added), wiki chip resolution and the `[[` hint list.
**Depends on:** none. Task 205 (tag index) is optional: if it is not shipped, store and expose the tags.

## Problem

`WikiCache` keys come only from file paths (`src/wiki.ts`), so an alias declared in front matter does not resolve, and `tags:` are not read.

## Scope

- [x] Host: extract `aliases` and `tags` (list or scalar) from the first front-matter block. Reuse the Task 207 parser where it fits. Malformed YAML skips the file's metadata and never errors the scan.
- [x] `WikiCache`: alias keys join the path-derived keys (normalized with `normalizeWikiLookupKey`). Ambiguity is handled like duplicate filenames (the existing picker). Re-parse on save and watch events.
- [x] `tags:` feed Task 205's index (if 205 is not shipped, store and expose them; do not block).
- [x] Chip resolution and the `[[` hint list include aliases (the hint shows `alias → file`).
- [x] Rename-refactor interplay (Task 202): an alias-resolved link is NOT rewritten on file rename (the alias still resolves). Pin this.

## Out of scope

- Alias write-side tooling, arbitrary property queries (Task 105), Front Matter CMS vault surfaces.

## Verification

- L1 backend: extractor unit (list, scalar, missing, malformed), cache-key merge, ambiguity, incremental update on an alias edit.
- L2: a `[[Some Alias]]` chip renders resolved when a fixture declares the alias.
- L3 real VS Code (mandatory): clicking an alias chip opens the declaring file; the hint offers the alias.

## Part 1 handoff

Read-only design, 2026-11-08, on `wt/709` at `dd860b86`. Names, signatures, constants and strings
below are fixed for Part 2. A worker that finds a contradiction reports it and does not rename.
Decisions marked "provisional" wait for the orchestrator (see section 5).

### 1. Inventory (verified on `dd860b86`)

The record's `src/wiki.ts` location is stale: the wiki host code lives in `src/wiki/`.

- Key building. `src/shared/wiki-core.ts:39-46` `normalizeWikiSegment` (strip `.md`/`.markdown`,
  trim, lower-case, `[ _]+` to `-`, collapse and trim `-`); `:48-55` `normalizeWikiLookupKey` (split
  on `/` and `\`, normalize each segment, drop empty ones); `:60-73` `wikiKeysForRelativePath`
  (relative-path key plus basename key, deduplicated). `src/wiki/wiki.ts:65-71` `getWikiKeys`;
  `:6` re-exports `normalizeWikiLookupKey`.
- Cache store. `src/wiki/wiki-cache.ts:18` `keyToUris`, `:19` `uriToKeys`, `:20` `cachedAllKeys`;
  lookup `:54-56` `has`, `:58-60` `resolve`; lists `:62-67` `allPageKeys`, `:74-98`
  `allDisplayNames` (unique basename bare, shared basename path-qualified), `:100-112` `allFiles`.
- Duplicate-filename picker. `src/session/asset-link-actions.ts:585-646` `onOpenWikilink`: key at
  `:598`, `cache.resolve(key)` at `:603-604`, zero matches gives the "Create Page" prompt
  (`:606-621`), more than one gives the QuickPick `Select wiki page for "<target>"` (`:622-640`),
  one opens with `vscode.openWith` (`:642-646`).
- Scan. `src/wiki/wiki.ts:275-289` `collectWikiMarkdownFiles`: one `workspace.findFiles` under the
  root. The scan reads NO file content today. `wiki-cache.ts:143-151` `fullScan` calls `:153-167`
  `indexFile` per file. `wiki.ts:45-57` `getWikiRoot`: `file` scheme only (`:46`), so Node `fs`
  reads are valid for every wiki page.
- Build and singleton. `wiki-cache.ts:35-46` `WikiCache.build`, `:230-262` `startBuild` (stale-build
  guard `:239`), `:282-299` `getOrBuildCache`, `:301-312` `invalidateCache`.
- Watch and save path. `wiki-cache.ts:186-208` `startWatcher`: `onDidCreate` (`:197-203`, exclusion
  check `:200`) and `onDidDelete` (`:204-207`) only. There is NO `onDidChange` handler, so a saved
  edit of an existing page changes nothing in the cache today. `:190-196` `scheduleUpdate`: 50 ms
  debounced listeners plus `schedulePersist` (`:137-141`, 2 s). The session's own
  `onDidSaveTextDocument` (`src/session/editor-session.ts:1830`) is per-document and not wiki
  related. Exclusion: `wiki.ts:239-255` `isWikiPageExcluded`.
- Persisted list (Task 638). `src/wiki/wiki-key-store.ts:16` `SchemaVersion = 1`, `:23-26`
  `StoredKeys { pageKeys, displayNames }`, `:76-92` `parseEntry`.
- Session delivery. `src/wiki/wiki-session.ts:18-21` `WikiKeys`, `:39-42` `keysOf`, `:46-49`
  `sameKeys`, `:119-146` `planInit`, `:152-164` `deliverPending`, `:166-174` `subscribeChanges`.
  `editor-session.ts:371-375` `planWikiKeys`, `:377-379` `postWikiUpdate`, `:391-398`
  `refreshWikiKeys` (destructures only `pageKeys`/`displayNames` at `:394-396`).
- Protocol. `src/shared/protocol.ts:187-191` `WikiInit { enabled, pageKeys?, displayNames? }`,
  `:414` `wiki-update { pageKeys; displayNames? }`, `:557` `open-wikilink { target }`; host shape
  `src/webview-host/webview-message-shape.ts:123`; webview shape
  `media-src/src/bridge/message-router.ts:1104`.
- Chip resolution, webview. `media-src/src/links/custom-renderer.ts:125-175` `wikiTextToHtml`
  (missing flag `:153-155`: `knownPages.has(normalizeWikiLookupKey(target))`);
  `media-src/src/links/wiki-keys.ts:19-42` `refreshWikiChips` (attributes only);
  `message-router.ts:1298-1330` `wiki-update` handler (fills `wikiKnownPages`/`wikiDisplayNames`,
  updates `lastInitMsg.wiki`, refreshes chips, re-runs the loading hint);
  `media-src/src/boot/vditor-init.ts:489-506` init fill; state
  `media-src/src/boot/editor-session-state.ts:58-68,81`. Click:
  `media-src/src/links/link-click-fix.ts:65` posts `open-wikilink`.
- Chip resolution, host prerender. `src/lute/lute-host.ts:450-463` `renderWikiChipsInHtml`: no
  page index, every chip renders resolved; unchanged by this task.
- `[[` hint list. `vditor-init.ts:378-411`: two extends, `[[` (`:381`) and `​[` (`:399`, prefix
  `' '`); both call `wikiHintItems(value, pages[, ' '])` (`custom-renderer.ts:25-43`, items
  `{ html, value }`, `:19-22`), with `wikiDisplayNames` preferred over `wikiKnownPages`.
- Rename refactor (Task 202): NOT shipped (`tasks/202-wiki-rename-refactor.md`, status planned). The
  only rename code is `editor-session.ts:1871-1896` `onDidRenameFiles`, which re-points the open
  panel and rewrites no link. Task 202's out-of-scope list already names alias resolution.
- Tag index (Task 205): NOT shipped (`tasks/205-tags-chips-index.md`, status planned; it plans the
  host index in the wiki scan and counts front-matter `tags:` "once 207 lands").
- Parser reuse. `src/shared/front-matter.ts:157-189` `parseFrontMatterProperties(yamlText)` turns
  the YAML text into table rows; `:79-94` `scalarText` holds the quote and PLAIN rules. It has no
  block locator: the webview reads the YAML from Lute's DOM. `yaml` (`package.json:1859`, 2.9.0)
  is bundled; the host does not import it yet. Module map: `scripts/module-manifest.mjs:75`
  (`shared` ids hold `front-matter`), `:121` (`wiki` ids).
- Test seams. `test/backend/vscode-mock.ts:725-745` `createFileSystemWatcher`: `onDidChange` exists
  but only `fireChange()` (fires `undefined`, `:737`); there is no `_fireChange(uri)`.
  `mock.setWorkspaceFiles` (`:1030`) feeds `findFiles` with virtual paths, so a real `fs` read of
  those paths fails (ENOENT) and must give "no metadata".

### 2. Design

#### 2.1 Extraction (shared, pure): `src/shared/front-matter.ts`

Add beside the Task 207 code, reusing its `parseDocument` import and the PLAIN/quoted rules of
`scalarText`:

```ts
export interface FrontMatterMetadata {
  aliases: string[]
  tags: string[]
}
/** Upper bounds per file; extra entries are ignored. */
export const FRONT_MATTER_ALIAS_LIMIT = 64
export const FRONT_MATTER_TAG_LIMIT = 256
/**
 * The YAML text of the leading front-matter block, or null when `markdown` does not start with
 * one or the block is not closed in the given text.
 */
export function frontMatterYaml(markdown: string): string | null
/** True when `markdown` starts with an opening fence (used to decide whether to read more bytes). */
export function startsWithFrontMatterFence(markdown: string): boolean
/**
 * `aliases` and `tags` of a front-matter YAML text. Null when the YAML has an error, the top level
 * is not a map, or neither key gives a usable value. Never throws.
 */
export function readFrontMatterMetadata(yamlText: string): FrontMatterMetadata | null
```

Rules (exact):
- Fence: optional U+FEFF, then a first line `---` with optional trailing spaces or tabs, ended by
  `\n` or `\r\n`. Closing fence: the next line that is `---` with optional trailing spaces or tabs.
  The YAML text is the lines between (without the closing line). An empty block gives `''`, and
  `readFrontMatterMetadata('')` is null.
- Keys `aliases` and `tags`, case-sensitive, top-level only. No legacy `alias`/`tag` keys
  (provisional, Q4).
- Scalar value: one entry. Quoted scalar gives its parsed value; PLAIN gives its source text
  (`2024` stays `2024`); null or empty value gives no entry. No comma splitting (provisional, Q4).
- Sequence value: each scalar item by the scalar rule; non-scalar items (maps, nested lists,
  aliases `*a`) are skipped. A map value is skipped.
- Each entry is trimmed; empty entries are dropped; tags lose one leading `#`; duplicates are
  dropped keeping the first (aliases compared by `normalizeWikiLookupKey`, tags by lower case).
- An alias containing `[`, `]`, `|`, `\n`, or whose normalized key is empty is dropped: it can never
  be written inside `[[…]]` (`WikiLinkPattern`, `wiki-core.ts:5`; `|` starts a label).
- Malformed YAML (any `document.errors`, including a duplicate `aliases` key) gives null: the file
  keeps its path keys and has no metadata. The function never throws (wrap `parseDocument` in
  `try`/`catch`, returning null).
- Allocation: return null (no arrays) when both lists end empty.

#### 2.2 Head read (host): new module `src/wiki/wiki-front-matter.ts`

Add id `wiki-front-matter` to the `wiki` ids at `scripts/module-manifest.mjs:121`.

```ts
export const WIKI_FRONT_MATTER_HEAD_BYTES = 4096
export const WIKI_FRONT_MATTER_MAX_BYTES = 65536
export const WIKI_METADATA_READ_CONCURRENCY = 16
/** Metadata of one page, or null (no front matter, not closed within the cap, malformed, unreadable). */
export async function readWikiPageMetadata(
  fsPath: string,
  scratch: Buffer,
): Promise<FrontMatterMetadata | null>
/** Reads every file with at most WIKI_METADATA_READ_CONCURRENCY open files; calls `onMetadata` only for non-null results. */
export async function readWikiMetadataBatch(
  files: readonly vscode.Uri[],
  onMetadata: (file: vscode.Uri, metadata: FrontMatterMetadata) => void,
  token?: vscode.CancellationToken,
): Promise<void>
```

Cost policy (exact):
- `node:fs/promises` `open(fsPath, 'r')` + `read(scratch, 0, WIKI_FRONT_MATTER_HEAD_BYTES, 0)` +
  `close()` in `finally`. Never `readFile`, never `workspace.fs.readFile` (whole file).
- Fast reject on bytes, before any string: the first 3 bytes (after an optional `EF BB BF`) must be
  `2D 2D 2D`; otherwise return null. No string, no array, no object for such files.
- Only then decode the read bytes (`scratch.toString('utf8', 0, bytesRead)`) and call
  `frontMatterYaml`. If it is null, the head was full (`bytesRead === HEAD_BYTES`) and the fence
  starts the text, read once more up to `WIKI_FRONT_MATTER_MAX_BYTES` into a new buffer (allocated
  only for this file) and retry; still not closed gives null.
- One scratch `Buffer.allocUnsafe(WIKI_FRONT_MATTER_HEAD_BYTES)` per worker, reused for every file
  (16 buffers per scan). Any read error gives null; nothing is logged per file.
- `token.isCancellationRequested` is checked before each file.
- Measured (probe `tmp/709/probe-head-read.mjs`, synthetic 6,000 files, warm page cache): head reads
  2,150 ms serial, 414 ms at 8, 171 ms at 16, 165 ms at 32 open files. Probe
  `tmp/709/probe-parse.mjs`: `parseDocument` of a typical block 0.08 ms; 2,040 front-matter files
  of 6,000 add about 160 ms. Cold-disk cost was not measured.

#### 2.3 Cache merge: `src/wiki/wiki-cache.ts`

New fields (path-key fields unchanged):

```ts
// Alias keys, separate from path keys so a path key always wins and Task 202 can tell them apart.
private aliasKeyToUris = new Map<string, vscode.Uri[]>()
// Only files that declare aliases or tags have an entry.
private uriToMetadata = new Map<string, WikiPageMetadataEntry>()
private cachedAliasHints: WikiAliasHint[] | null = null
// fsPath -> sequence number of the newest read in flight; an older read's result is dropped.
private metadataReads = new Map<string, number>()
private metadataReadSequence = 0

interface WikiPageMetadataEntry {
  aliases: string[]      // as declared (after 2.1 cleanup)
  aliasKeys: string[]    // normalizeWikiLookupKey(alias), same order, deduplicated
  tags: string[]
}
```

Public API (`WikiAliasHint` from `src/shared/protocol.ts`, see 2.5):
- `has(key)`: `keyToUris.has(key) || aliasKeyToUris.has(key)`.
- `resolve(key)`: path matches when any, else alias matches, else `[]`. Path wins (provisional,
  Q1). Alias-only ambiguity (two files declare the same alias, or an alias equals two files'
  aliases) returns every declaring file, so `onOpenWikilink` shows the existing picker unchanged.
- `resolvePathKey(key): vscode.Uri[]`: path matches only. Contract for Task 202 (2.6).
- `allPageKeys()`: sorted union of both maps' keys (cached in `cachedAllKeys` as now). Alias keys
  therefore reach `pageKeys`, so the webview chip check (`custom-renderer.ts:153-155`) and
  `refreshWikiChips` resolve alias chips with no webview change.
- `allAliasHints(): WikiAliasHint[]`: one entry per (declared alias, declaring file) whose alias
  key is NOT a path key and is not the declaring file's own path key; `file` is that file's display
  name by the `allDisplayNames` rule (refactor that rule into a private
  `displayNameOf(uri, baseCount)` shared by both). Sorted by `alias`, then `file`. Cached in
  `cachedAliasHints`, cleared wherever `cachedAllKeys` is cleared.
- Tags, store and expose only (Task 205 not shipped): `tagsOf(file: vscode.Uri): readonly string[]`
  (`[]` when none), `filesWithTag(tag: string): vscode.Uri[]` (case-insensitive, leading `#`
  ignored, sorted by `fsPath`), `allTags(): string[]` (distinct, first-seen spelling, sorted
  case-insensitively). No protocol field, no webview change, no setting.

Private flow:
- `fullScan`: after the path loop (unchanged), `await readWikiMetadataBatch(files, (file, m) =>
  this.applyMetadata(file, m), token)`. The build resolves after both, so the first delivered key
  set already holds alias keys (single phase; a two-phase delivery was rejected because a served
  Task 638 list holding alias keys would flip alias chips to missing and back). The pending period
  ("Loading pages…", no chip marked missing) grows by the measured read cost only on a cold open
  with no stored list.
- `applyMetadata(file, metadata: FrontMatterMetadata | null): boolean`: removes the file's old alias
  keys from `aliasKeyToUris`, stores or deletes the `uriToMetadata` entry, adds the new alias keys,
  clears both caches. Returns true when the alias set changed (tags-only changes return false).
- `removeFile` also calls `applyMetadata(…, null)` for that path and deletes `metadataReads`.
- `refreshMetadata(file)`: sets `metadataReads.set(fsPath, ++metadataReadSequence)`, awaits
  `readWikiPageMetadata`, then drops the result when the cache is disposed, the file is no longer in
  `uriToKeys`, or a newer read started; otherwise deletes the in-flight entry and, when
  `applyMetadata` returns true, calls the same `scheduleUpdate` as create/delete.
- Watcher: `onDidCreate` keeps its synchronous `indexFile` + `scheduleUpdate`, then
  `void this.refreshMetadata(uri)`. New `onDidChange(uri)`: ignore when `uriToKeys` lacks
  `uri.fsPath` (excluded or unknown), else `void this.refreshMetadata(uri)`. A save that does not
  change the alias set posts nothing (no `wiki-update` per save).
- Unsaved edits do not change aliases; the cache follows the file on disk (save or external edit).
- Persisted list (Task 638): unchanged schema. `pageKeys` already include alias keys through
  `allPageKeys`; alias hints are not stored (the background scan always revalidates and then
  posts them).

#### 2.4 Session and host delivery

- `src/wiki/wiki-session.ts`: `WikiKeys` gains `aliases?: WikiAliasHint[]` (optional so
  `StoredKeys` still fits `served`); `keysOf` sets `aliases: cache.allAliasHints()`; `sameKeys` also
  compares `a.aliases ?? []` with `b.aliases ?? []` by `alias` and `file`.
- `src/session/editor-session.ts:391-398` `refreshWikiKeys`: pass `aliases` through with the other
  two fields. `postWikiUpdate` already spreads `keys`.
- `asset-link-actions.ts` `onOpenWikilink`: no change (it uses `cache.resolve`).

#### 2.5 Protocol and webview

- `src/shared/protocol.ts`: `export interface WikiAliasHint { alias: string; file: string }`;
  `WikiInit.aliases?: WikiAliasHint[]`; `wiki-update` gains `aliases?: WikiAliasHint[]`. No shape
  table change (optional field; the handler validates).
- `media-src/src/boot/editor-session-state.ts`: `wikiAliases: WikiAliasHint[]` (initial `[]`),
  replaced as a whole, never mutated.
- `vditor-init.ts:489-506` and `message-router.ts:1298-1330`: set `sessionState.wikiAliases` from
  the message through a new pure `validWikiAliasHints(value: unknown): WikiAliasHint[]` in
  `media-src/src/links/wiki-keys.ts` (array of objects with non-empty string `alias` and `file`;
  anything else dropped); the router also copies `aliases` into `lastInitMsg.wiki`.
- `media-src/src/links/custom-renderer.ts`: new
  `export function wikiAliasHintItems(value: string, aliases: readonly WikiAliasHint[], prefix = ''): WikiHintItem[]`.
  Match: `alias.toLowerCase().includes(value.toLowerCase())`. `html`: `${escapeHTML(alias)} → ${escapeHTML(file)}`
  (U+2192, one space each side). `value`: the chip of the recommended insertion (Q2 option a):
  `prefix + <span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="<file>" data-wiki-source="[[<file>|<alias>]]"><alias></span>`,
  attributes and text escaped as in `wikiHintItems`. If the orchestrator picks Q2 option b, target
  `alias` and source `[[<alias>]]`.
- `vditor-init.ts:381-409`: both extends return
  `[...wikiHintItems(value, pages[, ' ']), ...wikiAliasHintItems(value, sessionState.wikiAliases[, ' '])]`
  (page rows first). The loading row is unchanged.

#### 2.6 Rename interplay (pin)

Task 202 is not shipped, so nothing rewrites links today. This task pins the contract Task 202
must follow, as API and tests:
- A link is rewritten on rename only when `cache.resolvePathKey(key)` returns exactly the renamed
  file. A link whose key resolves only through `aliasKeyToUris` is never rewritten: after the
  rename the alias still resolves to the new path (the alias moves with the file through the
  watcher's delete + create + metadata read).
- The orchestrator adds one line to Task 202's scope when it files this handoff ("use
  `WikiCache.resolvePathKey`; alias-resolved links are not rewritten, Task 709"). Part 2 does not
  edit the Task 202 record.

### 3. Test plan

Acceptance items: A1 extractor (list, scalar, missing, malformed); A2 alias keys join the cache
(normalized); A3 ambiguity like duplicate filenames; A4 re-parse on save and watch; A5 tags stored
and exposed; A6 chip resolution includes aliases; A7 hint offers `alias → file`; A8 rename pin;
A9 cost policy (head only, allocation only for declaring files).

Vitest (`npx vitest run --config test/vitest.config.ts <files>`):
- `test/backend/front-matter.test.ts` (extend; new `describe('front-matter metadata')`):
  - A1 `frontMatterYaml`: LF and CRLF fences, BOM, trailing spaces on fences, no opening fence,
    not closed, empty block, `---` not on line 1.
  - A1 `readFrontMatterMetadata`: list `aliases: [A, B]`; block list; scalar `aliases: Some Alias`;
    quoted scalar; PLAIN number `tags: 2024`; null value; missing keys gives null; malformed (bad
    indent, duplicate `aliases` key, unterminated quote) gives null without throwing; top-level list
    gives null; map value skipped; nested items skipped; `#` stripped from tags; dedupe; aliases
    with `[`, `]`, `|`, newline dropped; limits 64/256.
- `test/backend/wiki-front-matter.test.ts` (new; real temp dir under `os.tmpdir()`):
  - A9 a file without front matter returns null; a 5,000-byte front matter (beyond the head) is
    read through the second read; a block not closed within 65,536 bytes returns null; an
    unreadable path returns null; `readWikiMetadataBatch` never has more than 16 open handles
    (spy on `open` from `node:fs/promises` with `vi.mock` passthrough, count concurrent opens) and
    calls `onMetadata` only for declaring files; a cancelled token stops further reads.
- `test/backend/wiki-cache.test.ts` (extend; real temp dir files fed to
  `mock.setWorkspaceFiles`):
  - A2 `[[Some Alias]]` key `some-alias` is in `allPageKeys` and `resolve` returns the declaring
    file; a malformed file keeps its path keys and adds none.
  - A3 two files declaring one alias: `resolve` returns both (picker); alias equal to another
    file's basename: `resolve` returns only the path match and `allAliasHints` omits that alias
    (Q1 option a); alias equal to its own basename: one match, no hint entry.
  - A4 alias edit on disk + `_fireChange(uri)`: the old key leaves, the new key resolves, one
    change notification after the debounce; a save with unchanged aliases gives no notification;
    an older read finishing after a newer one is dropped; `onDidChange` for an unindexed path is
    ignored; create of a declaring file adds its alias after the read; delete removes it.
  - A5 `tagsOf`, `filesWithTag` (case and `#` insensitive), `allTags`.
  - A7 `allAliasHints` entries, display-name rule for duplicate basenames, sort order.
  - A8 rename pin: delete old path + create new path of a declaring file, then the read: `resolve(
    'some-alias')` returns the new path; `resolvePathKey('some-alias')` is `[]`;
    `resolvePathKey('page')` of the renamed file returns only path matches.
  - Existing virtual-path tests stay green (ENOENT gives no metadata).
- `test/backend/vscode-mock.ts`: add `_fireChange(uri: Uri)` to `MockWatcher` (test support only).
- `test/backend/wiki-session.test.ts` (extend): A7 `keysOf` carries `aliases`; `sameKeys` treats a
  served list without aliases as different from keys with aliases (an update is posted) and equal
  when both have none.
- `media-src/src/links/custom-renderer.test.ts` (extend): A7 `wikiAliasHintItems` html text with
  U+2192, escaping of `<`, `&`, `"`, prefix for the ZWSP key, filter case-insensitive, chip value
  shape for Q2 option a.
- `media-src/src/links/wiki-keys.test.ts` (extend): A6/A7
  `validWikiAliasHints` drops non-arrays, non-objects, empty strings.

Real VS Code (mandatory), `test/vscode-e2e/wiki-front-matter-aliases.spec.ts` with a generated
workspace (the `baseDir` pattern of `test/vscode-e2e/wiki-deferred-keys.spec.ts:97-108`):
`notes/Target Page.md` declares `aliases: [Some Alias]`; `links.md` holds `[[Some Alias]]` and
`[[no-such-page]]`; `.vscode/settings.json` enables `vmde.wiki.enabled`.
- A6 after keys arrive, the `[[Some Alias]]` chip has no `data-wiki-missing`, and the missing-page
  chip has it.
- A6 opening the alias chip (the `open-wikilink` route used by `wiki-chip-focus.spec.ts`, with the
  modifier policy of `link-click-fix.ts`) makes `notes/Target Page.md` the active tab, with no
  QuickPick and no "Create Page" prompt.
- A7 typing `[[Some` (ASCII, XTEST) shows a hint row with text `Some Alias → Target Page`; picking it
  inserts the Q2 source (option a: `[[Target Page|Some Alias]]`) into the host document text.
- A4 (optional in the same spec, one test): rewrite the alias on disk with `fs.writeFileSync`, then
  the chip of the new alias is resolved after the watcher update.
The orchestrator runs it (`node build.mjs`, then the wrapper).

L2 (record "Verification"): A6 is covered by the real-VS-Code chip assertion; no separate Chromium
harness case, because chip resolution needs host keys and the harness has no host scan.

### 4. Split plan for Part 2

- Step R (RED, tests only). Own: `test/backend/front-matter.test.ts`,
  `test/backend/wiki-front-matter.test.ts`, `test/backend/wiki-cache.test.ts`,
  `test/backend/wiki-session.test.ts`, `test/backend/vscode-mock.ts` (only `_fireChange`),
  `media-src/src/links/custom-renderer.test.ts`, `media-src/src/links/wiki-keys.test.ts`,
  `test/vscode-e2e/wiki-front-matter-aliases.spec.ts`. Check: the vitest files fail on missing
  exports or wrong behaviour only (no syntax or import-path failures other than the new module);
  `npm run lint:ci` on the new files.
- Step I (implementation). Own: `src/shared/front-matter.ts`, `src/wiki/wiki-front-matter.ts`
  (new), `src/wiki/wiki-cache.ts`, `src/wiki/wiki-session.ts`, `src/session/editor-session.ts`
  (`refreshWikiKeys` only), `src/shared/protocol.ts`, `scripts/module-manifest.mjs`,
  `media-src/src/boot/editor-session-state.ts`, `media-src/src/boot/vditor-init.ts`,
  `media-src/src/bridge/message-router.ts`, `media-src/src/links/custom-renderer.ts`,
  `media-src/src/links/wiki-keys.ts`. Check: Step R vitest green; existing
  `test/backend/wiki-*.test.ts` and `test/backend/module-boundaries.test.ts` green; `npm run
  typecheck`; `node build.mjs`; `npm run lint:ci`; coverage of the new lines (vmde-testing
  "Coverage"). The orchestrator then runs the real-VS-Code spec plus the regression set
  `wiki-deferred-keys`, `wiki-persistent-keys`, `wiki-keys-after-setting`,
  `wiki-hint-consecutive`, `wiki-chip-focus`.
- The two steps share no file and run in order. If the orchestrator picks Q2 option b, only the
  chip value line in `custom-renderer.ts` and its two test expectations change.

### 5. Open product choices (each needs a provisional decision)

- Q1 Alias equal to another file's name or path key. (a, recommended) The path key wins: existing
  `[[Guide]]` links keep their target when some page adds `aliases: [Guide]`; the shadowed alias
  is left out of the hint. Matches Obsidian, where file names come first. (b) Union with the
  picker, the literal reading of "ambiguity like duplicate filenames"; it turns an unambiguous
  link into a picker when any page adds an alias. Alias against alias stays a picker in both.
- Q2 Text inserted by an alias hint row. (a, recommended) `[[<file>|<alias>]]`: unambiguous, stays
  resolved in Obsidian (which does not resolve a bare `[[Alias]]`, to the best of available
  knowledge, not verified here), and Task 202 rewrites it on rename. (b) `[[<alias>]]`: keeps the
  typed name as the target; relies on alias resolution and is not rewritten on rename.
- Q3 Case folding of aliases. (a, recommended) Same as file names: `normalizeWikiLookupKey`
  (lower case, spaces and `_` to `-`), so `[[some alias]]` and `[[Some_Alias]]` resolve. (b) Exact
  match; needs a second key space and differs from file-name links.
- Q4 YAML forms. (a, recommended) Only `aliases`/`tags`; a scalar is one value (no comma split); no
  legacy `alias`/`tag` keys. (b) Also accept `alias`/`tag` and comma-separated scalars (older
  Obsidian notes).
- Q5 Tags without Task 205. (a, recommended) Host API only (`tagsOf`, `filesWithTag`, `allTags`);
  no protocol field, no UI; Task 205 consumes it. Tag comparison case-insensitive, leading `#`
  ignored, spelling kept for display. (b) Also send tags to the webview now (no consumer yet).
- Q6 Cold-open cost. (a, recommended) Single-phase scan (2.3): keys arrive after paths and heads are
  read; measured about 170 ms for 6,000 warm files plus about 160 ms of parsing for 2,040 front
  matters. (b) Two-phase delivery (paths first, aliases later); faster first keys on a cold open,
  but a served stored list makes alias chips flip to missing and back.

Residual risks: cold-disk head-read cost is not measured; the fence rule in 2.1 is written to
match Lute's front-matter recognition but is not checked against Lute here (Step R can add one
case comparing `frontMatterYaml` with Lute's `vditor-yml-front-matter` output); the host bundle
grows by the `yaml` parser (about 95 KB minified in production builds, `scripts/build-extension.mjs:14`) because `wiki-cache.ts` now imports
`src/shared/front-matter.ts`; the host has no bundle budget row.

## Decisions Q1–Q6 (provisional, orchestrator on the Owner's behalf, 2026-11-08)

All six take the Part 1 recommendation (option a):

- Q1: a file name wins over an alias that equals it.
- Q2: picking an alias hint inserts `[[file|alias]]`; a bare `[[Alias]]` already in a document still resolves.
- Q3: aliases match case-insensitively through `normalizeWikiLookupKey`, like file names.
- Q4: only the `aliases` and `tags` keys (list or scalar); no comma splitting; no legacy `alias`/`tag`.
- Q5: without Task 205, tags stay on the host behind an API, matched case-insensitively.
- Q6: one scan pass (paths and front matter before keys are delivered).

## Part 2b results

Step I implemented on `wt/709` (2026-11-08). Real-VS-Code spec `test/vscode-e2e/wiki-front-matter-aliases.spec.ts` and the regression set are NOT run yet (orchestrator).

- Host: `src/shared/front-matter.ts` (`frontMatterYaml`, `startsWithFrontMatterFence`, `readFrontMatterMetadata`, limits 64/256); new `src/wiki/wiki-front-matter.ts` (head read 4 KiB, cap 64 KiB, 16 open files, byte-level fence reject, one scratch buffer per worker); `src/wiki/wiki-cache.ts` (alias map, metadata entries, `resolve` path-first, `resolvePathKey`, `allAliasHints`, `tagsOf`/`filesWithTag`/`allTags`, `applyMetadata`/`refreshMetadata` with sequence guard, `onDidChange`, single scan pass); `src/wiki/wiki-session.ts` (`aliases` in `WikiKeys`, `sameKeys`); `editor-session.ts` `refreshWikiKeys`; `protocol.ts` (`WikiAliasHint`, `WikiInit.aliases`, `wiki-update.aliases`); `scripts/module-manifest.mjs` (`wiki-front-matter`).
- Webview: `validWikiAliasHints` (`wiki-keys.ts`), `wikiAliasHintItems` (`custom-renderer.ts`), `sessionState.wikiAliases`, both `[[` extends and the init and `wiki-update` handlers.
- Deviations from the handoff text (no behaviour change against the tests):
  - `keysOf` leaves `aliases` out when no page declares one, so the five existing Task 638 session tests (exact `toEqual` on delivered keys) stay valid. A missing list means "no alias hints" in the webview.
  - `WikiPageMetadataEntry` also holds `uri` (needed for `filesWithTag`, `allAliasHints`).
  - `allTags` walks files in path order so "first-seen spelling" is deterministic under concurrent reads.
- Step R test changed: `front-matter.test.ts` "drops duplicates" used an unquoted `#FOO` in a YAML flow list; YAML reads `#` as a comment, so the block was malformed. Quoted it (`"#FOO"`).
- Part 2a virtual-path test: root fixed to `/ws/virtual`; asserts `['ghost']`, passes (the scan sees the page, ENOENT gives no metadata).
- Host bundle (`scripts/build-extension.mjs --production`, `dist/extension.js`): 160,259 B before, 280,840 B after (+120,581 B, the bundled `yaml` parser).
- Checks: Step R Vitest files plus `wiki-*.test.ts` and `module-boundaries.test.ts`: 10 files, 253 tests pass. `npm run typecheck` ok. `node build.mjs` ok. `npm run lint:ci` exit 0 (4 infos in untouched files). `npx knip` exit 0. `npm run quality`: exit 0, every stage passes (390 files, 8846 tests pass, 1 expected fail). Uncovered lines in the changed files are the defensive `catch`, the unreachable loop end and pre-existing lines.

## Part 2c results

Orchestrator run after Part 2b: 10 passed, 2 failed. Both resolved without product-code changes.

- `wiki-front-matter-aliases.spec.ts` strict-mode violation (class: spec defect). Opening the declaring file leaves two `iframe.webview` elements, so `wf()` was ambiguous. The spec now reopens the document through the shared `reopenVmdeFixture` helper (`iframe.webview:visible`) and waits for router, editor and Lute readiness before typing.
- `wiki-chip-focus.spec.ts` host-trigger test (class: not a Task 709 regression). On a detached baseline at `dd860b86` the test passes (1/1). On this branch it passes in all four runs of the final combined run. The chip-focus failure seen once in the earlier combined run, and one `vmde-caret-inside` failure in the Ctrl+Enter test of an intermediate run, are the caret-decoration predicate (selection and focus based, no wiki lookup involved); they did not reproduce in the final run. A VS Code process of another run was active during the intermediate run. Treated as load-dependent; no change made.
- Final run (`wiki-front-matter-aliases.spec.ts` + `wiki-chip-focus.spec.ts`, `--repeat-each=2 --workers=1 --retries=0`): 8 passed, 8 total. An intermediate run, before the readiness wait was added to the new spec, had 6 of 8 passing (one hint-row timeout in the new spec, one chip-focus caret failure).
- `npm run lint:ci` exit 0, `npm run typecheck` exit 0, `npm run typecheck:vscode-e2e` exit 0. No product code changed, so `npm run quality` was not rerun.

## Closure (2026-11-08)

Front-matter `aliases:` join the wiki cache keys (case-insensitive, a file name wins over an equal alias), the `[[` hint list offers `alias → file` and inserts `[[file|alias]]`, and `tags:` are kept on the host behind an API. The scan reads only the first 4 KiB of each file (cap 64 KiB, 16 files open at once) in one pass; the watcher re-reads a changed file. Rename keeps alias-resolved links (`WikiCache.resolvePathKey`). Decisions Q1–Q6 are provisional (orchestrator on the Owner's behalf).

- Vitest: Step R 51 RED, then the Step R files plus `test/backend/wiki-*.test.ts` and `module-boundaries` 253 of 253.
- Real VS Code: `wiki-front-matter-aliases.spec.ts` and `wiki-chip-focus.spec.ts` 8 of 8 (`--repeat-each=2`); the regression set `wiki-deferred-keys`, `wiki-persistent-keys`, `wiki-keys-after-setting`, `wiki-hint-consecutive` passed in the orchestrator run. One `wiki-chip-focus` failure in that run passed on the baseline and in all later runs (load-dependent `vmde-caret-inside` poll).
- `npm run quality` passed all 8 stages on the product tree (the last change was spec-only).
- The extension host bundle grows from 160 KB to 281 KB (the bundled `yaml` parser); the host bundle has no size budget.
- Not measured: the head-read cost on a cold disk. Task 202 (rename) and Task 205 (tag index) are still planned; Task 202 must use `resolvePathKey` so alias-resolved links are not rewritten.
