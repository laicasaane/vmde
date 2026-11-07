// Task 705 — in-place reporting for mermaid renders. Owns: the warning markup, the pure checks, and the
// render hooks (`window.__vmdeMermaidHooks`) that Vditor's mermaidRender calls after the bundle-time
// patch in esbuild-shared.mjs (patchMermaidErrorRender). Installed from boot/preload.ts, the one module
// every entry point and e2e harness imports first, so a bare Vditor bundle (no hooks) still renders.
// Kept dependency-light (imports only mermaid-elk.ts) so it never pulls a heavy chunk into main.js.
import { registerMermaidElkLoaders, takeElkRender } from './mermaid-elk'

const MERMAID_RENDER_TIMEOUT_MS = 30_000
export const MERMAID_TIMEOUT_MESSAGE =
  'Mermaid did not finish drawing this diagram within 30 seconds.'
export const MERMAID_WARNING_TITLE = 'Mermaid warning'
export const ELK_FALLBACK_MESSAGE =
  'ELK layout is not available. Drawn with dagre instead.'
export const EMPTY_DRAWING_MESSAGE = 'Mermaid produced an empty drawing.'

type MermaidWarningKind =
  | 'layout-fallback'
  | 'terminal-labels'
  | 'empty-drawing'
export interface MermaidWarning {
  kind: MermaidWarningKind
  message: string
}
interface Point {
  x: number
  y: number
}
export interface EdgeEnds {
  start: Point
  end: Point
}
/** The terminal labels that follow one edge's label, in document order (first = start end). */
export interface TerminalGroup {
  edgeId: string
  labels: Point[]
}

