// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import {
  type FrontMatterParseResult,
  parseFrontMatterProperties,
} from '../../../src/shared/front-matter'
import { createRealLute } from '../testing/real-lute'
import {
  decorateFrontMatter,
  FRONT_MATTER_COPY_CONFIRM_MS,
  installFrontMatterCopy,
  observeFrontMatter,
} from './front-matter-table'

// Task 207 S5 — the front-matter properties table: DOM shape, serializer transparency, Preview,
// error/empty states, copy buttons and the commit-on-leave observer. Lute is the real vendored
// engine so the markup under test is what Vditor renders.

const YAML = 'title: "Hello"\ntags: [a, b]\nauthor:\n  name: Ann'
const MARKDOWN = `---\n${YAML}\n---\n\n# Heading\n\nbody\n`
const BLOCK_SELECTOR =
  'div[data-type="yaml-front-matter"], pre.vditor-yml-front-matter'

type Mode = 'ir' | 'wysiwyg' | 'preview'

function mount(mode: Mode, markdown = MARKDOWN) {
  const lute = createRealLute(mode === 'wysiwyg' ? 'wysiwyg' : 'ir')
  const root = document.createElement('div')
  root.className = `vditor-reset ${mode === 'ir' ? 'vditor-ir' : mode === 'wysiwyg' ? 'vditor-wysiwyg' : 'vditor-preview'}`
  root.innerHTML =
    mode === 'preview' ? lute.lute.Md2HTML(markdown) : lute.render(markdown)
  document.body.appendChild(root)
  const block = root.querySelector<HTMLElement>(BLOCK_SELECTOR) as HTMLElement
  return { lute, root, block }
}

// A frame, so the coalesced observer's trailing re-run has also happened.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

