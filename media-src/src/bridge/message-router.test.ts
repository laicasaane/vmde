// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Coverage-ratchet net (task 403 group 1) for the host->webview dispatch task 399 extracted
// from main.ts. Mirrors task 151's pattern (dispatch on a known command; log + no-op on an
// unhandled one) plus the highest-risk branches of handleUpdate — the echo-guard (task 38),
// the init-failure retry (task 151 item 3), and the external-update path (caret/scroll
// preservation + cache invalidation, #1912). Heavy collaborators (Vditor construction,
// diagram re-theme, live-config, the DOM caret/diff helpers) are mocked; the routing/dispatch
// logic and handleUpdate's own control flow are real.
const h = vi.hoisted(() => ({
  initVditor: vi.fn(),
  renderCacheThemeKey: vi.fn(() => 'KEY'),
  reportError: vi.fn(),
  logToHost: vi.fn(),
  saveVditorOptions: vi.fn(),
  applyBodyOptions: vi.fn(),
  applyPreviewReflowSetting: vi.fn(),
  effectivePreviewReflow: vi.fn(
    (options: { autoWrap?: boolean; reflowLineBreaks?: boolean } | undefined) =>
      options?.reflowLineBreaks === true,
  ),
  swapStyle: vi.fn(),
  initOnlyChanged: vi.fn(() => false),
  setD2Config: vi.fn(),
  setRenderCacheConfig: vi.fn(),
  applyCacheHits: vi.fn(),
  rethemeDiagrams: vi.fn(),
  applyLinkOpenSetting: vi.fn(),
  applyPasteUrlSetting: vi.fn(),
  renderDiffMarkers: vi.fn(),
  clearDiffMarkers: vi.fn(),
  preserveCaretAndScroll: vi.fn((_v: unknown, mutate: () => void) => mutate()),
  restoreEditorCaretIfLost: vi.fn(),
  getCursorSourceOffset: vi.fn(() => -1),
  // Explicit return-type annotation, not just `() => null` — the real activeModeElement returns
  // `HTMLElement | null`; without the annotation `vi.fn` infers the mock's type from the literal
  // `null`, so a later `mockReturnValue(someElement)` (see the "task 468" describe block below)
  // fails to type-check even though it matches the real function perfectly.
  activeModeElement: vi.fn((): HTMLElement | null => null),
  blockIndexForSourceLine: vi.fn((): number | null => 1),
  sourceLineForReveal: vi.fn((): number | null => 2),
  lineAndTextForOffset: vi.fn(() => ({ line: -1, lineText: '' })),
  markRouterReady: vi.fn(),
  beginE2EActivity: vi.fn(() => vi.fn()),
  markE2EError: vi.fn(),
  openFindReplace: vi.fn(),
  toggleFoldAtCaret: vi.fn(),
  ensureFoldTargetVisible: vi.fn(),
  runRewrap: vi.fn(),
  shiftHeadingLevel: vi.fn(),
  prepareRewrapDocument: vi.fn(),
  runRewrapDocument: vi.fn(),
  runOutlineSectionMove: vi.fn(),
  prepareOutlineSectionMove: vi.fn(),
  finishOutlineSectionMove: vi.fn(),
  applyAutoWrapConfig: vi.fn(),
  cancelAutoWrap: vi.fn(),
  invalidateEmojiInsertion: vi.fn(),
}))
// Task 460 phase 3: message-router no longer imports vditor-init/live-config as VALUES (they're
// injected via configureMessageRouter, called in beforeEach below) — vi.mock-ing those module
// specifiers here would silently do nothing (nothing imports them at runtime to intercept).
vi.mock('../util/webview-log', () => ({
  reportError: h.reportError,
  logToHost: h.logToHost,
}))
vi.mock('../chrome/toolbar-actions', () => ({
  saveVditorOptions: h.saveVditorOptions,
}))
// d2ConfigFromOptions is the real one (a pure projection): mocking it away would hide whether the
// router still forwards every D2/geo option, which is exactly what the shared helper is for.
vi.mock('../diagram-kit/d2-config', async (orig) => ({
  ...(await orig<typeof import('../diagram-kit/d2-config')>()),
  setD2Config: h.setD2Config,
}))
vi.mock('../diagrams/render-cache-client', () => ({
  setRenderCacheConfig: h.setRenderCacheConfig,
  applyCacheHits: h.applyCacheHits,
}))
vi.mock('../diagrams/diagram-retheme', () => ({
  rethemeDiagrams: h.rethemeDiagrams,
}))
vi.mock('../links/link-open-policy', () => ({
  applyLinkOpenSetting: h.applyLinkOpenSetting,
}))
vi.mock('../links/link-url', () => ({
  applyPasteUrlSetting: h.applyPasteUrlSetting,
}))
vi.mock('../chrome/diff-markers', () => ({
  renderDiffMarkers: h.renderDiffMarkers,
  clearDiffMarkers: h.clearDiffMarkers,
}))
vi.mock('../editing/caret-preserve', () => ({
  preserveCaretAndScroll: h.preserveCaretAndScroll,
}))
vi.mock('../editing/editor-caret', () => ({
  restoreEditorCaretIfLost: h.restoreEditorCaretIfLost,
}))
vi.mock('../util/source-map', () => ({
  HOIST_HIDDEN_ATTR: 'data-vmde-hoist-hidden',
  HOIST_OUTLINE_HIDDEN_ATTR: 'data-vmde-hoist-outline-hidden',
  HOIST_SCOPE_CHANGE_EVENT: 'vmde-section-scope-change',
  getCursorSourceOffset: h.getCursorSourceOffset,
  activeModeElement: h.activeModeElement,
  blockIndexForSourceLine: h.blockIndexForSourceLine,
  sourceLineForReveal: h.sourceLineForReveal,
  lineAndTextForOffset: h.lineAndTextForOffset,
}))
vi.mock('../testing/e2e-readiness', () => ({
  beginE2EActivity: h.beginE2EActivity,
  markE2EError: h.markE2EError,
  markRouterReady: h.markRouterReady,
}))
vi.mock('../editing/selection-scope', () => ({
  openFindReplace: h.openFindReplace,
}))
vi.mock('../editing/emoji-insertion', () => ({
  invalidateEmojiInsertion: h.invalidateEmojiInsertion,
}))
vi.mock('../nav/section-fold', () => ({
  ensureFoldTargetVisible: h.ensureFoldTargetVisible,
  toggleFoldAtCaret: h.toggleFoldAtCaret,
}))
vi.mock('../nav/reading-position', () => ({
  noteExplicitReadingPositionReveal: vi.fn(),
}))

