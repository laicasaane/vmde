// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filterEmoji,
  installEmojiPicker,
  type EmojiEntry,
} from './emoji-picker'

// Task 733 / 036 (block "036 keyboard handoff"): the capture and the Escape→Tab origin are replaced by
// controllable doubles. They delegate to the real modules unless a test sets `handoff.*`, so the tests
// above keep today's behaviour.
const handoff = vi.hoisted(() => ({
  active: false,
  captures: [] as Range[],
  snapshots: 0,
  captureResult: null as unknown,
  origin: null as {
    range: Range
    backward: boolean
    editor: HTMLElement
  } | null,
  consumable: false,
  consumeCalls: 0,
  applied: [] as unknown[],
}))
vi.mock('./emoji-insertion', async (importOriginal) => {
  const real = await importOriginal<typeof import('./emoji-insertion')>()
  return {
    ...real,
    captureEmojiInsertion: (range: Range) => {
      if (!handoff.active) return real.captureEmojiInsertion(range)
      handoff.captures.push(range.cloneRange())
      // The real capture reads `snapshotMarkdown()` first and then writes a marker text node at the
      // caret, which leaves the text node split (the row-7 writer).
      handoff.snapshots++
      const node = range.startContainer
      if (
        node instanceof Text &&
        range.startOffset > 0 &&
        range.startOffset < node.length
      )
        node.splitText(range.startOffset)
      return handoff.captureResult as ReturnType<
        typeof real.captureEmojiInsertion
      >
    },
    applyEmojiInsertion: async (bookmark: unknown, emoji: string) => {
      if (!handoff.active)
        return real.applyEmojiInsertion(bookmark as never, emoji)
      handoff.applied.push(bookmark)
      return null
    },
  }
})
vi.mock('./escape-toolbar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./escape-toolbar')>()
  return {
    ...real,
    peekConsumedToolbarSelectionOrigin: () => {
      if (!handoff.active) return real.peekConsumedToolbarSelectionOrigin()
      const origin = handoff.consumable ? handoff.origin : null
      return origin ? { ...origin, range: origin.range.cloneRange() } : null
    },
    consumeToolbarSelectionOrigin: () => {
      if (!handoff.active) return real.consumeToolbarSelectionOrigin()
      handoff.consumeCalls++
      const consumed = handoff.consumable
      handoff.consumable = false
      return consumed
    },
  }
})

const entries: EmojiEntry[] = [
  {
    emoji: '🫩',
    group: 'Smileys & Emotion',
    keywords: ['bags', 'exhausted', 'tired'],
    name: 'face with bags under eyes',
  },
  {
    emoji: '🧑‍🤝‍🧑',
    group: 'People & Body',
    keywords: ['friends', 'hold hands'],
    name: 'people holding hands',
  },
]

describe('filterEmoji', () => {
  it('finds names, CLDR keywords, and a literal complete emoji sequence without splitting it', () => {
    expect(filterEmoji(entries, 'EXHAUSTED')).toEqual([entries[0]])
    expect(filterEmoji(entries, '🧑‍🤝‍🧑')).toEqual([entries[1]])
  })

  it('returns no matches for a query absent from all names and keywords', () => {
    expect(filterEmoji(entries, 'not-a-real-emoji')).toEqual([])
  })
})

// Task 733 (task 002): main.css raises the toolbar through `.vditor-toolbar.vmde-emoji-open`; the
// picker writes the class from its panel's inline `display`, whoever changes it.
describe('installEmojiPicker open state', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function build(initialDisplay?: string) {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const item = document.createElement('div')
    item.className = 'vditor-toolbar__item'
    item.innerHTML =
      '<button data-type="emoji" class="vditor-tooltipped"></button><div class="vditor-panel vditor-panel--arrow"></div>'
    toolbar.append(item)
    document.body.append(toolbar)
    const original = item.querySelector<HTMLElement>('.vditor-panel')!
    if (initialDisplay) original.style.display = initialDisplay
    return { toolbar, item }
  }
  const flush = () => Promise.resolve()
  const panelOf = (item: HTMLElement) =>
    item.querySelector<HTMLElement>('.vmde-emoji-picker')!

  it('follows the panel display set directly, also when it is closed from outside', async () => {
    const { toolbar, item } = build()
    const dispose = installEmojiPicker(toolbar)
    const panel = panelOf(item)
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(false)

    panel.style.display = 'block'
    await flush()
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(true)

    // Vditor's hidePanel and the toolbar dismiss write `display: none` directly.
    panel.style.display = 'none'
    await flush()
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(false)
    dispose()
  })

  it('sets the class at install when the panel is already open', () => {
    const { toolbar } = build('block')
    const dispose = installEmojiPicker(toolbar)
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(true)
    dispose()
  })

  it('runs no callback after dispose and clears the class', async () => {
    const { toolbar, item } = build()
    const dispose = installEmojiPicker(toolbar)
    const panel = panelOf(item)
    panel.style.display = 'block'
    await flush()
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(true)
    dispose()
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(false)
    panel.style.display = 'block'
    await flush()
    expect(toolbar.classList.contains('vmde-emoji-open')).toBe(false)
  })
})

