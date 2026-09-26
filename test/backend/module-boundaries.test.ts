import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_MODULES,
  WEBVIEW_MODULES,
  checkManifest,
} from '../../scripts/module-manifest.mjs'

// Boundary meta-test for task 460's module decomposition. Without this, the DAG that phases
// 0-3 built rots back to a flat mess one convenient import at a time — this is the test that
// makes the reorg something other than cosmetic. Pattern follows this repo's own
// harness-registry.test.ts / engine-registry.test.ts: read the real source of truth
// (module-manifest.mjs), assert structural properties against the tree on disk, no mocking.
//
// THE RULE, stated once so every assertion below can be read against it: intra-module edges are
// UNCONSTRAINED (files inside one module may import each other freely); inter-module edges MUST
// be in the allowlist below AND the inter-module graph must be acyclic. `diagram-kit/` is
// deliberately NOT asserted to be a "leaf layer" — it has real outgoing edges
// (`diagram-kit -> util`, plus intra-module edges like `native-offscreen -> diagram-dom`); what
// makes it a bottom MODULE is that it has no outgoing INTER-module edges beyond `util`, which the
// general allowlist+acyclic check below already covers without a special case.
//
// Grouping (`moduleIdFor`) is what this test operates on — NEVER directory paths. A directory
// can be a subdirectory of a module (`diagrams/engines` is part of `diagrams`, not a sibling) —
// see module-manifest.mjs's own header for the phase-3 bug this distinction fixed.
//
// DIVISION OF LABOUR (task 460 addendum, cross-checked against task 469 item 5d — see
// .dependency-cruiser.cjs's matching header). 469 §5d said to extend dependency-cruiser's
// `forbidden` rules with task 460's layering instead of writing a hand-rolled test; that
// didn't happen cleanly, because dependency-cruiser has no notion of "the 21 modules named in
// our manifest" — only files and paths. So the guarantee is split along what each tool is
// actually good at:
//   - HERE (regex-based, manifest-driven): manifest totality/disjointness against
//     scripts/module-manifest.mjs, the full inter-module edge allowlist, and the per-side cycle
//     check — anything that needs "which of the 21 named modules is this file in".
//   - `.dependency-cruiser.cjs` (a real TypeScript resolver — sees dynamic `import()`,
//     `require()`, bare side-effect imports and re-exports for free): the two zero-exception
//     invariants that are pure path shape and don't need module-name knowledge — cross-side
//     webview→host reaches only src/shared/, and src/shared/ depends on nothing outside itself.
// Do not consolidate these into one tool without re-reading this note — the split is
// deliberate. If the two nets ever disagree, that's useful signal, not duplicated effort.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function idToModuleMap(modules: typeof HOST_MODULES) {
  const map = new Map<string, string>()
  for (const { module, ids } of Object.values(modules)) {
    for (const id of ids) map.set(id, module)
  }
  return map
}

function walkTs(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'media') continue // build artifact dir
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTs(p, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p)
    }
  }
}

