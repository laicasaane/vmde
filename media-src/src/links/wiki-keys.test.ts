// @vitest-environment jsdom

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import {
  guardWikiLoadingRow,
  refreshWikiChips,
  rerunWikiLoadingHint,
  type WikiHintHost,
  wikiLoadingHintItem,
} from './wiki-keys'

function chipHtml(target: string, missing = false): string {
  const state = missing
    ? ` data-wiki-missing="1" title="Missing wiki page ${target}"`
    : ''
  return `<span class="wiki-link-chip" data-wiki-link="1" data-wiki-target="${target}" data-wiki-source="[[${target}]]"${state}>${target}</span>`
}

describe('refreshWikiChips', () => {
  it('flags missing pages and clears the flag on existing ones, attributes only', () => {
    document.body.innerHTML = `<div id="root">${chipHtml('Home', true)}${chipHtml('Other Page')}${chipHtml('Gone')}</div>`
    const root = document.getElementById('root') as HTMLElement
    const before = root.innerHTML.replace(
      / (data-wiki-missing|title)="[^"]*"/g,
      '',
    )
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver((records) => {
      mutations.push(...records)
    })
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    const changed = refreshWikiChips(root, new Set(['home', 'other-page']))

    observer.takeRecords()
    observer.disconnect()
    expect(changed).toBe(2)
    const [home, other, gone] = Array.from(
      root.querySelectorAll<HTMLElement>('.wiki-link-chip'),
    )
    expect(home?.hasAttribute('data-wiki-missing')).toBe(false)
    expect(home?.getAttribute('title')).toBe('Open wiki page Home')
    expect(other?.hasAttribute('data-wiki-missing')).toBe(false)
    expect(gone?.getAttribute('data-wiki-missing')).toBe('1')
    expect(gone?.getAttribute('title')).toBe('Missing wiki page Gone')
    expect(gone?.getAttribute('aria-label')).toBe('Missing wiki page Gone')
    expect(home?.getAttribute('aria-label')).toBe('Open wiki page Home')
    // No child/character mutation: the text and structure are untouched.
    expect(mutations).toEqual([])
    expect(root.textContent).toBe('HomeOther PageGone')
    expect(root.querySelectorAll('.wiki-link-chip')).toHaveLength(3)
    expect(before).toContain('data-wiki-target="Home"')
  })

  it('reports zero changes when every chip already matches', () => {
    document.body.innerHTML = `<div id="root">${chipHtml('Home')}</div>`
    const root = document.getElementById('root') as HTMLElement
    expect(refreshWikiChips(root, new Set(['home']))).toBe(0)
  })
})

describe('wikiLoadingHintItem', () => {
  it('wraps the escaped label in a marked span with an empty insert value', () => {
    expect(wikiLoadingHintItem('Loading <pages> & more…')).toEqual({
      html: '<span data-vmde-wiki-loading="1">Loading &lt;pages&gt; &amp; more…</span>',
      value: '',
    })
  })
})

type SelectFn = (event: KeyboardEvent, vditor: unknown) => boolean
type FillFn = (element: HTMLElement, vditor: unknown) => void
type GetKeyFn = (line: string, extend: unknown[]) => string | undefined
type GenFn = (data: unknown[], key: string, vditor: unknown) => void

interface FakeHint {
  timeId: number
  element: HTMLElement
  select: Mock<SelectFn>
  fillEmoji: Mock<FillFn>
  getKey: Mock<GetKeyFn>
  splitChar: string
  genHTML: Mock<GenFn>
}

function hintHost(rows: string): { host: WikiHintHost; hint: FakeHint } {
  const element = document.createElement('div')
  element.className = 'vditor-hint'
  element.style.display = 'block'
  element.innerHTML = rows
  document.body.append(element)
  const hint: FakeHint = {
    timeId: -1,
    element,
    select: vi.fn<SelectFn>(() => true),
    fillEmoji: vi.fn<FillFn>(),
    getKey: vi.fn<GetKeyFn>(),
    splitChar: '[[',
    genHTML: vi.fn<GenFn>(),
  }
  const surface = document.createElement('div')
  surface.textContent = 'see [[Ho'
  document.body.append(surface)
  const host: WikiHintHost = {
    hint: hint as unknown as WikiHintHost['hint'],
    currentMode: 'ir',
    ir: { element: surface },
    options: { hint: { extend: [] } },
  }
  return { host, hint }
}

const LOADING_ROW =
  '<button class="vditor-hint--current"> <span data-vmde-wiki-loading="1">Loading pages…</span></button>'
const PAGE_ROW = '<button class="vditor-hint--current"> Home</button>'

function key(name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
}

afterEach(() => {
  guardWikiLoadingRow(null)
  document.body.innerHTML = ''
})

