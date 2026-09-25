// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import {
  clampTableColumnWidth,
  setSessionTableWidths,
  sessionTableWidths,
  tableResizeHandleLayout,
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

it('clips visible resize handles to the editor and nested horizontal scrollports', () => {
  const cell = { left: 20, right: 120, top: 20, bottom: 40 }
  expect(
    tableResizeHandleLayout(cell, {
      left: 0,
      right: 200,
      top: 0,
      bottom: 100,
    }),
  ).toEqual({ left: 116, top: 20, height: 20, visible: true })
  expect(
    tableResizeHandleLayout(cell, {
      left: 0,
      right: 100,
      top: 0,
      bottom: 100,
    }).visible,
  ).toBe(false)
  expect(
    tableResizeHandleLayout(
      { left: 20, right: 120, top: -5, bottom: 15 },
      { left: 0, right: 200, top: 0, bottom: 10 },
    ),
  ).toEqual({ left: 116, top: 0, height: 10, visible: true })
})
