// Task 661: a painted-frame probe for the live toolbar and the instant-paint placeholder. It is
// installed with `context.addInitScript` before the editor opens, runs in every child frame of the
// workbench page and samples once per animation frame. It reads state only; it changes nothing.

export interface ToolbarFlowProbe {
  // Painted frames in which any toolbar (the live one or the teaser's) was sampled.
  frames: number
  // Frames that held the placeholder element, with or without a toolbar inside it.
  overlayFrames: number
  devicePixelRatio: number
  // Unique "teaser:<height>" / "live:<height>" entries in first-seen order (height rounded to 0.01).
  heightLog: string[]
  // Frames of the live toolbar (the teaser is gone, the toolbar has width), and those among them
  // painted while the editor is still streaming (`vmde-streaming` is set).
  liveFrames: number
  liveStreamingFrames: number
  // What the first live frame showed.
  firstLiveFrame: { height: number; flatItems: number; rows: number } | null
  // Invariants broken by a live frame, with the viewport width of that frame.
  violations: string[]
}

// Must stay self-contained: Playwright serializes the function into the page.
export function toolbarFrameProbeScript() {
  if (window.top === window) return
  const store: ToolbarFlowProbe = {
    frames: 0,
    overlayFrames: 0,
    devicePixelRatio: window.devicePixelRatio,
    heightLog: [],
    liveFrames: 0,
    liveStreamingFrames: 0,
    firstLiveFrame: null,
    violations: [],
  }
  ;(
    window as unknown as { __toolbarFlowProbe: ToolbarFlowProbe }
  ).__toolbarFlowProbe = store
  const shown = (element: Element) =>
    getComputedStyle(element).display !== 'none'
  const when = (condition: boolean, text: string): string[] =>
    condition ? [text] : []
  const logHeight = (kind: string, height: number) => {
    const entry = `${kind}:${(Math.round(height * 100) / 100).toString()}`
    if (!store.heightLog.includes(entry)) store.heightLog.push(entry)
  }
  const liveViolations = (
    toolbar: HTMLElement,
    overflow: boolean,
  ): string[] => {
    const height = toolbar.getBoundingClientRect().height
    const collapsed = toolbar.classList.contains('vmde-toolbar--collapsed')
    const twoRows = toolbar.classList.contains('vmde-toolbar--two-rows')
    const want = collapsed ? 25 : twoRows ? 61.4 : 36
    const rows = Array.from(
      toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    )
    const flat = toolbar.querySelectorAll(
      ':scope > .vditor-toolbar__item, :scope > .vditor-toolbar__divider',
    ).length
    const buttons = rows
      .filter(shown)
      .flatMap((row) => Array.from(row.children).filter(shown))
      .map((item) => item.querySelector<HTMLElement>(':scope > [data-type]'))
      .filter((button): button is HTMLElement => button !== null)
    const empty = (element: Element | null) => {
      const box = element?.getBoundingClientRect()
      return box === undefined || box.width === 0 || box.height === 0
    }
    return [
      ...when(flat > 0, `${flat} flat toolbar children`),
      ...when(rows.length !== 2, `${rows.length} toolbar rows`),
      ...when(
        Math.abs(height - want) > 0.25,
        `height ${height} against ${want}`,
      ),
      ...rows
        .filter(shown)
        .filter((row) => overflow && row.scrollWidth > row.clientWidth + 1)
        .map((row) => `row overflows ${row.scrollWidth} > ${row.clientWidth}`),
      ...buttons
        .filter((button) => empty(button))
        .map((button) => `${button.dataset.type} has an empty box`),
      ...buttons
        .filter((button) => empty(button.querySelector('svg')))
        .map((button) => `${button.dataset.type} icon is empty`),
    ]
  }
  // A teaser frame counts once the stylesheet that gives the toolbar its 1 px bottom border has
  // applied; before that the frame is not the one that gets painted.
  const sampleTeaser = (overlay: HTMLElement | null) => {
    store.overlayFrames += overlay ? 1 : 0
    const teaser = overlay?.querySelector<HTMLElement>('.vditor-toolbar')
    if (!teaser) return
    store.frames++
    if (getComputedStyle(teaser).borderBottomWidth !== '0px')
      logHeight('teaser', teaser.getBoundingClientRect().height)
  }
  // Reads the live toolbar. `settled` is true for a reading taken after the flow controller's
  // ResizeObserver ran (the state that gets painted); an animation-frame callback runs before it,
  // so the width-dependent row overflow check is skipped there.
  const sampleLive = (live: HTMLElement, settled: boolean) => {
    if (live.getBoundingClientRect().width === 0) return
    store.frames++
    store.liveFrames++
    const height = live.getBoundingClientRect().height
    logHeight('live', height)
    if (document.querySelector('.vmde-streaming')) store.liveStreamingFrames++
    if (!store.firstLiveFrame)
      store.firstLiveFrame = {
        height,
        flatItems: live.querySelectorAll(
          ':scope > .vditor-toolbar__item, :scope > .vditor-toolbar__divider',
        ).length,
        rows: live.querySelectorAll(':scope > .vmde-toolbar-row').length,
      }
    for (const reason of liveViolations(live, settled)) {
      if (store.violations.length < 40)
        store.violations.push(`w${window.innerWidth}: ${reason}`)
    }
  }
  // Created at the first live frame, i.e. after the flow controller's own observers (they are
  // installed in the task that builds the rows), so it is notified after them and before paint.
  let paintObserver: ResizeObserver | null = null
  const watchPaint = () => {
    if (paintObserver) return
    paintObserver = new ResizeObserver(() => {
      const live = document.querySelector<HTMLElement>('#app .vditor-toolbar')
      if (live && !document.getElementById('vmde-prerender'))
        sampleLive(live, true)
    })
    paintObserver.observe(document.documentElement)
  }
  const sampleOnce = () => {
    const overlay = document.getElementById('vmde-prerender')
    const live = document.querySelector<HTMLElement>('#app .vditor-toolbar')
    sampleTeaser(overlay)
    if (overlay || !live) return
    sampleLive(live, false)
    if (live.querySelector(':scope > .vmde-toolbar-row')) watchPaint()
  }
  let armedOn: Element | null = null
  const sample = (root: Element) => {
    if (root !== document.documentElement) return
    sampleOnce()
    requestAnimationFrame(() => sample(root))
  }
  // A webview's content frame starts as `about:blank` and its document is replaced; a 1 ms timer
  // survives the replacement and arms the sampler on every new root element.
  setInterval(() => {
    const root = document.documentElement
    if (!root || root === armedOn) return
    armedOn = root
    requestAnimationFrame(() => sample(root))
  }, 1)
}

export const readToolbarFlowProbe = (frame: {
  locator: (selector: string) => {
    evaluate: <T>(fn: () => T) => Promise<T>
  }
}) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __toolbarFlowProbe?: ToolbarFlowProbe })
          .__toolbarFlowProbe ?? null,
    )
