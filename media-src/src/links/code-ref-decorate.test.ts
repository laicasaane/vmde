// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyCodeRefs,
  applyCodeRefsWithin,
  observeCodeRefs,
} from './code-ref-decorate'
import { observeLinkLikeSemantics } from './link-like-semantics'
import {
  _resetCodeRefResolutionForTests,
  applyCodeRefResolution,
  requestCodeRefResolution,
} from './code-ref-resolve'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'

// Task 229 — DOM decoration. Uses fake timers + the REAL code-ref-resolve module (not a stub)
// so these tests double as an integration check between the two, matching code-source.test.ts's
// style. `resolve(path, exists)` primes the shared resolver cache exactly the way a real host
// round-trip would (request → batch flush → reply), rather than reaching into module internals.
function resolve(path: string, exists: boolean) {
  const post = vi.fn()
  requestCodeRefResolution(path, post)
  vi.advanceTimersByTime(50)
  const requestId = post.mock.calls[0][0].requestId
  applyCodeRefResolution(requestId, exists ? [path] : [])
}

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

// Task 229 regression (found only by the real-VS-Code e2e, NOT by the plain `<div>` mount()
// above): Vditor's actual IR/WYSIWYG editor root is itself `<pre class="vditor-reset">`
// (`ir/index.ts` / `wysiwyg/index.ts`) — a bare `pre`/`code.closest('pre')` guard silently
// excludes the WHOLE editable surface, not just fenced code blocks, because that root is
// ALWAYS a `pre` ancestor of everything inside it. Mount through this wrapper (the `#app`
// caller in finish-init.ts passes the container ABOVE this root, so `applyCodeRefs` always
// sees it) to keep that regression covered at the unit layer too.
function mountInEditorRoot(html: string): HTMLElement {
  const app = document.createElement('div')
  app.innerHTML = `<pre class="vditor-reset">${html}</pre>`
  document.body.appendChild(app)
  return app
}

