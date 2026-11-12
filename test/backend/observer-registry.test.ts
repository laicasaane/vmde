import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Task 733 / 005 — observer freeze-list. Every whole-subtree MutationObserver re-reads the DOM on
// each mutation, so a new one adds a pass to every keystroke. The model change feed
// (`util/unit-changes.ts`) is the seam consumers use instead. The table below freezes the current
// sites (path, count, reason); migrating a site is its consumer task's work and lowers its row in
// the same commit. The only file that may gain a site is `bridge/unit-dom.ts`, the model's observer.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SRC = path.join(ROOT, 'media-src/src')
const PATTERN = /subtree:\s*true/gu
/** The one file allowed to add observer sites. */
const OBSERVER_OF_THE_MODEL = 'bridge/unit-dom.ts'

// Posix path relative to media-src/src, count, reason.
const FROZEN: ReadonlyArray<readonly [string, number, string]> = [
  [
    'bridge/edit-sync.ts',
    2,
    'IR seed observers: cancel the incremental seed on a content mutation and watch the edit surface.',
  ],
  [
    'bridge/unit-dom.ts',
    1,
    'The single observer of the text model: marks units dirty and reports batches to the feed.',
  ],
  [
    'chrome/diff-markers.ts',
    1,
    'Redraws diff markers when the pane content changes.',
  ],
  [
    'chrome/native-popover-position.ts',
    1,
    'Repositions native popovers when the editor content changes.',
  ],
  [
    'chrome/responsive-tables.ts',
    2,
    'Re-measures table wrappers when table content or structure changes.',
  ],
  [
    'chrome/sv-gutter.ts',
    1,
    'Redraws the Source line gutter when the pane content changes.',
  ],
  [
    'chrome/table-resize.ts',
    1,
    'Refreshes table resize handles when tables change.',
  ],
  [
    'chrome/toolbar-menu-position.ts',
    1,
    'Repositions toolbar menus when the toolbar subtree changes.',
  ],
  [
    'chrome/toolbar-overflow.ts',
    2,
    'Toolbar overflow: item visibility and the open more-panel (toolbar DOM, not the document).',
  ],
  [
    'chrome/toolbar-row-hover.ts',
    1,
    'Tracks toolbar row hover state (toolbar DOM, not the document).',
  ],
  [
    'chrome/toolbar-scroll-guard.ts',
    1,
    'Restores the toolbar scroll position after an editor re-render.',
  ],
  [
    'chrome/webview-context.ts',
    1,
    'Maintains webview context keys from the editor DOM.',
  ],
  [
    'diagrams/custom-diagrams.ts',
    1,
    'Finds new custom diagram blocks to render.',
  ],
  ['diagrams/diagram-controls.ts', 1, 'Attaches controls to diagram blocks.'],
  [
    'diagrams/diagram-semantics.ts',
    1,
    'Keeps accessible semantics on diagram blocks.',
  ],
  ['diagrams/diagram-zoom.ts', 1, 'Attaches zoom buttons to diagram blocks.'],
  [
    'diagrams/echarts-fit.ts',
    1,
    'Refits chart sizes when chart blocks change.',
  ],
  ['diagrams/echarts-retheme.ts', 1, 'Re-themes chart blocks as they appear.'],
  [
    'diagrams/plantuml/plantuml-render.ts',
    1,
    'Renders PlantUML blocks as they appear.',
  ],
  [
    'diagrams/render-cache-client.ts',
    1,
    'Serves cached diagram renders for new blocks.',
  ],
  [
    'editing/gap-paragraph.ts',
    1,
    'Keeps gap paragraphs consistent after content changes.',
  ],
  [
    'editing/github-color-literals.ts',
    1,
    'Decorates color literals in inline code.',
  ],
  ['editing/html-comment.ts', 1, 'Decorates HTML comments in the preview.'],
  ['editing/html-subscript.ts', 1, 'Decorates subscript HTML spans.'],
  ['editing/inline-picture.ts', 1, 'Decorates inline pictures.'],
  ['editing/link-popover.ts', 1, 'Tracks link elements for the link popover.'],
  [
    'editing/selection-bubble.ts',
    1,
    'Tracks content changes that hide or move the selection bubble.',
  ],
  ['editing/selection-scope.ts', 1, 'Preview selection scope bookkeeping.'],
  [
    'editing/svg-data-image-adapter.ts',
    1,
    'Adapts SVG data images as they appear.',
  ],
  [
    'editing/table-cell-selection.ts',
    1,
    'Maintains table cell selection after table changes.',
  ],
  [
    'editing/toc-invalidation.ts',
    1,
    'Invalidates the outline when headings change.',
  ],
  [
    'editing/wrap-hint-engine.ts',
    1,
    'Recomputes wrap hints for changed inline code.',
  ],
  [
    'editing/wysiwyg-code-highlight.ts',
    1,
    'Options of the WYSIWYG code-highlight observer.',
  ],
  ['links/bare-url-decorate.ts', 1, 'Decorates bare URLs in text.'],
  [
    'links/code-ref-decorate.ts',
    1,
    'Decorates code references in inline code.',
  ],
  [
    'links/link-like-semantics.ts',
    1,
    'Applies link semantics to link-like elements.',
  ],
  ['nav/block-handle.ts', 1, 'Keeps the block handle unit cache current.'],
  [
    'nav/outline-keyboard.ts',
    1,
    'Keeps outline keyboard navigation current with outline changes.',
  ],
  [
    'nav/outline-reorder.ts',
    1,
    'Keeps outline drag reordering current with outline changes.',
  ],
  [
    'nav/outline-viewport-sync.ts',
    1,
    'Syncs the outline viewport with outline changes.',
  ],
  [
    'nav/section-fold.ts',
    2,
    'Section fold state: the surface and the app root.',
  ],
  [
    'nav/section-hoist.ts',
    2,
    'Section hoist state: the content and the outline.',
  ],
  [
    'nav/source-block-index.ts',
    1,
    'Invalidates the source-block index on content mutations.',
  ],
  ['nav/split-scroll-sync.ts', 1, 'Split view scroll sync cache invalidation.'],
  [
    'util/mutation-impact.ts',
    2,
    'The mutation-impact probe (end-to-end only) and the shared editor observer.',
  ],
  [
    'util/observe-coalesce.ts',
    1,
    'Coalesces observer work for diagram and decoration passes.',
  ],
]

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sourceFiles(full, out)
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