describe('guardWikiLoadingRow', () => {
  it('lets Enter through (hint closed, key not consumed) while only the loading row is current', () => {
    const { host, hint } = hintHost(LOADING_ROW)
    const select = hint.select
    guardWikiLoadingRow(host)

    expect(hint.select(key('Enter'), {})).toBe(false)
    expect(hint.element.style.display).toBe('none')
    expect(select).not.toHaveBeenCalled()
  })

  it('delegates Enter to Vditor for a real page row and for modified Enter', () => {
    const real = hintHost(PAGE_ROW)
    const realSelect = real.hint.select
    guardWikiLoadingRow(real.host)
    expect(real.hint.select(key('Enter'), {})).toBe(true)
    expect(realSelect).toHaveBeenCalledTimes(1)
    expect(real.hint.element.style.display).toBe('block')

    const loading = hintHost(LOADING_ROW)
    const loadingSelect = loading.hint.select
    guardWikiLoadingRow(loading.host)
    expect(loading.hint.select(key('Enter', { shiftKey: true }), {})).toBe(true)
    expect(loadingSelect).toHaveBeenCalledTimes(1)
  })

  it('ignores a click on the loading row but fills a real row', () => {
    const { host, hint } = hintHost(LOADING_ROW + PAGE_ROW)
    const fill = hint.fillEmoji
    guardWikiLoadingRow(host)
    const [loadingButton, pageButton] = Array.from(
      hint.element.querySelectorAll('button'),
    )

    hint.fillEmoji(loadingButton as HTMLElement, {})
    expect(fill).not.toHaveBeenCalled()
    hint.fillEmoji(pageButton as HTMLElement, {})
    expect(fill).toHaveBeenCalledTimes(1)
  })

  it('closes the loading row on a bare Escape before later listeners see it', () => {
    const { host, hint } = hintHost(LOADING_ROW)
    guardWikiLoadingRow(host)
    const later = vi.fn()
    document.addEventListener('keydown', later, true)
    const event = key('Escape')

    document.body.dispatchEvent(event)

    expect(hint.element.style.display).toBe('none')
    expect(event.defaultPrevented).toBe(true)
    expect(later).not.toHaveBeenCalled()
    document.removeEventListener('keydown', later, true)
  })

  it('leaves Escape alone when the open hint is not the loading row', () => {
    const { host, hint } = hintHost(PAGE_ROW)
    guardWikiLoadingRow(host)
    const event = key('Escape')

    document.body.dispatchEvent(event)

    expect(hint.element.style.display).toBe('block')
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('rerunWikiLoadingHint', () => {
  function placeCaret(host: WikiHintHost): void {
    const surface = (host.ir as { element: HTMLElement }).element
    const text = surface.firstChild as Text
    const range = document.createRange()
    range.setStart(text, text.length)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  it('re-runs the hint synchronously with the current query', () => {
    const { host, hint } = hintHost(LOADING_ROW)
    const items = [{ html: 'Home', value: 'x' }]
    const hintFn = vi.fn(() => items)
    host.options = { hint: { extend: [{ key: '[[', hint: hintFn }] } }
    hint.getKey.mockReturnValue('Ho')
    placeCaret(host)

    rerunWikiLoadingHint(host)

    expect(hint.getKey).toHaveBeenCalledWith(
      'see [[Ho',
      host.options.hint?.extend,
    )
    expect(hintFn).toHaveBeenCalledWith('Ho')
    expect(hint.genHTML).toHaveBeenCalledWith(items, 'Ho', host)
  })

  it('does nothing when the hint is closed or shows real rows', () => {
    const closed = hintHost(LOADING_ROW)
    closed.hint.element.style.display = 'none'
    rerunWikiLoadingHint(closed.host)
    expect(closed.hint.genHTML).not.toHaveBeenCalled()

    const real = hintHost(PAGE_ROW)
    rerunWikiLoadingHint(real.host)
    expect(real.hint.genHTML).not.toHaveBeenCalled()
    expect(real.hint.element.style.display).toBe('block')
  })

  it('closes the stale loading row when the caret left the editor or the key is gone', () => {
    const outside = hintHost(LOADING_ROW)
    window.getSelection()?.removeAllRanges()
    rerunWikiLoadingHint(outside.host)
    expect(outside.hint.element.style.display).toBe('none')

    const noKey = hintHost(LOADING_ROW)
    noKey.hint.getKey.mockReturnValue(undefined)
    placeCaret(noKey.host)
    rerunWikiLoadingHint(noKey.host)
    expect(noKey.hint.element.style.display).toBe('none')
    expect(noKey.hint.genHTML).not.toHaveBeenCalled()
  })
})
