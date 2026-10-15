// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSectionFoldController,
  foldAtCaret,
  headingFoldGutterHitTest,
  installSectionFold,
  listFoldGutterHitTest,
  type SectionFoldState,
  toggleFoldAtCaret,
  unfoldAtCaret,
} from './section-fold'

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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('heading fold icon hit testing', () => {
  const computedStyle = (values: Record<string, string>) =>
    values as unknown as CSSStyleDeclaration

  const mockHeadingGutter = ({
    before = {},
    after = {},
    heading = {},
  }: {
    before?: Record<string, string>
    after?: Record<string, string>
    heading?: Record<string, string>
  } = {}) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
    } as DOMRect)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (_element, pseudoElement) => {
        if (pseudoElement === '::before') {
          return computedStyle({
            borderLeftWidth: '0px',
            borderRightWidth: '0px',
            borderTopWidth: '0px',
            borderBottomWidth: '0px',
            boxSizing: 'content-box',
            content: '"H3"',
            display: 'block',
            float: 'left',
            height: '21px',
            marginLeft: '-29px',
            marginRight: '0px',
            marginTop: '0px',
            paddingBottom: '0px',
            paddingLeft: '0px',
            paddingRight: '4px',
            paddingTop: '0px',
            position: 'relative',
            top: '1px',
            visibility: 'visible',
            width: '16px',
            ...before,
          })
        }
        if (pseudoElement === '::after') {
          return computedStyle({
            borderLeftWidth: '0px',
            borderRightWidth: '0px',
            borderTopWidth: '0px',
            borderBottomWidth: '0px',
            boxSizing: 'content-box',
            content: '"▼"',
            display: 'flex',
            height: '24px',
            left: '-38px',
            paddingBottom: '0px',
            paddingLeft: '0px',
            paddingRight: '0px',
            paddingTop: '0px',
            position: 'absolute',
            top: '31px',
            visibility: 'visible',
            width: '36px',
            ...after,
          })
        }
        return computedStyle({
          borderLeftWidth: '0px',
          borderRightWidth: '0px',
          borderTopWidth: '0px',
          borderBottomWidth: '0px',
          height: '0px',
          paddingLeft: '0px',
          paddingRight: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          width: '0px',
          ...heading,
        })
      },
    )
  }

  it('accepts the computed marker, gap, and arrow rectangle edges', () => {
    const heading = document.createElement('h2')
    heading.setAttribute('data-vmde-foldable', '1')
    mockHeadingGutter()

    for (const [clientX, clientY] of [
      [81, 211], // marker center
      [80, 226], // gap center
      [80, 243], // arrow center
      [62, 228],
      [98, 228],
      [80, 201],
      [80, 255],
      [62, 201],
      [98, 255],
    ]) {
      expect(headingFoldGutterHitTest(heading, { clientX, clientY })).toBe(true)
    }

    for (const [clientX, clientY] of [
      [61.99, 228],
      [98.01, 228],
      [80, 200.99],
      [80, 255.01],
      [100, 228], // caret position immediately before the first heading character
    ]) {
      expect(headingFoldGutterHitTest(heading, { clientX, clientY })).toBe(
        false,
      )
    }
  })

  it('uses every H1-H6 marker offset and arrow anchor for the rendered gutter', () => {
    const heading = document.createElement('h2')
    heading.setAttribute('data-vmde-foldable', '1')
    for (const { anchor, height, offset } of [
      { anchor: 38, height: 31, offset: 1 },
      { anchor: 34, height: 27, offset: 1 },
      { anchor: 31, height: 24, offset: 1 },
      { anchor: 28, height: 22, offset: 1 },
      { anchor: 26, height: 20, offset: 0 },
      { anchor: 23, height: 18, offset: 0 },
    ]) {
      mockHeadingGutter({
        before: {
          height: `${height}px`,
          position: offset ? 'relative' : 'static',
          top: offset ? `${offset}px` : 'auto',
        },
        after: {
          height: `${anchor + 24 - offset}px`,
          top: `${offset}px`,
        },
      })
      const markerBottom = 200 + offset + height
      const gutterBottom = 200 + anchor + 24
      const gap = (markerBottom + 200 + anchor) / 2
      for (const [clientX, clientY] of [
        [81, 200 + offset + height / 2],
        [80, gap],
        [80, 200 + anchor + 12],
        [62, 200 + offset],
        [98, gutterBottom],
      ])
        expect(headingFoldGutterHitTest(heading, { clientX, clientY })).toBe(
          true,
        )
      expect(
        headingFoldGutterHitTest(heading, {
          clientX: 80,
          clientY: 200 + offset - 0.01,
        }),
      ).toBe(false)
      expect(
        headingFoldGutterHitTest(heading, {
          clientX: 80,
          clientY: gutterBottom + 0.01,
        }),
      ).toBe(false)
      vi.restoreAllMocks()
    }
  })

  it('rejects non-foldable headings and list items', () => {
    const icon = { left: 0, top: 0, right: 18, bottom: 12 }
    expect(
      headingFoldGutterHitTest(
        document.createElement('h2'),
        { clientX: 9, clientY: 6 },
        icon,
      ),
    ).toBe(false)
    const listItem = document.createElement('li')
    listItem.setAttribute('data-vmde-list-foldable', '1')
    expect(
      headingFoldGutterHitTest(listItem, { clientX: 9, clientY: 6 }, icon),
    ).toBe(false)
  })

  it('falls back to the arrow only when the heading marker is hidden', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    mockHeadingGutter({ before: { content: 'none', display: 'none' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(true)
    expect(
      headingFoldGutterHitTest(heading, { clientX: 81, clientY: 211 }),
    ).toBe(false)
  })

  it('keeps border-box pseudo dimensions independent of validated insets', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    mockHeadingGutter({
      after: {
        borderRightWidth: '9px',
        boxSizing: 'border-box',
        paddingRight: '9px',
      },
    })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 98, clientY: 243 }),
    ).toBe(true)
    expect(
      headingFoldGutterHitTest(heading, { clientX: 98.01, clientY: 243 }),
    ).toBe(false)
  })

  it('accepts a relative marker with auto top and rejects unsupported marker placement', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    mockHeadingGutter({ before: { top: 'auto' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 81, clientY: 210 }),
    ).toBe(true)

    vi.restoreAllMocks()
    mockHeadingGutter({ before: { position: 'absolute' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(false)
  })

  it('fails closed for malformed visible marker or arrow geometry', () => {
    const heading = document.createElement('h3')
    heading.setAttribute('data-vmde-foldable', '1')
    mockHeadingGutter({ before: { width: 'auto' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(false)

    vi.restoreAllMocks()
    mockHeadingGutter({ after: { height: '0px' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(false)

    vi.restoreAllMocks()
    mockHeadingGutter({ heading: { borderLeftWidth: 'auto' } })
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(false)

    const invalidOffsets: Array<Record<string, string>> = [
      { left: 'auto' },
      { top: 'auto' },
    ]
    for (const after of invalidOffsets) {
      vi.restoreAllMocks()
      mockHeadingGutter({ after })
      expect(
        headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
      ).toBe(false)
    }

    vi.restoreAllMocks()
    mockHeadingGutter()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: Number.POSITIVE_INFINITY,
      top: 200,
    } as DOMRect)
    expect(
      headingFoldGutterHitTest(heading, { clientX: 80, clientY: 243 }),
    ).toBe(false)
  })
})

describe('list fold gutter hit testing', () => {
  const computedStyle = (values: Record<string, string>) =>
    values as unknown as CSSStyleDeclaration

  const listFixture = ({
    markerWidth = '6px',
    markerType = 'disc',
    arrowLeft = '-38px',
    arrowTop = '14px',
    arrowWidth = '36px',
    arrowHeight = '24px',
    listPosition = 'outside',
    task = false,
  }: {
    markerWidth?: string
    markerType?: string
    arrowLeft?: string
    arrowTop?: string
    arrowWidth?: string
    arrowHeight?: string
    listPosition?: string
    task?: boolean
  } = {}) => {
    const list = document.createElement('ul')
    const item = document.createElement('li')
    item.setAttribute('data-vmde-list-foldable', '1')
    if (task) {
      item.className = 'vditor-task'
      item.innerHTML = '<input type="checkbox"> parent<ul><li>child</li></ul>'
    } else {
      item.innerHTML = 'parent<ul><li>child</li></ul>'
    }
    list.append(item)
    document.body.append(list)
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 200,
      right: 400,
      bottom: 250,
      width: 300,
      height: 50,
    } as DOMRect)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudoElement) => {
        if (element === item && pseudoElement === '::after') {
          return computedStyle({
            boxSizing: 'border-box',
            borderBottomWidth: '0px',
            borderLeftWidth: '0px',
            borderRightWidth: '0px',
            borderTopWidth: '0px',
            content: '"▼"',
            display: 'flex',
            height: arrowHeight,
            left: arrowLeft,
            paddingBottom: '0px',
            paddingLeft: '0px',
            paddingRight: '0px',
            paddingTop: '3px',
            opacity: '1',
            pointerEvents: 'auto',
            position: 'absolute',
            top: arrowTop,
            visibility: 'visible',
            width: arrowWidth,
          })
        }
        if (element === item && pseudoElement === '::marker') {
          return computedStyle({
            content: 'normal',
            lineHeight: '21px',
            listStyleType: markerType,
            width: markerWidth,
          })
        }
        if (element === item) return computedStyle({ position: 'relative' })
        if (element === list)
          return computedStyle({ listStylePosition: listPosition })
        return computedStyle({})
      },
    )
    return { item, list }
  }

  it('accepts the native marker, gutter gap, and triangle across the target edges', () => {
    const { item } = listFixture({ markerWidth: '26.7188px' })

    for (const [clientX, clientY] of [
      [85, 210], // multi-digit native marker
      [80, 217], // visible gutter gap below the marker
      [80, 226], // triangle center
      [62, 200], // top-left outer edge
      [98, 238], // bottom-right outer edge
    ]) {
      expect(listFoldGutterHitTest(item, { clientX, clientY })).toBe(true)
    }

    for (const [clientX, clientY] of [
      [61.99, 219],
      [98.01, 219],
      [80, 199.99],
      [80, 238.01],
      [100, 210], // first-character caret position
    ]) {
      expect(listFoldGutterHitTest(item, { clientX, clientY })).toBe(false)
    }
  })

  it('keeps a 36 px triangle box aligned for bullets and multi-digit markers', () => {
    for (const markerWidth of ['6px', '26.7188px', '42px']) {
      const { item } = listFixture({ markerWidth })
      expect(listFoldGutterHitTest(item, { clientX: 80, clientY: 226 })).toBe(
        true,
      )
      vi.restoreAllMocks()
      document.body.replaceChildren()
    }
  })

  it('rejects malformed, non-foldable, and inside-marker geometry', () => {
    const malformedCases = [
      { arrowLeft: 'auto' },
      { arrowTop: 'auto' },
      { arrowWidth: 'auto' },
      { arrowHeight: '0px' },
      { markerWidth: 'auto' },
      { listPosition: 'inside' },
    ]
    for (const options of malformedCases) {
      const { item } = listFixture(options)
      expect(listFoldGutterHitTest(item, { clientX: 80, clientY: 226 })).toBe(
        false,
      )
      vi.restoreAllMocks()
      document.body.replaceChildren()
    }

    const withoutFoldableMarker = listFixture()
    withoutFoldableMarker.item.removeAttribute('data-vmde-list-foldable')
    expect(
      listFoldGutterHitTest(withoutFoldableMarker.item, {
        clientX: 80,
        clientY: 226,
      }),
    ).toBe(false)
    vi.restoreAllMocks()
    document.body.replaceChildren()

    const withoutChildList = listFixture()
    withoutChildList.item.querySelector(':scope > ul')?.remove()
    expect(
      listFoldGutterHitTest(withoutChildList.item, {
        clientX: 80,
        clientY: 226,
      }),
    ).toBe(false)
  })

  it('excludes task checkboxes even when a bad pseudo box overlaps one', () => {
    const { item } = listFixture({
      markerType: 'none',
      markerWidth: 'auto',
      arrowLeft: '-42px',
      arrowTop: '3px',
      task: true,
    })
    const checkbox = item.querySelector('input[type="checkbox"]')!
    vi.spyOn(checkbox, 'getBoundingClientRect').mockReturnValue({
      left: 70,
      top: 202,
      right: 83,
      bottom: 215,
      width: 13,
      height: 13,
    } as DOMRect)

    expect(listFoldGutterHitTest(item, { clientX: 76, clientY: 207 })).toBe(
      false,
    )
    expect(listFoldGutterHitTest(item, { clientX: 80, clientY: 220 })).toBe(
      true,
    )
  })
})

