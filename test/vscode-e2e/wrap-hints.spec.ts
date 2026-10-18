/**
 * Task 640 S3 - prioritized wrap points ("wrap hints") in the real VS Code webview.
 *
 * Expected positions come from the Owner contract (tasks/done/640-long-word-wrap-break-priority.md),
 * applied by hand to the Owner path, never read from the implementation:
 *   ../ | EncosyTower. | Tests. | EditorMode/ | EncosyTower. | PageFlows/ | PageFlowTestDoubles. | cs
 *   priority-1 offsets 3 15 21 32 44 54 (74 before `cs` is dropped by the final-piece rule, N = 3);
 *   priority-3 offsets inside the too-wide last piece: 58 62 66; N = 0 allows 74.
 * The width regimes are set in glyph advances of the page's own code font (measured from a probe
 * code), so they hold in any font: WIDE 82 (the path fits, no hint), MID 40 (the widest priority-1
 * piece fits), NARROW 16 (that piece does not fit, every priority-3 piece does). The webview has
 * no resizable viewport here, so the line width is tuned with an injected `max-width` on the edit
 * surface and re-measured (the same loop as the Chromium spec's fitWidth). The webview is narrow
 * (about 632 px), so the glyphs are shrunk first until WIDE is reachable; a Preview pane too narrow
 * even then skips WIDE only. Rendered breaks must be hints, or overflow breaks inside a piece wider
 * than the line (no hint tier can help there).
 *
 * Blocks (each boots VS Code):
 *  1. IR: fixture layout (code path, plain path, table column widths), hints are not edits, and a
 *     live `vmde.editor.wrapHints.minLastPiece` change without a re-init.
 *  2. WYSIWYG: the same layout and not-an-edit checks.
 *  3. SV: the source line has no hint and is unchanged; the Preview pane carries the same layout.
 *  4. OS (XTEST) typing in a hinted word is one Undo step and Ctrl+Z restores the exact bytes; OS
 *     Ctrl+C of the hinted path gives the source text. Needs VMDE_XTEST=1.
 * Fenced code blocks are out of scope (Owner decision 2026-10-18); the setting protects the last
 * piece only.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { FrameLocator } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAll,
  endSelectionGesture,
  evalFrame,
  hostState,
  makeKit,
  openDocument,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'wrap-hints.md')
const ORIGINAL = readFileSync(FIXTURE, 'utf8')
const PATH =
  '../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs'
const P1 = [3, 15, 21, 32, 44, 54]
const P3_ALL = [9, 27, 38, 48, 58, 62, 66]
const P1_AND_P3 = [3, 15, 21, 32, 44, 54, 58, 62, 66]
// Priority-1 piece bounds of the path, for the plain-text regimes.
const P1_BOUNDS = [0, 3, 15, 21, 32, 44, 54, PATH.length]

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Surface = Mode | 'preview'
type Kind = 'code' | 'plain' | 'cell'
const SURFACE: Record<Surface, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
  sv: '.vditor-sv',
  preview: '.vditor-preview .vditor-reset',
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    const global = vscode.ConfigurationTarget.Global
    await config.update('editor.defaultMode', undefined, global)
    await config.update('editor.wrapHints.minLastPiece', undefined, global)
  })
})

// ---------------------------------------------------------------------------------------------
// In-page reader (window.__wh): the Owner path in one container kind, as hint offsets, rendered
// line breaks, widths and the line box. Installed once per surface.

function installReader(_body: Element, selector: string) {
  const TAIL = 'PageFlowTestDoubles.cs'
  const root = () => document.querySelector(selector) as HTMLElement
  const isHint = (node: Node) =>
    node.nodeType === 1 &&
    (node as Element).classList.contains('vmde-wrap-hint')
  interface Run {
    el: Element
    nodes: Text[]
    offsets: number[]
    start: number
  }
  // Every Text node below `el` in document order (markers excluded) and the hint spans between
  // them, so a code split by hint spans, or an element nested in the container, still gives one run.
  function runOf(el: Element): Run | null {
    const nodes: Text[] = []
    const offsets: number[] = []
    let length = 0
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    )
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if ((n.parentElement as Element).closest('.vditor-ir__marker')) continue
        nodes.push(n as Text)
        length += (n as Text).length
      } else if (isHint(n)) offsets.push(length)
    }
    const text = nodes.map((node) => node.data).join('')
    if (!text.includes(TAIL) || !text.includes('../')) return null
    const start = text.indexOf('../')
    return {
      el,
      nodes,
      offsets: offsets.filter((o) => o >= start && o <= start + 76),
      start,
    }
  }
  const diagnose = () =>
    [...root().querySelectorAll('code')]
      .map(
        (c) =>
          `<${c.tagName.toLowerCase()} in ${c.parentElement?.tagName.toLowerCase()} len=${(c.textContent ?? '').length} hints=${c.querySelectorAll('.vmde-wrap-hint').length} text=${(c.textContent ?? '').slice(0, 24)}>`,
      )
      .join(' ')
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page finder of the path run per container kind
  function find(kind: string): Run {
    let hit: Run | null = null
    if (kind === 'plain') {
      for (const el of root().querySelectorAll('*')) {
        if (
          Array.from(el.childNodes).some(
            (c) => c.nodeType === 3 && (c as Text).data.includes('Plain text'),
          )
        )
          hit ??= runOf(el)
      }
    } else if (kind === 'cell') {
      const table = root().querySelectorAll('table')[0] as HTMLTableElement
      const code = table.rows[1].cells[0].querySelector('code')
      hit = code ? runOf(code) : null
    } else {
      for (const code of root().querySelectorAll('code')) {
        if (
          !code.closest(
            'td, th, li, h1, h2, h3, h4, h5, h6, pre:not(.vditor-reset)',
          )
        )
          hit ??= runOf(code)
      }
    }
    if (!hit)
      throw new Error(
        `no path run for ${kind}; root=${selector} found=${root() ? 'yes' : 'no'}; codes: ${diagnose()}`,
      )
    return hit
  }
  const locate = (run: Run, offset: number, atEnd: boolean): [Text, number] => {
    let rest = run.start + offset
    for (const node of run.nodes) {
      if (rest < node.length || (atEnd && rest === node.length))
        return [node, rest]
      rest -= node.length
    }
    const last = run.nodes[run.nodes.length - 1]
    return [last, last.length]
  }
  const width = (run: Run, a: number, b: number) => {
    const range = document.createRange()
    range.setStart(...locate(run, a, false))
    range.setEnd(...locate(run, b, true))
    let sum = 0
    for (const rect of Array.from(range.getClientRects())) sum += rect.width
    return sum
  }
  const fits: Record<string, number> = {}
  const fonts: Record<string, number> = {}
  const style = () => {
    let element = document.getElementById('vmde-wh-fit')
    if (!element) {
      element = document.createElement('style')
      element.id = 'vmde-wh-fit'
      document.head.appendChild(element)
    }
    return element
  }
  // The product pins the surface with `max-width: none !important` under `body[data-full-width]`
  // (higher specificity than any plain class selector), so every rule here carries an id-level
  // `:not(#vmde-wh-id)`, which outranks all class and attribute selectors without touching the DOM.
  const paint = () => {
    const rules = [
      ...new Set([...Object.keys(fits), ...Object.keys(fonts)]),
    ].map(
      (sel) =>
        `${sel}:not(#vmde-wh-id){${
          sel in fits
            ? `max-width:${fits[sel]}px !important;min-width:0 !important;margin-left:0 !important;margin-right:0 !important;`
            : ''
        }${sel in fonts ? `font-size:${fonts[sel]}px !important;` : ''}}`,
    )
    rules.push('.vmde-wh-anc:not(#vmde-wh-id){min-width:0 !important}')
    style().textContent = rules.join('\n')
  }
  ;(window as any).__wh = {
    // The advance of one glyph of the code font, from the probe code.
    advance: () => {
      const code = [...root().querySelectorAll('code')].find(
        (c) =>
          c.textContent?.includes('aaaaaaaaaa') && c.textContent.length <= 11,
      ) as HTMLElement
      const range = document.createRange()
      range.selectNodeContents(code)
      return range.getBoundingClientRect().width / 10
    },
    // Constrain a surface to `px` and re-measure the path's line box (the container's content
    // width, as the engine reads it) and the code's own edges (padding and border).
    fit: (target: string, px: number, kind: string) => {
      fits[target] = px
      // A flex or grid ancestor keeps min-width:auto, which floors the surface at its content's
      // min-content; release it on the whole ancestor chain (a class is not observed by the engine).
      for (
        let el = root().parentElement;
        el && el !== document.documentElement;
        el = el.parentElement
      )
        el.classList.add('vmde-wh-anc')
      paint()
      return (window as any).__wh.box(kind)
    },
    // The surface's own font size (code is 0.85em of it): shrinks the glyphs so a narrow webview
    // can still reach the regimes that need a wide line. Returns the size now in effect.
    font: (target: string, px: number | null) => {
      if (px === null) delete fonts[target]
      else fonts[target] = px
      paint()
      return parseFloat(getComputedStyle(root()).fontSize)
    },
    box: (kind: string) => {
      const run = find(kind)
      const host = run.el.closest('p, td, th, [data-block]') as HTMLElement
      const cs = getComputedStyle(host)
      const line =
        host.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight)
      let edges = 0
      if (run.el.tagName === 'CODE') {
        const ec = getComputedStyle(run.el)
        edges =
          parseFloat(ec.paddingLeft) +
          parseFloat(ec.paddingRight) +
          parseFloat(ec.borderLeftWidth) +
          parseFloat(ec.borderRightWidth)
      }
      return {
        line,
        edges,
        surface: root().getBoundingClientRect().width,
        font: parseFloat(getComputedStyle(root()).fontSize),
        innerWidth: window.innerWidth,
      }
    },
    // The surface and its ancestors: width, min-width, display; for the failure trace.
    chain: () => {
      const out: string[] = []
      for (let el: Element | null = root(); el; el = el.parentElement) {
        const cs = getComputedStyle(el)
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 24)} w=${Math.round(el.getBoundingClientRect().width)} min=${cs.minWidth} max=${cs.maxWidth} disp=${cs.display} box=${cs.boxSizing}`,
        )
      }
      const table = root().querySelector('table')
      const info = (el: Element | null) => {
        if (!el) return 'none'
        const cs = getComputedStyle(el)
        return `${el.tagName.toLowerCase()} w=${Math.round(el.getBoundingClientRect().width)} computed-width=${cs.width} max=${cs.maxWidth} inline=${(el as HTMLElement).style.cssText.slice(0, 80)}`
      }
      return `${out.join(' < ')}\nsurface: ${info(root())}\ntable: ${info(table)}\ntable wrapper: ${info(table?.parentElement ?? null)}`
    },
    // The contract's tier gating applied to the measured pieces at the current line width.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: in-page tier gating of the measured pieces
    expected: (kind: string, tiers: number[][]) => {
      const run = find(kind)
      const { line, edges } = (window as any).__wh.box(kind)
      const limit = line - edges
      if (width(run, 0, 76) <= limit) return []
      let cuts: number[] = []
      for (const tier of tiers) {
        const bounds = [0, ...cuts, 76]
        const added: number[] = []
        for (let i = 1; i < bounds.length; i += 1)
          if (width(run, bounds[i - 1], bounds[i]) > limit)
            for (const offset of tier)
              if (offset > bounds[i - 1] && offset < bounds[i])
                added.push(offset)
        cuts = [...cuts, ...added].sort((x, y) => x - y)
      }
      return cuts
    },
    // The measured numbers a failure message needs.
    diag: (kind: string, bounds: number[]) => {
      const run = find(kind)
      const box = (window as any).__wh.box(kind)
      const table = root().querySelectorAll('table')[0] as
        | HTMLElement
        | undefined
      return JSON.stringify({
        innerWidth: window.innerWidth,
        surface: root().getBoundingClientRect().width,
        table: table?.getBoundingClientRect().width,
        line: box.line,
        edges: box.edges,
        pieces: bounds.slice(1).map((b, i) => width(run, bounds[i], b)),
      })
    },
    hints: (kind: string) => {
      const run = find(kind)
      return run.offsets.map((offset) => offset - run.start)
    },
    width: (kind: string, a: number, b: number) => width(find(kind), a, b),
    // Offsets in the path where a rendered line starts, strictly inside it.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page reader of the rendered line starts
    breaks: (kind: string) => {
      const run = find(kind)
      const range = document.createRange()
      const out: number[] = []
      let top: number | null = null
      let offset = 0
      for (const node of run.nodes) {
        for (let i = 0; i < node.length; i += 1) {
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const rect = range.getClientRects()[0]
          if (rect) {
            const t = Math.round(rect.top)
            if (
              top !== null &&
              t > top + 2 &&
              offset > run.start &&
              offset - run.start < 76
            )
              out.push(offset - run.start)
            if (top === null || t > top + 2) top = t
          }
          offset += 1
        }
      }
      return out
    },
    // Hints below the code or paragraph whose text matches.
    hintsIn: (pattern: string) =>
      [...root().querySelectorAll('code')]
        .filter((c) => new RegExp(pattern).test(c.textContent ?? ''))
        .map((c) => c.querySelectorAll('.vmde-wrap-hint').length),
    totalHints: () => root().querySelectorAll('.vmde-wrap-hint').length,
    tableInfo: (index: number) => {
      const table = root().querySelectorAll('table')[index] as
        | HTMLTableElement
        | undefined
      if (!table) return null
      const cells = Array.from(table.rows[0].cells)
      return {
        auto: /vmde-table-auto-\d+/u.test(table.getAttribute('class') ?? ''),
        first: cells[0].getBoundingClientRect().width,
        table: table.getBoundingClientRect().width,
        columns: cells.length,
        hints: table.querySelectorAll('.vmde-wrap-hint').length,
        changeHints: table.rows[1]?.cells[1]
          ? table.rows[1].cells[1].querySelectorAll('.vmde-wrap-hint').length
          : 0,
      }
    },
  }
}

interface Box {
  line: number
  edges: number
  surface: number
  font: number
  innerWidth: number
}

const wh = {
  advance: (frame: FrameLocator) =>
    frame
      .locator('body')
      .evaluate(() => (window as any).__wh.advance() as number),
  fit: (frame: FrameLocator, target: string, px: number, kind: Kind) =>
    frame
      .locator('body')
      .evaluate((_b, a) => (window as any).__wh.fit(a[0], a[1], a[2]), [
        target,
        px,
        kind,
      ] as const) as Promise<Box>,
  chain: (frame: FrameLocator) =>
    frame
      .locator('body')
      .evaluate(() => (window as any).__wh.chain() as string),
  font: (frame: FrameLocator, target: string, px: number | null) =>
    frame
      .locator('body')
      .evaluate((_b, a) => (window as any).__wh.font(a[0], a[1]), [
        target,
        px,
      ] as const) as Promise<number>,
  box: (frame: FrameLocator, kind: Kind) =>
    frame
      .locator('body')
      .evaluate((_b, k) => (window as any).__wh.box(k), kind) as Promise<Box>,
  hints: (frame: FrameLocator, kind: Kind) =>
    frame
      .locator('body')
      .evaluate((_b, k) => (window as any).__wh.hints(k), kind) as Promise<
      number[]
    >,
  breaks: (frame: FrameLocator, kind: Kind) =>
    frame
      .locator('body')
      .evaluate((_b, k) => (window as any).__wh.breaks(k), kind) as Promise<
      number[]
    >,
  width: (frame: FrameLocator, kind: Kind, a: number, b: number) =>
    frame
      .locator('body')
      .evaluate((_b, x) => (window as any).__wh.width(x[0], x[1], x[2]), [
        kind,
        a,
        b,
      ] as const) as Promise<number>,
  expected: (frame: FrameLocator, kind: Kind, tiers: number[][]) =>
    frame
      .locator('body')
      .evaluate((_b, a) => (window as any).__wh.expected(a[0], a[1]), [
        kind,
        tiers,
      ] as const) as Promise<number[]>,
  diag: (frame: FrameLocator, kind: Kind, bounds: number[]) =>
    frame
      .locator('body')
      .evaluate((_b, a) => (window as any).__wh.diag(a[0], a[1]), [
        kind,
        bounds,
      ] as const) as Promise<string>,
  hintsIn: (frame: FrameLocator, pattern: string) =>
    frame
      .locator('body')
      .evaluate((_b, p) => (window as any).__wh.hintsIn(p), pattern) as Promise<
      number[]
    >,
  totalHints: (frame: FrameLocator) =>
    frame
      .locator('body')
      .evaluate(() => (window as any).__wh.totalHints() as number),
  tableInfo: (frame: FrameLocator, index: number) =>
    frame
      .locator('body')
      .evaluate(
        (_b, i) => (window as any).__wh.tableInfo(i),
        index,
      ) as Promise<{
      auto: boolean
      first: number
      table: number
      columns: number
      hints: number
      changeHints: number
    } | null>,
}

async function install(frame: FrameLocator, surface: Surface) {
  await frame
    .locator('body')
    .evaluate(installReader as never, SURFACE[surface] as never)
}

interface FitResult extends Box {
  reached: boolean
  trace: string
}

/**
 * Tune the line box of `kind` towards `wanted` px by constraining the surface. It never fails: the
 * result says whether the line is within 1.5 px, and carries a trace of every iteration (`max` is
 * the requested surface max-width) so a caller can report or decide on the closest reachable line.
 */
