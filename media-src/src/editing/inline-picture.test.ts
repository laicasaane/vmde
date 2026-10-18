// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

// Task 630: the dialog's captured source coordinate is a rendered-text offset; the test fixes it.
const cursor = vi.hoisted(() => ({ offset: -1 }))
vi.mock('../util/source-map', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/source-map')>()),
  getCursorSourceOffset: () => cursor.offset,
}))
vi.mock('./caret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./caret')>()),
  requestCaret: vi.fn(),
}))

import {
  buildInlinePictureMarkup,
  configureInlinePictureInsertion,
  installInlinePictureInsertion,
  observeInlinePictures,
  planInlinePictureInsertion,
} from './inline-picture'

function root(html: string) {
  document.body.innerHTML = `<div id="root">${html}</div>`
  return document.querySelector<HTMLElement>('#root')!
}

afterEach(() => document.body.replaceChildren())

describe('inline PICTURE source insertion', () => {
  it('generates ordered dark/light sources with escaped source-faithful attributes', () => {
    expect(
      buildInlinePictureMarkup({
        fallback: 'assets/light image.png?one=1&two=2',
        alt: 'A "bright" <example>',
        dark: 'https://cdn.example.test/dark.webp',
        light: './light.png',
      }),
    ).toBe(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://cdn.example.test/dark.webp"><source media="(prefers-color-scheme: light)" srcset="./light.png"><img src="assets/light image.png?one=1&amp;two=2" alt="A &quot;bright&quot; &lt;example&gt;"></picture>',
    )
  })

  it('rejects missing fallback and non-raster or unsafe image locations', () => {
    for (const input of [
      { fallback: '', alt: '', dark: '', light: '' },
      { fallback: 'photo.svg', alt: '', dark: '', light: '' },
      { fallback: 'javascript:alert(1).png', alt: '', dark: '', light: '' },
      {
        fallback: 'https://example.test/photo.png',
        alt: '',
        dark: 'data:image/png;base64,x',
        light: '',
      },
    ])
      expect(buildInlinePictureMarkup(input)).toBeNull()
  })

  it('splices exactly one generated PICTURE into the canonical source without changing CRLF bytes', () => {
    expect(
      planInlinePictureInsertion('before\r\nafter\r\n', 8, {
        fallback: 'light.png',
        alt: 'Light',
        dark: '',
        light: '',
      }),
    ).toEqual({
      markdown:
        'before\r\n<picture><img src="light.png" alt="Light"></picture>after\r\n',
      caret: 60,
    })
  })
})

describe('inline PICTURE reader', () => {
  it('replaces one safe marker sequence with a Lute-invisible picture and leaves authored source markers intact', () => {
    const app = root(
      '<p>Text <span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;source media="(prefers-color-scheme: dark)" srcset="dark.png"&gt;</span><span data-type="html-inline">&lt;img src="light.png" alt="Example"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span> text.</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      'picture[data-vmde-inline-picture="1"]',
    )!

    expect(preview.getAttribute('data-render')).toBe('1')
    expect(preview.getAttribute('contenteditable')).toBe('false')
    expect(preview.querySelector('source')?.getAttribute('srcset')).toBe(
      'dark.png',
    )
    expect(preview.querySelector('img')?.getAttribute('src')).toBe('light.png')
    expect(preview.querySelector('img')?.getAttribute('alt')).toBe('Example')
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === 'none',
      ),
    ).toBe(true)
    expect(app.textContent).toContain('<picture>')
    expect(app.textContent).toContain('light.png')
    dispose()
  })

  it('reveals the original markup on pointer entry and restores the render after focus leaves', () => {
    const app = root(
      '<p>x<span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span>y</p>',
    )
    const dispose = observeInlinePictures(app)
    const preview = app.querySelector<HTMLElement>(
      '[data-vmde-inline-picture]',
    )!
    preview.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
    )

    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    expect(
      Array.from(app.querySelectorAll('[data-type="html-inline"]')).every(
        (marker) => (marker as HTMLElement).style.display === '',
      ),
    ).toBe(true)

    const outside = document.createElement('p')
    outside.textContent = 'outside'
    app.append(outside)
    const range = document.createRange()
    range.setStart(outside.firstChild!, 0)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))

    expect(app.querySelector('[data-vmde-inline-picture]')).not.toBeNull()
    dispose()
  })

  it('fails closed for malformed, unsafe, and literal-code marker sequences', () => {
    const app = root(
      '<p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="vector.svg" alt="Vector"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></p><p><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span></p><pre><code><span data-type="html-inline">&lt;picture&gt;</span><span data-type="html-inline">&lt;img src="photo.png" alt="Photo"&gt;</span><span data-type="html-inline">&lt;/picture&gt;</span></code></pre>',
    )
    const dispose = observeInlinePictures(app)
    expect(app.querySelector('[data-vmde-inline-picture]')).toBeNull()
    dispose()
  })
})

