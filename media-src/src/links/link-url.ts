// Task 390 — the link toolbar button ignored a selected URL.
//
// Selecting `https://example.com` and clicking 🔗 produced `[https://example.com](https://)`: the URL
// became the link TEXT and the destination stayed the literal placeholder, so the one thing the user
// had already supplied was the one thing the link lacked. What it must produce is the URL in BOTH
// halves — `[https://example.com](https://example.com)` — which is also the shape the user's own
// documents already carry.
//
// Consumed by the esbuild patches on vditor's `ir/process.ts` and `wysiwyg/toolbarEvent.ts` (see
// esbuild-shared.mjs) through the `__vmdeSelectedUrl` global installed below: the patched Vditor
// sources cannot import from our bundle, and a global keeps the patch itself down to one line.

// Deliberately strict. A false positive silently rewrites a link's destination to something the user
// never typed, which is far worse than the missing convenience — so this only recognises the shapes
// that cannot be anything BUT a URL:
//   - an explicit scheme we know: http, https, mailto
//   - a bare `www.` host, which is a URL by convention everywhere and gets an https:// destination
// Anything with whitespace, a newline, or no dot in the host is ordinary text.
const EXPLICIT_SCHEME = /^(?:https?:\/\/|mailto:)\S+$/i
const BARE_WWW = /^www\.[^\s/]+\.[^\s]+$/i

/**
 * The destination a selected string should become, or null when the selection is ordinary text and
 * the button must keep its existing behaviour (selection → label, placeholder → destination).
 */
export function selectedUrl(selection: string): string | null {
  const text = selection.trim()
  // A multi-line clipboard/selection is not a URL even when its first line looks like one.
  if (!text || /\s/.test(text)) return null
  if (EXPLICIT_SCHEME.test(text)) return text
  if (BARE_WWW.test(text)) return `https://${text}`
  return null
}

// Task 392 — paste-a-URL-as-a-link is ON by default but must be switchable off
// (`vmde.paste.urlAsLink`): pasting is a reflex action, and a user who wants the bare URL
// must not have to undo every time. Set from the host's options on init and on every settings change.
let pasteUrlAsLink = true

// How long an explicit-edit mark stays valid. Comfortably longer than edit-sync's 250 ms debounce,
// short enough that a mark whose post never happened cannot attach itself to a later edit.
const EXPLICIT_EDIT_TTL_MS = 5000

export function applyPasteUrlSetting(enabled: boolean | undefined): void {
  pasteUrlAsLink = enabled !== false
}

/**
 * Task 707: pull a range's boundaries inside the Text nodes that hold the selected text.
 *
 * A late undo snapshot can restore a selection of a decorated URL (`See <span>url</span>`) with its
 * start on the END of the previous Text node (`See `, 4) instead of the span's text (0). The selected
 * text is the same, but `range.surroundContents(a)` then throws `InvalidStateError` (partially
 * selected non-Text node) and the Link action is silently lost. Moving a start at a Text end to the
 * next non-empty Text start, and an end at a Text start to the previous non-empty Text end, keeps
 * `toString()` identical and gives the passing shape. Mid-text, collapsed or same-node boundaries
 * are untouched. Runs only in the toolbar Link branch with a non-empty range; the TreeWalker is
 * created only when a boundary sits at a Text edge.
 */
export function tightenLinkRange(range: Range): void {
  if (range.collapsed) return
  const { startContainer: start, endContainer: end } = range
  const startAtTextEnd =
    start.nodeType === Node.TEXT_NODE &&
    range.startOffset === (start as Text).length
  const endAtTextStart =
    end.nodeType === Node.TEXT_NODE && range.endOffset === 0
  if (!startAtTextEnd && !endAtTextStart) return
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
  )
  if (startAtTextEnd) {
    walker.currentNode = start
    const next = nextNonEmptyText(walker, true)
    // Stay inside the range: a hop past the end would grow the selection.
    if (next && range.comparePoint(next, 0) <= 0) range.setStart(next, 0)
  }
  if (endAtTextStart) {
    walker.currentNode = end
    const prev = nextNonEmptyText(walker, false)
    if (prev && range.comparePoint(prev, prev.length) >= 0)
      range.setEnd(prev, prev.length)
  }
}