async function fitLine(
  frame: FrameLocator,
  surface: Surface,
  kind: Kind,
  wanted: number,
): Promise<FitResult> {
  let max = wanted + 160
  let last: Box = await wh.fit(frame, SURFACE[surface], max, kind)
  const rows: string[] = []
  for (let i = 0; i < 10; i += 1) {
    last = await wh.fit(frame, SURFACE[surface], max, kind)
    rows.push(
      JSON.stringify({
        i,
        max: Math.round(max * 100) / 100,
        line: Math.round(last.line * 100) / 100,
        surfaceWidth: Math.round(last.surface * 100) / 100,
        fontSize: last.font,
        edges: Math.round(last.edges * 100) / 100,
      }),
    )
    if (Math.abs(last.line - wanted) <= 1.5) break
    max = Math.max(1, max + wanted - last.line)
  }
  const reached = Math.abs(last.line - wanted) <= 1.5
  const trace = `wanted ${Math.round(wanted * 100) / 100} (${kind}), innerWidth ${last.innerWidth}\n${rows.join('\n')}\n${await wh.chain(frame)}`
  return { ...last, reached, trace }
}

const settleLayout = (frame: FrameLocator) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

const poll = <T>(fn: () => Promise<T>, message: string) =>
  expect.poll(fn, { timeout: 15_000, message })

