// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureFindReplaceActions,
  installFindReplace,
  installStructuralSelection,
  openFindReplace,
  runFindWidgetAction,
} from './selection-scope'
import { invalidateCaret, requestCaret } from './caret'
import type { FindWidgetAction } from '../../../src/shared/protocol'

let dispose: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom has no painted ranges. Keep the real SV mapper/selection and transaction paths while
  // providing the geometry and frame scheduling supplied by Chromium in integration tests.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => [],
  })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  invalidateCaret()
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
  delete (window as any).vditor
  delete (Range.prototype as Partial<Range>).getClientRects
  delete (Range.prototype as Partial<Range>).getBoundingClientRect
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function mount(markdown = 'alpha beta alpha') {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.tabIndex = 0
  editor.textContent = markdown
  document.body.append(editor)
  const addToUndoStack = vi.fn()
  const postExact = vi.fn()
  const reportState = vi.fn()
  const getValue = vi.fn(() => editor.textContent ?? '')
  const setValue = vi.fn((text: string) => {
    editor.textContent = text
  })
  ;(window as any).vditor = {
    vditor: {
      currentMode: 'sv',
      sv: { element: editor },
      undo: { addToUndoStack },
    },
    getValue,
    setValue,
  }
  configureFindReplaceActions({
    setApplying: vi.fn(),
    postExact,
    onError: vi.fn(),
    reportState,
  })
  const snapshotPair = vi.fn(() => ({
    exact: getValue(),
    rendered: getValue(),
  }))
  const revision = {}
  dispose = installFindReplace(document, {
    snapshotPair,
    snapshotRevision: () => revision,
  })
  const root = document.querySelector<HTMLElement>('.vmde-find-replace')!
  const find = root.querySelector<HTMLInputElement>('[data-find]')!
  const replace = root.querySelector<HTMLInputElement>('[data-replace]')!
  const toggle = root.querySelector<HTMLButtonElement>(
    '[data-action="toggle-replace"]',
  )!
  const row = replace.closest<HTMLElement>('.vmde-find-replace__row')!
  const button = (action: string) =>
    root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!
  const status = () => root.querySelector('[role="status"]')!.textContent
  const query = (text: string) => {
    find.value = text
    find.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return {
    editor,
    root,
    find,
    replace,
    toggle,
    row,
    button,
    status,
    query,
    postExact,
    reportState,
    snapshotPair,
    setValue,
    addToUndoStack,
  }
}

function select(node: Node, start: number, end = start, endNode = node) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(endNode, end)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

function key(
  target: HTMLElement,
  key: string,
  modifiers: KeyboardEventInit = {},
) {
  const forwarded = vi.fn()
  window.addEventListener('keydown', forwarded)
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  target.dispatchEvent(event)
  window.removeEventListener('keydown', forwarded)
  return { event, forwarded }
}

function expectSelected(input: HTMLInputElement) {
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([
    0,
    input.value.length,
  ])
}

describe('VS Code Find widget reference behavior (Task 579)', () => {
  it.each([
    {
      platform: 'Linux x86_64',
      names: {
        case: 'Match Case (Alt+C)',
        word: 'Match Whole Word (Alt+W)',
        previous: 'Previous Match (Shift+Enter)',
        next: 'Next Match (Enter)',
        replace: 'Replace (Enter)',
        'replace-all': 'Replace All (Ctrl+Alt+Enter)',
      },
    },
    {
      platform: 'MacIntel',
      names: {
        case: 'Match Case (Alt+Cmd+C)',
        word: 'Match Whole Word (Alt+Cmd+W)',
        previous: 'Previous Match (Shift+Cmd+G)',
        next: 'Next Match (Cmd+G)',
        replace: 'Replace (Shift+Cmd+1)',
        'replace-all': 'Replace All (Alt+Cmd+Enter)',
      },
    },
  ])(
    'uses $platform shortcut hints and input-embedded checkboxes',
    ({ platform, names }) => {
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
      const view = mount()
      openFindReplace('replace')
      for (const [action, name] of Object.entries(names)) {
        const button = view.button(action)
        expect(button.tagName).toBe('BUTTON')
        expect(button.getAttribute('type')).toBe('button')
        expect(button.getAttribute('aria-label')).toBe(name)
      }
      for (const action of ['case', 'word']) {
        const button = view.button(action)
        expect(button.getAttribute('role')).toBe('checkbox')
        expect(button.getAttribute('aria-checked')).toBe('false')
        expect(button.closest('.vmde-find-replace__input-wrap')).toBe(
          view.find.parentElement,
        )
      }
      expect(view.button('close').getAttribute('aria-label')).toBe(
        'Close (Escape)',
      )
      expect(view.find.getAttribute('aria-label')).toBe('Find')
      expect(view.replace.getAttribute('aria-label')).toBe('Replace')
      expect(view.toggle.querySelector('svg')).not.toBeNull()
      expect(view.button('previous').querySelector('svg')).not.toBeNull()
      view.query('absent term')
      expect(view.status()).toBe('No results')
      expect(
        view.root
          .querySelector('[data-status]')
          ?.getAttribute('data-no-results'),
      ).toBe('true')
    },
  )

  it('opens Find-only, seeds the caret word, selects Find and hides Replace from layout/a11y', () => {
    const view = mount()
    select(view.editor.firstChild!, 2)
    openFindReplace('find')
    expect(view.root.hidden).toBe(false)
    expect(view.root.getAttribute('aria-hidden')).toBe('false')
    expect(view.find.value).toBe('alpha')
    expectSelected(view.find)
    expect(view.status()).toBe('1 of 2')
    expect(view.row.hidden).toBe(true)
    expect(view.toggle.getAttribute('aria-label')).toBe('Toggle Replace')
    expect(view.toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.toggle.getAttribute('aria-controls')).toBe(view.row.id)
    // Use the shipped visibility rules: display:none removes the row and all its descendants
    // from the accessibility tree. jsdom itself cannot expose a native accessibility snapshot.
    const css = readFileSync('media-src/src/main.css', 'utf8')
    const style = document.createElement('style')
    style.textContent = Array.from(
      css.matchAll(/\.vmde-find-replace__row(?:\[hidden\])?\s*\{[^}]*\}/g),
      ([rule]) => rule,
    ).join('\n')
    document.body.append(style)
    expect(getComputedStyle(view.row).display).toBe('none')
    for (const control of [
      view.replace,
      view.button('replace'),
      view.button('replace-all'),
    ])
      expect(control.closest('[hidden]')).toBe(view.row)
    view.toggle.click()
    expect(getComputedStyle(view.row).display).toBe('flex')
  })

  it('ignores button, message and key replace attempts while collapsed or closed', () => {
    const view = mount()
    openFindReplace('find')
    view.query('alpha')
    view.replace.value = 'omega'
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    for (const closed of [false, true]) {
      if (closed) runFindWidgetAction('close')
      const reads = view.snapshotPair.mock.calls.length
      view.button('replace').click()
      view.button('replace-all').click()
      runFindWidgetAction('replace-one')
      runFindWidgetAction('replace-all')
      key(view.replace, 'Enter')
      key(view.replace, 'Enter', { metaKey: true })
      expect(view.snapshotPair).toHaveBeenCalledTimes(reads)
      expect(view.editor.textContent).toBe('alpha beta alpha')
      expect(view.setValue).not.toHaveBeenCalled()
      expect(view.postExact).not.toHaveBeenCalled()
      expect(view.addToUndoStack).not.toHaveBeenCalled()
    }
  })

  it.each(['find', 'replace'] as const)(
    'opening %s retires an earlier editor caret retry before focusing Find',
    async (mode) => {
      const view = mount()
      const text = view.editor.firstChild!
      requestCaret({
        anchor: { node: text, offset: 6 },
        focus: { node: text, offset: 10 },
      })
      openFindReplace(mode)
      expectSelected(view.find)
      expect(view.find.value).toBe('beta')
      const selection = window.getSelection()!
      // The real-webview trace shows input selection provoking a retry of the old editor Range.
      // jsdom retains that Range, so clear it to expose any still-armed authority on the next frame.
      selection.removeAllRanges()
      const replay = vi.spyOn(selection, 'setBaseAndExtent')
      await vi.advanceTimersByTimeAsync(100)
      expect(replay).not.toHaveBeenCalled()
      expectSelected(view.find)
      expect(view.postExact).not.toHaveBeenCalled()
      expect(view.addToUndoStack).not.toHaveBeenCalled()
    },
  )

  it('Ctrl+H from Find focuses Replace; Ctrl+F preserves the expanded row, query/options/match', () => {
    const view = mount('alpha alpha Alpha alphabet')
    openFindReplace('find')
    view.query('alpha')
    runFindWidgetAction('toggle-case')
    runFindWidgetAction('toggle-whole-word')
    runFindWidgetAction('next')
    expect(view.status()).toBe('2 of 2')
    view.replace.value = 'omega'
    const reads = view.snapshotPair.mock.calls.length
    openFindReplace('replace')
    expectSelected(view.replace)
    expect(view.row.hidden).toBe(false)
    expect(view.toggle.getAttribute('aria-expanded')).toBe('true')
    openFindReplace('find')
    expectSelected(view.find)
    expect(view.row.hidden).toBe(false)
    expect(view.find.value).toBe('alpha')
    expect(view.replace.value).toBe('omega')
    expect(view.button('case').getAttribute('aria-checked')).toBe('true')
    expect(view.button('word').getAttribute('aria-checked')).toBe('true')
    expect(view.status()).toBe('2 of 2')
    expect(view.snapshotPair).toHaveBeenCalledTimes(reads)
    expect(view.reportState.mock.calls).toEqual([[true]])
  })

  it.each(['replace', 'toggle', 'editor'] as const)(
    'Ctrl+H with %s focused expands and selects Find',
    (focused) => {
      const view = mount()
      openFindReplace('find')
      view.query('alpha')
      if (focused === 'replace') view.toggle.click()
      view[focused].focus()
      openFindReplace('replace')
      expectSelected(view.find)
      expect(view.row.hidden).toBe(false)
    },
  )

  it('Find invoked while already Find-only retains that mode and selects its unchanged query', () => {
    const view = mount()
    openFindReplace('find')
    view.query('beta')
    view.editor.focus()
    select(view.editor.firstChild!, 2)
    const reads = view.snapshotPair.mock.calls.length
    openFindReplace('find')
    expect(view.row.hidden).toBe(true)
    expect(view.find.value).toBe('beta')
    expectSelected(view.find)
    expect(view.snapshotPair).toHaveBeenCalledTimes(reads)
  })

  it('option commands update counts without moving input focus', () => {
    const view = mount('Alpha alpha alphabet alpha')
    openFindReplace('find')
    view.query('alpha')
    expect(view.status()).toBe('1 of 4')
    runFindWidgetAction('toggle-case')
    expect(view.status()).toBe('1 of 3')
    expect(document.activeElement).toBe(view.find)
    runFindWidgetAction('toggle-whole-word')
    expect(view.status()).toBe('1 of 2')
    expect(document.activeElement).toBe(view.find)
  })

  it('next/previous commands navigate, wrap and select the match while Find retains focus', () => {
    const view = mount()
    openFindReplace('find')
    view.query('alpha')
    runFindWidgetAction('next')
    expect(view.status()).toBe('2 of 2')
    expect(document.getSelection()?.toString()).toBe('alpha')
    expect(document.getSelection()?.anchorOffset).toBe(11)
    expect(document.activeElement).toBe(view.find)
    runFindWidgetAction('next')
    expect(view.status()).toBe('1 of 2')
    runFindWidgetAction('previous')
    expect(view.status()).toBe('2 of 2')
    expect(document.activeElement).toBe(view.find)
  })

  it('toggle collapses/expands with focus on the toggle and preserves replacement and current match', () => {
    const view = mount()
    openFindReplace('replace')
    view.query('alpha')
    runFindWidgetAction('next')
    view.replace.value = 'omega'
    view.replace.focus()
    const reads = view.snapshotPair.mock.calls.length
    for (const expanded of [false, true]) {
      view.toggle.click()
      expect(view.toggle.getAttribute('aria-expanded')).toBe(String(expanded))
      expect(view.row.hidden).toBe(!expanded)
      expect(document.activeElement).toBe(view.toggle)
      expect(view.replace.value).toBe('omega')
      expect(view.status()).toBe('2 of 2')
    }
    expect(view.snapshotPair).toHaveBeenCalledTimes(reads)
  })

  it.each(['Enter', 'replace-one', 'replace-all'] as const)(
    '%s replaces exactly and retains Replace focus',
    (action) => {
      const view = mount()
      openFindReplace('replace')
      view.query('alpha')
      view.replace.value = 'omega'
      view.replace.focus()
      if (action === 'Enter') {
        const { event, forwarded } = key(view.replace, 'Enter')
        expect(event.defaultPrevented).toBe(true)
        expect(forwarded).not.toHaveBeenCalled()
      } else runFindWidgetAction(action)
      expect(document.activeElement).toBe(view.replace)
      vi.advanceTimersByTime(32)
      expect(document.activeElement).toBe(view.replace)
      expect(view.postExact).toHaveBeenCalledExactlyOnceWith(
        action === 'replace-all' ? 'omega beta omega' : 'omega beta alpha',
      )
      expect(view.addToUndoStack).toHaveBeenCalledTimes(2)
      expect(view.status()).toBe(
        action === 'replace-all' ? 'No results' : '1 of 1',
      )
    },
  )

  it.each([false, true])(
    'Escape (shift=%s) closes, reports state once and returns focus',
    (shiftKey) => {
      const view = mount()
      openFindReplace('replace')
      view.replace.focus()
      const { event, forwarded } = key(view.replace, 'Escape', { shiftKey })
      expect(event.defaultPrevented).toBe(true)
      expect(forwarded).not.toHaveBeenCalled()
      expect(view.root.hidden).toBe(true)
      expect(view.root.getAttribute('aria-hidden')).toBe('true')
      expect(document.activeElement).toBe(view.editor)
      runFindWidgetAction('close')
      expect(view.reportState.mock.calls).toEqual([[true], [false]])
    },
  )

  it('lets Find own Escape with a retained IR selection, including when focus returns to the editor', () => {
    const view = mount()
    view.editor.innerHTML = '<p data-block="0">alpha beta alpha</p>'
    const inner = (window as any).vditor.vditor
    inner.currentMode = 'ir'
    inner.ir = { element: view.editor }
    const stopStructural = installStructuralSelection()
    try {
      openFindReplace('replace')
      select(view.editor.querySelector('p')!.firstChild!, 7)
      view.find.focus()
      expect(document.activeElement).toBe(view.find)
      expect(document.getSelection()?.getRangeAt(0).startContainer).toBe(
        view.editor.querySelector('p')!.firstChild,
      )
      const inFindSelectAll = key(view.find, 'a', { ctrlKey: true })
      expect(inFindSelectAll.event.defaultPrevented).toBe(false)
      expect(inFindSelectAll.forwarded).toHaveBeenCalledOnce()
      const inFind = key(view.find, 'Escape')
      expect(inFind.event.defaultPrevented).toBe(true)
      expect(view.root.hidden).toBe(true)

      openFindReplace('replace')
      view.editor.focus()
      const inEditor = key(view.editor, 'Escape')
      expect(inEditor.event.defaultPrevented).toBe(false)
      expect(inEditor.forwarded).toHaveBeenCalledOnce()
      runFindWidgetAction('close')
      expect(view.root.hidden).toBe(true)
    } finally {
      stopStructural()
    }
  })

  it.each(['find', 'replace'] as const)(
    'reopens closed Replace as requested %s, reseeding and focusing Find',
    (mode) => {
      const view = mount()
      openFindReplace('replace')
      view.query('alpha')
      runFindWidgetAction('close')
      select(view.editor.firstChild!, 6, 10)
      openFindReplace(mode)
      expect(view.row.hidden).toBe(mode === 'find')
      expect(view.find.value).toBe('beta')
      expectSelected(view.find)
      expect(view.reportState.mock.calls).toEqual([[true], [false], [true]])
    },
  )

  it('Replace from closed with a caret seeds its word and selects Find', () => {
    const view = mount()
    select(view.editor.firstChild!, 8)
    openFindReplace('replace')
    expect(view.find.value).toBe('beta')
    expect(view.row.hidden).toBe(false)
    expectSelected(view.find)
  })

  it('reports hidden when disposed and ignores subsequent widget actions', () => {
    const view = mount()
    openFindReplace('find')
    dispose!()
    dispose = undefined
    runFindWidgetAction('close')
    expect(view.reportState.mock.calls).toEqual([[true], [false]])
  })

  it('keeps button navigation, option toggles and Close on the same action path', () => {
    const view = mount('Alpha alpha alphabet alpha')
    openFindReplace('find')
    view.query('alpha')
    view.button('next').click()
    expect(view.status()).toBe('2 of 4')
    view.button('previous').click()
    expect(view.status()).toBe('1 of 4')
    view.button('case').click()
    expect(view.status()).toBe('1 of 3')
    view.button('word').click()
    expect(view.status()).toBe('1 of 2')
    view.button('close').click()
    expect(view.root.hidden).toBe(true)
    expect(document.activeElement).toBe(view.editor)
    expect(view.reportState.mock.calls).toEqual([[true], [false]])
  })

  it('leaves focus in the editor when a replace command originates there', () => {
    const view = mount()
    openFindReplace('replace')
    view.query('alpha')
    view.replace.value = 'omega'
    view.editor.focus()
    runFindWidgetAction('replace-one')
    vi.advanceTimersByTime(32)
    expect(view.postExact).toHaveBeenCalledExactlyOnceWith('omega beta alpha')
    expect(document.activeElement).toBe(view.editor)
    expect(view.status()).toBe('1 of 1')
  })

  it('does not refocus the widget if closed before replacement finishes its caret frame', () => {
    const view = mount()
    openFindReplace('replace')
    view.query('alpha')
    view.replace.value = 'omega'
    view.replace.focus()
    runFindWidgetAction('replace-one')
    runFindWidgetAction('close')
    vi.advanceTimersByTime(32)
    expect(view.root.hidden).toBe(true)
    expect(document.activeElement).toBe(view.editor)
    expect(view.reportState.mock.calls).toEqual([[true], [false]])
  })

  it('remembers an open mode received before installation', () => {
    openFindReplace('find')
    const view = mount()
    expect(view.root.hidden).toBe(false)
    expect(view.row.hidden).toBe(true)
    expectSelected(view.find)
    expect(view.reportState.mock.calls).toEqual([[true]])
  })
})