import {
  configureMessageRouter,
  handleUpdate,
  installMessageRouter,
  markInlineInited,
} from './message-router'
import { sessionState } from '../boot/editor-session-state'
import type { InitPayload } from '../boot/init-payload'
import { installScreenReaderSemantics } from '../util/screen-reader'

function boot() {
  const post = vi.fn()
  ;(globalThis as unknown as { vscode: unknown }).vscode = {
    postMessage: post,
  }
  return { post }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionState.lastInitMsg = null
  sessionState.applyingExtensionUpdate = false
  sessionState.streaming = false
  sessionState.editSync = null
  ;(window as any).vditor = undefined
  // Task 460 phase 3: message-router reads these off injected deps, not direct imports — wire
  // the same h.* mocks + the real sessionState object in before every test (mirrors what
  // main.ts's composition root does at real startup).
  configureMessageRouter({
    applyBodyOptions: h.applyBodyOptions,
    applyPreviewReflowSetting: h.applyPreviewReflowSetting,
    effectivePreviewReflow: h.effectivePreviewReflow,
    swapStyle: h.swapStyle,
    initOnlyChanged: h.initOnlyChanged,
    sessionState,
    initVditor: h.initVditor,
    renderCacheThemeKey: h.renderCacheThemeKey,
    runRewrap: h.runRewrap,
    shiftHeadingLevel: h.shiftHeadingLevel,
    prepareRewrapDocument: h.prepareRewrapDocument,
    runRewrapDocument: h.runRewrapDocument,
    runOutlineSectionMove: h.runOutlineSectionMove,
    prepareOutlineSectionMove: h.prepareOutlineSectionMove,
    finishOutlineSectionMove: h.finishOutlineSectionMove,
    applyAutoWrapConfig: h.applyAutoWrapConfig,
    cancelAutoWrap: h.cancelAutoWrap,
  })
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).__vmdeRequestCaret
})

