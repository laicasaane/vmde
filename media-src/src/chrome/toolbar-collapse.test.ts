// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAPSED_CLASS,
  COLLAPSE_STATE_KEY,
  installToolbarCollapse,
} from './toolbar-collapse'
import { chevronDownIcon, chevronUpIcon } from './toolbar-icons'

interface StubApi {
  getState: <T = unknown>() => T | undefined
  setState: <T>(state: T) => T
  current: () => unknown
}

function stubApi(initial?: unknown): StubApi {
  let state = initial
  return {
    getState: <T = unknown>() => state as T | undefined,
    setState: <T>(next: T) => {
      state = next
      return next
    },
    current: () => state,
  }
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

  it('persists the collapsed flag under the state key and keeps other keys', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi({ vmdeSectionHoist: { headingIndex: 3 }, other: 1 })
    installToolbarCollapse(toolbar, api)

    toggle.click()
    expect(api.current()).toEqual({
      vmdeSectionHoist: { headingIndex: 3 },
      other: 1,
      [COLLAPSE_STATE_KEY]: true,
    })

    toggle.click()
    expect(api.current()).toEqual({
      vmdeSectionHoist: { headingIndex: 3 },
      other: 1,
      [COLLAPSE_STATE_KEY]: false,
    })
  })

  it('writes state when none exists yet', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi(undefined)
    installToolbarCollapse(toolbar, api)

    toggle.click()

    expect(api.current()).toEqual({ [COLLAPSE_STATE_KEY]: true })
  })

  it('applies a stored collapsed state at install without writing state', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi({ [COLLAPSE_STATE_KEY]: true, other: 1 })
    const setState = vi.spyOn(api, 'setState')

    installToolbarCollapse(toolbar, api)

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toBe('Expand toolbar')
    expect(shownPath(toggle)).toBe(pathData(chevronDownIcon))
    expect(setState).not.toHaveBeenCalled()
  })

  it.each([
    ['absent state', undefined],
    ['null state', null],
    ['a non-object state', 'collapsed'],
    ['a non-boolean flag', { [COLLAPSE_STATE_KEY]: 'yes' }],
    ['a numeric flag', { [COLLAPSE_STATE_KEY]: 1 }],
  ])('opens expanded for %s', (_name, state) => {
    const { toolbar, toggle } = buildToolbar()
    installToolbarCollapse(toolbar, stubApi(state))

    expect(toolbar.classList.contains(COLLAPSED_CLASS)).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('does not throw and keeps working when the stored state is a non-object', () => {
    const { toolbar, toggle } = buildToolbar()
    const api = stubApi('garbage')
    installToolbarCollapse(toolbar, api)

    toggle.click()

    expect(api.current()).toEqual({ [COLLAPSE_STATE_KEY]: true })
  })

  it('does nothing when the toolbar has no toggle (toolbar off)', () => {
    const { toolbar } = buildToolbar(false)
    const api = stubApi({ [COLLAPSE_STATE_KEY]: true })
    const dispose = installToolbarCollapse(toolbar, api)

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
    expect(api.current()).toBeUndefined()
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
