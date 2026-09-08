import { activeModeElement } from '../util/source-map'
import {
  filterRecentEmoji,
  normalizeRecentEmoji,
  recordRecentEmoji,
} from './emoji-recents'
import {
  applyEmojiInsertion,
  captureEmojiInsertion,
  type EmojiInsertionBookmark,
  invalidateEmojiInsertion,
} from './emoji-insertion'

export interface EmojiEntry {
  emoji: string
  group: string
  keywords: readonly string[]
  name: string
}

const GROUP_ORDER = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
]

let catalog: readonly EmojiEntry[] | null = null
let closeOnSelect = true
let initialRecentState: unknown
let recentStateListener: ((value: unknown) => void) | undefined

export function setEmojiPickerRecentState(value: unknown): void {
  initialRecentState = value
  recentStateListener?.(value)
}

/** Live editor setting: false keeps the picker open for consecutive insertions. */
export function setEmojiPickerCloseOnSelect(value: boolean): void {
  closeOnSelect = value
}

async function loadCatalog(): Promise<readonly EmojiEntry[]> {
  if (!catalog) {
    const cdn = window.vditor?.vditor?.options?.cdn
    if (!cdn) throw new Error('Emoji catalog has no Vditor asset base')
    const response = await fetch(
      new URL('../emoji/emoji-catalog.json', `${cdn}/`),
    )
    if (!response.ok)
      throw new Error(`Emoji catalog failed to load (${response.status})`)
    catalog = ((await response.json()) as { entries: EmojiEntry[] }).entries
  }
  return catalog
}

export function filterEmoji(
  entries: readonly EmojiEntry[],
  query: string,
): EmojiEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...entries]
  return entries.filter(
    ({ emoji, name, keywords }) =>
      emoji.includes(query) ||
      name.toLocaleLowerCase().includes(needle) ||
      keywords.some((keyword) => keyword.toLocaleLowerCase().includes(needle)),
  )
}

function pickerPanel(trigger: HTMLElement): HTMLElement | null {
  return (
    Array.from(trigger.parentElement?.children ?? []).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.classList.contains('vditor-panel'),
    ) ?? null
  )
}