describe('applyCodeRefs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCodeRefResolutionForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('wraps a RESOLVED ref in prose with a chip carrying path/line/col, text unchanged', () => {
    resolve('src/foo.ts', true)
    const root = mount('<p>See src/foo.ts:42:7 for details.</p>')
    applyCodeRefs(root, vi.fn())
    const chip = root.querySelector<HTMLElement>('[data-code-ref="1"]')
    expect(chip).not.toBeNull()
    expect(chip?.className).toBe('vmde-code-ref-chip')
    expect(chip?.dataset.codeRefPath).toBe('src/foo.ts')
    expect(chip?.dataset.codeRefLine).toBe('42')
    expect(chip?.dataset.codeRefCol).toBe('7')
    expect(chip?.textContent).toBe('src/foo.ts:42:7')
    expect(root.textContent).toBe('See src/foo.ts:42:7 for details.') // visible text unchanged
  })

  it('drops a ref that overlaps a bare URL and still chips a separate one (Task 655)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p>open https://example.com/src/foo.ts:42 and src/foo.ts:7</p>',
    )
    applyCodeRefs(root, vi.fn())
    const chips = Array.from(
      root.querySelectorAll<HTMLElement>('[data-code-ref="1"]'),
    )
    expect(chips.map((c) => c.textContent)).toEqual(['src/foo.ts:7'])
  })

  it('does not chip text inside a bare URL span (Task 655)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p><span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="https://x.org/src/foo.ts:1">https://x.org/src/foo.ts:1</span></p>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('wraps MULTIPLE resolved refs in the same paragraph independently', () => {
    resolve('src/a.ts', true)
    resolve('src/b.ts', true)
    const root = mount('<p>see src/a.ts:1 and src/b.ts:2 here</p>')
    applyCodeRefs(root, vi.fn())
    const chips = Array.from(
      root.querySelectorAll<HTMLElement>('[data-code-ref="1"]'),
    )
    expect(chips.map((c) => c.dataset.codeRefPath)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ])
    expect(root.textContent).toBe('see src/a.ts:1 and src/b.ts:2 here')
  })

  it('leaves an UNRESOLVED (not yet known) path plain and requests its resolution', () => {
    const root = mount('<p>See src/unknown.ts:5 here.</p>')
    const post = vi.fn()
    applyCodeRefs(root, post)
    expect(root.querySelector('[data-code-ref]')).toBeNull()
    expect(root.textContent).toBe('See src/unknown.ts:5 here.')
    vi.advanceTimersByTime(50)
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'resolve-code-refs',
        paths: ['src/unknown.ts'],
      }),
    )
  })

  it('leaves a CONFIRMED-MISSING path plain — no dead-link chip', () => {
    resolve('src/gone.ts', false)
    const root = mount('<p>See src/gone.ts:5 here.</p>')
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
    expect(root.textContent).toBe('See src/gone.ts:5 here.')
  })

  it('does not decorate inside a fenced code block (via its <code>)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<div data-type="code-block"><pre class="vditor-ir__marker--pre"><code>src/foo.ts:42</code></pre></div>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('does not decorate bare text directly inside a <pre> (no nested <code>) — the `pre` guard on its own', () => {
    resolve('src/foo.ts', true)
    const root = mount('<pre>src/foo.ts:42</pre>')
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
    expect(root.textContent).toBe('src/foo.ts:42')
  })

  it('does not decorate inside a Vditor IR marker or preview subtree', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<span class="vditor-ir__marker">src/foo.ts:42</span>' +
        '<div class="vditor-ir__preview">src/foo.ts:42</div>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('does not decorate inside an existing link or wiki chip (no stacked affordance)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<a href="https://example.com">src/foo.ts:42</a>' +
        '<span data-wiki-link="1">src/foo.ts:42</span>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('does not re-enter its own already-decorated chip', () => {
    resolve('src/foo.ts', true)
    const root = mount('<p>See src/foo.ts:42 here.</p>')
    applyCodeRefs(root, vi.fn())
    applyCodeRefs(root, vi.fn()) // second pass — must be a no-op, not a nested re-wrap
    expect(root.querySelectorAll('[data-code-ref="1"]')).toHaveLength(1)
    expect(root.textContent).toBe('See src/foo.ts:42 here.')
  })

  it('does not decorate inside a math block/inline', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<div data-type="math-block">src/foo.ts:42</div>' +
        '<span data-type="math-inline">src/foo.ts:42</span>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('does not chip a code reference inside a decorated raw HTML link (Task 654)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p>See <span class="vmde-html-link" data-vmde-html-link="1" data-vmde-html-link-href="https://example.com/x">src/foo.ts:42</span> here.</p>',
    )
    applyCodeRefs(root, vi.fn())
    expect(root.querySelector('[data-code-ref]')).toBeNull()
  })

  it('does not chip a code reference in a revealed raw HTML link body (Task 654)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p>See <span data-type="html-inline"><code>&lt;a href="https://example.com/x"&gt;</code></span>src/foo.ts:42<span data-type="html-inline"><code>&lt;/a&gt;</code></span> and src/foo.ts:43 here.</p>',
    )
    applyCodeRefs(root, vi.fn())
    const chips = root.querySelectorAll('[data-code-ref="1"]')
    expect(chips).toHaveLength(1)
    expect(chips[0].textContent).toBe('src/foo.ts:43')
  })

  it('skips decorating the block that currently holds the caret (avoids DOM churn while typing)', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p data-block="0">See src/foo.ts:42 here.</p>' +
        '<p data-block="1">Also src/foo.ts:42 here.</p>',
    )
    const editing = root.children[0].firstChild! // text node inside the FIRST <p>
    const sel = window.getSelection()
    const r = document.createRange()
    r.setStart(editing, 4)
    r.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(r)

    applyCodeRefs(root, vi.fn())
    const chips = root.querySelectorAll('[data-code-ref="1"]')
    expect(chips).toHaveLength(1) // only the SECOND block's ref got chipped
    expect(root.children[0].querySelector('[data-code-ref]')).toBeNull()
    expect(root.children[1].querySelector('[data-code-ref]')).not.toBeNull()
  })

  it('decorates the WHOLE inline code span, attribute-only — no DOM injection inside <code>', () => {
    resolve('src/foo.ts', true)
    const root = mount('<p>See <code>src/foo.ts:42</code> here.</p>')
    applyCodeRefs(root, vi.fn())
    const code = root.querySelector('code')!
    expect(code.children).toHaveLength(0) // no nested span
    expect(code.textContent).toBe('src/foo.ts:42') // literal text untouched
    expect(code.classList.contains('vmde-code-ref')).toBe(true)
    expect(code.getAttribute('data-code-ref-path')).toBe('src/foo.ts')
    expect(code.getAttribute('data-code-ref-line')).toBe('42')
  })

  it('does NOT decorate an inline code span where the ref is only PART of the content', () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<p>See <code>see src/foo.ts:42 here</code> for details.</p>',
    )
    applyCodeRefs(root, vi.fn())
    const code = root.querySelector('code')!
    expect(code.classList.contains('vmde-code-ref')).toBe(false)
    expect(code.hasAttribute('data-code-ref')).toBe(false)
  })

  it("does not treat a fenced code BLOCK's <code> as inline code", () => {
    resolve('src/foo.ts', true)
    const root = mount(
      '<pre><code class="language-ts">src/foo.ts:42</code></pre>',
    )
    applyCodeRefs(root, vi.fn())
    const code = root.querySelector('code')!
    expect(code.classList.contains('vmde-code-ref')).toBe(false)
  })

  // Task 229 regression — see mountInEditorRoot's own comment for the bug this pins down.
  describe('inside Vditor\'s real <pre class="vditor-reset"> editor root', () => {
    it('still decorates prose text (the editor root itself is not a fenced code block)', () => {
      resolve('src/foo.ts', true)
      const root = mountInEditorRoot('<p>See src/foo.ts:42 here.</p>')
      applyCodeRefs(root, vi.fn())
      expect(root.querySelector('[data-code-ref="1"]')).not.toBeNull()
      expect(root.textContent).toBe('See src/foo.ts:42 here.')
    })

    it('still decorates inline code (its own nearest <pre> is the reset root, not a code fence)', () => {
      resolve('src/foo.ts', true)
      const root = mountInEditorRoot(
        '<p>See <code>src/foo.ts:42</code> here.</p>',
      )
      applyCodeRefs(root, vi.fn())
      const code = root.querySelector('code')!
      expect(code.classList.contains('vmde-code-ref')).toBe(true)
      expect(code.children).toHaveLength(0)
    })

    it('still excludes a REAL fenced code block nested inside the reset root', () => {
      resolve('src/foo.ts', true)
      const root = mountInEditorRoot(
        '<pre class="vditor-ir__marker--pre"><code>src/foo.ts:42</code></pre>',
      )
      applyCodeRefs(root, vi.fn())
      expect(root.querySelector('[data-code-ref]')).toBeNull()
    })
  })
})

