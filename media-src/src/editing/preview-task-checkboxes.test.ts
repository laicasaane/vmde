// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import * as previewTaskCheckboxes from './preview-task-checkboxes'
import { matchPreviewTaskCheckboxes } from './preview-task-checkboxes'
import { findTaskListMarkers } from './list-normalize-source'

function preview(markup: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = markup
  return root
}

describe('delegated Preview task-checkbox controller', () => {
  it('posts one exact marker request and waits for host ack plus a fresh render', async () => {
    const install = (previewTaskCheckboxes as any).installPreviewTaskCheckboxes
    expect(typeof install).toBe('function')
    if (typeof install !== 'function') return

    const source = '- [ ] one'
    const root = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li></ul>',
    )
    document.body.appendChild(root)
    const owner = { preview: { previewElement: root } }
    const postMessage = vi.fn()
    const controller = install(owner, true, {
      postMessage,
      createRequestId: () => 'task-request-1',
    })

    try {
      controller.onPreviewRendered(owner, root, source, 1)
      const input = root.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!
      expect(input.disabled).toBe(false)
      input.click()
      await Promise.resolve()

      expect(postMessage).toHaveBeenCalledOnce()
      expect(postMessage).toHaveBeenCalledWith({
        command: 'toggle-preview-task-checkbox',
        requestId: 'task-request-1',
        source,
        startOffset: source.indexOf('[ ]'),
        endOffset: source.indexOf('[ ]') + 3,
        marker: '[ ]',
        checked: true,
      })
      expect(input.checked).toBe(false)
      expect(input.disabled).toBe(true)
      expect(
        previewTaskCheckboxes.isPendingPreviewTaskCheckboxHistoryUpdate(
          'task-request-1',
          source,
          '- [x] one',
        ),
      ).toBe(true)
      expect(
        previewTaskCheckboxes.isPendingPreviewTaskCheckboxHistoryUpdate(
          'another-request',
          source,
          '- [x] one',
        ),
      ).toBe(false)

      controller.handleOutcome({
        command: 'preview-task-checkbox-outcome',
        requestId: 'task-request-1',
        status: 'applied',
        source: '- [x] one',
      })
      expect(input.disabled).toBe(true)

      root.innerHTML =
        '<ul><li class="vditor-task vditor-task--done">' +
        '<input type="checkbox" checked disabled>one</li></ul>'
      controller.onPreviewRendered(owner, root, '- [x] one', 2)
      expect(
        root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      ).toBe(true)
      expect(
        root.querySelector<HTMLInputElement>('input[type="checkbox"]')
          ?.disabled,
      ).toBe(false)
    } finally {
      controller.dispose()
      root.remove()
    }
  })

  it('maps controls and posts offsets from exact host bytes when Vditor normalizes list spacing', async () => {
    const install = (previewTaskCheckboxes as any).installPreviewTaskCheckboxes
    expect(typeof install).toBe('function')
    if (typeof install !== 'function') return

    const exactHostSource = '\n\n\n- [ ] one'
    const normalizedVditorSource = '\n\n- [ ]  one'
    const root = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li></ul>',
    )
    document.body.appendChild(root)
    const owner = { preview: { previewElement: root } }
    const postMessage = vi.fn()
    const controller = install(owner, true, {
      postMessage,
      createRequestId: () => 'exact-host-source',
    })

    try {
      controller.onPreviewRendered(owner, root, exactHostSource, 1)
      expect(
        matchPreviewTaskCheckboxes(exactHostSource, root)?.[0]?.marker,
      ).toMatchObject({
        startOffset: exactHostSource.indexOf('[ ]'),
        endOffset: exactHostSource.indexOf('[ ]') + 3,
      })
      expect(exactHostSource).not.toBe(normalizedVditorSource)
      const input = root.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!
      expect(input.disabled).toBe(false)
      input.click()
      await Promise.resolve()

      expect(postMessage).toHaveBeenCalledWith({
        command: 'toggle-preview-task-checkbox',
        requestId: 'exact-host-source',
        source: exactHostSource,
        startOffset: exactHostSource.indexOf('[ ]'),
        endOffset: exactHostSource.indexOf('[ ]') + 3,
        marker: '[ ]',
        checked: true,
      })
    } finally {
      controller.dispose()
      root.remove()
    }
  })

  it('does not unlock when a render arrives before the matching applied ack', async () => {
    const install = (previewTaskCheckboxes as any).installPreviewTaskCheckboxes
    expect(typeof install).toBe('function')
    if (typeof install !== 'function') return

    const source = '- [ ] one'
    const after = '- [x] one'
    const root = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li></ul>',
    )
    document.body.appendChild(root)
    const owner = { preview: { previewElement: root } }
    const controller = install(owner, true, {
      postMessage: vi.fn(),
      createRequestId: () => 'render-first',
    })

    try {
      controller.onPreviewRendered(owner, root, source, 1)
      const oldInput = root.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!
      oldInput.click()
      await Promise.resolve()

      root.innerHTML =
        '<ul><li class="vditor-task vditor-task--done">' +
        '<input type="checkbox" checked disabled>one</li></ul>'
      controller.onPreviewRendered(owner, root, after, 2)
      expect(
        root.querySelector<HTMLInputElement>('input[type="checkbox"]')
          ?.disabled,
      ).toBe(true)

      controller.handleOutcome({
        command: 'preview-task-checkbox-outcome',
        requestId: 'render-first',
        status: 'applied',
        source: after,
      })
      expect(
        root.querySelector<HTMLInputElement>('input[type="checkbox"]')
          ?.disabled,
      ).toBe(false)
    } finally {
      controller.dispose()
      root.remove()
    }
  })

  it('keeps controls disabled when the setting is off or render ownership is ambiguous', () => {
    const install = (previewTaskCheckboxes as any).installPreviewTaskCheckboxes
    expect(typeof install).toBe('function')
    if (typeof install !== 'function') return

    const source = '- [ ] one'
    const root = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li></ul>',
    )
    document.body.appendChild(root)
    const owner = { preview: { previewElement: root } }
    const controller = install(owner, false, {
      postMessage: vi.fn(),
      createRequestId: () => 'unused',
    })

    try {
      controller.onPreviewRendered(owner, root, source, 1)
      let input = root.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      )!
      expect(input.disabled).toBe(true)
      controller.setEnabled(true)
      expect(input.disabled).toBe(false)

      root.innerHTML =
        '<ul><li><input type="checkbox" disabled>raw HTML lookalike</li></ul>'
      controller.onPreviewRendered(owner, root, source, 2)
      input = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      expect(input.disabled).toBe(true)
      expect(
        controller.handleOutcome({
          command: 'preview-task-checkbox-outcome',
          requestId: 'unknown',
          status: 'stale',
          source,
        }),
      ).toBeUndefined()
    } finally {
      controller.dispose()
      root.remove()
    }
  })
})