describe('installMessageRouter — routing', () => {
  it('routes host announcements through the single polite live region', async () => {
    document.body.innerHTML = ''
    installScreenReaderSemantics('router.md')
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'announce', message: 'Saved router.md' },
      }),
    )
    await Promise.resolve()
    expect(document.getElementById('vmde-live-region')?.textContent).toBe(
      'Saved router.md',
    )
  })

  it('dispatches a known command to its handler', () => {
    installMessageRouter(window)
    expect(h.markRouterReady).toHaveBeenCalledOnce()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'reload-css', id: 'foo', css: '.x{}' },
      }),
    )
    expect(h.swapStyle).toHaveBeenCalledWith('foo', '.x{}')
  })

  it('routes the manual rewrap command through the injected editor action', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'rewrap-selection' },
      }),
    )
    expect(h.runRewrap).toHaveBeenCalled()
  })

  it('routes a heading level command through the injected editor action', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'shift-heading-level',
          direction: -1,
          section: true,
        },
      }),
    )
    expect(h.shiftHeadingLevel).toHaveBeenCalledWith(-1, true)
  })

  it('routes the host find/replace command to the installed widget', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'open-find-replace' },
      }),
    )
    expect(h.openFindReplace).toHaveBeenCalled()
  })

  it('routes the host fold command to the caret controller', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'toggle-section-fold' },
      }),
    )
    expect(h.toggleFoldAtCaret).toHaveBeenCalled()
  })

  it('routes the document rewrap command through its injected editor action', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'rewrap-document', content: 'alpha beta gamma' },
      }),
    )
    expect(h.runRewrapDocument).toHaveBeenCalledWith('alpha beta gamma')
    expect(h.runRewrap).not.toHaveBeenCalled()
  })

  it('routes document preparation through exact live-edit synchronization', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'prepare-rewrap-document' },
      }),
    )
    expect(h.prepareRewrapDocument).toHaveBeenCalled()
    expect(h.runRewrapDocument).not.toHaveBeenCalled()
  })

  it('logs and no-ops on an unhandled command instead of throwing', () => {
    installMessageRouter(window)
    expect(() =>
      window.dispatchEvent(
        new MessageEvent('message', { data: { command: 'not-a-real-one' } }),
      ),
    ).not.toThrow()
    expect(h.logToHost).toHaveBeenCalledWith(
      expect.stringContaining('not-a-real-one'),
    )
  })

  it('ignores a message with no string command (e.g. a foreign postMessage)', () => {
    installMessageRouter(window)
    expect(() =>
      window.dispatchEvent(new MessageEvent('message', { data: {} })),
    ).not.toThrow()
    expect(h.logToHost).not.toHaveBeenCalled()
  })
})

// Task 148 item 3 (second half): a known command with a MISSING or WRONG-TYPE required field used
// to reach its handler as-is — TypeScript's HostMessage union only checks internal callers, not
// what actually arrives on the wire, so a malformed/drifted message became a runtime shape error
// INSIDE the handler instead of a rejection at the dispatch seam. Lightweight discriminant +
// required-field check, routed to the SAME logToHost the unhandled-command branch already uses
// (never throws) — deliberately no schema library for a same-process seam.
describe('installMessageRouter — payload shape validation (task 148 item 3)', () => {
  it('drops a known command missing a required field instead of calling its handler', () => {
    installMessageRouter(window)
    // reload-css requires both `id` and `css` (handleReloadCss calls swapStyle(msg.id, msg.css));
    // `css` is missing here.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'reload-css', id: 'foo' },
      }),
    )
    expect(h.swapStyle).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      expect.stringContaining('reload-css'),
    )
  })

  it('drops a known command whose required field has the wrong type', () => {
    installMessageRouter(window)
    // set-theme's `theme` must be a string; handleSetTheme forwards it into rethemeDiagrams.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'set-theme', theme: 42 },
      }),
    )
    expect(h.rethemeDiagrams).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      expect.stringContaining('set-theme'),
    )
  })

  it('validates boolean fields before dispatch', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'shift-heading-level',
          direction: 1,
          section: 'yes',
        },
      }),
    )
    expect(h.shiftHeadingLevel).not.toHaveBeenCalled()
    expect(h.logToHost).toHaveBeenCalledWith(
      expect.stringContaining('shift-heading-level'),
    )
  })

  it('still dispatches a valid message with every required field present and correctly typed', () => {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'reload-css', id: 'foo', css: '.x{}' },
        // A realistic trusted origin — a bare jsdom MessageEvent defaults `origin` to `""`, which
        // would (correctly) trip the UNRELATED origin-mismatch warning (task 148 item 3) and
        // break this test's "no logging at all" assertion for a reason that has nothing to do
        // with what this test checks (shape validation). See the dedicated origin-check describe
        // block below for that behaviour.
        origin: 'vscode-webview://test-instance',
      }),
    )
    expect(h.swapStyle).toHaveBeenCalledWith('foo', '.x{}')
    expect(h.logToHost).not.toHaveBeenCalled()
  })

  it('does not shape-check a command with no required fields (e.g. nothing to validate)', () => {
    installMessageRouter(window)
    // uploaded requires `files` to be an array; an empty array is a VALID array, not a missing field.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'uploaded', files: [] },
        origin: 'vscode-webview://test-instance', // see comment above
      }),
    )
    expect(h.logToHost).not.toHaveBeenCalled()
  })
})

