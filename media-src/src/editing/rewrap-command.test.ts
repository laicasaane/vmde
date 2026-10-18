// @vitest-environment jsdom

import fs from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { wrapLiveLineBreakIdentity } from './live-line-breaks'
import {
  applyRewrapTransaction,
  cancelPendingUndoSnapshot,
  captureRewrapSourceSelection,
  mapCaretOffsetByLine,
  recordRewrapDocumentHistory,
  sourceSelectionFromDom,
  takeRewrapDocumentHistorySync,
} from './rewrap-command'

const TABLE_OPEN = `<SUB data-note="a > b" title='Q'>`
const TABLE_CLOSE = '</SUB>'
const TABLE_MARKDOWN = [
  '| A | B |',
  '| --- | --- |',
  `|  ${TABLE_OPEN}**2** &amp;${TABLE_CLOSE}     |    keep   |`,
  '| untouched  |  row |',
].join('\n')

function tableFixture(
  mode: 'ir' | 'wysiwyg',
  kind: 'body' | 'interior' | 'caret' = 'body',
  options: { source?: string; tableIndex?: number; cellIndex?: number } = {},
) {
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync('media-src/vendor/lute/lute.min.js', 'utf8'),
    sandbox,
    { filename: 'lute.min.js' },
  )
  const lute = (sandbox as { Lute: { New(): any } }).Lute.New()
  lute.SetVditorIR(mode === 'ir')
  lute.SetVditorWYSIWYG(mode === 'wysiwyg')
  lute.SetSpin(true)
  lute.SetSanitize(true)
  lute.SetSup(false)
  lute.SetSub(false)
  patchLuteGapRepair(lute)
  wrapLiveLineBreakIdentity(lute)
  const render =
    mode === 'ir'
      ? lute.Md2VditorIRDOM.bind(lute)
      : lute.Md2VditorDOM.bind(lute)
  const serialize =
    mode === 'ir'
      ? lute.VditorIRDOM2Md.bind(lute)
      : lute.VditorDOM2Md.bind(lute)
  const source =
    options.source ??
    `Before __keep__.\n\n${TABLE_MARKDOWN}\n\n${TABLE_MARKDOWN}\n\nAfter *keep*.\n`
  const editor = document.createElement('div')
  editor.innerHTML = render(source)
  document.body.replaceChildren(editor)
  const tableIndex = options.tableIndex ?? 1
  const cellIndex = options.cellIndex ?? 0
  const cell =
    editor.querySelectorAll('table')[tableIndex].tBodies[0].rows[0].cells[
      cellIndex
    ]
  const markers = Array.from(
    cell.querySelectorAll<HTMLElement>('[data-type="html-inline"]'),
  )
  const opening = markers.find(
    (node) => node.textContent?.includes('data-note=') === true,
  )!
  const closing = markers.find(
    (node) => node.textContent?.includes('/SUB') === true,
  )!
  const range = document.createRange()
  if (kind === 'body') {
    if (opening && closing) {
      range.setStartAfter(opening)
      range.setEndBefore(closing)
    } else {
      range.selectNodeContents(cell)
    }
  } else if (kind === 'interior') {
    const text = cell.querySelector('strong')!.firstChild as Text
    range.setStart(text, 0)
    range.setEnd(text, text.data.length)
  } else {
    range.setStartAfter(opening)
    range.collapse(true)
  }
  return {
    editor,
    range,
    serialize,
    canonical: serialize(editor.innerHTML),
    cell,
  }
}

describe('document rewrap exact history sync', () => {
  it('tracks native undo and redo Markdown without replacing the undo engine', () => {
    const nativeState = {}
    const native = { undoStack: [] as unknown[], redoStack: [nativeState] }
    const inner = {
      currentMode: 'ir',
      undo: { ir: native },
    } as any
    recordRewrapDocumentHistory({
      owner: inner,
      mode: 'ir',
      nativeState,
      beforeRendered: 'before canonical',
      beforeExact: 'before exact\n',
      afterRendered: 'after canonical',
      afterExact: 'after exact\n',
    })

    expect(takeRewrapDocumentHistorySync(inner, 'before canonical')).toBe(
      'before exact\n',
    )
    expect(
      takeRewrapDocumentHistorySync(inner, 'before canonical'),
    ).toBeUndefined()
    native.redoStack.pop()
    native.undoStack.push(nativeState)
    expect(takeRewrapDocumentHistorySync(inner, 'after canonical')).toBe(
      'after exact\n',
    )
  })
})