function previewIsOpen(): boolean {
  return (
    window.vditor?.vditor?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

function verticalEmojiTile(
  key: 'ArrowDown' | 'ArrowUp',
  target: HTMLButtonElement,
  tiles: readonly HTMLButtonElement[],
): HTMLButtonElement | undefined {
  const gridTiles = Array.from(
    target.parentElement?.querySelectorAll<HTMLButtonElement>(
      '.vmde-emoji-picker__tile',
    ) ?? [],
  )
  const gridCurrent = gridTiles.indexOf(target)
  const columns = Math.max(
    1,
    new Set(gridTiles.map((tile) => tile.offsetLeft)).size,
  )
  if (key === 'ArrowDown') {
    // A short recent grid must flow into the catalog's first tile, not skip a whole visual row.
    return (
      gridTiles[gridCurrent + columns] ??
      tiles[tiles.indexOf(gridTiles.at(-1)!) + 1]
    )
  }
  return (
    gridTiles[gridCurrent - columns] ?? tiles[tiles.indexOf(gridTiles[0]) - 1]
  )
}

function nextEmojiTile(
  key: string,
  target: HTMLButtonElement,
  tiles: readonly HTMLButtonElement[],
): HTMLButtonElement | undefined {
  const current = tiles.indexOf(target)
  if (current < 0) return undefined
  if (key === 'ArrowRight') return tiles[current + 1]
  if (key === 'ArrowLeft') return tiles[current - 1]
  if (key === 'Home') return tiles[0]
  if (key === 'End') return tiles.at(-1)
  if (key === 'ArrowDown' || key === 'ArrowUp')
    return verticalEmojiTile(key, target, tiles)
  return undefined
}

/** Replace Vditor's eight-item Emoji panel with a VMDE-owned search dialog. Capture the trigger
 * activation so Vditor's original toggler, which still retains its detached panel, cannot reopen it. */
export function installEmojiPicker(toolbar: HTMLElement): () => void {
  const trigger = toolbar.querySelector<HTMLElement>('[data-type="emoji"]')
  const vditorPanel = trigger ? pickerPanel(trigger) : null
  if (!trigger || !vditorPanel)
    return () => {
      // No Vditor Emoji toolbar item in this configuration.
    }

  // Emoji.ts binds click and mouseover listeners directly to its panel. Reusing that element after
  // replacing its children lets those listeners read Vditor-only data-value/tip nodes from our
  // picker controls. A shallow replacement preserves the panel's placement and CSS hooks while
  // giving VMDE exclusive ownership of the interaction surface.
  const panel = vditorPanel.cloneNode(false) as HTMLElement
  vditorPanel.replaceWith(panel)

  interface RawEditorEndpoints {
    editor: HTMLElement
    mode: string
    startContainer: Node
    startOffset: number
    endContainer: Node
    endOffset: number
  }
  let rawEditorEndpoints: RawEditorEndpoints | null = null
  let preparedBookmark: EmojiInsertionBookmark | null = null
  let savedBookmark: EmojiInsertionBookmark | null = null
  let applyingEmoji = false
  let allowCollapsedEndpointUpdate = false
  let query = ''
  let recents: string[] = []
  let recentsInitialized = false
  let openGeneration = 0
  const onEditorFocus = (event: FocusEvent) => {
    if (panel.style.display !== 'block') return
    if (applyingEmoji) return
    if (event.target !== activeModeElement(window.vditor!)) return
    event.stopPropagation()
    requestAnimationFrame(() => search.focus({ preventScroll: true }))
  }
  document.addEventListener('focus', onEditorFocus, true)
  const headingIds = new Map<string, string>()
  panel.dataset.vmdeEmojiPicker = '1'
  panel.classList.add('vmde-emoji-picker')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Emoji picker')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  // The submenu ARIA observer was installed before this cloned panel exists. Keep the trigger in
  // sync when toolbar overflow or Vditor's generic hidePanel closes the owned replacement.
  const expandedObserver = new MutationObserver(() => {
    trigger.setAttribute(
      'aria-expanded',
      panel.style.display === 'block' ? 'true' : 'false',
    )
    if (panel.style.display !== 'block') {
      savedBookmark = null
      preparedBookmark = null
      invalidateEmojiInsertion()
    }
  })
  expandedObserver.observe(panel, {
    attributes: true,
    attributeFilter: ['style'],
  })

  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Search emoji'
  search.setAttribute('aria-label', 'Search emoji')
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = 'Clear search'
  clear.setAttribute('aria-label', 'Clear emoji search')
  const count = document.createElement('p')
  count.setAttribute('aria-live', 'polite')
  const results = document.createElement('div')
  results.className = 'vmde-emoji-picker__results'
  const header = document.createElement('div')
  header.className = 'vmde-emoji-picker__search'
  header.append(search, clear)
  panel.replaceChildren(header, count, results)

  const persistRecents = (sequence: string) => {
    try {
      window.vscode?.postMessage({ command: 'record-emoji-recent', sequence })
    } catch {
      // Host/profile storage is best-effort; the successful edit and in-session history remain.
    }
  }

  const close = (returnFocus: boolean) => {
    openGeneration++
    savedBookmark = null
    preparedBookmark = null
    invalidateEmojiInsertion()
    panel.style.display = 'none'
    trigger.setAttribute('aria-expanded', 'false')
    if (returnFocus) {
      // The search field's focusout schedules VMDE's editor-focus repair for the next frame.
      // Return after that repair settles, otherwise the repair steals the picker trigger focus.
      const deadline = performance.now() + 1500
      const retry = () => {
        trigger.focus({ preventScroll: true })
        if (document.activeElement === trigger || performance.now() >= deadline)
          return
        requestAnimationFrame(retry)
      }
      requestAnimationFrame(retry)
    }
  }

  const select = (entry: EmojiEntry) => {
    if (previewIsOpen() || !savedBookmark) {
      close(true)
      return
    }
    applyingEmoji = true
    let result: ReturnType<typeof applyEmojiInsertion>
    try {
      result = applyEmojiInsertion(savedBookmark, entry.emoji)
    } finally {
      applyingEmoji = false
    }
    if (!result) {
      close(true)
      return
    }
    savedBookmark = result.nextBookmark
    recents = recordRecentEmoji(recents, entry.emoji)
    persistRecents(entry.emoji)
    render()
    if (closeOnSelect) close(false)
    else {
      search.focus({ preventScroll: true })
    }
  }

  const render = () => {
    const filtered = filterEmoji(catalog ?? [], query)
    count.textContent = `${filtered.length.toLocaleString()} emoji`
    clear.hidden = query.length === 0
    results.replaceChildren()
    const recentHeading = document.createElement('h2')
    recentHeading.id = 'vmde-emoji-recents-heading'
    recentHeading.textContent = 'Recently used'
    results.append(recentHeading)
    const recentEntries = filterRecentEmoji(recents, catalog ?? [], query)
    if (recentEntries.length) {
      results.append(createGrid(recentEntries, recentHeading.id, 'recent'))
    } else {
      const recentEmpty = document.createElement('p')
      recentEmpty.className = 'vmde-emoji-picker__recent-empty'
      recentEmpty.textContent = query
        ? 'No matching recently used emoji.'
        : 'No recently used emoji yet.'
      results.append(recentEmpty)
    }
    if (!filtered.length) {
      const empty = document.createElement('p')
      empty.textContent = 'No emoji found.'
      results.append(empty)
      return
    }
    const groups = new Map<string, EmojiEntry[]>()
    for (const entry of filtered) {
      const list = groups.get(entry.group) ?? []
      list.push(entry)
      groups.set(entry.group, list)
    }
    for (const group of GROUP_ORDER) {
      const entries = groups.get(group)
      if (!entries?.length) continue
      const heading = document.createElement('h2')
      const id = headingIds.get(group) ?? `vmde-emoji-group-${headingIds.size}`
      headingIds.set(group, id)
      heading.id = id
      heading.textContent = group
      const grid = createGrid(entries, id, 'catalog')
      results.append(heading, grid)
    }
  }

  const applyRecentState = (state: unknown) => {
    initialRecentState = state
    if (!catalog) return
    recents = normalizeRecentEmoji(
      state,
      new Set(catalog.map((entry) => entry.emoji)),
    )
    recentsInitialized = true
    if (panel.style.display === 'block') render()
  }
  recentStateListener = applyRecentState

  const createGrid = (
    entries: readonly EmojiEntry[],
    labelledBy: string,
    kind: 'catalog' | 'recent',
  ) => {
    const grid = document.createElement('div')
    grid.className = 'vmde-emoji-picker__grid'
    grid.dataset.emojiGrid = kind
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-labelledby', labelledBy)
    for (const entry of entries) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'vmde-emoji-picker__tile'
      tile.textContent = entry.emoji
      tile.setAttribute('aria-label', entry.name)
      tile.title = entry.name
      tile.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        select(entry)
      })
      grid.append(tile)
    }
    return grid
  }

  const open = async (bookmark: EmojiInsertionBookmark | null) => {
    const generation = ++openGeneration
    if (previewIsOpen()) return
    savedBookmark = bookmark
    for (const other of toolbar.querySelectorAll<HTMLElement>(
      '.vditor-hint, .vditor-panel',
    )) {
      if (other !== panel) other.style.display = 'none'
    }
    panel.style.display = 'block'
    // The original Vditor toggler normally chooses an arrow direction. VMDE owns this panel, so
    // constrain its absolute offset after it has a measurable width; this keeps a narrow split
    // inside the webview rather than letting the fixed 400px preference hang past its right edge.
    // Clear the previous correction before measuring: otherwise reopening measures the already
    // translated bounds and replaces the correction with zero, pushing a narrow picker out again.
    panel.style.transform = ''
    const panelBounds = panel.getBoundingClientRect()
    const left = Math.max(
      8,
      Math.min(
        panelBounds.left,
        document.documentElement.clientWidth - panelBounds.width - 8,
      ),
    )
    panel.style.transform = `translateX(${left - panelBounds.left}px)`
    trigger.setAttribute('aria-expanded', 'true')
    catalog = await loadCatalog()
    if (generation !== openGeneration) return
    if (!recentsInitialized) {
      recents = normalizeRecentEmoji(
        initialRecentState,
        new Set(catalog.map((entry) => entry.emoji)),
      )
      recentsInitialized = true
    }
    // Vditor's editor-focus listener can hide every submenu while the asynchronous catalog loads.
    // Reassert only this still-current explicit picker opening; dismissal advances openGeneration.
    panel.style.display = 'block'
    render()
    // Vditor's trigger click and VMDE's editor-focus repair both settle after this handler in a
    // real VS Code webview. Focus on the following frame so the searchable dialog owns focus.
    requestAnimationFrame(() => {
      if (generation !== openGeneration || panel.style.display !== 'block')
        return
      search.focus({ preventScroll: true })
    })
  }
  const rangeFromEndpoints = (): Range | null => {
    const endpoints = rawEditorEndpoints
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    if (
      !endpoints ||
      !outer ||
      !editor ||
      endpoints.editor !== editor ||
      endpoints.mode !== outer.getCurrentMode() ||
      !endpoints.startContainer.isConnected ||
      !endpoints.endContainer.isConnected
    )
      return null
    try {
      const range = document.createRange()
      range.setStart(endpoints.startContainer, endpoints.startOffset)
      range.setEnd(endpoints.endContainer, endpoints.endOffset)
      return range
    } catch {
      return null
    }
  }
  const currentEditorRange = (): Range | null => {
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const live =
      range &&
      editor?.contains(range.startContainer) &&
      editor.contains(range.endContainer)
        ? range
        : null
    const retained = rangeFromEndpoints()
    return live && !live.collapsed ? live : (retained ?? live)
  }
  const prepare = () => {
    const range = currentEditorRange()
    preparedBookmark = range ? captureEmojiInsertion(range) : null
  }
  const activate = (event: Event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (panel.style.display === 'block') close(true)
    else {
      if (!preparedBookmark) prepare()
      const bookmark = preparedBookmark
      preparedBookmark = null
      void open(bookmark)
    }
  }
  const rememberEditorEndpoints = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (
      !outer ||
      !editor ||
      !range ||
      !editor.contains(range.startContainer) ||
      !editor.contains(range.endContainer)
    )
      return
    if (
      !editor.contains(document.activeElement) &&
      range.collapsed &&
      range.startOffset === 0
    )
      return
    const retainedSelectionIsDirectional =
      rawEditorEndpoints !== null &&
      rawEditorEndpoints.editor === editor &&
      rawEditorEndpoints.mode === outer.getCurrentMode() &&
      (rawEditorEndpoints.startContainer !== rawEditorEndpoints.endContainer ||
        rawEditorEndpoints.startOffset !== rawEditorEndpoints.endOffset)
    // Toolbar focus/caret repair can collapse the browser selection after a genuine editor
    // selectionchange but before the trigger's pointerdown. Only an editor-owned pointer/key gesture
    // may replace a retained directional selection with a caret; a replacement editor/mode has no
    // live directional selection to protect and must accept its new caret.
    if (
      range.collapsed &&
      retainedSelectionIsDirectional &&
      !allowCollapsedEndpointUpdate
    )
      return
    rawEditorEndpoints = {
      editor,
      mode: outer.getCurrentMode(),
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
    }
    allowCollapsedEndpointUpdate = false
  }
  const noteEditorGesture = (event: Event) => {
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    const target = event.target
    if (editor && target instanceof Node && editor.contains(target))
      allowCollapsedEndpointUpdate = true
  }
  const prepareKeyboardHandoff = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    if (!editor?.contains(document.activeElement)) return
    // Window capture precedes escape-toolbar and structural-selection's document capture. Escape
    // refreshes the source bookmark before either listener can consume/move focus; its armed Tab
    // then preserves that bookmark rather than relying on a document listener that never runs.
    if (event.key === 'Escape' || !preparedBookmark) prepare()
  }
  const prepareKeyboardActivation = (event: KeyboardEvent) => {
    if ((event.key === 'Enter' || event.key === ' ') && !preparedBookmark)
      prepare()
  }
  const onSearch = () => {
    query = search.value
    render()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const target = event.target
    if (target === search && event.key === 'ArrowDown') {
      event.preventDefault()
      results
        .querySelector<HTMLButtonElement>('.vmde-emoji-picker__tile')
        ?.focus({
          preventScroll: true,
        })
      return
    }
    if (
      !(target instanceof HTMLButtonElement) ||
      !target.classList.contains('vmde-emoji-picker__tile')
    )
      return
    const destination = nextEmojiTile(
      event.key,
      target,
      Array.from(
        results.querySelectorAll<HTMLButtonElement>('.vmde-emoji-picker__tile'),
      ),
    )
    if (!destination) return
    event.preventDefault()
    destination.focus({
      // Arrow/Home/End can move across a long catalog; scroll the bounded results region so the
      // focused tile remains perceptible instead of leaving keyboard focus off-screen.
      preventScroll: false,
    })
  }
  const onOutside = (event: MouseEvent) => {
    const target = event.target
    if (
      panel.style.display === 'block' &&
      target instanceof Node &&
      !panel.contains(target) &&
      !trigger.contains(target)
    )
      close(false)
  }
  trigger.addEventListener('pointerdown', prepare, true)
  // A keyboard click has no pointerdown; capture only when Tab did not already preserve the
  // editor range, otherwise Vditor's toolbar focus path can replace that saved selection.
  trigger.addEventListener('keydown', prepareKeyboardActivation, true)
  trigger.addEventListener('click', activate, true)
  search.addEventListener('input', onSearch)
  clear.addEventListener('click', () => {
    search.value = ''
    query = ''
    render()
    search.focus({ preventScroll: true })
  })
  panel.addEventListener('keydown', onKeydown)
  document.addEventListener('selectionchange', rememberEditorEndpoints)
  document.addEventListener('pointerdown', noteEditorGesture, true)
  document.addEventListener('keydown', noteEditorGesture, true)
  window.addEventListener('keydown', prepareKeyboardHandoff, true)
  document.addEventListener('mousedown', onOutside, true)
  return () => {
    trigger.removeEventListener('pointerdown', prepare, true)
    trigger.removeEventListener('keydown', prepareKeyboardActivation, true)
    trigger.removeEventListener('click', activate, true)
    search.removeEventListener('input', onSearch)
    panel.removeEventListener('keydown', onKeydown)
    document.removeEventListener('selectionchange', rememberEditorEndpoints)
    document.removeEventListener('pointerdown', noteEditorGesture, true)
    document.removeEventListener('keydown', noteEditorGesture, true)
    window.removeEventListener('keydown', prepareKeyboardHandoff, true)
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('focus', onEditorFocus, true)
    expandedObserver.disconnect()
    invalidateEmojiInsertion()
    if (recentStateListener === applyRecentState)
      recentStateListener = undefined
  }
}
