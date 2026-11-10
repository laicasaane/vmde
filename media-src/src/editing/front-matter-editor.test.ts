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
import { createRealLute } from '../testing/real-lute'
import { requestCaret } from './caret'
import { checkpointEditorUndoCoalescing } from './rewrap-command'
import {
  editFrontMatterDocument,
  parseFrontMatterTable,
} from './front-matter-edit-model'
import { installFrontMatterEdit } from './front-matter-editor'
import { observeFrontMatter } from './front-matter-table'

// Task 725 — the table's cell editors and row actions: which surfaces are editable, the commit and
// cancel keys, the exact-source transaction (one post per action, spliced into the front-matter
// range only), placeholder and duplicate rows, and the event isolation from the editor.
const state = vi.hoisted(() => ({
  inner: null as any,
  editor: null as HTMLElement | null,
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => state.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => state.editor }))
vi.mock('./caret', () => ({
  requestCaret: vi.fn(),
  invalidateCaret: vi.fn(),
}))
// The checkpoint pushes a fresh native entry, so a test can see which entry a transaction left on top.
vi.mock('./rewrap-command', () => ({
  checkpointEditorUndo: vi.fn((inner: any) =>
    inner.undo[inner.currentMode].undoStack.push(['entry']),
  ),
  checkpointEditorUndoCoalescing: vi.fn(),
  recordRewrapDocumentHistory: vi.fn(),
}))
vi.mock('./undo-boundaries', () => ({ disarmAfterRenderUndoEntry: vi.fn() }))

type Mode = 'ir' | 'wysiwyg' | 'preview'
const BODY = '\n# Heading\n\nParagraph below.\n'
const DOC = `---\n# keep this comment\ntitle: "Hello"\ntags:\n  - a\n  - b\ncount: 3\n---\n${BODY}`

let exact: string
/** What the editor DOM renders (Vditor `getValue`): follows `setValue`, like the real editor. */
let rendered: string
let postExact: Mock<(markdown: string, opts?: unknown) => void>
let setValue: Mock<(markdown: string) => void>
let disposers: (() => void)[] = []

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

async function mount(mode: Mode, markdown = DOC) {
  exact = markdown
  rendered = markdown
  const lute = createRealLute(mode === 'wysiwyg' ? 'wysiwyg' : 'ir')
  const root = document.createElement('div')
  root.className = `vditor-reset ${mode === 'ir' ? 'vditor-ir' : mode === 'wysiwyg' ? 'vditor-wysiwyg' : 'vditor-preview'}`
  const render = (md: string) =>
    mode === 'preview' ? lute.lute.Md2HTML(md) : lute.render(md)
  root.innerHTML = render(markdown)
  if (mode !== 'preview') root.contentEditable = 'true'
  document.body.appendChild(root)
  state.editor = root
  state.inner = {
    currentMode: mode === 'preview' ? 'ir' : mode,
    undo: { [mode]: { undoStack: ['base'], redoStack: [] } },
  }
  setValue = vi.fn((md: string) => {
    rendered = md
    root.innerHTML = render(md)
  })
  ;(window as any).vditor = {
    getValue: () => rendered.replace(/\r\n/g, '\n'),
    setValue,
  }
  ;(window as any).__vmdeFrontMatter = {
    parse: parseFrontMatterTable,
    edit: editFrontMatterDocument,
    yaml: (md: string) => {
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)
      return match ? match[1] : null
    },
  }
  postExact = vi.fn((markdown: string) => {
    exact = markdown
  })
  disposers.push(
    observeFrontMatter(root, { loadParser: async () => parseFrontMatterTable }),
    installFrontMatterEdit(window as Window & typeof globalThis, {
      snapshotExactMarkdown: () => exact,
      acquireExactAuthority: async () => ({ exact, rendered: exact }),
      setApplying: vi.fn(),
      postExact,
      onError: (error) => {
        throw error
      },
    }),
  )
  await flush()
  return root
}

