// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createRealLute } from '../testing/real-lute'
import {
  createSourceBlockIndex,
  type SourceBlockIndexHandle,
} from '../nav/source-block-index'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import * as blockMove from '../../../src/shared/block-move'
import * as plans from './link-popover-plan'
import * as rewrap from './rewrap-command'
import { installLinkPopover } from './link-popover'

const real = createRealLute('ir')
const originalRangeRect = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
)
const cleanups: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML =
    '<div id="app"><div class="vditor-content"><div class="vditor-ir"><pre class="vditor-reset" contenteditable="true"></pre></div></div></div>'
  // Geometry belongs to the Chromium/VS Code specs. Nonzero jsdom rects let
  // these tests exercise real Lute binding without a layout engine.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('vditor-content'))
        return new DOMRect(0, 0, 900, 700)
      return new DOMRect(100, 100, 200, 30)
    },
  )
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(100, 100, 20, 20),
  })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (originalRangeRect)
    Object.defineProperty(
      Range.prototype,
      'getBoundingClientRect',
      originalRangeRect,
    )
  else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
})

function setup(
  exact: string,
  options: {
    rejectUnits?: boolean
    readonly?: boolean
    // Task 630: after a trusted edit the legacy exact snapshot is the rendered fallback.
    legacyExact?: boolean
  } = {},
) {
  const root = document.querySelector<HTMLElement>('.vditor-reset')!
  root.innerHTML = real.render(exact)
  if (options.readonly) root.setAttribute('contenteditable', 'false')
  const serialize = vi.fn(real.serialize)
  const render = vi.fn(real.render)
  const lute = {
    VditorIRDOM2Md: serialize,
    Md2VditorIRDOM: render,
    VditorDOM2Md: real.lute.VditorDOM2Md,
    Md2VditorDOM: real.lute.Md2VditorDOM,
  }
  const inner = { currentMode: 'ir', ir: { element: root }, lute }
  const getValue = vi.fn(() => serialize(root.innerHTML))
  vi.stubGlobal('vditor', {
    vditor: inner,
    getCurrentMode: () => inner.currentMode,
    getValue,
  })
  const post = vi.fn()
  vi.stubGlobal('vscode', { postMessage: post })
  const revision = { value: {} }
  const snapshot = vi.fn(() => (options.legacyExact ? getValue() : exact))
  const snapshotPair = vi.fn(() => ({
    exact: options.legacyExact ? getValue() : exact,
    rendered: getValue(),
  }))
  const index = createSourceBlockIndex({
    getActiveRoot: () => (inner.currentMode === 'sv' ? null : root),
    projection: currentBlockProjection,
    snapshotPair,
    snapshotRevision: () => revision.value,
    resolveUnits: (node, source, rendered) =>
      options.rejectUnits
        ? null
        : resolveBlockHandleUnits(
            node,
            source,
            rendered,
            currentBlockProjection(),
          ),
  })
  cleanups.push(() => index.dispose())
  const postExact = vi.fn()
  const onError = vi.fn()
  const install = (
    handle: SourceBlockIndexHandle = index,
    extra: object = {},
  ) => {
    cleanups.push(
      installLinkPopover({
        index: handle,
        snapshotExactMarkdown: snapshot,
        acquireExactAuthority: async () => ({
          exact: snapshot(),
          rendered: getValue(),
        }),
        setApplying: vi.fn(),
        postExact,
        onError,
        ...extra,
      }),
    )
  }
  return {
    root,
    inner,
    getValue,
    serialize,
    render,
    index,
    revision,
    snapshot,
    snapshotPair,
    install,
    post,
    postExact,
    onError,
  }
}

async function settle() {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

function action(name: string) {
  return document.querySelector<HTMLButtonElement>(
    `.vmde-link-popover [data-action="${name}"]`,
  )!
}

function click(target: Element) {
  target.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  )
}

function link(root: HTMLElement, ordinal = 0) {
  return root.querySelectorAll<HTMLElement>(
    '[data-type="a"], [data-type="img"]',
  )[ordinal]
}

