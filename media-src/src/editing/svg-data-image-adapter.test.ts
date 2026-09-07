// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import {
  applySvgDataImagePreviews,
  maskSvgDataImagesForPreview,
  observeSvgDataImagePreviews,
} from './svg-data-image-adapter'

const SAFE_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxwYXRoIGQ9Ik0wIDBoMXYxSDB6Ii8+PC9zdmc+'
const SCRIPT_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4='

afterEach(() => {
  vi.unstubAllGlobals()
  delete window.DOMPurify
})

describe('maskSvgDataImagesForPreview', () => {
  it('moves a raw SVG data URI into a sanitizer-safe preview-only attribute', () => {
    const source = `<img width="24" src="${SAFE_SVG}" alt="safe icon">`
    const masked = maskSvgDataImagesForPreview(source)

    expect(masked).toContain('data-vmde-svg-data=')
    expect(masked).not.toContain(`src="${SAFE_SVG}"`)
    expect(masked).toContain('alt="safe icon"')
  })

  it('leaves fenced HTML literal', () => {
    const source = `~~~html\n<img src="${SAFE_SVG}" alt="literal">\n~~~`
    expect(maskSvgDataImagesForPreview(source)).toBe(source)
  })
})

describe('applySvgDataImagePreviews', () => {
  beforeEach(() => {
    window.DOMPurify = DOMPurify
  })
  it('renders a sanitized SVG through a blob URL in a Lute-invisible preview node', () => {
    const createObjectURL = vi.fn(() => 'blob:vmde-safe')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const root = document.createElement('div')
    root.innerHTML = `<img data-vmde-svg-data="${SAFE_SVG}" alt="safe icon">`

    applySvgDataImagePreviews(root)

    const preview = root.querySelector<HTMLElement>('[data-render="1"]')
    expect(preview?.getAttribute('contenteditable')).toBe('false')
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe(
      'blob:vmde-safe',
    )
    expect(root.querySelector('img[data-vmde-svg-data]')).toBeNull()
    expect(createObjectURL).toHaveBeenCalledOnce()
  })

  it('rejects a script-bearing SVG without creating a blob URL', () => {
    const createObjectURL = vi.fn(() => 'blob:unsafe')
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() })
    const root = document.createElement('div')
    root.innerHTML = `<img data-vmde-svg-data="${SCRIPT_SVG}" alt="hostile">`

    applySvgDataImagePreviews(root)

    expect(root.querySelector('[data-render="1"]')).toBeNull()
    expect(root.querySelector('img[data-vmde-svg-data]')).not.toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('adds an IR/WYSIWYG render-only preview without changing the authored HTML marker', () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<div data-type="html-block"><pre class="vditor-ir__marker--pre"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></pre><pre class="vditor-ir__preview" data-render="2"><img alt="safe icon"></pre></div>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root
        .querySelector('.vditor-ir__preview [data-render="1"] img')
        ?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it('adds a Lute-invisible preview beside an inline HTML marker', () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<p><span data-type="html-inline"><code>&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></span></p>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root
        .querySelector('[data-type="html-inline"] [data-render="1"] img')
        ?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it("adds a WYSIWYG preview beside Vditor's inline code marker", () => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL: vi.fn(),
    })
    const root = document.createElement('div')
    root.innerHTML = `<p><code data-type="html-inline">​&lt;img src=&quot;${SAFE_SVG}&quot; alt=&quot;safe icon&quot;&gt;</code></p>`
    const source = root.querySelector('code')?.textContent

    applySvgDataImagePreviews(root)

    expect(root.querySelector('code')?.textContent).toBe(source)
    expect(
      root.querySelector('p > [data-render="1"] img')?.getAttribute('src'),
    ).toBe('blob:vmde-safe')
  })

  it('revokes the blob URL when a Preview rebuild removes its render-only node', async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:vmde-safe'),
      revokeObjectURL,
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = `<img data-vmde-svg-data="${SAFE_SVG}" alt="safe icon">`
    const dispose = observeSvgDataImagePreviews(root, 'local')
    revokeObjectURL.mockClear()

    root.replaceChildren()
    await Promise.resolve()

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:vmde-safe')
    dispose()
    root.remove()
  })
})