function tableResult(yamlText = YAML): FrontMatterParseResult {
  return parseFrontMatterProperties(yamlText)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('decorateFrontMatter: DOM shape', () => {
  it('injects the table directly after the pre in IR with the exact names', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    expect(block.getAttribute('data-vmde-front-matter')).toBe('table')
    const pre = block.querySelector('pre') as HTMLElement
    const preview = pre.nextElementSibling as HTMLElement
    expect(preview.className).toBe('vmde-front-matter vditor-ir__preview')
    expect(preview.getAttribute('data-render')).toBe('1')
    expect(preview.getAttribute('contenteditable')).toBe('false')
    expect(preview.getAttribute('data-sig')).toBe(YAML)
    const rows = preview.querySelectorAll(
      'table.vmde-front-matter__table > tbody > tr.vmde-front-matter__row',
    )
    expect(rows).toHaveLength(3)
    const first = rows[0]
    const key = first.querySelector('th.vmde-front-matter__key') as HTMLElement
    const value = first.querySelector(
      'td.vmde-front-matter__value',
    ) as HTMLElement
    expect(key.getAttribute('scope')).toBe('row')
    expect(key.querySelector('.vmde-front-matter__content')?.textContent).toBe(
      'title',
    )
    expect(value.querySelector('.vmde-front-matter__text')?.textContent).toBe(
      'Hello',
    )
  })

  it('uses the WYSIWYG mode class and no class in Preview', () => {
    const wys = mount('wysiwyg')
    decorateFrontMatter(wys.block, tableResult())
    expect(
      wys.block.querySelector(':scope > pre + .vmde-front-matter')?.className,
    ).toBe('vmde-front-matter vditor-wysiwyg__preview')
    document.body.innerHTML = ''
    const prev = mount('preview')
    decorateFrontMatter(prev.block, tableResult())
    expect(prev.block.getAttribute('data-vmde-front-matter')).toBe('table')
    const sibling = prev.block.nextElementSibling as HTMLElement
    expect(sibling.className).toBe('vmde-front-matter')
    expect(sibling.getAttribute('data-render')).toBe('1')
  })

  it('builds icon-only copy buttons with accessible names and copy texts', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    const buttons = block.querySelectorAll<HTMLButtonElement>(
      '.vmde-front-matter__copy',
    )
    // 3 rows x (key + value); inner map cells carry none.
    expect(buttons).toHaveLength(6)
    const [nameBtn, valueBtn] = [buttons[0], buttons[1]]
    expect(nameBtn.type).toBe('button')
    expect(nameBtn.getAttribute('title')).toBe('Copy name')
    expect(nameBtn.getAttribute('aria-label')).toBe('Copy name: title')
    expect(nameBtn.getAttribute('data-copy-text')).toBe('title')
    expect(valueBtn.getAttribute('title')).toBe('Copy value')
    expect(valueBtn.getAttribute('aria-label')).toBe('Copy value of title')
    expect(valueBtn.getAttribute('data-copy-text')).toBe('Hello')
    expect(nameBtn.textContent?.trim()).toBe('')
    const icons = nameBtn.querySelectorAll('span.vmde-front-matter__icon')
    expect(icons).toHaveLength(2)
    expect(icons[0].classList.contains('vmde-front-matter__icon--copy')).toBe(
      true,
    )
    expect(icons[1].classList.contains('vmde-front-matter__icon--check')).toBe(
      true,
    )
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      expect(icon.querySelector('svg')).not.toBeNull()
    }
    // The tags value copies its YAML source, the map value its source lines.
    expect(buttons[3].getAttribute('data-copy-text')).toBe('[a, b]')
    expect(buttons[5].getAttribute('data-copy-text')).toBe('name: Ann')
  })

  it('renders list items as chips and a nested map as an inner table without buttons', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    const rows = block.querySelectorAll('tr.vmde-front-matter__row')
    const chips = rows[1].querySelectorAll(
      '.vmde-front-matter__list > .vmde-front-matter__chip',
    )
    expect([...chips].map((chip) => chip.textContent)).toEqual(['a', 'b'])
    const inner = rows[2].querySelector(
      'table.vmde-front-matter__inner',
    ) as HTMLElement
    expect(inner.querySelector('th')?.textContent).toBe('name')
    expect(inner.querySelector('td')?.textContent).toBe('Ann')
    expect(inner.querySelector('button')).toBeNull()
  })

  it('writes document text only through textContent', () => {
    const yamlText = 'title: "<img src=x onerror=alert(1)>"'
    const { block } = mount('ir', `---\n${yamlText}\n---\n\nbody\n`)
    decorateFrontMatter(block, tableResult(yamlText.replace(/&quot;/g, '"')))
    expect(block.querySelector('.vmde-front-matter img')).toBeNull()
    expect(block.querySelector('.vmde-front-matter__text')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    )
  })

  it('makes no DOM mutation when decorated twice with the same text', async () => {
    const { block, root } = mount('ir')
    decorateFrontMatter(block, tableResult())
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    decorateFrontMatter(block, tableResult())
    expect(observer.takeRecords()).toHaveLength(0)
    observer.disconnect()
  })

  it('rebuilds the preview when the source text changed', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    const code = block.querySelector('code') as HTMLElement
    code.textContent = 'title: Changed'
    decorateFrontMatter(block, tableResult('title: Changed'))
    expect(block.querySelectorAll('.vmde-front-matter')).toHaveLength(1)
    expect(block.querySelector('.vmde-front-matter__text')?.textContent).toBe(
      'Changed',
    )
    expect(
      block.querySelector('.vmde-front-matter')?.getAttribute('data-sig'),
    ).toBe('title: Changed')
  })

  it('clears the decoration for a null result', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    decorateFrontMatter(block, null)
    expect(block.hasAttribute('data-vmde-front-matter')).toBe(false)
    expect(block.querySelector('.vmde-front-matter')).toBeNull()
  })
})

