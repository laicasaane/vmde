// Global link/wiki-chip click + keyboard routing (split out of utils.ts, 185/3g).
//
// A webview anchor must never navigate the panel — every link routes to the host
// (open-link / open-wikilink) under the task-62 modifier policy. Wiki chips get
// click-to-expand, Enter/Space activation, and one-keystroke Backspace/Delete removal
// (contenteditable can't natively delete an opaque inline span).

import '../util/vscode-api'
import { guardComposition, registerCaretGesture } from '../util/caret-gesture'
import { linkLikeAt, linkLikeInSelection } from './caret-link'
import { isEditorContentLink, shouldOpenLink } from './link-open-policy'
import { rawHrefOf } from './raw-href'
import { tryScrollToSameDocAnchor } from './same-doc-anchor'
import { resolveSvSourceLink } from './sv-source-link'

function collapseExpandedWikiChips() {
  for (const el of document.querySelectorAll('.wiki-link-chip--expanded')) {
    el.classList.remove('wiki-link-chip--expanded')
  }
}

// Task 229 — clickable code references. `data-code-ref="1"` is set on BOTH decoration shapes
// (code-ref-decorate.ts's prose chip `<span>` and its attribute-only inline-`<code>` case), so
// one selector/handler covers both — the click target's own data-* attributes carry everything
// needed, no lookup elsewhere. Reads `line`/`col` as plain numbers (the decorator only ever
// writes digit strings — see findCodeRefs' `\d+` capture — so no NaN guard needed here).
function openCodeRefFromElement(el: HTMLElement): boolean {
  const path = el.dataset.codeRefPath
  const line = el.dataset.codeRefLine
  if (!path || !line) return false
  const col = el.dataset.codeRefCol
  vscode.postMessage({
    command: 'open-code-ref',
    path,
    line: Number(line),
    ...(col ? { col: Number(col) } : {}),
  })
  return true
}

// Task 243 — a bare `#fragment` href is a same-document anchor: resolve + scroll to it
// entirely in-process (tryScrollToSameDocAnchor, backed by the shared src/heading-slug.ts
// resolver) and never post it to the host at all. Before this, EVERY href (including
// same-doc anchors) posted `open-link`, which asset-link-actions.ts's `same-doc-anchor`
// branch just no-op'd on (task 359's placeholder for this task). Real navigable hrefs
// (external/local/scheme) are untouched — tryScrollToSameDocAnchor returns false for them.
//
// Module-level (not a closure inside fixLinkClick) since task 457's activateLinkAtCaret — driven
// off the caret via Ctrl/Cmd+Enter, not a click — needs it too.
/** Route an explicit Open action through the same fragment-scroll and host wire as link clicks. */
export function openLinkUrl(url: string): boolean {
  const href = url.trim()
  if (!href) return false
  if (tryScrollToSameDocAnchor(href, window.vditor)) return true
  vscode.postMessage({ command: 'open-link', href })
  return true
}

function openLink(url: string) {
  openLinkUrl(url)
}
function openWikiLink(target: string) {
  vscode.postMessage({ command: 'open-wikilink', target })
}
function activateWikiLink(element: HTMLElement | null): boolean {
  if (!element?.dataset.wikiTarget) {
    return false
  }
  openWikiLink(element.dataset.wikiTarget)
  return true
}

// Task 457 — the URL for whatever link-like element the caret sits inside (caret-link.ts's
// LINK_LIKE_SELECTOR), for Ctrl/Cmd+Enter activation. A real `a[href]` (WYSIWYG, Preview) carries
// it as an attribute — rawHrefOf handles that. IR mode's `[text](url)` does NOT: Lute renders it as
// a flat `<span data-type="a" class="vditor-ir__node">` around separate marker spans, never a real
// editable `<a>` (an editable anchor would fight typing/DnD/hover) — verified via a Lute-in-Node
// probe (`Md2VditorIRDOM('[text](url)')` output, task 457): the display text is `.vditor-ir__link`,
// the raw url is TEXT in a sibling `.vditor-ir__marker--link`, not an attribute anywhere. So for
// that shape the url has to be read from the sibling marker's text.
function hrefForLinkLike(el: HTMLElement): string {
  if (el.matches('a[href]')) return rawHrefOf(el)
  const marker = el
    .closest('[data-type="a"]')
    ?.querySelector<HTMLElement>('.vditor-ir__marker--link')
  return marker?.textContent ?? ''
}

// Task 457 — activate the link-like element the CARET (not e.target) currently sits inside. One
// function, reused by BOTH triggers: the shared caret-gesture dispatcher's Ctrl/Cmd+Enter listener
// (registered below, via util/caret-gesture.ts — shared with editing/callout-popover-keys.ts's
// callout-focus handler since task 459) and the `activate-link-at-caret` host message
// (message-router.ts), posted by the `vmde.activateLinkAtCaret` VS Code command — registered
// separately (src/app/commands.ts) so the binding is also discoverable/rebindable in the Keyboard
// Shortcuts UI (decision 4 of task 457). Whichever trigger a real VS Code session actually resolves
// the chord through, both call this SAME function — never two activation paths. Returns whether it
// found+activated something, so a caller can preventDefault only then (an idle Ctrl+Enter away from
// any link is left alone, not swallowed).
export function activateLinkAtCaret(): boolean {
  const link = linkLikeInSelection(window.getSelection())
  if (!link) return false
  if (link.dataset.wikiLink === '1') return activateWikiLink(link)
  if (link.dataset.codeRef === '1') return openCodeRefFromElement(link)
  const href = hrefForLinkLike(link)
  if (!href) return false
  openLink(href)
  return true
}