const table = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('.vmde-front-matter') as HTMLElement
const cell = (root: HTMLElement, index: number, kind: 'key' | 'value') =>
  root.querySelector<HTMLElement>(
    `tr[data-vmde-fm-index="${index}"] > [data-vmde-fm-cell="${kind}"]`,
  ) as HTMLElement
const editor = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '.vmde-front-matter__editor',
  )

function click(target: Element) {
  target.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }),
  )
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
  )
}

function key(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function type(root: HTMLElement, text: string) {
  const control = editor(root) as HTMLInputElement
  control.value = text
  control.dispatchEvent(new InputEvent('input', { bubbles: true }))
}

/** Waits for the queued transaction (the queue is a promise chain). */
const settle = () => flush()

beforeEach(() => {
  disposers = []
})

afterEach(() => {
  for (const dispose of disposers) dispose()
  document.body.innerHTML = ''
  delete (window as any).vditor
  delete (window as any).__vmdeFrontMatter
  state.editor = null
})

describe('which surfaces are editable (D2)', () => {
  it.each(['ir', 'wysiwyg'] as const)(
    '%s: cells, row tools and the Add button',
    async (mode) => {
      const root = await mount(mode)
      const preview = table(root)
      expect(preview.hasAttribute('data-vmde-fm-editable')).toBe(true)
      expect(preview.querySelectorAll('[data-vmde-fm-cell]')).toHaveLength(6)
      expect(
        preview.querySelectorAll('.vmde-front-matter__remove'),
      ).toHaveLength(3)
      // Task 728: the handle sits in the name cell, the remove button in the value cell's wrapper.
      expect(
        preview.querySelectorAll(
          '[data-vmde-fm-cell="key"] > .vmde-front-matter__handle',
        ),
      ).toHaveLength(3)
      expect(
        preview.querySelectorAll(
          '[data-vmde-fm-cell="value"] > .vmde-front-matter__tools > .vmde-front-matter__remove',
        ),
      ).toHaveLength(3)
      expect(
        preview.querySelector('.vmde-front-matter__add')?.textContent,
      ).toBe('+ Add property')
      expect(cell(root, 1, 'value').hasAttribute('data-vmde-fm-yaml')).toBe(
        true,
      )
      expect(cell(root, 0, 'value').hasAttribute('data-vmde-fm-yaml')).toBe(
        false,
      )
    },
  )

  it('Preview: the same table has no edit affordance and a click opens nothing', async () => {
    const root = await mount('preview')
    const preview = table(root)
    expect(preview.querySelector('tr')).not.toBeNull()
    expect(preview.hasAttribute('data-vmde-fm-editable')).toBe(false)
    expect(
      preview.querySelector(
        '[data-vmde-fm-cell], .vmde-front-matter__add, .vmde-front-matter__remove, .vmde-front-matter__handle',
      ),
    ).toBeNull()
    click(preview.querySelector('td') as Element)
    expect(editor(root)).toBeNull()
  })
})

describe('cell editor keys', () => {
  it('a click opens an input with the value; Enter commits one exact edit and focuses the cell', async () => {
    const root = await mount('ir')
    click(cell(root, 0, 'value'))
    const control = editor(root) as HTMLInputElement
    expect(control.tagName).toBe('INPUT')
    expect(control.value).toBe('Hello')
    expect(document.activeElement).toBe(control)
    type(root, 'World')
    key(control, { key: 'Enter' })
    await settle()
    const expected = DOC.replace('title: "Hello"', 'title: "World"')
    expect(postExact).toHaveBeenCalledOnce()
    expect(postExact.mock.calls[0][0]).toBe(expected)
    expect(setValue).toHaveBeenCalledExactlyOnceWith(expected)
    expect(editor(root)).toBeNull()
    expect(document.activeElement).toBe(cell(root, 0, 'value'))
  })

  it('Esc cancels: no edit, the cell keeps its text and takes the focus', async () => {
    const root = await mount('wysiwyg')
    click(cell(root, 2, 'key'))
    type(root, 'renamed')
    key(editor(root) as Element, { key: 'Escape' })
    await settle()
    expect(postExact).not.toHaveBeenCalled()
    expect(editor(root)).toBeNull()
    expect(cell(root, 2, 'key').textContent).toContain('count')
    expect(document.activeElement).toBe(cell(root, 2, 'key'))
  })

  it('Tab commits and opens the next cell (name, value, next row); unchanged text posts nothing', async () => {
    const root = await mount('ir')
    click(cell(root, 0, 'key'))
    key(editor(root) as Element, { key: 'Tab' })
    await settle()
    expect(postExact).not.toHaveBeenCalled()
    expect(editor(root)?.parentElement).toBe(cell(root, 0, 'value'))
    type(root, 'Next')
    key(editor(root) as Element, { key: 'Tab' })
    await settle()
    expect(postExact).toHaveBeenCalledOnce()
    expect(editor(root)?.parentElement).toBe(cell(root, 1, 'key'))
    key(editor(root) as Element, { key: 'Tab', shiftKey: true })
    await settle()
    expect(editor(root)?.parentElement).toBe(cell(root, 0, 'value'))
  })

  it('a list cell opens a YAML box; Shift+Enter is a line break, Enter commits the source', async () => {
    const root = await mount('ir')
    click(cell(root, 1, 'value'))
    const box = editor(root) as HTMLTextAreaElement
    expect(box.tagName).toBe('TEXTAREA')
    expect(box.value).toBe('\n  - a\n  - b')
    expect(key(box, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(
      false,
    )
    type(root, '\n  - a\n  - b\n  - c')
    key(box, { key: 'Enter' })
    await settle()
    expect(postExact.mock.calls[0][0]).toBe(
      DOC.replace('  - b\n', '  - b\n  - c\n'),
    )
  })

  it('keys and input in a cell editor never reach the editor surface', async () => {
    const root = await mount('ir')
    const seen: string[] = []
    for (const kind of [
      'keydown',
      'keyup',
      'input',
      'beforeinput',
      'paste',
      'mousedown',
      'click',
    ])
      root.addEventListener(kind, () => seen.push(kind))
    document.addEventListener(
      'keydown',
      () => seen.push('document keydown'),
      true,
    )
    click(cell(root, 0, 'value'))
    seen.length = 0
    const control = editor(root) as HTMLInputElement
    key(control, { key: 'a' })
    control.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', bubbles: true }),
    )
    control.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }))
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    control.dispatchEvent(new Event('paste', { bubbles: true }))
    click(control)
    expect(seen).toEqual([])
    // The editor's own Lute serialization of the surface never contains the open editor.
    expect(control.closest('[data-render="1"]')).not.toBeNull()
  })
})