describe('Find seeding', () => {
  it('prefers a nonempty single-line selection over the caret word without editing source', () => {
    const view = mount('alpha beta alpha')
    select(view.editor.firstChild!, 2, 9)
    const before = view.editor.innerHTML
    openFindReplace('find')
    expect(view.find.value).toBe('pha bet')
    expect(view.editor.innerHTML).toBe(before)
    expectSelected(view.find)
    expect(view.setValue).not.toHaveBeenCalled()
    expect(view.postExact).not.toHaveBeenCalled()
  })

  it.each(['ir', 'wysiwyg', 'sv'])(
    'seeds Unicode words across adjacent split text nodes in %s',
    (mode) => {
      const view = mount('hello café!')
      ;(window as any).vditor.vditor.currentMode = mode
      ;(window as any).vditor.vditor[mode] = { element: view.editor }
      view.editor.replaceChildren('hello ca', 'fé!')
      select(view.editor.lastChild!, 0)
      openFindReplace('find')
      expect(view.find.value).toBe('café')
    },
  )

  it.each(['newline', 'blocks', 'br'] as const)(
    'keeps the old query for a multiline %s selection',
    (shape) => {
      const view = mount('alpha\nbeta')
      view.find.value = 'previous'
      if (shape === 'newline') select(view.editor.firstChild!, 0, 10)
      else {
        view.editor.innerHTML =
          shape === 'blocks'
            ? '<p>alpha</p><p>beta</p>'
            : '<p>alpha<br>beta</p>'
        const first = view.editor.querySelector('p')!.firstChild!
        const last = view.editor.querySelector('p:last-child')!.lastChild!
        select(first, 0, 4, last)
      }
      openFindReplace('find')
      expect(view.find.value).toBe('previous')
    },
  )

  it.each([
    '.vditor-ir__preview',
    '[data-render]',
    'svg',
    '[contenteditable="false"]',
    '.vditor-ir__marker',
  ])(
    'skips rendered/helper text in %s even if it also occurs in source',
    (selector) => {
      const view = mount('alpha')
      const preview = document.createElement(
        selector === 'svg' ? 'svg' : 'span',
      )
      if (selector.startsWith('.')) preview.className = selector.slice(1)
      if (selector === '[data-render]') preview.setAttribute('data-render', '1')
      if (selector === '[contenteditable="false"]')
        preview.setAttribute('contenteditable', 'false')
      preview.textContent = 'alpha'
      view.editor.replaceChildren(preview)
      view.find.value = 'previous'
      select(preview.firstChild!, 1, 4)
      openFindReplace('find')
      expect(view.find.value).toBe('previous')
    },
  )

  it('skips a visible phrase whose source contains Markdown delimiters', () => {
    const view = mount('alpha **beta**')
    view.editor.innerHTML = 'alpha <strong>beta</strong>'
    view.snapshotPair.mockReturnValue({
      exact: 'alpha **beta**',
      rendered: 'alpha **beta**',
    })
    view.find.value = 'previous'
    select(view.editor.firstChild!, 0, 4, view.editor.lastChild!.firstChild!)
    openFindReplace('find')
    expect(view.find.value).toBe('previous')
  })

  it.each(['absent', 'outside', 'whitespace', 'empty'] as const)(
    'keeps the previous query for an %s caret',
    (kind) => {
      const view = mount('alpha  beta')
      view.find.value = 'previous'
      if (kind === 'whitespace') select(view.editor.firstChild!, 6)
      if (kind === 'empty') {
        view.editor.replaceChildren()
        select(view.editor, 0)
      }
      if (kind === 'outside') {
        const other = document.createElement('p')
        other.textContent = 'outside'
        document.body.append(other)
        select(other.firstChild!, 2)
      }
      openFindReplace('find')
      expect(view.find.value).toBe('previous')
    },
  )
})

