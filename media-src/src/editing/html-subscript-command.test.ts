// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureHtmlSubscriptCommand,
  installHtmlSubscriptControls,
  sourceLeafSelection,
} from './html-subscript-command'
import { installEscapeToolbar } from './escape-toolbar'

interface Fixture {
  editor: HTMLElement
  button: HTMLButtonElement
  getValue: () => string
  invalidate: ReturnType<typeof vi.fn>
  schedule: ReturnType<typeof vi.fn>
  undo: ReturnType<typeof vi.fn>
  getValueSpy: ReturnType<typeof vi.fn>
  serializeSpy: ReturnType<typeof vi.fn>
  flush: () => void
  dispose: () => void
}

function fixture(
  source = 'H2O',
  leaf = 'p',
  collapseAtCheckpoint = false,
  resetToLeafBoundaryAtSecondCheckpoint = false,
): Fixture {
  document.body.innerHTML = `<div class="vditor-toolbar"><span><button data-type="headings">Headings</button></span><span><button data-type="bold">Bold</button></span><span><button data-type="subscript">Subscript</button></span><span><button data-type="more">More</button></span></div><div class="vditor-ir">${leaf === 'td' ? '<table><tbody><tr><td></td></tr></tbody></table>' : `<${leaf}></${leaf}>`}</div>`
  const button = document.querySelector<HTMLButtonElement>(
    '[data-type="subscript"]',
  )!
  const editor = document.querySelector<HTMLElement>('.vditor-ir')!
  const content =
    leaf === 'td' ? editor.querySelector('td')! : editor.firstElementChild!
  content.textContent = source
  let checkpointCount = 0
  const undo = vi.fn(() => {
    checkpointCount++
    if (!collapseAtCheckpoint) return
    const selection = document.getSelection()
    if (!selection?.rangeCount) return
    const collapsed = document.createRange()
    if (resetToLeafBoundaryAtSecondCheckpoint && checkpointCount === 2)
      collapsed.setStart(content, 0)
    else {
      const range = selection.getRangeAt(0)
      collapsed.setStart(range.startContainer, range.startOffset)
    }
    collapsed.collapse(true)
    selection.removeAllRanges()
    selection.addRange(collapsed)
  })
  const getValueSpy = vi.fn(() => editor.textContent ?? '')
  const serializeSpy = vi.fn((html: string) => {
    const root = document.createElement('div')
    root.innerHTML = html
    return root.textContent ?? ''
  })
  const outer = {
    getValue: getValueSpy,
    setValue: (markdown: string) => {
      content.textContent = markdown
    },
    vditor: {
      currentMode: 'ir',
      ir: { element: editor },
      lute: {
        VditorIRDOM2Md: serializeSpy,
        VditorDOM2Md: (html: string) => html,
      },
      undo: { addToUndoStack: undo },
      toolbar: {
        elements: {
          subscript: button.parentElement!,
          preview: document.createElement('div'),
        },
      },
    },
  }
  ;(window as unknown as { vditor: unknown }).vditor = outer
  const invalidate = vi.fn()
  const schedule = vi.fn()
  configureHtmlSubscriptCommand({
    setApplying: () => undefined,
    invalidate,
    scheduleSync: schedule,
    snapshotMarkdown: outer.getValue,
    onError: (error) => {
      throw error
    },
  })
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  const dispose = installHtmlSubscriptControls()
  const flush = () => {
    for (const callback of frames.splice(0)) callback(0)
  }
  flush()
  return {
    editor,
    button,
    getValue: outer.getValue,
    invalidate,
    schedule,
    undo,
    getValueSpy,
    serializeSpy,
    flush,
    dispose,
  }
}