// Remove `target` (a wiki chip, or the ZWSP/text boundary node next to one) and collapse the
// caret into an empty text node left in its place, then dispatch a synthetic `input` so Vditor's
// own input handler re-parses the block. Shared by the Delete/Backspace handler's two chip-removal
// paths below (task 502 — jscpd flagged the caret-inside and caret-adjacent branches carrying a
// byte-identical copy of this replace-and-reparse tail).
function replaceWithCaretAndReparse(
  target: Node,
  range: Range,
  sel: Selection,
): void {
  const parent = target.parentNode!
  const textNode = document.createTextNode('')
  parent.replaceChild(textNode, target)
  range.setStart(textNode, 0)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
  ;(parent as Element)
    .closest?.('[contenteditable]')
    ?.dispatchEvent(new Event('input', { bubbles: true }))
}

export function fixLinkClick() {
  // Real pointer activation must run before Vditor's IR click handler. Pointerdown/selectionchange
  // expands the link node before click, and Vditor refuses to open expanded nodes; synthetic click
  // tests never exercised that sequence. Rejected plain clicks keep propagating for native editing.
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target as HTMLElement | null
      const link = target?.closest<HTMLElement>('.vditor-ir [data-type="a"]')
      if (!link || !shouldOpenLink(event)) return
      const href = hrefForLinkLike(link)
      if (!href) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openLink(href)
    },
    true,
  )
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: routes clicks across wiki-link/regular-link × editable/read-only × modifier-key branches; pre-existing (task 469 baseline)
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null
    // Task 229 — same modifier policy as a real link (Ctrl/Cmd+click in editable content,
    // plain click in read-only Preview). Checked before the wiki-chip branch since the two
    // never overlap on the same element, but both must run before the generic `a[href]`
    // fallback below (a code-ref chip is never itself an anchor).
    const codeRefElement = target?.closest<HTMLElement>('[data-code-ref="1"]')
    if (codeRefElement) {
      const inEditable = !!codeRefElement.closest('[contenteditable]')
      if (!inEditable || shouldOpenLink(e)) {
        e.preventDefault()
        e.stopPropagation()
        openCodeRefFromElement(codeRefElement)
      }
      return
    }
    const wikiElement = target?.closest<HTMLElement>('[data-wiki-link="1"]')
    if (wikiElement) {
      // In editable areas (IR/wysiwyg contenteditable) the modifier policy
      // applies: plain click = edit (place caret), Ctrl/Cmd+click = navigate.
      // In read-only areas (preview, chrome) plain click navigates directly.
      const inEditable = !!wikiElement.closest('[contenteditable]')
      if (!inEditable || shouldOpenLink(e)) {
        e.preventDefault()
        e.stopPropagation()
        activateWikiLink(wikiElement)
      }
      // In editable mode with plain click: show [[…]] markers around the
      // chip (expand), but don't allow text editing. Click elsewhere collapses.
      if (inEditable) {
        e.preventDefault()
        e.stopPropagation()
        collapseExpandedWikiChips()
        wikiElement.classList.add('wiki-link-chip--expanded')
      }
      return
    }

    // Task 542: SV source uses flat syntax spans rather than <a href>. Resolve only Lute's exact
    // logical-link shape, then reuse the same live modifier policy and secure host opener as every
    // other content surface. A rejected plain click remains completely native caret placement.
    const svHref = target ? resolveSvSourceLink(target) : null
    if (svHref) {
      if (shouldOpenLink(e)) {
        e.preventDefault()
        e.stopPropagation()
        openLink(svHref)
      }
      return
    }

    collapseExpandedWikiChips()

    // Real <a href>. Always cancel the browser's own navigation (a webview anchor
    // must never navigate the panel), then route to the host. The modifier policy
    // (task 62) applies ONLY to links in the editor's document content
    // (WYSIWYG/SV/preview), where a plain click means "edit": there a plain click is
    // left for editing and only Ctrl/Cmd+click opens. Links in chrome — the
    // About/Info dialog and other tips, toolbar, panels — are not editable text, so
    // they open on a plain click. Wiki links above are unaffected.
    const linkElement = target?.closest<HTMLAnchorElement>('a[href]')
    if (linkElement) {
      const href = rawHrefOf(linkElement)
      if (href) {
        e.preventDefault()
        e.stopPropagation()
        if (!isEditorContentLink(linkElement) || shouldOpenLink(e)) {
          openLink(href)
        }
      }
    }
  })
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    // Task 229 — Enter/Space on a focused code-ref chip opens it unconditionally: a keyboard user
    // tabbed to the element SPECIFICALLY to activate it, unlike a mouse click which could be an
    // accidental caret placement (hence the click handler's modifier requirement in editable
    // content, which doesn't apply here). Wiki chips lost their OWN Enter/Space-on-focus branch
    // here (task 457): they lost `tabindex="0"`, so `target` can never resolve to one via keyboard
    // focus any more (Tab can't reach an in-document chip regardless — see caret-link.ts). They now
    // activate through Ctrl/Cmd+Enter on the CARET instead, below — not through focus at all.
    const codeRefElement = target?.closest<HTMLElement>('[data-code-ref="1"]')
    if (codeRefElement && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      e.stopPropagation()
      openCodeRefFromElement(codeRefElement)
    }
  })

  // Task 457/459 — Ctrl/Cmd+Enter activates the link-like element under the CARET (caret-link.ts's
  // LINK_LIKE_SELECTOR: wiki chip, code ref, plain `[text](url)`), the caret-targeted replacement
  // for Tab+Enter (Tab can never reach an in-document chip: `tab: '\t'` preventDefaults every Tab
  // in the editable surface). Registered against the SHARED dispatcher (util/caret-gesture.ts) —
  // task 459's callout-popover-keys.ts registers its own handler there too, both on the SAME
  // chord (the user rejected a second Ctrl+Alt+Enter chord, task 459). `linkLikeAt` is the match
  // (which element, if any, the caret is in); `activateLinkAtCaret` re-derives from the live
  // selection rather than trusting the matched element directly, so its existing standalone unit
  // tests (link-click-fix.test.ts) keep exercising the exact function both triggers call.
  registerCaretGesture(linkLikeAt, activateLinkAtCaret)

  // Delete/Backspace on wiki chips: contenteditable can't natively remove an
  // opaque inline <span> with one keystroke. Handle it ourselves: if the caret
  // is adjacent to a wiki chip (or inside one), remove the chip and leave the
  // caret in its place. Capture phase so we run before Vditor's input handler.
  document.addEventListener(
    'keydown',
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Backspace/Delete-adjacent-to-a-wiki-chip removal across the caret-position/chip-boundary branches; pre-existing (task 469 baseline)
    (e) => {
      if (guardComposition(e)) return
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return

      const range = sel.getRangeAt(0)
      const container = range.startContainer
      const offset = range.startOffset

      // Case 1: caret is INSIDE a wiki chip span
      const inside =
        (container as HTMLElement)?.closest?.('[data-wiki-link="1"]') ??
        container.parentElement?.closest?.('[data-wiki-link="1"]')
      if (inside) {
        e.preventDefault()
        e.stopPropagation()
        replaceWithCaretAndReparse(inside, range, sel)
        return
      }

      // Case 2: caret is right BEFORE a chip (Delete) or right AFTER (Backspace),
      // tolerating the zero-width space (U+200B) we render after each chip — the
      // caret typically sits in/after that ZWSP, so we skip ZWSP-only text nodes
      // (and ZWSP chars before the caret) when looking for the adjacent chip.
      const isChip = (n: Node | null): n is HTMLElement =>
        !!n &&
        n.nodeType === 1 &&
        (n as HTMLElement).matches?.('[data-wiki-link="1"]') === true
      const isZwspText = (n: Node | null): boolean =>
        !!n &&
        n.nodeType === 3 &&
        (n.textContent ?? '').replace(/\u200B/g, '') === ''

      let node: Node | null = null
      if (container.nodeType === 3) {
        const slice =
          e.key === 'Backspace'
            ? container.textContent!.slice(0, offset)
            : container.textContent!.slice(offset)
        // only proceed if there's no REAL text between the caret and the edge
        if (slice.replace(/\u200B/g, '') === '') {
          node =
            e.key === 'Backspace'
              ? container.previousSibling
              : container.nextSibling
        }
      } else if (container.nodeType === 1) {
        const el = container as HTMLElement
        node =
          e.key === 'Backspace'
            ? (el.childNodes[offset - 1] ?? null)
            : (el.childNodes[offset] ?? null)
      }
      // hop over any ZWSP-only text nodes between the caret and the chip
      const junk: Node[] = []
      while (isZwspText(node)) {
        junk.push(node as Node)
        node =
          e.key === 'Backspace'
            ? (node as Node).previousSibling
            : (node as Node).nextSibling
      }
      if (isChip(node)) {
        e.preventDefault()
        e.stopPropagation()
        for (const j of junk) j.parentNode?.removeChild(j)
        replaceWithCaretAndReparse(node, range, sel)
      }
    },
    true, // capture phase — before Vditor
  )
  // Widened to window.open's real signature (url?: string | URL, target?, features?) so this
  // override stays assignable under strictFunctionTypes. Vditor's only call site
  // (`window.open(markerText)`, see link-click.ts) always passes a string; the URL/undefined
  // branches are a defensive net for any other caller strictFunctionTypes now makes possible.
  window.open = (url?: string | URL, _target?: string, _features?: string) => {
    if (url) openLink(typeof url === 'string' ? url : url.toString())
    return window
  }
}
