import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docFor,
  FONTS,
  type Frame,
  frames,
  type HostEvaluator,
  measure,
  openIr,
  place,
} from './helpers/ir-page-navigation'
import { docText } from './webview-helpers'

// Task 612 — PageUp/PageDown travel near hidden IR markers, in the real VS Code webview with
// OS-level keys (XTEST). Run under the isolated Xvfb + Openbox shell with VMDE_XTEST=1. The
// `@probe` measurement lives in ir-page-navigation-probe.spec.ts.

// ---------------------------------------------------------------------------------------------
// Acceptance (Task 612): in the real webview, OS PageUp/PageDown next to collapsed inline code move a
// page like plain text, Shift extends from a fixed anchor, and the Markdown stays exact.

const WORD_JOINER = '⁠'
const ACCEPT_CASES: [string, string][] = [
  ['anchor-end', 'Prior'],
  ['mid-mid', 'Prior'],
  ['mid-end', 'Prior'],
  ['anchor-top-end', 'Next'],
  ['mid-mid', 'Next'],
]
const SHIFT_CASES: [string, string][] = [
  ['anchor-end', 'shift+Prior'],
  ['mid-mid', 'shift+Prior'],
  ['mid-mid', 'shift+Next'],
]
const ACCEPT_PRESSES = 2

type Measured = {
  docY: number
  clientHeight: number
  lineHeight: number
  collapsed: boolean
  selected: number
} | null

async function travelAfter(
  frame: Frame,
  input: Awaited<ReturnType<typeof createXtestInput>>,
  start: string,
  key: string,
  presses: number,
) {
  expect(await place(frame, start)).toBe(true)
  await frames(frame, 4)
  const first = (await measure(frame)) as NonNullable<Measured>
  let prev = first.docY
  const travel: number[] = []
  let last = first
  for (let i = 0; i < presses; i++) {
    await input.key(key)
    await frames(frame, 4)
    last = (await measure(frame)) as NonNullable<Measured>
    travel.push(Math.abs(last.docY - prev))
    prev = last.docY
  }
  return { first, last, travel }
}

for (const font of Object.keys(FONTS))
  test(`OS PageUp/PageDown near collapsed code move a page like plain text (${font} font)`, async ({
    electronApp,
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.skip(
      process.env.VMDE_XTEST !== '1',
      'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
    )
    test.setTimeout(900_000)
    const evaluate = evaluateInVSCode as HostEvaluator
    const input = await createXtestInput(electronApp, workbox as Page)
    // Tolerance vs the plain control: whole-block quantization of the native move, wider in the
    // `mixed` document whose lines differ in height (measured 65 px at clientHeight 725).
    const controls = new Map<string, number[]>()
    for (const kind of ['plain', 'code', 'mixed', 'wcode']) {
      const file = path.join(baseDir, `task612-accept-${kind}-${font}.md`)
      const doc = docFor(kind)
      writeFileSync(file, doc)
      const frame = await openIr(evaluate, workbox, file, font)
      for (const [start, key] of ACCEPT_CASES) {
        const { first, travel } = await travelAfter(
          frame,
          input,
          start,
          key,
          ACCEPT_PRESSES,
        )
        const id = `${start}|${key}`
        if (kind === 'plain') {
          controls.set(id, travel)
          continue
        }
        const control = controls.get(id) as number[]
        travel.forEach((t, i) => {
          const label = `${kind} ${start} ${key} press ${i + 1}`
          expect(
            t,
            `${label}: travel ${t} of ${first.clientHeight}`,
          ).toBeGreaterThanOrEqual(0.7 * first.clientHeight)
          expect(
            Math.abs(t - control[i]),
            `${label}: vs plain control ${control[i]}`,
          ).toBeLessThanOrEqual(0.15 * first.clientHeight)
        })
      }
      if (kind === 'plain') continue
      // Shift: a selection grows a page with the anchor fixed.
      for (const [start, key] of SHIFT_CASES) {
        const { first, last } = await travelAfter(frame, input, start, key, 1)
        expect(last.collapsed, `${kind} ${start} ${key}: extends`).toBe(false)
        expect(
          Math.abs(last.docY - first.docY),
          `${kind} ${start} ${key}: focus travel`,
        ).toBeGreaterThanOrEqual(0.7 * first.clientHeight)
        const anchorY = (await frame.locator('body').evaluate(() => {
          const s = getSelection()!
          const r = document.createRange()
          r.setStart(s.anchorNode!, s.anchorOffset)
          r.collapse(true)
          const el = (window as any).vditor.vditor.ir.element as HTMLElement
          const rect =
            r.getClientRects()[0] ??
            (s.anchorNode!.parentElement as Element).getBoundingClientRect()
          return rect.top - el.getBoundingClientRect().top + el.scrollTop
        })) as number
        expect(
          Math.abs(anchorY - first.docY),
          `${kind} ${start} ${key}: anchor stays`,
        ).toBeLessThanOrEqual(2.5 * first.lineHeight)
      }
      // Typing after a landing inserts once and leaves the Markdown otherwise exact.
      expect(await place(frame, 'mid-mid')).toBe(true)
      await frames(frame, 4)
      const before = (await frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue())) as string
      await input.key('Prior')
      await frames(frame, 4)
      await input.type('Z')
      await frames(frame, 6)
      const after = (await frame
        .locator('body')
        .evaluate(() => (window as any).vditor.getValue())) as string
      expect(after.replace('Z', ''), `${kind}: typing after PageUp`).toBe(
        before,
      )
      expect(after.match(/Z/g)?.length).toBe(1)
      expect(after).not.toContain(WORD_JOINER)
      expect(await docText(evaluate, file)).not.toContain(WORD_JOINER)
    }
  })
