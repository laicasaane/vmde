import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'markmap-security.md')

test('rebuilt Markmap stays responsive, offline, and zoom-gated', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const remoteRequests: string[] = []
  const pageErrors: string[] = []
  workbox.on('request', (request) => {
    const url = request.url()
    if (
      /^https?:\/\//.test(url) &&
      !url.startsWith('https://file+.vscode-resource.vscode-cdn.net/') &&
      /markmap|unpkg\.com|cdn\.jsdelivr\.net|\/d3(?:[./@-]|$)/i.test(url)
    ) {
      remoteRequests.push(url)
    }
  })
  workbox.on('pageerror', (error) => pageErrors.push(String(error)))

  await evaluateInVSCode(
    async (vscode, args) => {
      const [uri] = args as [string]
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
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
  const svg = frame.locator('.language-markmap svg').first()
  await svg.waitFor({ timeout: 60_000 })

  const state = await frame.locator('body').evaluate(() => {
    const markmap = document.querySelector('.language-markmap svg')
    const fire = (ctrlKey: boolean) => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey,
        deltaY: 120,
      })
      markmap?.dispatchEvent(event)
      return event.defaultPrevented
    }
    return {
      nodes: markmap?.querySelectorAll('.markmap-node').length ?? 0,
      plainWheelPrevented: fire(false),
      ctrlWheelPrevented: fire(true),
      polluted: Object.hasOwn(
        Object.prototype,
        'markmapPrototypePollutionMarker',
      ),
    }
  })
  expect(state.nodes).toBeGreaterThan(5)
  expect(state).toMatchObject({
    plainWheelPrevented: false,
    ctrlWheelPrevented: true,
    polluted: false,
  })

  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              requestAnimationFrame(() => resolve(true))
            }),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  expect(remoteRequests).toEqual([])
  expect(pageErrors).toEqual([])
})
