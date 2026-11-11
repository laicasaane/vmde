// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { minimalDiffWriteback } from '../../../src/markdown/minimal-diff-writeback'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { createRealLute } from '../testing/real-lute'
import { installModelSync } from './model-structure'
import { createTextModel } from './text-model'
import { createUnitDom, type UnitDomControl } from './unit-dom'
import type { UnitLute } from './unit-lute'

// Task 733 / 004 round 2: where does the model's prediction differ from the bytes the host writes
// (`minimalDiffWriteback`, the host's whole-text path) on the synthetic table-heavy fixture? The
// host takes Lute's serialization of the front-matter block, which joins it to the next block with a
// single newline, while the model keeps the document's own blank line: the first publication of any
// edit differs at that junction, and only there. The later publications agree.
let lute: UnitLute
beforeAll(() => {
  installModelSync()
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

const attached: UnitDomControl[] = []
afterEach(() => {
  for (const dom of attached.splice(0)) dom.detach()
  document.body.replaceChildren()
})

const JUNCTION = '---\n\n# Overview'
const HOST_JUNCTION = '---\n# Overview'

const PLACES = [
  ['paragraph', ':scope > p', 2],
  ['table cell', ':scope > table td', 7],
  ['list item', ':scope > ul > li', 2],
] as const

describe('the model against the host write-back on tableHeavyMarkdown(1)', () => {
  for (const [name, selector, nth] of PLACES) {
    it(`typing in a ${name}: the first publication differs only at the front-matter junction`, () => {
      const fixture = tableHeavyMarkdown(1)
      const root = document.createElement('div')
      document.body.appendChild(root)
      root.innerHTML = lute.Md2VditorIRDOM(fixture)
      const dom = createUnitDom(root, lute)
      attached.push(dom)
      const model = createTextModel(dom, scanMovableBlocks)
      model.build(fixture)
      dom.attach(model)
      const reserialize = (block: string) =>
        lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(block))
      let host = fixture
      const differences: number[] = []
      for (const letter of ['a', 'b', 'c']) {
        const el = root.querySelectorAll<HTMLElement>(selector)[nth]
        model.prove(model.unitOf(el) as never)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        let last: Text | null = null
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          last = n as Text
        ;(last as Text).data += letter
        dom.drain()
        expect(model.sync(1).kind).toBe('changes')
        const written = minimalDiffWriteback(
          host,
          lute.VditorIRDOM2Md(root.innerHTML),
          reserialize,
        )
        if (model.text === written) differences.push(0)
        else {
          differences.push(1)
          // The whole difference is the blank line after the front matter.
          expect(model.text.replace(JUNCTION, HOST_JUNCTION)).toBe(written)
        }
        host = written
        model.rebind(host)
      }
      expect(differences).toEqual([1, 0, 0])
    })
  }
})
