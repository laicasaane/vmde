// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  boundedPanelPosition,
  installToolbarMenuPosition,
} from './toolbar-menu-position'

describe('boundedPanelPosition', () => {
  it('opens a flyout left of an edge trigger and keeps it inside a short viewport', () => {
    expect(
      boundedPanelPosition(
        { left: 340, top: 160, right: 370, bottom: 190 },
        { width: 180, height: 180 },
        { width: 400, height: 220 },
        true,
      ),
    ).toEqual({ left: 160, top: 36, maxWidth: 392, maxHeight: 212 })
  })
})

describe('installToolbarMenuPosition', () => {
  it('restores helper-owned fixed geometry when disposed', () => {
    const toolbar = document.createElement('div')
    const item = document.createElement('div')
    item.className = 'vditor-toolbar__item'
    const button = document.createElement('button')
    button.dataset.type = 'emoji'
    const panel = document.createElement('div')
    panel.className = 'vditor-panel'
    panel.style.display = 'block'
    item.append(button, panel)
    toolbar.append(item)
    document.body.append(toolbar)
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => ({ left: 20, top: 10, right: 45, bottom: 35 }),
    })
    Object.defineProperty(panel, 'getBoundingClientRect', {
      value: () => ({ width: 160, height: 80 }),
    })

    const dispose = installToolbarMenuPosition(toolbar)
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(panel.style.position).toBe('fixed')

    dispose()
    expect(panel.style.position).toBe('')
    expect(panel.style.display).toBe('block')
    toolbar.remove()
  })
})
