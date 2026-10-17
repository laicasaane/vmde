// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAPSED_CLASS,
  installToolbarCollapse,
  receiveToolbarCollapsed,
  sharedToolbarCollapsed,
} from './toolbar-collapse'
import type { WebviewMessage } from '../../../src/shared/protocol'
import { chevronDownIcon, chevronUpIcon } from './toolbar-icons'

// Follow-up F2 (Owner, 2026-10-15): the collapsed state is one user-level value owned by the host
// and shared by every editor and file. The webview posts each toggle and applies what the host sends.
function stubApi() {
  return { postMessage: vi.fn<(message: WebviewMessage) => void>() }
}

// innerHTML re-serializes the SVG, so compare the drawn path instead of the raw string.
const pathData = (svg: string) => /\sd="([^"]+)"/.exec(svg)?.[1]
const shownPath = (button: HTMLElement) =>
  button.querySelector('svg path')?.getAttribute('d')

function buildToolbar(withToggle = true): {
  toolbar: HTMLElement
  toggle: HTMLButtonElement
} {
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  const row = document.createElement('div')
  row.className = 'vmde-toolbar-row'
  row.dataset.vmdeToolbarRow = '1'
  const bold = document.createElement('div')
  bold.className = 'vditor-toolbar__item'
  bold.innerHTML = '<button data-type="bold"></button>'
  row.append(bold)
  const wrapper = document.createElement('div')
  wrapper.className = 'vditor-toolbar__item'
  const toggle = document.createElement('button')
  toggle.dataset.type = 'collapse-toolbar'
  wrapper.append(toggle)
  if (withToggle) row.append(wrapper)
  toolbar.append(row)
  document.body.append(toolbar)
  return { toolbar, toggle }
}

afterEach(() => {
  document.body.replaceChildren()
  receiveToolbarCollapsed(false)
})