// ---------------------------------------------------------------------------------------------
// Opening and the not-an-edit snapshot.

async function openFixture(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: any,
  baseDir: string,
  mode: Mode,
) {
  const file = path.join(baseDir, `wrap-hints-${mode}.md`)
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          args[1],
          vscode.ConfigurationTarget.Global,
        )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file, mode] as [string, string],
  )
  const frame = wf(workbox)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === mode,
    { timeout: 90_000, message: `${mode} readiness` },
  )
  await waitForInitialUndoSnapshot(frame)
  return { file, frame }
}

/** Host text, dirty flag, disk bytes, the webview value and the Undo/Redo lengths. */
async function snapshot(
  frame: FrameLocator,
  evaluateInVSCode: any,
  file: string,
) {
  const host = (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      return { text: document?.getText() ?? null, dirty: document?.isDirty }
    },
    [file] as [string],
  )) as { text: string | null; dirty: boolean | undefined }
  const view = await frame.locator('body').evaluate(() => {
    const win = window as any
    const inner = win.vditor.vditor
    const slot = inner.undo[inner.currentMode]
    return {
      value: win.vditor.getValue() as string,
      undo: slot.undoStack.length as number,
      redo: slot.redoStack.length as number,
      lastTextHasHint: String(slot.lastText).includes('vmde-wrap-hint'),
      epoch: win.__vmdeE2EReadiness.editorEpoch as number,
    }
  })
  return { host, disk: readFileSync(file, 'utf8'), view }
}

