// @vitest-environment jsdom
//
// Task 720 — the block-scoped Undo/Redo restore that replaces upstream Vditor's whole-root
// `element.innerHTML = text` in the patched `Undo.renderDiff`. Each case mounts a live editor root
// rendered from the previous snapshot (plus, where stated, the decorations VMDE adds after a
// snapshot is taken), restores another snapshot, and checks both the content and which top-level
// nodes kept their identity.
import { describe, expect, it } from 'vitest'
import { restoreSnapshotBlocks } from './undo-block-restore'

const p = (text: string) => `<p data-block="0">${text}</p>`
const h2 = (text: string) =>
  `<h2 data-block="0" class="vditor-ir__node" data-marker="#"><span class="vditor-ir__marker vditor-ir__marker--heading" data-type="heading-marker">## </span>${text}</h2>`
const table = (cell: string, extra = '') =>
  `<table data-block="0"${extra}><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>${cell}</td><td>1</td></tr></tbody></table>`
const frontMatter = (yaml: string, decoration = '') =>
  '<div class="vditor-ir__node" data-type="yaml-front-matter" data-block="0">' +
  '<span data-type="yaml-front-matter-open-marker" class="vditor-ir__marker">---</span>' +
  `<pre class="vditor-ir__marker--pre vditor-ir__marker"><code>${yaml}</code></pre>${decoration}` +
  '<span data-type="yaml-front-matter-close-marker" class="vditor-ir__marker">---</span></div>'
// The properties table front-matter-table.ts injects after the source pre (live DOM only).
const FRONT_MATTER_TABLE =
  '<div class="vmde-front-matter" data-render="1" contenteditable="false" data-sig="s1"><table><tr><th>title</th><td>A</td></tr></table></div>'
const mermaid = (source: string, preview: string) =>
  '<div class="vditor-ir__node" data-type="code-block" data-block="0">' +
  '<span data-type="code-block-open-marker" class="vditor-ir__marker">```</span>' +
  '<span class="vditor-ir__marker vditor-ir__marker--info" data-type="code-block-info">mermaid</span>' +
  `<pre class="vditor-ir__marker--pre vditor-ir__marker"><code class="language-mermaid">${source}</code></pre>` +
  `${preview}<span data-type="code-block-close-marker" class="vditor-ir__marker">\`\`\`</span></div>`
// Snapshot form (addCaret / Task 623 reset) and the live rendered form of the same Mermaid block.
const MERMAID_SNAPSHOT = mermaid(
  'graph TD;A--&gt;B',
  '<pre class="vditor-ir__preview" data-render="2"><code class="language-mermaid">graph TD;A--&gt;B</code></pre>',
)
const MERMAID_LIVE = mermaid(
  'graph TD;A--&gt;B',
  '<pre class="vditor-ir__preview" data-render="1"><code class="language-mermaid" data-processed="true"><svg id="m1"><g><text>A</text></g></svg></code></pre>',
)
const list = (inner: string) =>
  `<ul data-tight="true" data-marker="-" data-block="0"><li data-marker="-"><p>one</p><ul data-tight="true" data-marker="-"><li data-marker="-">${inner}</li></ul></li></ul>`
const task = (checked: boolean) =>
  `<ul data-tight="true" data-marker="-" data-block="0"><li data-marker="-" class="vditor-task"><input${checked ? ' checked=""' : ''} type="checkbox"> todo</li></ul>`

function mount(html: string): HTMLElement {
  document.body.innerHTML =
    '<div class="vditor-ir"><pre class="vditor-reset" contenteditable="true"></pre></div>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  root.innerHTML = html
  return root
}

// Top-level nodes before the restore, and a helper to name which of them survived where.
function track(root: HTMLElement) {
  const before = Array.from(root.childNodes)
  return {
    before,
    keptAt: () =>
      Array.from(root.childNodes).map((node) => before.indexOf(node as never)),
  }
}