function warm(test: ReturnType<typeof setup>) {
  const entry = test.index.read()
  test.getValue.mockClear()
  test.serialize.mockClear()
  test.snapshot.mockClear()
  return entry
}

test.each([
  [
    'duplicates',
    'Before [same](https://one.test/a "first") and [same](https://one.test/a "second") after.\n',
    1,
  ],
  [
    'image',
    'Before ![first](https://one.test/a) and ![second **alt**](https://two.test/b "title") after.\n',
    1,
  ],
  [
    'noncanonical',
    '# Heading\r\n\r\nBefore [one](<https://one.test/a> "title") and [two](https://two.test/b).\r\n\r\n|  A  | B |\r\n| :- | -: |\r\n| x | y |\r\n',
    1,
  ],
  [
    'table',
    '| A | B |\n| --- | --- |\n| [one](https://one.test/a) | [two](https://two.test/b) |\n',
    1,
  ],
] as const)(
  'ordinal span agrees with real marker mapping on %s without warm-click mutations',
  (_name, exact, ordinal) => {
    const t = setup(exact)
    const target = link(t.root, ordinal)
    const marker = target.querySelector<HTMLElement>(
      ':scope > .vditor-ir__marker--link',
    )!
    const range = document.createRange()
    range.selectNodeContents(marker)
    const rendered = t.getValue()
    const mapped = rewrap.captureRewrapSourceRange(window, range, {
      authoritativeMarkdown: rendered,
    })
    expect(mapped).not.toBeNull()
    const visible = plans.listLinkPopoverCandidates(rendered)[ordinal]
    expect(mapped).toMatchObject({
      markdown: rendered,
      startOffset: visible.start,
      endOffset: visible.end,
    })
    const candidate = plans.listLinkPopoverCandidates(exact)[ordinal]
    expect(warm(t)?.units).not.toBeNull()
    const plan = vi.spyOn(plans, 'planLinkPopoverAction')
    const markerMapping = vi.spyOn(rewrap, 'captureRewrapSourceRange')
    t.install()
    const observer = new MutationObserver(() => undefined)
    observer.observe(t.root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    try {
      click(target)
      expect(action('edit').disabled).toBe(false)
      expect(action('unlink').disabled).toBe(false)
      expect(plan).toHaveBeenCalledWith(
        exact,
        { start: candidate.start, end: candidate.end, kind: candidate.kind },
        { kind: 'unlink' },
      )
      expect(markerMapping).not.toHaveBeenCalled()
      expect(t.getValue).not.toHaveBeenCalled()
      expect(t.snapshot).not.toHaveBeenCalled()
      expect(t.serialize).not.toHaveBeenCalled()
      expect(observer.takeRecords()).toEqual([])
    } finally {
      observer.disconnect()
    }
  },
)

test('caches lexical scans per entry and reuses the warm index across targets', () => {
  const t = setup(
    'Before [one](https://one.test/a) and [two](https://two.test/b) after.\n',
  )
  const entry = warm(t)!
  const groups = vi.spyOn(blockMove, 'scanMovableBlocks')
  const candidates = vi.spyOn(plans, 'listLinkPopoverCandidates')
  t.install()
  click(link(t.root))
  click(link(t.root, 1))
  expect(t.index.peek()).toBe(entry)
  expect(t.snapshotPair).toHaveBeenCalledOnce()
  expect(groups).toHaveBeenCalledOnce()
  expect(candidates).toHaveBeenCalledTimes(2)
  expect(t.getValue).not.toHaveBeenCalled()
})

test('a cold click builds once; a new source revision creates a new entry', () => {
  const t = setup('Before [one](https://one.test/a) after.\n')
  t.install()
  click(link(t.root))
  expect(t.snapshotPair).toHaveBeenCalledOnce()
  expect(action('edit').disabled).toBe(false)
  click(link(t.root))
  expect(t.snapshotPair).toHaveBeenCalledOnce()
  t.revision.value = {}
  click(link(t.root))
  expect(t.snapshotPair).toHaveBeenCalledTimes(2)
})

test.each(['reordered', 'missing', 'extra'] as const)(
  'rejects %s live nodes even if a stale entry is supplied',
  (change) => {
    const t = setup(
      'Before [one](https://one.test/a) and [two](https://two.test/b) after.\n',
    )
    const entry = warm(t)!
    const [first, second] = [link(t.root), link(t.root, 1)]
    if (change === 'reordered') first.before(second)
    if (change === 'missing') second.remove()
    if (change === 'extra') second.after(second.cloneNode(true))
    vi.spyOn(t.index, 'read').mockReturnValue(entry)
    t.install()
    click(first)
    expect(action('edit').disabled).toBe(true)
    expect(action('unlink').disabled).toBe(true)
    expect(t.postExact).not.toHaveBeenCalled()
  },
)

test('linked images keep the existing candidate-count rejection and marker mapping remains available', () => {
  const exact =
    'Before [![alt](https://image.test/a)](https://outer.test/b) after.\n'
  const t = setup(exact)
  const target = link(t.root, 1)
  const range = document.createRange()
  range.selectNodeContents(target.querySelector('.vditor-ir__marker--link')!)
  const rendered = t.getValue()
  const marker = rewrap.captureRewrapSourceRange(window, range, {
    authoritativeMarkdown: rendered,
  })
  expect(marker).not.toBeNull()
  expect(rendered.slice(marker!.startOffset, marker!.endOffset)).toBe(
    'https://image.test/a',
  )
  expect(plans.listLinkPopoverCandidates(exact)).toHaveLength(1)
  expect(
    t.root.querySelectorAll('[data-type="a"], [data-type="img"]'),
  ).toHaveLength(2)
  warm(t)
  t.install()
  click(target)
  expect(action('edit').disabled).toBe(true)
  expect(action('unlink').disabled).toBe(true)
})

test.each([{ rejectUnits: true }, { readonly: true }])(
  'unprovable binding keeps Open/Copy and disables source actions: %j',
  (options) => {
    const t = setup('Before [one](https://one.test/a) after.\n', options)
    warm(t)
    t.install()
    click(link(t.root))
    expect(action('edit').disabled).toBe(true)
    expect(action('unlink').disabled).toBe(true)
    action('copy').click()
    expect(t.post).toHaveBeenCalledWith({
      command: 'copy-link-url',
      href: 'https://one.test/a',
    })
    click(link(t.root))
    action('open').click()
    expect(t.post).toHaveBeenCalledWith({
      command: 'open-link',
      href: 'https://one.test/a',
    })
  },
)

test.each(['root', 'mode', 'owner'] as const)(
  'rejects mismatched index %s authority',
  (field) => {
    const t = setup('Before [one](https://one.test/a) after.\n')
    const entry = warm(t)!
    const key = { ...entry.key }
    if (field === 'root') key.root = document.createElement('pre')
    if (field === 'mode') key.mode = 'wysiwyg'
    if (field === 'owner') key.owner = {}
    vi.spyOn(t.index, 'read').mockReturnValue({ ...entry, key })
    t.install()
    click(link(t.root))
    expect(action('edit').disabled).toBe(true)
    expect(action('unlink').disabled).toBe(true)
  },
)

test.each(['count', 'kind', 'membership'] as const)(
  'retains the group binding guard for mismatched %s',
  (field) => {
    const t = setup('Before [one](https://one.test/a) after.\n')
    const entry = warm(t)!
    const units = entry.units!.map((unit) => ({ ...unit }))
    if (field === 'count') units.pop()
    if (field === 'kind') units[0].kind = 'heading'
    if (field === 'membership') units[0].members = [document.createElement('p')]
    vi.spyOn(t.index, 'read').mockReturnValue({ ...entry, units })
    t.install()
    click(link(t.root))
    expect(action('edit').disabled).toBe(true)
    expect(action('unlink').disabled).toBe(true)
  },
)

test('keyboard selection entry reuses the warm entry; composition hides the popover and SV cannot open it', async () => {
  const t = setup('Before [one](https://one.test/a) after.\n')
  warm(t)
  t.install()
  const range = document.createRange()
  range.selectNodeContents(link(t.root).querySelector('.vditor-ir__link')!)
  range.collapse(true)
  window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  await vi.advanceTimersByTimeAsync(32)
  const panel = document.querySelector<HTMLElement>('.vmde-link-popover')!
  expect(panel.hidden).toBe(false)
  expect(action('edit').disabled).toBe(false)
  expect(t.getValue).not.toHaveBeenCalled()
  document.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  )
  expect(panel.hidden).toBe(true)
  t.inner.currentMode = 'sv'
  click(link(t.root))
  expect(panel.hidden).toBe(true)
})

