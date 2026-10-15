// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRealLute } from '../testing/real-lute'
import { insertWrapHint } from '../util/wrap-hint-mark'
import {
  flattenSourceHtml,
  observeWysiwygCodeHighlight,
  positionAtOffset,
  wrapLuteFlatten,
} from './wysiwyg-code-highlight'

describe('flattenSourceHtml', () => {
  it('unwraps token spans in a wysiwyg code source, leaving raw text', () => {
    const html =
      '<pre class="vditor-wysiwyg__pre"><code class="language-js hljs">' +
      '<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>' +
      '</code></pre>'
    const out = flattenSourceHtml(html)
    expect(out).not.toContain('<span')
    expect(out).toContain('const a = 1')
  })

  it('strips the hljs class off the source code (Lute reads it as the fence info-string)', () => {
    const html =
      '<pre class="vditor-wysiwyg__pre"><code class="language-js hljs">const a = 1</code></pre>'
    const out = flattenSourceHtml(html)
    expect(out).toContain('class="language-js"')
    expect(out).not.toContain('hljs')
  })

  it('preserves the <wbr> caret marker while unwrapping', () => {
    const html =
      '<pre class="vditor-wysiwyg__pre"><code class="language-js hljs">' +
      '<span class="hljs-keyword">con<wbr>st</span> a' +
      '</code></pre>'
    const out = flattenSourceHtml(html)
    expect(out).toContain('<wbr>')
    expect(out).not.toContain('<span')
    // wbr stays at its caret position inside the (now unwrapped) text.
    expect(out).toContain('con<wbr>st a')
  })

  it('returns the input untouched when there is no wysiwyg code source (fast path)', () => {
    const html = '<p>just a <strong>paragraph</strong></p>'
    expect(flattenSourceHtml(html)).toBe(html)
  })

  it('does not touch the rendered preview, only the editable source', () => {
    // The preview keeps its spans (Lute ignores it); only the source `pre.vditor-wysiwyg__pre` is flattened.
    const html =
      '<pre class="vditor-wysiwyg__preview"><code class="language-js hljs"><span class="hljs-keyword">const</span></code></pre>'
    expect(flattenSourceHtml(html)).toBe(html)
  })
})

describe('positionAtOffset', () => {
  it('locates an offset within a single text node', () => {
    expect(positionAtOffset([11], 5)).toEqual([0, 5])
  })

  it('locates an offset in a later node after a boundary', () => {
    // nodes of length 5 and 6 (total 11); offset 8 → node 1, local offset 3.
    expect(positionAtOffset([5, 6], 8)).toEqual([1, 3])
    expect(positionAtOffset([5, 6], 5)).toEqual([1, 0])
  })

  it('clamps past-the-end offsets to the last node', () => {
    expect(positionAtOffset([4], 99)).toEqual([0, 4])
  })

  it('clamps negatives to the start and handles no nodes', () => {
    expect(positionAtOffset([4], -3)).toEqual([0, 0])
    expect(positionAtOffset([], 5)).toEqual([0, 0])
  })
})

describe('observeWysiwygCodeHighlight mode-gate (task 173/174)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const nextFrame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const build = () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<pre class="vditor-wysiwyg__pre"><code class="language-js">const a = 1</code></pre>'
    document.body.appendChild(root)
    return root
  }

  it('does NOT tag wysiwyg sources when not in WYSIWYG mode (the wasted IR-keystroke scan)', async () => {
    const root = build()
    const dispose = observeWysiwygCodeHighlight(
      root,
      () => undefined,
      () => false, // pretend we're in IR mode
    )
    const code = root.querySelector('code')!
    code.appendChild(document.createTextNode('x')) // a mutation that would wake the observer
    await flush()
    expect(code.classList.contains('hljs')).toBe(false)
    dispose()
    root.remove()
  })

  it('tags wysiwyg sources when in WYSIWYG mode', async () => {
    const root = build()
    const dispose = observeWysiwygCodeHighlight(
      root,
      () => undefined,
      () => true,
    )
    const code = root.querySelector('code')!
    await flush()
    expect(code.classList.contains('hljs')).toBe(true) // tagged (install + observer run in wysiwyg)
    dispose()
    root.remove()
  })

  it('does not rewrite an unchanged plain source after selection changes', async () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<pre class="vditor-wysiwyg__pre"><code class="language-js">replace</code></pre>'
    document.body.appendChild(root)
    const code = root.querySelector<HTMLElement>('code')!
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'innerHTML',
    )!
    let writes = 0
    Object.defineProperty(code, 'innerHTML', {
      configurable: true,
      get: () => descriptor.get!.call(code),
      set: (html: string) => {
        writes++
        descriptor.set!.call(code, html)
      },
    })
    const dispose = observeWysiwygCodeHighlight(
      root,
      () => ({
        highlight: (text) => ({ value: text }),
        getLanguage: () => true,
      }),
      () => true,
    )
    await nextFrame()
    const text = code.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, text.length)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await nextFrame()
    expect(writes).toBe(1)
    dispose()
    root.remove()
  })
})