describe('restoreSnapshotBlocks (Task 720 — block-scoped Undo/Redo restore)', () => {
  it('replaces only a changed middle block and keeps every other node', () => {
    const previous = [p('a'), p('b edited'), p('c')].join('')
    const restored = [p('a'), p('b'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    const result = restoreSnapshotBlocks(root, previous, restored)
    expect(result.full).toBe(false)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 2])
  })

  it('inserts a block restored by Undo of a deletion', () => {
    const previous = [p('a'), p('c')].join('')
    const restored = [p('a'), p('b'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 1])
  })

  it('removes a block when Undo drops an insertion', () => {
    const previous = [p('a'), p('new'), p('c')].join('')
    const restored = [p('a'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, 2])
  })

  it('handles a change in the first and in the last block', () => {
    const first = [p('A'), p('b'), p('c')].join('')
    const last = [p('a'), p('b'), p('C')].join('')
    const base = [p('a'), p('b'), p('c')].join('')
    let root = mount(first)
    let t = track(root)
    restoreSnapshotBlocks(root, first, base)
    expect(root.innerHTML).toBe(base)
    expect(t.keptAt()).toEqual([-1, 1, 2])
    root = mount(last)
    t = track(root)
    restoreSnapshotBlocks(root, last, base)
    expect(root.innerHTML).toBe(base)
    expect(t.keptAt()).toEqual([0, 1, -1])
  })

  it('replaces every block when all of them changed', () => {
    const previous = [p('x'), p('y')].join('')
    const restored = [h2('a'), p('b'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([-1, -1, -1])
  })

  it('lands the caret marker of the restored snapshot inside the replaced block', () => {
    const previous = [p('a'), p('bqzx'), p('c')].join('')
    const restored = [p('a'), p('b<wbr>'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(root.querySelector('wbr')?.parentElement?.textContent).toBe('b')
    expect(t.keptAt()).toEqual([0, -1, 2])
  })

  it('replaces an otherwise unchanged block that holds the restored caret marker', () => {
    // A caret-only difference: without the replacement the live block has no marker and
    // Vditor's setRangeByWbr branch would not run.
    const previous = [p('a'), p('b'), p('c')].join('')
    const restored = [p('a'), p('b'), p('c<wbr>')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.querySelector('wbr')).not.toBeNull()
    expect(t.keptAt()).toEqual([0, 1, -1])
  })

  it('swaps the marker block on its own and keeps the blocks between it and the change', () => {
    // The snapshot before the edit was taken with the caret in another block (measured in
    // WYSIWYG: four blocks above the edited paragraph).
    const preview = (id: string) =>
      `<div class="vditor-ir__node" data-type="code-block" data-block="0" id="${id}"><pre class="vditor-ir__preview" data-render="2"><code>${id}</code></pre></div>`
    const previous = [p('a'), p('b'), p('c'), p('d qzx'), preview('tail')].join(
      '',
    )
    const restored = [
      p('a<wbr>'),
      p('b'),
      p('c'),
      p('d'),
      preview('tail').replace('>tail</code>', '>tail<wbr></code>'),
    ].join('')
    const root = mount(previous)
    const t = track(root)
    const result = restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([-1, 1, 2, -1, -1])
    // The swapped blocks are part of the replaced set, in document order.
    expect(
      result
        .querySelectorAll('[data-block]')
        .map((el) => el.id || el.textContent),
    ).toEqual(['a', 'd', 'tail'])
  })

  it('keeps an unchanged front matter that holds the marker while another block changed', () => {
    // The restore bridge drops that marker and places the caret at the change
    // (undo-restore-caret.ts frontMatterMarkerIsStale), so a swap would only rebuild the table.
    const previous = [frontMatter('title: A'), p('b'), p('d qzx')].join('')
    const restored = [frontMatter('title: A<wbr>'), p('b'), p('d')].join('')
    const root = mount(
      [frontMatter('title: A', FRONT_MATTER_TABLE), p('b'), p('d qzx')].join(
        '',
      ),
    )
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(t.keptAt()).toEqual([0, 1, -1])
    expect(root.querySelector('wbr')).toBeNull()
    expect(root.querySelector('.vmde-front-matter')).not.toBeNull()
  })

  it('swaps a front matter that holds the marker when nothing else changed', () => {
    // A caret-only restore: the marker is the only thing to restore, and the bridge keeps it.
    const previous = [frontMatter('title: A'), p('b')].join('')
    const restored = [frontMatter('title: A<wbr>'), p('b')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(t.keptAt()).toEqual([-1, 1])
    expect(root.querySelector('wbr')).not.toBeNull()
  })

  it('keeps a block whose previous snapshot held the old caret marker', () => {
    const previous = [p('a'), p('b<wbr>'), p('c edited')].join('')
    const live = [p('a'), p('b'), p('c edited')].join('')
    const restored = [p('a'), p('b'), p('c')].join('')
    const root = mount(live)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, 1, -1])
  })

  it('restores a caret marker that sits at the top level of the snapshot', () => {
    const previous = [p('a'), p('b'), p('c')].join('')
    const restored = [p('a'), '<wbr>', p('b'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 1, 2])
  })

  it('changes nothing when both snapshots hold the same text and no marker', () => {
    const html = [p('a'), p('b')].join('')
    const root = mount(html)
    const t = track(root)
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, { childList: true, subtree: true })
    const result = restoreSnapshotBlocks(root, html, html)
    expect(observer.takeRecords()).toHaveLength(0)
    observer.disconnect()
    expect(result.full).toBe(false)
    expect(t.keptAt()).toEqual([0, 1])
    expect(result.querySelectorAll('p')).toEqual([])
  })

  it('falls back to a full rebuild for an empty root', () => {
    const root = mount('')
    const restored = [p('a'), p('b')].join('')
    const result = restoreSnapshotBlocks(root, '', restored)
    expect(result.full).toBe(true)
    expect(root.innerHTML).toBe(restored)
    expect(result.querySelectorAll('p')).toHaveLength(2)
  })

  it('replaces only the changed table', () => {
    const previous = [p('a'), table('alphaqzx'), p('c')].join('')
    const restored = [p('a'), table('alpha'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 2])
  })

  it('replaces a changed front matter and keeps an unchanged decorated one', () => {
    const previous = [frontMatter('title: Aqzx'), p('b')].join('')
    const restored = [frontMatter('title: A'), p('b')].join('')
    let root = mount(
      [frontMatter('title: Aqzx', FRONT_MATTER_TABLE), p('b')].join(''),
    )
    let t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([-1, 1])
    // Unchanged front matter: the live properties table (data-render, non-editable) is a
    // decoration, so the block keeps its identity and its table.
    const unchanged = [frontMatter('title: A'), p('b qzx')].join('')
    const back = [frontMatter('title: A'), p('b')].join('')
    root = mount(
      [frontMatter('title: A', FRONT_MATTER_TABLE), p('b qzx')].join(''),
    )
    t = track(root)
    restoreSnapshotBlocks(root, unchanged, back)
    expect(t.keptAt()).toEqual([0, -1])
    expect(root.querySelector('.vmde-front-matter')).not.toBeNull()
  })

  it('replaces the whole top-level list when a nested item changed', () => {
    const previous = [p('a'), list('innerqzx'), p('c')].join('')
    const restored = [p('a'), list('inner'), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 2])
  })

  it('keeps decorated live blocks whose snapshots are equal', () => {
    // Each live block differs from its snapshot HTML only by VMDE or Vditor view state: section
    // fold attributes, the responsive-table width class, the rendered Mermaid SVG (the snapshot
    // holds the reset source), an empty wrap-hint span that splits a text node, the IR expand
    // class and IR code tagging. The comparison projects source text and non-view attributes, so
    // none of these forces a rebuild.
    const snapshotRest = [
      h2('Section'),
      table('alpha'),
      MERMAID_SNAPSHOT,
      p('long words here'),
    ]
    const previous = [p('edit qzx'), ...snapshotRest].join('')
    const restored = [p('edit'), ...snapshotRest].join('')
    const live = [
      p('edit qzx'),
      h2('Section').replace(
        '<h2 ',
        '<h2 data-vmde-foldable="" data-vmde-folded="" aria-expanded="false" ',
      ),
      table('alpha', ' class="vmde-table-auto-3"'),
      MERMAID_LIVE.replace(
        'class="vditor-ir__node"',
        'class="vditor-ir__node vditor-ir__node--expand"',
      ).replace(
        '<code class="language-mermaid">graph',
        '<code class="language-mermaid hljs">graph',
      ),
      p('long<span class="vmde-wrap-hint" data-render="1"></span> words here'),
    ].join('')
    const root = mount(live)
    const t = track(root)
    const result = restoreSnapshotBlocks(root, previous, restored)
    expect(result.full).toBe(false)
    expect(t.keptAt()).toEqual([-1, 1, 2, 3, 4])
    expect(root.querySelector('svg#m1')).not.toBeNull()
    expect(root.firstElementChild?.outerHTML).toBe(p('edit'))
  })

  it('keeps blocks whose two snapshots differ only in view state captured at different times', () => {
    // Measured in real VS Code: the snapshot before an edit can predate the front-matter properties
    // table, a table's width class or a Mermaid render, and the next snapshot holds them. Lute reads
    // neither, so the blocks are equal and the live nodes stay.
    const before = [
      frontMatter('title: A'),
      table('alpha'),
      MERMAID_SNAPSHOT,
      p('edit'),
    ]
    const after = [
      frontMatter('title: A', FRONT_MATTER_TABLE),
      table('alpha', ' class="vmde-table-auto-7"'),
      MERMAID_LIVE,
      p('edit qzx'),
    ]
    const root = mount(after.join(''))
    const t = track(root)
    restoreSnapshotBlocks(root, after.join(''), before.join(''))
    expect(t.keptAt()).toEqual([0, 1, 2, -1])
    expect(root.querySelector('.vmde-front-matter')).not.toBeNull()
    expect(root.querySelector('table[data-block]')?.className).toBe(
      'vmde-table-auto-7',
    )
    expect(root.querySelector('svg#m1')).not.toBeNull()
  })

  it('treats WYSIWYG code-highlight spans as view state', () => {
    const code = (inner: string, hljs = '') =>
      `<div class="vditor-wysiwyg__block" data-type="code-block" data-block="0" data-marker="\`\`\`"><pre class="vditor-wysiwyg__pre" style="display: none"><code class="language-js${hljs}">${inner}</code></pre><pre class="vditor-wysiwyg__preview" data-render="1"><code class="language-js">x</code></pre></div>`
    const plain = code('const a = 1')
    const highlighted = code(
      '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>',
      ' hljs',
    )
    const previous = [highlighted, p('b qzx')].join('')
    const restored = [plain, p('b')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(t.keptAt()).toEqual([0, -1])
    // A real source change inside the highlighted code is still a change.
    const changed = [code('const a = 2'), p('b')].join('')
    const root2 = mount(previous)
    const t2 = track(root2)
    restoreSnapshotBlocks(root2, previous, changed)
    expect(t2.keptAt()).toEqual([-1, -1])
  })

  it('replaces a block whose non-editable chip changed its source attribute', () => {
    const chip = (target: string) =>
      p(
        `see <span class="wiki-link-chip" contenteditable="false" data-wiki-source="[[${target}]]">${target}</span>`,
      )
    const previous = [chip('Alpha'), p('c qzx')].join('')
    const restored = [chip('Alpha'), p('c')].join('')
    const changed = [chip('Beta').replace('>Beta<', '>Alpha<'), p('c')].join('')
    let root = mount(previous)
    let t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(t.keptAt()).toEqual([0, -1])
    root = mount(previous)
    t = track(root)
    restoreSnapshotBlocks(root, previous, changed)
    expect(t.keptAt()).toEqual([-1, -1])
    expect(root.innerHTML).toBe(changed)
  })

  it('does not keep a live block whose source text differs from the previous snapshot', () => {
    // Defensive: the live DOM and lastText disagree (an unrecorded change). The block equal in
    // both snapshots must still come from the restored snapshot, not stay stale.
    const previous = [p('a'), p('b'), p('c qzx')].join('')
    const restored = [p('a'), p('b'), p('c')].join('')
    const root = mount([p('a'), p('b drift'), p('c qzx')].join(''))
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, -1])
  })

  it('does not keep a live block whose checkbox state differs from the previous snapshot', () => {
    const previous = [task(false), p('c qzx')].join('')
    const restored = [task(false), p('c')].join('')
    const root = mount([task(true), p('c qzx')].join(''))
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([-1, -1])
  })

  it('replaces a block whose snapshots differ only in an attribute', () => {
    const previous = [p('a'), task(true), p('c')].join('')
    const restored = [p('a'), task(false), p('c')].join('')
    const root = mount(previous)
    const t = track(root)
    restoreSnapshotBlocks(root, previous, restored)
    expect(root.innerHTML).toBe(restored)
    expect(t.keptAt()).toEqual([0, -1, 2])
  })

  it('falls back to a full rebuild when the live top level does not match the previous snapshot', () => {
    const previous = [p('a'), p('b qzx')].join('')
    const restored = [p('a'), p('b')].join('')
    const root = mount(
      [p('a'), p('b qzx'), '<div class="stray">x</div>'].join(''),
    )
    const result = restoreSnapshotBlocks(root, previous, restored)
    expect(result.full).toBe(true)
    expect(root.innerHTML).toBe(restored)
  })

  it('falls back to a full rebuild for top-level table parts the editor root would drop', () => {
    const previous = p('a')
    const restored = `<tr><td>x</td></tr>${p('a')}`
    const root = mount(previous)
    const result = restoreSnapshotBlocks(root, previous, restored)
    expect(result.full).toBe(true)
    const expected = document.createElement('pre')
    expected.innerHTML = restored
    expect(root.innerHTML).toBe(expected.innerHTML)
  })

  it('queries only the replaced range, in document order, including top-level matches', () => {
    const preview = (id: string) =>
      `<div class="vditor-ir__node" data-type="code-block" data-block="0" id="${id}"><pre class="vditor-ir__preview" data-render="2"><code>${id}</code></pre></div>`
    const previous = [preview('k1'), p('x'), preview('k2')].join('')
    const restored = [
      preview('k1'),
      preview('n1'),
      p('y'),
      preview('n2'),
      preview('k2'),
    ].join('')
    const root = mount(previous)
    const result = restoreSnapshotBlocks(root, previous, restored)
    const ids = (els: Element[]) =>
      els.map((el) => el.closest('[id]')?.id ?? el.id)
    expect(
      ids(result.querySelectorAll(".vditor-ir__preview[data-render='2']")),
    ).toEqual(['n1', 'n2'])
    expect(ids(result.querySelectorAll('.vditor-ir__node'))).toEqual([
      'n1',
      'n2',
    ])
    // Vditor's echarts loop replaces a replaced top-level block through outerHTML; a later query
    // still sees the new node because the range is re-read from the live root.
    const n1 = root.querySelector('#n1') as HTMLElement
    n1.outerHTML = preview('n1b')
    expect(
      ids(result.querySelectorAll(".vditor-ir__preview[data-render='2']")),
    ).toEqual(['n1b', 'n2'])
  })
})