// SV's editable text ends in an extra newline span that the host omits.
const svForm = (text: string) => text.replace(/​/gu, '').replace(/\n+$/u, '')

// The table checks at the natural width (acceptance item 1, tables).
async function expectTables(frame: FrameLocator, surface: Surface) {
  await poll(
    async () => (await wh.tableInfo(frame, 0))?.auto ?? false,
    'the Owner table has its automatic widths',
  ).toBe(true)
  await settleLayout(frame)
  // The applied cell width depends on the real webview width, so the exact set is the contract's
  // tier gating for the measured pieces (computed in the page); the fixed facts hold at any width.
  const CELL_BOUNDS = [0, 3, 15, 21, 32, 44, 54, PATH.length]
  const diagnostics = () => wh.diag(frame, 'cell', CELL_BOUNDS)
  try {
    await poll(async () => {
      const hints = await wh.hints(frame, 'cell')
      const expected = await wh.expected(frame, 'cell', [P1, [], P3_ALL])
      return JSON.stringify([hints, expected])
    }, 'the Owner path in the table cell follows the tier gating').toMatch(
      /^\[(\[[\d,]*\]),\1\]$/,
    )
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nmeasured: ${await diagnostics()}`,
    )
  }
  const hints = await wh.hints(frame, 'cell')
  const measured = await diagnostics()
  for (const offset of P1)
    expect(hints, `P1 ${offset}; ${measured}`).toContain(offset)
  for (const offset of hints)
    expect(
      [...P1, ...P3_ALL],
      `hint ${offset} is in the contract; ${measured}`,
    ).toContain(offset)
  // Last-piece-only rule: nothing in the final zone before `cs`.
  const inZone = (offset: number) => offset >= PATH.length - 3
  expect(
    hints.filter(inZone),
    `no hint in the final zone; ${measured}`,
  ).toEqual([])
  const breaks = await wh.breaks(frame, 'cell')
  expect(breaks.length, `the path column wraps; ${measured}`).toBeGreaterThan(0)
  const box = await wh.box(frame, 'cell')
  const limit = box.line - box.edges
  for (const offset of breaks) {
    if (hints.includes(offset)) {
      expect(inZone(offset), `break ${offset} outside the final zone`).toBe(
        false,
      )
      continue
    }
    // Not a hint: the browser's overflow break. It is only allowed inside a piece (between the
    // neighbouring hints or the word ends) that is wider than the line, where no hint tier can help.
    const lo = Math.max(0, ...hints.filter((hint) => hint < offset))
    const hi = Math.min(PATH.length, ...hints.filter((hint) => hint > offset))
    const piece = await wh.width(frame, 'cell', lo, hi)
    expect(
      piece,
      `break ${offset} is a hint or lies in a piece wider than the line (${lo}-${hi}); ${measured}`,
    ).toBeGreaterThan(limit - 1)
  }
  const owner = await wh.tableInfo(frame, 0)
  // The path column is narrower than the equal share the over-wide fallback would give it. The
  // narrow Preview pane of SV squeezes both columns to about the floor, so there the path column
  // only must not exceed the equal share.
  const share = owner!.table / owner!.columns
  expect(
    owner!.first,
    `path column narrower than the equal share; ${measured}`,
  ).toBeLessThan(surface === 'preview' ? share + 1 : share - 8)
  // The short table has no long word: no hint. The change column's content fits in the edit
  // surfaces' wide table; the narrow Preview pane of SV squeezes it until its own words need hints.
  if (surface !== 'preview') expect(owner!.changeHints).toBe(0)
  expect((await wh.tableInfo(frame, 1))!.hints).toBe(0)
}

/**
 * Shrink the surface's glyphs until a line of 82 code advances fits the webview (the real webview is
 * narrow), then make the engine plan again at the new size: a font change alone resizes nothing, so
 * the width is nudged twice. Returns whether the WIDE code regime is reachable (no, in a narrow
 * Preview pane).
 */
async function shrinkGlyphs(frame: FrameLocator, surface: Surface) {
  const selector = SURFACE[surface]
  const reach = async () => {
    const natural = (await wh.fit(frame, selector, 100_000, 'code')).line
    const advance = await wh.advance(frame)
    const { edges } = await wh.box(frame, 'code')
    return { natural, need: 82 * advance + edges }
  }
  let { natural, need } = await reach()
  let reachable = need <= natural - 4
  if (!reachable) {
    const base = await wh.font(frame, selector, null)
    const px = Math.max(
      7,
      Math.floor(((base * (natural - 8)) / need) * 10) / 10,
    )
    await wh.font(frame, selector, px)
    ;({ natural, need } = await reach())
    reachable = need <= natural - 4
    await wh.fit(frame, selector, natural - 10, 'code')
    await settleLayout(frame)
    await wh.fit(frame, selector, 100_000, 'code')
    await settleLayout(frame)
  }
  return reachable
}

const SAME_PAIR = /^\[(\[[\d,]*\]),\1\]$/

/**
 * The hints at the current line equal the contract's tier gating applied to the measured piece and
 * line widths (that is the assertion that proves a regime, whatever line the surface could reach),
 * and the rendered breaks are among them. Returns the gated set.
 */
async function expectGated(
  frame: FrameLocator,
  kind: Kind,
  label: string,
  fitted: FitResult,
) {
  const tiers = [P1, [], P3_ALL]
  try {
    await poll(async () => {
      const hints = await wh.hints(frame, kind)
      const gated = await wh.expected(frame, kind, tiers)
      return JSON.stringify([hints, gated])
    }, `${label}: the hints follow the tier gating`).toMatch(SAME_PAIR)
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nmeasured: ${await wh.diag(frame, kind, P1_BOUNDS)}\n${fitted.trace}`,
    )
  }
  const gated = await wh.expected(frame, kind, tiers)
  await settleLayout(frame)
  const breaks = await wh.breaks(frame, kind)
  for (const offset of breaks)
    expect(gated, `${label}: break ${offset} is a gated hint`).toContain(offset)
  // The break before `cs` (74) is never planned with the default N = 3.
  expect(await wh.hints(frame, kind)).not.toContain(74)
  return { gated, breaks }
}

