// Task 722: a list item's fold triangle must line up with the item's own marker (bullet, ordered
// number, or task checkbox). Task 569 placed the painted triangle beneath the marker and centred it
// horizontally from a CSS model of Chromium's outside marker; this spec measures the PAINTED ink of
// both in the real VS Code webview, so a model that drifts from the actual paint fails here.
//
// Method: screenshot the gutter strip left of each foldable item twice, once as rendered and once
// with only the triangle hidden. The second shot holds only the marker ink; the pixels that differ
// between the two shots are the triangle ink. Ink bounding boxes give the painted centres.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import { expect, test } from 'vscode-test-playwright'
import {
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
} from './webview-helpers'

const WRAP_TEXT = `wrap parent ${'long words keep this first item wrapping onto more lines '.repeat(8)}end`

const CONTENT = [
  '# Lists',
  '',
  // Filler keeps the first list below the pinned toolbar when it is scrolled to the centre.
  ...Array.from({ length: 12 }, (_, index) => [
    `Filler paragraph ${index + 1}.`,
    '',
  ]).flat(),
  '- bullet top',
  '  - bullet level two',
  '    - bullet level three',
  '      - bullet leaf',
  `- ${WRAP_TEXT}`,
  '  - wrap child',
  '',
  'Ordered list:',
  '',
  '1. ordered top',
  '   1. ordered level two',
  '      1. ordered level three',
  '         1. ordered leaf',
  '',
  'Task list:',
  '',
  '- [ ] task top',
  '  - [ ] task level two',
  '    - [ ] task level three',
  '      - [ ] task leaf',
  '',
].join('\n')

const ITEMS = [
  'bullet top',
  'bullet level two',
  'bullet level three',
  'wrap parent',
  'ordered top',
  'ordered level two',
  'ordered level three',
  'task top',
  'task level two',
  'task level three',
] as const

type Mode = 'ir' | 'wysiwyg'

interface InkBox {
  left: number
  top: number
  right: number
  bottom: number
  cx: number
  cy: number
}

interface ItemGeometry {
  left: number
  top: number
  fontSize: string
  lineHeight: string
  markerLineHeight: string
  glyph: { left: number; top: number; width: number; height: number }
  glyphContent: string
  textLine: { top: number; bottom: number } | null
  checkbox: { left: number; top: number; right: number; bottom: number } | null
}

function frameFor(workbox: import('@playwright/test').Page) {
  return workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')
}

type VmdeFrame = ReturnType<typeof frameFor>

// The deepest foldable item containing `needle`: `hasText` also matches every ancestor, and a
// descendant follows its ancestors in document order.
function itemLocator(frame: VmdeFrame, mode: Mode, needle: string) {
  return frame
    .locator(`.vditor-${mode} li[data-vmde-list-foldable]`)
    .filter({ hasText: needle })
    .last()
}

function readGeometry(item: import('@playwright/test').Locator) {
  return item.evaluate((element): ItemGeometry => {
    const px = (value: string) => Number.parseFloat(value)
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const glyph = getComputedStyle(element, '::before')
    const checkbox = Array.from(
      element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) => input.closest('li') === element)
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue?.trim() &&
        node.parentElement?.closest('li') === element &&
        !node.parentElement?.closest(
          '[data-type="task-marker"], .vditor-ir__marker',
        )
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    })
    const text = walker.nextNode() as Text | null
    let textLine: ItemGeometry['textLine'] = null
    if (text) {
      const first = text.nodeValue!.search(/\S/)
      const range = document.createRange()
      range.setStart(text, first)
      range.setEnd(text, first + 1)
      const box = range.getBoundingClientRect()
      textLine = { top: box.top, bottom: box.bottom }
    }
    const box = checkbox?.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      markerLineHeight: getComputedStyle(element, '::marker').lineHeight,
      glyph: {
        left: rect.left + px(glyph.left),
        top: rect.top + px(glyph.top),
        width: px(glyph.width),
        height: px(glyph.height),
      },
      glyphContent: glyph.content,
      textLine,
      checkbox: box
        ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom }
        : null,
    }
  })
}