// Task 641: the glyph centre is measured after the first paint, only for items near the viewport.
// The stubs below are the environment's idle scheduler and viewport observer, driven by the tests.
function glyphEnvironment() {
  const idle: (() => void)[] = []
  const resize: { callback?: ResizeObserverCallback } = {}
  const near: {
    callback?: IntersectionObserverCallback
    options?: IntersectionObserverInit
    observed: Set<Element>
  } = { observed: new Set() }
  vi.stubGlobal('requestIdleCallback', (run: () => void) => idle.push(run))
  vi.stubGlobal('cancelIdleCallback', () => undefined)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize.callback = callback
      }
      observe() {
        /* test observer records its callback */
      }
      unobserve() {
        /* nothing pending */
      }
      disconnect() {
        /* no pending native observations */
      }
    },
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        near.callback = callback
        near.options = options
      }
      observe(target: Element) {
        near.observed.add(target)
      }
      unobserve(target: Element) {
        near.observed.delete(target)
      }
      disconnect() {
        near.observed.clear()
      }
    },
  )
  return {
    idle,
    resize,
    near,
    /** The first idle period: the controller starts measuring. */
    runIdle: () => {
      for (const run of idle.splice(0)) run()
    },
    /** The viewport observer reports `items` as inside (or outside) the margin. */
    report: (items: Element[], isIntersecting = true) =>
      near.callback?.(
        items.map((target) => ({ target, isIntersecting }) as never),
        {} as IntersectionObserver,
      ),
  }
}