describe('structural actions', () => {
  it('Add appends `property_<N>: ""` each press (Task 728 D1-D4), one post each, and opens the new name selected; Tab fills the rows in one go', async () => {
    const root = await mount('ir')
    // Several Adds in a row, the previous name editor open and unchanged each time (D6).
    for (let count = 0; count < 3; count++) {
      click(root.querySelector('.vmde-front-matter__add') as Element)
      await settle()
    }
    expect(postExact).toHaveBeenCalledTimes(3)
    expect(exact).toBe(
      DOC.replace(
        'count: 3\n',
        'count: 3\nproperty_1: ""\nproperty_2: ""\nproperty_3: ""\n',
      ),
    )
    const control = editor(root) as HTMLInputElement
    expect(control.parentElement).toBe(cell(root, 5, 'key'))
    expect([
      control.value,
      control.selectionStart,
      control.selectionEnd,
    ]).toEqual(['property_3', 0, 10])
    // Valid YAML: plain rows, no placeholder marker and no malformed-YAML warning.
    expect(root.querySelector('.vmde-front-matter__warning')).toBeNull()
    expect(root.querySelector('tr[data-vmde-fm-warning]')).toBeNull()
    click(cell(root, 3, 'key'))
    for (const [text, tab] of [
      ['one', true],
      ['1', true],
      ['two', true],
      ['2', false],
    ] as const) {
      type(root, text)
      key(editor(root) as Element, tab ? { key: 'Tab' } : { key: 'Enter' })
      await settle()
    }
    expect(exact).toBe(
      DOC.replace(
        'count: 3\n',
        'count: 3\none: "1"\ntwo: "2"\nproperty_3: ""\n',
      ),
    )
  })

  it('the first Add starts after the largest existing `property_<N>`; taken numbers are skipped (D4)', async () => {
    const root = await mount(
      'ir',
      DOC.replace(
        'count: 3\n',
        'count: 3\nproperty_1: x\nproperty_5: y\n"property_7": z\n',
      ),
    )
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    expect(exact).toBe(
      DOC.replace(
        'count: 3\n',
        'count: 3\nproperty_1: x\nproperty_5: y\n"property_7": z\nproperty_8: ""\nproperty_9: ""\n',
      ),
    )
    expect(postExact).toHaveBeenCalledTimes(2)
  })

  it('Undo does not lower the number; a new editor session starts from the document (D3, D4)', async () => {
    let root = await mount('ir')
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    // The host's Undo puts the old text back; the next Add still takes the next number.
    root.innerHTML = createRealLute('ir').render(DOC)
    exact = DOC
    rendered = DOC
    await flush()
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    expect(exact).toBe(DOC.replace('count: 3\n', 'count: 3\nproperty_2: ""\n'))
    // Close and reopen: the count starts again after the largest existing number.
    for (const dispose of disposers.splice(0)) dispose()
    document.body.innerHTML = ''
    root = await mount('ir', exact)
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    expect(exact).toBe(
      DOC.replace('count: 3\n', 'count: 3\nproperty_2: ""\nproperty_3: ""\n'),
    )
  })

  it('Add after a changed name commits the name first, then adds the next row (D6)', async () => {
    const root = await mount('wysiwyg')
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    type(root, 'named')
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    expect(postExact).toHaveBeenCalledTimes(3)
    expect(exact).toBe(
      DOC.replace('count: 3\n', 'count: 3\nnamed: ""\nproperty_2: ""\n'),
    )
  })

  it('a transaction on top of the previous one checkpoints with the source proven unchanged (Task 728)', async () => {
    const root = await mount('ir')
    const coalescing = vi.mocked(checkpointEditorUndoCoalescing)
    coalescing.mockClear()
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    click(root.querySelector('.vmde-front-matter__add') as Element)
    await settle()
    // The first Add sits on the loaded state; the second on the first Add's own entry, same text.
    expect(coalescing.mock.calls.map((call) => call[1])).toEqual([false, true])
  })

  it('a press on the drag handle or next to the remove button opens no editor and edits nothing', async () => {
    const root = await mount('wysiwyg')
    const handle = cell(root, 0, 'key').querySelector(
      '.vmde-front-matter__handle',
    ) as Element
    const tools = cell(root, 0, 'value').querySelector(
      '.vmde-front-matter__tools',
    ) as Element
    for (const target of [handle, tools]) {
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
      target.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    }
    await settle()
    expect(editor(root)).toBeNull()
    expect(postExact).not.toHaveBeenCalled()
  })

  it('a drag of the name cell handle lands where the pointer is released (Task 728)', async () => {
    const root = await mount('ir')
    const handle = cell(root, 0, 'key').querySelector(
      '.vmde-front-matter__handle',
    ) as Element
    // jsdom has no PointerEvent; the handlers read only button, target and clientY.
    handle.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    )
    // No pointermove: the release point alone decides the drop row (below every row: the last).
    handle.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        clientY: 500,
      }),
    )
    await settle()
    expect(exact).toBe(
      DOC.replace(
        'title: "Hello"\ntags:\n  - a\n  - b\ncount: 3',
        'tags:\n  - a\n  - b\ncount: 3\ntitle: "Hello"',
      ),
    )
    expect(postExact).toHaveBeenCalledTimes(1)
  })

  it('a rename to an existing name is written as typed and both rows show the duplicate marker (D2)', async () => {
    const root = await mount('ir')
    click(cell(root, 2, 'key'))
    type(root, 'title')
    key(editor(root) as Element, { key: 'Enter' })
    await settle()
    expect(exact).toBe(DOC.replace('count: 3', 'title: 3'))
    expect(
      [...root.querySelectorAll('tr[data-vmde-fm-warning="duplicate"]')].map(
        (row) => row.getAttribute('data-vmde-fm-index'),
      ),
    ).toEqual(['0', '2'])
    expect(table(root).hasAttribute('data-vmde-fm-editable')).toBe(true)
  })

  it('remove deletes only that row; Alt+ArrowUp on a focused cell moves it up', async () => {
    const root = await mount('wysiwyg')
    click(root.querySelectorAll('.vmde-front-matter__remove')[1] as Element)
    await settle()
    expect(exact).toBe(DOC.replace('tags:\n  - a\n  - b\n', ''))
    cell(root, 1, 'key').focus()
    key(cell(root, 1, 'key'), { key: 'ArrowUp', altKey: true })
    await settle()
    expect(exact).toBe(
      DOC.replace(
        'title: "Hello"\ntags:\n  - a\n  - b\ncount: 3',
        'count: 3\ntitle: "Hello"',
      ),
    )
    expect(document.activeElement).toBe(cell(root, 0, 'key'))
    expect(postExact).toHaveBeenCalledTimes(2)
  })

  it('a CRLF document keeps CRLF and every byte outside the edited value', async () => {
    const crlf = DOC.replace(/\n/g, '\r\n')
    const root = await mount('ir', crlf)
    click(cell(root, 2, 'value'))
    type(root, '4')
    key(editor(root) as Element, { key: 'Enter' })
    await settle()
    expect(postExact.mock.calls[0][0]).toBe(
      crlf.replace('count: 3', 'count: 4'),
    )
  })

  it('declines when the table does not show the exact text (no post, no setValue)', async () => {
    const root = await mount('ir')
    exact = DOC.replace('count: 3', 'count: 9')
    click(cell(root, 0, 'value'))
    type(root, 'X')
    key(editor(root) as Element, { key: 'Enter' })
    await settle()
    expect(postExact).not.toHaveBeenCalled()
    expect(setValue).not.toHaveBeenCalled()
  })
})