// Task 148 item 3 (origin check — WARN-ONLY). Uses a fresh `EventTarget` per test instead of the
// shared jsdom `window` other describe blocks in this file use: `installMessageRouter` attaches a
// NEW listener each call and nothing in this file ever removes old ones, so listeners accumulate
// on `window` across the whole test file's run. That's harmless for tests that only check "was
// the handler called with X", but these tests check EXACT call counts (rate-limiting semantics),
// which stale listeners from earlier tests would silently inflate. `installMessageRouter`'s
// parameter only needs `addEventListener`/the shape a `MessageEvent` handler expects — a plain
// `EventTarget` satisfies that with zero cross-test interference.
describe('installMessageRouter — origin check (task 148 item 3, warn-only)', () => {
  function freshTarget() {
    return new EventTarget() as unknown as Window
  }

  it('warns once (not per-message) when messages arrive with an unexpected origin, but still dispatches every one', () => {
    const target = freshTarget()
    installMessageRouter(target)
    for (let i = 0; i < 3; i++) {
      target.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'reload-css', id: `f${i}`, css: '.x{}' },
          origin: 'https://evil.example.com',
        }),
      )
    }
    expect(h.swapStyle).toHaveBeenCalledTimes(3)
    const originWarnings = h.logToHost.mock.calls.filter(
      // (args: unknown[]), not a [string] tuple: `.calls`'s any[] element type fails a
      // fixed-length-tuple param check under strictFunctionTypes ("may have fewer" elements).
      (args: unknown[]) =>
        (args[0] as string).includes('unexpected message origin'),
    )
    expect(originWarnings).toHaveLength(1)
    expect(originWarnings[0][0]).toContain('https://evil.example.com')
  })

  it('does not warn when the origin matches vscode-webview://', () => {
    const target = freshTarget()
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'reload-css', id: 'foo', css: '.x{}' },
        origin: 'vscode-webview://some-per-launch-random-token',
      }),
    )
    expect(h.swapStyle).toHaveBeenCalledWith('foo', '.x{}')
    expect(
      h.logToHost.mock.calls.some((args: unknown[]) =>
        (args[0] as string).includes('unexpected message origin'),
      ),
    ).toBe(false)
  })

  it('never blocks dispatch, even for an unexpected origin — warn-only means warn-only', () => {
    const target = freshTarget()
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        // A browser-hosted VS Code (Codespaces) origin shape — plausible per package.json's
        // declared `virtualWorkspaces: "limited"` support, not something this repo can launch to
        // confirm the exact string, which is exactly why this must never become a drop.
        data: { command: 'reload-css', id: 'bar', css: '.y{}' },
        origin: 'https://abc123.vscode-cdn.net',
      }),
    )
    expect(h.swapStyle).toHaveBeenCalledWith('bar', '.y{}')
  })
})

describe('handleUpdate — init', () => {
  it('a fresh init clears stale diff markers and calls initVditor', () => {
    handleUpdate({
      command: 'update',
      type: 'init',
      content: 'doc',
    } as any)
    expect(h.clearDiffMarkers).toHaveBeenCalledTimes(1)
    expect(h.applyBodyOptions).toHaveBeenCalled()
    expect(h.applyPreviewReflowSetting).toHaveBeenCalledWith(false)
    expect(h.initVditor).toHaveBeenCalledTimes(1)
    expect(h.initVditor).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'init', content: 'doc' }),
    )
  })

  it('task 38: an init echo matching the inline-inited content is skipped once, then re-armed', () => {
    markInlineInited('same-content')
    handleUpdate({
      command: 'update',
      type: 'init',
      content: 'same-content',
    } as any)
    expect(h.initVditor).not.toHaveBeenCalled()
    expect(h.invalidateEmojiInsertion).toHaveBeenCalledTimes(1)

    // The guard is one-shot: a SECOND init with the same content is a real re-init, not an echo.
    handleUpdate({
      command: 'update',
      type: 'init',
      content: 'same-content',
    } as any)
    expect(h.initVditor).toHaveBeenCalledTimes(1)
  })

  it('a failed init is reported and retried with content only, then re-saves options', () => {
    h.initVditor.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    handleUpdate({
      command: 'update',
      type: 'init',
      content: 'doc',
      options: { codeTheme: 'x' },
    } as any)
    expect(h.reportError).toHaveBeenCalledTimes(1)
    expect(h.initVditor).toHaveBeenCalledTimes(2)
    expect(h.initVditor).toHaveBeenLastCalledWith({ content: 'doc' })
    expect(h.saveVditorOptions).toHaveBeenCalledTimes(1)
  })
})

