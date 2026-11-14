// @vitest-environment jsdom

// Task 733 / 012-8: in full Preview the inner `.vditor-reset` is the scroller, so Vditor's own
// Outline click (which scrolls `.vditor-preview`) does nothing there. A click on an entry goes
// through `scrollToHeadingIndex` instead; the collapse arrow, IR, WYSIWYG and Split keep Vditor's
// handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Vditor from 'vditor'
import { setupOutlineFlash } from './outline'

const HEADINGS =
  '<h1 id="title_0">Title</h1><p>a</p><h2 id="far_2">Far</h2><p>b</p>'
const ENTRIES =
  '<ul><li><span data-target-id="title_0"><svg class="vditor-outline__action"></svg><span>Title</span></span>' +
  '<ul><li><span data-target-id="far_2"><svg></svg><span>Far</span></span></li></ul></li></ul>'

function fixture(options: { preview: boolean; sourcePaneHidden: boolean }) {
  document.body.innerHTML =
    `<div class="vditor-content"${options.sourcePaneHidden ? ' data-vmde-source-pane="hidden"' : ''}>` +
    `<div class="vditor-ir"><pre class="vditor-reset">${HEADINGS.replace(/id="/g, 'id="ir-')}</pre></div>` +
    `<div class="vditor-preview" style="display: ${options.preview ? 'block' : 'none'}">` +
    `<div class="vditor-reset">${HEADINGS}</div></div>` +
    '<div class="vditor-outline"><div class="vditor-outline__content"></div></div></div>'
  const list = document.querySelector('.vditor-outline__content')!
  list.innerHTML = ENTRIES
  const inner = {
    currentMode: 'ir',
    ir: { element: document.querySelector('.vditor-ir > pre') },
    preview: {
      element: document.querySelector('.vditor-preview'),
      previewElement: document.querySelector('.vditor-preview > .vditor-reset'),
    },
    outline: { element: document.querySelector('.vditor-outline') },
  }
  const editor = { vditor: inner } as unknown as Vditor
  ;(window as unknown as { vditor: unknown }).vditor = editor
  // Stands in for Vditor's own listener, which outlineRender adds on the list (bubble phase).
  const vendor = vi.fn()
  list.firstElementChild!.addEventListener('click', vendor)
  setupOutlineFlash(editor)
  return { vendor }
}

const click = (selector: string) =>
  document
    .querySelector(selector)!
    .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

describe('Outline entry click in full Preview', () => {
  let scrolled: Element[]

  beforeEach(() => {
    vi.useFakeTimers()
    scrolled = []
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { vditor?: unknown }).vditor
  })

  it('scrolls the Preview heading through the shared path, not the vendor handler', () => {
    const { vendor } = fixture({ preview: true, sourcePaneHidden: true })

    click('[data-target-id="far_2"] > span')

    expect(scrolled.map((el) => el.id)).toEqual(['far_2'])
    expect(
      document.querySelector('.vditor-preview #far_2')!.contains(scrolled[0]!),
    ).toBe(true)
    expect(vendor).not.toHaveBeenCalled()
  })

  it('leaves the collapse arrow to the vendor handler', () => {
    const { vendor } = fixture({ preview: true, sourcePaneHidden: true })

    click('[data-target-id="title_0"] > .vditor-outline__action')

    expect(vendor).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([])
  })

  it('keeps the vendor handler in an edit mode', () => {
    const { vendor } = fixture({ preview: false, sourcePaneHidden: true })

    click('[data-target-id="far_2"] > span')

    expect(vendor).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([])
  })

  it('keeps the vendor handler in Split, where the Preview pane itself scrolls', () => {
    const { vendor } = fixture({ preview: true, sourcePaneHidden: false })

    click('[data-target-id="far_2"] > span')

    expect(vendor).toHaveBeenCalledTimes(1)
    expect(scrolled).toEqual([])
  })
})