/** Next (or previous) Text node with content from the walker's current node, or null. */
function nextNonEmptyText(walker: TreeWalker, forward: boolean): Text | null {
  for (
    let n = forward ? walker.nextNode() : walker.previousNode();
    n;
    n = forward ? walker.nextNode() : walker.previousNode()
  ) {
    if ((n as Text).length > 0) return n as Text
  }
  return null
}

/**
 * Expose the detector to the patched Vditor toolbar + paste handlers. Called once from main.ts; the
 * patches call it defensively (`?.()`), so a harness without it falls back to stock behaviour.
 */
export function installSelectedUrl(win: Window): void {
  ;(win as unknown as Record<string, unknown>).__vmdeSelectedUrl = selectedUrl
  ;(win as unknown as Record<string, unknown>).__vmdeExplicitEdit = () => {
    ;(win as unknown as Record<string, unknown>).__vmdeExplicitEditPending =
      Date.now()
  }
  // Task 707: exposed to the patched WYSIWYG toolbar Link branch (esbuild-shared.mjs,
  // patchWysiwygLinkSelectedUrl), which calls it before `range.surroundContents(node)`.
  ;(win as unknown as Record<string, unknown>).__vmdeTightenLinkRange =
    tightenLinkRange
  // Task 392: the markdown a pasted URL should become when NOTHING is selected — the URL as both
  // the label and the destination, matching what the link button produces for a selected URL.
  // Returns null when the setting is off, the clipboard text is not a URL, or the caret is already
  // inside a link (pasting into a destination must stay literal). The selected-text case is
  // Vditor's own and is deliberately left alone.
  ;(win as unknown as Record<string, unknown>).__vmdePasteUrlMd = (
    text: string,
    insideLink: boolean,
  ): string | null => {
    if (!pasteUrlAsLink || insideLink) return null
    const url = selectedUrl(text)
    return url ? `[${text.trim()}](${url})` : null
  }
  // Task 224 residual gap: Vditor's OWN selection-wrap branch (patchPasteUrlAsLink's stock anchor,
  // `range.toString() !== "" && IsValidLinkDest(textPlain)`) was never gated on
  // `vmde.paste.urlAsLink` — only the collapsed-caret branch above consulted it. Expose the
  // flag alone, NOT __vmdePasteUrlMd: that helper also runs OUR url-validity detector
  // (selectedUrl), which disagrees with Lute's IsValidLinkDest (measured: Lute rejects
  // `mailto:me@example.com` where ours accepts it), so routing the selection branch through it would
  // change WHICH pastes wrap, not just whether the setting is honoured.
  ;(win as unknown as Record<string, unknown>).__vmdePasteUrlEnabled =
    (): boolean => pasteUrlAsLink
}

/**
 * Was the last edit an explicit markup action whose result may be semantically identical to what is
 * already on disk? Read once and cleared by edit-sync when it posts.
 *
 * This exists because `[https://x](https://x)` and a bare `https://x` are the SAME document under
 * GFM — Lute's canonical round trip proves it — so the host's minimal-diff write-back classifies the
 * link button's work as a no-op and keeps the original bytes. That layer is right in general (it is
 * what stops an edit reflowing blocks the user never touched), so rather than weaken it, an explicit
 * button press says so, and the host rewrites only that one block.
 */
export function takeExplicitEdit(win: Window): boolean {
  const store = win as unknown as Record<string, unknown>
  const at = store.__vmdeExplicitEditPending
  store.__vmdeExplicitEditPending = undefined
  // Read-once AND time-limited. The post it belongs to can be skipped entirely (edit-sync bails
  // while an extension update / streaming is in flight), and a flag that survives that would force
  // a block rewrite on the NEXT, ordinary edit — the same staleness the cut-intent flag guards
  // against. Generous, because the post is only debounced by 250 ms.
  return typeof at === 'number' && Date.now() - at <= EXPLICIT_EDIT_TTL_MS
}

/**
 * Task 699: is an explicit-edit mark set and still fresh? Unlike `takeExplicitEdit` this does not
 * clear the mark: the undo boundary uses it to decide whether to publish, and the flush that follows
 * still needs the mark to attach `explicitBlock`. One window-property read.
 */
export function explicitEditPending(win: Window): boolean {
  const at = (win as unknown as Record<string, unknown>)
    .__vmdeExplicitEditPending
  return typeof at === 'number' && Date.now() - at <= EXPLICIT_EDIT_TTL_MS
}