function tableFixture(): Fixture {
  const result = fixture('unused', 'td')
  const source = [
    '| Left | Right |',
    '| --- | --- |',
    '|  keep  | H2O     |',
  ].join('\n')
  let rendered = source
  const renderTable = (right: string) => {
    result.editor.innerHTML =
      '<table><thead><tr><th>Left</th><th>Right</th></tr></thead><tbody><tr><td>keep</td><td></td></tr></tbody></table>'
    result.editor.querySelectorAll('td')[1]!.textContent = right
  }
  const currentMarkdown = () =>
    source.replace(
      'H2O',
      result.editor.querySelectorAll('td')[1]?.textContent ?? '',
    )
  renderTable('H2O')
  const outer = window.vditor as unknown as {
    getValue(): string
    setValue(markdown: string): void
    vditor: { lute: Record<string, unknown> }
  }
  outer.getValue = currentMarkdown
  outer.setValue = (markdown: string) => {
    const right = /^\|\s*keep\s*\|\s*(.*?)\s*\|$/mu.exec(markdown)?.[1]
    if (right === undefined)
      throw new Error('table cell is missing from rendered Markdown')
    renderTable(right)
  }
  outer.vditor.lute.Md2VditorIRDOM = (markdown: string) => {
    rendered = markdown
    return '<vmde-table-canonical></vmde-table-canonical>'
  }
  outer.vditor.lute.VditorIRDOM2Md = (html: string) => {
    if (html.includes('vmde-table-canonical')) return rendered
    const root = document.createElement('div')
    root.innerHTML = html
    if (root.querySelector('table')) return currentMarkdown()
    return root.textContent ?? ''
  }
  configureHtmlSubscriptCommand({
    setApplying: () => undefined,
    invalidate: () => (result.invalidate as unknown as () => void)(),
    scheduleSync: () => (result.schedule as unknown as () => void)(),
    snapshotMarkdown: outer.getValue,
    onError: (error) => {
      throw error
    },
  })
  return result
}

function select(node: Text, anchor: number, focus: number): void {
  const selection = document.getSelection()!
  selection.removeAllRanges()
  if (selection.setBaseAndExtent) {
    selection.setBaseAndExtent(node, anchor, node, focus)
  } else {
    const range = document.createRange()
    range.setStart(node, Math.min(anchor, focus))
    range.setEnd(node, Math.max(anchor, focus))
    selection.addRange(range)
  }
  document.dispatchEvent(new Event('selectionchange'))
}

function selectAcross(
  anchorNode: Text,
  anchorOffset: number,
  focusNode: Text,
  focusOffset: number,
): void {
  const selection = document.getSelection()!
  selection.removeAllRanges()
  if (selection.setBaseAndExtent) {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  } else {
    const range = document.createRange()
    range.setStart(anchorNode, anchorOffset)
    range.setEnd(focusNode, focusOffset)
    selection.addRange(range)
  }
  document.dispatchEvent(new Event('selectionchange'))
}

function toggle(button: HTMLButtonElement): void {
  button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-subscript'))
}

function keyboardKey(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  )
}

function configureSvFixture(editor: HTMLElement, source: string): void {
  const outer = window.vditor as unknown as {
    getValue(): string
    vditor: { currentMode: string; sv: { element: HTMLElement } }
  }
  outer.vditor.currentMode = 'sv'
  outer.vditor.sv = { element: editor }
  outer.getValue = () => source
}