/** One regime: gated at the reachable line; counted only when that line really is in the regime. */
async function proveRegime(
  frame: FrameLocator,
  kind: Kind,
  label: string,
  want: readonly number[],
  fitted: FitResult,
) {
  const { gated, breaks } = await expectGated(frame, kind, label, fitted)
  if (JSON.stringify(gated) !== JSON.stringify(want)) {
    test.info().annotations.push({
      type: 'skipped-regime',
      description: `${label}: reachable line ${fitted.line.toFixed(1)} gives ${JSON.stringify(gated)}, not ${JSON.stringify(want)}\n${fitted.trace}`,
    })
    return { proven: false, trace: fitted.trace }
  }
  if (want.length > 0)
    expect(breaks.length, `${label}: the text wraps`).toBeGreaterThan(0)
  return { proven: true, trace: fitted.trace }
}

// The inline-code and plain-text regimes (acceptance item 1, prose).
async function expectRegimes(frame: FrameLocator, surface: Surface) {
  await shrinkGlyphs(frame, surface)
  const advance = await wh.advance(frame)
  // Code: WIDE 82, MID 40, NARROW 16 advances. The surface cannot always be constrained to the
  // requested line (the real webview is narrow), so each regime is proven from the measured piece
  // and line widths of the line actually reached; a regime the line is not in is skipped, logged.
  const proven: string[] = []
  const traces: string[] = []
  for (const [advances, want] of [
    [82, [] as number[]],
    [40, P1],
    [16, P1_AND_P3],
  ] as const) {
    const { edges } = await wh.box(frame, 'code')
    const fitted = await fitLine(
      frame,
      surface,
      'code',
      advances * advance + edges,
    )
    const result = await proveRegime(
      frame,
      'code',
      `code at ${advances} advances`,
      want,
      fitted,
    )
    if (result.proven) proven.push(String(advances))
    else traces.push(result.trace)
  }
  expect(
    proven.some((name) => name !== '82'),
    `a MID or NARROW code regime was reached; proven: ${proven.join(',')}\n${traces.join('\n---\n')}`,
  ).toBe(true)
  // Words that fit get no hint at any width: the heading code, the probe, the acronym word.
  expect(await wh.hintsIn(frame, '^\\u200B?(short\\.cs|aaaaaaaaaa)$')).toEqual([
    0, 0,
  ])
  expect(await wh.hintsIn(frame, '^\\u200B?HTMLParser')).toEqual([0])

  // Plain text: widths come from the page's proportional font. WIDE = the whole path fits.
  await wh.fit(frame, SURFACE[surface], 100_000, 'plain')
  const total = await wh.width(frame, 'plain', 0, PATH.length)
  await proveRegime(
    frame,
    'plain',
    'plain text WIDE',
    [],
    await fitLine(frame, surface, 'plain', total + 6),
  )
  const pieces: number[] = []
  for (let i = 1; i < P1_BOUNDS.length; i += 1)
    pieces.push(await wh.width(frame, 'plain', P1_BOUNDS[i - 1], P1_BOUNDS[i]))
  // MID = the widest priority-1 piece fits (1.25x): priority 1 only.
  const mid = await proveRegime(
    frame,
    'plain',
    'plain text MID',
    P1,
    await fitLine(frame, surface, 'plain', Math.max(...pieces) * 1.25),
  )
  expect(mid.proven, `plain text MID was reached\n${mid.trace}`).toBe(true)
}

