import { activeModeElement } from '../util/source-map'

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

async function loadCatalog(): Promise<readonly EmojiEntry[]> {
  if (!catalog) {
    const cdn = window.vditor?.vditor?.options?.cdn
    if (!cdn) throw new Error('Emoji catalog has no Vditor asset base')
    const response = await fetch(
      new URL('../emoji/emoji-catalog.json', `${cdn}/`),
    )
    if (!response.ok) throw new Error(`Emoji catalog failed to load (${response.status})`)
    catalog = (await response.json() as { entries: EmojiEntry[] }).entries
  }
  return catalog
}

export function filterEmoji(
  entries: readonly EmojiEntry[],
  query: string,
): EmojiEntry[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...entries]
  return entries.filter(({ emoji, name, keywords }) =>
    emoji.includes(query) ||
    name.toLocaleLowerCase().includes(needle) ||
    keywords.some((keyword) => keyword.toLocaleLowerCase().includes(needle)),
  )
}

function editorRange(): Range | null {
  const outer = window.vditor
  if (!outer) return null
  const editor = activeModeElement(outer)
  const selection = document.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (range && editor?.contains(range.commonAncestorContainer)) return range.cloneRange()
  const stored = outer.vditor?.[outer.getCurrentMode()]?.range as Range | undefined
  return stored?.cloneRange() ?? null
}

function restoreRange(range: Range): void {
  if (!range.startContainer.isConnected) return
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  const outer = window.vditor
  const state = outer?.vditor?.[outer.getCurrentMode()]
  if (state) state.range = range.cloneRange()
}

function pickerPanel(trigger: HTMLElement): HTMLElement | null {
  return Array.from(trigger.parentElement?.children ?? []).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('vditor-panel'),
  ) ?? null
}

function previewIsOpen(): boolean {
  return (
    window.vditor?.vditor?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

/** Replace Vditor's eight-item Emoji panel with a VMDE-owned search dialog. The button listener is
 * capture-phase because Vditor's bubble listener misses Space activation in the real webview. */
export function installEmojiPicker(toolbar: HTMLElement): () => void {
  const trigger = toolbar.querySelector<HTMLElement>('[data-type="emoji"]')
  const panel = trigger ? pickerPanel(trigger) : null
  if (!trigger || !panel) return () => {}

  let savedRange: Range | null = null
  let query = ''
  const headingIds = new Map<string, string>()
  panel.dataset.vmdeEmojiPicker = '1'
  panel.classList.add('vmde-emoji-picker')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Emoji picker')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')

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

  const close = (returnFocus: boolean) => {
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
    const outer = window.vditor
    if (!outer || previewIsOpen() || !savedRange) return
    const editor = activeModeElement(outer)
    if (!editor || !editor.contains(savedRange.commonAncestorContainer)) {
      close(true)
      return
    }
    outer.focus()
    restoreRange(savedRange)
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!range) return
    range.deleteContents()
    const text = document.createTextNode(entry.emoji)
    range.insertNode(text)
    range.setStartAfter(text)
    range.collapse(true)
    restoreRange(range)
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: entry.emoji, inputType: 'insertText' }),
    )
    close(false)
  }

  const render = () => {
    const filtered = filterEmoji(catalog ?? [], query)
    count.textContent = `${filtered.length.toLocaleString()} emoji`
    clear.hidden = query.length === 0
    results.replaceChildren()
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
      const grid = document.createElement('div')
      grid.className = 'vmde-emoji-picker__grid'
      grid.setAttribute('role', 'group')
      grid.setAttribute('aria-labelledby', id)
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
      results.append(heading, grid)
    }
  }

  const open = async () => {
    if (previewIsOpen()) return
    savedRange = editorRange()
    for (const other of toolbar.querySelectorAll<HTMLElement>(
      '.vditor-hint, .vditor-panel',
    )) {
      if (other !== panel) other.style.display = 'none'
    }
    panel.style.display = 'block'
    trigger.setAttribute('aria-expanded', 'true')
    catalog = await loadCatalog()
    if (panel.style.display !== 'block') return
    render()
    // Vditor's trigger click and VMDE's editor-focus repair both settle after this handler in a
    // real VS Code webview. Focus on the following frame so the searchable dialog owns focus.
    requestAnimationFrame(() => search.focus({ preventScroll: true }))
  }
  const capture = () => {
    savedRange = editorRange()
  }
  const activate = (event: Event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (panel.style.display === 'block') close(true)
    else void open()
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
    }
  }
  const onOutside = (event: MouseEvent) => {
    const target = event.target
    if (panel.style.display === 'block' && target instanceof Node && !panel.contains(target) && !trigger.contains(target))
      close(false)
  }
  trigger.addEventListener('pointerdown', capture, true)
  trigger.addEventListener('click', activate, true)
  search.addEventListener('input', onSearch)
  clear.addEventListener('click', () => {
    search.value = ''
    query = ''
    render()
    search.focus({ preventScroll: true })
  })
  panel.addEventListener('keydown', onKeydown)
  document.addEventListener('mousedown', onOutside, true)
  return () => {
    trigger.removeEventListener('pointerdown', capture, true)
    trigger.removeEventListener('click', activate, true)
    search.removeEventListener('input', onSearch)
    panel.removeEventListener('keydown', onKeydown)
    document.removeEventListener('mousedown', onOutside, true)
  }
}