// Task 173/174 scoping: observeCodeRefs re-decorates via a block-scoped path
// (`applyCodeRefsWithin`), not always a full `applyCodeRefs` walk — a SEPARATE code path from the
// `applyCodeRefs` tests above, with its own caret guard that needs its own coverage (a bug found
// during self-review: the scoped path originally forgot to re-check the caret at all).
// `applyCodeRefsWithin` is called directly below rather than through the real MutationObserver/rAF
// plumbing — which branch a given mutation resolves to is mutation-scope.test.ts's job (already
// covered there); this suite tests only the guard itself, deterministically.
describe('observeCodeRefs (task 173/174 scoping)', () => {
  let dispose: (() => void) | null = null
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCodeRefResolutionForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    dispose?.()
    dispose = null
    document.body.innerHTML = ''
  })

  // A `.vditor-reset` root with 2 top-level `[data-block]` paragraphs, matching Vditor's real IR
  // shape closely enough for mutation-scope.ts's topLevelBlock climb (mirrors code-source.test.ts's
  // own `irWithTwoBlocks`).
  function irWithTwoParagraphs(): {
    ir: HTMLElement
    blockA: HTMLElement
    blockB: HTMLElement
  } {
    const ir = document.createElement('pre')
    ir.className = 'vditor-reset'
    const blockA = document.createElement('p')
    blockA.setAttribute('data-block', '0')
    blockA.textContent = 'See src/foo.ts:42 here.'
    const blockB = document.createElement('p')
    blockB.setAttribute('data-block', '1')
    blockB.textContent = 'Also src/bar.ts:1 here.'
    ir.append(blockA, blockB)
    document.body.appendChild(ir)
    return { ir, blockA, blockB }
  }

  it('the initial mount pass (a full walk) decorates every block', () => {
    resolve('src/foo.ts', true)
    resolve('src/bar.ts', true)
    const { blockA, blockB, ir } = irWithTwoParagraphs()
    dispose = observeCodeRefs(ir, vi.fn())
    expect(blockA.querySelector('[data-code-ref]')).not.toBeNull()
    expect(blockB.querySelector('[data-code-ref]')).not.toBeNull()
  })

  it('applyCodeRefsWithin decorates a resolved ref when there is no caret in the way', () => {
    resolve('src/foo.ts', true)
    const { blockA } = irWithTwoParagraphs()
    applyCodeRefsWithin(blockA, vi.fn())
    expect(blockA.querySelector('[data-code-ref]')).not.toBeNull()
  })

  it('applyCodeRefsWithin (the scoped path a same-block keystroke actually takes) also respects the caret guard', () => {
    // Regression found during self-review: this function originally had NO caret check at all —
    // only the full-walk `applyCodeRefs` did — so a same-block keystroke (the common case,
    // routed through `scopeMutations`' scoped branch) would churn the DOM under the live caret
    // on every keystroke, exactly what the guard exists to prevent (see the module doc). Called
    // directly (not through the real MutationObserver) so this is a fast, deterministic unit
    // test of the guard itself, not of scopeMutations' branch selection (mutation-scope.test.ts's
    // job) or of the rAF-coalescing plumbing (already covered elsewhere in this file).
    resolve('src/foo.ts', true)
    const { blockA } = irWithTwoParagraphs()

    const sel = window.getSelection()
    const r = document.createRange()
    r.setStart(blockA, 0)
    r.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(r)

    applyCodeRefsWithin(blockA, vi.fn())
    expect(blockA.querySelector('[data-code-ref]')).toBeNull()
  })
})

