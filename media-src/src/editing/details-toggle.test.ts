// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { provideUnitFeed } from '../util/unit-changes'
import { transformDetailsSelection } from './details'
import { resolveDetailsBlockRange } from './details-source'

// Task 733 / 012-2: the callout capture is the marker path of `captureTarget` (the exact fallback);
// counting it shows whether a passive Details read ran that fallback.
const calloutCapture = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./callouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./callouts')>()
  return {
    ...actual,
    captureCalloutActionTarget: () => {
      calloutCapture.calls++
      return null
    },
  }
})

import { installDetailsToggleControls } from './details-toggle'

const transform = (
  markdown: string,
  startOffset: number,
  endOffset: number,
  resolved = true,
) => transformDetailsSelection({ markdown, startOffset, endOffset, resolved })

describe('details selection source transform', () => {
  it('wraps one exact LF paragraph and preserves the logical body selection', () => {
    const markdown = 'Before\n\nBody **exact**.\n\nAfter\n'
    const start = markdown.indexOf('Body')
    const end = start + 'Body **exact**.'.length
    expect(transform(markdown, start, end)).toEqual({
      status: 'wrap',
      markdown:
        'Before\n\n<details>\n<summary>Details</summary>\n\nBody **exact**.\n\n</details>\n\nAfter\n',
      startOffset: start + '<details>\n<summary>Details</summary>\n\n'.length,
      endOffset: end + '<details>\n<summary>Details</summary>\n\n'.length,
    })
  })

  it('uses CRLF for wrapper bytes without normalizing a mixed multi-block body', () => {
    const body =
      '## Heading\r\n\r\n3. three\r\n4. four\r\n\r\n```js\r\nconst x = 1\r\n```'
    const markdown = `Before\r\n\r\n${body}\r\n\r\nAfter\r\n`
    const start = markdown.indexOf('## Heading')
    const result = transform(markdown, start, start + body.length)
    expect(result.status).toBe('wrap')
    expect(result.markdown).toContain(
      `<details>\r\n<summary>Details</summary>\r\n\r\n${body}\r\n\r\n</details>`,
    )
    expect(result.markdown?.slice(result.startOffset, result.endOffset)).toBe(
      body,
    )
  })

  it('unwraps only the exact immediate body, including attributed custom summary markup', () => {
    const prefix =
      '<details open class="box">\n<summary data-x="1">Custom <b>title</b></summary>\n\n'
    const body = 'Body\n\n- item'
    const markdown = `${prefix}${body}\n\n</details>\n`
    const result = transform(
      markdown,
      prefix.length,
      prefix.length + body.length,
    )
    expect(result).toEqual({
      status: 'unwrap',
      markdown: `${body}\n`,
      startOffset: 0,
      endOffset: body.length,
    })
  })

  it('wraps a strict subset inside a broader details body instead of removing the ancestor', () => {
    const prefix = '<details>\n<summary>Outer</summary>\n\n'
    const markdown = `${prefix}First\n\nSecond\n\n</details>\n`
    const start = markdown.indexOf('Second')
    const result = transform(markdown, start, start + 'Second'.length)
    expect(result.status).toBe('wrap')
    expect(result.markdown).toContain(
      'First\n\n<details>\n<summary>Details</summary>\n\nSecond\n\n</details>\n\n</details>',
    )
  })

  it.each([
    ['collapsed', 'Body\n', 2, 2, true],
    ['unresolved', 'Body\n', 0, 4, false],
    ['partial raw wrapper', '<details>\nBody\n', 0, 9, true],
    ['closing only', 'Body\n</details>\n', 0, 15, true],
  ])('disables %s selections', (_name, markdown, start, end, resolved) => {
    expect(transform(markdown, start, end, resolved)).toEqual({
      status: 'disabled',
      markdown,
      startOffset: start,
      endOffset: end,
    })
  })

  it('does not treat details-shaped fenced text as an immediate wrapper', () => {
    const markdown =
      '```html\n<details>\n<summary>Fake</summary>\n\nbody\n\n</details>\n```\n'
    const start = markdown.indexOf('body')
    expect(transform(markdown, start, start + 4).status).toBe('wrap')
  })
})

