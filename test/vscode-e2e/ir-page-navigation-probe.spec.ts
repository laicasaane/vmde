import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docFor,
  FONTS,
  frames,
  type HostEvaluator,
  measure,
  openIr,
  place,
} from './helpers/ir-page-navigation'

// @probe — Task 612 P2-1: non-asserting measurement of OS PageUp/PageDown travel near hidden IR
// markers (excluded from the default run; run with VMDE_PROBES=1 and VMDE_XTEST=1). Rows go to
// $VMDE_PROBE_OUT (default tmp/612/p2-1/vscode-rows.jsonl).

const OUT =
  process.env.VMDE_PROBE_OUT ??
  path.resolve(__dirname, '../../tmp/612/p2-1/vscode-rows.jsonl')

test('@probe OS PageUp/PageDown travel near hidden IR markers', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1' || !process.env.VMDE_PROBES,
    'Requires isolated Xvfb + Openbox, VMDE_XTEST=1 and VMDE_PROBES=1',
  )
  test.setTimeout(3_000_000)
  const evaluate = evaluateInVSCode as HostEvaluator
  mkdirSync(path.dirname(OUT), { recursive: true })
  const press = 3
  for (const font of Object.keys(FONTS))
    for (const kind of ['code', 'link', 'strong', 'plain', 'mixed', 'wcode']) {
      const file = path.join(baseDir, `task612-${kind}-${font}.md`)
      writeFileSync(file, docFor(kind))
      const frame = await openIr(evaluate, workbox, file, font)
      const input = await createXtestInput(electronApp, workbox as Page)
      const cases: [string, string][] = [
        ['anchor-end', 'Prior'],
        ['mid-mid', 'Prior'],
        ['mid-end', 'Prior'],
        ['anchor-top-end', 'Next'],
        ['mid-mid', 'Next'],
        ['anchor-end', 'shift+Prior'],
        ['mid-mid', 'shift+Prior'],
      ]
      for (const [start, key] of cases) {
        expect(await place(frame, start)).toBe(true)
        await frames(frame, 4)
        let prev = (await measure(frame))?.docY as number
        const row = (p: number, m: unknown, k: string) =>
          appendFileSync(
            OUT,
            `${JSON.stringify({ group: 'vscode', kind, font, start, key: k, press: p, m, prevDocY: prev })}\n`,
          )
        row(0, await measure(frame), 'start')
        for (let p = 1; p <= press; p++) {
          await input.key(key)
          await frames(frame, 4)
          const m = (await measure(frame)) as { docY: number } | null
          row(p, m, key)
          prev = m?.docY ?? Number.NaN
        }
      }
    }
})
