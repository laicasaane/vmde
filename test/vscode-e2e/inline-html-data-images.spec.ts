import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'inline-html-data-images.md')

test('safe raster data images render under the real webview CSP while SVG data images stay sanitized', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, [uri]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE] as [string],
  )

  const frame = wf(workbox)
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0)
  await frame.locator('body').evaluate(() => {
    document
      .querySelector<HTMLElement>('button[data-type="preview"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const preview = (window as any).vditor.vditor.preview
          .element as HTMLElement
        const images = Array.from(
          preview.querySelectorAll<HTMLImageElement>('img'),
        )
        return {
          visible: preview.style.display === 'block',
          png: images.filter((image: HTMLImageElement) =>
            image.src.startsWith('data:image/png;base64,'),
          ).length,
          pngWidths: images
            .filter((image: HTMLImageElement) =>
              image.src.startsWith('data:image/png;base64,'),
            )
            .map((image: HTMLImageElement) => image.naturalWidth),
          svg: images.filter((image: HTMLImageElement) =>
            image.src.startsWith('data:image/svg+xml;base64,'),
          ).length,
          renderedSvg: preview.querySelectorAll(
            '[data-render="1"] img[src^="blob:"]',
          ).length,
          rejectedSvgCandidates: preview.querySelectorAll(
            'img[data-vmde-svg-data]',
          ).length,
          javascript: images.filter((image: HTMLImageElement) =>
            image.src.startsWith('javascript:'),
          ).length,
          eventAttributes: images.filter((image: HTMLImageElement) =>
            Array.from(image.attributes).some((attribute) =>
              attribute.name.startsWith('on'),
            ),
          ).length,
          fencedImage: Array.from(preview.querySelectorAll('code')).some(
            (code) => (code.textContent ?? '').includes('fenced PNG'),
          ),
          unsafeSvgMarkup: preview.querySelectorAll(
            'script, style, foreignObject, [onload], [onerror], [href^="http"]',
          ).length,
          editorRenderedSvg: document.querySelectorAll(
            '.vditor-ir [data-render="1"] img[src^="blob:"]',
          ).length,
          sourcePreservesSvg: (window as any).vditor
            .getValue()
            .includes(
              'src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg=="',
            ),
          sourceHasNoAdapterMarker: !(window as any).vditor
            .getValue()
            .includes('data-vmde-svg-data'),
        }
      }),
    )
    .toEqual({
      visible: true,
      png: 4,
      pngWidths: [1, 1, 1, 1],
      svg: 0,
      renderedSvg: 1,
      rejectedSvgCandidates: 6,
      javascript: 0,
      eventAttributes: 0,
      fencedImage: true,
      unsafeSvgMarkup: 0,
      editorRenderedSvg: 1,
      sourcePreservesSvg: true,
      sourceHasNoAdapterMarker: true,
    })
})
