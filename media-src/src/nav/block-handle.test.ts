// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { installBlockHandleLayer, resolveBlockHandleUnits } from './block-handle'

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
  expect(resolveBlockHandleUnits(root, markdown, 'stale rendered bytes')).toBeNull()
  root.querySelector('li')?.remove()
  expect(resolveBlockHandleUnits(root, markdown, markdown)).toBeNull()
})

it('does not offer a heading marker as a movable unit until section delegation exists', () => {
  document.body.innerHTML = '<pre class="vditor-reset"><h1 data-block="0">A</h1><p data-block="0">body</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const markdown = '# A\n\nbody\n'
  const units = resolveBlockHandleUnits(root, markdown, markdown)
  expect(units?.map((unit) => unit.movable)).toEqual([false, true])
})

it('places one external handle left of the fold gutter and routes its click menu by exact start', () => {
  document.body.innerHTML = '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const first = root.children[0] as HTMLElement
  const second = root.children[1] as HTMLElement
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)
  second.getBoundingClientRect = () => new DOMRect(100, 70, 300, 25)
  const actions: number[] = []
  const dispose = installBlockHandleLayer(
    () => root,
    {
      snapshot: () => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }),
      move: () => undefined,
      delete: (start) => { actions.push(start) },
      duplicate: () => undefined,
      turnInto: () => undefined,
    },
  )
  first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const handle = document.querySelector('.vmde-block-handle') as HTMLButtonElement
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