describe('installToolbarCollapse', () => {
  it('uses distinct chevron paths for the two states', () => {
    expect(pathData(chevronUpIcon)).toBeTruthy()
    expect(pathData(chevronDownIcon)).toBeTruthy()
    expect(pathData(chevronUpIcon)).not.toBe(pathData(chevronDownIcon))
  })

  it('starts expanded: label, aria-expanded and chevron-up icon', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse toolbar')
    expect(shownPath(toggle)).toBe(pathData(chevronUpIcon))
  })

  it('collapses on click: class, aria-expanded, label and chevron-down icon', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())

    toggle.click()

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Expand toolbar')
    expect(shownPath(toggle)).toBe(pathData(chevronDownIcon))
  })

  it('expands again on a second click and restores label and icon', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())

    toggle.click()
    toggle.click()

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse toolbar')
    expect(shownPath(toggle)).toBe(pathData(chevronUpIcon))
  })

  // Task 642 (A10): the toggle's tooltip is a description that follows the state, opens towards
  // the left edge and never names a key.
  it('describes the toggle for each state without a key and opens its tip to the left', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())

    expect(toggle.getAttribute('data-vmde-tip')).toBe(
      'Collapse the toolbar to one row of small buttons',
    )
    expect(toggle.getAttribute('aria-description')).toBe(
      'Collapse the toolbar to one row of small buttons',
    )
    toggle.click()
    expect(toggle.getAttribute('data-vmde-tip')).toBe(
      'Expand the toolbar to full-size buttons',
    )
    expect(toggle.getAttribute('aria-label')).toBe('Expand toolbar')
    expect(toggle.classList.contains('vditor-tooltipped__sw')).toBe(true)
    expect(toggle.getAttribute('data-vmde-tip')).not.toMatch(/Ctrl|Cmd|\+/)
  })

  it('prevents the default of mousedown so editor focus and selection survive', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())

    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    toggle.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('posts every toggle to the host so it can store and share the value (F2: remembered across sessions)', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi()
    installToolbarCollapse(toolbar, api)

    toggle.click()
    expect(api.postMessage).toHaveBeenLastCalledWith({
      command: 'save-toolbar-collapsed',
      collapsed: true,
    })

    toggle.click()
    expect(api.postMessage).toHaveBeenLastCalledWith({
      command: 'save-toolbar-collapsed',
      collapsed: false,
    })
    expect(api.postMessage).toHaveBeenCalledTimes(2)
  })

  it('applies the host value at install without posting anything (F2: initial state, no expanded flash)', () => {
    receiveToolbarCollapsed(true)
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi()

    installToolbarCollapse(toolbar, api)

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Expand toolbar')
    expect(shownPath(toggle)).toBe(pathData(chevronDownIcon))
    expect(api.postMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'yes'],
    ['a number', 1],
  ])(
    'treats %s host value as expanded (F2: invalid value opens expanded)',
    (_name, value) => {
      receiveToolbarCollapsed(true)
      receiveToolbarCollapsed(value)
      const { toolbar, toggle } = buildToolbar()
      installToolbarCollapse(toolbar, stubApi())

      expect(sharedToolbarCollapsed()).toBe(false)
      expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    },
  )

  it('a later editor or file opens in the state the last toggle left (F2: all files share one state)', () => {
    const first = buildToolbar()
    const disposeFirst = installToolbarCollapse(first.toolbar, stubApi())
    first.toggle.click()
    disposeFirst()
    document.body.replaceChildren()

    const second = buildToolbar()
    installToolbarCollapse(second.toolbar, stubApi())
    expect(second.toolbar.classList.contains(COLLAPSED_CLASS)).toBe(true)

    second.toggle.click()
    document.body.replaceChildren()
    const third = buildToolbar()
    installToolbarCollapse(third.toolbar, stubApi())
    expect(third.toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
  })

  it('follows a host state message live in both directions and posts nothing back (F2: other editors follow)', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi()
    installToolbarCollapse(toolbar, api)

    receiveToolbarCollapsed(true)
    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(shownPath(toggle)).toBe(pathData(chevronDownIcon))

    receiveToolbarCollapsed(false)
    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(shownPath(toggle)).toBe(pathData(chevronUpIcon))
    expect(api.postMessage).not.toHaveBeenCalled()
  })

  it('a host state message keeps editor focus and selection and fires no document event (631 acceptance 3)', () => {
    const { toolbar } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    editor.tabIndex = 0
    editor.textContent = 'hello world'
    document.body.append(editor)
    editor.focus()
    const range = document.createRange()
    range.setStart(editor.firstChild as Text, 1)
    range.setEnd(editor.firstChild as Text, 4)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    const seen: string[] = []
    for (const type of ['input', 'change', 'beforeinput'])
      document.addEventListener(type, () => seen.push(type))

    receiveToolbarCollapsed(true)
    receiveToolbarCollapsed(false)

    expect(document.activeElement).toBe(editor)
    expect(getSelection()?.toString()).toBe('ell')
    expect(editor.textContent).toBe('hello world')
    expect(seen).toEqual([])
  })

  it('a host collapse closes open panels and moves focus off a row-two control to the toggle', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())
    const panel = document.createElement('div')
    panel.className = 'vditor-panel'
    panel.style.display = 'block'
    toolbar.append(panel)
    // Task 642: only row two leaves the layout when collapsed.
    const rowTwo = document.createElement('div')
    rowTwo.className = 'vmde-toolbar-row'
    rowTwo.dataset.vmdeToolbarRow = '2'
    rowTwo.innerHTML =
      '<div class="vditor-toolbar__item"><button data-type="table"></button></div>'
    toolbar.append(rowTwo)
    const table = toolbar.querySelector<HTMLElement>('[data-type="table"]')
    table?.focus()
    expect(document.activeElement).toBe(table)

    receiveToolbarCollapsed(true)

    expect(panel.style.display).toBe('none')
    expect(document.activeElement).toBe(toggle)
  })

  it('a host collapse leaves focus on a row-one control, which stays in the collapsed row (642)', () => {
    const { toolbar } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())
    const bold = toolbar.querySelector<HTMLElement>('[data-type="bold"]')
    bold?.focus()

    receiveToolbarCollapsed(true)

    expect(document.activeElement).toBe(bold)
  })

  it('a repeated host state is a no-op (does not close panels again)', () => {
    const { toolbar } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())
    receiveToolbarCollapsed(true)
    const panel = document.createElement('div')
    panel.className = 'vditor-panel'
    panel.style.display = 'block'
    toolbar.append(panel)

    receiveToolbarCollapsed(true)

    expect(panel.style.display).toBe('block')
  })

  it('stops following the host after dispose', () => {
    const { toolbar } = buildToolbar()
    const dispose = installToolbarCollapse(toolbar, stubApi())
    dispose()

    receiveToolbarCollapsed(true)

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(sharedToolbarCollapsed()).toBe(true)
  })

  it('does nothing when the toolbar has no toggle (toolbar off)', () => {
    const { toolbar } = buildToolbar(false)
    receiveToolbarCollapsed(true)
    const dispose = installToolbarCollapse(toolbar, stubApi())

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(() => dispose()).not.toThrow()
  })

  it('does nothing for an empty toolbar shell', () => {
    const toolbar = document.createElement('div')
    toolbar.className = 'vditor-toolbar'
    document.body.append(toolbar)

    const dispose = installToolbarCollapse(toolbar, stubApi())

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(() => dispose()).not.toThrow()
  })

  it('disposer unbinds the click and mousedown handlers', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi()
    const dispose = installToolbarCollapse(toolbar, api)

    dispose()
    toggle.click()
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    toggle.dispatchEvent(event)

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(api.postMessage).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not touch the document: no input or change event fires on collapse', () => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi())
    const seen: string[] = []
    for (const type of ['input', 'change', 'beforeinput'])
      document.addEventListener(type, () => seen.push(type))

    toggle.click()

    expect(seen).toEqual([])
  })
})
