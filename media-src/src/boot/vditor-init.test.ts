// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage-ratchet net (task 403 group 1) for the two pieces of vditor-init.ts that are
// separable from actually constructing a Vditor instance: renderCacheThemeKey (pure) and
// applyVditorTheme (a thin wrapper over setVditorTheme, gated on window.vditor). initVditor
// itself constructs a REAL `vditor/src/index` instance and is deliberately left to the
// real-VS-Code e2e suite (task 399's fast-tier run) — mocking Vditor's own construction for a
// unit test would test the mock, not the editor, the same reason editor-caret.ts/
// prerender-overlay.ts stay e2e-only.
const h = vi.hoisted(() => ({
  setVditorTheme: vi.fn(),
  // Task 651: constructed MockVditor instances (options + destroy spy) and the stream hooks.
  created: [] as Array<{ options: any; destroy: () => void }>,
  streamHooks: undefined as any,
  streamResult: undefined as (() => Promise<void>) | undefined,
  openInPreview: vi.fn(),
  previewShowing: vi.fn(() => false),
  // Task 661: the toolbar flow install and the overlay removal, for call-order checks.
  installToolbarFlow: vi.fn(),
  removePrerenderOverlay: vi.fn(),
  runFinishInit: vi.fn(),
  streamRenderSV: vi.fn(),
}))
vi.mock('./toolbar-flow-install', () => ({
  installToolbarFlow: h.installToolbarFlow,
}))
vi.mock('./vditor-theme', () => ({ setVditorTheme: h.setVditorTheme }))
// vditor-init.ts imports the SOURCE entry ('vditor/src/index', not the published dist), which
// pulls in Vditor's whole source tree including its .less assets (see vscode-api.ts's own
// comment on why it avoids this as a type root) — vitest's CSS pipeline has no `less`
// preprocessor installed and fails just importing the file. Stub it out entirely: nothing
// under test here calls `new Vditor(...)`.
vi.mock('vditor/src/index', () => ({
  default: class MockVditor {
    options: any
    destroy = vi.fn()
    constructor(_id: string, options: any) {
      this.options = options
      h.created.push(this)
    }
  },
}))
vi.mock('../chrome/open-preview', () => ({
  openInPreview: h.openInPreview,
  previewShowing: h.previewShowing,
}))
// stream-render.ts (only used by initVditor's streaming branch, not by the two functions under
// test) imports Vditor's INTERNAL ts files directly (`vditor/src/ts/ir/process`, `.../
// util/processCode`), bypassing the barrel above — those reference a `VDITOR_VERSION` global
// esbuild injects via `define` at build time (media-src/esbuild-shared.mjs) and vitest does not.
// Stub the whole module rather than chase every internal Vditor import transitively.
vi.mock('../diagrams/stream-render', () => ({
  streamRenderIR: vi.fn((_v: unknown, _c: string, hooks: unknown) => {
    h.streamHooks = hooks
    return h.streamResult ? h.streamResult() : Promise.resolve()
  }),
  streamRenderSV: h.streamRenderSV,
  STREAM_MIN_CHARS: 700_000,
}))
// Everything below is a collaborator of `initVditor` (the Vditor-construction/streaming
// lifecycle we deliberately do NOT unit test — see header) that the two functions under test
// never touch. Several transitively import Vditor's internal ts files the same way
// stream-render.ts does (toolbar icons, callout/link DOM patches, mermaid/echarts wiring,
// finish-init's ~12 observer modules) — mocked wholesale so loading this file doesn't drag in
// Vditor's whole source tree a second (third, fourth…) time.
vi.mock('../diagram-kit/d2-config', () => ({
  d2ConfigFromOptions: vi.fn(() => ({})),
  setD2Config: vi.fn(),
}))
vi.mock('../clipboard/upload-handler', () => ({ createUploadHandler: vi.fn() }))
vi.mock('../chrome/toolbar', () => ({ createToolbar: vi.fn(() => []) }))
vi.mock('../links/custom-renderer', () => ({ setupCustomRenderer: vi.fn() }))
vi.mock('../links/wiki-serialize', () => ({
  patchLuteSerialize: vi.fn(),
  setKnownPagesRef: vi.fn(),
}))
vi.mock('../bridge/edit-sync', () => ({ createEditSync: vi.fn() }))
vi.mock('./finish-init', () => ({ runFinishInit: h.runFinishInit }))
vi.mock('../chrome/prerender-overlay', () => ({
  bridgePrepaintScroll: vi.fn(),
  removePrerenderOverlay: h.removePrerenderOverlay,
  removeStreamSpinner: vi.fn(),
  showRealToolbarInOverlay: vi.fn(),
  showStreamSpinner: vi.fn(),
}))
vi.mock('../diagrams/render-cache-client', () => ({
  setRenderCacheConfig: vi.fn(),
}))
vi.mock('../diagrams/mermaid/mermaid-theme', () => ({
  applyMermaidTheme: vi.fn(),
  resolveMermaidInit: vi.fn(),
}))
vi.mock('../../../src/shared/echarts-theme', () => ({
  resolveEchartsTheme: vi.fn(),
}))
vi.mock('../diagrams/echarts-apply', () => ({
  applyEchartsTheme: vi.fn(),
  readVscodePalette: vi.fn(),
}))
vi.mock('../diagrams/flowchart-retheme', () => ({
  applyFlowchartLabelHalo: vi.fn(),
  flowchartDrawOptions: vi.fn(),
}))
vi.mock('../editing/callouts', () => ({ calloutWysiwygToolbar: vi.fn() }))
vi.mock('../links/link-click', () => ({ openLinkFromMarker: vi.fn() }))
vi.mock('../links/link-url', () => ({ applyPasteUrlSetting: vi.fn() }))
vi.mock('../bridge/edit-sync-tuning', () => ({
  undoDelayForContentLength: vi.fn(),
}))
vi.mock('../chrome/toolbar-actions', () => ({
  setPersistModeOverride: vi.fn(),
}))

