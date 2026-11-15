// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSectionFoldController as createController,
  foldSurface,
  foldAtCaret,
  headingFoldGutterHitTest,
  installSectionFold,
  listFoldGutterHitTest,
  type SectionFoldState,
  storedFrontMatterFold,
  storeFrontMatterFold,
  toggleFoldAtCaret,
  unfoldAtCaret,
} from './section-fold'
import { pauseCoalescedObservers } from '../util/observe-coalesce'
import {
  type LiveUnit,
  provideUnitFeed,
  type UnitFeed,
  type UnitsChange,
} from '../util/unit-changes'
import {
  costClock,
  countBudget,
  type Factor,
  fakeLanes,
  irFixture,
  wysiwygFixture,
} from '../testing/budget-harness'
import { createBackgroundScheduler } from '../util/background-budget'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'

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

// Many cases never dispose their controller. Its idle glyph timer would then fire after the jsdom
// environment is torn down and call the missing requestAnimationFrame as an unhandled error, so
// every controller a case creates is disposed after the case.
const createdControllers: Array<{ dispose(): void }> = []
const createSectionFoldController: typeof createController = (...args) => {
  const controller = createController(...args)
  createdControllers.push(controller)
  return controller
}

afterEach(() => {
  for (const controller of createdControllers.splice(0)) controller.dispose()
})

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
  const idle: ((deadline: IdleDeadline) => void)[] = []
  const resize: { callback?: ResizeObserverCallback } = {}
  const near: {
    callback?: IntersectionObserverCallback
    options?: IntersectionObserverInit
    observed: Set<Element>
  } = { observed: new Set() }
  vi.stubGlobal(
    'requestIdleCallback',
    (run: (deadline: IdleDeadline) => void) => idle.push(run),
  )
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
    // An idle period long enough for the glyph job to finish its work.
    runIdle: () => {
      for (const run of idle.splice(0))
        run({ didTimeout: false, timeRemaining: () => 50 })
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

  // Task 724: the front-matter fold is one optional field of the same per-document state.
  it('leaves the front-matter field absent until it is stored', () => {
    const { vditor } = fixture()
    const persist = vi.fn()
    const controller = createSectionFoldController(vditor as never, { persist })
    controller.toggleHeading(0)
    expect(controller.frontMatterFolded()).toBeUndefined()
    expect('frontMatterFolded' in persist.mock.calls[0][0]).toBe(false)
    expect('frontMatterFolded' in controller.state()).toBe(false)
  })

  it('stores the front-matter fold next to the heading and list folds', () => {
    const { root, vditor } = fixture()
    const persist = vi.fn()
    const controller = createSectionFoldController(vditor as never, { persist })
    controller.toggleHeading(0)
    controller.toggleListItem(root.querySelector('li')!)
    controller.setFrontMatterFolded(true)
    expect(controller.frontMatterFolded()).toBe(true)
    expect(persist).toHaveBeenLastCalledWith({
      headings: [expect.objectContaining({ text: 'One', level: 1 })],
      lists: [expect.objectContaining({ text: 'parent' })],
      frontMatterFolded: true,
    })
    // A heading change after it keeps the front-matter field.
    controller.toggleHeading(0)
    expect(persist).toHaveBeenLastCalledWith({
      headings: [],
      lists: [expect.objectContaining({ text: 'parent' })],
      frontMatterFolded: true,
    })
    controller.setFrontMatterFolded(false)
    expect(persist.mock.calls.at(-1)?.[0]).toMatchObject({
      frontMatterFolded: false,
    })
  })

  it('does not persist a front-matter fold that did not change', () => {
    const { vditor } = fixture()
    const persist = vi.fn()
    const controller = createSectionFoldController(vditor as never, {
      initialState: { headings: [], lists: [], frontMatterFolded: true },
      persist,
    })
    controller.setFrontMatterFolded(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('restores a stored front-matter fold and keeps it across a heading restore', () => {
    const { vditor } = fixture()
    const controller = createSectionFoldController(vditor as never, {
      initialState: {
        headings: [{ id: 'one', text: 'One', level: 1 }],
        lists: [],
        frontMatterFolded: false,
      },
    })
    expect(controller.frontMatterFolded()).toBe(false)
    expect(controller.state()).toMatchObject({
      headings: [expect.objectContaining({ text: 'One' })],
      frontMatterFolded: false,
    })
  })

  it('reads and writes the front-matter fold of the installed controller', () => {
    const { vditor } = fixture()
    const persisted: SectionFoldState[] = []
    const dispose = installSectionFold(
      vditor as never,
      { headings: [], lists: [] },
      (state) => persisted.push(state),
    )
    try {
      expect(storedFrontMatterFold()).toBeUndefined()
      storeFrontMatterFold(true)
      expect(storedFrontMatterFold()).toBe(true)
      expect(persisted.at(-1)).toEqual({
        headings: [],
        lists: [],
        frontMatterFolded: true,
      })
    } finally {
      dispose()
    }
    // No controller: nothing is stored and nothing throws.
    expect(storedFrontMatterFold()).toBeUndefined()
    storeFrontMatterFold(false)
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

describe('bullet marker centre from the marker font ascent (Task 722)', () => {
  // Chromium sizes disc/circle/square markers from the font's integer ascent, so the triangle
  // centre follows the ascent rather than half the line box. A fresh module instance gets a fresh
  // canvas cache, so the mocked 2D context is the one the controller measures with.
  it.each([
    [14, '-13.5px'],
    [15, '-14.5px'],
    [17, '-15px'],
    [21, '-17.5px'],
    [27, '-20.5px'],
  ])('ascent %d px centres the triangle at %s', async (ascent, expected) => {
    vi.resetModules()
    const fresh = await import('./section-fold')
    const env = glyphEnvironment()
    mockGlyphGeometry(() => 7)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: () => ({ width: 5, fontBoundingBoxAscent: ascent }),
    } as unknown as CanvasRenderingContext2D)
    const { vditor, first } = listsFixture()
    const controller = fresh.createSectionFoldController(vditor as never)
    env.runIdle()
    env.report([first])
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe(expected)
    controller.dispose()
  })

  it('falls back to the line-box model when the ascent cannot be measured', async () => {
    vi.resetModules()
    const fresh = await import('./section-fold')
    const env = glyphEnvironment()
    mockGlyphGeometry(() => 7)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      font: '',
      measureText: () => ({ width: 5, fontBoundingBoxAscent: Number.NaN }),
    } as unknown as CanvasRenderingContext2D)
    const { vditor, first } = listsFixture()
    const controller = fresh.createSectionFoldController(vditor as never)
    env.runIdle()
    env.report([first])
    expect(first.style.getPropertyValue(GLYPH_CENTER)).toBe('-14px')
    controller.dispose()
  })
})

// Task 721 — full Preview gets the same folds, read-only, from the same per-document state.
describe('section folds in full Preview (Task 721)', () => {
  beforeEach(() => {
    const realStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
        pseudo
          ? ({ display: 'none' } as CSSStyleDeclaration)
          : realStyle(element),
    )
  })

  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

  // IR source DOM (with the inline markers IR shows) next to Lute's Preview HTML for one document.
  const twoPanes = () => {
    const app = document.createElement('div')
    app.id = 'app'
    const irPane = document.createElement('div')
    irPane.className = 'vditor-ir'
    const ir = document.createElement('pre')
    ir.className = 'vditor-reset'
    ir.innerHTML = `
      <h1 data-block="0" id="ir-one">One</h1>
      <p data-block="0">one body</p>
      <h2 data-block="0" id="ir-child">Child</h2>
      <p data-block="0">child body</p>
      <h1 data-block="0" id="ir-two">Two</h1>
      <ul data-block="0"><li data-marker="-"><p><span class="vditor-ir__node" data-type="strong"><span class="vditor-ir__marker">**</span><strong>parent</strong><span class="vditor-ir__marker">**</span></span> item</p><ul><li data-marker="-"><p>nested</p></li></ul></li></ul>`
    irPane.append(ir)
    const previewPane = document.createElement('div')
    previewPane.className = 'vditor-preview'
    previewPane.style.display = 'none'
    const preview = document.createElement('div')
    preview.className = 'vditor-reset'
    preview.innerHTML = `
      <h1 id="one">One</h1>
      <p>one body</p>
      <h2 id="child">Child</h2>
      <p>child body</p>
      <h2 data-vmde-raw-heading="">Raw</h2>
      <p>raw body</p>
      <h1 id="two">Two</h1>
      <ul>
      <li><strong>parent</strong> item
      <ul>
      <li>nested</li>
      </ul>
      </li>
      </ul>`
    previewPane.append(preview)
    app.append(irPane, previewPane)
    document.body.append(app)
    const vditor = {
      vditor: {
        currentMode: 'ir',
        ir: { element: ir },
        preview: { element: previewPane, previewElement: preview },
      },
    }
    const showPreview = (shown: boolean) => {
      previewPane.style.display = shown ? 'block' : 'none'
      irPane.style.display = shown ? 'none' : ''
    }
    return { ir, preview, vditor, showPreview }
  }

  const folded = (root: HTMLElement) => ({
    headings: Array.from(root.querySelectorAll('[data-vmde-folded]')).map(
      (heading) => heading.textContent?.trim(),
    ),
    lists: Array.from(root.querySelectorAll('[data-vmde-list-folded]')).length,
    hidden: Array.from(root.querySelectorAll('[data-vmde-fold-hidden]')).map(
      (element) => element.textContent?.replace(/\s+/g, ' ').trim(),
    ),
  })

  it('makes Preview the fold surface only while full Preview shows over IR or WYSIWYG', () => {
    const { ir, preview, vditor, showPreview } = twoPanes()
    expect(foldSurface(vditor as never)).toBe(ir)
    showPreview(true)
    expect(foldSurface(vditor as never)).toBe(preview)
    vditor.vditor.currentMode = 'sv'
    expect(foldSurface(vditor as never)).toBeNull()
  })

  it('folds Preview headings and list items without data-block and keeps raw HTML headings out', () => {
    const { preview, vditor, showPreview } = twoPanes()
    showPreview(true)
    const persist = vi.fn()
    const before = preview.innerHTML.replace(/ data-vmde-[a-z-]+="[^"]*"/g, '')
    const controller = createSectionFoldController(vditor as never, {
      persist,
      surface: () => foldSurface(vditor as never),
    })
    expect(
      preview
        .querySelector('[data-vmde-raw-heading]')
        ?.hasAttribute('data-vmde-foldable'),
    ).toBe(false)
    expect(controller.toggleHeading(1)).toBe(true)
    // The raw HTML heading is body text of "Child", as it is in IR and WYSIWYG.
    expect(folded(preview)).toMatchObject({
      headings: ['Child'],
      hidden: ['child body', 'Raw', 'raw body'],
    })
    expect(controller.toggleListItem(preview.querySelector('li')!)).toBe(true)
    expect(folded(preview).lists).toBe(1)
    expect(persist).toHaveBeenCalledTimes(2)
    controller.toggleHeading(1)
    controller.toggleListItem(preview.querySelector('li')!)
    expect(preview.innerHTML.replace(/ data-vmde-[a-z-]+="[^"]*"/g, '')).toBe(
      before,
    )
  })

  it('shares one fold state between Preview and IR across a Preview toggle', async () => {
    const { ir, preview, vditor, showPreview } = twoPanes()
    const persisted: SectionFoldState[] = []
    const dispose = installSectionFold(
      vditor as never,
      { headings: [], lists: [] },
      (state) => persisted.push(state),
    )
    try {
      showPreview(true)
      await nextFrame()
      await nextFrame()
      // A click on a Preview heading's gutter goes through the same controller as the edit modes.
      expect(toggleAtNode(preview, 'Child')).toBe(true)
      expect(toggleAtNode(preview, 'parent')).toBe(true)
      expect(folded(preview)).toMatchObject({ headings: ['Child'], lists: 1 })
      expect(persisted.at(-1)).toMatchObject({
        headings: [expect.objectContaining({ text: 'Child', level: 2 })],
        lists: [{ path: [0, 0], text: 'parent item' }],
      })

      showPreview(false)
      await nextFrame()
      await nextFrame()
      expect(folded(ir)).toMatchObject({
        headings: ['Child'],
        lists: 1,
        hidden: ['child body', 'nested'],
      })
      // The old Preview controller cleaned its own surface when IR took over.
      expect(folded(preview)).toEqual({ headings: [], lists: 0, hidden: [] })

      expect(toggleAtNode(ir, 'Child')).toBe(true)
      expect(toggleAtNode(ir, 'One')).toBe(true)
      showPreview(true)
      await nextFrame()
      await nextFrame()
      expect(folded(preview)).toMatchObject({ headings: ['One'], lists: 1 })
      expect(folded(ir)).toEqual({ headings: [], lists: 0, hidden: [] })
    } finally {
      dispose()
    }
  })

  it('re-applies Preview folds when Preview renders again', async () => {
    const { preview, vditor, showPreview } = twoPanes()
    showPreview(true)
    const controller = createSectionFoldController(vditor as never, {
      initialState: {
        headings: [{ id: 'child', text: 'Child', level: 2 }],
        lists: [{ path: [0, 0], text: 'parent item' }],
      },
      surface: () => foldSurface(vditor as never),
    })
    expect(folded(preview)).toMatchObject({ headings: ['Child'], lists: 1 })
    preview.innerHTML = preview.innerHTML.replace(
      / data-vmde-[a-z-]+="[^"]*"/g,
      '',
    )
    // The mutation frame starts the sliced pass; its first slice runs on the next frame.
    await nextFrame()
    await nextFrame()
    expect(folded(preview)).toMatchObject({ headings: ['Child'], lists: 1 })
    controller.dispose()
  })

  it('waits for a paused Preview stream to end before folding the streamed blocks', async () => {
    const { preview, vditor, showPreview } = twoPanes()
    showPreview(true)
    const controller = createSectionFoldController(vditor as never, {
      initialState: {
        headings: [{ id: 'child', text: 'Child', level: 2 }],
        lists: [],
      },
      surface: () => foldSurface(vditor as never),
    })
    const resume = pauseCoalescedObservers()
    preview.innerHTML = preview.innerHTML.replace(
      / data-vmde-[a-z-]+="[^"]*"/g,
      '',
    )
    await nextFrame()
    expect(folded(preview).headings).toEqual([])
    // The resume starts the pass; its first bounded slice folds the top of the pane at once.
    resume()
    expect(folded(preview).headings).toEqual(['Child'])
    controller.dispose()
  })

  it('folds a large Preview in bounded slices, one per frame, and a newer pass cancels the old one', async () => {
    const { preview, vditor, showPreview } = twoPanes()
    // 400 sections of a heading and a paragraph: 800 top-level blocks, 150 per slice.
    preview.innerHTML = Array.from(
      { length: 400 },
      (_, index) =>
        `<h2 id="s${index}">Section ${index}</h2><p>body ${index}</p>`,
    ).join('')
    showPreview(true)
    const headings = () => Array.from(preview.querySelectorAll('h2'))
    const controller = createSectionFoldController(vditor as never, {
      initialState: {
        headings: [{ id: 's399', text: 'Section 399', level: 2 }],
        lists: [],
      },
      surface: () => foldSurface(vditor as never),
    })
    const foldable = () =>
      headings().filter((heading) => heading.hasAttribute('data-vmde-foldable'))
        .length
    // The first slice ran with the controller: 150 blocks are 75 headings.
    expect(foldable()).toBe(75)
    await nextFrame()
    expect(foldable()).toBe(150)
    // A Preview render mid-pass starts a new pass over the new blocks; the old one stops.
    preview.append(
      Object.assign(document.createElement('h2'), {
        id: 's400',
        textContent: 'Section 400',
      }),
      Object.assign(document.createElement('p'), { textContent: 'body 400' }),
    )
    for (let frame = 0; frame < 8; frame++) await nextFrame()
    expect(foldable()).toBe(401)
    expect(folded(preview)).toMatchObject({
      headings: ['Section 399'],
      hidden: ['body 399'],
    })
    // A fold toggle applies at once and cancels a running pass.
    preview.querySelector('#s0')!.remove()
    expect(controller.toggleHeading(0)).toBe(true)
    expect(folded(preview).headings).toEqual(['Section 1', 'Section 399'])
    controller.dispose()
  })

  it('folds a re-rendered Preview before any task or frame can see it unfolded (Task 721 repair 2)', async () => {
    const { preview, vditor, showPreview } = twoPanes()
    showPreview(true)
    const controller = createSectionFoldController(vditor as never, {
      initialState: {
        headings: [{ id: 'one', text: 'One', level: 1 }],
        lists: [],
      },
      surface: () => foldSurface(vditor as never),
    })
    preview.innerHTML = preview.innerHTML.replace(
      / data-vmde-[a-z-]+="[^"]*"/g,
      '',
    )
    // A reading-position save is a timer task: by then the mutation microtask has folded the pane.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(folded(preview).headings).toEqual(['One'])
    controller.dispose()
  })

  it('still restores a list fold stored with the IR marker text of an earlier version', () => {
    const { ir, vditor } = twoPanes()
    createSectionFoldController(vditor as never, {
      initialState: {
        headings: [],
        lists: [{ path: [0, 0], text: '**parent** item' }],
      },
    })
    expect(folded(ir).lists).toBe(1)
  })
})

