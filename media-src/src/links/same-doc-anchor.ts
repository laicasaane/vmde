// Task 243 — same-document `#fragment` anchor links. Resolves against the shared slugger
// (src/heading-slug.ts, the host-tree cross-import — same shape as echarts-theme.ts's) and
// reuses the EXISTING scroll-to-heading mechanism (outline.ts's scrollToHeadingIndex) entirely
// in-process: no host round-trip, no new webview→host message. This is what
// asset-link-actions.ts's `same-doc-anchor` case used to no-op on — now the webview never
// posts that href to the host at all (see the call sites in link-click.ts / link-click-fix.ts),
// so that host branch stays a no-op for the (should-be-unreachable) case where it still is.
import type Vditor from 'vditor'
import { liveDocumentText } from '../util/document-text'
import { classifyHref } from '../../../src/shared/link-target'
import type { SlugifyMode } from '../../../src/shared/heading-slug'
import {
  type IdTarget,
  resolveFragmentTarget,
} from '../../../src/shared/id-target'
import {
  FLASH_CLASS,
  revealSourceLine,
  scrollToHeadingIndex,
} from '../nav/outline'
import { scrollBehavior } from '../util/reduced-motion'
import { activeModeElement } from '../util/source-map'

let slugifyMode: SlugifyMode = 'github'

// Mirrors link-open-policy.ts's applyLinkOpenSetting: called once at init (vditor-init.ts) and
// again on every live config change (message-router.ts's handleConfigChanged), so a settings
// edit takes effect without reopening the document.
export function applySlugifyModeSetting(mode: string | undefined): void {
  slugifyMode = mode === 'gitlab' ? 'gitlab' : 'github'
}

export function getSlugifyMode(): SlugifyMode {
  return slugifyMode
}

// The surface the user is looking at: the shown preview element (Preview and the Split preview
// pane), else the active edit-mode element. Searching only this root keeps ids of hidden mode
// panes and extension UI from matching a user value.
function visibleSurfaceRoot(vditor: Vditor): HTMLElement | null {
  const preview = (
    vditor as unknown as {
      vditor?: { preview?: { element?: HTMLElement } }
    }
  ).vditor?.preview?.element
  if (preview && preview.style.display === 'block') return preview
  return activeModeElement(vditor)
}

function renderedTargetElement(
  root: HTMLElement | null,
  target: IdTarget,
): HTMLElement | undefined {
  if (!root) return undefined
  const selector = target.attribute === 'id' ? '[id]' : 'a[name]'
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.getAttribute(target.attribute) === target.value,
  )
}

// If `href` is a bare `#fragment` (classifyHref's `same-doc-anchor` kind), resolve it against
// THIS document's own headings and scroll+flash — never posting anything to the host. Returns
// true when it handled the href at all (including "fragment didn't match any heading" — a
// same-doc anchor never falls through to open-link), false when `href` isn't a same-doc anchor,
// so the caller should proceed with its normal open-link routing.
export function tryScrollToSameDocAnchor(
  href: string,
  vditor: Vditor | undefined,
): boolean {
  const classified = classifyHref(href)
  if (classified.kind !== 'same-doc-anchor') return false
  if (!vditor || typeof vditor.getValue !== 'function') return true
  const markdown = liveDocumentText(vditor)
  const resolved = resolveFragmentTarget(
    markdown,
    classified.fragment,
    slugifyMode,
  )
  if (resolved?.kind === 'heading') {
    scrollToHeadingIndex(vditor, resolved.index)
    return true
  }
  if (resolved) {
    // Preview keeps real `id`/`name` elements, while edit modes keep HTML as source nodes. Prefer
    // the rendered element in the visible surface; otherwise reveal the owning source line.
    const rendered = renderedTargetElement(
      visibleSurfaceRoot(vditor),
      resolved.target,
    )
    const target = rendered?.closest<HTMLElement>('[data-block]') ?? rendered
    if (target) {
      target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
      target.classList.add(FLASH_CLASS)
      setTimeout(() => target.classList.remove(FLASH_CLASS), 1400)
    } else {
      revealSourceLine(vditor, resolved.target.line)
    }
  }
  return true
}