// jsdom cannot compute pseudo geometry, so every list item reports the same native marker and
// arrow box, and `markerWidth()` is the live marker width the test can change.
function mockGlyphGeometry(
  markerWidth: () => number,
  scroller?: () => HTMLElement | undefined,
) {
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(100, 200, 300, 50))
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (!pseudo && element === scroller?.())
      return { overflowY: 'auto' } as CSSStyleDeclaration
    if (element.tagName === 'LI' && pseudo === '::after')
      return {
        position: 'absolute',
        display: 'flex',
        visibility: 'visible',
        content: '""',
        opacity: '1',
        pointerEvents: 'auto',
        boxSizing: 'border-box',
        left: '-38px',
        top: '21px',
        width: '36px',
        height: '24px',
        paddingLeft: '0px',
        paddingRight: '0px',
        paddingTop: '3px',
        paddingBottom: '0px',
        borderLeftWidth: '0px',
        borderRightWidth: '0px',
        borderTopWidth: '0px',
        borderBottomWidth: '0px',
      } as CSSStyleDeclaration
    if (element.tagName === 'LI' && pseudo === '::marker')
      return {
        listStyleType: 'disc',
        width: `${markerWidth()}px`,
        lineHeight: '21px',
      } as CSSStyleDeclaration
    return {
      position: 'relative',
      listStylePosition: 'outside',
    } as CSSStyleDeclaration
  })
  return rect
}