// Task 601: an exact transaction cancels the pending snapshot; its drainable record goes with it,
// so a following Undo cannot run it and publish Vditor's rendering over the exact bytes.
describe('cancelPendingUndoSnapshot', () => {
  it.each([
    ['ir', 'processTimeoutId'],
    ['wysiwyg', 'afterRenderTimeoutId'],
    ['sv', 'processTimeoutId'],
  ] as const)('%s: clears the timer and retires its record', (mode, key) => {
    vi.useFakeTimers()
    const run = vi.fn()
    const owner: Record<string, unknown> = {}
    owner[key] = setTimeout(run, 800)
    owner.vmdeAfterRender = { run }
    cancelPendingUndoSnapshot({ currentMode: mode, [mode]: owner } as never)
    vi.runAllTimers()
    expect(run).not.toHaveBeenCalled()
    expect(owner.vmdeAfterRender).toBeUndefined()
    vi.useRealTimers()
  })
})

describe('mapCaretOffsetByLine', () => {
  it('maps a logical caret across blank-line canonicalization', () => {
    const canonical = '---\n# Heading\nmiddle alpha beta\n'
    const authoritative = '---\n\n# Heading\n\nmiddle alpha beta\n'

    expect(
      mapCaretOffsetByLine(
        canonical,
        authoritative,
        canonical.indexOf('alpha') + 2,
      ),
    ).toBe(authoritative.indexOf('alpha') + 2)
  })

  it('maps the matching ordinal when an identical line is repeated', () => {
    const canonical = 'repeat line\nother\nrepeat line\n'
    const authoritative = 'repeat line\n\nother\n\nrepeat line\n'

    expect(
      mapCaretOffsetByLine(
        canonical,
        authoritative,
        canonical.lastIndexOf('line') + 2,
      ),
    ).toBe(authoritative.lastIndexOf('line') + 2)
  })

  it('maps the start of a line to that line instead of the preceding newline', () => {
    expect(mapCaretOffsetByLine('a\nb\n', 'a\n\nb\n', 2)).toBe(3)
  })

  it('maps a caret on a canonical blank line through added blank lines', () => {
    expect(mapCaretOffsetByLine('a\n\nb\n', 'a\n\n\nb\n', 2)).toBe(3)
  })

  it('maps EOF after a trailing newline across newline conventions', () => {
    expect(mapCaretOffsetByLine('a\n', 'a\r\n', 2)).toBe(3)
  })
})