describe('Preview task-checkbox ownership', () => {
  it('pairs nested, separate, and quoted controls with exact source spans', () => {
    const source = [
      '- [ ] top',
      '  - [x] nested',
      '- [ ] sibling',
      '',
      'A paragraph closes the first root.',
      '',
      '- ordinary list item',
      '- [ ] second root',
      '',
      '> [!NOTE]',
      '> - [X] quoted callout',
    ].join('\n')
    const root = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>top' +
        '<ul><li class="vditor-task vditor-task--done"><input type="checkbox" checked disabled>nested</li></ul>' +
        '</li><li class="vditor-task"><input type="checkbox" disabled>sibling</li></ul>' +
        '<p>A paragraph closes the first root.</p>' +
        '<ul><li>ordinary list item</li>' +
        '<li class="vditor-task"><input type="checkbox" disabled>second root</li></ul>' +
        '<blockquote><p>[!NOTE]</p>' +
        '<ul><li class="vditor-task vditor-task--done"><input type="checkbox" checked disabled>quoted callout</li></ul>' +
        '</blockquote>',
    )

    const bindings = matchPreviewTaskCheckboxes(source, root)

    expect(bindings).not.toBeNull()
    expect(
      bindings!.map(({ input, marker }) => ({
        checked: input.checked,
        sourceText: source.slice(marker.startOffset, marker.endOffset),
        rootIndex: marker.rootIndex,
        quoteDepth: marker.quoteDepth,
        path: marker.containerPath.map(({ listType, itemIndex }) => [
          listType,
          itemIndex,
        ]),
      })),
    ).toEqual([
      {
        checked: false,
        sourceText: '[ ]',
        rootIndex: 0,
        quoteDepth: 0,
        path: [['ul', 0]],
      },
      {
        checked: true,
        sourceText: '[x]',
        rootIndex: 0,
        quoteDepth: 0,
        path: [
          ['ul', 0],
          ['ul', 0],
        ],
      },
      {
        checked: false,
        sourceText: '[ ]',
        rootIndex: 0,
        quoteDepth: 0,
        path: [['ul', 1]],
      },
      {
        checked: false,
        sourceText: '[ ]',
        rootIndex: 1,
        quoteDepth: 0,
        path: [['ul', 1]],
      },
      {
        checked: true,
        sourceText: '[X]',
        rootIndex: 2,
        quoteDepth: 1,
        path: [['ul', 0]],
      },
    ])
  })

  it('recognizes the pinned Lute tight, loose, and quoted task-input shapes', () => {
    const source = [
      '- [ ] first',
      '',
      '  continuation',
      '- [x] second',
      '',
      '> [!NOTE]',
      '>',
      '> - [X] quoted',
    ].join('\n')
    expect(
      findTaskListMarkers(source).map(
        ({ rootIndex, quoteDepth, containerPath }) => ({
          rootIndex,
          quoteDepth,
          containerPath,
        }),
      ),
    ).toEqual([
      {
        rootIndex: 0,
        quoteDepth: 0,
        containerPath: [{ listType: 'ul', itemIndex: 0 }],
      },
      {
        rootIndex: 0,
        quoteDepth: 0,
        containerPath: [{ listType: 'ul', itemIndex: 1 }],
      },
      {
        rootIndex: 1,
        quoteDepth: 1,
        containerPath: [{ listType: 'ul', itemIndex: 0 }],
      },
    ])
    const root = preview(
      '<ul><li class="vditor-task"><p><input type="checkbox" disabled>first</p>' +
        '<p>continuation</p></li>' +
        '<li class="vditor-task vditor-task--done"><p><input type="checkbox" checked disabled>second</p></li></ul>' +
        '<blockquote><p>[!NOTE]</p><ul>' +
        '<li class="vditor-task vditor-task--done"><input type="checkbox" checked disabled>quoted</li>' +
        '</ul></blockquote>',
    )

    expect(matchPreviewTaskCheckboxes(source, root)).toHaveLength(3)
  })

  it('rejects a raw HTML checkbox inside an ordinary li even when count and path mimic a task marker', () => {
    const source = '- [ ] genuine Markdown task'
    const root = preview(
      '<ul><li><input type="checkbox" disabled>raw HTML checkbox</li></ul>',
    )

    expect(matchPreviewTaskCheckboxes(source, root)).toBeNull()
  })

  it('fails closed when a rendered control is outside a list item or counts differ', () => {
    const source = '- [ ] one\n- [x] two'
    const withExtra = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li>' +
        '<li class="vditor-task vditor-task--done"><input type="checkbox" checked disabled>two</li></ul>' +
        '<input type="checkbox">',
    )
    const missing = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>one</li></ul>',
    )

    expect(matchPreviewTaskCheckboxes(source, withExtra)).toBeNull()
    expect(matchPreviewTaskCheckboxes(source, missing)).toBeNull()
  })

  it('fails closed when checked state or nested-list identity differs', () => {
    const source = '- [ ] parent\n  - [ ] child'
    const wrongState = preview(
      '<ul><li class="vditor-task"><input type="checkbox" checked disabled>parent' +
        '<ul><li class="vditor-task"><input type="checkbox" disabled>child</li></ul></li></ul>',
    )
    const wrongNesting = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>parent</li>' +
        '<li class="vditor-task"><input type="checkbox" disabled>child</li></ul>',
    )

    expect(matchPreviewTaskCheckboxes(source, wrongState)).toBeNull()
    expect(matchPreviewTaskCheckboxes(source, wrongNesting)).toBeNull()
  })

  it('fails closed when quote depth or a preceding non-task list root differs', () => {
    const quoted = '> - [ ] quoted'
    const noQuote = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>quoted</li></ul>',
    )
    const precededByList = '- ordinary only\n\n- [ ] task'
    const missingRoot = preview(
      '<ul><li class="vditor-task"><input type="checkbox" disabled>task</li></ul>',
    )

    expect(matchPreviewTaskCheckboxes(quoted, noQuote)).toBeNull()
    expect(matchPreviewTaskCheckboxes(precededByList, missingRoot)).toBeNull()
  })
})