// Task 630 S1 (RED): the dialog acquires exact authority on submit, plans on the acquired exact
// text and posts with a rollback. The module has no acquire seam yet, so `acquireExactAuthority` and
// `postExact(markdown, opts)` are declared here and cast onto the product type.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type ExactDeps = Parameters<typeof configureInlinePictureInsertion>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

// Extra blank lines normalize away, so a rendered offset differs from the host offset.
const HOST_EXACT = 'Alpha\n\n\n\nBeta paragraph\n\n* * *\n\nGamma\n'
const RENDERED = 'Alpha\n\nBeta paragraph\n\n---\n\nGamma\n'
const PICTURE = '<picture><img src="light.png" alt="Light"></picture>'

function pictureHarness(acquire: () => Promise<AcquiredPair | null>) {
  document.body.innerHTML = '<div class="vditor-ir"><p>Alpha</p></div>'
  const editor = document.querySelector<HTMLElement>('.vditor-ir')!
  const host = { text: HOST_EXACT, owned: null as string | null, restored: 0 }
  let shown = RENDERED
  const setValue = vi.fn((value: string) => {
    shown = value
  })
  const inner = {
    currentMode: 'ir',
    ir: { element: editor },
    undo: { addToUndoStack: vi.fn() },
    toolbar: { elements: {} },
  }
  ;(window as any).vditor = {
    getCurrentMode: () => 'ir',
    getValue: () => shown,
    setValue,
    focus: () => undefined,
    insertValue: vi.fn(),
    vditor: inner,
  }
  const acquireExactAuthority = vi.fn(acquire)
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      shown = host.text
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  configureInlinePictureInsertion({
    setApplying: vi.fn(),
    postExact,
    snapshotMarkdown: () => RENDERED,
    acquireExactAuthority,
    onError: (error) => {
      throw error
    },
  } as ExactDeps)
  cursor.offset = RENDERED.indexOf('Gamma')
  const dispose = installInlinePictureInsertion()
  const submit = async () => {
    document.dispatchEvent(new Event('vmde-insert-picture'))
    const dialog = document.querySelector<HTMLFormElement>(
      '[data-vmde-picture-dialog]',
    )!
    ;(dialog.elements.namedItem('fallback') as HTMLInputElement).value =
      'light.png'
    ;(dialog.elements.namedItem('alt') as HTMLInputElement).value = 'Light'
    dialog.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    // The delayed acquire case resolves on a timer, so settle past one macrotask too.
    await new Promise((done) => setTimeout(done, 10))
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  }
  return {
    host,
    shown: () => shown,
    setValue,
    acquireExactAuthority,
    postExact,
    submit,
    dispose,
  }
}

describe('inline PICTURE exact authority (Task 630)', () => {
  it.each([
    ['after a trusted edit (host round trip)', true],
    ['on a fresh document (owned pair)', false],
  ] as const)(
    'Insert Picture %s acquires on submit and splices into the acquired exact text',
    async (_name, delayed) => {
      const h = pictureHarness(async () => {
        if (delayed) await new Promise((done) => setTimeout(done, 1))
        h.host.owned = h.host.text
        return { exact: h.host.text, rendered: h.shown() }
      })
      await h.submit()

      expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
      expect(h.postExact).toHaveBeenCalledOnce()
      expect(h.postExact.mock.calls[0][1]).toEqual({
        rollback: { restore: expect.any(Function) },
      })
      // The picture lands at the mapped host offset; every other byte stays the host's.
      expect(h.host.text).toBe(HOST_EXACT.replace('Gamma', `${PICTURE}Gamma`))
      h.dispose()
    },
  )

  it('Insert Picture refuses a stale host: no write, rollback runs, the DOM shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\n`
    const h = pictureHarness(async () => {
      h.host.owned = h.host.text
      const pair = { exact: h.host.text, rendered: h.shown() }
      h.host.text = drifted
      return pair
    })
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(h.host.restored).toBe(1)
    expect(h.host.text).toBe(drifted)
    expect(h.shown()).toBe(drifted)
    h.dispose()
  })

  it('Insert Picture declines without a write or a DOM change when acquisition fails', async () => {
    const h = pictureHarness(async () => null)
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.setValue).not.toHaveBeenCalled()
    expect(h.postExact).not.toHaveBeenCalled()
    expect(h.shown()).toBe(RENDERED)
    h.dispose()
  })

  it('Insert Picture declines when the host rendering moved while the dialog was open', async () => {
    const h = pictureHarness(async () => ({
      exact: `${HOST_EXACT}Moved\n`,
      rendered: `${RENDERED}Moved\n`,
    }))
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.setValue).not.toHaveBeenCalled()
    expect(h.postExact).not.toHaveBeenCalled()
    h.dispose()
  })
})