describe('sourceSelectionFromDom', () => {
  it('maps a non-collapsed DOM selection through the real serializer boundary', () => {
    document.body.innerHTML = '<div id="editor">alpha <em>beta</em> gamma</div>'
    const editor = document.querySelector<HTMLElement>('#editor')!
    const alpha = editor.firstChild!
    const beta = editor.querySelector('em')!.firstChild!
    const range = document.createRange()
    range.setStart(alpha, 2)
    range.setEnd(beta, 2)

    const selection = sourceSelectionFromDom({
      editor,
      range,
      serialize: (html) => {
        const clone = document.createElement('div')
        clone.innerHTML = html
        return clone.textContent ?? ''
      },
    })

    expect(selection).toEqual({
      markdown: 'alpha beta gamma',
      startOffset: 2,
      endOffset: 8,
      caretOffset: 8,
    })
    expect(editor.innerHTML).toBe('alpha <em>beta</em> gamma')
  })

  it('maps the second identical table cell through frozen canonical Markdown', () => {
    const { editor, range, serialize, canonical } = tableFixture('ir')
    const selection = sourceSelectionFromDom({
      editor,
      range,
      serialize,
      canonicalMarkdown: canonical,
    } as any)

    expect(selection?.markdown).toBe(canonical)
    expect(canonical.slice(selection?.startOffset, selection?.endOffset)).toBe(
      '**2** &amp;',
    )
    expect(editor.innerHTML).not.toContain('VMDE_REWRAP')
  })

  it.each(['ir', 'wysiwyg'] as const)(
    'maps body, interior, and caret endpoints in %s table cells',
    (mode) => {
      for (const [kind, expected] of [
        ['body', '**2** &amp;'],
        ['interior', '2'],
        ['caret', ''],
      ] as const) {
        const { editor, range, serialize, canonical } = tableFixture(mode, kind)
        const selection = sourceSelectionFromDom({
          editor,
          range,
          serialize,
          canonicalMarkdown: canonical,
        })
        expect(selection?.markdown, `${mode} ${kind}`).toBe(canonical)
        expect(
          canonical.slice(selection?.startOffset, selection?.endOffset),
          `${mode} ${kind}`,
        ).toBe(expected)
      }
    },
  )

  it.each([
    ['empty prefix and suffix', `${TABLE_MARKDOWN}\n`],
    ['empty suffix', `Before __keep__.\n\n${TABLE_MARKDOWN}\n`],
  ] as const)('admits actual %s', (_name, source) => {
    const { editor, range, serialize, canonical } = tableFixture('ir', 'body', {
      source,
      tableIndex: 0,
    })
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toMatchObject({ markdown: canonical })
  })

  it('rejects a non-LF gap and cross-cell table selection', () => {
    const { editor, range, serialize, canonical, cell } = tableFixture('ir')
    const table = editor.querySelectorAll('table')[1]
    const tableMarkdown = serialize(table.outerHTML).replace(/\n+$/u, '')
    const invalidCanonical = canonical.replace(
      tableMarkdown,
      `X${tableMarkdown}`,
    )
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: invalidCanonical,
      }),
    ).toBeNull()

    const crossCell = document.createRange()
    crossCell.setStart(cell, 0)
    crossCell.setEnd(cell.parentElement!.children[1], 1)
    expect(
      sourceSelectionFromDom({
        editor,
        range: crossCell,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toBeNull()
  })

  it('rejects unsupported table shape and preserves escaped-pipe content', () => {
    const escapedTable = [
      '| A | B |',
      '| --- | --- |',
      '| a\\|b | keep |',
    ].join('\n')
    const { editor, range, serialize, canonical, cell } = tableFixture(
      'ir',
      'body',
      {
        source: `${escapedTable}\n`,
        tableIndex: 0,
      },
    )
    const escapedRange = document.createRange()
    escapedRange.selectNodeContents(cell)
    const escaped = sourceSelectionFromDom({
      editor,
      range: escapedRange,
      serialize,
      canonicalMarkdown: canonical,
    })
    expect(
      escaped?.markdown.slice(escaped.startOffset, escaped.endOffset),
    ).toBe('a\\|b')

    cell.setAttribute('colspan', '2')
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toBeNull()

    cell.removeAttribute('colspan')
    const footer = document.createElement('tfoot')
    footer.innerHTML = '<tr><td>footer</td><td>footer</td></tr>'
    editor.querySelector('table')!.append(footer)
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toBeNull()
  })

  it('uses a collision-free detached marker and rejects nested table structure', () => {
    const collision = '\uE100VMDE_REWRAP_START'
    const { editor, range, serialize, canonical } = tableFixture('ir', 'body', {
      source: `Before.\n\n${TABLE_MARKDOWN.replace('**2**', `${collision}**2**`)}\n`,
      tableIndex: 0,
    })
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toMatchObject({ markdown: canonical })

    const nested = document.createElement('table')
    editor.querySelector('table')!.append(nested)
    expect(
      sourceSelectionFromDom({
        editor,
        range,
        serialize,
        canonicalMarkdown: canonical,
      }),
    ).toBeNull()
  })
})