// Every relative import specifier a file can reference another module through — not just
// `from '...'`. Task 460's own codemod had to be widened twice for exactly this gap (once for
// `vi.mock`, once for bare side-effect imports — see the task file's Phase 0 section), so this
// meta-test covers the same six forms the codemod does, as five patterns (#1 catches two):
//   1. `import ... from '...'` / `export ... from '...'` (re-exports — same regex catches both)
//   2. `vi.mock('...')` — the dangerous one: fails at RUNTIME, not compile time
//   3. dynamic `import('...')`
//   4. `require('...')`
//   5. bare side-effect `import '...'` (no `from` keyword at all)
// WHICH OF THESE ARE LOAD-BEARING TODAY (don't read all five as verified nets): only #1 and #5
// are. #5 is the one that earned its place — it caught the four `X -> bridge/vscode-api` edges that
// #1 alone missed, which is why the "0 cycles" claim was wrong for a day. #2 `vi.mock` can never
// fire from here at all, because `walkTs` skips `*.test.ts` and a `foo.test` basename matches no
// manifest id; it is kept so that pulling test files into the graph (a real open design decision —
// there are 93 such specifiers) is a one-line change rather than a re-derivation. #3 and #4 are
// future-proofing: no production file currently crosses a module boundary through a dynamic
// `import()` or a `require()`. If you delete any of these, delete #2/#3/#4 — never #5.
// Measured per-pattern yield of distinct inter-module edge kinds, 2026-07-31 (`tmp/pattern-yield.mjs`,
// throwaway) — host `1=24, 2/3/4/5=0`, webview `1=44, 5=3, 2/3/4=0`. Webview's 3 are the surviving
// bare `import '../util/vscode-api'` in chrome/clipboard/links; all three are allowed edges now that
// the file is a `util/` leaf, which is the whole point of the move.
// Type-only forms (`import type {...} from '...'`, `import type X from '...'`,
// `export type {...} from '...'`) are stripped first since they erase at compile time and create
// no runtime/bundle edge. Dynamic `import()` and `require()` can't be type-only, so they always
// count. Single-quote only: Biome enforces `quoteStyle: single` repo-wide (biome.json), verified
// zero double-quoted relative specifiers across src/, media-src/src/, media-src/e2e/, test/backend/.
function relativeSpecifiers(src: string): string[] {
  const typeOnly = [
    /import\s+type\s*\{[^}]*\}\s*from\s*'\.[^']+'/g,
    /import\s+type\s+\w+\s*from\s*'\.[^']+'/g,
    /export\s+type\s*\{[^}]*\}\s*from\s*'\.[^']+'/g,
  ]
  let stripped = src
  for (const re of typeOnly) stripped = stripped.replace(re, '')
  const patterns = [
    /from\s+'(\.[^']+)'/g, // import ... from '...' / export ... from '...'
    /vi\.mock\(\s*'(\.[^']+)'/g,
    /import\(\s*'(\.[^']+)'\s*\)/g, // dynamic import(...) — "import(" never matches the bare pattern below
    /require\(\s*'(\.[^']+)'\s*\)/g,
    /import\s+'(\.[^']+)'/g, // bare side-effect import '...' — no braces/identifier/"(" follows "import"
  ]
  const specifiers: string[] = []
  for (const re of patterns) {
    for (const m of stripped.matchAll(re)) specifiers.push(m[1])
  }
  return specifiers
}

// Every inter-module edge KIND (fromModule -> toModule, deduped) found by scanning relative
// import specifiers (all forms — see relativeSpecifiers).
function edgeKinds(
  idModule: Map<string, string>,
  rootDir: string,
): Set<string> {
  const files: string[] = []
  walkTs(rootDir, files)
  const kinds = new Set<string>()
  for (const f of files) {
    const id = path.basename(f, '.ts')
    const fromMod = idModule.get(id)
    if (!fromMod) continue
    const src = readFileSync(f, 'latin1')
    for (const spec of relativeSpecifiers(src)) {
      const targetPath = path.normalize(path.join(path.dirname(f), spec))
      const targetId = path.basename(targetPath)
      const toMod = idModule.get(targetId)
      if (!toMod || toMod === fromMod) continue
      kinds.add(`${fromMod}->${toMod}`)
    }
  }
  return kinds
}

// Cross-side (webview -> host) edges: only specifiers that actually cross the tree boundary
// (contain '/src/' after normalization — the `../../src/<m>` shape every cross-side import uses).
function crossSideEdgeKinds(
  webviewIdModule: Map<string, string>,
  hostIdModule: Map<string, string>,
): Set<string> {
  const files: string[] = []
  walkTs(path.join(ROOT, 'media-src', 'src'), files)
  const kinds = new Set<string>()
  for (const f of files) {
    const id = path.basename(f, '.ts')
    const fromMod = webviewIdModule.get(id)
    if (!fromMod) continue
    const src = readFileSync(f, 'latin1')
    for (const spec of relativeSpecifiers(src)) {
      if (!spec.includes('/src/')) continue
      const targetPath = path.normalize(path.join(path.dirname(f), spec))
      const targetId = path.basename(targetPath)
      const toMod = hostIdModule.get(targetId)
      if (!toMod) continue
      kinds.add(`webview:${fromMod}->host:${toMod}`)
    }
  }
  return kinds
}