describe('handleUpdate — external update (non-init)', () => {
  it('while streaming, a differing update is ignored (no diff/setValue against a partial doc)', () => {
    sessionState.streaming = true
    ;(window as any).vditor = { getValue: () => 'OLD' }
    handleUpdate({ command: 'update', content: 'NEW' } as any)
    expect(h.preserveCaretAndScroll).not.toHaveBeenCalled()
    expect(h.cancelAutoWrap).not.toHaveBeenCalled()
  })

  it('an external update rewrites the doc and atomically reseeds the cache', () => {
    vi.useFakeTimers()
    const setValue = vi.fn()
    const reseed = vi.fn()
    const reportDocMode = vi.fn()
    sessionState.editSync = { reseed, reportDocMode } as any
    ;(window as any).vditor = { getValue: () => 'OLD', setValue }
    const incrementalSeed = { markdown: 'CANONICAL' }
    handleUpdate({ command: 'update', content: 'NEW', incrementalSeed } as any)

    expect(sessionState.applyingExtensionUpdate).toBe(true)
    expect(h.preserveCaretAndScroll).toHaveBeenCalledTimes(1)
    expect(h.cancelAutoWrap).toHaveBeenCalledTimes(1)
    expect(setValue).toHaveBeenCalledWith('NEW', true)
    expect(reseed).toHaveBeenCalledWith(incrementalSeed, 'NEW')
    expect(reportDocMode).toHaveBeenCalledTimes(1)

    vi.runAllTimers()
    expect(sessionState.applyingExtensionUpdate).toBe(false)
  })

  it('a no-op update (content already matches) touches nothing', () => {
    ;(window as any).vditor = { getValue: () => 'SAME' }
    handleUpdate({ command: 'update', content: 'SAME' } as any)
    expect(h.preserveCaretAndScroll).not.toHaveBeenCalled()
    expect(h.cancelAutoWrap).not.toHaveBeenCalled()
  })
})

describe('handleGetCursorOffset', () => {
  it('always replies, even with no live editor (line -1, so the host round-trip never hangs)', () => {
    const { post } = boot()
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'get-cursor-offset', requestId: 'r1' },
      }),
    )
    expect(post).toHaveBeenCalledWith({
      command: 'cursor-offset',
      requestId: 'r1',
      line: -1,
      lineText: '',
    })
  })
})