test.each(['null', 'different-offset'] as const)(
  'Edit and Unlink fail closed on an action-time marker mismatch: %s',
  async (mismatch) => {
    const t = setup('Before [one](https://one.test/a) after.\n')
    const entry = warm(t)!
    t.install()
    click(link(t.root))
    expect(action('edit').disabled).toBe(false)
    const marker = vi.spyOn(rewrap, 'captureRewrapSourceRange').mockReturnValue(
      mismatch === 'null'
        ? null
        : {
            markdown: entry.rendered,
            startOffset: 0,
            endOffset: 1,
            caretOffset: 1,
          },
    )
    const html = t.root.innerHTML
    action('unlink').click()
    await settle()
    expect(marker).toHaveBeenCalledOnce()
    expect(t.root.innerHTML).toBe(html)
    expect(t.postExact).not.toHaveBeenCalled()
    action('edit').click()
    const input = document.querySelector<HTMLInputElement>(
      '.vmde-link-popover input',
    )!
    input.value = 'https://changed.test/b'
    action('save').click()
    await settle()
    expect(marker).toHaveBeenCalledTimes(2)
    expect(t.root.innerHTML).toBe(html)
    expect(t.postExact).not.toHaveBeenCalled()
    expect(t.onError).not.toHaveBeenCalled()
  },
)

