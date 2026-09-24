import {
  BLOCK_LABELS,
  BLOCK_TYPES,
  type BlockType,
} from '../../../src/shared/block-types'
import {
  createFloatingOverlay,
  type AnchorRect,
} from '../chrome/floating-overlay'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  applyBlockTransformChoice,
  requestBlockTransformOptions,
} from './block-transform-command'
import {
  bubbleShouldShow,
  wikiTargetFromSelection,
} from './selection-bubble-state'
import {
  runSelectedLink,
  type SelectionLinkDeps,
} from './selection-link-actions'
import {
  formatIsActive,
  runSelectionFormat,
  type InlineFormat,
} from './selection-format-actions'

interface BubbleDeps extends SelectionLinkDeps {
  enabled: boolean
  wikiEnabled: boolean
}

interface Bookmark {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  range: Range
  exact: string
  rendered: string
  rect: AnchorRect
}

const FORMAT_BUTTONS: Array<{
  action: InlineFormat
  label: string
  text: string
}> = [
  { action: 'bold', label: 'Bold', text: 'B' },
  { action: 'italic', label: 'Italic', text: 'I' },
  { action: 'strike', label: 'Strikethrough', text: 'S' },
  { action: 'inline-code', label: 'Inline Code', text: '</>' },
]

function selectionInEditor(
  editor: HTMLElement | null,
  range: Range | null,
): boolean {
  return Boolean(
    editor &&
      range &&
      editor.contains(range.startContainer) &&
      editor.contains(range.endContainer) &&
      editor.getAttribute('contenteditable') !== 'false',
  )
}

function liveRangeMatches(retained: Range): boolean {
  const selection = window.getSelection()
  const live = selection?.rangeCount ? selection.getRangeAt(0) : null
  return Boolean(
    live &&
      live.startContainer === retained.startContainer &&
      live.startOffset === retained.startOffset &&
      live.endContainer === retained.endContainer &&
      live.endOffset === retained.endOffset,
  )
}

