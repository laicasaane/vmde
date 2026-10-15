// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import * as mutationImpact from '../util/mutation-impact'
import { clearWrapHints, insertWrapHint } from '../util/wrap-hint-mark'
import {
  classifyEditorMutations,
  queryIncludingSelf,
  scopeMutations,
} from '../util/mutation-impact'

function irRootWith(innerHTML: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'vditor-ir'
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.innerHTML = innerHTML
  wrapper.appendChild(root)
  document.body.replaceChildren(wrapper)
  return root
}

// Collect a batch of MutationRecords for a synchronous mutation by observing BEFORE it runs and
// reading `takeRecords()` immediately after — avoids depending on the microtask queue in a test.
function recordsFor(root: HTMLElement, mutate: () => void): MutationRecord[] {
  const obs = new MutationObserver(() => {
    /* never invoked — records are read synchronously via takeRecords() below */
  })
  obs.observe(root, { childList: true, subtree: true, characterData: true })
  mutate()
  const records = obs.takeRecords()
  obs.disconnect()
  return records
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('scopeMutations', () => {
  it('exposes the mutation-impact classifier used by local helper observers', () => {
    expect(
      typeof (mutationImpact as Record<string, unknown>)
        .classifyEditorMutations,
    ).toBe('function')
  })

  it('exposes deterministic helper-pass instrumentation for the E2E acceptance gate', () => {
    expect(
      typeof (mutationImpact as Record<string, unknown>)
        .recordHelperMutationPass,
    ).toBe('function')
    expect(
      typeof (mutationImpact as Record<string, unknown>)
        .installMutationRecordProbe,
    ).toBe('function')
  })

  it('an empty batch (initial mount pass) always means full walk', () => {
    expect(scopeMutations([])).toEqual({ full: true, blocks: new Set() })
  })

  it('outerHTML replace of ONE top-level block scopes to just that block (the common per-keystroke path)', () => {
    const root = irRootWith(
      '<p id="a">a</p><blockquote id="b">b</blockquote><p id="c">c</p>',
    )
    const b = root.querySelector('#b') as HTMLElement
    const records = recordsFor(root, () => {
      b.outerHTML = '<blockquote id="b">b2</blockquote>'
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(1)
    const only = [...scope.blocks][0] as HTMLElement
    expect(only.id).toBe('b')
    expect(only.textContent).toBe('b2')
    // the untouched siblings must NOT be in scope
    expect([...scope.blocks].some((el) => (el as HTMLElement).id === 'a')).toBe(
      false,
    )
    expect([...scope.blocks].some((el) => (el as HTMLElement).id === 'c')).toBe(
      false,
    )
  })

  it('a characterData change resolves via its target (marker-rewrite case, e.g. renaming a callout type)', () => {
    const root = irRootWith(
      '<blockquote id="bq"><p id="p">text</p></blockquote>',
    )
    const textNode = root.querySelector('#p')!.firstChild as Text
    const records = recordsFor(root, () => {
      textNode.textContent = 'changed'
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(1)
    expect(([...scope.blocks][0] as HTMLElement).id).toBe('bq')
  })

  it('root.innerHTML replace (the isIRElement path) widens to full once many top-level blocks land at once', () => {
    const root = irRootWith('<p>only</p>')
    const records = recordsFor(root, () => {
      root.innerHTML = Array.from({ length: 8 }, (_, i) => `<p>${i}</p>`).join(
        '',
      )
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(true)
  })

  it('root.innerHTML replace with FEW resulting blocks stays scoped (no special-casing on target===root)', () => {
    const root = irRootWith('<p>only</p>')
    const records = recordsFor(root, () => {
      root.innerHTML = '<p id="x">x</p>'
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(1)
  })

  it('a pure decoration write (data-render="1") is dropped entirely — no walk, not even scoped', () => {
    const root = irRootWith('<div id="host"></div>')
    const host = root.querySelector('#host') as HTMLElement
    const records = recordsFor(root, () => {
      const overlay = document.createElement('div')
      overlay.setAttribute('data-render', '1')
      host.appendChild(overlay)
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(0)
  })

  it('a known vmde decoration class is also dropped (callout preview / marker / title / comment span)', () => {
    const root = irRootWith('<blockquote id="bq"><p>[!NOTE]</p></blockquote>')
    const bq = root.querySelector('#bq') as HTMLElement
    const records = recordsFor(root, () => {
      const preview = document.createElement('div')
      preview.className = 'vditor-ir__preview vmde-callout__preview'
      bq.appendChild(preview)
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(0)
  })

  it('a record MIXING a decoration with real content still passes (never target-based)', () => {
    // Mirrors the spin: blockElement.outerHTML replace produces a NEW block whose subtree happens to
    // contain a decoration — that record must still resolve to the real block, not be dropped.
    const root = irRootWith('<blockquote id="bq"><p>old</p></blockquote>')
    const records = recordsFor(root, () => {
      const bq = root.querySelector('#bq') as HTMLElement
      bq.outerHTML =
        '<blockquote id="bq2"><p>new</p><div data-render="1" class="vmde-stale-overlay"></div></blockquote>'
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(1)
    expect(([...scope.blocks][0] as HTMLElement).id).toBe('bq2')
  })

  it('a mutation outside any .vditor-reset root over-scopes to full (safety net, never silently drops)', () => {
    const detachedParent = document.createElement('div') // no .vditor-reset ancestor at all
    const child = document.createElement('p')
    detachedParent.appendChild(child)
    const rec = {
      type: 'childList',
      target: detachedParent,
      addedNodes: Object.assign([child], {
        item: (i: number) => [child][i],
      }) as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord
    const scope = scopeMutations([rec])
    expect(scope.full).toBe(true)
  })

  it('a pure removal (no addedNodes) is a no-op — nothing new to decorate', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const b = root.querySelector('#b') as HTMLElement
    const records = recordsFor(root, () => {
      b.remove()
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(0)
  })

  it('a stray text-node addedNode (no wrapping element) is skipped, not mistaken for a block', () => {
    const root = irRootWith('<p id="a">a</p>')
    const records = recordsFor(root, () => {
      root.querySelector('#a')!.after(document.createTextNode('bare text'))
    })
    const scope = scopeMutations(records)
    // A bare text addedNode can never itself be (or contain) a blockquote/code-block/html-block — the
    // 3 decorators only ever match ELEMENT selectors — so it's correctly ignored as noise, same as a
    // pure removal: nothing to re-scan, but that's a real "nothing to do", not an unresolvable case.
    expect(scope.full).toBe(false)
    expect(scope.blocks.size).toBe(0)
  })

  it('once a batch is deemed full, later records are skipped (short-circuit, not re-processed)', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const detached = document.createElement('div')
    const strayChild = document.createElement('p')
    detached.appendChild(strayChild)
    const outsideRootRecord = {
      type: 'childList',
      target: detached,
      addedNodes: [strayChild] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    } as unknown as MutationRecord
    const b = root.querySelector('#b') as HTMLElement
    const realRecords = recordsFor(root, () => {
      b.outerHTML = '<p id="b2">b2</p>'
    })
    // the out-of-root record comes FIRST — it alone forces full:true, and the loop must break
    // before even looking at the second (perfectly resolvable) record.
    const scope = scopeMutations([outsideRootRecord, ...realRecords])
    expect(scope.full).toBe(true)
  })

  it('a characterData change on a text node DIRECTLY under root (no block wrapper) safely falls back to full', () => {
    const root = irRootWith('')
    const text = document.createTextNode('unwrapped')
    root.appendChild(text)
    const records = recordsFor(root, () => {
      text.textContent = 'unwrapped, edited'
    })
    // characterData records always resolve via `target` (never skipped like a childList addedNode
    // would be) — topLevelBlockOf's climb starts AT root (the text's parent) and runs past it looking
    // for a top-level block, correctly finding none (there isn't one) rather than returning a wrong
    // element — the safe over-scope-to-full fallback, not a silent no-op.
    const scope = scopeMutations(records)
    expect(scope.full).toBe(true)
  })
})

describe('queryIncludingSelf', () => {
  it('matches the root itself in addition to descendants', () => {
    const root = document.createElement('blockquote')
    root.innerHTML = '<p><blockquote>nested</blockquote></p>'
    document.body.replaceChildren(root)
    const found = queryIncludingSelf(root, 'blockquote')
    expect(found).toHaveLength(2)
    expect(found[0]).toBe(root)
  })

  it('returns only descendants when the root does not itself match', () => {
    const root = document.createElement('div')
    root.innerHTML = '<blockquote>a</blockquote>'
    document.body.replaceChildren(root)
    const found = queryIncludingSelf(root, 'blockquote')
    expect(found).toHaveLength(1)
    expect(found[0]).not.toBe(root)
  })
})

describe('classifyEditorMutations', () => {
  it('classifies a one-for-one prose block spin as local and non-structural', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const records = recordsFor(root, () => {
      root.querySelector('#b')!.outerHTML = '<p id="b">changed</p>'
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(false)
    expect(impact.structural).toBe(false)
    expect(impact.modeRebuild).toBe(false)
    expect(impact).toMatchObject({ topLevelChanged: false })
    expect([...impact.blocks].map((block) => block.id)).toEqual(['b'])
  })

  it('resolves a chain of detached intermediate spins to the final live replacement block', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p><p id="c">c</p>')
    const records = recordsFor(root, () => {
      root.querySelector('#b')!.outerHTML = '<p id="b">first</p>'
      root.querySelector('#b')!.outerHTML = '<p id="b">second</p>'
      root.querySelector('#b')!.outerHTML = '<p id="b">final</p>'
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(false)
    expect(impact.structural).toBe(false)
    expect([...impact.blocks].map((block) => block.outerHTML)).toEqual([
      '<p id="b">final</p>',
    ])
  })

  it('associates detached caret-marker mutations with the one live spun block in the same batch', () => {
    const root = irRootWith('<p id="a">a</p><p id="b" data-block="0">b</p>')
    const records = recordsFor(root, () => {
      const block = root.querySelector('#b')!
      block.appendChild(document.createElement('wbr'))
      block.outerHTML = '<p id="b" data-block="0">b!</p>'
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(false)
    expect(impact.structural).toBe(false)
    expect([...impact.blocks].map((block) => block.id)).toEqual(['b'])
  })

  it('marks heading replacement and direct heading text mutation as structural', () => {
    const root = irRootWith('<h2 id="heading">Old</h2><p>body</p>')
    const replace = recordsFor(root, () => {
      root.querySelector('#heading')!.outerHTML = '<h3 id="heading">New</h3>'
    })
    const text = root.querySelector('#heading')!.firstChild as Text
    const characterData = recordsFor(root, () => {
      text.data = 'Newest'
    })

    expect(classifyEditorMutations(replace).structural).toBe(true)
    expect(classifyEditorMutations(characterData).structural).toBe(true)
  })

  it('resolves an observed table attribute change to its live top-level block', () => {
    const root = irRootWith(
      '<div id="table-block"><table id="table"><tbody><tr><td>A</td></tr></tbody></table></div>',
    )
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['width'],
    })
    root.querySelector('#table')!.setAttribute('width', '400')
    const records = observer.takeRecords()
    observer.disconnect()

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(false)
    expect([...impact.blocks].map((block) => block.id)).toEqual(['table-block'])
  })

  it('marks a top-level insert/remove batch as structural even below the full threshold', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const records = recordsFor(root, () => {
      root.querySelector('#a')!.after(document.createElement('p'))
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(false)
    expect(impact.structural).toBe(true)
    expect(impact).toMatchObject({ topLevelChanged: true })
  })

  it('treats a freshly added editor surface as a full mode rebuild', () => {
    const app = document.createElement('div')
    document.body.replaceChildren(app)
    const records = recordsFor(app, () => {
      app.innerHTML =
        '<div class="vditor-ir"><pre class="vditor-reset"><p>fresh</p></pre></div>'
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(true)
    expect(impact.structural).toBe(true)
    expect(impact.modeRebuild).toBe(true)
  })

  it('treats a whole replacement of a reused small reset root as a mode rebuild', () => {
    const root = irRootWith('<p>old</p>')
    const records = recordsFor(root, () => {
      root.innerHTML = '<h2>new mode</h2><p>body</p>'
    })

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(true)
    expect(impact.modeRebuild).toBe(true)
    expect(impact.topLevelChanged).toBe(true)
  })

  it('widens a pure top-level removal because no connected replacement block remains', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const records = recordsFor(root, () => root.querySelector('#b')!.remove())

    const impact = classifyEditorMutations(records)

    expect(impact.full).toBe(true)
    expect(impact.structural).toBe(true)
  })

  it('drops decoration-only records but keeps a mixed decoration/content replacement local', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p>')
    const decoration = recordsFor(root, () => {
      const overlay = document.createElement('span')
      overlay.setAttribute('data-render', '1')
      root.querySelector('#a')!.appendChild(overlay)
    })
    const mixed = recordsFor(root, () => {
      root.querySelector('#b')!.outerHTML =
        '<p id="b">changed<span data-render="1">ui</span></p>'
    })

    expect(classifyEditorMutations(decoration)).toMatchObject({
      full: false,
      structural: false,
      modeRebuild: false,
    })
    expect(classifyEditorMutations(decoration).blocks.size).toBe(0)
    expect(classifyEditorMutations(mixed).full).toBe(false)
    expect(
      [...classifyEditorMutations(mixed).blocks].map((block) => block.id),
    ).toEqual(['b'])
  })

  it('uses the configured distinct-block threshold as a full fallback', () => {
    const root = irRootWith('<p id="a">a</p><p id="b">b</p><p id="c">c</p>')
    const records = recordsFor(root, () => {
      for (const id of ['a', 'b', 'c'])
        root.querySelector(`#${id}`)!.textContent = `${id}!`
    })

    const impact = (
      classifyEditorMutations as unknown as (
        records: MutationRecord[],
        options: { blockThreshold: number },
      ) => ReturnType<typeof classifyEditorMutations>
    )(records, { blockThreshold: 2 })

    expect(impact.full).toBe(true)
    expect(impact.blocks.size).toBe(3)
  })
})

// Task 640 S2b: the hint engine's own writes are neither content nor decoration changes, so the
// shared scoping used by the synchronous decorators and the helper classifier skips them.
describe('wrap-hint writes (Task 640)', () => {
  const CODE =
    '<p data-block="0">see <code>aaaa/bbbb/cccc</code></p><p data-block="0">next</p>'

  it('scopeMutations returns an empty scoped set for a hint write and its removal', () => {
    const root = irRootWith(CODE)
    const code = root.querySelector('code')!
    const written = recordsFor(root, () => {
      insertWrapHint(code.firstChild as Text, 10)
      insertWrapHint(code.firstChild as Text, 5)
    })
    expect(written.length).toBeGreaterThan(0)
    expect(scopeMutations(written)).toEqual({ full: false, blocks: new Set() })
    const removed = recordsFor(root, () => clearWrapHints(code))
    expect(scopeMutations(removed)).toEqual({ full: false, blocks: new Set() })
  })

  it('scopeMutations still scopes a real edit that shares the batch', () => {
    const root = irRootWith(CODE)
    const code = root.querySelector('code')!
    const records = recordsFor(root, () => {
      insertWrapHint(code.firstChild as Text, 5)
      ;(root.children[1].firstChild as Text).data = 'edited'
    })
    const scope = scopeMutations(records)
    expect(scope.full).toBe(false)
    expect([...scope.blocks]).toEqual([root.children[1]])
  })

  it('classifyEditorMutations treats a hint write as no impact', () => {
    const root = irRootWith(CODE)
    const code = root.querySelector('code')!
    const records = recordsFor(root, () =>
      insertWrapHint(code.firstChild as Text, 5),
    )
    const impact = classifyEditorMutations(records)
    expect(impact.blocks.size).toBe(0)
    expect(impact.full).toBe(false)
    expect(impact.structural).toBe(false)
  })
})
