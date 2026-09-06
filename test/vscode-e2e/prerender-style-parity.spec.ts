import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'prerender-style-parity.md')

const probes = {
  heading: ':scope > h1',
  paragraph: ':scope > p',
  list: ':scope > ul',
  quote: ':scope > blockquote',
  table: ':scope > table',
  code: ':scope > div[data-type="code-block"]',
} as const

type Snapshot = Record<keyof typeof probes, Record<string, string | number>>

function readSnapshot(
  frame: ReturnType<typeof wf>,
  rootSelector: string,
): Promise<Snapshot> {
  return frame.locator('body').evaluate(
    (_body, { rootSelector, probes }) => {
      const root = document.querySelector(rootSelector)
      if (!root) throw new Error(`missing parity root: ${rootSelector}`)
      const readProbe = (name: keyof typeof probes) => {
        const element = root.querySelector(probes[name]) as HTMLElement | null
        if (!element) throw new Error(`missing parity probe: ${name}`)
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          marginBottom: style.marginBottom,
          marginTop: style.marginTop,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          paddingRight: style.paddingRight,
          paddingTop: style.paddingTop,
          // Syntax highlighting is a post-mount dynamic decoration and is explicitly outside the
          // host first-paint contract; it can add token-line geometry after every static style matches.
          height: name === 'code' ? 0 : Math.round(rect.height * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          x: Math.round(rect.x * 100) / 100,
          y: Math.round(rect.y * 100) / 100,
        }
      }
      return {
        heading: readProbe('heading'),
        paragraph: readProbe('paragraph'),
        list: readProbe('list'),
        quote: readProbe('quote'),
        table: readProbe('table'),
        code: readProbe('code'),
      }
    },
    { rootSelector, probes },
  )
}

test('host prerender and settled IR keep static Markdown styles identical', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(
    async (vscode, args) => {
      const previous = process.env.VMDE_PRERENDER_PARITY_HOLD
      process.env.VMDE_PRERENDER_PARITY_HOLD = '1'
      try {
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      } finally {
        if (previous === undefined)
          delete process.env.VMDE_PRERENDER_PARITY_HOLD
        else process.env.VMDE_PRERENDER_PARITY_HOLD = previous
      }
    },
    [FIXTURE] as [string],
  )

  const frame = wf(workbox)
  const overlay = frame.locator('#vmde-prerender')
  await overlay.waitFor({ timeout: 45_000 })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        )
          .filter((link) => !link.disabled)
          .every((link) => link.sheet !== null),
      ),
    )
    .toBe(true)
  await frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
  const before = await readSnapshot(frame, '#vmde-prerender .vditor-reset')

  await expect
    .poll(() =>
      frame.locator('body').evaluate(
        () =>
          typeof (
            window as typeof window & {
              __vmdeReleasePrerender?: () => void
            }
          ).__vmdeReleasePrerender,
      ),
    )
    .toBe('function')
  await frame.locator('body').evaluate(() => {
    const release = (
      window as typeof window & {
        __vmdeReleasePrerender?: () => void
      }
    ).__vmdeReleasePrerender
    if (!release) throw new Error('prerender parity hold is unavailable')
    release()
  })
  await overlay.waitFor({ state: 'detached', timeout: 45_000 })

  await expect
    .poll(() => readSnapshot(frame, '.vditor-ir .vditor-reset'))
    .toEqual(before)
})