describe('element-boundary Find seeds', () => {
  it.each([0, 1])(
    'seeds a word at an element-container caret edge %s',
    (offset) => {
      const view = mount('alpha')
      select(view.editor, offset)
      openFindReplace('find')
      expect(view.find.value).toBe('alpha')
    },
  )

  it('keeps the old query when element boundaries select multiple paragraphs', () => {
    const view = mount()
    view.editor.innerHTML = '<p>alpha</p><p>beta</p>'
    view.find.value = 'previous'
    select(view.editor, 0, 2)
    openFindReplace('find')
    expect(view.find.value).toBe('previous')
  })

  it.each([false, true])(
    'descends into authored text but skips rendered content at a container caret (preview=%s)',
    (preview) => {
      const view = mount('alpha')
      view.editor.innerHTML = preview
        ? '<span data-render="1">alpha</span>'
        : '<p><strong>alpha</strong></p>'
      view.find.value = 'previous'
      select(view.editor, 0)
      openFindReplace('find')
      expect(view.find.value).toBe(preview ? 'previous' : 'alpha')
    },
  )
})

describe('local widget keys and workbench forwarding', () => {
  it('consumes plain Enter/Shift+Enter only in Find, navigating next/previous', () => {
    const view = mount()
    openFindReplace('find')
    view.query('alpha')
    for (const shiftKey of [false, true]) {
      const { event, forwarded } = key(view.find, 'Enter', { shiftKey })
      expect(event.defaultPrevented).toBe(true)
      expect(forwarded).not.toHaveBeenCalled()
      expect(view.status()).toBe(shiftKey ? '1 of 2' : '2 of 2')
      expect(document.activeElement).toBe(view.find)
    }
  })

  it.each([
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true, altKey: true },
    { metaKey: true, altKey: true },
  ])(
    'forwards modified Enter without navigating/replacing: %j',
    (modifiers) => {
      const view = mount()
      openFindReplace('replace')
      view.query('alpha')
      view.replace.value = 'omega'
      vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
      for (const input of [view.find, view.replace]) {
        const { event, forwarded } = key(input, 'Enter', modifiers)
        expect(event.defaultPrevented).toBe(false)
        expect(forwarded).toHaveBeenCalledOnce()
      }
      expect(view.status()).toBe('1 of 2')
      expect(view.postExact).not.toHaveBeenCalled()
    },
  )

  it('mac Cmd+Enter replaces all only from Replace; Cmd+Alt+Enter reaches the host', () => {
    const view = mount()
    openFindReplace('replace')
    view.query('alpha')
    view.replace.value = 'omega'
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    expect(
      key(view.find, 'Enter', { metaKey: true }).event.defaultPrevented,
    ).toBe(false)
    expect(
      key(view.replace, 'Enter', { metaKey: true, altKey: true }).event
        .defaultPrevented,
    ).toBe(false)
    expect(view.postExact).not.toHaveBeenCalled()
    view.replace.focus()
    const { event, forwarded } = key(view.replace, 'Enter', { metaKey: true })
    expect(event.defaultPrevented).toBe(true)
    expect(forwarded).not.toHaveBeenCalled()
    vi.advanceTimersByTime(32)
    expect(view.postExact).toHaveBeenCalledExactlyOnceWith('omega beta omega')
    expect(document.activeElement).toBe(view.replace)
  })

  it.each([
    ['F3', {}, 'next'],
    ['F3', { shiftKey: true }, 'previous'],
    ['c', { altKey: true }, 'toggle-case'],
    ['w', { altKey: true }, 'toggle-whole-word'],
    ['1', { ctrlKey: true, shiftKey: true }, 'replace-one'],
    ['Enter', { ctrlKey: true, altKey: true }, 'replace-all'],
  ] as [string, KeyboardEventInit, FindWidgetAction][])(
    'forwards %s %j for the host command %s',
    (name, modifiers, action) => {
      const view = mount()
      openFindReplace('replace')
      view.query('alpha')
      view.replace.focus()
      const { event, forwarded } = key(view.replace, name, modifiers)
      expect(event.defaultPrevented).toBe(false)
      expect(forwarded).toHaveBeenCalledOnce()
      expect(view.postExact).not.toHaveBeenCalled()
      runFindWidgetAction(action)
      expect(view.root.hidden).toBe(false)
    },
  )

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'ignores composing input %j',
    (modifiers) => {
      const view = mount()
      openFindReplace('replace')
      view.query('alpha')
      for (const input of [view.find, view.replace])
        for (const name of ['Enter', 'Escape']) {
          const { event, forwarded } = key(input, name, modifiers)
          expect(event.defaultPrevented).toBe(false)
          expect(forwarded).toHaveBeenCalledOnce()
        }
      expect(view.root.hidden).toBe(false)
      expect(view.status()).toBe('1 of 2')
      expect(view.postExact).not.toHaveBeenCalled()
    },
  )

  it('does not intercept button Enter or modified Escape', () => {
    const view = mount()
    openFindReplace('find')
    expect(key(view.toggle, 'Enter').event.defaultPrevented).toBe(false)
    expect(
      key(view.find, 'Escape', { ctrlKey: true }).event.defaultPrevented,
    ).toBe(false)
    expect(view.root.hidden).toBe(false)
  })
})