// Task 733: a fake unit feed over the IR root (`ir`); the observers under test watch the wider
// `app` that holds it, as `boot/finish-init.ts` binds them. `emit` plays one per-frame unit change.
function fakeFeed(ir: HTMLElement, live = true) {
  const listeners = new Set<(change: UnitsChange) => void>()
  const feed: UnitFeed = {
    root: ir,
    isLive: () => live,
    liveUnitOf: () => undefined,
    liveUnits: () => (live ? [] : undefined),
    onUnitsChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    confirmNow: () => live,
    confirmedLines: () => undefined,
  }
  provideUnitFeed(window, feed)
  return {
    emit(change: Partial<UnitsChange> & Pick<UnitsChange, 'whole'>) {
      const full: UnitsChange = {
        cause: 'mutation',
        changed: [],
        structural: [],
        ...change,
      }
      for (const listener of Array.from(listeners)) listener(full)
    },
  }
}

function cellUnit(cell: HTMLElement): LiveUnit {
  return {
    el: cell,
    members: [cell],
    kind: 'cell',
    top: cell.closest('table') as HTMLElement,
  }
}

// Three 2-cell tables and a paragraph: top-level `[data-block]` children of the IR root.
function irFixture(cellHtml: string) {
  const app = document.createElement('div')
  const table = (n: number) =>
    `<table data-block="${n}"><tbody><tr><td>${cellHtml}</td><td>${cellHtml}</td></tr></tbody></table>`
  app.innerHTML = `<pre class="vditor-reset" contenteditable="true">${table(0)}${table(1)}${table(2)}<p data-block="3">tail</p></pre>`
  document.body.appendChild(app)
  const ir = app.firstElementChild as HTMLElement
  const tables = Array.from(ir.querySelectorAll<HTMLElement>('table'))
  const cells = tables.map((t) => Array.from(t.querySelectorAll('td')))
  const para = ir.querySelector('p') as HTMLElement
  return { app, ir, tables, cells, para }
}