describe('captureRewrapSourceSelection authoritative snapshot', () => {
  it('uses a supplied exact snapshot for the marker equality guard without getValue', () => {
    document.body.innerHTML = '<div id="editor"><p>alpha beta</p></div>'
    const editor = document.querySelector<HTMLElement>('#editor')!
    const text = editor.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 'alpha'.length)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const serialize = (html: string) => {
      const template = document.createElement('template')
      template.innerHTML = html
      return template.content.textContent ?? ''
    }
    const getValue = vi.fn(() => 'alpha beta')
    ;(window as any).vditor = {
      getValue,
      vditor: {
        currentMode: 'ir',
        ir: { element: editor },
        lute: {
          VditorIRDOM2Md: serialize,
          VditorDOM2Md: serialize,
        },
      },
    }

    const captured = captureRewrapSourceSelection(window, {
      authoritativeMarkdown: 'alpha beta',
    })

    expect(captured).toMatchObject({ markdown: 'alpha beta', caretOffset: 5 })
    expect(getValue).not.toHaveBeenCalled()
  })
})

describe('applyRewrapTransaction', () => {
  it('document scope ignores the smaller selection and applies all paragraphs once', () => {
    const calls: string[] = []
    const markdown = [
      'first alpha beta gamma delta',
      '',
      'middle alpha beta gamma delta',
      '',
      'tail alpha beta gamma delta',
    ].join('\n')
    const middle = markdown.indexOf('middle')

    expect(
      applyRewrapTransaction(
        {
          markdown,
          startOffset: middle,
          endOffset: middle + 'middle'.length,
          caretOffset: middle + 2,
        },
        18,
        {
          checkpointUndo: () => calls.push('undo'),
          applyMarkdown: (_value, _marker, result) => {
            calls.push(`apply:${result.markdown}`)
            return true
          },
          readScroll: () => 21,
          restoreScroll: (value) => calls.push(`scroll:${value}`),
          sync: (markdown) => calls.push(`sync:${markdown}`),
        },
        'document',
      ),
    ).toBe(true)
    expect(calls.filter((call) => call.startsWith('apply:'))).toHaveLength(1)
    expect(calls.join('\n')).toContain('first alpha beta\ngamma delta')
    expect(calls.join('\n')).toContain('middle alpha beta\ngamma delta')
    expect(calls.join('\n')).toContain('tail alpha beta\ngamma delta')
    expect(calls.filter((call) => call === 'undo')).toHaveLength(2)
    expect(calls.filter((call) => call.startsWith('sync:'))).toHaveLength(1)
  })

  it('applies one marked render between explicit undo snapshots and syncs once', () => {
    const calls: string[] = []
    const applyMarkdown = vi.fn((markdown: string, marker: string) => {
      calls.push(`apply:${markdown}:${marker}`)
      return true
    })
    const result = applyRewrapTransaction(
      {
        markdown: 'alpha beta gamma delta',
        startOffset: 0,
        endOffset: 22,
        caretOffset: 22,
      },
      12,
      {
        checkpointUndo: () => calls.push('undo'),
        applyMarkdown,
        readScroll: () => 37,
        restoreScroll: (value) => calls.push(`scroll:${value}`),
        sync: () => calls.push('sync'),
      },
    )

    expect(result).toBe(true)
    expect(calls[0]).toBe('undo')
    expect(calls[1]).toMatch(/^apply:alpha beta\ngamma delta.+:/u)
    expect(calls.slice(2)).toEqual(['undo', 'scroll:37', 'sync'])
    expect(applyMarkdown).toHaveBeenCalledTimes(1)
  })

  it('does not create undo, render, scroll, or sync work for a formatter no-op', () => {
    const deps = {
      checkpointUndo: vi.fn(),
      applyMarkdown: vi.fn(() => true),
      readScroll: vi.fn(() => 0),
      restoreScroll: vi.fn(),
      sync: vi.fn(),
    }

    expect(
      applyRewrapTransaction(
        {
          markdown: 'short line',
          startOffset: 0,
          endOffset: 10,
          caretOffset: 10,
        },
        80,
        deps,
      ),
    ).toBe(false)
    expect(deps.checkpointUndo).not.toHaveBeenCalled()
    expect(deps.applyMarkdown).not.toHaveBeenCalled()
    expect(deps.readScroll).not.toHaveBeenCalled()
    expect(deps.restoreScroll).not.toHaveBeenCalled()
    expect(deps.sync).not.toHaveBeenCalled()
  })

  it('document scope is also a silent no-op when every paragraph already fits', () => {
    const deps = {
      checkpointUndo: vi.fn(),
      applyMarkdown: vi.fn(() => true),
      readScroll: vi.fn(() => 0),
      restoreScroll: vi.fn(),
      sync: vi.fn(),
    }
    const markdown = 'short first\n\nshort tail\n'

    expect(
      applyRewrapTransaction(
        {
          markdown,
          startOffset: markdown.indexOf('tail'),
          endOffset: markdown.indexOf('tail'),
          caretOffset: markdown.indexOf('tail') + 2,
        },
        80,
        deps,
        'document',
      ),
    ).toBe(false)
    expect(deps.checkpointUndo).not.toHaveBeenCalled()
    expect(deps.applyMarkdown).not.toHaveBeenCalled()
    expect(deps.readScroll).not.toHaveBeenCalled()
    expect(deps.restoreScroll).not.toHaveBeenCalled()
    expect(deps.sync).not.toHaveBeenCalled()
  })

  it('does not commit a post-format snapshot when the marked caret cannot be restored', () => {
    const checkpointUndo = vi.fn()
    const sync = vi.fn()

    expect(
      applyRewrapTransaction(
        {
          markdown: 'alpha beta gamma delta',
          startOffset: 0,
          endOffset: 22,
          caretOffset: 22,
        },
        12,
        {
          checkpointUndo,
          applyMarkdown: () => false,
          readScroll: () => 0,
          restoreScroll: vi.fn(),
          sync,
        },
        'document',
      ),
    ).toBe(false)
    expect(checkpointUndo).toHaveBeenCalledTimes(1)
    expect(sync).not.toHaveBeenCalled()
  })
})

