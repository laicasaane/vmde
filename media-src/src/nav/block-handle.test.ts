// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import {
  installBlockHandleLayer,
  resolveBlockHandleUnits,
} from './block-handle'

afterEach(() => document.body.replaceChildren())

it('maps simple rendered block order to exact source starts only when count and kind agree', () => {
  document.body.innerHTML = `<pre class="vditor-reset">
    <p data-block="0">before</p>
    <div data-block="0" data-type="code-block"><pre>code</pre></div>
    <p data-block="0">after</p>
  </pre>`
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const markdown = 'before\n\n```ts\ncode\n```\n\nafter\n'
  const units = resolveBlockHandleUnits(root, markdown, markdown)
  expect(units?.map((unit) => [unit.kind, unit.start])).toEqual([
    ['paragraph', 0],
    ['fence', markdown.indexOf('```ts')],
    ['paragraph', markdown.indexOf('after')],
  ])
})

it('uses direct list item nodes and refuses a stale or mismatched render', () => {
  document.body.innerHTML = `<pre class="vditor-reset"><ul data-block="0"><li>one<ul><li>child</li></ul></li><li>two</li></ul></pre>`
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const markdown = '- one\n  - child\n- two\n'
  const units = resolveBlockHandleUnits(root, markdown, markdown)
  expect(units?.map((unit) => unit.element.tagName)).toEqual(['LI', 'LI'])
  expect(
    resolveBlockHandleUnits(root, markdown, 'stale rendered bytes'),
  ).toBeNull()
  root.querySelector('li')?.remove()
  expect(resolveBlockHandleUnits(root, markdown, markdown)).toBeNull()
})

it('offers headings for whole-section moves while retaining body as a separate target', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><h1 data-block="0">A</h1><p data-block="0">body</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const markdown = '# A\n\nbody\n'
  const units = resolveBlockHandleUnits(root, markdown, markdown)
  expect(units?.map((unit) => unit.movable)).toEqual([true, true])
})

it('places one external handle left of the fold gutter and routes its click menu by exact start', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const first = root.children[0] as HTMLElement
  const second = root.children[1] as HTMLElement
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)
  second.getBoundingClientRect = () => new DOMRect(100, 70, 300, 25)
  const actions: number[] = []
  const dispose = installBlockHandleLayer(() => root, {
    snapshot: () => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }),
    move: () => undefined,
    delete: (start) => {
      actions.push(start)
    },
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const handle = document.querySelector(
    '.vmde-block-handle',
  ) as HTMLButtonElement
  expect(handle).toBeTruthy()
  expect(Number.parseFloat(handle.style.left)).toBeLessThan(62)
  expect(handle.getAttribute('aria-label')).toContain('Block')
  handle.click()
  const menu = document.querySelector('.vmde-block-handle-menu') as HTMLElement
  expect(menu).toBeTruthy()
  ;(menu.querySelector('[data-action="delete"]') as HTMLButtonElement).click()
  expect(actions).toEqual([0])
  expect(root.querySelector('.vmde-block-handle')).toBeNull()
  dispose()
  expect(document.querySelector('.vmde-block-handle')).toBeNull()
})

it('keeps an open menu through ordinary editor attribute changes and clears a rebuilt target', async () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const first = root.children[0] as HTMLElement
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot: () => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }),
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const handle = document.querySelector(
    '.vmde-block-handle',
  ) as HTMLButtonElement
  const menu = document.querySelector('.vmde-block-handle-menu') as HTMLElement
  handle.click()
  expect(menu.hidden).toBe(false)
  first.classList.add('vditor-current')
  await Promise.resolve()
  expect(menu.hidden).toBe(false)
  first.remove()
  await Promise.resolve()
  expect(menu.hidden).toBe(true)
  expect(handle.hidden).toBe(true)
  dispose()
})

it('invalidates a cached proof after in-place live text changes even with stable element identities', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const proof = {
    owner: {},
    mode: 'ir' as const,
    render: () => '',
    serialize: (html: string) => {
      const detached = document.createElement('div')
      detached.innerHTML = html
      return `${Array.from(detached.querySelectorAll('p'))
        .map((p) => p.textContent)
        .join('\n\n')}\n`
    },
  }
  const before = 'A\n\nB\n'
  expect(resolveBlockHandleUnits(root, before, before, proof)).toHaveLength(2)
  root.querySelector('p')!.firstChild!.textContent = 'changed'
  expect(resolveBlockHandleUnits(root, before, before, proof)).toBeNull()
})

it('declines filled trailing nodes and protected raw-HTML ownership', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0" data-vmde-trailing="">payload</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  expect(resolveBlockHandleUnits(root, 'A\n', 'A\n')).toBeNull()
  root.innerHTML = '<p data-block="0">A</p><div data-block="0">raw</div>'
  expect(
    resolveBlockHandleUnits(
      root,
      'A\n\n<div>raw</div>\n',
      'A\n\n<div>raw</div>\n',
    ),
  ).toBeNull()
})

it('pairs exact source offsets with a verified canonical render and rejects a changed live block', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">one!</p><p data-block="0">two</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const exact = 'one\n\ntwo\n'
  const rendered = 'one!\n\ntwo\n'
  const proof = {
    owner: {},
    mode: 'ir' as const,
    render: (source: string) =>
      source.includes('one') && source.includes('two')
        ? '<p data-block="0">one!</p><p data-block="0">two</p>'
        : source.includes('one')
          ? '<p data-block="0">one!</p>'
          : '<p data-block="0">two</p>',
    serialize: (html: string) => {
      const detached = document.createElement('div')
      detached.innerHTML = html
      return `${Array.from(detached.querySelectorAll('p'))
        .map((p) => p.textContent)
        .join('\n\n')}\n`
    },
  }
  expect(
    resolveBlockHandleUnits(root, exact, rendered, proof)?.map(
      (unit) => unit.start,
    ),
  ).toEqual([0, 5])
  ;(root.children[1] as HTMLElement).textContent = 'changed'
  expect(resolveBlockHandleUnits(root, exact, rendered, proof)).toBeNull()
})