// General cycle detection (not just pairwise A<->B — a 3-node A->B->C->A cycle is just as real).
// DFS-based: returns every module that sits on some cycle, so a failure names the culprits.
function findCyclicModules(edgeSet: Set<string>): string[] {
  const adjacency = new Map<string, Set<string>>()
  for (const edge of edgeSet) {
    const [from, to] = edge.split('->')
    if (!adjacency.has(from)) adjacency.set(from, new Set())
    adjacency.get(from)!.add(to)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const cyclic = new Set<string>()

  function visit(node: string, stack: string[]) {
    color.set(node, GRAY)
    stack.push(node)
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) {
        // found a cycle: everything from `next` onward in the stack is on it
        const cycleStart = stack.indexOf(next)
        for (const n of stack.slice(cycleStart)) cyclic.add(n)
        cyclic.add(next)
      } else if (c === WHITE) {
        visit(next, stack)
      }
    }
    stack.pop()
    color.set(node, BLACK)
  }

  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node, [])
  }
  return [...cyclic].sort()
}

// --- Allowlists, computed from the tree as it stands at phase 3's close (task 460). Any NEW
// inter-module edge kind not listed here must be added deliberately — that's the point: it forces
// a decision instead of a silent import. ---

const HOST_ALLOWED_EDGES = new Set([
  'app->lute',
  'app->markdown',
  'app->platform',
  'app->session',
  'app->shared',
  'app->webview-host',
  'app->wiki',
  'app->writeback',
  'lute->markdown',
  'lute->shared',
  'markdown->shared',
  // Task 576 (Part 1, 4c894c01): outline-tree.ts's heading reorder finds the panel for reveal via
  // platform/active-panels's findPanelForUri; platform imports nothing from markdown, so no cycle.
  'markdown->platform',
  'platform->shared',
  'platform->wiki',
  // Task 537: EditorSession asks the host-owned vendored Lute instance for the one canonical IR
  // seed; the pure admission contract remains in shared/ and the webview never reaches into lute/.
  'session->lute',
  'session->markdown',
  'session->platform',
  'session->shared',
  'session->webview-host',
  'session->wiki',
  'session->writeback',
  'webview-host->platform',
  'webview-host->shared',
  'wiki->shared',
  'writeback->lute',
  'writeback->markdown',
])

const WEBVIEW_ALLOWED_EDGES = new Set([
  'boot->bridge',
  'boot->chrome',
  'boot->clipboard',
  'boot->diagram-kit',
  'boot->diagrams',
  'boot->diagrams/mermaid',
  'boot->editing',
  'boot->links',
  'boot->nav',
  'boot->testing',
  'boot->util',
  'bridge->chrome',
  'bridge->clipboard',
  'bridge->diagram-kit',
  'bridge->diagrams',
  'bridge->editing',
  'bridge->links',
  'bridge->nav',
  'bridge->testing',
  'bridge->util',
  // Task 576 reconciliation: webview-context.ts (chrome/) reads engineLangSet from
  // diagram-kit/engine-registry to classify context-menu sections over diagram panes — the same
  // shared-registry relationship diagrams/editing/bridge/boot already have to diagram-kit.
  'chrome->diagram-kit',
  'chrome->testing',
  'chrome->util',
  'clipboard->util',
  'diagram-kit->util',
  'diagrams->diagram-kit',
  'diagrams->diagrams/d2',
  'diagrams->diagrams/mermaid',
  'diagrams->diagrams/plantuml',
  'diagrams->editing',
  'diagrams->nav',
  'diagrams->util',
  'diagrams/d2->diagram-kit',
  'diagrams/d2->util',
  'diagrams/mermaid->diagram-kit',
  'diagrams/mermaid->diagrams/d2',
  'diagrams/mermaid->nav',
  'diagrams/mermaid->util',
  'diagrams/plantuml->diagram-kit',
  'diagrams/plantuml->util',
  'editing->chrome',
  'editing->diagram-kit',
  // Task 576 (Part 1, b9fa6e57): the source-proven link popover reuses links/link-open-policy and
  // links/link-click-fix instead of duplicating the link-open policy.
  'editing->links',
  // Task 254: the heading transaction reuses nav/section-range's shared subtree/source engine.
  'editing->nav',
  'editing->util',
  'links->editing',
  'links->nav',
  'links->util',
  'nav->chrome',
  'nav->util',
])

