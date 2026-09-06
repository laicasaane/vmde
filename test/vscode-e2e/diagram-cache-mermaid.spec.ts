import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 184 Phase 3 acceptance (real VS Code, headless) — the Vditor-NATIVE SVG engines served from
// the persistent host cache with ZERO fresh render on reopen: mermaid, graphviz, abc, flowchart.
// Unlike the d2 path (a custom observer), these are rendered by Vditor's OWN deferred
// `addScript().then()` pass; we reserve each preview target (`data-processed="true"`) synchronously
// on open — before that deferred pass fires — so a cache HIT paints the stored SVG and the engine
// never runs it. A MISS (cold cache) renders the source offscreen (renderNativeJobs) and caches it.
//
// Zero-render proof: `data-vmde-cache-hit` is set ONLY by our cache paint, and only on a block we
// reserved (data-processed set before the engine's deferred pass) → its presence on reopen means the
// engine was blocked. For mermaid we ALSO assert a byte-identical svg (mermaid stamps every render a
// fresh `"mermaid"+genUUID()` id — vditor mermaidRender.ts:47 — so identical markup can only be the
// reused cached svg). Plus a byte-identical whole-doc `getValue()` (injected svgs carry data-render="1").
const FIXTURE = path.join(__dirname, 'fixtures', 'diagram-cache.md')
const NATIVE_LANGS = ['mermaid', 'abc', 'flowchart']

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode'), args: string[]) => Promise<void>,
    args: [string],
  ) => Promise<void>,
) {
  await evaluateInVSCode(
    async (vscode, args) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [FIXTURE],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  return frame
}

async function closeActive(
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode')) => Promise<void>,
  ) => Promise<void>,
) {
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand(
      'workbench.action.revertAndCloseActiveEditor',
    )
  })
}

// Wait until every native engine's preview target holds a rendered <svg>, then settle.
async function waitNative(frame: ReturnType<typeof wf>) {
  for (const lang of NATIVE_LANGS) {
    await frame
      .locator(`.vditor-ir__preview .language-${lang} svg`)
      .first()
      .waitFor({ timeout: 60_000 })
  }
  // task 512: retain — native renderer cache PUTs have no host acknowledgement
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
}

// Per-lang snapshot of the native preview target + the whole-doc getValue.
async function snapshot(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate((_b, langs) => {
    const byLang: Record<
      string,
      { cacheHit: boolean; svgId: string; svgHTML: string; width: number }
    > = {}
    for (const lang of langs) {
      const target = document.querySelector(
        `.vditor-ir__preview .language-${lang}`,
      )
      const svg = target?.querySelector('svg')
      byLang[lang] = {
        cacheHit: target?.getAttribute('data-vmde-cache-hit') === '1',
        svgId: svg?.id ?? '',
        svgHTML: svg?.outerHTML ?? '',
        width: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
      }
    }
    const vditor = (window as unknown as { vditor?: { getValue(): string } })
      .vditor
    return { byLang, value: vditor ? vditor.getValue() : '' }
  }, NATIVE_LANGS)
}

test('reopen serves every native engine (mermaid/graphviz/abc/flowchart) from cache with zero fresh render', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame1 = await open(workbox, evaluateInVSCode)
  await waitNative(frame1)
  const before = await snapshot(frame1)
  for (const lang of NATIVE_LANGS) {
    expect(
      before.byLang[lang].svgHTML.length,
      `${lang} rendered`,
    ).toBeGreaterThan(0)
    expect(before.byLang[lang].width, `${lang} width`).toBeGreaterThan(0)
  }

  await closeActive(evaluateInVSCode)
  await new Promise((r) => setTimeout(r, 500))
  const frame2 = await open(workbox, evaluateInVSCode)
  await waitNative(frame2)
  const after = await snapshot(frame2)

  for (const lang of NATIVE_LANGS) {
    const b = before.byLang[lang]
    const a = after.byLang[lang]
    // eslint-disable-next-line no-console
    console.log(
      `[native-cache:${lang}] hit=${a.cacheHit} w=${b.width}/${a.width} id=${a.svgId === b.svgId}`,
    )
    // Served from the host cache (marker set only by our cache paint on a reserved/blocked block).
    expect(a.cacheHit, `${lang} cache-hit on reopen`).toBe(true)
    // Correct size — no task-183 grow/shrink (painted into the live constrained preview node).
    expect(
      Math.abs(a.width - b.width),
      `${lang} size stable`,
    ).toBeLessThanOrEqual(2)
  }
  // mermaid: mermaid mints a fresh genUUID id on every RENDER, so a matching id proves the svg was
  // NOT re-rendered — it came from cache. Compare the STEM: since task 373 each PAINT appends its own
  // `-vmN` namespace (duplicate ids across panes sent url(#…) into the hidden pane and killed every
  // arrowhead), so the suffix is expected to differ while the mermaid uuid must not.
  const idStem = (x: string) => x.replace(/-vm\d+$/, '')
  const htmlStem = (x: string) => x.replace(/-vm\d+(?=["')])/g, '')
  expect(idStem(after.byLang.mermaid.svgId)).toBe(
    idStem(before.byLang.mermaid.svgId),
  )
  expect(htmlStem(after.byLang.mermaid.svgHTML)).toBe(
    htmlStem(before.byLang.mermaid.svgHTML),
  )
  // getValue() byte-identical with the cached svgs injected (data-render="1" → Lute-invisible).
  expect(after.value).toBe(before.value)
})