import {
  applyVditorTheme,
  initVditor,
  renderCacheThemeKey,
  streamModeDecision,
} from './vditor-init'
import { sessionState } from './editor-session-state'

describe('renderCacheThemeKey', () => {
  // Task 408 — narrowed to the GLOBAL fragment only (mode/contentTheme/fontSize: everything that
  // changes EVERY engine's render output). Per-engine settings (mermaidTheme, d2Layout, …) used to
  // live here too, folded into one flat string shared by every engine's cache key — meaning a
  // single engine's setting change invalidated every OTHER engine's cached SVGs as a side effect.
  // They now feed render-cache-client's per-lang engineCacheKeyFragment instead (see
  // diagram-config-delta.test.ts + render-cache-client.test.ts's "per-engine cache-key fragment").
  it('folds mode/themeKind/contentTheme/fontSize into one pipe-joined key', () => {
    const key = renderCacheThemeKey({
      content: '',
      theme: 'dark',
      options: {
        contentTheme: 'github-dark',
        mermaidTheme: 'auto',
        mermaidLayout: 'elk',
        echartsTheme: 'auto',
        d2Layout: 'dagre',
        d2Theme: '0',
        d2Sketch: false,
        fontSize: '14px',
      },
    })
    expect(key).toBe('dark||github-dark|14px')
  })

  it('a non-dark theme normalises to "light"', () => {
    const key = renderCacheThemeKey({ content: '', theme: 'system' as any })
    expect(key.startsWith('light|')).toBe(true)
  })

  it('missing options fold to empty segments, not "undefined"', () => {
    const key = renderCacheThemeKey({ content: '', theme: 'light' })
    expect(key).toBe('light|||')
    expect(key).not.toContain('undefined')
  })

  it('separates high contrast from the ordinary cache key at the same mode', () => {
    const base = renderCacheThemeKey({
      content: '',
      theme: 'dark',
      themeKind: 'dark',
    })
    const highContrast = renderCacheThemeKey({
      content: '',
      theme: 'dark',
      themeKind: 'high-contrast',
    })
    expect(base).toBe('dark|dark||')
    expect(highContrast).toBe('dark|high-contrast||')
  })

  it('two payloads differing only in a PER-ENGINE option (d2Theme) produce the SAME global key', () => {
    // d2Theme is now d2's own configKeys concern (render-cache-client's engineCacheKeyFragment),
    // not part of the global themeKey — so it must NOT move this key at all any more.
    const base = {
      content: '',
      theme: 'dark' as const,
      options: { d2Theme: '0' },
    }
    const changed = { ...base, options: { d2Theme: '1' } }
    expect(renderCacheThemeKey(base)).toBe(renderCacheThemeKey(changed))
  })

  it('two payloads differing in a GLOBAL option (contentTheme) produce different keys', () => {
    const base = {
      content: '',
      theme: 'dark' as const,
      options: { contentTheme: 'auto' },
    }
    const changed = { ...base, options: { contentTheme: 'github-dark' } }
    expect(renderCacheThemeKey(base)).not.toBe(renderCacheThemeKey(changed))
  })
})