export function terminalLabelsMessage(n: number): string {
  return n === 1
    ? '1 relation end label sits closer to the other end of its line.'
    : `${n} relation end labels sit closer to the other end of their lines.`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The warning box markup. `data-render="1"` + the data-render="2" preview half keep it invisible to
 *  Lute (never serialized); role="note" so it is not announced like the error box. */
export function mermaidWarningHtml(
  warnings: readonly MermaidWarning[],
): string {
  if (warnings.length === 0) return ''
  const tokens = [...new Set(warnings.map((w) => w.kind))].join(' ')
  return (
    `<div class="vmde-diagram-warning" data-render="1" role="note" data-vmde-warning="${tokens}">` +
    `<div class="vmde-diagram-warning__title">${MERMAID_WARNING_TITLE}</div>` +
    warnings
      .map(
        (w) =>
          `<p class="vmde-diagram-warning__msg">${escapeHtml(w.message)}</p>`,
      )
      .join('') +
    `</div>`
  )
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

/** A terminal label is misplaced when it is no nearer its own end than the other end (ratio 1.0:
 *  Probe 2 showed the flagged set is stable for 1.0-1.5). Edges with one label are skipped. */
export function misplacedTerminalLabelCount(
  edges: ReadonlyMap<string, EdgeEnds>,
  groups: readonly TerminalGroup[],
): number {
  let n = 0
  for (const g of groups) {
    const e = edges.get(g.edgeId)
    if (!e || g.labels.length !== 2) continue
    const [first, second] = g.labels
    if (dist(first, e.start) >= dist(first, e.end)) n++
    if (dist(second, e.end) >= dist(second, e.start)) n++
  }
  return n
}

const TRANSLATE_RE = /translate\(\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)\s*\)/

function readEdges(svg: Element): Map<string, EdgeEnds> {
  const edges = new Map<string, EdgeEnds>()
  for (const path of svg.querySelectorAll(
    'path[data-edge="true"][data-id][data-points]',
  )) {
    try {
      const pts = JSON.parse(
        atob(path.getAttribute('data-points') ?? ''),
      ) as Point[]
      if (Array.isArray(pts) && pts.length >= 2) {
        edges.set(path.getAttribute('data-id') ?? '', {
          start: pts[0],
          end: pts[pts.length - 1],
        })
      }
    } catch {
      // Undecodable points: the edge is skipped (no measurement beats a wrong warning).
    }
  }
  return edges
}

function labelEdgeId(g: Element): string | null | undefined {
  return (
    g.querySelector('.label[data-id]') ?? g.querySelector('[data-id]')
  )?.getAttribute('data-id')
}

function readGroups(svg: Element): TerminalGroup[] {
  const groups: TerminalGroup[] = []
  let cur: TerminalGroup | null = null
  for (const g of svg.querySelectorAll('g.edgeLabel, g.edgeTerminals')) {
    if (g.classList.contains('edgeLabel')) {
      const id = labelEdgeId(g)
      cur = id ? { edgeId: id, labels: [] } : null
      if (cur) groups.push(cur)
      continue
    }
    const m = cur && TRANSLATE_RE.exec(g.getAttribute('transform') ?? '')
    if (cur && m) cur.labels.push({ x: Number(m[1]), y: Number(m[2]) })
  }
  return groups
}

/** Attribute-only read (no layout, works in display:none panes and the offscreen sandbox). */
export function collectTerminalGeometry(svg: Element): {
  edges: Map<string, EdgeEnds>
  groups: TerminalGroup[]
} {
  // Cost bound: 62 of the 75 combat diagrams have no terminals and return here.
  if (!svg.querySelector('g.edgeTerminals')) {
    return { edges: new Map(), groups: [] }
  }
  return { edges: readEdges(svg), groups: readGroups(svg) }
}

const DRAWABLE =
  'path, rect, circle, ellipse, polygon, polyline, line, text, foreignObject, image'

/** F8: zero-size viewBox or nothing drawn outside defs/marker/style. */
export function isEmptyMermaidSvg(svg: Element): boolean {
  const vb = (svg.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const [w, h] = [vb[2], vb[3]]
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) return true
  for (const el of svg.querySelectorAll(DRAWABLE)) {
    if (!el.closest('defs, marker, style')) return false
  }
  return true
}

/** String test only (no parse): an `elk` word in the source, or the global layout is elk. */
export function mayRequestElk(
  code: string,
  globalLayout: string | undefined,
): boolean {
  return globalLayout === 'elk' || /\belk\b/.test(code)
}

// The diagram types whose renderer calls getRegisteredLayoutAlgorithm and silently falls back to
// dagre; state diagrams throw instead (reported as an error).
const FALLBACK_TYPES = new Set([
  'flowchart-v2',
  'flowchart',
  'flowchart-elk',
  'classDiagram',
  'class',
  'er',
  'requirement',
])

export function elkFallbackApplies(
  diagramType: string,
  requestedLayout: string | undefined,
): boolean {
  const elk =
    requestedLayout === 'elk' ||
    !!requestedLayout?.startsWith('elk.') ||
    diagramType === 'flowchart-elk'
  return elk && FALLBACK_TYPES.has(diagramType)
}

/** Race `p` against a timer; the timer is cleared as soon as `p` settles. */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

interface HookWindow {
  mermaid?: {
    parse?: (
      code: string,
      opts: unknown,
    ) => Promise<{ diagramType: string; config?: { layout?: string } } | false>
  }
  __vmdeCdn?: string
  __vmdeMermaidLayout?: string
  __vmdeMermaidHooks?: unknown
}

/** Installs `win.__vmdeMermaidHooks`, called by the patched mermaidRender in this fixed order:
 *  beforeRender → timed(mermaid.render) → fallbackAfterRender (only if ELK was requested) →
 *  innerHTML=svg (+C4 hook) → afterInsert. */
export function installMermaidRenderHooks(win: HookWindow): void {
  win.__vmdeMermaidHooks = {
    // Register ELK before EVERY render (a plain overwrite, cheap): the harness and any path that
    // renders without the initialize wrapper otherwise get "Unknown layout algorithm: elk" (state) or
    // a silent dagre fallback. `__vmdeCdn` is what the lazy ELK loader fetches from.
    beforeRender(code: string, cdn: string) {
      win.__vmdeCdn ??= cdn
      registerMermaidElkLoaders()
      return { elkRequested: mayRequestElk(code, win.__vmdeMermaidLayout) }
    },
    timed<T>(p: Promise<T>, message = MERMAID_TIMEOUT_MESSAGE): Promise<T> {
      return withTimeout(p, MERMAID_RENDER_TIMEOUT_MS, message)
    },
    // Direct evidence of a dagre fallback: ELK was requested but the ELK render module did not draw
    // this id. The extra parse runs only on that path.
    async fallbackAfterRender(id: string, code: string): Promise<boolean> {
      if (takeElkRender(id)) return false
      try {
        const r = await win.mermaid?.parse?.(code, { suppressErrors: true })
        if (!r) return false
        return elkFallbackApplies(
          r.diagramType,
          r.config?.layout ??
            (win.__vmdeMermaidLayout === 'elk' ? 'elk' : undefined),
        )
      } catch {
        return false
      }
    },
    afterInsert(
      item: HTMLElement,
      _id: string,
      code: string,
      fallback: boolean,
    ) {
      const warnings: MermaidWarning[] = []
      if (fallback)
        warnings.push({
          kind: 'layout-fallback',
          message: ELK_FALLBACK_MESSAGE,
        })
      const svg = item.querySelector('svg')
      if (svg) {
        if (isEmptyMermaidSvg(svg)) {
          warnings.push({
            kind: 'empty-drawing',
            message: EMPTY_DRAWING_MESSAGE,
          })
        } else {
          const { edges, groups } = collectTerminalGeometry(svg)
          const n = misplacedTerminalLabelCount(edges, groups)
          if (n > 0)
            warnings.push({
              kind: 'terminal-labels',
              message: terminalLabelsMessage(n),
            })
        }
      }
      if (warnings.length === 0) return
      // The box text would otherwise leak into a textContent read of the node: pin the source.
      item.setAttribute('data-code', code.trim())
      item.insertAdjacentHTML('beforeend', mermaidWarningHtml(warnings))
    },
  }
}