describe('details source block-range resolver', () => {
  it('expands a partial soft-wrapped paragraph and a partial list item', () => {
    const paragraph = 'alpha line\nbeta line\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        paragraph,
        paragraph.indexOf('beta') + 1,
        paragraph.indexOf('beta') + 3,
      ),
    ).toMatchObject({
      startOffset: 0,
      endOffset: 'alpha line\nbeta line'.length,
    })

    const list = 'before\n\n1. one\n2. two\n  - nested\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        list,
        list.indexOf('two') + 1,
        list.indexOf('two') + 2,
      ),
    ).toMatchObject({
      startOffset: list.indexOf('1. one'),
      endOffset: list.indexOf('  - nested') + '  - nested'.length,
    })
  })

  it('rejects partial table cells and fenced bodies', () => {
    const table = '| a | b |\n| - | - |\n| c | d |\n'
    expect(resolveDetailsBlockRange(table, 2, 3)).toBeNull()
    const fence = '```js\nconst x = 1\n```\n'
    const start = fence.indexOf('const')
    expect(resolveDetailsBlockRange(fence, start, start + 5)).toBeNull()
    expect(
      resolveDetailsBlockRange(fence, 0, fence.lastIndexOf('```') + 3),
    ).toMatchObject({
      startOffset: 0,
      endOffset: fence.lastIndexOf('```') + 3,
    })
  })

  it('keeps Setext pairs, loose lists, pipe-less tables, and non-closing fences atomic', () => {
    const setext = 'first title line\nsecond title line\n---\n\nafter\n'
    expect(resolveDetailsBlockRange(setext, 8, 12)).toMatchObject({
      startOffset: 0,
      endOffset: setext.indexOf('---') + 3,
    })

    const loose = '1. one\n\n2. two\n   continuation\n\nafter\n'
    expect(
      resolveDetailsBlockRange(
        loose,
        loose.indexOf('two'),
        loose.indexOf('two') + 2,
      ),
    ).toMatchObject({
      startOffset: 0,
      endOffset: loose.indexOf('   continuation') + '   continuation'.length,
    })

    const table = 'name | value\n--- | ---\na | b\n'
    expect(resolveDetailsBlockRange(table, 1, 3)).toBeNull()

    const fence = '```md\ninside\n``` still source\n## still fenced\n```\n'
    const inside = fence.indexOf('still fenced')
    expect(resolveDetailsBlockRange(fence, inside, inside + 5)).toBeNull()
  })

  it.each([
    ['> quoted\nfirst lazy\nlater continuation\n\nafter\n', 'quoted'],
    ['1. item\nfirst lazy\nlater continuation\n\nafter\n', 'item'],
  ])('keeps a lazy continuation with its %s owner', (markdown) => {
    for (const needle of ['first lazy', 'later continuation']) {
      const start = markdown.indexOf(needle) + 2
      expect(
        resolveDetailsBlockRange(markdown, start, start + 3),
      ).toMatchObject({
        startOffset: 0,
        endOffset: markdown.indexOf('\n\n'),
      })
    }
  })
})

it('treats display math like a fence for complete and partial Details selections', () => {
  for (const math of ['$$x^2$$', '$$\nx^2\n\ny^2\n$$']) {
    const source = `${math}\n\nTail\n`
    const inner = source.indexOf('x^2')
    expect(resolveDetailsBlockRange(source, inner, inner + 3)).toBeNull()
    expect(resolveDetailsBlockRange(source, 0, math.length)).toMatchObject({
      startOffset: 0,
      endOffset: math.length,
    })
  }
})

it('ignores fence and math marker lines inside YAML when resolving a body Details selection', () => {
  for (const marker of ['```', '$$']) {
    const prefix = `---\ntitle: doc\nexample: |\n  ${marker}\n---\n\n`
    const source = `${prefix}Body paragraph\n`
    expect(
      resolveDetailsBlockRange(source, prefix.length, prefix.length + 4),
    ).toMatchObject({
      startOffset: prefix.length,
      endOffset: source.length - 1,
    })
  }
})