/** Selection-local controls remain outside Lute's serializer-owned editor DOM. */
export function installSelectionBubble(deps: BubbleDeps): () => void {
  const overlay = createFloatingOverlay('vmde-selection-bubble')
  overlay.element.setAttribute('role', 'toolbar')
  overlay.element.setAttribute('aria-label', 'Selection formatting')
  const row = document.createElement('div')
  row.className = 'vmde-selection-bubble-row'
  const buttons = new Map<InlineFormat, HTMLButtonElement>()
  for (const item of FORMAT_BUTTONS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = item.action
    button.setAttribute('aria-label', item.label)
    button.setAttribute('aria-pressed', 'false')
    button.textContent = item.text
    row.append(button)
    buttons.set(item.action, button)
  }
  const link = document.createElement('button')
  link.type = 'button'
  link.dataset.action = 'link'
  link.textContent = 'Link'
  row.append(link)
  const wiki = document.createElement('button')
  wiki.type = 'button'
  wiki.dataset.action = 'wiki-link'
  wiki.textContent = 'Wiki Link'
  row.append(wiki)
  const turn = document.createElement('button')
  turn.type = 'button'
  turn.dataset.action = 'turn-into'
  turn.textContent = 'Turn Into'
  turn.setAttribute('aria-haspopup', 'menu')
  turn.setAttribute('aria-expanded', 'false')
  row.append(turn)
  const menu = document.createElement('div')
  menu.className = 'vmde-selection-bubble-menu'
  menu.setAttribute('role', 'menu')
  menu.hidden = true
  overlay.element.append(row, menu)
  let bookmark: Bookmark | null = null
  let timer: number | undefined
  let selecting = false
  let spinUntil = 0
  let turnToken: number | null = null

  const hide = () => {
    overlay.hide()
    menu.hidden = true
    turn.setAttribute('aria-expanded', 'false')
    turnToken = null
    bookmark = null
  }
  const valid = (record: Bookmark): boolean =>
    Boolean(
      !isCompositionActive() &&
        window.vditor === record.outer &&
        innerVditor() === record.inner &&
        record.inner.currentMode === record.mode &&
        activeModeElement(record.outer) === record.editor &&
        record.editor.isConnected &&
        record.range.startContainer.isConnected &&
        record.range.endContainer.isConnected &&
        record.editor.contains(record.range.startContainer) &&
        record.editor.contains(record.range.endContainer) &&
        liveRangeMatches(record.range) &&
        deps.snapshotExactMarkdown() === record.exact &&
        record.outer.getValue() === record.rendered,
    )
  const selectionOwner = (): Bookmark | null => {
    const outer = window.vditor
    const inner = innerVditor()
    const mode = inner?.currentMode
    const editor = outer ? activeModeElement(outer) : null
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const owned = selectionInEditor(editor, range)
    const preview = inner?.preview?.element?.style.display === 'block'
    if (
      !bubbleShouldShow({
        enabled: deps.enabled,
        mode,
        preview,
        collapsed: !range || range.collapsed,
        editorOwned: owned,
        composing: isCompositionActive(),
        spinning:
          Boolean(inner?.ir?.composingLock) || performance.now() < spinUntil,
        selecting,
      })
    )
      return null
    if (
      !outer ||
      !inner ||
      !editor ||
      !range ||
      (mode !== 'ir' && mode !== 'wysiwyg')
    )
      return null
    const bounds = range.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    return {
      outer,
      inner,
      editor,
      mode,
      range: range.cloneRange(),
      exact: deps.snapshotExactMarkdown(),
      rendered: outer.getValue(),
      rect: {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      },
    }
  }
  const refresh = () => {
    timer = undefined
    const next = selectionOwner()
    if (!next) {
      hide()
      return
    }
    bookmark = next
    for (const item of FORMAT_BUTTONS) {
      buttons
        .get(item.action)
        ?.setAttribute(
          'aria-pressed',
          String(formatIsActive(item.action, next.range, next.editor)),
        )
    }
    const selected = next.range.toString()
    link.disabled =
      !selected || /[\r\n]/u.test(selected) || selected.length > 256
    wiki.disabled =
      !deps.wikiEnabled || wikiTargetFromSelection(selected) === null
    overlay.show(next.rect)
  }
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(refresh, 32)
  }
  const onPointerDown = (event: PointerEvent) => {
    if (overlay.element.contains(event.target as Node)) {
      event.preventDefault()
      return
    }
    const editor = activeModeElement(window.vditor)
    if (editor?.contains(event.target as Node)) {
      selecting = true
      hide()
    }
  }
  const onPointerUp = () => {
    if (selecting) {
      selecting = false
      schedule()
    }
  }
  const onScroll = (event: Event) => {
    if (!overlay.element.contains(event.target as Node)) hide()
  }
  const onMutation = () => {
    if (bookmark && valid(bookmark)) return
    spinUntil = performance.now() + 16
    hide()
    window.requestAnimationFrame(schedule)
  }
  const showTurnMenu = (owner: Bookmark) => {
    const options = requestBlockTransformOptions(window)
    if (!options) {
      hide()
      return
    }
    turnToken = options.token
    menu.replaceChildren()
    for (const item of options.targets) {
      const option = document.createElement('button')
      option.type = 'button'
      option.dataset.action = 'turn-choice'
      option.dataset.type = item.type
      option.textContent = `${item.type === options.currentType ? '✓ ' : ''}${BLOCK_LABELS[item.type]}`
      option.setAttribute('role', 'menuitemradio')
      option.setAttribute(
        'aria-checked',
        String(item.type === options.currentType),
      )
      option.disabled = item.status !== 'changed'
      if (item.status === 'confirm-required')
        option.title = 'Requires confirmation'
      menu.append(option)
    }
    menu.hidden = false
    turn.setAttribute('aria-expanded', 'true')
    overlay.show(owner.rect)
  }
  const chooseTurnTarget = (button: HTMLButtonElement | null) => {
    const type = button?.dataset.type as BlockType | undefined
    if (turnToken === null || !type || !BLOCK_TYPES.includes(type)) return
    applyBlockTransformChoice(window, turnToken, { type })
    hide()
  }
  const runBubbleAction = (
    action: string,
    button: HTMLButtonElement | null,
    owner: Bookmark,
  ) => {
    if (buttons.has(action as InlineFormat)) {
      runSelectionFormat(action as InlineFormat, owner)
      hide()
    } else if (action === 'link' || action === 'wiki-link') {
      runSelectedLink(action === 'link' ? 'link' : 'wiki', owner, deps)
      hide()
    } else if (action === 'turn-into') showTurnMenu(owner)
    else if (action === 'turn-choice') chooseTurnTarget(button)
  }
  const onClick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action]',
    )
    const action = button?.dataset.action
    const owner = bookmark
    if (!action || !owner || !valid(owner)) {
      hide()
      return
    }
    try {
      runBubbleAction(action, button, owner)
    } catch (error) {
      deps.onError(error)
      hide()
    }
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || overlay.element.hidden) return
    event.preventDefault()
    const owner = bookmark
    hide()
    if (owner?.editor.isConnected) owner.editor.focus({ preventScroll: true })
  }
  const app = document.getElementById('app')
  const observer = app ? new MutationObserver(onMutation) : null
  observer?.observe(app!, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  document.addEventListener('selectionchange', schedule)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('dragstart', hide, true)
  document.addEventListener('compositionstart', hide, true)
  document.addEventListener('compositionend', schedule, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', hide)
  overlay.element.addEventListener('click', onClick)
  return () => {
    if (timer !== undefined) window.clearTimeout(timer)
    observer?.disconnect()
    document.removeEventListener('selectionchange', schedule)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointerup', onPointerUp, true)
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('dragstart', hide, true)
    document.removeEventListener('compositionstart', hide, true)
    document.removeEventListener('compositionend', schedule, true)
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', hide)
    overlay.element.removeEventListener('click', onClick)
    overlay.dispose()
  }
}
