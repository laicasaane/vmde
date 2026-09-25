// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  currentBlockProjection,
  installBlockHandleLayer,
  resolveBlockHandleUnits,
} from './block-handle'

afterEach(() => document.body.replaceChildren())
const stableSnapshotRevision = {}

function installFakeBlockProjection(root: HTMLElement): () => void {
  const previous = (window as any).vditor
  const serialize = (html: string): string => {
    const detached = document.createElement('div')
    detached.innerHTML = html
    return `${Array.from(detached.children)
      .map((child) => child.textContent ?? '')
      .join('\n\n')}\n`
  }
  const render = (markdown: string): string =>
    markdown
      .trim()
      .split(/\n\n+/u)
      .map((block) => `<p data-block="0">${block.trimEnd()}</p>`)
      .join('')
  const lute = {
    Md2VditorIRDOM: render,
    Md2VditorDOM: render,
    VditorIRDOM2Md: serialize,
    VditorDOM2Md: serialize,
  }
  ;(window as any).vditor = {
    vditor: {
      currentMode: 'ir',
      ir: { element: root },
      wysiwyg: { element: root },
      lute,
    },
  }
  return () => {
    if (previous === undefined) delete (window as any).vditor
    else (window as any).vditor = previous
  }
}

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
    snapshotRevision: () => stableSnapshotRevision,
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
  const handleLeft = Number.parseFloat(handle.style.left)
  const foldTargetLeft = first.getBoundingClientRect().left - 38
  expect(foldTargetLeft - (handleLeft + 12)).toBe(2)
  expect(handle.getAttribute('aria-label')).toContain('Block')

  first.getBoundingClientRect = () => new DOMRect(40, 30, 300, 25)
  first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const narrowHandleLeft = Number.parseFloat(handle.style.left)
  expect(narrowHandleLeft).toBe(328)
  expect(38).toBeLessThan(narrowHandleLeft)
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)
  first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  handle.click()
  const menu = document.querySelector('.vmde-block-handle-menu') as HTMLElement
  expect(menu).toBeTruthy()
  ;(menu.querySelector('[data-action="delete"]') as HTMLButtonElement).click()
  expect(actions).toEqual([0])
  expect(root.querySelector('.vmde-block-handle')).toBeNull()
  dispose()
  expect(document.querySelector('.vmde-block-handle')).toBeNull()
})

it('resolves one cached presentation for 30 unchanged mousemoves, including a rejected map', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p>A<span> first</span></p><p>B<span> second</span></p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const previousVditor = (window as any).vditor
  const revision = {}
  const lute = {
    Md2VditorIRDOM: (markdown: string) => markdown,
    Md2VditorDOM: (markdown: string) => markdown,
    VditorIRDOM2Md: (html: string) => html,
    VditorDOM2Md: (html: string) => html,
  }
  ;(window as any).vditor = {
    vditor: {
      currentMode: 'ir',
      ir: { element: root },
      wysiwyg: { element: root },
      lute,
    },
  }
  const snapshot = vi.fn(() => null)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => revision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const targets = [
    root.children[0].firstChild!,
    root.querySelector('span')!,
    root.children[1].firstChild!,
    root.children[1].querySelector('span')!,
  ]

  try {
    for (let index = 0; index < 30; index++) {
      targets[index % targets.length].dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true }),
      )
    }
    expect(snapshot).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
    if (previousVditor === undefined) delete (window as any).vditor
    else (window as any).vditor = previousVditor
  }
})

it('keeps two pixels between handles and wide ordered-list fold markers', () => {
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML =
    '<ol data-block="0"><li data-block="0" data-marker="9999.">9999. parent<ul><li>child</li></ul></li></ol>'
  document.body.append(root)
  const markdown = '9999. parent\n    - child\n'
  const item = root.querySelector('li')!
  item.getBoundingClientRect = () => new DOMRect(100, 30, 300, 50)
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  const css = (values: Record<string, string>) =>
    values as unknown as CSSStyleDeclaration
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (element, pseudoElement) => {
      if (element === item && pseudoElement === '::after')
        return css({ left: '-38px', width: '36px' })
      if (element === item && pseudoElement === '::marker')
        return css({ listStyleType: 'decimal', width: '42px' })
      return originalGetComputedStyle(element, pseudoElement)
    },
  )
  const dispose = installBlockHandleLayer(() => root, {
    snapshot: () => ({ exact: markdown, rendered: markdown }),
    snapshotRevision: () => stableSnapshotRevision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const handle = document.querySelector(
    '.vmde-block-handle',
  ) as HTMLButtonElement
  const targetLeft = Math.min(62, 100 - 2 - 42)
  const handleLeft = Number.parseFloat(handle.style.left)
  expect(targetLeft - (handleLeft + 12)).toBe(2)
  expect(handleLeft).toBe(42)
  dispose()
})

it('keeps an open menu through ordinary editor attribute changes and clears a rebuilt target', async () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const first = root.children[0] as HTMLElement
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot: () => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }),
    snapshotRevision: () => stableSnapshotRevision,
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

