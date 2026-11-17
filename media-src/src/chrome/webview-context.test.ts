// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { applyCaretInside } from '../links/caret-link'
import {
  type BudgetCounts,
  countBudget,
  type Factor,
  irFixture,
} from '../testing/budget-harness'
import { installWebviewContext } from './webview-context'

const context = (element: Element | null) =>
  element?.getAttribute('data-vscode-context')

describe('installWebviewContext', () => {
  afterEach(() => document.body.replaceChildren())

  it('does not rewrite contexts when caret decoration enters or leaves a wiki chip or linked image', async () => {
    const root = document.createElement('main')
    root.innerHTML =
      '<p><span class="wiki-link-chip" data-wiki-link="1">Home</span> <a href="page.md"><img src="image.png"></a></p>'
    document.body.append(root)
    const dispose = installWebviewContext(root)
    const records: MutationRecord[] = []
    const watcher = new MutationObserver((batch) => records.push(...batch))
    watcher.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-vscode-context'],
    })
    try {
      for (const target of [
        root.querySelector<HTMLElement>('span'),
        root.querySelector('a'),
        null,
      ]) {
        applyCaretInside(root, target)
        // Let the class observer restamp, then deliver any resulting writes.
        await Promise.resolve()
        await Promise.resolve()
        records.push(...watcher.takeRecords())
        expect(records).toEqual([])
      }
      expect(context(root.querySelector('span'))).toBe(
        '{"webviewSection":"wiki"}',
      )
      expect(context(root.querySelector('img'))).toBe(
        '{"webviewSection":"image"}',
      )
    } finally {
      watcher.disconnect()
      dispose()
    }
  })

  it('stamps exact visibility contexts without adding a contextmenu handler', () => {
    const root = document.createElement('main')
    root.innerHTML = `
      <p id="prose">prose</p>
      <div data-type="code-block"><pre id="code"><code>const x = 1</code></pre></div>
      <div class="vditor-ir__preview"><div id="diagram" class="language-mermaid"><svg></svg></div></div>
      <img id="image" src="data:image/png;base64,AA==">
      <span id="wiki" class="wiki-link-chip" data-wiki-link="1">Home</span>
    `
    document.body.append(root)
    const prevent = (event: Event) => event.preventDefault()
    root.addEventListener('contextmenu', prevent)
    root.removeEventListener('contextmenu', prevent)

    const dispose = installWebviewContext(root)

    expect(context(root)).toBe('{"webviewSection":"editor"}')
    expect(context(root.querySelector('#prose'))).toBeNull()
    expect(context(root.querySelector('#code'))).toBe(
      '{"webviewSection":"code"}',
    )
    expect(context(root.querySelector('#diagram'))).toBe(
      '{"webviewSection":"diagram","lang":"mermaid"}',
    )
    expect(context(root.querySelector('#image'))).toBe(
      '{"webviewSection":"image"}',
    )
    expect(context(root.querySelector('#wiki'))).toBe(
      '{"webviewSection":"wiki"}',
    )
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    })
    root.querySelector('#diagram')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)

    dispose()
  })

  // Task 706: a `pre` inside a d2 markdown label is diagram content, not a code block. Stamping it
  // `code` offered code actions on the diagram and made the cache-painted copies differ from IR.
  it('does not stamp a code context inside a diagram label (svg foreignObject)', async () => {
    const root = document.createElement('main')
    document.body.append(root)
    const dispose = installWebviewContext(root)
    try {
      root.innerHTML =
        '<div class="vditor-preview"><div id="diagram" class="language-d2"><svg><foreignObject><div><pre id="label"><code>x</code></pre></div></foreignObject></svg></div></div>'
      await Promise.resolve()
      expect(context(root.querySelector('#label'))).toBeNull()
      expect(context(root.querySelector('#diagram'))).toBe(
        '{"webviewSection":"diagram","lang":"d2"}',
      )
    } finally {
      dispose()
    }
  })

  it('reapplies the exact context after a render rebuild and stops after disposal', async () => {
    const root = document.createElement('main')
    document.body.append(root)
    const dispose = installWebviewContext(root)
    root.innerHTML =
      '<div class="vditor-preview"><div class="language-d2"></div></div>'
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(context(root.querySelector('.language-d2'))).toBe(
      '{"webviewSection":"diagram","lang":"d2"}',
    )

    dispose()
    root.replaceChildren()
    root.insertAdjacentHTML('beforeend', '<img id="late">')
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(context(root.querySelector('#late'))).toBeNull()
  })

  it('does not label source-language code or unrelated language classes as diagrams', async () => {
    const root = document.createElement('main')
    root.innerHTML = `
      <pre id="source"><code class="language-mermaid">graph TD</code></pre>
      <div class="vditor-ir__preview"><code id="plain" class="language-ts">const x = 1</code></div>
      <div id="unrelated" class="language-unrelated"></div>
      <div class="vditor-ir__preview"><div id="late-diagram"></div></div>
    `
    document.body.append(root)

    const dispose = installWebviewContext(root)

    expect(context(root.querySelector('#source'))).toBe(
      '{"webviewSection":"code"}',
    )
    expect(context(root.querySelector('#plain'))).toBeNull()
    expect(context(root.querySelector('#unrelated'))).toBeNull()
    root.querySelector('#late-diagram')!.className = 'language-mermaid'
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(context(root.querySelector('#late-diagram'))).toBe(
      '{"webviewSection":"diagram","lang":"mermaid"}',
    )
    dispose()
  })

  it('reconciles stale contexts when discriminators change or are removed', async () => {
    const root = document.createElement('main')
    root.innerHTML = `
      <div class="vditor-ir__preview"><div id="diagram" class="language-mermaid"><div class="leaflet-pane"><img id="tile"></div></div></div>
      <span id="wiki" data-wiki-link="1">Home</span>
    `
    document.body.append(root)
    const dispose = installWebviewContext(root)
    const diagram = root.querySelector<HTMLElement>('#diagram')!
    const tile = root.querySelector('#tile')
    const wiki = root.querySelector<HTMLElement>('#wiki')!

    expect(context(tile)).toBe('{"webviewSection":"diagram","lang":"mermaid"}')
    diagram.className = 'language-ts'
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(context(diagram)).toBeNull()
    expect(context(tile)).toBe('{"webviewSection":"image"}')

    wiki.removeAttribute('data-wiki-link')
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(context(wiki)).toBeNull()
    dispose()
  })

  it('restamps a presentation class change without rewriting unchanged contexts', async () => {
    // Task 574: the shared source index counts attribute churn as DOM changes. Vditor toggles
    // classes on code blocks as the caret moves; restamping must not remove and re-add an
    // identical data-vscode-context value.
    const root = document.createElement('main')
    root.innerHTML =
      '<div id="block" data-type="code-block" class="vditor-ir__node"><pre id="code"><code class="hljs">x</code></pre></div>'
    document.body.append(root)
    const dispose = installWebviewContext(root)
    const records: MutationRecord[] = []
    const watcher = new MutationObserver((batch) => records.push(...batch))
    watcher.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-vscode-context'],
    })

    root.querySelector('#block')!.classList.add('vditor-ir__node--expand')
    root.querySelector('code')!.className = 'hljs language-js'
    await Promise.resolve()
    await Promise.resolve()
    records.push(...watcher.takeRecords())

    expect(records).toEqual([])
    expect(context(root.querySelector('#block'))).toBe(
      '{"webviewSection":"code"}',
    )
    watcher.disconnect()
    dispose()
  })
})