describe('decorateFrontMatter: states', () => {
  it('shows the warning after the pre and no table on a parse error', () => {
    const { block } = mount('ir', '---\na: 1\na: 2\n---\n\nbody\n')
    decorateFrontMatter(block, parseFrontMatterProperties('a: 1\na: 2'))
    expect(block.getAttribute('data-vmde-front-matter')).toBe('error')
    expect(block.querySelector('.vmde-front-matter')).toBeNull()
    const warning = block.querySelector(
      'pre + .vmde-front-matter__warning',
    ) as HTMLElement
    expect(warning.textContent).toBe(
      'Front matter could not be parsed: Map keys must be unique (line 3, column 1)',
    )
    expect(warning.getAttribute('role')).toBe('note')
    expect(warning.getAttribute('data-render')).toBe('1')
    expect(warning.getAttribute('contenteditable')).toBe('false')
    expect(block.querySelector('pre')).not.toBeNull()
  })

  it('marks empty front matter and injects nothing', () => {
    const { block } = mount('ir', '---\n# only a comment\n---\n\nbody\n')
    decorateFrontMatter(block, { status: 'empty' })
    expect(block.getAttribute('data-vmde-front-matter')).toBe('empty')
    expect(
      block.querySelector('.vmde-front-matter, .vmde-front-matter__warning'),
    ).toBeNull()
  })

  it('switches table to error and back without leaving a stale node', () => {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    decorateFrontMatter(block, parseFrontMatterProperties('a: 1\na: 2'))
    expect(block.querySelector('.vmde-front-matter')).toBeNull()
    expect(block.querySelectorAll('.vmde-front-matter__warning')).toHaveLength(
      1,
    )
    decorateFrontMatter(block, tableResult())
    expect(block.querySelector('.vmde-front-matter__warning')).toBeNull()
    expect(block.querySelectorAll('.vmde-front-matter')).toHaveLength(1)
  })

  it('places the Preview warning after the pre', () => {
    const { block } = mount('preview', '---\na: 1\na: 2\n---\n\nbody\n')
    decorateFrontMatter(block, parseFrontMatterProperties('a: 1\na: 2'))
    expect(block.nextElementSibling?.className).toBe(
      'vmde-front-matter__warning',
    )
  })
})

describe('serializer transparency', () => {
  for (const mode of ['ir', 'wysiwyg'] as const) {
    it(`serializes ${mode} identically with and without the table and the warning`, () => {
      const { lute, root, block } = mount(mode)
      const base = lute.serialize(root.innerHTML)
      decorateFrontMatter(block, tableResult())
      expect(lute.serialize(root.innerHTML)).toBe(base)
      decorateFrontMatter(block, parseFrontMatterProperties('a: 1\na: 2'))
      expect(lute.serialize(root.innerHTML)).toBe(base)
    })
  }
})

describe('installFrontMatterCopy', () => {
  let post: Mock<
    (message: { command: 'copy-property'; content: string }) => void
  >
  let dispose: () => void

  beforeEach(() => {
    post =
      vi.fn<(message: { command: 'copy-property'; content: string }) => void>()
    dispose = installFrontMatterCopy(window as Window & typeof globalThis, post)
  })
  afterEach(() => dispose())

  function copyButtons() {
    const { block } = mount('ir')
    decorateFrontMatter(block, tableResult())
    return [
      ...block.querySelectorAll<HTMLButtonElement>('.vmde-front-matter__copy'),
    ]
  }

  const mouse = (type: string, button = 0) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button })

  it('posts the key text and the value text on click and consumes the event', () => {
    const [nameBtn, valueBtn] = copyButtons()
    const seen = vi.fn()
    nameBtn.addEventListener('click', seen)
    const click = mouse('click')
    nameBtn.dispatchEvent(click)
    expect(post).toHaveBeenCalledWith({
      command: 'copy-property',
      content: 'title',
    })
    expect(click.defaultPrevented).toBe(true)
    expect(seen).not.toHaveBeenCalled()
    valueBtn.dispatchEvent(mouse('click'))
    expect(post).toHaveBeenLastCalledWith({
      command: 'copy-property',
      content: 'Hello',
    })
  })

  it('ignores clicks that are not on a copy button', () => {
    const [nameBtn] = copyButtons()
    nameBtn.parentElement
      ?.querySelector('.vmde-front-matter__content')
      ?.dispatchEvent(mouse('click'))
    expect(post).not.toHaveBeenCalled()
  })

  it('prevents the mousedown default only for the primary button', () => {
    const [nameBtn] = copyButtons()
    const primary = mouse('mousedown', 0)
    nameBtn.dispatchEvent(primary)
    expect(primary.defaultPrevented).toBe(true)
    const secondary = mouse('mousedown', 2)
    nameBtn.dispatchEvent(secondary)
    expect(secondary.defaultPrevented).toBe(false)
    const outside = mouse('mousedown', 0)
    document.body.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
  })

  it('copies on Enter and Space keydown and stops the event', () => {
    const [nameBtn] = copyButtons()
    const seen = vi.fn()
    nameBtn.addEventListener('keydown', seen)
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      })
      nameBtn.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(post).toHaveBeenCalledTimes(2)
    expect(seen).not.toHaveBeenCalled()
    const other = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    })
    nameBtn.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('confirms with data-copied for 1500 ms and restarts on a second click', () => {
    vi.useFakeTimers()
    expect(FRONT_MATTER_COPY_CONFIRM_MS).toBe(1500)
    const [nameBtn] = copyButtons()
    nameBtn.dispatchEvent(mouse('click'))
    expect(nameBtn.hasAttribute('data-copied')).toBe(true)
    vi.advanceTimersByTime(1499)
    expect(nameBtn.hasAttribute('data-copied')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(nameBtn.hasAttribute('data-copied')).toBe(false)

    nameBtn.dispatchEvent(mouse('click'))
    vi.advanceTimersByTime(1000)
    nameBtn.dispatchEvent(mouse('click'))
    vi.advanceTimersByTime(1000)
    expect(nameBtn.hasAttribute('data-copied')).toBe(true)
    vi.advanceTimersByTime(500)
    expect(nameBtn.hasAttribute('data-copied')).toBe(false)
  })

  it('stops listening after dispose', () => {
    const [nameBtn] = copyButtons()
    dispose()
    nameBtn.dispatchEvent(mouse('click'))
    expect(post).not.toHaveBeenCalled()
    dispose = installFrontMatterCopy(window as Window & typeof globalThis, post)
  })
})