function pixelDiff(a: PNG, b: PNG | null, index: number, bg: number[]) {
  const offset = index * 4
  const ref = b ? [b.data[offset], b.data[offset + 1], b.data[offset + 2]] : bg
  return Math.max(
    Math.abs(a.data[offset] - ref[0]),
    Math.abs(a.data[offset + 1] - ref[1]),
    Math.abs(a.data[offset + 2] - ref[2]),
  )
}

function dominantColor(png: PNG): number[] {
  const counts = new Map<number, number>()
  for (let i = 0; i < png.width * png.height; i++) {
    const o = i * 4
    const key = (png.data[o] << 16) | (png.data[o + 1] << 8) | png.data[o + 2]
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const [key] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255]
}

// Bounding box of the pixels that differ from the reference (another shot, or the background
// colour) by at least 35% of the strongest difference, in CSS pixels of the clip.
function inkBox(png: PNG, ref: PNG | null, scale: number): InkBox | null {
  const bg = dominantColor(ref ?? png)
  const diffs: number[] = []
  let max = 0
  for (let i = 0; i < png.width * png.height; i++) {
    const d = pixelDiff(png, ref, i, bg)
    diffs.push(d)
    if (d > max) max = d
  }
  if (max < 24) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  diffs.forEach((d, i) => {
    if (d < max * 0.35) return
    const x = i % png.width
    const y = Math.floor(i / png.width)
    left = Math.min(left, x)
    right = Math.max(right, x + 1)
    top = Math.min(top, y)
    bottom = Math.max(bottom, y + 1)
  })
  return {
    left: left / scale,
    top: top / scale,
    right: right / scale,
    bottom: bottom / scale,
    cx: (left + right) / 2 / scale,
    cy: (top + bottom) / 2 / scale,
  }
}

const shift = (box: InkBox, x: number, y: number): InkBox => ({
  left: box.left + x,
  top: box.top + y,
  right: box.right + x,
  bottom: box.bottom + y,
  cx: box.cx + x,
  cy: box.cy + y,
})

async function measureItem(
  workbox: import('@playwright/test').Page,
  frame: VmdeFrame,
  mode: Mode,
  needle: string,
) {
  const item = itemLocator(frame, mode, needle)
  await item.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  // The glyph variables are written on an idle frame once the item is near the viewport.
  await expect
    .poll(() =>
      item.evaluate((element) =>
        element.style.getPropertyValue('--vmde-list-fold-arrow-top'),
      ),
    )
    .not.toBe('')
  await workbox.mouse.move(1, 1)
  const geometry = await readGeometry(item)
  const outer = await item.boundingBox()
  if (!outer) throw new Error(`${needle}: no bounding box`)
  const dx = outer.x - geometry.left
  const dy = outer.y - geometry.top
  // Stop short of the item's content edge, where a caret or selection can paint.
  const right = geometry.checkbox
    ? geometry.checkbox.right + 1
    : geometry.left - 2
  const bottom = geometry.glyph.top + geometry.glyph.height + 4
  const clipLeft = geometry.left - 56
  const clip = {
    x: dx + clipLeft,
    y: dy + geometry.top,
    width: right - clipLeft,
    height: bottom - geometry.top,
  }
  const scale = await workbox.evaluate(() => window.devicePixelRatio)
  const shot = async () =>
    PNG.sync.read(
      await workbox.screenshot({ clip, animations: 'disabled', caret: 'hide' }),
    )
  // Hide every fold glyph except this item's (parents' triangles and heading arrows reach into
  // this strip), then hide this one too: the first shot minus the second is this item's triangle.
  const hide = (all: boolean) =>
    item.evaluate((element, hideAll) => {
      document.getElementById('task-722-hide-glyph')?.remove()
      element.toggleAttribute('data-task-722-probe', !hideAll)
      const style = document.createElement('style')
      style.id = 'task-722-hide-glyph'
      style.textContent = `li[data-vmde-list-foldable]:not([data-task-722-probe])::before,
        [data-vmde-foldable]::after, [data-vmde-foldable]::before, .vmde-block-layer
        { visibility: hidden !important; }`
      document.head.append(style)
    }, all)
  await hide(false)
  const full = await shot()
  await hide(true)
  const markerOnly = await shot()
  await item.evaluate((element) => {
    document.getElementById('task-722-hide-glyph')?.remove()
    element.removeAttribute('data-task-722-probe')
  })
  const marker = inkBox(markerOnly, null, scale)
  const arrow = inkBox(full, markerOnly, scale)
  if (!marker || !arrow) throw new Error(`${needle}: no ink found`)
  return {
    geometry,
    marker: shift(marker, clipLeft, geometry.top),
    arrow: shift(arrow, clipLeft, geometry.top),
  }
}