describe('module boundaries (task 460)', () => {
  it('manifest is total and disjoint against the tree on disk', () => {
    expect(checkManifest({ verbose: false })).toBe(true)
  })

  it('host src/ has zero cross-module cycles', () => {
    const edges = edgeKinds(idToModuleMap(HOST_MODULES), path.join(ROOT, 'src'))
    const cyclic = findCyclicModules(edges)
    expect(cyclic, `cyclic host modules: ${cyclic.join(', ')}`).toEqual([])
  })

  it('webview media-src/src/ has zero cross-module cycles', () => {
    const edges = edgeKinds(
      idToModuleMap(WEBVIEW_MODULES),
      path.join(ROOT, 'media-src', 'src'),
    )
    const cyclic = findCyclicModules(edges)
    expect(cyclic, `cyclic webview modules: ${cyclic.join(', ')}`).toEqual([])
  })

  it('every host inter-module edge is in the allowlist', () => {
    const edges = edgeKinds(idToModuleMap(HOST_MODULES), path.join(ROOT, 'src'))
    const unlisted = [...edges].filter((e) => !HOST_ALLOWED_EDGES.has(e)).sort()
    expect(
      unlisted,
      `new host inter-module edges, not in HOST_ALLOWED_EDGES: ${unlisted.join(', ')}`,
    ).toEqual([])
  })

  it('every webview inter-module edge is in the allowlist', () => {
    const edges = edgeKinds(
      idToModuleMap(WEBVIEW_MODULES),
      path.join(ROOT, 'media-src', 'src'),
    )
    const unlisted = [...edges]
      .filter((e) => !WEBVIEW_ALLOWED_EDGES.has(e))
      .sort()
    expect(
      unlisted,
      `new webview inter-module edges, not in WEBVIEW_ALLOWED_EDGES: ${unlisted.join(', ')}`,
    ).toEqual([])
  })

  // Task 460 phase 3 finding: the webview used to reach into `lute/` and `wiki/` directly
  // (lute-gap-repair, link-target) alongside the intended `shared/`-only contract. Both moved
  // into `shared/` because they passed the purity test (zero vscode/Node/browser deps) — this
  // assertion is what keeps that fix from silently regressing. Zero exceptions, on purpose.
  it('the webview reaches into src/shared/ and nowhere else', () => {
    const edges = crossSideEdgeKinds(
      idToModuleMap(WEBVIEW_MODULES),
      idToModuleMap(HOST_MODULES),
    )
    const nonShared = [...edges]
      .filter((e) => !e.endsWith('->host:shared'))
      .sort()
    expect(
      nonShared,
      `cross-side edges NOT targeting host:shared: ${nonShared.join(', ')}`,
    ).toEqual([])
  })

  // `shared/` is the dependency-free kernel both sides sit on top of — if it imported a sibling
  // host module, that sibling's own dependencies (some of which are vscode/Node-only) would leak
  // into every file that imports `shared/`, including the webview.
  it('src/shared/ imports nothing from sibling host modules', () => {
    const sharedDir = path.join(ROOT, 'src', 'shared')
    const files = readdirSync(sharedDir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    )
    const violations: string[] = []
    for (const f of files) {
      const src = readFileSync(path.join(sharedDir, f), 'utf8')
      for (const spec of relativeSpecifiers(src)) {
        if (spec.startsWith('./')) continue // intra-shared/ is fine
        violations.push(`${f}: '${spec}'`)
      }
    }
    expect(violations, violations.join('; ')).toEqual([])
  })
})