// Task 408 — handleConfigChanged currently hand-computes 8 `xxxChanged` booleans by comparing
// sessionState.lastInitMsg.options against msg.options field-by-field, then calls rethemeDiagrams
// with them OR'd against contentThemeChanged. This PINS that exact dispatch behavior BEFORE the
// rewrite (replacing the hand-written comparisons with diagramConfigDelta + rethemeFlagsFor) so
// the refactor is provably behavior-preserving — every case here must still pass unchanged after.
describe('handleConfigChanged — rethemeDiagrams dispatch (task 408 pin)', () => {
  function initWith(options: Record<string, unknown>) {
    sessionState.lastInitMsg = {
      content: '',
      theme: 'light',
      options,
    } as unknown as InitPayload
    ;(window as any).vditor = {}
  }
  function dispatchConfigChanged(options: Record<string, unknown>) {
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'config-changed', options },
      }),
    )
  }

  it('applies preview reflow live without remounting Vditor', () => {
    initWith({ reflowLineBreaks: false })
    dispatchConfigChanged({ reflowLineBreaks: true })

    expect(h.applyPreviewReflowSetting).toHaveBeenCalledWith(true)
    expect(h.initVditor).not.toHaveBeenCalled()
  })

  it('a lone d2Layout change flips ONLY d2', () => {
    initWith({ contentTheme: 'auto', d2Layout: 'dagre' })
    dispatchConfigChanged({ contentTheme: 'auto', d2Layout: 'elk' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: false,
        mermaid: false,
        echarts: false,
        smiles: false,
        flowchart: false,
        vega: false,
        monoGroup: false,
        geo: false,
        d2: true,
      }),
    )
  })

  it('a lone mermaidLayout change flips ONLY mermaid', () => {
    initWith({ contentTheme: 'auto', mermaidLayout: 'dagre' })
    dispatchConfigChanged({ contentTheme: 'auto', mermaidLayout: 'elk' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: false,
        mermaid: true,
        echarts: false,
        smiles: false,
        flowchart: false,
        vega: false,
        monoGroup: false,
        geo: false,
        d2: false,
      }),
    )
  })

  it('a lone geoBasemap change flips ONLY geo', () => {
    initWith({ contentTheme: 'auto', geoBasemap: 'auto' })
    dispatchConfigChanged({ contentTheme: 'auto', geoBasemap: 'none' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: false,
        mermaid: false,
        echarts: false,
        smiles: false,
        flowchart: false,
        vega: false,
        monoGroup: false,
        geo: true,
        d2: false,
      }),
    )
  })

  it('a contentTheme change flips EVERY diagram flag (global) but not code alone', () => {
    initWith({ contentTheme: 'auto' })
    dispatchConfigChanged({ contentTheme: 'github-dark' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: true,
        mermaid: true,
        echarts: true,
        smiles: true,
        flowchart: true,
        vega: true,
        monoGroup: true,
        geo: true,
        d2: true,
      }),
    )
  })

  it('a lone codeTheme change flips ONLY code, no diagram flag', () => {
    initWith({ contentTheme: 'auto', codeTheme: 'github' })
    dispatchConfigChanged({ contentTheme: 'auto', codeTheme: 'monokai' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: true,
        mermaid: false,
        echarts: false,
        smiles: false,
        flowchart: false,
        vega: false,
        monoGroup: false,
        geo: false,
        d2: false,
      }),
    )
  })

  it('no change at all flips nothing', () => {
    initWith({ contentTheme: 'auto', d2Layout: 'dagre' })
    dispatchConfigChanged({ contentTheme: 'auto', d2Layout: 'dagre' })
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        code: false,
        mermaid: false,
        echarts: false,
        smiles: false,
        flowchart: false,
        vega: false,
        monoGroup: false,
        geo: false,
        d2: false,
      }),
    )
  })

  it('a workbench mode change flips every diagram even when contentTheme stays auto', () => {
    initWith({ contentTheme: 'auto' })
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'config-changed',
          options: { contentTheme: 'auto' },
          theme: 'dark',
        },
      }),
    )
    expect(sessionState.lastInitMsg?.theme).toBe('dark')
    expect(h.rethemeDiagrams).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'dark',
        code: true,
        mermaid: true,
        echarts: true,
        smiles: true,
        flowchart: true,
        vega: true,
        monoGroup: true,
        geo: true,
        d2: true,
      }),
    )
  })

  it("forwards the merged options to setRenderCacheConfig (feeds hashOf's per-engine fragment)", () => {
    initWith({ contentTheme: 'auto', d2Layout: 'dagre' })
    dispatchConfigChanged({ contentTheme: 'auto', d2Layout: 'elk' })
    expect(h.setRenderCacheConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          contentTheme: 'auto',
          d2Layout: 'elk',
        }),
      }),
    )
  })
})

describe('handleDiffInfo', () => {
  it('stashes the changes and renders gutter markers when an editor is live', () => {
    ;(window as any).vditor = {}
    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'diff-info', changes: [{ line: 3 }] },
      }),
    )
    expect(h.renderDiffMarkers).toHaveBeenCalledWith((window as any).vditor, [
      { line: 3 },
    ])
  })
})

// Task 436 (prerequisite finding) — a VS Code colour-theme flip arrives as `set-theme` and NOTHING
// ELSE: the host's onDidChangeActiveColorTheme posts only that command (editor-session.ts). But the
// render cache's `themeKey` is `mode|contentTheme|fontSize` (renderCacheThemeKey), so a flip that
// moves the MODE has to reach setRenderCacheConfig or the key goes stale — every render PUT after
// the flip is filed under the pre-flip mode, and a later lookup in that mode serves the wrong
// colours. config-changed already does this; set-theme did not, which is why 436's cache-first
// lookup could not be built on top of it.
describe('handleSetTheme — the cache key follows a workbench flip (task 436)', () => {
  beforeEach(() => {
    sessionState.lastInitMsg = {
      content: '',
      theme: 'light',
      options: { contentTheme: 'auto' },
    } as unknown as InitPayload
    ;(window as any).vditor = {}
  })

  it('updates the render-cache themeKey + mode BEFORE re-theming', () => {
    // A FRESH target, not the shared jsdom `window`: installMessageRouter adds a listener per call
    // and nothing removes them, so on `window` every earlier test's listener would also fire and
    // inflate the ordering log. Same reasoning as the origin-check block above.
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    const order: string[] = []
    h.setRenderCacheConfig.mockImplementation(() => {
      order.push('cache')
    })
    h.rethemeDiagrams.mockImplementation(() => {
      order.push('retheme')
    })
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'set-theme', theme: 'dark' },
      }),
    )
    expect(h.setRenderCacheConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dark' }),
    )
    // The key itself is renderCacheThemeKey's job (mocked here); what this pins is that the flip's
    // new mode is what gets handed to it.
    expect(h.renderCacheThemeKey).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
    )
    // Ordering is the whole point: a re-theme that hashes under the OLD key would "hit" on the
    // pre-flip render and paint the colours the flip was supposed to change.
    expect(order).toEqual(['cache', 'retheme'])
  })

  it('keys and configures the cache with the non-binary high-contrast kind', () => {
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: {
          command: 'set-theme',
          theme: 'dark',
          themeKind: 'high-contrast',
        },
      }),
    )
    expect(h.setD2Config).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dark', themeKind: 'high-contrast' }),
    )
    expect(h.renderCacheThemeKey).toHaveBeenCalledWith(
      expect.objectContaining({ themeKind: 'high-contrast' }),
    )
  })
})

