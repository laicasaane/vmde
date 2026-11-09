// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateCaret } from './caret'
import {
  CODE,
  HR,
  PARA,
  caretBlockIndex,
  caretIn,
  chain,
  editorWithBlocks,
} from './gap-nav-fixture'
import { setupGapNav } from './gap-nav'

// The DECISION half of the arrow mover against stubbed layout (see gap-nav-fixture.ts for why the
// geometry has to be faked at all). What this can prove: which boundary is acted on, what lands in
// the DOM, and that a non-boundary key is left alone. What it cannot: that the caret was really on
// the block's edge LINE — that is real layout, and lives in media-src/e2e/gap-cursor.spec.ts.

let dispose: () => void

beforeEach(() => {
  document.body.replaceChildren()
})
afterEach(() => {
  dispose?.()
  invalidateCaret()
  ;(window as unknown as { vditor?: unknown }).vditor = undefined
})

const arrow = (down: boolean, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', {
    key: down ? 'ArrowDown' : 'ArrowUp',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(e)
  return e
}

const setup = (html: string) => {
  const editor = editorWithBlocks(html)
  dispose = setupGapNav(() => editor)
  return editor
}

describe('setupGapNav — arrows across void boundaries', () => {
  it('ArrowDown from a paragraph above a rule+fence stops between the rule and the fence', () => {
    const editor = setup(`${PARA}${HR}${CODE}`)
    caretIn(editor.children[0] as HTMLElement)
    const e = arrow(true)
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p | code-block')
    expect(caretBlockIndex(editor)).toBe(2) // in the manufactured gap
    expect(editor.children[2].hasAttribute('data-vmde-gap')).toBe(true)
  })

  it('ArrowUp out of a leading code block opens a line ABOVE the document', () => {
    const editor = setup(`${CODE}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    const e = arrow(false)
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | code-block | p')
    expect(caretBlockIndex(editor)).toBe(0)
  })

  it('steps ACROSS a rule when the boundary beyond it needs no gap (task 100)', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    const e = arrow(true)
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p') // nothing spliced
    expect(caretBlockIndex(editor)).toBe(2) // landed past the rule
  })

  it('leaves the END of the document to the trailing invariant', () => {
    const editor = setup(`${PARA}${CODE}`)
    caretIn(editor.children[1] as HTMLElement)
    const e = arrow(true)
    expect(e.defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | code-block')
  })

  it('does nothing between two plain paragraphs', () => {
    const editor = setup(`${PARA}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    const e = arrow(true)
    expect(e.defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | p')
  })

  it('ignores arrows with a modifier (those are selection / word / document moves)', () => {
    const editor = setup(`${PARA}${HR}${CODE}`)
    caretIn(editor.children[0] as HTMLElement)
    for (const init of [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      expect(arrow(true, init).defaultPrevented).toBe(false)
    }
    expect(chain(editor)).toBe('p | hr | code-block')
  })

  it('ignores a non-collapsed selection', () => {
    const editor = setup(`${PARA}${HR}${CODE}`)
    const r = document.createRange()
    r.selectNodeContents(editor.children[0])
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(r)
    expect(arrow(true).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | hr | code-block')
  })

  it('stops listening once disposed', () => {
    const editor = setup(`${PARA}${HR}${CODE}`)
    caretIn(editor.children[0] as HTMLElement)
    dispose()
    expect(arrow(true).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | hr | code-block')
  })
})

// Task 714 (D3) — Shift+ArrowDown/Up over a rule moves the selection FOCUS to where the plain arrow
// would put the caret, keeping the anchor. The native move leaves the focus on the editor root (a
// rule has no text node). A boundary that needs a spliced gap paragraph stays native: a selection
// key must not edit the document.
describe('setupGapNav — Shift+Arrow over a rule (task 714)', () => {
  const selectionState = () => {
    const s = window.getSelection()!
    return {
      anchorNode: s.anchorNode,
      anchorOffset: s.anchorOffset,
      focusNode: s.focusNode,
    }
  }
  const blockOf = (editor: HTMLElement, node: Node | null) =>
    Array.from(editor.children).findIndex(
      (child) => node && child.contains(node),
    )

  it('Shift+ArrowDown extends the focus past the rule into the next paragraph, anchor kept', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    const before = selectionState()
    const e = arrow(true, { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p')
    const after = selectionState()
    expect(after.anchorNode).toBe(before.anchorNode)
    expect(after.anchorOffset).toBe(before.anchorOffset)
    expect(blockOf(editor, after.focusNode)).toBe(2)
    expect(window.getSelection()!.isCollapsed).toBe(false)
  })

  it('Shift+ArrowUp extends the focus back past the rule, anchor kept', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[2] as HTMLElement)
    const before = selectionState()
    const e = arrow(false, { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p')
    const after = selectionState()
    expect(after.anchorNode).toBe(before.anchorNode)
    expect(blockOf(editor, after.focusNode)).toBe(0)
  })

  it('judges the edge line at the moving focus of an existing selection', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    const s = window.getSelection()!
    s.extend(editor.children[0].firstChild!, 1)
    const anchorNode = s.anchorNode
    const e = arrow(true, { shiftKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(s.anchorNode).toBe(anchorNode)
    expect(blockOf(editor, s.focusNode)).toBe(2)
  })

  it('leaves Shift+Arrow native when no rule is crossed', () => {
    const editor = setup(`${PARA}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    expect(arrow(true, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | p')
  })

  it('never splices a gap paragraph for a Shift selection', () => {
    const editor = setup(`${PARA}${HR}${CODE}`)
    caretIn(editor.children[0] as HTMLElement)
    expect(arrow(true, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | hr | code-block')
  })

  it('does not take Shift+Ctrl, Shift+Alt or Shift+Meta arrows', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[0] as HTMLElement)
    for (const extra of [
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ])
      expect(arrow(true, { shiftKey: true, ...extra }).defaultPrevented).toBe(
        false,
      )
  })
})

// Task 608 — Ctrl+Home (Cmd+ArrowUp on a Mac) on a document whose first block is atomic. Vditor's
// native document-start move lands on the bare editable root there (a rule has no text node), so
// the mover places the caret in the boundary-0 gap instead. IR only.
const TOC =
  '<div data-block="0" class="vditor-toc" contenteditable="false"><span>[toc]</span></div>'

const homeKey = (init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', {
    key: 'Home',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  document.dispatchEvent(e)
  return e
}

const setMode = (mode: string) => {
  ;(
    window as unknown as { vditor: { vditor: { currentMode: string } } }
  ).vditor.vditor.currentMode = mode
}

describe('setupGapNav — document start on an atomic-first document (task 608)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('Ctrl+Home on an HR-first document puts the caret in the boundary-0 gap', () => {
    const editor = setup(`${HR}${PARA}${PARA}`)
    caretIn(editor.children[2] as HTMLElement)
    const e = homeKey()
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p | p')
    expect(caretBlockIndex(editor)).toBe(0)
    expect(editor.children[0].hasAttribute('data-vmde-gap')).toBe(true)
    // Only the invisible seed: nothing a serializer could turn into Markdown.
    expect((editor.children[0].textContent ?? '').replace(/\u200b/g, '')).toBe(
      '',
    )
  })

  it('Ctrl+Home on a TOC-first document puts the caret in the boundary-0 gap', () => {
    const editor = setup(`${TOC}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    const e = homeKey()
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | div | p')
    expect(caretBlockIndex(editor)).toBe(0)
    expect(editor.children[0].hasAttribute('data-vmde-gap')).toBe(true)
  })

  it('Cmd+ArrowUp is the document-start chord on a Mac', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    const editor = setup(`${HR}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    const e = arrow(false, { metaKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr | p')
    expect(caretBlockIndex(editor)).toBe(0)
  })

  it('leaves a paragraph-first document to the native move (control)', () => {
    const editor = setup(`${PARA}${HR}${PARA}`)
    caretIn(editor.children[2] as HTMLElement)
    const e = homeKey()
    expect(e.defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('p | hr | p')
  })

  it('an HR-only document lands in the boundary-0 gap (decision 3)', () => {
    const editor = setup(HR)
    caretIn(editor.children[0] as HTMLElement)
    const e = homeKey()
    expect(e.defaultPrevented).toBe(true)
    expect(chain(editor)).toBe('p | hr')
    expect(caretBlockIndex(editor)).toBe(0)
  })

  it('a second Ctrl+Home while in the gap adds no second gap', () => {
    const editor = setup(`${HR}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    homeKey()
    homeKey()
    expect(chain(editor)).toBe('p | hr | p')
    expect(caretBlockIndex(editor)).toBe(0)
  })

  it('does not pre-empt Ctrl+Shift+Home (selection extend)', () => {
    const editor = setup(`${HR}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    expect(homeKey({ shiftKey: true }).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('hr | p')
  })

  it('does not pre-empt plain Home or Alt+Ctrl+Home', () => {
    const editor = setup(`${HR}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    expect(homeKey({ ctrlKey: false }).defaultPrevented).toBe(false)
    expect(homeKey({ altKey: true }).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('hr | p')
  })

  it('is IR only: WYSIWYG and source-view modes are not affected', () => {
    for (const mode of ['wysiwyg', 'sv']) {
      const editor = setup(`${HR}${PARA}`)
      setMode(mode)
      caretIn(editor.children[1] as HTMLElement)
      expect(homeKey().defaultPrevented).toBe(false)
      expect(chain(editor)).toBe('hr | p')
      dispose()
    }
  })

  it('does not pre-empt during IME composition', () => {
    const editor = setup(`${HR}${PARA}`)
    caretIn(editor.children[1] as HTMLElement)
    expect(homeKey({ isComposing: true }).defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('hr | p')
  })

  it('does nothing when the caret is outside the editor', () => {
    const editor = setup(`${HR}${PARA}`)
    const outside = document.createElement('input')
    document.body.append(outside)
    outside.focus()
    window.getSelection()?.removeAllRanges()
    expect(homeKey().defaultPrevented).toBe(false)
    expect(chain(editor)).toBe('hr | p')
  })
})
