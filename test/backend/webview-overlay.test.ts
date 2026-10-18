import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditorProvider } from '../../src/app/extension'
import { prewarmLute } from '../../src/lute/lute-host'
import {
  isLuteArtifactBuilt,
  waitForLuteWarm,
  warnLuteArtifactMissing,
} from './lute-artifact'
import { mock } from './vscode-mock'

// The instant-paint overlay branch of _getHtmlForWebview only fires when the host
// Lute is warm AND extensionPath points at a real install (so renderForMode can
// read media/vditor/dist/js/lute/lute.min.js). The default mock uses a fake
// '/ext', so the existing webview-html tests never exercise it — cover it here.
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// task 476: WASM boot cost is CPU-bound and scales with machine contention — give it a ceiling
// sized for a busy box, not an idle one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const LUTE_BUILT = isLuteArtifactBuilt(ROOT)
if (!LUTE_BUILT) {
  warnLuteArtifactMissing(
    '_getHtmlForWebview instant-paint overlay (host pre-render)',
    ROOT,
  )
}

function htmlFor(opts: { mode?: string; content?: string } = {}) {
  mock.setWorkspaceFolder('/workspace')
  const context = { ...mock.createExtensionContext(), extensionPath: ROOT }
  if (opts.mode) {
    // saved Vditor options carry the last mode; the host pre-renders in it
    context.globalState.update('vmde.options', { mode: opts.mode })
  }
  const document = mock.createTextDocument(
    '/workspace/note.md',
    opts.content ?? '# Hello\n\nA paragraph.\n',
  )
  const panel = mock.createWebviewPanel()
  // resolveCustomTextEditor is `async`, but for a conflict-free document (every test here) its
  // body completes synchronously before any `await` — the returned Promise resolves with no
  // observable async tail. `void` marks the discard deliberately (task 482, noFloatingPromises).
  void new MarkdownEditorProvider(context as any).resolveCustomTextEditor(
    document as any,
    panel as any,
  )
  return panel.webview.html
}

describe.skipIf(!LUTE_BUILT)(
  '_getHtmlForWebview instant-paint overlay (host pre-render)',
  () => {
    beforeAll(async () => {
      prewarmLute(ROOT)
      // Poll for real readiness instead of a fixed sleep (task 476 — see waitForLuteWarm).
      await waitForLuteWarm()
    })
    beforeEach(() => mock.reset())

    it('inlines an IR overlay for a small doc in the default mode', () => {
      const html = htmlFor()
      expect(html).toContain('id="vmde-prerender"')
      // mode-aware wrapper: IR
      expect(html).toMatch(/id="vmde-prerender"[\s\S]*?class="[^"]*vditor-ir/)
      // static toolbar placeholder + the pre-rendered heading content
      expect(html).toContain('vditor-toolbar')
      expect(html).toContain('Hello')
      // content-theme link so the overlay text colour matches the live editor
      expect(html).toMatch(/id="vditorContentTheme"/)
      // themed body so the overlay colours/layout match
      expect(html).toMatch(/data-use-vscode-theme-color="1"/)
    })

    it('sizes the placeholder for the wiki threshold by default and the no-wiki one when wiki is off (Task 661)', () => {
      // The default mock leaves vmde.wiki.enabled on and sets a workspace folder, so the document is a wiki file.
      expect(htmlFor()).toContain('min-width:1218px')
      mock.reset()
      mock.setConfig({ enabled: false })
      const off = htmlFor()
      expect(off).toContain('min-width:1151px')
      expect(off).not.toContain('min-width:1218px')
    })

    it('uses the WYSIWYG wrapper when the saved mode is wysiwyg', () => {
      const html = htmlFor({ mode: 'wysiwyg' })
      expect(html).toContain('id="vmde-prerender"')
      expect(html).toContain('vditor-wysiwyg')
      // the IR-only source marker must NOT appear in a WYSIWYG pre-render
      expect(html).not.toContain('vditor-ir__marker--heading')
    })

    it('skips the overlay for split (sv) mode', () => {
      const html = htmlFor({ mode: 'sv' })
      expect(html).not.toContain('vmde-prerender')
      // the editor still opens normally (mount point + bundle present)
      expect(html).toContain('<div id="app">')
    })

    it('pre-renders a truncated prefix for a document over the size cap', () => {
      // ~17 KB of clean blocks → over the 12 KB cap. The overlay shows the top of
      // the doc (instant paint) while the live editor loads the full document.
      let content = '# Big Doc\n\n'
      for (let i = 0; i < 800; i++)
        content += `## Section ${i}\n\nbody text.\n\n`
      const html = htmlFor({ content })
      expect(html).toContain('id="vmde-prerender"')
      expect(html).toContain('Big Doc') // top is painted
      expect(html).not.toContain('Section 799') // tail truncated
      expect(html).toContain('<div id="app">')
    })
  },
)