describe('YAML source entry (D22)', () => {
  it('WYSIWYG: ArrowUp at the start of the next block puts the caret at the end of the source', async () => {
    const root = await mount('wysiwyg')
    const heading = root.querySelector('h1') as HTMLElement
    const text = heading.firstChild as Text
    getSelection()?.collapse(text, 0)
    const event = key(heading, { key: 'ArrowUp' })
    expect(event.defaultPrevented).toBe(true)
    const pre = root.querySelector<HTMLElement>(
      '[data-type="yaml-front-matter"] > pre',
    ) as HTMLElement
    expect(pre.style.display).toBe('block')
    const intent = vi.mocked(requestCaret).mock.calls.at(-1)?.[0] as {
      node: Node
      offset: number
    }
    expect(pre.contains(intent.node)).toBe(true)
  })

  it('leaves ArrowUp alone away from the block start and in IR', async () => {
    const root = await mount('wysiwyg')
    const text = (root.querySelector('h1') as HTMLElement).firstChild as Text
    getSelection()?.collapse(text, 2)
    expect(
      key(text.parentElement as Element, { key: 'ArrowUp' }).defaultPrevented,
    ).toBe(false)
    document.body.innerHTML = ''
    const ir = await mount('ir')
    const irText = (ir.querySelector('h1') as HTMLElement).lastChild as Text
    getSelection()?.collapse(irText, 0)
    expect(
      key(irText.parentElement as Element, { key: 'ArrowUp' }).defaultPrevented,
    ).toBe(false)
  })
})
