// fix cannot find global
;(window as any).global = window.global || globalThis

// Task 370: hand every Lute instance to the whitespace-gap repair the moment Vditor creates it
// (our setLute build patch calls this global). It has to be installed before ANY Vditor is
// constructed — Vditor renders the initial value from initUI, before `options.after` — and this
// module is the one thing both main.ts and every e2e harness import first, so the editor and the
// harnesses cannot drift apart on it.
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { wrapLiveLineBreakIdentity } from '../editing/live-line-breaks'
import { wrapHtmlSubscriptLute } from '../editing/html-subscript'
;(window as any).__vmdePatchLute = (
  lute: Parameters<typeof patchLuteGapRepair>[0],
) => {
  patchLuteGapRepair(lute)
  wrapLiveLineBreakIdentity(
    lute as Parameters<typeof wrapLiveLineBreakIdentity>[0],
  )
  wrapHtmlSubscriptLute(lute as Parameters<typeof wrapHtmlSubscriptLute>[0])
}

// Task 470 — acquire the vscode postMessage handle here too, for the same "every real entry
// point imports this module first" reason as __vmdePatchLute above: main.ts and every e2e
// harness entry (media-src/e2e/*-harness.ts) already `import './preload'` (or './preload')
// as their first line, so this is the codebase's existing shared-bootstrap slot rather than a new
// pattern — a call repeated at 7 independent entry points would drift (as it already had:
// `raw-href.ts`'s comment on the OLD import-time side effect this replaced was worded differently
// from the others). vscode-api.ts itself stays free of import-time side effects (so a plain unit
// test can import it, or any module that merely re-exports its types, without a `window`-less
// crash) — initVsCodeApi() is idempotent (acquireVsCodeApi() throws if actually called twice per
// webview), so this one call covers every entry point without any of them having to remember it.
import { initVsCodeApi } from '../util/vscode-api'
initVsCodeApi()
