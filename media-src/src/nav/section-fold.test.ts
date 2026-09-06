// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSectionFoldController,
  headingFoldIconHitTest,
  sectionFoldShortcut,
  type SectionFoldState,
} from './section-fold'

describe('section fold shortcut ownership', () => {
  it('owns Ctrl+Alt+[ and leaves Ctrl+Shift+[ to heading promotion', () => {
    expect(
      sectionFoldShortcut({
        code: 'BracketLeft',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: true,
      }),
    ).toBe(true)
    expect(
      sectionFoldShortcut({
        code: 'BracketLeft',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false)
    expect(
      sectionFoldShortcut({
        code: 'BracketLeft',
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: true,
      }),
    ).toBe(false)
  })
})

const fixture = () => {
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = `
    <h1 data-block="0" id="one">One</h1>
    <p data-block="0">one body</p>
    <h2 data-block="0" id="child">Child</h2>
    <p data-block="0">child body</p>
    <h1 data-block="0" id="two">Two</h1>
    <ul data-block="0"><li>parent<ul><li>nested</li></ul></li><li>plain</li></ul>
    <table data-block="0"><tbody><tr><td>cell</td></tr></tbody></table>`
  document.body.appendChild(root)
  const vditor = {
    vditor: { currentMode: 'ir', ir: { element: root } },
  }
  return { root, vditor }
}

beforeEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('heading fold icon hit testing', () => {
  it('accepts the bounded icon rectangle edges and rejects every point just outside it', () => {
    const heading = document.createElement('h2')
    heading.setAttribute('data-vmde-foldable', '1')
    const icon = { left: 71, top: 142, right: 89, bottom: 154 }

    for (const [clientX, clientY] of [
      [80, 148],
      [71, 148],
      [89, 148],
      [80, 142],
      [80, 154],
      [71, 142],
      [89, 142],
      [71, 154],
      [89, 154],
    ]) {
      expect(headingFoldIconHitTest(heading, { clientX, clientY }, icon)).toBe(
        true,
      )
    }

    for (const [clientX, clientY] of [
      [70.99, 148],
      [89.01, 148],
      [80, 141.99],
      [80, 154.01],
      [100, 148], // caret position immediately before the first heading character
    ]) {
      expect(headingFoldIconHitTest(heading, { clientX, clientY }, icon)).toBe(
        false,
      )
    }
  })

  it('rejects non-foldable headings and list items', () => {
    const icon = { left: 0, top: 0, right: 18, bottom: 12 }
    expect(
      headingFoldIconHitTest(
        document.createElement('h2'),
        { clientX: 9, clientY: 6 },
        icon,
      ),
    ).toBe(false)
    const listItem = document.createElement('li')
    listItem.setAttribute('data-vmde-list-foldable', '1')
    expect(
      headingFoldIconHitTest(listItem, { clientX: 9, clientY: 6 }, icon),
    ).toBe(false)
  })

  it('reads the rendered pseudo-element rectangle for pointer input', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
    } as DOMRect)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      left: '-29px',
      top: '31px',
      width: '18px',
      height: '12px',
    } as CSSStyleDeclaration)

    expect(headingFoldIconHitTest(heading, { clientX: 80, clientY: 237 })).toBe(
      true,
    )
  })

  it('rejects a heading when its rendered icon has no numeric box', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    vi.spyOn(heading, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
    } as DOMRect)
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      left: 'auto',
      top: 'auto',
      width: 'auto',
      height: 'auto',
    } as CSSStyleDeclaration)

    expect(headingFoldIconHitTest(heading, { clientX: 80, clientY: 237 })).toBe(
      false,
    )
  })
})

