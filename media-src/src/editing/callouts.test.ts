// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyCallouts,
  CALLOUT_TYPES,
  calloutSourceHasAnchor,
  createCalloutControls,
  deriveCalloutContext,
  matchCallout,
  observeCallouts,
  runCalloutAction,
  transformCalloutMarkdown,
} from './callouts'
import { installCompositionState } from '../util/caret-gesture'

const PREVIEW = '.vmde-callout__preview'

describe('callout authoring source core', () => {
  it('keeps the GitHub alert types first and every exposed type parseable', () => {
    expect(CALLOUT_TYPES.slice(0, 5)).toEqual([
      'note',
      'tip',
      'important',
      'warning',
      'caution',
    ])
    for (const type of CALLOUT_TYPES) {
      expect(matchCallout(`[!${type.toUpperCase()}]`)).toMatchObject({ type })
    }
  })

  it('inserts a NOTE callout into an empty block and places the caret in its body', () => {
    const result = transformCalloutMarkdown('', 0, 0, {
      kind: 'apply',
      type: 'note',
      title: '',
    })
    expect(result).toMatchObject({
      changed: true,
      markdown: '> [!NOTE]\n> ',
      startOffset: 12,
      endOffset: 12,
    })
  })

  it('converts one prose block without losing inline Markdown or the logical caret', () => {
    const markdown = 'alpha **beta** gamma\n\ntail\n'
    const caret = markdown.indexOf('beta') + 2
    const result = transformCalloutMarkdown(markdown, caret, caret, {
      kind: 'apply',
      type: 'tip',
      title: 'Heads up',
    })
    expect(result.markdown).toBe(
      '> [!TIP] Heads up\n> alpha **beta** gamma\n\ntail\n',
    )
    expect(result.markdown.slice(0, result.startOffset)).toContain('be')
    expect(result.startOffset).toBe(result.endOffset)
  })

  it('inserts the marker into a multi-paragraph plain blockquote without nesting it', () => {
    const markdown = '> first\n>\n> - nested item\n> second\n\nafter\n'
    const result = transformCalloutMarkdown(markdown, 3, 3, {
      kind: 'apply',
      type: 'warning',
      title: '',
    })
    expect(result.markdown).toBe(
      '> [!WARNING]\n> first\n>\n> - nested item\n> second\n\nafter\n',
    )
  })

  it('rewrites only the requested existing marker fields and preserves fold/body bytes', () => {
    const markdown = '> [!NOTE]-  Old title\n> body **exact**\n'
    const typeResult = transformCalloutMarkdown(markdown, 30, 30, {
      kind: 'apply',
      type: 'caution',
    })
    expect(typeResult.markdown).toBe(
      '> [!CAUTION]-  Old title\n> body **exact**\n',
    )
    const titleResult = transformCalloutMarkdown(typeResult.markdown, 34, 34, {
      kind: 'apply',
      type: 'caution',
      title: 'New title',
    })
    expect(titleResult.markdown).toBe(
      '> [!CAUTION]- New title\n> body **exact**\n',
    )
  })

  it('removes only the marker line and preserves the normal blockquote body', () => {
    const markdown = '> [!IMPORTANT] Title\n> body\n>\n> second\n'
    const result = transformCalloutMarkdown(markdown, 27, 27, {
      kind: 'remove',
    })
    expect(result.markdown).toBe('> body\n>\n> second\n')
    expect(result.changed).toBe(true)
  })

  it('derives current source state and treats exact reapplication as a no-op', () => {
    const markdown = '> [!TIP] Current\n> body\n'
    expect(deriveCalloutContext(markdown, 23, 23)).toMatchObject({
      kind: 'callout',
      type: 'tip',
      title: 'Current',
      canApply: true,
      canRemove: true,
    })
    expect(
      transformCalloutMarkdown(markdown, 23, 23, {
        kind: 'apply',
        type: 'tip',
        title: 'Current',
      }),
    ).toMatchObject({ changed: false, markdown })
  })

  it.each([
    ['unknown marker', '> [!UNKNOWN]\n> body\n', 15, 15],
    ['cross-block selection', 'alpha\n\nbeta\n', 1, 10],
    ['heading', '# Heading\n', 3, 3],
    ['table', '| a | b |\n| - | - |\n', 3, 3],
    ['fence', '```js\nconst x = 1\n```\n', 10, 10],
  ])('rejects %s without mutation', (_label, markdown, start, end) => {
    expect(deriveCalloutContext(markdown, start, end)).toMatchObject({
      kind: 'unsupported',
      canApply: false,
    })
    expect(
      transformCalloutMarkdown(markdown, start, end, {
        kind: 'apply',
        type: 'note',
      }),
    ).toMatchObject({ changed: false, markdown })
  })

  it('builds one labeled, Lute-invisible control set for apply/remove/Escape', () => {
    const apply = vi.fn()
    const remove = vi.fn()
    const dismiss = vi.fn()
    const panel = createCalloutControls(
      document,
      {
        kind: 'callout',
        type: 'tip',
        title: 'Current',
        canApply: true,
        canRemove: true,
        sourceStart: 0,
        sourceEnd: 0,
      },
      { apply, remove, dismiss },
    )
    expect(panel.dataset.render).toBe('1')
    expect(panel.contentEditable).toBe('false')
    const select = panel.querySelector('select')!
    const title = panel.querySelector('input')!
    expect(select.getAttribute('aria-label')).toBe('Callout type')
    expect(title.getAttribute('aria-label')).toBe('Callout title')
    select.value = 'warning'
    title.value = 'Changed'
    ;(panel.querySelector('.vmde-callout__apply') as HTMLButtonElement).click()
    expect(apply).toHaveBeenCalledWith('warning', 'Changed')
    ;(panel.querySelector('.vmde-callout__remove') as HTMLButtonElement).click()
    expect(remove).toHaveBeenCalledOnce()
    panel.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(dismiss).toHaveBeenCalledOnce()
  })
})