it('unwraps existing Details after YAML containing a code marker without changing the prefix', () => {
  const prefix = '---\nexample: |\n  ```\n---\n\n'
  const source = `${prefix}<details>\n<summary>Details</summary>\n\nBody\n\n</details>\n`
  const start = source.indexOf('Body')
  expect(transform(source, start, start + 4)).toMatchObject({
    status: 'unwrap',
    markdown: `${prefix}Body\n`,
  })
})

// Task 733 / 012-2 (action 2, amended Q-98): the Details settled read is passive display state.
// While the model's units are unconfirmed it may take the index's snapshot path (the cost case, a
// refused table cell Undo, is fixed by the history key), but it settles the button from that entry
// with no exact capture (`captureTarget`). With no cacheable key it captures nothing and shows the
// enabled state; the Details action captures exact source when it is invoked.
describe('Details passive settled read with unconfirmed units', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    calloutCapture.calls = 0
  })
  const disposers: Array<() => void> = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    provideUnitFeed(window, undefined)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    delete (window as any).vditor
  })

  const MARKDOWN = 'Alpha paragraph one\n\nBeta paragraph two\n'

  function mountUnconfirmed(options: { noKey?: boolean } = {}) {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const button = document.createElement('button')
    button.dataset.type = 'details'
    toolbar.append(button)
    const root = document.createElement('div')
    root.className = 'vditor-reset'
    root.innerHTML =
      '<p data-block="0">Alpha paragraph one</p><p data-block="0">Beta paragraph two</p>'
    document.body.append(toolbar, root)
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: root }, toolbar: {} },
      getValue: vi.fn(() => MARKDOWN),
    }
    // A live IR model whose units are not confirmed (typing not yet published).
    provideUnitFeed(window, {
      root,
      isLive: () => true,
      liveUnitOf: () => undefined,
      liveUnits: () => [],
      onUnitsChanged: () => () => undefined,
      confirmNow: () => false,
      confirmedLines: () => undefined,
    })
    const snapshotPair = vi.fn(() => ({ exact: MARKDOWN, rendered: MARKDOWN }))
    const revision = {}
    const projection = { owner: {}, mode: 'ir' as const }
    const index = createSourceBlockIndex({
      getActiveRoot: () => root,
      projection: () => projection,
      snapshotPair,
      snapshotRevision: () => (options.noKey ? undefined : revision),
      // A rejected exact key: the passive state reads advisory units on the rendered bytes.
      resolveUnits: () => null,
    })
    const dispose = installDetailsToggleControls(index)
    disposers.push(() => {
      dispose()
      index.dispose()
    })
    vi.advanceTimersByTime(16)
    const text = root.querySelector('p')?.firstChild as Text
    // One OS-style key step to an expanded selection, then the settle frame.
    const selectExpanded = () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'ShiftLeft' }),
      )
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      const selection = document.getSelection() as Selection
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(16)
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }))
      vi.advanceTimersByTime(60)
    }
    return { index, snapshotPair, selectExpanded, button }
  }

  it('settles an expanded selection from one snapshot entry with no exact capture', () => {
    const view = mountUnconfirmed()
    view.selectExpanded()

    expect(view.snapshotPair).toHaveBeenCalledTimes(1)
    expect(calloutCapture.calls).toBe(0)
    expect(view.button.disabled).toBe(false)
  })

  it('with no cacheable index key it enables the button and runs no exact capture', () => {
    const view = mountUnconfirmed({ noKey: true })
    view.selectExpanded()

    expect(calloutCapture.calls).toBe(0)
    expect(view.snapshotPair).not.toHaveBeenCalled()
    expect(view.button.disabled).toBe(false)
  })

  it('a settled read held by the selection bubble builds once at release with no exact capture', () => {
    const view = mountUnconfirmed()
    const release = view.index.holdBuilds()
    view.selectExpanded()
    expect(view.snapshotPair).not.toHaveBeenCalled()
    release()
    vi.advanceTimersByTime(60)

    expect(view.snapshotPair).toHaveBeenCalledTimes(1)
    expect(calloutCapture.calls).toBe(0)
    expect(view.button.disabled).toBe(false)
  })
})