// ---------------------------------------------------------------------------------------------

test('ir: Owner path layout, hints are not edits, and the setting updates live', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const { file, frame } = await openFixture(
    workbox,
    evaluateInVSCode,
    baseDir,
    'ir',
  )
  await install(frame, 'ir')
  const before = await snapshot(frame, evaluateInVSCode, file)
  expect(before.host.text).toBe(ORIGINAL)
  expect(before.disk).toBe(ORIGINAL)
  expect(before.host.dirty).toBe(false)

  await expectTables(frame, 'ir')
  await expectRegimes(frame, 'ir')

  // Hints are not edits: nothing the host, the disk or the Undo history can see changed. Longer
  // than Vditor's 800 ms undo delay plus the 250 ms edit sync.
  expect(await wh.totalHints(frame)).toBeGreaterThan(0)
  await workbox.waitForTimeout(1500)
  const after = await snapshot(frame, evaluateInVSCode, file)
  expect(after.host).toEqual(before.host)
  expect(after.disk).toBe(before.disk)
  expect(after.view).toEqual(before.view)
  expect(after.view.lastTextHasHint).toBe(false)

  // The setting: N = 0 allows the break before `cs` at MID, N = 3 drops it again, with no re-init.
  const advance = await wh.advance(frame)
  const { edges } = await wh.box(frame, 'code')
  const midFit = await fitLine(frame, 'ir', 'code', 40 * advance + edges)
  const mid = await expectGated(frame, 'code', 'MID before the change', midFit)
  expect(mid.gated, `MID before the change\n${midFit.trace}`).toEqual(P1)
  const epoch = after.view.epoch
  const setN = (n: number) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: number[]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.wrapHints.minLastPiece',
            args[0],
            vscode.ConfigurationTarget.Global,
          )
      },
      [n] as [number],
    )
  await setN(0)
  await poll(
    () => wh.hints(frame, 'code'),
    'N = 0 adds the hint at 74',
  ).toEqual([...P1, 74])
  await setN(3)
  await poll(() => wh.hints(frame, 'code'), 'N = 3 removes it').toEqual(P1)
  await workbox.waitForTimeout(1500)
  const end = await snapshot(frame, evaluateInVSCode, file)
  expect(end.view.epoch, 'the editor was not re-initialised').toBe(epoch)
  expect(end.host).toEqual(before.host)
  expect(end.disk).toBe(before.disk)
  expect(end.view.value).toBe(before.view.value)
  expect(end.view.undo).toBe(before.view.undo)
  expect(end.view.redo).toBe(before.view.redo)
})