// Build a real IR-editor-ish DOM: a contenteditable `.vditor-ir` surface holding a `[!NOTE]` callout
// blockquote and a trailing paragraph the caret can move into. Mirrors what Vditor emits in IR mode.
function buildIrCallout() {
  const ir = document.createElement('div')
  ir.className = 'vditor-ir vditor-reset'
  ir.setAttribute('contenteditable', 'true')
  const bq = document.createElement('blockquote')
  const p = document.createElement('p')
  p.textContent = '[!NOTE]\nbody text of the note'
  bq.appendChild(p)
  const after = document.createElement('p')
  after.textContent = 'after'
  ir.append(bq, after)
  document.body.appendChild(ir)
  return { ir, bq, p, after }
}

function placeCaret(node: Node, offset: number) {
  const sel = window.getSelection()
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  sel?.removeAllRanges()
  sel?.addRange(r)
}

describe('matchCallout', () => {
  it('matches GitHub alert types (case-insensitive)', () => {
    expect(matchCallout('[!NOTE]')).toMatchObject({ type: 'note' })
    expect(matchCallout('[!Tip]')).toMatchObject({ type: 'tip' })
    expect(matchCallout('[!WARNING]')?.type).toBe('warning')
  })

  it('captures an optional title after the marker', () => {
    expect(matchCallout('[!NOTE] Heads up')).toMatchObject({
      type: 'note',
      title: 'Heads up',
    })
    expect(matchCallout('[!note]')?.title).toBe('')
  })

  it("accepts Obsidian's foldable suffixes but ignores them (fold support dropped)", () => {
    expect(matchCallout('[!note]-')).toMatchObject({ type: 'note', title: '' })
    expect(matchCallout('[!note]+ Title')).toMatchObject({
      type: 'note',
      title: 'Title',
    })
    expect(matchCallout('[!note]-')).not.toHaveProperty('foldable')
  })

  it('rejects unknown types — not a callout, stays a plain blockquote', () => {
    expect(matchCallout('[!whatever]')).toBeNull()
    expect(matchCallout('[!TIPs]')).toBeNull() // the reported invalid name (typo of tip)
    expect(matchCallout('[!note]')?.type).toBe('note') // a known type still matches
  })

  it('returns null for normal blockquote text', () => {
    expect(matchCallout('Just a quote.')).toBeNull()
    expect(matchCallout('[not a callout]')).toBeNull()
    expect(matchCallout('')).toBeNull()
  })

  it('tolerates leading whitespace', () => {
    expect(matchCallout('  [!tip] x')?.type).toBe('tip')
  })
})