// Task 580 CP2-7 — Rewrap and the heading shifts are unbound commands. The webview owns no key for
// them any more, so a keydown reaches VS Code untouched.
describe('rewrap and heading-shift keys', () => {
  it('exports no webview keybinding for Rewrap', async () => {
    const module = await import('./rewrap-command')
    expect(Object.keys(module)).not.toContain('setupRewrapKeybind')
    expect(Object.keys(module)).not.toContain('rewrapShortcut')
  })
})

// Task 607: Rewrap Document plans on the text the host sent after its typing flush. That flush
// published a plain edit, so no owned base remains; the exact sync must name the host text.
// Task 606: the caret is proven against the bound exact/rendered source (real Lute, round-trip
// document), not mapped by a line heuristic, so the case now binds a source; without one the run
// declines (see "Rewrap without a bound proof source").
describe('Rewrap Document host base', () => {
  it('passes the host-sent text to the exact sync as `hostBefore`', async () => {
    const {
      bindRewrapSource,
      captureRewrapSourceSelection,
      runRewrapDocumentCommand,
    } = await import('./rewrap-command')
    const { createRealLute } = await import('../testing/real-lute')
    const { currentBlockProjection, resolveBlockHandleUnits } = await import(
      '../nav/block-handle'
    )
    const { createSourceBlockIndex } = await import('../nav/source-block-index')
    const real = createRealLute('ir')
    const host = `${'word '.repeat(30).trim()}\n`
    const root = document.createElement('pre')
    root.className = 'vditor-reset'
    root.setAttribute('contenteditable', 'true')
    root.innerHTML = real.render(host)
    document.body.append(root)
    ;(window as any).vditor = {
      getCurrentMode: () => 'ir',
      getValue: () => real.serialize(root.innerHTML),
      setValue: (markdown: string) => {
        root.innerHTML = real.render(markdown)
      },
      vditor: {
        currentMode: 'ir',
        ir: { element: root },
        lute: real.lute,
        undo: {},
      },
    }
    const revision = {}
    const snapshotPair = () => ({
      exact: host,
      rendered: real.serialize(root.innerHTML),
    })
    const index = createSourceBlockIndex({
      getActiveRoot: () => root,
      projection: currentBlockProjection,
      snapshotPair,
      snapshotRevision: () => revision,
      resolveUnits: (element, exact, rendered) =>
        resolveBlockHandleUnits(
          element,
          exact,
          rendered,
          currentBlockProjection(),
        ),
    })
    const unbind = bindRewrapSource({ index, snapshotPair })
    const text = root.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 3)
    range.collapse(true)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
    const prepared = captureRewrapSourceSelection(window, {
      proofOnly: true,
    })
    const syncExact = vi.fn()

    const ran = runRewrapDocumentCommand(
      window,
      {
        column: 40,
        setApplying: vi.fn(),
        invalidate: vi.fn(),
        scheduleSync: vi.fn(),
        syncExact,
        onError: (error) => {
          throw error
        },
      },
      host,
      prepared,
    )
    unbind()
    index.dispose()

    expect(ran).toBe(true)
    expect(syncExact).toHaveBeenCalledOnce()
    expect(syncExact.mock.calls[0][0]).not.toBe(host)
    expect(syncExact.mock.calls[0][1]).toBe(host)
    expect(syncExact.mock.calls[0][3]).toBe(host)
  })
})