test('wysiwyg: Owner path layout and hints are not edits', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const { file, frame } = await openFixture(
    workbox,
    evaluateInVSCode,
    baseDir,
    'wysiwyg',
  )
  await install(frame, 'wysiwyg')
  const before = await snapshot(frame, evaluateInVSCode, file)
  expect(before.host.text).toBe(ORIGINAL)
  expect(before.host.dirty).toBe(false)

  await expectTables(frame, 'wysiwyg')
  await expectRegimes(frame, 'wysiwyg')

  expect(await wh.totalHints(frame)).toBeGreaterThan(0)
  await workbox.waitForTimeout(1500)
  const after = await snapshot(frame, evaluateInVSCode, file)
  expect(after.host).toEqual(before.host)
  expect(after.disk).toBe(before.disk)
  expect(after.view).toEqual(before.view)
  expect(after.view.lastTextHasHint).toBe(false)
})

test('sv: the source line has no hint and is unchanged; the Preview pane carries the layout', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const { file, frame } = await openFixture(
    workbox,
    evaluateInVSCode,
    baseDir,
    'sv',
  )
  await frame.locator('.vditor-preview').first().waitFor({ timeout: 30_000 })
  await frame
    .locator('.vditor-preview .vditor-reset table')
    .first()
    .waitFor({ timeout: 30_000 })
  await install(frame, 'preview')
  const before = await snapshot(frame, evaluateInVSCode, file)
  expect(before.host.text).toBe(ORIGINAL)

  // Preview: the same layout as the edit surfaces.
  await expectTables(frame, 'preview')
  await expectRegimes(frame, 'preview')

  // SV: a narrow source column would need hints if SV took any, and it takes none.
  await wh.fit(frame, SURFACE.sv, 300, 'code')
  await settleLayout(frame)
  await workbox.waitForTimeout(1500)
  const source = await frame
    .locator('.vditor-sv')
    .first()
    .evaluate((el) => ({
      hints: el.querySelectorAll('.vmde-wrap-hint').length,
      lines: (el as HTMLElement).innerText.split('\n'),
    }))
  expect(source.hints).toBe(0)
  expect(source.lines).toContain(`Paragraph path \`${PATH}\` ends here.`)
  const after = await snapshot(frame, evaluateInVSCode, file)
  expect(after.host).toEqual(before.host)
  expect(after.disk).toBe(before.disk)
  // The SV editor's own value read-back already drops the generic arguments of the inline code
  // `Option<IPageOwnershipTracker>` before any hint exists (the same on a build without the hint
  // engine; open item, not caused by hints), so the check is that this checks changed nothing and
  // that the host and disk bytes (asserted above) are the original.
  expect(svForm(after.view.value)).toBe(svForm(before.view.value))
  expect(svForm(after.view.value).replace(/<\w+>/gu, '')).toBe(
    svForm(ORIGINAL).replace(/<\w+>/gu, ''),
  )
  expect(after.view.undo).toBe(before.view.undo)
  expect(after.view.redo).toBe(before.view.redo)
})

// ---------------------------------------------------------------------------------------------
// OS input. The document is paragraphs only, so every edit round-trips byte for byte.

const DOC = `# Wrap hints

Probe \`aaaaaaaaaa\` for the glyph advance.

Paragraph path \`${PATH}\` ends here.
`