// Task 468 debugging — real-VS-Code evidence showed a cross-doc `file.md#frag` open resolving
// everything correctly host-side (index, panel, `postMessage` awaited) while the freshly-opened
// webview never scrolled: `scroll-to-heading` can arrive before Vditor has finished rendering the
// target document's headings into the DOM. `scrollToHeadingIndex` (real, from ./outline — not
// mocked here) silently returns `false` in that case; these pin the retry that now covers it.
describe('handleScrollToHeading — retry for a freshly-opened panel (task 468)', () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView — outline.ts's scrollToHeadingIndex calls it
    // unconditionally (same workaround as same-doc-anchor.test.ts).
    Element.prototype.scrollIntoView = vi.fn()
    ;(window as any).vditor = undefined
    h.activeModeElement.mockReturnValue(null)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('retries until window.vditor exists and the heading has rendered, then scrolls', () => {
    vi.useFakeTimers()
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'scroll-to-heading', index: 0 },
      }),
    )
    // First attempt: no window.vditor yet — nothing to scroll, nothing thrown.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()

    // Simulate Vditor finishing construction + DOM render partway through the retry window —
    // the exact "fresh panel catches up" case the real bug hit.
    const root = document.createElement('div')
    root.innerHTML = '<h1>Target</h1>'
    document.body.appendChild(root)
    ;(window as any).vditor = {}
    h.activeModeElement.mockReturnValue(root)

    vi.advanceTimersByTime(2000)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('gives up after the 2s budget if the panel never finishes rendering (no crash, no infinite retry)', () => {
    vi.useFakeTimers()
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'scroll-to-heading', index: 0 },
      }),
    )
    vi.advanceTimersByTime(10_000) // well past the 2s retry budget
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    // Nothing left scheduled — advancing further wouldn't do anything either. Asserted by
    // absence of an error: a runaway setTimeout chain would otherwise still be firing here.
  })

  it("doesn't retry at all when the heading is already there (the common outline-click case)", () => {
    vi.useFakeTimers()
    const root = document.createElement('div')
    root.innerHTML = '<h1>Target</h1>'
    document.body.appendChild(root)
    ;(window as any).vditor = {}
    h.activeModeElement.mockReturnValue(root)
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'scroll-to-heading', index: 0 },
      }),
    )
    // Succeeds synchronously on attempt #1 — no timer needed at all.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1) // no extra retries
  })
})

describe('handleRevealLine — source line to live block (task 52)', () => {
  it('scrolls, flashes, and places the caret in the mapped block', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const root = document.createElement('div')
    root.innerHTML =
      '<p data-block="0">first</p><p data-block="0">target block</p>'
    document.body.appendChild(root)
    h.activeModeElement.mockReturnValue(root)
    h.blockIndexForSourceLine.mockReturnValue(1)
    const requestCaret = vi.fn(() => true)
    ;(window as any).__vmdeRequestCaret = requestCaret
    ;(window as any).vditor = {
      getValue: () => 'first\n\ntarget block',
      vditor: { currentMode: 'ir', ir: { element: root } },
    }

    installMessageRouter(window)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'reveal-line', line: 3, lineText: 'target block' },
      }),
    )

    const target = root.children[1] as HTMLElement
    expect(h.blockIndexForSourceLine).toHaveBeenCalledWith(
      'first\n\ntarget block',
      2,
    )
    expect(h.sourceLineForReveal).toHaveBeenCalledWith(
      'first\n\ntarget block',
      3,
      'target block',
    )
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    })
    expect(target.classList.contains('heading-flash')).toBe(true)
    expect(requestCaret).toHaveBeenCalledWith({
      node: target.firstChild,
      offset: 0,
    })
  })
})