// Task 606 S2a (RED until S2b): proof-only Rewrap. With no bound exact/rendered source there is
// nothing to prove an endpoint against, so neither scope may fall back to the marker capture or to
// `mapCaretOffsetByLine`. Acceptance 1 and Part 1 contract items 1, 3 and 4. The real-Lute
// counterparts (proven, unprovable, CRLF, list/table, Undo) are in `rewrap-non-round-trip.test.ts`.
describe('Rewrap without a bound proof source', () => {
  function stubEditor(host: string) {
    document.body.innerHTML = '<div id="editor"></div>'
    const editor = document.querySelector<HTMLElement>('#editor')!
    const setValue = vi.fn((markdown: string) => {
      editor.replaceChildren(
        ...markdown
          .split('\n\n')
          .filter(Boolean)
          .map((block) => {
            const paragraph = document.createElement('p')
            paragraph.textContent = block
            return paragraph
          }),
      )
    })
    setValue(host)
    const serialize = (html: string) => {
      const template = document.createElement('template')
      template.innerHTML = html
      return Array.from(template.content.children)
        .map((node) => node.textContent)
        .join('\n\n')
    }
    ;(window as any).vditor = {
      getValue: () => host,
      setValue,
      vditor: {
        currentMode: 'ir',
        ir: { element: editor },
        lute: { VditorIRDOM2Md: serialize, VditorDOM2Md: serialize },
        undo: {},
      },
    }
    const deps = {
      column: 40,
      setApplying: vi.fn(),
      invalidate: vi.fn(),
      scheduleSync: vi.fn(),
      syncExact: vi.fn(),
      onError: (error: unknown) => {
        throw error
      },
    }
    return { editor, setValue, deps }
  }

  const HOST = `${'word '.repeat(30).trim()}\n\nsecond paragraph\n`

  it('selection scope declines and changes nothing', async () => {
    const { runRewrapCommand } = await import('./rewrap-command')
    const { editor, setValue, deps } = stubEditor(HOST)
    setValue.mockClear()
    const text = editor.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 5)
    range.setEnd(text, 20)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(runRewrapCommand(window, deps)).toBe(false)
    expect(setValue).not.toHaveBeenCalled()
    expect(deps.syncExact).not.toHaveBeenCalled()
    expect(deps.scheduleSync).not.toHaveBeenCalled()
  })

  it('the auto-wrap form (rendered snapshot supplied) declines too', async () => {
    const { runRewrapCommand } = await import('./rewrap-command')
    const { editor, setValue, deps } = stubEditor(HOST)
    setValue.mockClear()
    const text = editor.querySelector('p')!.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 5)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(runRewrapCommand(window, deps, HOST)).toBe(false)
    expect(setValue).not.toHaveBeenCalled()
    expect(deps.syncExact).not.toHaveBeenCalled()
    expect(deps.scheduleSync).not.toHaveBeenCalled()
  })
})