// Task 179 — typing inside a callout used to eject the caret + blank the text. The fix drives the
// dual-node's expand/collapse off the LIVE selection (not Vditor's keyup timing) and skips rebuilding
// the preview of the callout being typed in. These guard that behaviour so the regression can't return.
describe('calloutSourceHasAnchor (editing-guard predicate)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('is true for a node inside the editable source, false in the injected preview', () => {
    const { ir, bq, p } = buildIrCallout()
    applyCallouts(ir) // injects the non-editable preview
    const preview = bq.querySelector(PREVIEW) as HTMLElement
    expect(calloutSourceHasAnchor(bq, p.firstChild)).toBe(true) // source text node
    expect(calloutSourceHasAnchor(bq, preview)).toBe(false) // inside the preview → not editing
    expect(
      calloutSourceHasAnchor(bq, preview.querySelector('*') ?? preview),
    ).toBe(false)
  })

  it('is false for no anchor or a node outside the callout', () => {
    const { ir, bq, after } = buildIrCallout()
    applyCallouts(ir)
    expect(calloutSourceHasAnchor(bq, null)).toBe(false)
    expect(calloutSourceHasAnchor(bq, undefined)).toBe(false)
    expect(calloutSourceHasAnchor(bq, after.firstChild)).toBe(false) // sibling paragraph
  })
})

describe('callout preview body survives a SPLIT marker/body text run (renamed-type bug)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  // Editing the marker (e.g. [!TIP] → [!NOTE]) makes the IR split the leading run into separate text
  // nodes: `[!NOTE]` + `\nbody`. stripMarkerLine used to look only at p.firstChild (`[!NOTE]`, no `\n`)
  // and drop the WHOLE <p> — so the body vanished from the rendered callout. It must scan child nodes.
  it('strips only the marker line, keeping the body, when the run is split across text nodes', () => {
    const ir = document.createElement('div')
    ir.className = 'vditor-ir vditor-reset'
    ir.setAttribute('contenteditable', 'true')
    const bq = document.createElement('blockquote')
    const p = document.createElement('p')
    p.appendChild(document.createTextNode('[!NOTE]')) // marker in its own text node…
    p.appendChild(document.createTextNode('\nbody text here')) // …body split into a sibling node
    bq.appendChild(p)
    ir.appendChild(bq)
    document.body.appendChild(ir)

    applyCallouts(ir)
    const preview = bq.querySelector(PREVIEW) as HTMLElement
    expect(preview).not.toBeNull()
    expect(preview.querySelector('.vmde-callout__title')?.textContent).toBe(
      'Note',
    )
    expect(
      preview.querySelector('.vmde-callout__body')?.textContent?.trim(),
    ).toBe('body text here') // body PRESERVED (was empty before the fix)
  })

  it('still drops a marker-only first paragraph (no body line)', () => {
    const ir = document.createElement('div')
    ir.className = 'vditor-ir vditor-reset'
    const bq = document.createElement('blockquote')
    const marker = document.createElement('p')
    marker.textContent = '[!NOTE]'
    const bodyP = document.createElement('p')
    bodyP.textContent = 'a second paragraph body'
    bq.append(marker, bodyP)
    ir.appendChild(bq)
    document.body.appendChild(ir)

    applyCallouts(ir)
    const body = bq.querySelector('.vmde-callout__body') as HTMLElement
    expect(body.textContent).toContain('a second paragraph body') // body kept
    expect(body.textContent).not.toContain('[!NOTE]') // marker-only <p> dropped
  })
})

describe('applyCallouts editing guard (caret inside the callout source)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('caret outside → collapsed, preview built, not flagged editing', () => {
    const { ir, bq, after } = buildIrCallout()
    placeCaret(after.firstChild as Node, 1)
    applyCallouts(ir)
    expect(bq.querySelector(PREVIEW)).not.toBeNull()
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(false)
    expect(bq.hasAttribute('data-callout-editing')).toBe(false)
  })

  it('caret inside → expanded, flagged editing, preview NOT restructured (caret-safe)', () => {
    const { ir, bq, p } = buildIrCallout()
    applyCallouts(ir) // build the preview first (collapsed state)
    const previewBefore = bq.querySelector(PREVIEW)
    placeCaret(p.firstChild as Node, 1) // caret into the editable source
    applyCallouts(ir) // re-decorate as the per-keystroke observer would
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(true) // source stays visible
    expect(bq.hasAttribute('data-callout-editing')).toBe(true)
    // the node being typed in is never restructured (same preview element → no replaceWith/caret eject)
    expect(bq.querySelector(PREVIEW)).toBe(previewBefore)
  })

  it('does NOT expand for a non-editable surface (Preview pane, no .vditor-ir)', () => {
    const { bq, p } = buildIrCallout()
    const pane = document.createElement('div')
    pane.className = 'vditor-preview' // read-only render, not the IR edit surface
    pane.appendChild(bq.parentElement?.removeChild(bq) ?? bq)
    document.body.appendChild(pane)
    applyCallouts(pane)
    placeCaret(p.firstChild as Node, 1) // a text selection in the preview pane is not "editing"
    applyCallouts(pane)
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(false)
    expect(bq.hasAttribute('data-callout-editing')).toBe(false)
    expect(bq.querySelector(PREVIEW)).not.toBeNull() // still rendered
  })
})