describe('section fold controller', () => {
  it('folds a heading-owned subtree without hiding the heading or next peer', () => {
    const { root, vditor } = fixture()
    const persist = vi.fn()
    const controller = createSectionFoldController(vditor as never, { persist })
    expect(controller.toggleHeading(0)).toBe(true)
    const blocks = Array.from(root.children) as HTMLElement[]
    expect(blocks[0].hasAttribute('data-vmde-folded')).toBe(true)
    expect(blocks[0].dataset.vmdeFoldCount).toBe('3')
    expect(
      blocks
        .slice(1, 4)
        .every((block) => block.hasAttribute('data-vmde-fold-hidden')),
    ).toBe(true)
    expect(blocks[4].hasAttribute('data-vmde-fold-hidden')).toBe(false)
    expect(persist).toHaveBeenCalled()
  })

  it('toggles the same heading open and preserves source text', () => {
    const { root, vditor } = fixture()
    const before = root.textContent
    const controller = createSectionFoldController(vditor as never)
    controller.toggleHeading(1)
    controller.toggleHeading(1)
    expect(root.querySelector('[data-vmde-fold-hidden]')).toBeNull()
    expect(root.textContent).toBe(before)
  })

  it('unfolds an ancestor when navigation targets a hidden block', () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    controller.toggleHeading(0)
    const hidden = Array.from(root.children)[3] as HTMLElement
    expect(controller.ensureBlockVisible(hidden)).toBe(true)
    expect(root.querySelector('[data-vmde-fold-hidden]')).toBeNull()
  })

  it('restores persisted heading identity on a fresh DOM', () => {
    const first = fixture()
    const controller = createSectionFoldController(first.vditor as never)
    controller.toggleHeading(1)
    const state = controller.state()
    controller.dispose()
    document.body.replaceChildren()
    const second = fixture()
    createSectionFoldController(second.vditor as never, { initialState: state })
    expect(
      second.root.querySelector('#child')?.hasAttribute('data-vmde-folded'),
    ).toBe(true)
    expect(
      Array.from(second.root.children)[3]?.hasAttribute(
        'data-vmde-fold-hidden',
      ),
    ).toBe(true)
  })

  it('folds and restores a nested list subtree by stable list path', () => {
    const first = fixture()
    const controller = createSectionFoldController(first.vditor as never)
    const parent = first.root.querySelector('li')!
    expect(controller.toggleListItem(parent)).toBe(true)
    expect(parent.hasAttribute('data-vmde-list-folded')).toBe(true)
    expect(
      parent
        .querySelector(':scope > ul')
        ?.hasAttribute('data-vmde-fold-hidden'),
    ).toBe(true)
    const state: SectionFoldState = controller.state()
    controller.dispose()
    document.body.replaceChildren()
    const second = fixture()
    createSectionFoldController(second.vditor as never, { initialState: state })
    const restored = second.root.querySelector('li')!
    expect(restored.hasAttribute('data-vmde-list-folded')).toBe(true)
    expect(
      restored
        .querySelector(':scope > ul')
        ?.hasAttribute('data-vmde-fold-hidden'),
    ).toBe(true)
  })

  it('reapplies list folding after Vditor replaces the list DOM', async () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    controller.toggleListItem(root.querySelector('li')!)
    const unrelated = root.querySelector<HTMLElement>('#two')!
    const removeAttribute = vi.spyOn(unrelated, 'removeAttribute')
    const list = root.querySelector('ul[data-block="0"]')!
    list.innerHTML = '<li>parent<ul><li>nested again</li></ul></li>'
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(
      root.querySelector('li')?.hasAttribute('data-vmde-list-folded'),
    ).toBe(true)
    expect(
      root.querySelector('li > ul')?.hasAttribute('data-vmde-fold-hidden'),
    ).toBe(true)
    expect(removeAttribute).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('leaves unrelated fold attributes byte-identical after a non-structural prose spin', async () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    const unrelated = root.querySelector<HTMLElement>('#two')!
    const before = unrelated.outerHTML
    const removeAttribute = vi.spyOn(unrelated, 'removeAttribute')

    const prose = Array.from(root.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent === 'one body',
    )!
    prose.outerHTML = '<p data-block="0">one body changed</p>'
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(unrelated.outerHTML).toBe(before)
    expect(removeAttribute).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not reapply folds for a table-internal content mutation', async () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    const unrelated = root.querySelector<HTMLElement>('#two')!
    const removeAttribute = vi.spyOn(unrelated, 'removeAttribute')

    root.querySelector('td')!.textContent = 'changed cell'
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(removeAttribute).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps a changed list hidden when its owning heading remains folded', async () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    controller.toggleHeading(2)
    const list = root.querySelector<HTMLElement>('ul[data-block="0"]')!
    expect(list.hasAttribute('data-vmde-fold-hidden')).toBe(true)

    list.innerHTML = '<li>parent<ul><li>changed</li></ul></li>'
    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(list.hasAttribute('data-vmde-fold-hidden')).toBe(true)
    controller.dispose()
  })
})