describe('streamModeDecision', () => {
  it('streams persisted SV directly without session forcing', () => {
    expect(streamModeDecision(true, 'sv')).toEqual({
      streamInSV: true,
      forceToIR: false,
    })
  })

  it('keeps IR direct and session-forces only WYSIWYG', () => {
    expect(streamModeDecision(true, 'ir')).toEqual({
      streamInSV: false,
      forceToIR: false,
    })
    expect(streamModeDecision(true, 'wysiwyg')).toEqual({
      streamInSV: false,
      forceToIR: true,
    })
    expect(streamModeDecision(false, 'wysiwyg')).toEqual({
      streamInSV: false,
      forceToIR: false,
    })
  })
})

describe('applyVditorTheme', () => {
  beforeEach(() => {
    sessionState.lastInitMsg = null
    h.setVditorTheme.mockClear()
  })
  afterEach(() => {
    ;(window as any).vditor = undefined
  })

  it('no-ops when there is no live Vditor instance yet', () => {
    ;(window as any).vditor = undefined
    applyVditorTheme('dark')
    expect(h.setVditorTheme).not.toHaveBeenCalled()
  })

  it('applies the theme through setVditorTheme, reading code style + cdn from sessionState', () => {
    const vd = {}
    ;(window as any).vditor = vd
    sessionState.lastInitMsg = {
      content: '',
      cdn: 'https://cdn.example/vditor',
      options: { codeTheme: 'monokai' },
    }
    applyVditorTheme('dark')
    expect(h.setVditorTheme).toHaveBeenCalledTimes(1)
    expect(h.setVditorTheme).toHaveBeenCalledWith(
      vd,
      'dark',
      'monokai',
      'https://cdn.example/vditor',
    )
  })

  it('falls back to no cdn / no explicit code style when lastInitMsg is unset', () => {
    ;(window as any).vditor = {}
    applyVditorTheme('light')
    expect(h.setVditorTheme).toHaveBeenCalledTimes(1)
    const [, mode, , cdn] = h.setVditorTheme.mock.calls[0]
    expect(mode).toBe('light')
    expect(cdn).toBeUndefined()
  })
})

// Task 651 — which init paths open the Preview overlay. initVditor builds a real Vditor in
// production; here a recording stand-in captures the constructor options so `after()` (the
// mount hook that owns the open decision) can be driven directly.
describe('initVditor Preview open', () => {
  const SMALL = '# small'
  const HUGE = 'x'.repeat(700_001)

  function init(options: Record<string, unknown>, content = SMALL) {
    initVditor({ content, theme: 'dark', options } as never)
    const created = h.created[h.created.length - 1]
    created.options.after()
    return created
  }

  beforeEach(() => {
    h.created.length = 0
    h.streamHooks = undefined
    h.streamResult = undefined
    h.openInPreview.mockClear()
    h.previewShowing.mockReset()
    h.previewShowing.mockReturnValue(false)
    ;(window as any).vditor = undefined
  })

  it('opens Preview after a small-document init when it was left on (acceptance 2)', () => {
    init({ openInPreview: true })
    expect(h.openInPreview).toHaveBeenCalledTimes(1)
  })

  it('does not open Preview without the flag', () => {
    init({})
    expect(h.openInPreview).not.toHaveBeenCalled()
  })

  it('an explicit preview rule still opens Preview on a small document, unchanged', () => {
    init({ defaultMode: 'preview' })
    expect(h.openInPreview).toHaveBeenCalledTimes(1)
  })

  it('a streamed document opens Preview after stream onDone, not before (acceptance 6)', () => {
    init({ openInPreview: true }, HUGE)
    expect(h.streamHooks).toBeDefined()
    expect(h.openInPreview).not.toHaveBeenCalled()
    h.streamHooks.onDone()
    expect(h.openInPreview).toHaveBeenCalledTimes(1)
  })

  it('a streamed document without the flag never opens Preview', () => {
    init({}, HUGE)
    h.streamHooks.onDone()
    expect(h.openInPreview).not.toHaveBeenCalled()
  })

  it('a preview rule on a streamed document keeps opening editable (282 behaviour)', () => {
    init({ defaultMode: 'preview' }, HUGE)
    h.streamHooks.onDone()
    expect(h.openInPreview).not.toHaveBeenCalled()
  })

  it('does not open Preview when the stream fails', async () => {
    h.streamResult = () => Promise.reject(new Error('stream failed'))
    const created = (() => {
      initVditor({
        content: HUGE,
        theme: 'dark',
        options: { openInPreview: true },
      } as never)
      const c = h.created[h.created.length - 1]
      ;(window as any).vditor = Object.assign(c, { setValue: vi.fn() })
      c.options.after()
      return c
    })()
    expect(created).toBeDefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.openInPreview).not.toHaveBeenCalled()
  })

  it('re-init with the flag absent while showing Preview reopens it', () => {
    const first = init({})
    h.openInPreview.mockClear()
    h.previewShowing.mockReturnValue(true)
    ;(window as any).vditor = first
    init({})
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(h.openInPreview).toHaveBeenCalledTimes(1)
  })

  it('re-init with the flag on while not showing Preview stays off', () => {
    const first = init({ openInPreview: true })
    h.openInPreview.mockClear()
    h.previewShowing.mockReturnValue(false)
    ;(window as any).vditor = first
    init({ openInPreview: true })
    expect(h.openInPreview).not.toHaveBeenCalled()
  })
})