describe('observeCallouts caret-leave re-sync (selectionchange)', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('rebuilds the preview from the final source after the caret leaves the callout', () => {
    const { ir, bq, p, after } = buildIrCallout()
    dispose = observeCallouts(ir)

    // enter + edit: applyCallouts stands in for the synchronous per-keystroke observer (the real
    // MutationObserver is a microtask → not deterministic in a sync test). It flags the callout
    // `data-callout-editing` + keeps the preview skipped while the caret is inside.
    placeCaret(p.firstChild as Node, 1)
    applyCallouts(ir)
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(true)
    expect(bq.hasAttribute('data-callout-editing')).toBe(true)
    ;(p.firstChild as Text).textContent = '[!NOTE]\nedited body now'
    applyCallouts(ir) // caret still inside → preview still skipped, flag stays

    // leave the callout → the selectionchange handler collapses it + re-syncs the preview to the edit
    placeCaret(after.firstChild as Node, 1)
    document.dispatchEvent(new Event('selectionchange'))
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(false)
    expect(bq.hasAttribute('data-callout-editing')).toBe(false)
    const preview = bq.querySelector(PREVIEW) as HTMLElement
    expect(preview).not.toBeNull()
    expect(preview.textContent).toContain('edited body now') // rebuilt from the final source
  })

  it('expands the focused IR callout straight off the selection (not Vditor keyup timing)', () => {
    const { ir, bq, p } = buildIrCallout()
    dispose = observeCallouts(ir)
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(false)
    // caret moves into the source + selection change fires → the handler expands it itself, so the
    // source can't flash to display:none between the re-spin and Vditor re-adding `--expand`.
    placeCaret(p.firstChild as Node, 1)
    document.dispatchEvent(new Event('selectionchange'))
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(true)
  })

  it('does NOT re-sync a callout still holding the caret (skips the one being typed in)', () => {
    const { ir, bq, p } = buildIrCallout()
    dispose = observeCallouts(ir)
    placeCaret(p.firstChild as Node, 1)
    applyCallouts(ir) // flag it editing (caret inside)
    expect(bq.hasAttribute('data-callout-editing')).toBe(true)
    // a selection change while the caret is STILL inside must leave the edited callout untouched
    // (the leave path only fires for a flagged callout the caret has left) — no collapse mid-typing.
    document.dispatchEvent(new Event('selectionchange'))
    expect(bq.classList.contains('vditor-ir__node--expand')).toBe(true)
    expect(bq.hasAttribute('data-callout-editing')).toBe(true)
  })

  it('defers caret-leave re-sync until after compositionend propagation', async () => {
    const { ir, bq, p, after } = buildIrCallout()
    const disposeComposition = installCompositionState(document)
    const disposeCallouts = observeCallouts(ir)
    dispose = () => {
      disposeCallouts()
      disposeComposition()
    }
    placeCaret(p.firstChild as Node, 1)
    applyCallouts(ir)
    ;(p.firstChild as Text).textContent = '[!NOTE]\ncomposed body'
    applyCallouts(ir)

    document.dispatchEvent(new CompositionEvent('compositionstart'))
    placeCaret(after.firstChild as Node, 1)
    document.dispatchEvent(new Event('selectionchange'))

    expect(bq.hasAttribute('data-callout-editing')).toBe(true)

    let editingDuringCompositionEnd = false
    document.addEventListener(
      'compositionend',
      () => {
        editingDuringCompositionEnd = bq.hasAttribute('data-callout-editing')
      },
      { once: true },
    )
    document.dispatchEvent(new CompositionEvent('compositionend'))

    expect(editingDuringCompositionEnd).toBe(true)
    await Promise.resolve()
    expect(bq.hasAttribute('data-callout-editing')).toBe(false)
    expect(bq.querySelector(PREVIEW)?.textContent).toContain('composed body')
  })
})

