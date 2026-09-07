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