// Task 661 — the toolbar rows and flow are installed in the same task as the toolbar, before a
// streamed open removes its overlay, so the first live frame is already flowed.
describe('initVditor streaming toolbar flow', () => {
  const HUGE = 'x'.repeat(700_001)

  function init(options: Record<string, unknown>, content: string) {
    initVditor({ content, theme: 'dark', options } as never)
    const created = h.created[h.created.length - 1]
    ;(window as any).vditor = Object.assign(created, { setValue: vi.fn() })
    created.options.after()
    return created
  }

  beforeEach(() => {
    h.created.length = 0
    h.streamHooks = undefined
    h.streamResult = undefined
    h.installToolbarFlow.mockClear()
    h.removePrerenderOverlay.mockClear()
    h.runFinishInit.mockClear()
    h.streamRenderSV.mockReset()
    ;(window as any).vditor = undefined
  })

  it('(a) a streamed IR open flows the toolbar before any chunk and before the overlay goes', () => {
    init({}, HUGE)
    expect(h.installToolbarFlow).toHaveBeenCalledTimes(1)
    expect(h.runFinishInit).not.toHaveBeenCalled()
    h.streamHooks.onFirstChunk()
    expect(h.removePrerenderOverlay).toHaveBeenCalledTimes(1)
    expect(h.installToolbarFlow.mock.invocationCallOrder[0]).toBeLessThan(
      h.removePrerenderOverlay.mock.invocationCallOrder[0],
    )
  })

  it('(b) a streamed SV open flows the toolbar before the stream starts', () => {
    h.streamRenderSV.mockImplementation(
      (_v: unknown, _c: string, hooks: any) => {
        h.streamHooks = hooks
        return Promise.resolve()
      },
    )
    init({ mode: 'sv' }, HUGE)
    expect(h.streamRenderSV).toHaveBeenCalledTimes(1)
    expect(h.installToolbarFlow).toHaveBeenCalledTimes(1)
    expect(h.installToolbarFlow.mock.invocationCallOrder[0]).toBeLessThan(
      h.streamRenderSV.mock.invocationCallOrder[0],
    )
    h.streamHooks.onFirstChunk()
    expect(h.installToolbarFlow.mock.invocationCallOrder[0]).toBeLessThan(
      h.removePrerenderOverlay.mock.invocationCallOrder[0],
    )
  })

  it('(c) a failed stream installs the flow exactly once', async () => {
    h.streamResult = () => Promise.reject(new Error('stream failed'))
    init({}, HUGE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.installToolbarFlow).toHaveBeenCalledTimes(1)
  })

  it('(d) a small document leaves the flow install to runFinishInit', () => {
    init({}, '# small')
    expect(h.installToolbarFlow).not.toHaveBeenCalled()
  })
})