// Task 173: observeCallouts is scoped via mutation-scope.ts (applyCalloutsWithin) instead of a
// whole-editor applyCallouts on every batch. These exercise the REAL MutationObserver-driven path
// (a genuine DOM mutation, not a direct applyCallouts() call — every other describe block above calls
// applyCallouts directly, which never reaches the scoped branch) so it's covered.
//
// Deterministic rAF (same pattern as observe-coalesce.test.ts): coalescePerFrameWithRecords's leading
// edge runs synchronously, but it ALSO arms a trailing-edge rAF — a real, un-stubbed jsdom rAF may not
// resolve within a plain `await`, which would silently strand a same-"frame" edit in `pending`. Stub
// it so the trailing pass is triggered explicitly via `fireFrame()`.
describe('observeCallouts scoping (task 173/174)', () => {
  let dispose: (() => void) | null = null
  let frameCallbacks: FrameRequestCallback[]
  beforeEach(() => {
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameCallbacks.push(cb)
      return frameCallbacks.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      // Mark the slot cancelled so a later flush of frameCallbacks can't
      // re-invoke a callback the code under test already cancelled.
      frameCallbacks[id - 1] = () => {
        /* cancelled */
      }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    dispose?.()
    dispose = null
    document.body.innerHTML = ''
  })
  const fireFrame = () => {
    const cbs = frameCallbacks
    frameCallbacks = []
    for (const cb of cbs) cb(0)
  }

  function buildTwoCallouts() {
    const ir = document.createElement('div')
    ir.className = 'vditor-ir vditor-reset'
    ir.setAttribute('contenteditable', 'true')
    const bqA = document.createElement('blockquote')
    const pA = document.createElement('p')
    pA.textContent = '[!NOTE]\nalpha body'
    bqA.appendChild(pA)
    const bqB = document.createElement('blockquote')
    const pB = document.createElement('p')
    pB.textContent = '[!TIP]\nbravo body'
    bqB.appendChild(pB)
    ir.append(bqA, bqB)
    document.body.appendChild(ir)
    return { ir, bqA, bqB }
  }

  it('a real outerHTML replace of ONE callout re-decorates the FRESH node via the scoped path, sibling untouched', async () => {
    const { ir, bqA, bqB } = buildTwoCallouts()
    dispose = observeCallouts(ir) // mount's leading run also arms a trailing-edge rAF
    expect(bqA.getAttribute('data-callout')).toBe('note')
    expect(bqB.getAttribute('data-callout')).toBe('tip')

    // Mirrors the spin's `blockElement.outerHTML = html`: the pre-existing blockquote is destroyed
    // and a brand-new one takes its place — the real regression risk task 173 warns about (a freshly
    // recreated node the scoped re-decorate pass must still find).
    bqA.outerHTML = '<blockquote><p>[!WARNING]\nalpha renamed</p></blockquote>'
    await Promise.resolve() // flush the MutationObserver microtask → coalesced (mount's rAF is armed)
    fireFrame() // flush the trailing pass, which resolves the scoped block via mutation-scope.ts

    const freshA = ir.querySelector('blockquote') as HTMLElement
    expect(freshA.getAttribute('data-callout')).toBe('warning') // fresh node correctly decorated
    expect(bqB.getAttribute('data-callout')).toBe('tip') // untouched sibling unchanged
    expect(bqB.querySelector(PREVIEW)).not.toBeNull() // sibling's preview still intact
  })

  it('a decoration-only write (our own preview injection) does not need the fleet to re-walk (task 174)', async () => {
    const { ir, bqA } = buildTwoCallouts()
    dispose = observeCallouts(ir)
    const before = bqA.querySelector(PREVIEW)?.outerHTML
    // Simulate what our own syncPreview() does: append a `vmde-callout__preview` decoration node.
    // scopeMutations must drop this batch entirely (task 174) — assert the observable effect: the
    // pre-existing preview is untouched (no rebuild triggered) rather than poking internals.
    const extra = document.createElement('div')
    extra.className = 'vditor-ir__preview vmde-callout__preview'
    extra.dataset.sig = 'decoration-only-probe'
    bqA.appendChild(extra)
    await Promise.resolve()
    fireFrame()
    // the ORIGINAL preview (first match) is still exactly as it was — nothing rebuilt it
    expect(bqA.querySelector(PREVIEW)?.outerHTML).toBe(before)
  })
})