function toggleAtNode(root: HTMLElement, needle: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.includes(needle)) continue
    const range = document.createRange()
    range.setStart(node, 0)
    range.collapse(true)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    return toggleFoldAtCaret()
  }
  throw new Error(`${needle} missing`)
}

// The factor-16 fixture takes seconds to mount in jsdom on a loaded machine.
const BUDGET_TIMEOUT_MS = 60_000

// Task 733 (D-13 B-11): while a live feed describes the fold surface, its scoped changes drive the
// fold frame; the frame makes no root query and leaves the whole clear to whole changes.
describe('section fold on unit feed changes (Task 733, B-11)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  type Change = Pick<UnitsChange, 'whole'> &
    Partial<UnitsChange> & { scopes?: readonly HTMLElement[] }

  const nodesIn = (node: Node): number => {
    let count = 1
    for (let child = node.firstChild; child; child = child.nextSibling)
      count += nodesIn(child)
    return count
  }
  const unit = (
    el: HTMLElement,
    kind: LiveUnit['kind'],
    top: HTMLElement = el,
  ): LiveUnit => ({ el, members: [el], kind, top })
  const settle = () => new Promise<void>((done) => setTimeout(done, 0))

  afterEach(() => {
    provideUnitFeed(window, undefined)
  })

  function setup(factor: Factor, initialState?: SectionFoldState) {
    const ir = irFixture(tableHeavyMarkdown(factor), () => undefined).root
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    )
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('requestIdleCallback', () => 0)
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    const listeners = new Set<(change: UnitsChange) => void>()
    const feed: UnitFeed = {
      root: ir,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    const emit = (change: Change) => {
      const full: UnitsChange = {
        cause: 'mutation',
        changed: [],
        structural: [],
        ...change,
      }
      for (const listener of Array.from(listeners)) listener(full)
    }
    createSectionFoldController({} as never, {
      surface: () => ir,
      initialState,
    })
    frames.splice(0)
    // Every frame queued so far and every frame they queue (the shared scheduler's slices), counted
    // as one run on the IR root.
    const runFrames = () =>
      countBudget(ir, () => {
        for (let round = 0; round < 1000 && frames.length > 0; round++)
          for (const frame of frames.splice(0)) frame(0)
      }).counts
    const list = ir.querySelector<HTMLElement>(':scope > ul')!
    return { ir, emit, runFrames, list }
  }

  describe.each([1, 4, 16] as Factor[])('at factor %i', (factor) => {
    it('a paragraph change makes no root query', async () => {
      const { ir, emit, runFrames } = setup(factor)
      const paragraph = Array.from(ir.children).find((block) =>
        block.textContent?.startsWith('Fourth paragraph'),
      ) as HTMLElement
      paragraph.firstChild!.textContent = 'Fourth paragraph, edited.'
      emit({
        whole: false,
        changed: [unit(paragraph, 'paragraph')],
        scopes: [paragraph],
      })
      await settle()
      const counts = runFrames()
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(paragraph) + ir.childElementCount,
      )
    })

    it('a list item change reconciles its list with no root query', async () => {
      const { ir, emit, runFrames, list } = setup(factor)
      const item = list.children[2] as HTMLElement
      item.append(document.createElement('wbr'))
      emit({
        whole: false,
        changed: [unit(item, 'list-item', list)],
        structural: [list],
        scopes: [item],
      })
      await settle()
      const counts = runFrames()
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(list) + ir.childElementCount,
      )
    })

    it('a pending list replaced before the frame takes the change scopes, not a whole pass', async () => {
      const { ir, emit, runFrames, list } = setup(factor)
      emit({
        whole: false,
        changed: [unit(list.children[2] as HTMLElement, 'list-item', list)],
        structural: [list],
        scopes: [list.children[2] as HTMLElement],
      })
      const replacement = list.cloneNode(true) as HTMLElement
      list.replaceWith(replacement)
      const item = replacement.children[2] as HTMLElement
      emit({
        whole: false,
        changed: [unit(item, 'list-item', replacement)],
        structural: [replacement],
        scopes: [item],
      })
      await settle()
      const counts = runFrames()
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBeLessThanOrEqual(
        nodesIn(replacement) + ir.childElementCount,
      )
    })
  })

  it('a heading change still refreshes its fold', async () => {
    const { ir, emit, runFrames } = setup(1, {
      headings: [{ id: 'Code', text: 'Code', level: 2 }],
      lists: [],
    })
    const heading = Array.from(ir.children).find(
      (block) => block.textContent === '## Code',
    ) as HTMLElement
    expect(heading.hasAttribute('data-vmde-folded')).toBe(true)
    // A respin replaces the heading with one that carries no fold attributes.
    const respun = heading.cloneNode(true) as HTMLElement
    respun.removeAttribute('data-vmde-folded')
    respun.removeAttribute('data-vmde-foldable')
    delete respun.dataset.vmdeFoldCount
    heading.replaceWith(respun)
    emit({
      whole: false,
      changed: [unit(respun, 'heading')],
      structural: [respun],
      scopes: [respun],
    })
    await settle()
    const counts = runFrames()
    expect(respun.hasAttribute('data-vmde-folded')).toBe(true)
    expect(
      respun.nextElementSibling?.hasAttribute('data-vmde-fold-hidden'),
    ).toBe(true)
    // Heading folds may iterate the root's children, never query the root.
    expect(counts.rootQueries).toBe(0)
    expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(
      ir.childElementCount + nodesIn(respun),
    )
  })

  it('a whole change runs the whole fold pass', async () => {
    const { ir, emit, runFrames, list } = setup(1)
    const stale = list.children[0] as HTMLElement
    stale.setAttribute('data-vmde-list-foldable', '1')
    emit({ whole: true, cause: 'rebind' })
    await settle()
    const counts = runFrames()
    expect(stale.hasAttribute('data-vmde-list-foldable')).toBe(false)
    expect(counts.rootQueries).toBeGreaterThan(0)
    expect(ir.isConnected).toBe(true)
  })
})

