// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import {
  clampTableColumnWidth,
  setSessionTableWidths,
  sessionTableWidths,
} from './table-resize'
import { fixResponsiveTables } from './responsive-tables'

afterEach(() => document.body.replaceChildren())

it('clamps a dragged column to a usable width', () => {
  expect(clampTableColumnWidth(12)).toBe(48)
  expect(clampTableColumnWidth(125)).toBe(125)
})

it('keeps only session-owned col widths through responsive normalization', async () => {
  document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">
    <table id="resized"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>
    <table id="ordinary"><colgroup><col style="width:300px"></colgroup><thead><tr><th>C</th></tr></thead></table>
  </pre></div>`
  const resized = document.getElementById('resized') as HTMLTableElement
  const ordinary = document.getElementById('ordinary') as HTMLTableElement
  setSessionTableWidths(resized, [120, 80])
  fixResponsiveTables()
  await new Promise((resolve) => setTimeout(resolve, 40))
  window.dispatchEvent(new Event('resize'))
  await new Promise((resolve) => setTimeout(resolve, 40))

  expect(sessionTableWidths(resized)).toEqual([120, 80])
  expect(resized.querySelector('colgroup')).toBeNull()
  expect(document.head.textContent).toContain('width: 120px !important')
  expect(document.head.textContent).toContain('width: 80px !important')
  expect(ordinary.querySelector('col')?.style.width).toBe('')
})