test.describe('OS input in a hinted word', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('XTEST typing is one Undo step and Ctrl+Z restores the exact bytes; Ctrl+C gives the source text', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(workbox, electronApp, evaluateInVSCode, baseDir)
    // Warm the OS key route once on a throwaway document, as the other XTEST specs do.
    const warm = await openDocument(kit, 'wrap-hints-warm.md', DOC, 'ir')
    await waitForInitialUndoSnapshot(kit.frame())
    await select(warm, 'Probe', { collapsed: true, offset: 5 })
    await kit.xtest.key('ctrl+z')
    await workbox.waitForTimeout(1500)
    await closeAll(kit, warm.file)

    const ctx = await openDocument(kit, 'wrap-hints-xtest.md', DOC, 'ir')
    try {
      const frame = kit.frame()
      await waitForInitialUndoSnapshot(frame)
      await frame
        .locator('code', { hasText: 'PageFlowTestDoubles' })
        .first()
        .waitFor({ timeout: 30_000 })
      await install(frame, 'ir')
      const advance = await wh.advance(frame)
      const { edges } = await wh.box(frame, 'code')
      const narrowFit = await fitLine(frame, 'ir', 'code', 16 * advance + edges)
      const { gated } = await expectGated(
        frame,
        'code',
        'hinted before typing',
        narrowFit,
      )
      // Typing needs the hints around `Tests.` (15 and 21), which priority 1 gives.
      expect(
        gated.includes(15) && gated.includes(21),
        `the path is hinted around Tests.\n${narrowFit.trace}`,
      ).toBe(true)

      // Ctrl+C of the whole hinted path: the clipboard holds the source text (a sentinel first,
      // so a stale clipboard cannot pass).
      await kit.host(async (vscode) => {
        await vscode.env.clipboard.writeText('SENTINEL-wrap-hints')
      }, [])
      const placed = await evalFrame(
        kit,
        () => {
          const inner = (window as any).vditor.vditor
          const root = inner[inner.currentMode].element as HTMLElement
          const code = [...root.querySelectorAll('p code')].find((c) =>
            c.textContent?.includes('PageFlowTestDoubles'),
          ) as HTMLElement
          const nodes: Text[] = []
          const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode())
            nodes.push(n as Text)
          const full = nodes.map((n) => n.data).join('')
          const startAt = full.indexOf('../')
          const locate = (offset: number): [Text, number] => {
            let rest = offset
            for (const node of nodes) {
              if (rest <= node.length) return [node, rest]
              rest -= node.length
            }
            const last = nodes[nodes.length - 1]
            return [last, last.length]
          }
          const [aNode, aOffset] = locate(startAt)
          const [fNode, fOffset] = locate(startAt + 76)
          root.focus({ preventScroll: true })
          const range = document.createRange()
          range.setStart(aNode, aOffset)
          range.setEnd(fNode, fOffset)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          const request = (window as any).__vmdeRequestCaret
          if (typeof request === 'function')
            request({
              anchor: { node: aNode, offset: aOffset },
              focus: { node: fNode, offset: fOffset },
            })
          return Boolean(selection.rangeCount && !selection.isCollapsed)
        },
        0,
      )
      expect(placed, 'the path is selected').toBe(true)
      await endSelectionGesture(ctx)
      await kit.xtest.key('ctrl+c')
      await expect
        .poll(
          () =>
            kit.host(
              async (vscode) => vscode.env.clipboard.readText(),
              [] as unknown as [],
            ),
          { timeout: 10_000, message: 'Ctrl+C reached the clipboard' },
        )
        .not.toBe('SENTINEL-wrap-hints')
      const clip = (await kit.host(
        async (vscode) => vscode.env.clipboard.readText(),
        [] as unknown as [],
      )) as string
      // No hint residue; an inline-code copy may carry its backticks.
      expect(clip.replace(/`/gu, '')).toBe(PATH)

      // Typing inside the hinted word: `Tests.` is the text between the hints at 15 and 21.
      await select(ctx, 'Tests.', { collapsed: true, offset: 3 })
      await endSelectionGesture(ctx)
      const startState = await hostState(ctx)
      expect(startState.text).toBe(DOC)
      const depth = () =>
        evalFrame(
          kit,
          () => {
            const inner = (window as any).vditor.vditor
            const slot = inner.undo[inner.currentMode]
            return {
              undo: slot.undoStack.length as number,
              redo: slot.redoStack.length as number,
            }
          },
          0,
        )
      const d0 = await depth()
      await kit.xtest.type('XY')
      const typed = DOC.replace('Tests.EditorMode', 'TesXYts.EditorMode')
      await expect
        .poll(async () => (await hostState(ctx)).text, {
          timeout: 15_000,
          message: 'the host holds exactly the typed bytes',
        })
        .toBe(typed)
      await workbox.waitForTimeout(UNDO_LOCK_MS)
      expect(await depth(), 'typing is one Undo step').toEqual({
        undo: d0.undo + 1,
        redo: 0,
      })

      await kit.xtest.key('ctrl+z')
      await expect
        .poll(async () => (await hostState(ctx)).text, {
          timeout: 15_000,
          message: 'Ctrl+Z restores the exact bytes',
        })
        .toBe(DOC)
      await workbox.waitForTimeout(1500)
      const restored = await hostState(ctx)
      expect(restored.text).toBe(DOC)
      expect(restored.dirty).toBe(false)
      expect(readFileSync(ctx.file, 'utf8')).toBe(DOC)
      expect(
        await evalFrame(
          kit,
          () => (window as any).vditor.getValue() as string,
          0,
        ),
      ).toBe(DOC)
      expect(await depth()).toEqual({ undo: d0.undo, redo: 1 })
      // The edited word is hinted again after the pause.
      await poll(() => wh.hints(frame, 'code'), 'hinted after Undo').toEqual(
        gated,
      )
    } finally {
      await closeAll(kit, ctx.file).catch(() => undefined)
    }
  })
})