async function switchMode(frame: VmdeFrame, mode: Mode) {
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(frame, (state) => state.mode === mode, {
    message: `switch to ${mode}`,
  })
  // Close the mode menu and drop toolbar focus so neither paints over the gutter.
  await frame.locator('body').press('Escape')
  await frame
    .locator('body')
    .evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

async function setVmdeConfig(
  evaluateInVSCode: (fn: unknown, args: string[]) => Promise<unknown>,
  key: string,
  value: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === '<default>' ? undefined : args[1],
          vscode.ConfigurationTarget.Global,
        )
    },
    [key, value],
  )
}

const THEMES = ['auto', 'github-light', 'material-dark', 'vscode-dark-2026']
const FONT_SIZES = ['<default>', '20']

for (const theme of THEMES) {
  test(`list fold triangle lines up with its marker (${theme})`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const docPath = path.join(baseDir, 'list-fold-alignment.md')
    writeFileSync(docPath, CONTENT)
    const rows: Record<string, unknown>[] = []
    try {
      await setVmdeConfig(evaluateInVSCode, 'theme.content', theme)
      await setVmdeConfig(evaluateInVSCode, 'editor.defaultMode', 'ir')
      for (const fontSize of FONT_SIZES) {
        await setVmdeConfig(evaluateInVSCode, 'editor.fontSize', fontSize)
        await evaluateInVSCode(
          async (vscode: typeof import('vscode'), args: string[]) => {
            await vscode.commands.executeCommand(
              'workbench.action.closeAllEditors',
            )
            await vscode.extensions.getExtension(args[1])?.activate()
            await vscode.commands.executeCommand(
              'vscode.openWith',
              vscode.Uri.file(args[0]),
              args[2],
            )
          },
          [docPath, ExtensionId, MarkdownEditorViewType],
        )
        const frame = frameFor(workbox)
        await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
        await waitForE2EReadiness(
          frame,
          (state) => state.routerReady && state.mode === 'ir',
          { message: 'list-fold-alignment readiness' },
        )
        await frame.locator('body').evaluate(() => document.fonts.ready)
        for (const mode of ['ir', 'wysiwyg'] as const) {
          if (mode === 'wysiwyg') await switchMode(frame, mode)
          for (const needle of ITEMS) {
            const m = await measureItem(workbox, frame, mode, needle)
            const row = {
              theme,
              fontSize,
              mode,
              item: needle,
              computedFont: m.geometry.fontSize,
              lineHeight: m.geometry.lineHeight,
              marker: m.marker,
              arrow: m.arrow,
              textLine: m.geometry.textLine,
              checkbox: m.geometry.checkbox,
              glyphBox: m.geometry.glyph,
              itemLeft: m.geometry.left,
              itemTop: m.geometry.top,
              dxCenter: m.arrow.cx - m.marker.cx,
              dyCenter: m.arrow.cy - m.marker.cy,
              gap: m.arrow.top - m.marker.bottom,
            }
            rows.push(row)
            console.log(`TASK722 ${JSON.stringify(row)}`)
          }
        }
      }
    } finally {
      await setVmdeConfig(evaluateInVSCode, 'theme.content', '<default>')
      await setVmdeConfig(evaluateInVSCode, 'editor.fontSize', '<default>')
      await setVmdeConfig(evaluateInVSCode, 'editor.defaultMode', '<default>')
    }
    expect(rows.length).toBe(FONT_SIZES.length * 2 * ITEMS.length)
    // Task 569 contract: the painted triangle sits beneath its marker, centred on it.
    const offCentre = rows
      .filter((row) => Math.abs(row.dxCenter as number) > 1)
      .map(
        (row) =>
          `${row.fontSize} ${row.mode} ${row.item}: dx ${(row.dxCenter as number).toFixed(1)}`,
      )
    expect(offCentre).toEqual([])
  })
}