describe('HTML SUB command', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
    delete (window as unknown as { vditor?: unknown }).vditor
  })

  it('uses two transient markers, restores a noncollapsed selection, and syncs only after they are removed', () => {
    const {
      editor,
      button,
      getValue,
      invalidate,
      schedule,
      undo,
      flush,
      dispose,
    } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()
    toggle(button)

    expect(getValue()).toBe('H<sub>2</sub>O')
    expect(editor.textContent).not.toContain('VMDE_SUBSCRIPT')
    expect(document.getSelection()?.toString()).toBe('2')
    expect(invalidate).toHaveBeenCalledOnce()
    expect(schedule).toHaveBeenCalledOnce()
    expect(undo).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('preserves a backward range through the render transaction', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 2, 1)
    flush()
    toggle(button)

    const selection = document.getSelection()!
    expect(getValue()).toBe('H<sub>2</sub>O')
    expect(selection.toString()).toBe('2')
    expect(selection.anchorOffset).toBeGreaterThan(selection.focusOffset)
    dispose()
  })

  it('rejects a stale target before it checkpoints or changes the document', () => {
    const { editor, button, getValue, undo, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    editor.querySelector('p')!.textContent = 'changed'
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('changed')
    expect(undo).not.toHaveBeenCalled()
    dispose()
  })

  it('disables a partial existing wrapper selection instead of nesting another wrapper', () => {
    const { editor, button, getValue, flush, dispose } =
      fixture('<sub>abc</sub>')
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 5, 6)
    flush()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.classList.contains('vditor-menu--current')).toBe(true)
    toggle(button)
    expect(getValue()).toBe('<sub>abc</sub>')
    dispose()
  })

  it('replaces a former range with a new empty editor caret before activation', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()
    select(text, 1, 1)
    flush()

    expect(button.disabled).toBe(false)
    toggle(button)

    expect(getValue()).toBe('H<sub></sub>2O')
    dispose()
  })

  it('restores an empty insertion caret after the final undo checkpoint changes it', () => {
    const { editor, button, getValue, flush, dispose } = fixture(
      'H2O',
      'p',
      true,
      true,
    )
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 1)
    flush()
    toggle(button)

    const finalText = editor.querySelector('p')!.firstChild as Text
    expect(getValue()).toBe('H<sub></sub>2O')
    expect(document.getSelection()?.anchorNode).toBe(finalText)
    expect(document.getSelection()?.anchorOffset).toBe(6)
    dispose()
  })

  it('keeps the editor range when keyboard focus enters the toolbar control', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()

    button.focus()
    const toolbarText = button.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H<sub>2</sub>O')
    dispose()
  })

  it('keeps the editor range while roving through an earlier toolbar button', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()

    const bold =
      document.querySelector<HTMLButtonElement>('[data-type="bold"]')!
    bold.focus()
    const toolbarText = bold.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    button.focus()
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H<sub>2</sub>O')
    dispose()
  })

  it('keeps the editor range while keyboard focus enters More then Subscript', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()

    const more =
      document.querySelector<HTMLButtonElement>('[data-type="more"]')!
    more.parentElement!.classList.add('vmde-toolbar-more')
    more.parentElement!.append(button.parentElement!)
    more.focus()
    const moreText = more.firstChild as Text
    select(moreText, 0, moreText.data.length)
    button.focus()
    const toolbarText = button.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H<sub>2</sub>O')
    dispose()
  })

  it('keeps an exact WYSIWYG wrapper selection enabled through Vditor zero-width markers', () => {
    const { editor, button, flush, dispose } = fixture(
      'Action H\u200b<sub>2\u200b</sub>O',
    )
    const outer = window.vditor as unknown as {
      getValue(): string
      vditor: {
        currentMode: string
        wysiwyg: { element: HTMLElement }
        lute: { VditorDOM2Md(html: string): string }
      }
    }
    outer.vditor.currentMode = 'wysiwyg'
    outer.vditor.wysiwyg = { element: editor }
    outer.getValue = () => 'Action H<sub>2</sub>O'
    outer.vditor.lute.VditorDOM2Md = (html) => {
      const root = document.createElement('div')
      root.innerHTML = html
      return (root.textContent ?? '').replaceAll('\u200b', '')
    }
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 14, 15)
    flush()

    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    dispose()
  })

  it('keeps an authored SV zero-width character as a partial SUB body selection', () => {
    const { editor, button, flush, dispose } = fixture('A<sub>a\u200bb</sub>Z')
    configureSvFixture(editor, 'A<sub>a\u200bb</sub>Z')
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 7, 8)
    flush()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    dispose()
  })

  it('disables an SV selection inside a fenced block without changing source', () => {
    const source = '```\nH2O\n```'
    const { editor, button, getValue, flush, dispose } = fixture(source)
    configureSvFixture(editor, source)
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 5, 6)
    flush()

    expect(button.disabled).toBe(true)
    toggle(button)
    expect(getValue()).toBe(source)
    dispose()
  })

  it('disables an SV selection across prose paragraphs without changing source', () => {
    const source = 'First H2O\n\nSecond H2O'
    const { editor, button, getValue, flush, dispose } = fixture(source)
    configureSvFixture(editor, source)
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 6, 18)
    flush()

    expect(button.disabled).toBe(true)
    toggle(button)
    expect(getValue()).toBe(source)
    dispose()
  })

  it('disables an SV selection inside an HTML tag without changing source', () => {
    const source = 'H<sub>2</sub>O'
    const { editor, button, getValue, flush, dispose } = fixture(source)
    configureSvFixture(editor, source)
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 2, 3)
    flush()

    expect(button.disabled).toBe(true)
    toggle(button)
    expect(getValue()).toBe(source)
    dispose()
  })

  it('uses the consumed Escape toolbar origin after structural selection widens live range', () => {
    const { editor, getValue, flush, dispose } = fixture()
    const escapeDispose = installEscapeToolbar()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 2, 1)
    flush()
    keyboardKey('Escape')
    select(text, 3, 0)
    flush()
    keyboardKey('Tab')
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H<sub>2</sub>O')
    escapeDispose()
    dispose()
  })

  it('cancels an invalid consumed Escape toolbar origin instead of formatting its widened range', () => {
    const { editor, getValue, flush, dispose } = fixture()
    const escapeDispose = installEscapeToolbar()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 2, 1)
    flush()
    keyboardKey('Escape')
    select(text, 3, 0)
    flush()
    keyboardKey('Tab')
    text.data = 'H3O'
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H3O')
    escapeDispose()
    dispose()
  })

  it('gives a fresh pointer selection priority over a consumed Escape toolbar origin', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const escapeDispose = installEscapeToolbar()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 2, 1)
    flush()
    keyboardKey('Escape')
    select(text, 3, 0)
    flush()
    keyboardKey('Tab')
    select(text, 0, 1)
    toggle(button)

    expect(getValue()).toBe('<sub>H</sub>2O')
    escapeDispose()
    dispose()
  })

  it('clears the former editor range when focus moves outside the owned toolbar menu', () => {
    const { editor, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()

    const outside = document.createElement('button')
    outside.textContent = 'Outside'
    document.body.append(outside)
    outside.focus()
    const outsideText = outside.firstChild as Text
    select(outsideText, 0, outsideText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H2O')
    dispose()
  })

  it('invalidates a retained editor range after an input edit before keyboard activation', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 1, 2)
    flush()
    button.focus()
    text.data = 'H3O'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H3O')
    dispose()
  })

  it('drops a former valid range when the new selection enters unsupported code', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const paragraph = editor.querySelector('p')!
    const text = paragraph.firstChild as Text
    select(text, 1, 2)
    flush()
    paragraph.innerHTML = 'H<code>2</code>O'
    const codeText = paragraph.querySelector('code')!.firstChild as Text
    select(codeText, 0, 1)
    flush()

    expect(button.disabled).toBe(true)
    button.focus()
    const toolbarText = button.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H2O')
    dispose()
  })

  it('lets an unsupported live editor range clear retention even while More owns focus', () => {
    const { editor, button, getValue, flush, dispose } = fixture('H2Ox')
    const paragraph = editor.querySelector('p')!
    const text = paragraph.firstChild as Text
    select(text, 1, 2)
    flush()
    const more =
      document.querySelector<HTMLButtonElement>('[data-type="more"]')!
    more.parentElement!.classList.add('vmde-toolbar-more')
    more.focus()
    const code = document.createElement('code')
    code.textContent = 'code'
    paragraph.append(code)
    const codeText = code.firstChild as Text
    select(codeText, 0, 1)
    button.focus()
    const toolbarText = button.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H2Oxcode')
    dispose()
  })

  it('drops a former valid range when the new selection crosses editor leaves', () => {
    const { editor, button, getValue, flush, dispose } = fixture()
    const paragraph = editor.querySelector('p')!
    const text = paragraph.firstChild as Text
    select(text, 1, 2)
    flush()
    const sibling = document.createElement('p')
    sibling.textContent = 'other'
    editor.append(sibling)
    selectAcross(
      text,
      1,
      sibling.firstChild as Text,
      (sibling.firstChild as Text).data.length,
    )
    flush()

    expect(button.disabled).toBe(true)
    button.focus()
    const toolbarText = button.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getValue()).toBe('H2Oother')
    dispose()
  })

  it('disables a selection that crosses an authored SUB wrapper boundary', () => {
    const { editor, button, getValue, flush, dispose } =
      fixture('<sub>abc</sub>d')
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 5, 15)
    flush()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('mixed')
    toggle(button)

    expect(getValue()).toBe('<sub>abc</sub>d')
    dispose()
  })

  it('does not serialize or read markdown while selection changes are coalesced into a frame', () => {
    const { editor, flush, getValueSpy, serializeSpy, dispose } = fixture()
    const text = editor.querySelector('p')!.firstChild as Text
    getValueSpy.mockClear()
    serializeSpy.mockClear()

    select(text, 1, 1)
    select(text, 1, 2)
    flush()

    expect(getValueSpy).not.toHaveBeenCalled()
    expect(serializeSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('accepts the independent table canonical form after actual DOM replacement', () => {
    const { editor, button, flush, dispose } = tableFixture()
    const getTableValue = () =>
      (window.vditor as NonNullable<Window['vditor']>).getValue()
    const text = editor.querySelectorAll('td')[1]!.firstChild as Text
    select(text, 1, 2)
    flush()
    expect(button.disabled).toBe(false)
    expect(text.parentElement?.closest('td')).not.toBeNull()
    toggle(button)

    expect(getTableValue()).toBe(
      [
        '| Left | Right |',
        '| --- | --- |',
        '|  keep  | H<sub>2</sub>O     |',
      ].join('\n'),
    )
    expect(editor.querySelectorAll('td')[1]?.textContent).toBe('H<sub>2</sub>O')
    dispose()
  })

  it('uses the current table selection when pointerdown arrives before selectionchange', () => {
    const { editor, button, flush, dispose } = tableFixture()
    const getTableValue = () =>
      (window.vditor as NonNullable<Window['vditor']>).getValue()
    const text = editor.querySelectorAll('td')[1]!.firstChild as Text
    select(text, 0, 1)
    flush()

    const selection = document.getSelection()!
    selection.removeAllRanges()
    const current = document.createRange()
    current.setStart(text, 1)
    current.setEnd(text, 2)
    selection.addRange(current)
    toggle(button)

    expect(getTableValue()).toBe(
      [
        '| Left | Right |',
        '| --- | --- |',
        '|  keep  | H<sub>2</sub>O     |',
      ].join('\n'),
    )
    dispose()
  })

  it('keeps a pending table pointer transaction enabled after toolbar focus clears the live selection', () => {
    const { editor, button, flush, dispose } = tableFixture()
    const getTableValue = () =>
      (window.vditor as NonNullable<Window['vditor']>).getValue()
    const text = editor.querySelectorAll('td')[1]!.firstChild as Text
    select(text, 1, 2)
    flush()

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    button.focus()
    const toolbarText = button.firstChild as Text
    const selection = document.getSelection()!
    selection.removeAllRanges()
    const sentinel = document.createRange()
    sentinel.selectNodeContents(toolbarText)
    selection.addRange(sentinel)
    document.dispatchEvent(new Event('selectionchange'))
    flush()

    expect(button.disabled).toBe(false)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))
    expect(getTableValue()).toBe(
      [
        '| Left | Right |',
        '| --- | --- |',
        '|  keep  | H<sub>2</sub>O     |',
      ].join('\n'),
    )
    dispose()
  })

  it('retains active pending state while focus is in the toolbar', () => {
    const active = fixture('<sub>2</sub>')
    const activeText = active.editor.querySelector('p')!.firstChild as Text
    select(activeText, 5, 6)
    active.flush()
    active.button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    active.button.focus()
    select(active.button.firstChild as Text, 0, 9)
    active.flush()
    expect(active.button.disabled).toBe(false)
    expect(active.button.getAttribute('aria-pressed')).toBe('true')
    active.dispose()
  })

  it('keeps an observable mixed disabled state while More owns toolbar focus', () => {
    const { editor, button, flush, dispose } = fixture('<sub>abc</sub>d')
    const text = editor.querySelector('p')!.firstChild as Text
    select(text, 5, 15)
    flush()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('mixed')

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    const more =
      document.querySelector<HTMLButtonElement>('[data-type="more"]')!
    more.parentElement!.classList.add('vmde-toolbar-more')
    more.parentElement!.append(button.parentElement!)
    more.focus()
    const toolbarText = more.firstChild as Text
    select(toolbarText, 0, toolbarText.data.length)
    flush()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('mixed')
    dispose()
  })

  it('restores a pending table selection through a native text split', () => {
    const { editor, button, flush, dispose } = tableFixture()
    const getTableValue = () =>
      (window.vditor as NonNullable<Window['vditor']>).getValue()
    const text = editor.querySelectorAll('td')[1]!.firstChild as Text
    select(text, 1, 2)
    flush()

    button.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    text.splitText(1)
    document.dispatchEvent(new Event('vmde-toggle-subscript'))

    expect(getTableValue()).toBe(
      [
        '| Left | Right |',
        '| --- | --- |',
        '|  keep  | H<sub>2</sub>O     |',
      ].join('\n'),
    )
    dispose()
  })

  it('rolls back an actual table DOM replacement when the cell text changes', () => {
    const { editor, button, invalidate, schedule, flush, dispose } =
      tableFixture()
    const outer = window.vditor as unknown as {
      getValue(): string
      setValue(markdown: string): void
      vditor: { lute: Record<string, unknown> }
    }
    const originalSetValue = outer.setValue
    outer.setValue = (markdown: string) =>
      originalSetValue(
        markdown.includes('VMDE_SUBSCRIPT')
          ? markdown.replace('2', '3')
          : markdown,
      )
    const text = editor.querySelectorAll('td')[1]!.firstChild as Text
    select(text, 1, 2)
    flush()
    toggle(button)

    expect(outer.getValue()).toBe(
      ['| Left | Right |', '| --- | --- |', '|  keep  | H2O     |'].join('\n'),
    )
    expect(editor.querySelectorAll('td')[1]?.textContent).toBe('H2O')
    expect(invalidate).not.toHaveBeenCalled()
    expect(schedule).not.toHaveBeenCalled()
    dispose()
  })

  it('fails closed for source selections inside containing fences and raw HTML blocks', () => {
    expect(
      sourceLeafSelection('```\nH2O\n```', {
        markdown: '```\nH2O\n```',
        startOffset: 5,
        endOffset: 6,
        caretOffset: 6,
      }),
    ).toBeNull()
    expect(
      sourceLeafSelection('<div>\nH2O\n</div>', {
        markdown: '<div>\nH2O\n</div>',
        startOffset: 7,
        endOffset: 8,
        caretOffset: 8,
      }),
    ).toBeNull()
  })

  it('admits only a direct inline list item as a leaf', () => {
    const direct = fixture('H2O', 'li')
    select(direct.editor.querySelector('li')!.firstChild as Text, 1, 2)
    direct.flush()
    expect(direct.button.disabled).toBe(false)
    toggle(direct.button)
    expect(direct.getValue()).toBe('H<sub>2</sub>O')
    direct.dispose()

    const nested = fixture('H2O', 'li')
    nested.editor.querySelector('li')!.innerHTML = '<p>H2O</p>'
    select(nested.editor.querySelector('p')!.firstChild as Text, 1, 2)
    nested.flush()
    expect(nested.button.disabled).toBe(false)
    nested.dispose()
  })
})
