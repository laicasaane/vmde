// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installWebviewContext } from './webview-context'

const context = (element: Element | null) =>
  element?.getAttribute('data-vscode-context')

describe('installWebviewContext', () => {
  afterEach(() => document.body.replaceChildren())

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
})