// Task 733 / 036 (F7b, row 7): Escape and Tab do no Emoji work. A keyboard activation after an
// Escape→Tab session resolves once, from the saved origin; a stale or unusable origin gives a null
// bookmark and the generated click does not fall back to the widened live range. Pointer activation
// consumes the keyboard origin and captures the live range once.
describe('036 keyboard handoff', () => {
  const BOOKMARK = { kind: '036-bookmark' }
  let editor: HTMLElement
  let toolbar: HTMLElement
  let trigger: HTMLElement
  let dispose: () => void
  let text: Text

  const textNodes = () => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let count = 0
    while (walker.nextNode()) count++
    return count
  }
  const settle = async () => {
    for (let index = 0; index < 6; index++)
      await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const key = (target: EventTarget, name: string) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    )
  const caret = (offset: number) => {
    const range = document.createRange()
    range.setStart(text, offset)
    range.collapse(true)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return range
  }
  /** The live selection Escape widens to the block (`selection-scope.ts`). */
  const widen = () => {
    const range = document.createRange()
    range.selectNodeContents(editor)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return range
  }
  const sameRange = (a: Range, b: Range) =>
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  const pickFirstTile = async () => {
    await settle()
    document
      .querySelector<HTMLButtonElement>('.vmde-emoji-picker__tile')
      ?.click()
    await settle()
  }

  beforeEach(() => {
    Object.assign(handoff, {
      active: true,
      captures: [],
      snapshots: 0,
      captureResult: BOOKMARK,
      origin: null,
      consumable: false,
      consumeCalls: 0,
      applied: [],
    })
    if (!window.requestAnimationFrame)
      window.requestAnimationFrame = (callback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ entries }) })),
    )
    editor = document.createElement('div')
    editor.className = 'vditor-ir'
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    editor.innerHTML = '<ul><li>alpha beta</li></ul>'
    text = editor.querySelector('li')!.firstChild as Text
    toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const item = document.createElement('div')
    item.className = 'vditor-toolbar__item'
    item.innerHTML =
      '<button data-type="emoji" class="vditor-tooltipped"></button><div class="vditor-panel vditor-panel--arrow"></div>'
    toolbar.append(item)
    document.body.append(toolbar, editor)
    trigger = item.querySelector<HTMLElement>('[data-type="emoji"]')!
    ;(window as unknown as { vditor: unknown }).vditor = {
      vditor: {
        currentMode: 'ir',
        ir: { element: editor },
        options: { cdn: 'https://vditor.invalid' },
        toolbar: { elements: {} },
      },
      getCurrentMode: () => 'ir',
    }
    dispose = installEmojiPicker(toolbar)
    editor.focus()
  })
  afterEach(() => {
    dispose()
    handoff.active = false
    vi.unstubAllGlobals()
    delete (window as unknown as { vditor?: unknown }).vditor
    document.body.replaceChildren()
  })

  it('Escape then Tab with the capture stubbed to null: no capture, no snapshotMarkdown, text nodes unchanged', () => {
    handoff.captureResult = null
    caret(3)
    const before = textNodes()

    key(editor, 'Escape')
    key(editor, 'Tab')

    expect(handoff.captures).toHaveLength(0)
    expect(handoff.snapshots).toBe(0)
    expect(textNodes()).toBe(before)
  })

  it.each([
    ['Enter', 'a caret inside the text'],
    [' ', 'a caret inside the text'],
    ['Enter', 'a collapsed editor-root start edge'],
    [' ', 'a collapsed editor-root start edge'],
  ])(
    'Escape→Tab, then %j and the generated click: one resolution with the origin range (%s)',
    async (activation, where) => {
      const origin =
        where === 'a caret inside the text' ? caret(6) : document.createRange()
      if (where !== 'a caret inside the text') {
        origin.setStart(editor, 0)
        origin.collapse(true)
      }
      handoff.origin = { range: origin.cloneRange(), backward: false, editor }
      handoff.consumable = true
      // jsdom moves the selection to a focused button (a browser does not): focus first.
      trigger.focus()
      widen()

      key(trigger, activation)
      trigger.click()
      await pickFirstTile()

      expect(handoff.captures).toHaveLength(1)
      expect(sameRange(handoff.captures[0], origin)).toBe(true)
      expect(handoff.applied).toEqual([BOOKMARK])
    },
  )

  it.each([
    ['a stale origin', 'stale'],
    ['editor-root endpoints the origin capture rejected', 'root'],
  ])(
    '%s: no live-range capture on the generated click, a null bookmark, and the insertion declines',
    async (_label) => {
      // The handoff was consumed, but its origin is no longer usable: `peek` gives null.
      handoff.origin = null
      handoff.consumable = true
      // jsdom moves the selection to a focused button (a browser does not): focus first.
      trigger.focus()
      widen()

      key(trigger, 'Enter')
      trigger.click()
      await pickFirstTile()

      expect(handoff.captures).toHaveLength(0)
      expect(handoff.applied).toHaveLength(0)
    },
  )

  it('a failed mapping of a valid origin is not retried on the generated click', async () => {
    const origin = caret(6)
    handoff.origin = { range: origin.cloneRange(), backward: false, editor }
    handoff.consumable = true
    handoff.captureResult = null
    trigger.focus()
    widen()

    key(trigger, 'Enter')
    trigger.click()
    await pickFirstTile()

    expect(handoff.captures).toHaveLength(1)
    expect(sameRange(handoff.captures[0], origin)).toBe(true)
    expect(handoff.applied).toHaveLength(0)
  })

  it('pointer activation consumes the keyboard origin and captures the live range once', async () => {
    const origin = caret(2)
    handoff.origin = { range: origin.cloneRange(), backward: false, editor }
    handoff.consumable = true
    const live = caret(8)

    trigger.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    trigger.click()
    await pickFirstTile()

    expect(handoff.consumeCalls).toBeGreaterThanOrEqual(1)
    expect(handoff.consumable).toBe(false)
    expect(handoff.captures).toHaveLength(1)
    expect(sameRange(handoff.captures[0], live)).toBe(true)
    expect(handoff.applied).toEqual([BOOKMARK])
  })
})
