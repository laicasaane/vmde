// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  filterEmoji,
  installEmojiPicker,
  type EmojiEntry,
} from './emoji-picker'

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