// Task 733 / 031 (F-7): an attribute record restamps its target alone unless the target is (or was)
// a rendered pane or a `language-` element, and one batch stamps each scope once. The observer is
// replaced by a fake that keeps its callback, so a batch runs synchronously inside `countBudget`.
// Building the factor 16 fixture with the real Lute can pass 5 s under a full parallel run.
describe('scoped budgets (Task 733 / 031, F-7)', { timeout: 60_000 }, () => {
  const FACTORS: readonly Factor[] = [1, 4, 16]
  let deliver: ((records: MutationRecord[]) => void) | undefined

  beforeEach(() => {
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: (records: MutationRecord[]) => void) {
          deliver = callback
        }
        observe() {
          /* the fake observer delivers only what the test passes */
        }
        disconnect() {
          /* the fake observer delivers only what the test passes */
        }
        takeRecords() {
          return []
        }
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    deliver = undefined
  })

  const attributeRecord = (target: HTMLElement, oldValue: string) =>
    ({
      type: 'attributes',
      target,
      attributeName: 'class',
      oldValue,
      addedNodes: [] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    }) as unknown as MutationRecord
  const addedRecord = (parent: HTMLElement, node: HTMLElement) =>
    ({
      type: 'childList',
      target: parent,
      attributeName: null,
      oldValue: null,
      addedNodes: [node] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    }) as unknown as MutationRecord

  const contexts = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('[data-vscode-context]'), (element) => [
      element,
      element.getAttribute('data-vscode-context'),
    ])

  // Delivers `records` to an observer installed on `root` and counts the batch; `full` is the result
  // of a fresh full stamp of the same DOM, for comparison with what the batch left.
  function deliverCounted(
    root: HTMLElement,
    records: () => MutationRecord[],
  ): { counts: BudgetCounts; stamped: unknown[]; full: unknown[] } {
    if (!root.isConnected) document.body.append(root.parentElement ?? root)
    const dispose = installWebviewContext(root)
    let counts: BudgetCounts
    try {
      const batch = records()
      counts = countBudget(root, () => deliver?.(batch)).counts
    } finally {
      dispose()
    }
    const stamped = contexts(root)
    installWebviewContext(root)()
    return { counts, stamped, full: contexts(root) }
  }

  const cost = (counts: BudgetCounts) =>
    counts.queriedNodes + counts.nodesWalked

  function rootClassToggle(factor: Factor) {
    const { root } = irFixture(tableHeavyMarkdown(factor))
    return deliverCounted(root, () => {
      const oldValue = root.className
      root.classList.toggle('vmde-test-toggle')
      return [attributeRecord(root, oldValue)]
    })
  }

  it.each(FACTORS)(
    'a class toggle on the editor root restamps only the root at factor %i',
    (factor) => {
      const { counts, stamped, full } = rootClassToggle(factor)
      expect(counts.rootQueries).toBe(0)
      expect(counts.queriedNodes).toBe(0)
      expect(stamped).toEqual(full)
    },
  )

  it('costs the same at every factor', () => {
    const costs = FACTORS.map((factor) => cost(rootClassToggle(factor).counts))
    expect(new Set(costs).size).toBe(1)
  })

  it('a batch with the same block added twice stamps it once', () => {
    const { root } = irFixture(tableHeavyMarkdown(1))
    const block = root.querySelector<HTMLElement>('[data-type="code-block"]')!
    const once = deliverCounted(root, () => [addedRecord(root, block)])
    const twice = deliverCounted(root, () => [
      addedRecord(root, block),
      addedRecord(root, block),
    ])
    expect(cost(twice.counts)).toBe(cost(once.counts))
    expect(twice.stamped).toEqual(twice.full)
  })

  it('a removed language- class restamps the subtree', () => {
    const root = document.createElement('div')
    root.className = 'vditor-reset'
    root.innerHTML =
      '<div class="vditor-ir__preview"><div id="chart" class="language-mermaid"><img id="out" src="data:,"></div></div>'
    document.body.replaceChildren(root)
    const chart = root.querySelector<HTMLElement>('#chart')!
    const result = deliverCounted(root, () => {
      chart.classList.remove('language-mermaid')
      return [attributeRecord(chart, 'language-mermaid')]
    })
    expect(
      root.querySelector('#out')?.getAttribute('data-vscode-context'),
    ).toBe('{"webviewSection":"image"}')
    expect(result.stamped).toEqual(result.full)
  })
})