// Task 733 / 036 (F7b and Q9 (b)): a passive Details read never publishes. With a cold index, and with a
// cached model entry whose lazy `rendered` getter takes `snapshotPair()` first, the settled selection
// reads no publishing snapshot: `snapshotPair` here stands for the production pair, which reads
// `liveExactText()` and can post a whole-text `exact` publication while a unit is dirty and unproven.
// The display is the enabled, unpressed `wrap` (Q8 (a)); a later acquiring read still takes the exact
// pair, so the shared cache keeps its exact-source check.
describe('036 passive state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    calloutCapture.calls = 0
  })
  const disposers: Array<() => void> = []
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    delete (window as any).vditor
  })

  const SOURCE = 'Alpha paragraph one\n\nBeta paragraph two\n'

  function mountPassive(entry: 'cold' | 'model') {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    const button = document.createElement('button')
    button.dataset.type = 'details'
    toolbar.append(button)
    const root = document.createElement('div')
    root.className = 'vditor-reset'
    root.innerHTML =
      '<p data-block="0">Alpha paragraph one</p><p data-block="0">Beta paragraph two</p>'
    document.body.append(toolbar, root)
    ;(window as any).vditor = {
      vditor: { currentMode: 'ir', ir: { element: root }, toolbar: {} },
      getValue: vi.fn(() => SOURCE),
    }
    const [alpha, beta] = Array.from(root.querySelectorAll('p'))
    const units = [
      {
        element: alpha,
        start: 0,
        end: 19,
        kind: 'paragraph',
        movable: true,
        members: [alpha],
      },
      {
        element: beta,
        start: 21,
        end: 39,
        kind: 'paragraph',
        movable: true,
        members: [beta],
      },
    ] as never
    const snapshotPair = vi.fn(() => ({ exact: SOURCE, rendered: SOURCE }))
    // Q9 (b) contract (step 4): the production wiring gives passive reads a non-publishing pair (a dirty
    // unproven unit: no exact text). Edited after step 1, which assumed no such dependency.
    const passivePair = vi.fn(() => ({ exact: null, rendered: SOURCE }))
    const revision = {}
    const index = createSourceBlockIndex({
      getActiveRoot: () => root,
      projection: () => ({ owner: {}, mode: 'ir' as const }),
      snapshotPair,
      passivePair,
      snapshotRevision: () => revision,
      // The exact key is rejected, so the passive state is `unknown` and today's fallback would run.
      resolveUnits: () => null,
      ...(entry === 'model'
        ? { modelUnits: () => ({ exact: SOURCE, units }) }
        : {}),
    })
    const dispose = installDetailsToggleControls(index)
    disposers.push(() => {
      dispose()
      index.dispose()
    })
    vi.advanceTimersByTime(16)
    const text = alpha.firstChild as Text
    const selectExpanded = () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'ShiftLeft' }),
      )
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 5)
      const selection = document.getSelection() as Selection
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(16)
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }))
      vi.advanceTimersByTime(60)
    }
    const textNodes = () => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let count = 0
      while (walker.nextNode()) count++
      return count
    }
    return {
      index,
      snapshotPair,
      passivePair,
      selectExpanded,
      button,
      textNodes,
    }
  }

  it.each(['cold', 'model'] as const)(
    'the %s-index passive read publishes nothing and displays the enabled wrap state',
    (entry) => {
      const view = mountPassive(entry)
      const before = view.textNodes()
      view.selectExpanded()

      expect(view.snapshotPair).not.toHaveBeenCalled()
      expect(view.passivePair).toHaveBeenCalledTimes(1)
      expect(calloutCapture.calls).toBe(0)
      expect(view.textNodes()).toBe(before)
      expect(view.button.disabled).toBe(false)
      expect(view.button.getAttribute('aria-pressed')).toBe('false')
    },
  )

  it.each(['cold', 'model'] as const)(
    'a later acquiring read after the %s passive read takes the exact pair',
    (entry) => {
      const view = mountPassive(entry)
      view.selectExpanded()
      expect(view.snapshotPair).not.toHaveBeenCalled()

      const exact = view.index.read()

      expect(exact?.exact).toBe(SOURCE)
      expect(view.snapshotPair).toHaveBeenCalledTimes(1)
    },
  )
})