function placeCaret(node: Node, offset = 0): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

// Deterministic frames: the coalescers' leading edge is synchronous, the trailing edge waits here.
let frameCallbacks: FrameRequestCallback[] = []
const fireFrame = () => {
  const callbacks = frameCallbacks
  frameCallbacks = []
  for (const callback of callbacks) callback(0)
}
const stubFrames = () => {
  frameCallbacks = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frameCallbacks.push(cb)
    return frameCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
}
// Lets the MutationObserver callbacks of earlier writes run.
const flushRecords = async () => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve()
}

const REF = 'src/foo.ts:1'
const CHIP = '[data-code-ref="1"]'

describe('observeCodeRefs on unit feed changes (Task 733)', () => {
  let dispose: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCodeRefResolutionForTests()
    stubFrames()
    window.getSelection()?.removeAllRanges()
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
    provideUnitFeed(window, undefined)
    vi.unstubAllGlobals()
    vi.useRealTimers()
    window.getSelection()?.removeAllRanges()
    document.body.replaceChildren()
  })

  // Resolved refs everywhere, decorated by the mount pass; `fresh` then undoes one cell, as a respin does.
  function setup() {
    resolve('src/foo.ts', true)
    const fixture = irFixture(REF)
    const feed = fakeFeed(fixture.ir)
    dispose = observeCodeRefs(fixture.app, vi.fn())
    fireFrame()
    const fresh = (cell: HTMLElement) => {
      cell.innerHTML = `<span>${REF}</span>`
    }
    return { ...fixture, feed, fresh }
  }

  it('decorates the top-level block of the changed cell and skips its own pass for records inside the feed root', async () => {
    const { app, ir, cells, feed, fresh } = setup()
    fresh(cells[1][0])
    fresh(cells[2][0])
    const spies = [app, ir].map((el) => vi.spyOn(el, 'querySelectorAll'))

    feed.emit({ whole: false, changed: [cellUnit(cells[1][0])] })
    fireFrame()
    expect(cells[1][0].querySelector(CHIP)).not.toBeNull()
    expect(cells[2][0].querySelector(CHIP)).toBeNull()

    await flushRecords()
    fireFrame()
    expect(cells[2][0].querySelector(CHIP)).toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the whole-table caret skip (Q-30): the caret table stays undecorated, the other changed table is decorated', () => {
    const { cells, feed, fresh } = setup()
    placeCaret(cells[0][0].firstChild as Node, 0)
    fresh(cells[0][1])
    fresh(cells[1][0])
    fresh(cells[2][0])

    feed.emit({
      whole: false,
      changed: [cellUnit(cells[0][1]), cellUnit(cells[1][0])],
    })
    fireFrame()
    expect(cells[0][1].querySelector(CHIP)).toBeNull()
    expect(cells[1][0].querySelector(CHIP)).not.toBeNull()
    expect(cells[2][0].querySelector(CHIP)).toBeNull()
  })

  it('does no walk when a selection change keeps the caret in the same top-level block', async () => {
    const { app, ir, cells, fresh } = setup()
    placeCaret(cells[0][0].firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    fresh(cells[2][0])
    await flushRecords()
    fireFrame()
    const spies = [app, ir].map((el) => vi.spyOn(el, 'querySelectorAll'))

    placeCaret(cells[0][1].firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    expect(cells[2][0].querySelector(CHIP)).toBeNull()
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('decorates only the block the caret left when it moves from block X to block Y', async () => {
    const { cells, para, fresh } = setup()
    placeCaret(cells[0][0].firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    fresh(cells[0][1])
    fresh(cells[2][0])
    await flushRecords()
    fireFrame()

    placeCaret(para.firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    expect(cells[0][1].querySelector(CHIP)).not.toBeNull()
    expect(cells[2][0].querySelector(CHIP)).toBeNull()
  })

  it('runs the full pass for a whole change', () => {
    const { cells, feed, fresh } = setup()
    fresh(cells[1][0])
    fresh(cells[2][0])
    feed.emit({ whole: true, cause: 'rebind' })
    fireFrame()
    expect(cells[1][0].querySelector(CHIP)).not.toBeNull()
    expect(cells[2][0].querySelector(CHIP)).not.toBeNull()
  })

  it('keeps the full pass for a host resolution reply', () => {
    const fixture = irFixture(REF)
    fakeFeed(fixture.ir)
    const post = vi.fn()
    dispose = observeCodeRefs(fixture.app, post)
    fireFrame()
    expect(fixture.app.querySelector(CHIP)).toBeNull()

    vi.advanceTimersByTime(50)
    applyCodeRefResolution(post.mock.calls[0][0].requestId, ['src/foo.ts'])
    fireFrame()
    for (const row of fixture.cells)
      for (const cell of row) expect(cell.querySelector(CHIP)).not.toBeNull()
  })

  it('keeps the full observer pass with no feed', async () => {
    resolve('src/foo.ts', true)
    const { app, cells } = irFixture(REF)
    dispose = observeCodeRefs(app, vi.fn())
    fireFrame()
    cells[2][0].innerHTML = `<span>${REF}</span>`
    await flushRecords()
    fireFrame()
    expect(cells[2][0].querySelector(CHIP)).not.toBeNull()
  })

  it('decorates the block a whole pass skipped once the caret leaves it', () => {
    const { cells, feed, fresh, para } = setup()
    placeCaret(cells[1][0].firstChild as Node, 0)
    fresh(cells[1][1])
    // The full pass skips the caret table; no selection change has run since it started.
    feed.emit({ whole: true, cause: 'rebind' })
    fireFrame()
    expect(cells[1][1].querySelector(CHIP)).toBeNull()

    placeCaret(para.firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    expect(cells[1][1].querySelector(CHIP)).not.toBeNull()
  })

  it('tracks the caret block while the feed is not live', () => {
    resolve('src/foo.ts', true)
    const fixture = irFixture(REF)
    fakeFeed(fixture.ir, false)
    dispose = observeCodeRefs(fixture.app, vi.fn())
    fireFrame()
    placeCaret(fixture.cells[1][0].firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    fixture.cells[1][1].innerHTML = `<span>${REF}</span>`
    // The model becomes live (a rebuild finished) between the two selection changes.
    fakeFeed(fixture.ir)

    placeCaret(fixture.para.firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    expect(fixture.cells[1][1].querySelector(CHIP)).not.toBeNull()
  })

  it('gives a chip decorated on caret leave its link semantics', async () => {
    const { app, cells, para, fresh } = setup()
    const stopLinks = observeLinkLikeSemantics(app)
    placeCaret(cells[0][0].firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    fresh(cells[0][1])
    await flushRecords()
    fireFrame()

    placeCaret(para.firstChild as Node, 0)
    document.dispatchEvent(new Event('selectionchange'))
    fireFrame()
    await flushRecords()
    const chip = cells[0][1].querySelector<HTMLElement>(CHIP)
    expect(chip?.getAttribute('role')).toBe('link')
    expect(chip?.getAttribute('aria-label')).toContain('Open code reference')
    stopLinks()
  })
})
