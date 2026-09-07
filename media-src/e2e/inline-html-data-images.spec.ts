import { expect, test } from './coverage-fixture'

// A 1×1 transparent PNG, intentionally self-contained so the browser probe has no network or
// workspace-file dependency. Lute's sanitizer permits raster data images but rejects SVG data URLs.
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLw5QAAAABJRU5ErkJggg=='
const SVG_DATA_URI =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg=='

test('Vditor sanitization keeps safe raster data images and blocks SVG data images', async ({
  page,
}) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__ready === true)

  const result = await page.evaluate(
    async ({ png, svg }) => {
      const lute = (window as any).vditor.vditor.lute
      const markdown = [
        `<img src="${png}" alt="raw png">`,
        '',
        `<img src="${png}" alt="event handler stripped" onerror="window.__vmdeUnsafe = true">`,
        '',
        '| Asset |',
        '| --- |',
        `| <img src="${png}" alt="table png"> |`,
        '',
        `![markdown png](${png})`,
        '',
        `<img src="${svg}" alt="raw svg">`,
        '',
        '<img src="javascript:window.__vmdeUnsafe = true" alt="javascript URL">',
        '',
        '~~~html',
        `<img src="${png}" alt="fenced png">`,
        '~~~',
      ].join('\n')
      const preview = lute.Md2HTML(markdown)
      const root = document.createElement('div')
      root.innerHTML = preview
      const images = Array.from(root.querySelectorAll('img'))
      const loadedWidths = await Promise.all(
        images
          .filter((image) => image.getAttribute('src')?.startsWith('data:'))
          .map(
            (image) =>
              new Promise<number>((resolve) => {
                image.addEventListener(
                  'load',
                  () => resolve(image.naturalWidth),
                  {
                    once: true,
                  },
                )
                image.addEventListener('error', () => resolve(0), {
                  once: true,
                })
                document.body.append(image)
              }),
          ),
      )
      root.remove()
      return {
        pngSourceCount: images.filter(
          (image) => image.getAttribute('src') === png,
        ).length,
        svgSourceCount: images.filter(
          (image) => image.getAttribute('src') === svg,
        ).length,
        javascriptSourceCount: images.filter((image) =>
          image.getAttribute('src')?.startsWith('javascript:'),
        ).length,
        eventAttributeCount: images.filter((image) =>
          Array.from(image.attributes).some((attribute) =>
            attribute.name.startsWith('on'),
          ),
        ).length,
        loadedWidths,
        fenceIsLiteral: preview.includes(`&lt;img src=&quot;${png}`),
      }
    },
    { png: PNG_DATA_URI, svg: SVG_DATA_URI },
  )

  expect(result.pngSourceCount).toBe(4)
  expect(result.loadedWidths).toEqual([1, 1, 1, 1])
  expect(result.svgSourceCount).toBe(0)
  expect(result.javascriptSourceCount).toBe(0)
  expect(result.eventAttributeCount).toBe(0)
  expect(result.fenceIsLiteral).toBe(true)
})

test('the SVG presentation adapter creates blobs only for restricted sanitized candidates', async ({
  page,
}) => {
  await page.goto('/behaviors.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  const result = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/vditor/dist/js/dompurify/purify.min.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('DOMPurify asset failed to load'))
      document.head.append(script)
    })
    const adapter = (window as any).__svgDataImageAdapter
    const safe =
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxwYXRoIGQ9Ik0wIDBoMXYxSDB6Ii8+PC9zdmc+'
    const hostile = [
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=',
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==',
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzdHlsZT4qe2Rpc3BsYXk6bm9uZX08L3N0eWxlPjwvc3ZnPg==',
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxmb3JlaWduT2JqZWN0PjxpbWcgc3JjPXggb25lcnJvcj1hbGVydCgxKT48L2ZvcmVpZ25PYmplY3Q+PC9zdmc+',
      'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxpbWFnZSBocmVmPSJodHRwczovL2V2aWwuZXhhbXBsZS94LnBuZyIvPjwvc3ZnPg==',
      'PCFET0NUWVBFIHN2Zz48c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PC9zdmc+',
    ].map((encoded) => `data:image/svg+xml;base64,${encoded}`)
    const source = [
      `<img src="${safe}" alt="safe">`,
      ...hostile.map((uri, i) => `<img src="${uri}" alt="hostile-${i}">`),
      '~~~html',
      `<img src="${safe}" alt="literal">`,
      '~~~',
    ].join('\n')
    const masked = adapter.maskSvgDataImagesForPreview(source)
    const root = document.createElement('div')
    root.innerHTML = masked
    adapter.applySvgDataImagePreviews(root)
    return {
      sourceUnchanged: source.includes(safe),
      fenceLiteral: masked.includes(`<img src="${safe}" alt="literal">`),
      rendered: root.querySelectorAll('[data-render="1"] img[src^="blob:"]')
        .length,
      remainingCandidates: root.querySelectorAll('img[data-vmde-svg-data]')
        .length,
      unsafeEvents: root.querySelectorAll('[onload], [onerror]').length,
    }
  })

  expect(result).toEqual({
    sourceUnchanged: true,
    fenceLiteral: true,
    rendered: 1,
    remainingCandidates: 6,
    unsafeEvents: 0,
  })
})
