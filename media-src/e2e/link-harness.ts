import '../src/boot/preload'
// Import Vditor from SOURCE (not the 'vditor' dist entry) so our esbuild onLoad
// patches (fixIrLinkClick etc.) are applied — exactly what main.ts ships. The
// dist build is unpatched and would not exercise the real behaviour.
import Vditor from 'vditor/src/index'
import { openLinkFromMarker } from '../src/links/link-click'
import { fixLinkClick } from '../src/links/link-click-fix'
import {
  installLinkOpenGate,
  applyLinkOpenSetting,
} from '../src/links/link-open-policy'
import { captureRewrapSourceRange } from '../src/editing/rewrap-command'
import { installLinkPopover } from '../src/editing/link-popover'

// preload.ts's initVsCodeApi() call (task 470) picks up the spec's acquireVsCodeApi stub.
// Real Vditor with a single link, wired exactly as main.ts does (task 62). The
// edit mode is read from the URL (`?mode=ir|wysiwyg|sv`), and the link-open policy
// from `?policy=modifier|click` so one harness exercises every combination. Posts
// go to the recording stub (window.__posted) installed by the spec before this
// bundle runs.
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') as 'ir' | 'wysiwyg' | 'sv') || 'ir'
// Default policy (modifier) unless the spec asks for legacy plain-click opening.
applyLinkOpenSetting(params.get('policy') !== 'click')
installLinkOpenGate(window) // the gate the IR/WYSIWYG source patches call

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  height: 500,
  cdn: `${location.origin}/vditor`,
  value: 'Click [Example](https://example.com/page) here.\n',
  link: {
    click: (el: Element) =>
      openLinkFromMarker(el, (m) => (window as any).vscode.postMessage(m)),
  },
  // Vditor 3.11 calls this unconditionally while rendering the wysiwyg
  // toolbar; without it init throws (see main.ts).
  customWysiwygToolbar: () => {
    /* required stub — see comment above */
  },
  after() {
    ;(window as any).vditor = editor
    ;(window as any).vditorTest = editor
    ;(window as any).__captureRewrapSourceRange = (
      range: Range,
      exact: string,
    ) =>
      captureRewrapSourceRange(window, range, {
        authoritativeMarkdown: exact,
      })
    let applying = false
    installLinkPopover({
      snapshotExactMarkdown: () =>
        (window as any).__linkExactSource ?? editor.getValue(),
      setApplying: (value) => {
        applying = value
      },
      postExact: (markdown) => {
        // Match the real edit-sync: source writes are suppressed while our own
        // rendered mutation is protected by setApplying(true).
        if (applying) return
        ;(window as any).__postedLinkExact = markdown
        ;(window as any).__linkExactSource = markdown
      },
      onError: (error) => {
        ;(window as any).__linkPopoverError = String(error)
      },
    })
    // Mirror main.ts: the global link handler for real <a href> + window.open
    // override. This is what makes WYSIWYG/SV link clicks reach the host.
    fixLinkClick()
    // A link OUTSIDE the editor content, mimicking the About/Info dialog (Vditor
    // renders it in a `.vditor-tip`). The modifier policy must NOT gate it — a plain
    // click should open it. Lets the spec assert chrome links open on a plain click.
    const tip = document.createElement('div')
    tip.className = 'vditor-tip'
    tip.innerHTML =
      '<a id="dialog-link" href="https://dialog.example/info">info</a>'
    document.body.appendChild(tip)
    ;(window as any).__ready = true
  },
})