const GLYPH_CENTER = '--vmde-list-fold-glyph-center-x'

function listsFixture() {
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = `<ul data-block="0">
    <li>first<ul><li>first child</li></ul></li>
    <li>second<ul><li>second child</li></ul></li>
    <li>third<ul><li>third child</li></ul></li>
  </ul>`
  document.body.appendChild(root)
  const vditor = { vditor: { currentMode: 'ir', ir: { element: root } } }
  const [first, second, third] = Array.from(
    root.querySelectorAll<HTMLElement>(':scope > ul > li'),
  )
  return { root, vditor, first, second, third }
}

describe('list fold glyph alignment off the startup path (Task 641)', () => {
  // Acceptance: fold glyph alignment is not called synchronously during init.
  it('measures no list item while the controller is created and applied', () => {
    const env = glyphEnvironment()
    const measure = mockGlyphGeometry(() => 6)
    const { vditor, first, second, third } = listsFixture()
    const controller = createSectionFoldController(vditor as never)
    controller.apply()

    expect(measure).not.toHaveBeenCalled()
    for (const item of [first, second, third])
      expect(item.style.getPropertyValue(GLYPH_CENTER)).toBe('')
    expect(env.near.observed.size).toBe(0)
    controller.dispose()
  })

  // Acceptance: it runs for near-viewport items after the idle trigger, and for no other item.
  it('after the idle trigger measures the items the observer reports near the viewport', () => {
    const env = glyphEnvironment()
    mockGlyphGeometry(() => 6)
    const { vditor, first, second, third } = listsFixture()
    const controller = createSectionFoldController(vditor as never)

    env.runIdle()
    expect([...env.near.observed]).toEqual(
      expect.arrayContaining([first, second, third]),
    )
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('')

    env.report([first, second])
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('-13.5px')
    expect(first.style.getPropertyValue('--vmde-list-fold-arrow-top')).toBe(
      '21px',
    )
    expect(second.style.getPropertyValue(GLYPH_CENTER)).toBe('-13.5px')
    // Far from the viewport: still the CSS fallback centre.
    expect(third.style.getPropertyValue(GLYPH_CENTER)).toBe('')

    // Scrolled into the margin later: measured when the observer reports it.
    env.report([third])
    expect(third.style.getPropertyValue(GLYPH_CENTER)).toBe('-13.5px')
    controller.dispose()
  })

  // An intersection margin widens only the observer's root, never a clipping ancestor, so a pane
  // that scrolls inside the page must be the root or "near" would stop at its edge.
  it('observes against the clipping scroller when the editor scrolls inside the page', () => {
    const env = glyphEnvironment()
    let scroller: HTMLElement | undefined
    mockGlyphGeometry(
      () => 6,
      () => scroller,
    )
    const { root, vditor } = listsFixture()
    scroller = document.createElement('div')
    root.parentElement?.insertBefore(scroller, root)
    scroller.appendChild(root)
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { value: 400 })
    const controller = createSectionFoldController(vditor as never)
    env.runIdle()

    expect(env.near.options?.root).toBe(scroller)
    expect(env.near.options?.rootMargin).toBe('600px')
    controller.dispose()
  })

  it('measures every foldable item in one batch of reads before any write', () => {
    const env = glyphEnvironment()
    const events: string[] = []
    mockGlyphGeometry(() => 6)
    const { vditor, first, second } = listsFixture()
    for (const item of [first, second]) {
      vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() => {
        events.push('read')
        return new DOMRect(100, 200, 300, 50)
      })
      const setProperty = item.style.setProperty.bind(item.style)
      vi.spyOn(item.style, 'setProperty').mockImplementation((...args) => {
        events.push('write')
        setProperty(...args)
      })
    }
    const controller = createSectionFoldController(vditor as never)
    env.runIdle()
    env.report([first, second])

    const firstWrite = events.indexOf('write')
    expect(firstWrite).toBeGreaterThan(0)
    expect(events.slice(0, firstWrite)).toEqual(['read', 'read'])
    controller.dispose()
  })

  // Acceptance: folding a list still aligns its glyph (the toggled item at once).
  it('aligns a list item the moment it is folded, before any idle period', () => {
    glyphEnvironment()
    mockGlyphGeometry(() => 6)
    const { vditor, first, second } = listsFixture()
    const controller = createSectionFoldController(vditor as never)

    expect(controller.toggleListItem(first)).toBe(true)

    expect(first.hasAttribute('data-vmde-list-folded')).toBe(true)
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('-13.5px')
    expect(second.style.getPropertyValue(GLYPH_CENTER)).toBe('')
    controller.dispose()
  })

  // Acceptance: the position stays correct when the marker changes after font load, zoom or pane
  // resize, for the items near the viewport.
  it('recomputes the glyph center of near items after their measured marker resizes', async () => {
    const env = glyphEnvironment()
    let markerWidth = 6
    mockGlyphGeometry(() => markerWidth)
    const { vditor, first, second } = listsFixture()
    const controller = createSectionFoldController(vditor as never)
    env.runIdle()
    env.report([first])
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('-13.5px')

    markerWidth = 26
    expect(env.resize.callback).toBeDefined()
    env.resize.callback!([], {} as ResizeObserver)
    await vi.waitFor(() =>
      expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('-23.5px'),
    )
    // The far item was never near, so the resize measured nothing for it.
    expect(second.style.getPropertyValue(GLYPH_CENTER)).toBe('')
    controller.dispose()
  })

  it('keeps no pending work after dispose', () => {
    const env = glyphEnvironment()
    const measure = mockGlyphGeometry(() => 6)
    const { vditor, first } = listsFixture()
    const controller = createSectionFoldController(vditor as never)
    controller.dispose()

    env.runIdle()
    env.report([first])

    expect(measure).not.toHaveBeenCalled()
    expect(env.near.observed.size).toBe(0)
  })
})