// Task 630 S1 (RED): Edit acquires exact authority with `publish: true` (its `execCommand` input is
// trusted and clears the owned base) and posts `before: pair.exact` explicitly; Remove (Unlink) acquires
// without publishing and keeps the default `before` (its dispatched event is untrusted, so the owned
// base stays). Both plan on the acquired exact text. The popover has no acquire seam yet, so
// `acquireExactAuthority` and `postExact(markdown, opts)` are declared here and passed as extra deps.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }

// Extra blank lines and `***` normalize away, so rendered offsets differ from the host offsets.
const HOST_EXACT =
  'Alpha\n\n\n\nBefore [one](https://one.test/a) after.\n\n***\n\nTail\n'
const NEW_URL = 'https://changed.test/b'

function exactPopover(options: { normalizing: boolean; drift?: boolean }) {
  const exact = options.normalizing
    ? HOST_EXACT
    : 'Alpha\n\nBefore [one](https://one.test/a) after.\n\nTail\n'
  const t = setup(exact, { legacyExact: options.normalizing })
  // The action records its Undo checkpoint against the native stack's top entry.
  Object.assign(t.inner, {
    undo: { addToUndoStack: vi.fn(), ir: { undoStack: [{}] } },
  })
  const host = { text: exact, owned: null as string | null, restored: 0 }
  const acquireExactAuthority = vi.fn(
    async (_opts?: { publish?: boolean }): Promise<AcquiredPair | null> => {
      host.owned = host.text
      const pair = { exact: host.text, rendered: t.getValue() as string }
      if (options.drift) host.text = `${exact}Delta\n`
      return pair
    },
  )
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      t.root.innerHTML = real.render(host.text)
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  // jsdom has no `execCommand`: replace the selected destination text and revoke the owned base
  // as the trusted `input` it dispatches in the webview does.
  document.execCommand = vi.fn(
    (_command: string, _ui?: boolean, value?: string) => {
      const range = window.getSelection()!.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(value ?? ''))
      host.owned = null
      return true
    },
  )
  t.install(undefined, { acquireExactAuthority, postExact })
  warm(t)
  return { ...t, exact, host, acquireExactAuthority, exactPost: postExact }
}