/** Counts of `subtree: true` per file, for the files that have any. */
function countSites(
  files: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const [file, text] of files) {
    const n = text.match(PATTERN)?.length ?? 0
    if (n > 0) counts.set(file, n)
  }
  return counts
}

/** The messages for every difference between the counts and the table; empty when they agree. */
function compare(counts: ReadonlyMap<string, number>): string[] {
  const frozen = new Map(FROZEN.map(([file, count]) => [file, count]))
  const problems: string[] = []
  for (const [file, count] of counts) {
    const allowed = frozen.get(file) ?? 0
    if (count > allowed) {
      problems.push(
        file === OBSERVER_OF_THE_MODEL
          ? `${file}: ${count} observer sites, ${allowed} listed. Update the table.`
          : `${file}: ${count} whole-subtree observer sites, ${allowed} allowed. Use onUnitFeed from util/unit-changes instead of a new subtree observer.`,
      )
    }
  }
  for (const [file, allowed] of frozen) {
    const count = counts.get(file) ?? 0
    if (count < allowed) {
      problems.push(
        `${file}: ${count} observer sites, ${allowed} listed. Lower its row in test/backend/observer-registry.test.ts in the same commit.`,
      )
    }
  }
  return problems
}

describe('observer freeze-list', () => {
  const tree = new Map<string, string>()
  for (const file of sourceFiles(SRC)) {
    tree.set(
      path.relative(SRC, file).split(path.sep).join('/'),
      readFileSync(file, 'utf8'),
    )
  }

  it('lists 46 files and 52 sites, each with a reason', () => {
    expect(FROZEN).toHaveLength(46)
    expect(FROZEN.reduce((sum, [, count]) => sum + count, 0)).toBe(52)
    expect(FROZEN.every(([, , reason]) => reason.trim().length > 0)).toBe(true)
  })

  it('matches the tree: no new site and no stale row', () => {
    expect(compare(countSites(tree))).toEqual([])
  })

  it('fails for a new subtree observer in another file', () => {
    const withNew = new Map(tree)
    withNew.set(
      'editing/new-decorator.ts',
      'obs.observe(root, { childList: true, subtree: true })',
    )
    expect(compare(countSites(withNew))).toEqual([
      expect.stringContaining('editing/new-decorator.ts: 1 whole-subtree'),
    ])
  })

  it('fails for a second site in a listed file', () => {
    const more = new Map(tree)
    more.set(
      'links/link-like-semantics.ts',
      `${tree.get('links/link-like-semantics.ts')}\nobs.observe(a, { subtree: true })`,
    )
    expect(compare(countSites(more))).toEqual([
      expect.stringContaining('links/link-like-semantics.ts: 2'),
    ])
  })

  it('asks for a lowered row when a site is removed', () => {
    const fewer = new Map(tree)
    fewer.set('nav/outline-reorder.ts', 'export {}')
    expect(compare(countSites(fewer))).toEqual([
      expect.stringContaining('Lower its row'),
    ])
  })
})
