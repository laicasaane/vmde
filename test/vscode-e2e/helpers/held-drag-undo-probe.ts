/** Test-only instrumentation shared by Chromium and real VS Code. Never returns source text. */
export function installHeldDragUndoProbe() {
  const win = window as any
  const inner = win.vditor.vditor
  let armed = false
  let held = false
  let bridgeDepth = 0
  let undoDepth = 0
  let activeTimer: number | null = null
  let injected = false
  let source = ''
  let events: any[] = []
  const jobs = new Map<number, any>()
  const timers: any[] = []
  const originalTimeout = window.setTimeout
  const originalClear = window.clearTimeout
  const record = (kind: string, extra: object = {}) => {
    if (armed)
      events.push({
        kind,
        at: performance.now(),
        held,
        bridgeDepth,
        undoDepth,
        activeTimer,
        ...extra,
      })
  }
  window.setTimeout = ((
    callback: TimerHandler,
    delay?: number,
    ...args: any[]
  ) => {
    if (typeof callback !== 'function')
      return originalTimeout.call(window, callback, delay, ...args)
    let id = 0
    id = originalTimeout.call(
      window,
      function (this: Window, ...values: any[]) {
        const job = jobs.get(id)
        const previous = activeTimer
        activeTimer = id
        if (job) {
          job.firedAt = performance.now()
          record('timer', { ...job })
        }
        try {
          return callback.apply(this, values)
        } finally {
          activeTimer = previous
          jobs.delete(id)
        }
      },
      delay,
      ...args,
    )
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = (id?: number) => {
    if (id !== undefined && jobs.has(id)) {
      jobs.get(id).cancelled = true
      jobs.delete(id)
    }
    return originalClear.call(window, id)
  }
  for (const [mode, property] of [
    ['ir', 'processTimeoutId'],
    ['wysiwyg', 'afterRenderTimeoutId'],
  ]) {
    const owner = inner[mode]
    let value = owner[property]
    Object.defineProperty(owner, property, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (id) => {
        value = id
        const job = {
          id,
          mode,
          property,
          delay: inner.options.undoDelay,
          armedAt: performance.now(),
          firedAt: 0,
          cancelled: false,
        }
        timers.push(job)
        jobs.set(id, job)
      },
    })
  }
  const request = win.__vmdeRequestCaret
  if (typeof request !== 'function')
    throw new Error('caret bridge is not installed')
  win.__vmdeRequestCaret = function (...args: any[]) {
    bridgeDepth++
    record('request-caret', { stack: new Error().stack })
    try {
      const placed = request.apply(this, args)
      const selection = getSelection()
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      record('repair', {
        placed,
        caretHeight: range?.getBoundingClientRect().height ?? 0,
      })
      return placed
    } finally {
      bridgeDepth--
    }
  }
  const addUndo = inner.undo.addToUndoStack
  inner.undo.addToUndoStack = function (...args: any[]) {
    undoDepth++
    record('undo-snapshot', { stack: new Error().stack })
    try {
      return addUndo.apply(this, args)
    } finally {
      undoDepth--
    }
  }
  for (const method of ['setBaseAndExtent', 'addRange', 'removeAllRanges']) {
    const prototype = Selection.prototype as any
    const original = prototype[method]
    prototype[method] = function (...args: any[]) {
      if (held)
        record('selection-write', {
          method,
          afterInjection: injected,
          immediateRepair: bridgeDepth > 0 && undoDepth > 0,
          stack: new Error().stack,
        })
      return original.apply(this, args)
    }
  }
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return
      held = true
      record('pointerdown', {
        pending: [...jobs.values()].map((job) => ({ ...job })),
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      })
    },
    true,
  )
  window.addEventListener(
    'pointerup',
    () => {
      record('pointerup')
      held = false
    },
    true,
  )
  window.addEventListener(
    'pointercancel',
    () => {
      record('pointercancel')
      held = false
    },
    true,
  )
  win.__heldDragProbe = {
    timerState: () => ({
      pending: jobs.size,
      completed: timers.filter((t) => t.firedAt).length,
      scheduled: timers.length,
    }),
    prepare() {
      armed = false
      getSelection()?.removeAllRanges()
      source = win.vditor.getValue()
      injected = false
      events = []
    },
    arm() {
      armed = true
    },
    inject() {
      if (!held) throw new Error('forced snapshot requires a held pointer')
      inner.undo.addToUndoStack(inner)
      injected = true
    },
    stop() {
      armed = false
      const selection = getSelection()!
      const range = document.createRange()
      if (selection.anchorNode && selection.focusNode) {
        range.setStart(selection.anchorNode, selection.anchorOffset)
        range.setEnd(selection.focusNode, selection.focusOffset)
      }
      return {
        events,
        selectedLength: selection.toString().length,
        forward: !range.collapsed,
        sourceUnchanged: win.vditor.getValue() === source,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
      }
    },
  }
}

export function heldDragPoints(paragraph: Element) {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text)
  const point = (offset: number) => {
    for (const text of nodes) {
      if (offset <= text.length) {
        const range = document.createRange()
        range.setStart(text, offset)
        range.collapse(true)
        const rect = range.getBoundingClientRect()
        const box = paragraph.getBoundingClientRect()
        if (!rect.height) throw new Error('drag endpoint is not painted')
        return { x: rect.x - box.x + 0.2, y: rect.y - box.y + rect.height / 2 }
      }
      offset -= text.length
    }
    throw new Error('fixture is too short for a full native drag')
  }
  return { start: point(2), end: point(40) }
}

// The duration is part of the gesture: each step lets at least two frames run, and the complete
// drag crosses the natural 800 ms snapshot window. This is not a pre-gesture settling sleep.
export function heldDragFrames() {
  return new Promise<void>((resolve) => {
    const start = performance.now()
    let frames = 0
    const tick = () => {
      frames++
      if (frames >= 2 && performance.now() - start >= 100) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

export async function runHeldDrag(
  page: any,
  body: any,
  paragraph: any,
  inject: boolean,
) {
  await body.evaluate(() => (window as any).__heldDragProbe.prepare())
  const points = await paragraph.evaluate(heldDragPoints)
  const box = await paragraph.boundingBox()
  if (!box) throw new Error('drag paragraph has no box')
  const start = { x: box.x + points.start.x, y: box.y + points.start.y }
  const end = { x: box.x + points.end.x, y: box.y + points.end.y }
  await page.mouse.move(start.x, start.y)
  await body.evaluate(() => (window as any).__heldDragProbe.arm())
  await page.mouse.down()
  try {
    if (inject)
      await body.evaluate(() => (window as any).__heldDragProbe.inject())
    for (let step = 1; step <= 12; step++) {
      await page.mouse.move(
        start.x + ((end.x - start.x) * step) / 12,
        start.y + ((end.y - start.y) * step) / 12,
      )
      await body.evaluate(heldDragFrames)
    }
  } finally {
    await page.mouse.up()
  }
  return body.evaluate(() => (window as any).__heldDragProbe.stop())
}