// Task 640 S2b (go condition 2). A wrap hint is an empty span inside inline code. Lute's WYSIWYG
// serializer truncates inline code at the first element child (S1 probe 3, Part 1 revision), so
// every WYSIWYG Lute call must read HTML without hints.
describe('wrap hints in WYSIWYG Lute calls (Task 640)', () => {
  const HINT = '<span class="vmde-wrap-hint" data-render="1"></span>'

  it('strips hint spans from HTML that has no wysiwyg code source (the early return must pass it)', () => {
    expect(
      flattenSourceHtml(
        `<p data-block="0">a <code>src/${HINT}Table.cs</code></p>`,
      ),
    ).toBe('<p data-block="0">a <code>src/Table.cs</code></p>')
  })

  it('strips hint spans and still flattens the fenced source in the same HTML', () => {
    const html =
      `<p><code>a/${HINT}b</code></p>` +
      '<pre class="vditor-wysiwyg__pre"><code class="language-js hljs"><span class="hljs-keyword">const</span> a</code></pre>'
    expect(flattenSourceHtml(html)).toBe(
      '<p><code>a/b</code></p><pre class="vditor-wysiwyg__pre"><code class="language-js">const a</code></pre>',
    )
  })

  it('leaves HTML without hints or fenced source untouched', () => {
    const html = '<p>just a <code>word</code></p>'
    expect(flattenSourceHtml(html)).toBe(html)
  })

  const MARKDOWN = [
    '# Heading with `src/HeadingCode.cs` inside',
    '',
    'A paragraph with **bold `src/BoldCode.cs`** and `src/Paragraph/Code.cs` text.',
    '',
    '- list item `src/ListItem/Code.cs`',
    '',
    '> quote with `src/Quote/Code.cs`',
    '',
    '| a | b |',
    '| - | - |',
    '| `src/Cell/Code.cs` | plain |',
    '',
  ].join('\n')

  function hinted(html: string): string {
    const root = document.createElement('div')
    root.innerHTML = html
    let count = 0
    for (const code of Array.from(root.querySelectorAll('code'))) {
      const text = code.firstChild as Text
      insertWrapHint(text, Math.max(1, Math.floor(text.length / 2)))
      count++
    }
    expect(count).toBeGreaterThanOrEqual(5)
    return root.innerHTML
  }

  it('documents the hazard: an unwrapped Lute truncates inline code at a hint', () => {
    const real = createRealLute('wysiwyg')
    const html = hinted(real.render(MARKDOWN))
    expect(real.serialize(html)).not.toBe(real.serialize(real.render(MARKDOWN)))
  })

  it('keeps every inline code byte through SpinVditorDOM and VditorDOM2Md once the Lute methods are wrapped', () => {
    const real = createRealLute('wysiwyg')
    const html = hinted(real.render(MARKDOWN))
    const canonical = real.serialize(real.render(MARKDOWN))
    const spun = real.lute.SpinVditorDOM(real.render(MARKDOWN))

    wrapLuteFlatten({ vditor: { lute: real.lute } })

    expect(real.lute.VditorDOM2Md(html)).toBe(canonical)
    expect(real.lute.SpinVditorDOM(html)).toBe(spun)
    expect(real.lute.SpinVditorDOM(html)).not.toContain('vmde-wrap-hint')
  })
})