describe('observeFrontMatter', () => {
  function setCaret(node: Node, offset: number) {
    const range = document.createRange()
    range.setStart(node, offset)
    range.collapse(true)
    const selection = document.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }

  it('decorates after the lazy parser resolves', async () => {
    const { root, block } = mount('ir')
    const loadParser = vi.fn(async () => parseFrontMatterProperties)
    const dispose = observeFrontMatter(root, { loadParser })
    expect(block.hasAttribute('data-vmde-front-matter')).toBe(false)
    await flush()
    expect(loadParser).toHaveBeenCalledTimes(1)
    expect(block.getAttribute('data-vmde-front-matter')).toBe('table')
    dispose()
  })

  it('never loads the parser for a document without front matter', async () => {
    const { root } = mount('ir', '# Heading\n\nbody\n')
    const loadParser = vi.fn(async () => parseFrontMatterProperties)
    const dispose = observeFrontMatter(root, { loadParser })
    await flush()
    expect(loadParser).not.toHaveBeenCalled()
    dispose()
  })

  it('keeps the code block when the parser fails to load', async () => {
    const { root, block } = mount('ir')
    const loadParser = vi.fn(async () => {
      throw new Error('no bundle')
    })
    const dispose = observeFrontMatter(root, { loadParser })
    await flush()
    expect(block.hasAttribute('data-vmde-front-matter')).toBe(false)
    expect(
      block.querySelector('.vmde-front-matter, .vmde-front-matter__warning'),
    ).toBeNull()
    expect(loadParser).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('re-applies after the block is replaced by a fresh render (spin)', async () => {
    const { lute, root } = mount('ir')
    const parse = vi.fn(parseFrontMatterProperties)
    const dispose = observeFrontMatter(root, { loadParser: async () => parse })
    await flush()
    root.innerHTML = lute.render(MARKDOWN)
    await flush()
    const block = root.querySelector(
      'div[data-type="yaml-front-matter"]',
    ) as HTMLElement
    expect(block.getAttribute('data-vmde-front-matter')).toBe('table')
    expect(parse).toHaveBeenCalledTimes(1) // same text: the committed result is reused
    dispose()
  })

  it('decorates the Preview pane block', async () => {
    const { root, block } = mount('preview')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    expect(block.getAttribute('data-vmde-front-matter')).toBe('table')
    expect(
      block.nextElementSibling?.classList.contains('vmde-front-matter'),
    ).toBe(true)
    dispose()
  })

  it('flags editing while the caret is inside, does not parse, and commits on leave', async () => {
    const { root, block } = mount('ir')
    const parse = vi.fn(parseFrontMatterProperties)
    const dispose = observeFrontMatter(root, { loadParser: async () => parse })
    await flush()
    expect(parse).toHaveBeenCalledTimes(1)
    const oldSig = block
      .querySelector('.vmde-front-matter')
      ?.getAttribute('data-sig')

    const code = block.querySelector('code') as HTMLElement
    setCaret(code.firstChild as Node, 3)
    expect(block.hasAttribute('data-vmde-front-matter-editing')).toBe(true)

    // Typing: the source changes, Vditor's spin drops our nodes; the observer re-injects the last
    // committed preview (cached clone) and does NOT parse.
    code.firstChild!.textContent = 'title: "Hello"\ntags: [a, b, c]'
    block.querySelector('.vmde-front-matter')?.remove()
    block.removeAttribute('data-vmde-front-matter')
    await flush()
    expect(parse).toHaveBeenCalledTimes(1)
    expect(block.getAttribute('data-vmde-front-matter')).toBe('table')
    expect(
      block.querySelector('.vmde-front-matter')?.getAttribute('data-sig'),
    ).toBe(oldSig)

    // Leave: move the caret into the heading. The new text is parsed and committed.
    const heading = root.querySelector('h1') as HTMLElement
    setCaret(heading.lastChild as Node, 1)
    expect(block.hasAttribute('data-vmde-front-matter-editing')).toBe(false)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(
      block.querySelector('.vmde-front-matter')?.getAttribute('data-sig'),
    ).toBe('title: "Hello"\ntags: [a, b, c]')
    dispose()
  })

  it('rebuilds a preview that carries another mode class (IR clone after a switch to WYSIWYG)', () => {
    const { block } = mount('wysiwyg')
    decorateFrontMatter(block, tableResult())
    const preview = block.querySelector('.vmde-front-matter') as HTMLElement
    preview.className = 'vmde-front-matter vditor-ir__preview'
    decorateFrontMatter(block, tableResult())
    expect(block.querySelector('.vmde-front-matter')?.className).toBe(
      'vmde-front-matter vditor-wysiwyg__preview',
    )
  })

  it('shows the WYSIWYG source when the document opens with the caret inside it', async () => {
    const { root, block } = mount('wysiwyg')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    const pre = block.querySelector('pre') as HTMLElement
    expect(pre.style.display).toBe('none')
    setCaret((block.querySelector('code') as HTMLElement).firstChild as Node, 1)
    expect(pre.style.display).toBe('block')
    dispose()
  })

  it('sets the WYSIWYG pre hidden at once on leave in table state', async () => {
    const { root, block } = mount('wysiwyg')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    const pre = block.querySelector('pre') as HTMLElement
    const code = block.querySelector('code') as HTMLElement
    setCaret(code.firstChild as Node, 1)
    pre.style.display = 'block' // what Vditor's showCode does
    const paragraph = root.querySelector('h1') as HTMLElement
    setCaret(paragraph.lastChild as Node, 0)
    expect(pre.style.display).toBe('none')
    dispose()
  })

  it('stops observing after dispose', async () => {
    const { lute, root } = mount('ir')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    dispose()
    root.innerHTML = lute.render(MARKDOWN)
    await flush()
    expect(root.querySelector('[data-vmde-front-matter]')).toBeNull()
  })

  it('returns a no-op disposer without a root', () => {
    const dispose = observeFrontMatter(null, {
      loadParser: async () => parseFrontMatterProperties,
    })
    expect(() => dispose()).not.toThrow()
  })
})

// Task 207 S10 (Q1 option a) — TOML between `+++` lines is NOT front matter to Lute: it renders as a
// plain paragraph. The paragraph stays as it is; a non-editable warning span is added inside it.
describe('TOML front matter warning', () => {
  const TOML = '+++\ntitle = "x"\n+++\n\ntext\n'
  const WARNING =
    'Front matter could not be parsed: TOML front matter is not supported'
  const toml = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('p > span.vmde-front-matter__warning--toml')

  function mountToml(mode: Mode, markdown = TOML) {
    const lute = createRealLute(mode === 'wysiwyg' ? 'wysiwyg' : 'ir')
    const root = document.createElement('div')
    root.className = `vditor-reset ${mode === 'ir' ? 'vditor-ir' : mode === 'wysiwyg' ? 'vditor-wysiwyg' : 'vditor-preview'}`
    root.innerHTML =
      mode === 'preview' ? lute.lute.Md2HTML(markdown) : lute.render(markdown)
    document.body.appendChild(root)
    return { lute, root }
  }

  for (const mode of ['ir', 'wysiwyg', 'preview'] as const) {
    it(`adds the warning span inside the leading paragraph in ${mode}`, async () => {
      const { root } = mountToml(mode)
      const loadParser = vi.fn(async () => parseFrontMatterProperties)
      const dispose = observeFrontMatter(root, { loadParser })
      await flush()
      const span = toml(root) as HTMLElement
      expect(span.getAttribute('data-render')).toBe('1')
      expect(span.getAttribute('contenteditable')).toBe('false')
      expect(span.textContent).toBe(WARNING)
      expect(root.firstElementChild?.tagName).toBe('P')
      expect(loadParser).not.toHaveBeenCalled()
      dispose()
    })
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    it(`serializes ${mode} identically with and without the warning span`, async () => {
      const { lute, root } = mountToml(mode)
      const base = lute.serialize(root.innerHTML)
      const dispose = observeFrontMatter(root, {
        loadParser: async () => parseFrontMatterProperties,
      })
      await flush()
      expect(toml(root)).not.toBeNull()
      expect(lute.serialize(root.innerHTML)).toBe(base)
      dispose()
    })
  }

  it('adds nothing to a paragraph that only starts with +++ or is not first', async () => {
    const lone = mountToml('ir', '+++\nno closing line\n')
    const notFirst = mountToml('ir', '# Heading\n\n+++\na = 1\n+++\n')
    for (const { root } of [lone, notFirst]) {
      const dispose = observeFrontMatter(root, {
        loadParser: async () => parseFrontMatterProperties,
      })
      await flush()
      expect(toml(root)).toBeNull()
      dispose()
    }
  })

  it('leaves the paragraph alone while the caret is inside and restores on leave', async () => {
    const { lute, root } = mountToml('ir')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    const paragraph = root.firstElementChild as HTMLElement
    const range = document.createRange()
    range.setStart(paragraph.firstChild as Node, 2)
    range.collapse(true)
    const selection = document.getSelection() as Selection
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    // Typing respins the block: the span is gone and stays gone while the caret is inside.
    root.innerHTML = lute.render('+++\ntitle = "y"\n+++\n\ntext\n')
    // Vditor restores the caret into the respun paragraph.
    const respun = root.firstElementChild as HTMLElement
    const restored = document.createRange()
    restored.setStart(respun.firstChild as Node, 2)
    restored.collapse(true)
    selection.removeAllRanges()
    selection.addRange(restored)
    await flush()
    expect(toml(root)).toBeNull()
    document.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    expect(toml(root)).not.toBeNull()
    dispose()
  })

  it('removes the warning when the paragraph stops being TOML', async () => {
    const { lute, root } = mountToml('ir')
    const dispose = observeFrontMatter(root, {
      loadParser: async () => parseFrontMatterProperties,
    })
    await flush()
    const paragraph = root.firstElementChild as HTMLElement
    // An edit that keeps our span but breaks the delimiters.
    paragraph.firstChild!.textContent = 'plain'
    await flush()
    expect(toml(root)).toBeNull()
    expect(lute.serialize(root.innerHTML)).not.toContain('not supported')
    dispose()
  })
})

describe('front-matter-entry (lazy bundle entry)', () => {
  it('exposes the parser on window.__vmdeFrontMatter', async () => {
    await import('./front-matter-entry')
    const bridge = (
      window as unknown as {
        __vmdeFrontMatter?: { parse(text: string): FrontMatterParseResult }
      }
    ).__vmdeFrontMatter
    expect(bridge?.parse('title: Hello')).toMatchObject({ status: 'table' })
  })
})