it('declines a paired details DOM group without a full Lute projection proof', () => {
  document.body.innerHTML = `<pre class="vditor-reset">
    <p data-block="0">A</p>
    <div data-block="0" data-type="html-block">&lt;details&gt;</div>
    <p data-block="0">body</p>
    <div data-block="0" data-type="html-block">&lt;/details&gt;</div>
    <p data-block="0">B</p>
  </pre>`
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const markdown = 'A\n\n<details>\n\nbody\n\n</details>\n\nB\n'
  expect(resolveBlockHandleUnits(root, markdown, markdown)).toBeNull()
})

it('invalidates warmed rejection before text, link and image mutations deliver', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p><a href="/old">A</a><img src="old.png"></p><p>B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  const revision = {}
  const snapshot = vi.fn(() => null)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => revision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const link = root.querySelector('a')!
  const move = () =>
    link.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

  try {
    move()
    expect(snapshot).toHaveBeenCalledTimes(1)

    link.firstChild!.textContent = 'changed'
    move()
    expect(snapshot).toHaveBeenCalledTimes(2)

    link.setAttribute('href', '/new')
    move()
    expect(snapshot).toHaveBeenCalledTimes(3)

    root.querySelector('img')!.setAttribute('src', 'new.png')
    move()
    expect(snapshot).toHaveBeenCalledTimes(4)
  } finally {
    dispose()
    restore()
  }
})

it('uses fresh offsets when exact bytes change without changing rendered DOM', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  let exact = 'A\n\nB\n'
  let revision = {}
  const snapshot = vi.fn(() => ({ exact, rendered: 'A\n\nB\n' }))
  const deleted: number[] = []
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => revision,
    move: () => undefined,
    delete: (start) => {
      deleted.push(start)
    },
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const second = root.children[1] as HTMLElement
  second.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)

  try {
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(
      (
        document.querySelector('.vmde-block-handle') as HTMLButtonElement
      ).getAttribute('aria-disabled'),
    ).toBe('false')

    exact = 'A \n\nB\n'
    revision = {}
    expect(
      resolveBlockHandleUnits(
        root,
        exact,
        'A\n\nB\n',
        currentBlockProjection(),
      )?.map((unit) => unit.start),
    ).toEqual([0, 4])
    second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(
      (document.querySelector('.vmde-block-handle') as HTMLButtonElement)
        .hidden,
    ).toBe(false)

    ;(document.querySelector('.vmde-block-handle') as HTMLButtonElement).click()
    expect(
      (document.querySelector('.vmde-block-handle-menu') as HTMLElement).hidden,
    ).toBe(false)
    exact = 'A  \n\nB\n'
    revision = {}
    ;(
      document.querySelector(
        '.vmde-block-handle-menu [data-action="delete"]',
      ) as HTMLButtonElement
    ).click()
    expect(deleted).toEqual([5])
  } finally {
    dispose()
    restore()
  }
})

it('rejects a menu action after its displayed target is replaced before observer delivery', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  const snapshot = vi.fn(() => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }))
  const deleted: number[] = []
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => stableSnapshotRevision,
    move: () => undefined,
    delete: (start) => {
      deleted.push(start)
    },
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const oldTarget = root.children[1] as HTMLElement
  oldTarget.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)

  try {
    oldTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(
      (document.querySelector('.vmde-block-handle') as HTMLButtonElement)
        .hidden,
    ).toBe(false)
    ;(document.querySelector('.vmde-block-handle') as HTMLButtonElement).click()
    expect(
      (document.querySelector('.vmde-block-handle-menu') as HTMLElement).hidden,
    ).toBe(false)
    const replacement = document.createElement('p')
    replacement.dataset.block = '0'
    replacement.textContent = 'B'
    oldTarget.replaceWith(replacement)
    ;(
      document.querySelector(
        '.vmde-block-handle-menu [data-action="delete"]',
      ) as HTMLButtonElement
    ).click()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(deleted).toEqual([])
  } finally {
    dispose()
    restore()
  }
})