// Task 733 (D-13 B-01 rules, design 1.1): the whole fold pass and the glyph alignment run as the
// background jobs `fold-apply` (frame lane) and `fold-glyphs` (idle lane) on the shared scheduler,
// in slices measured on the cost clock.
describe('section fold background jobs (Task 733)', {
  timeout: BUDGET_TIMEOUT_MS,
}, () => {
  const FRAME_LIMIT_MS = 4 + 2
  afterEach(() => {
    provideUnitFeed(window, undefined)
  })

  function setupJobs(factor: Factor, nestItems = false) {
    const ir = irFixture(tableHeavyMarkdown(factor), () => undefined).root
    const list = ir.querySelector<HTMLElement>(':scope > ul')!
    // Items with a nested list are foldable, so each one has a glyph to align.
    if (nestItems)
      for (const item of Array.from(list.children))
        item.insertAdjacentHTML('beforeend', '<ul><li>nested</li></ul>')
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback),
    )
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    vi.stubGlobal('requestIdleCallback', () => 0)
    vi.stubGlobal('cancelIdleCallback', () => undefined)
    const listeners = new Set<(change: UnitsChange) => void>()
    const feed: UnitFeed = {
      root: ir,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    const clock = costClock()
    const lanes = fakeLanes(clock)
    const scheduler = createBackgroundScheduler(lanes)
    const options = {
      surface: () => ir,
      initialState: {
        headings: [{ id: 'Code', text: 'Code', level: 2 }],
        lists: [],
      },
      scheduler,
    }
    createSectionFoldController({} as never, options)
    // Runs the controller's own frames and `count` scheduler frames (or idle callbacks of `idle` ms),
    // all counted so that every operation charges the cost clock.
    const drive = (count: number, idle?: number) =>
      countBudget(ir, () => {
        for (let index = 0; index < count; index++) {
          for (const frame of frames.splice(0)) frame(0)
          if (idle === undefined) lanes.runFrame()
          else lanes.runIdle(idle)
        }
      }).counts
    const whole = () => {
      const change: UnitsChange = {
        cause: 'rebind',
        whole: true,
        changed: [],
        structural: [],
      }
      for (const listener of Array.from(listeners)) listener(change)
    }
    return { ir, list, scheduler, drive, whole }
  }

  it.each([1, 4, 16] as Factor[])(
    'a whole change runs the fold pass as the fold-apply job in frame slices at factor %i',
    async (factor) => {
      const { ir, list, scheduler, drive, whole } = setupJobs(factor)
      const heading = Array.from(ir.children).find(
        (block) => block.textContent === '## Code',
      ) as HTMLElement
      const stale = list.children[0] as HTMLElement
      stale.setAttribute('data-vmde-list-foldable', '1')
      heading.removeAttribute('data-vmde-folded')
      whole()
      await new Promise<void>((done) => setTimeout(done, 0))
      drive(400)
      const stats = scheduler.stats('fold-apply')
      expect(stats.slices).toBeGreaterThan(0)
      expect(stats.overruns).toBe(0)
      expect(stats.maxSliceMs).toBeLessThanOrEqual(FRAME_LIMIT_MS)
      expect(stale.hasAttribute('data-vmde-list-foldable')).toBe(false)
      expect(heading.hasAttribute('data-vmde-folded')).toBe(true)
      expect(
        heading.nextElementSibling?.hasAttribute('data-vmde-fold-hidden'),
      ).toBe(true)
    },
  )

  it.each([
    [16, 50],
    [16, 3],
  ] as Array<[Factor, number]>)(
    'aligns the glyphs as the fold-glyphs job in idle slices at factor %i with %i ms idle',
    (factor, idle) => {
      const { list, scheduler, drive } = setupJobs(factor, true)
      const counts = drive(400, idle)
      const stats = scheduler.stats('fold-glyphs')
      expect(stats.slices).toBeGreaterThan(0)
      expect(stats.overruns).toBe(0)
      expect(stats.maxSliceMs).toBeLessThanOrEqual(Math.min(idle, 8) + 2)
      // Every foldable item is measured once the job is done.
      expect(counts.layoutReads).toBeGreaterThanOrEqual(list.children.length)
    },
  )
})