// Task 505 — the `vmde.format.*` VS Code commands arrive here as `trigger-toolbar-hotkey`. No
// dedupe any more: every promoted key is `hotkey: ''`'d in toolbar.ts (Vditor's own handler never
// sees it) and undo/redo have no keybinding at all (undo-keybind.ts owns those keys outright) — see
// format-hotkeys.ts and this handler's own comment for why nothing competes for a name any more.
// Real-webview verification (incl. the Ctrl+B/I/U native-execCommand guard) lives in
// test/vscode-e2e/format-hotkeys.spec.ts; this pins the routing logic at the unit layer.
describe('handleTriggerToolbarHotkey (trigger-toolbar-hotkey)', () => {
  function mockToolbarButton() {
    const button = document.createElement('button')
    const click = vi.fn()
    button.addEventListener('click', click)
    ;(window as any).vditor = {
      vditor: {
        toolbar: { elements: { bold: { children: [button] } } },
        undo: { undo: vi.fn(), redo: vi.fn() },
      },
    }
    return { button, click }
  }

  it('dispatches a click on the toolbar item button for a plain formatting name', () => {
    const { click } = mockToolbarButton()
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'bold' },
      }),
    )
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('routes undo/redo through the undo engine directly, not a toolbar button click', () => {
    const { button, click } = mockToolbarButton()
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'undo' },
      }),
    )
    const inner = (window as any).vditor.vditor
    expect(inner.undo.undo).toHaveBeenCalledWith(inner)
    expect(click).not.toHaveBeenCalled()
    void button
  })

  it('is a no-op when window.vditor is not ready yet', () => {
    ;(window as any).vditor = undefined
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    expect(() =>
      target.dispatchEvent(
        new MessageEvent('message', {
          data: { command: 'trigger-toolbar-hotkey', name: 'bold' },
        }),
      ),
    ).not.toThrow()
  })

  // Task 506 follow-up (MEASURED in the real editor + probe spec): Vditor's highlightToolbarIR
  // debounces 200ms and DISABLES the indent/outdent buttons whenever the caret hasn't been settled
  // in a list, so a hotkey pressed within that window no-ops on a disabled button even though the
  // caret IS in a list. A hotkey is a deliberate keyboard action — it must act on the caret's
  // ACTUAL context, not the button's debounced visual state; the handlers' own
  // hasClosestByMatchTag(LI) is the real semantic gate. The class is dropped for this dispatch
  // only (the next highlightToolbarIR run re-asserts it).
  it('drops the disabled class from indent/outdent buttons before dispatch', () => {
    const button = document.createElement('button')
    button.classList.add('vditor-menu--disabled')
    const click = vi.fn()
    button.addEventListener('click', click)
    ;(window as any).vditor = {
      vditor: { toolbar: { elements: { indent: { children: [button] } } } },
    }
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'indent' },
      }),
    )
    expect(click).toHaveBeenCalledTimes(1) // the handler ran despite the disabled class
    expect(button.classList.contains('vditor-menu--disabled')).toBe(false)
  })

  it('drops a stale disabled class from a list-family button in plain editor content', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>plain paragraph</p>'
    document.body.appendChild(root)
    h.activeModeElement.mockReturnValue(root)
    const text = root.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    const button = document.createElement('button')
    button.classList.add('vditor-menu--disabled')
    ;(window as any).vditor = {
      vditor: { toolbar: { elements: { list: { children: [button] } } } },
    }
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'list' },
      }),
    )
    expect(button.classList.contains('vditor-menu--disabled')).toBe(false)
  })

  it('keeps a list-family button disabled when the live selection is inside code', () => {
    const root = document.createElement('div')
    root.innerHTML = '<code data-type="code">inline code</code>'
    document.body.appendChild(root)
    h.activeModeElement.mockReturnValue(root)
    const text = root.querySelector('code')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    const button = document.createElement('button')
    button.classList.add('vditor-menu--disabled')
    ;(window as any).vditor = {
      vditor: { toolbar: { elements: { list: { children: [button] } } } },
    }
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'list' },
      }),
    )
    expect(button.classList.contains('vditor-menu--disabled')).toBe(true)
  })

  it('leaves the disabled class untouched for non-indent names', () => {
    const button = document.createElement('button')
    button.classList.add('vditor-menu--disabled')
    const click = vi.fn()
    button.addEventListener('click', click)
    ;(window as any).vditor = {
      vditor: { toolbar: { elements: { bold: { children: [button] } } } },
    }
    const target = new EventTarget() as unknown as Window
    installMessageRouter(target)
    target.dispatchEvent(
      new MessageEvent('message', {
        data: { command: 'trigger-toolbar-hotkey', name: 'bold' },
      }),
    )
    expect(click).toHaveBeenCalledTimes(1)
    expect(button.classList.contains('vditor-menu--disabled')).toBe(true)
  })
})