async function saveEdit(t: ReturnType<typeof exactPopover>) {
  click(link(t.root))
  action('edit').click()
  const input = document.querySelector<HTMLInputElement>(
    '.vmde-link-popover input',
  )!
  input.value = NEW_URL
  action('save').click()
  await vi.advanceTimersByTimeAsync(20)
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

async function unlink(t: ReturnType<typeof exactPopover>) {
  click(link(t.root))
  action('unlink').click()
  await vi.advanceTimersByTimeAsync(20)
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

test.each([true, false])(
  'Edit acquires with publish and posts the destination change on the acquired exact text (normalizing: %s)',
  async (normalizing) => {
    const t = exactPopover({ normalizing })
    await saveEdit(t)

    expect(t.acquireExactAuthority).toHaveBeenCalledExactlyOnceWith({
      publish: true,
    })
    expect(t.exactPost).toHaveBeenCalledOnce()
    // The folded cause: `before` is the acquired exact text, not the revoked owned base.
    expect(t.exactPost.mock.calls[0][1]).toEqual({
      before: t.exact,
      rollback: { restore: expect.any(Function) },
    })
    expect(t.host.text).toBe(t.exact.replace('https://one.test/a', NEW_URL))
  },
)

test('Edit refuses a stale host: no write, the rollback runs and the DOM shows the host text', async () => {
  const t = exactPopover({ normalizing: false, drift: true })
  await saveEdit(t)

  expect(t.host.restored).toBe(1)
  expect(t.host.text).toBe(`${t.exact}Delta\n`)
  expect(t.exactPost.mock.calls[0][1]).toEqual({
    before: t.exact,
    rollback: { restore: expect.any(Function) },
  })
  expect(t.root.innerHTML).toBe(real.render(`${t.exact}Delta\n`))
})

test('Edit declines without a write or a DOM change when acquisition fails', async () => {
  const t = exactPopover({ normalizing: true })
  t.acquireExactAuthority.mockResolvedValueOnce(null)
  const html = t.root.innerHTML
  await saveEdit(t)

  expect(t.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(document.execCommand).not.toHaveBeenCalled()
  expect(t.exactPost).not.toHaveBeenCalled()
  expect(t.root.innerHTML).toBe(html)
})

test('Remove acquires without publishing, plans on the acquired exact text and keeps the default before', async () => {
  const t = exactPopover({ normalizing: true })
  await unlink(t)

  expect(t.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(t.acquireExactAuthority.mock.calls[0][0]?.publish).not.toBe(true)
  expect(t.exactPost).toHaveBeenCalledOnce()
  expect(t.exactPost.mock.calls[0][1]).toEqual({
    rollback: { restore: expect.any(Function) },
  })
  expect(t.host.text).toBe(t.exact.replace('[one](https://one.test/a)', 'one'))
})

test('Remove refuses a stale host: no write, the rollback runs and the DOM shows the host text', async () => {
  const t = exactPopover({ normalizing: false, drift: true })
  await unlink(t)

  expect(t.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(t.host.restored).toBe(1)
  expect(t.host.text).toBe(`${t.exact}Delta\n`)
  expect(t.exactPost.mock.calls[0][1]).toEqual({
    rollback: { restore: expect.any(Function) },
  })
  expect(t.root.innerHTML).toBe(real.render(`${t.exact}Delta\n`))
})

test('Remove declines without a write or a DOM change when acquisition fails', async () => {
  const t = exactPopover({ normalizing: true })
  t.acquireExactAuthority.mockResolvedValueOnce(null)
  const html = t.root.innerHTML
  await unlink(t)

  expect(t.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(t.exactPost).not.toHaveBeenCalled()
  expect(t.root.innerHTML).toBe(html)
})