describe('section fold controller', () => {
  beforeEach(() => {
    // jsdom cannot compute pseudo geometry; these state tests are not the painted-glyph test above.
    const realStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
        pseudo
          ? ({ display: 'none' } as CSSStyleDeclaration)
          : realStyle(element),
    )
  })
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

// Task 580 CP2-4 — Fold and Unfold (VS Code's editor.fold / editor.unfold) act in one direction on
// the same target Toggle Fold uses; the old Ctrl/Cmd+Alt+[ keydown match is gone.
describe('section fold commands at the caret', () => {
  beforeEach(() => {
    const realStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
        pseudo
          ? ({ display: 'none' } as CSSStyleDeclaration)
          : realStyle(element),
    )
  })

  const textIn = (root: HTMLElement, needle: string): Text => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (node.nodeValue?.includes(needle)) return node as Text
    throw new Error(`${needle} missing`)
  }

  const placeCaret = (root: HTMLElement, needle: string) => {
    const range = document.createRange()
    range.setStart(textIn(root, needle), 0)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
  }

  const foldedHeadings = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('[data-vmde-folded]')).map((h) => h.id)

  it('folds and unfolds a heading section one way only', () => {
    const { root, vditor } = fixture()
    const persist = vi.fn()
    const controller = createSectionFoldController(vditor as never, { persist })
    const one = textIn(root, 'One')
    expect(controller.foldAt(one)).toBe(true)
    expect(foldedHeadings(root)).toEqual(['one'])
    expect(controller.foldAt(one)).toBe(false)
    expect(foldedHeadings(root)).toEqual(['one'])
    expect(persist).toHaveBeenCalledTimes(1)
    expect(controller.unfoldAt(one)).toBe(true)
    expect(foldedHeadings(root)).toEqual([])
    expect(controller.unfoldAt(one)).toBe(false)
    expect(root.querySelector('[data-vmde-fold-hidden]')).toBeNull()
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('folds the list item that owns a nested list, and nothing from a leaf item or body text', () => {
    const { root, vditor } = fixture()
    const controller = createSectionFoldController(vditor as never)
    const before = root.textContent
    expect(controller.foldAt(textIn(root, 'nested'))).toBe(false)
    expect(controller.foldAt(textIn(root, 'one body'))).toBe(false)
    expect(controller.foldAt(textIn(root, 'cell'))).toBe(false)
    expect(
      root.querySelector('[data-vmde-folded], [data-vmde-list-folded]'),
    ).toBeNull()
    const parent = root.querySelector('li')!
    expect(controller.foldAt(textIn(root, 'parent'))).toBe(true)
    expect(parent.hasAttribute('data-vmde-list-folded')).toBe(true)
    expect(controller.foldAt(textIn(root, 'parent'))).toBe(false)
    expect(parent.hasAttribute('data-vmde-list-folded')).toBe(true)
    expect(controller.unfoldAt(textIn(root, 'parent'))).toBe(true)
    expect(parent.hasAttribute('data-vmde-list-folded')).toBe(false)
    expect(root.textContent).toBe(before)
  })

  it('runs Fold, Unfold and Toggle Fold on the installed editor at the caret', () => {
    const { root, vditor } = fixture()
    const dispose = installSectionFold(vditor as never, {
      headings: [],
      lists: [],
    })
    try {
      placeCaret(root, 'Child')
      expect(foldAtCaret()).toBe(true)
      expect(foldAtCaret()).toBe(false)
      expect(foldedHeadings(root)).toEqual(['child'])
      expect(unfoldAtCaret()).toBe(true)
      expect(unfoldAtCaret()).toBe(false)
      expect(toggleFoldAtCaret()).toBe(true)
      expect(foldedHeadings(root)).toEqual(['child'])
      expect(toggleFoldAtCaret()).toBe(true)
      expect(foldedHeadings(root)).toEqual([])
    } finally {
      dispose()
    }
    expect(foldAtCaret()).toBe(false)
  })

  it('leaves Ctrl/Cmd+Alt+[ inert', () => {
    const { root, vditor } = fixture()
    const dispose = installSectionFold(vditor as never, {
      headings: [],
      lists: [],
    })
    try {
      placeCaret(root, 'One')
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const event = new KeyboardEvent('keydown', {
          key: '[',
          code: 'BracketLeft',
          altKey: true,
          bubbles: true,
          cancelable: true,
          ...modifier,
        })
        root.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(false)
      }
      expect(foldedHeadings(root)).toEqual([])
    } finally {
      dispose()
    }
  })
})