// ---- Task 733 / 013-T5: B-11 on the WYSIWYG fixture (D-13 design section 5.2; technical task 013) ----
//
// `createSectionFoldController` over a live feed of Lute's WYSIWYG root (the table-heavy fixture). B-11: a scoped paragraph change queries nothing on
// the root; a heading change still refreshes the folds.
describe('013 B-11 createSectionFoldController on the WYSIWYG fixture', () => {
  const feedListeners = new Set<(change: UnitsChange) => void>()
  let wysiwygFrames: FrameRequestCallback[] = []
  let stop: (() => void) | undefined
  beforeEach(() => {
    wysiwygFrames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      wysiwygFrames.push(cb)
      return wysiwygFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    provideUnitFeed(window, undefined)
    feedListeners.clear()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })
  const runWysiwygFrames = (): void => {
    for (let round = 0; round < 5 && wysiwygFrames.length > 0; round++)
      for (const frame of wysiwygFrames.splice(0)) frame(0)
  }
  const settleWysiwyg = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    runWysiwygFrames()
  }
  /** The observer callbacks of the edit run; the frames they queue run inside the count. */
  const flushRecords = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
  }
  const nodesOf = (elements: readonly Element[]): number =>
    elements.reduce((sum, el) => sum + 1 + el.querySelectorAll('*').length, 0)
  const emit = (partial: Partial<UnitsChange>): void => {
    const change = {
      cause: 'mutation',
      whole: false,
      changed: [],
      structural: [],
      ...partial,
    } as UnitsChange
    for (const listener of Array.from(feedListeners)) listener(change)
  }
  const unitOf = (
    el: HTMLElement,
    kind: LiveUnit['kind'],
    top = el,
  ): LiveUnit => ({
    el,
    members: [el],
    kind,
    top,
  })
  async function mountWysiwyg(factor: Factor) {
    const app = document.createElement('div')
    // The production mount: observers watch `#app`, so its queries count as root queries.
    app.id = 'app'
    app.className = 'vditor vditor-wysiwyg'
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = wysiwygFixture(MARKDOWN(factor)).root.innerHTML
    app.append(root)
    document.body.append(app)
    vi.stubGlobal('vditor', {
      getCurrentMode: () => 'wysiwyg',
      vditor: { currentMode: 'wysiwyg', wysiwyg: { element: root } },
    })
    const feed: UnitFeed = {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: (listener) => {
        feedListeners.add(listener)
        return () => feedListeners.delete(listener)
      },
      confirmNow: () => true,
      confirmedLines: () => undefined,
    }
    provideUnitFeed(window, feed)
    {
      const controller = createSectionFoldController(
        window.vditor as never,
        { surface: () => root } as never,
      )
      controller.apply()
      stop = () => controller.dispose()
    }
    await settleWysiwyg()
    return { app, root }
  }

  const MARKDOWN = (factor: Factor): string => tableHeavyMarkdown(factor)

  describe.each([1, 4, 16] as const)('at factor %i', (factor) => {
    it('a paragraph change queries nothing on the root and at most its scope plus the top-level count', async () => {
      const { root } = await mountWysiwyg(factor)
      const paragraph = root.querySelector(':scope > p') as HTMLElement
      ;(paragraph.firstChild as Text).data += 'x'
      await flushRecords()
      const { counts } = countBudget(root, () => {
        emit({
          changed: [unitOf(paragraph, 'paragraph')],
          scopes: [paragraph],
        } as Partial<UnitsChange>)
        runWysiwygFrames()
      })
      expect(counts.rootQueries, 'root queries').toBe(0)
      expect(counts.queriedNodes, 'queried nodes').toBeLessThanOrEqual(
        nodesOf([paragraph]) + root.children.length,
      )
    }, 60_000)
    it('a heading change still refreshes the folds', async () => {
      const { root } = await mountWysiwyg(factor)
      const heading = root.querySelector(':scope > h2') as HTMLElement
      ;(heading.firstChild as Text).data += 'x'
      await flushRecords()
      emit({
        changed: [unitOf(heading, 'heading')],
        scopes: [heading],
      } as Partial<UnitsChange>)
      runWysiwygFrames()
      expect(
        heading.hasAttribute('data-vmde-foldable'),
        'heading foldable',
      ).toBe(true)
    }, 60_000)
  })
})