// Task 630 S1 (RED): a callout action acquires exact authority, plans on the acquired exact text and
// posts with a rollback. `CalloutActionDeps` has no acquire seam yet, so `acquireExactAuthority` and
// `postExact(markdown, opts)` are declared here and cast onto the product type.
describe('callout action exact authority (Task 630)', () => {
  interface ExactEdit {
    rollback?: { restore(): void }
    before?: string
  }
  type AcquiredPair = { exact: string; rendered: string }
  type Deps = Parameters<typeof runCalloutAction>[1] & {
    acquireExactAuthority(): Promise<AcquiredPair | null>
    postExact(markdown: string, opts?: ExactEdit): void
  }

  // Extra blank lines and `* * *` normalize away, so rendered offsets differ from the host offsets.
  const HOST_EXACT = 'Alpha\n\n\n\nBeta paragraph\n\n* * *\n\nGamma\n'
  const RENDERED = 'Alpha\n\nBeta paragraph\n\n---\n\nGamma\n'
  const NOTE = { kind: 'apply', type: 'note', title: '' } as const

  function harness(acquire: () => Promise<AcquiredPair | null>) {
    document.body.innerHTML = '<div class="vditor-ir"></div>'
    const editor = document.querySelector<HTMLElement>('.vditor-ir')!
    let shown = RENDERED
    const render = (markdown: string) => {
      shown = markdown
      const paragraph = document.createElement('p')
      paragraph.textContent = markdown
      editor.replaceChildren(paragraph)
    }
    render(RENDERED)
    const setValue = vi.fn(render)
    ;(window as any).vditor = {
      getValue: () => shown,
      setValue,
      vditor: {
        currentMode: 'ir',
        ir: { element: editor },
        undo: { addToUndoStack: vi.fn() },
      },
    }
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const host = { text: HOST_EXACT, owned: null as string | null, restored: 0 }
    const acquireExactAuthority = vi.fn(acquire)
    const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
      const before = opts?.before ?? host.owned
      if (before !== host.text) {
        render(host.text)
        opts?.rollback?.restore()
        host.restored++
        return
      }
      host.text = markdown
      host.owned = markdown
    })
    const onError = vi.fn()
    const deps = {
      setApplying: vi.fn(),
      postExact,
      acquireExactAuthority,
      onError,
    } as Deps
    const offset = RENDERED.indexOf('Gamma')
    const target = {
      selection: {
        markdown: RENDERED,
        startOffset: offset,
        endOffset: offset,
        caretOffset: offset,
      },
      context: deriveCalloutContext(RENDERED, offset, offset),
    }
    const run = () =>
      runCalloutAction(window, deps, NOTE, target as never) as unknown as
        | boolean
        | Promise<boolean>
    return {
      host,
      shown: () => shown,
      setValue,
      acquireExactAuthority,
      postExact,
      onError,
      run,
    }
  }

  afterEach(() => {
    delete (window as any).vditor
  })

  it.each([
    ['after a trusted edit (host round trip)', true],
    ['on a fresh document (owned pair)', false],
  ] as const)(
    'applying a callout %s acquires authority and plans on the acquired exact text',
    async (_name, delayed) => {
      const h = harness(async () => {
        if (delayed) await new Promise((done) => setTimeout(done, 1))
        h.host.owned = h.host.text
        return { exact: h.host.text, rendered: h.shown() }
      })

      expect(await h.run()).toBe(true)

      expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
      expect(h.postExact).toHaveBeenCalledOnce()
      expect(h.postExact.mock.calls[0][1]).toEqual({
        rollback: { restore: expect.any(Function) },
      })
      const at = HOST_EXACT.indexOf('Gamma')
      expect(h.host.text).toBe(
        transformCalloutMarkdown(HOST_EXACT, at, at, NOTE).markdown,
      )
      // Everything before the converted block is still the host's bytes.
      expect(h.host.text.startsWith(HOST_EXACT.slice(0, at))).toBe(true)
    },
  )

  it('refuses a stale host: no write, the rollback runs and the DOM shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\n`
    const h = harness(async () => {
      h.host.owned = h.host.text
      const pair = { exact: h.host.text, rendered: h.shown() }
      h.host.text = drifted
      return pair
    })

    await h.run()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(h.host.restored).toBe(1)
    expect(h.host.text).toBe(drifted)
    expect(h.shown()).toBe(drifted)
  })

  it('declines without a write or a DOM change when acquisition fails', async () => {
    const h = harness(async () => null)

    expect(await h.run()).toBe(false)

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.setValue).not.toHaveBeenCalled()
    expect(h.postExact).not.toHaveBeenCalled()
    expect(h.shown()).toBe(RENDERED)
    expect(h.onError).not.toHaveBeenCalled()
  })
})