it('rebinds on root replacement and disconnects on disposal', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p>A</p></pre><pre class="vditor-reset"><p>B</p></pre>'
  const [firstRoot, secondRoot] = Array.from(
    document.querySelectorAll('pre.vditor-reset'),
  ) as HTMLElement[]
  const restore = installFakeBlockProjection(firstRoot)
  let activeRoot = firstRoot
  const snapshot = vi.fn(() => null)
  const dispose = installBlockHandleLayer(() => activeRoot, {
    snapshot,
    snapshotRevision: () => stableSnapshotRevision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })

  try {
    firstRoot.firstElementChild!.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    )
    activeRoot = secondRoot
    secondRoot.firstElementChild!.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    )
    expect(snapshot).toHaveBeenCalledTimes(2)

    secondRoot.setAttribute('contenteditable', 'false')
    secondRoot.firstElementChild!.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    )
    expect(snapshot).toHaveBeenCalledTimes(2)

    dispose()
    secondRoot.removeAttribute('contenteditable')
    secondRoot.firstElementChild!.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true }),
    )
    expect(snapshot).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
    restore()
  }
})

it('re-resolves a cached rejection when exact-source authority advances', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  let snapshotValue: { exact: string; rendered: string } | null = null
  let revision = {}
  const snapshot = vi.fn(() => snapshotValue)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => revision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const first = root.children[0] as HTMLElement
  first.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)

  try {
    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(
      (document.querySelector('.vmde-block-handle') as HTMLButtonElement)
        .hidden,
    ).toBe(true)

    snapshotValue = { exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }
    revision = {}
    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(
      (
        document.querySelector('.vmde-block-handle') as HTMLButtonElement
      ).getAttribute('aria-disabled'),
    ).toBe('false')
    first.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
    restore()
  }
})

it('bypasses presentation reuse when exact-source revision authority is absent', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  const snapshot = vi.fn(() => null)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => undefined,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const paragraph = root.firstElementChild!

  try {
    paragraph.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    paragraph.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
    restore()
  }
})

it('rejects a connected menu target when its fresh rendered proof is stale', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><p data-block="0">A</p><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  const snapshot = vi.fn(() => ({ exact: 'A\n\nB\n', rendered: 'A\n\nB\n' }))
  const deleted: number[] = []
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => stableSnapshotRevision,
    move: () => undefined,
    delete: (start) => {
      deleted.push(start)
    },
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const target = root.children[1] as HTMLElement
  target.getBoundingClientRect = () => new DOMRect(100, 30, 300, 25)

  try {
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    ;(document.querySelector('.vmde-block-handle') as HTMLButtonElement).click()
    expect(
      (document.querySelector('.vmde-block-handle-menu') as HTMLElement).hidden,
    ).toBe(false)
    target.textContent = 'changed'
    ;(
      document.querySelector(
        '.vmde-block-handle-menu [data-action="delete"]',
      ) as HTMLButtonElement
    ).click()
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(deleted).toEqual([])
    expect(
      (document.querySelector('.vmde-block-handle') as HTMLButtonElement)
        .hidden,
    ).toBe(true)
  } finally {
    dispose()
    restore()
  }
})

it('keeps a warmed map through known section-fold presentation attributes', () => {
  document.body.innerHTML =
    '<pre class="vditor-reset"><h1 data-block="0">A</h1><p data-block="0">B</p></pre>'
  const root = document.querySelector('pre.vditor-reset') as HTMLElement
  const restore = installFakeBlockProjection(root)
  const snapshot = vi.fn(() => null)
  const dispose = installBlockHandleLayer(() => root, {
    snapshot,
    snapshotRevision: () => stableSnapshotRevision,
    move: () => undefined,
    delete: () => undefined,
    duplicate: () => undefined,
    turnInto: () => undefined,
  })
  const heading = root.firstElementChild!
  try {
    heading.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(1)
    heading.setAttribute('data-vmde-foldable', '1')
    heading.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(snapshot).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
    restore()
  }
})
