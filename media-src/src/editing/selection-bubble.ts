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
  sameSourceBlockIndexKey,
  type SourceBlockIndexHandle,
  type SourceBlockIndexKey,
} from '../nav/source-block-index'
import {
  cancelBlockTransformChoice,
  requestBlockTransformOptions,
  type BlockTransformOptions,
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
  /** Exact bytes plus the rendered serialization from one serializer run (Task 574). */
  snapshotPair(): { exact: string; rendered: string }
  /** Shared per-revision source block index; only the key is read for passive display. */
  index: SourceBlockIndexHandle
}

/** Display-only bookmark: identifies the selection with the shared index key, no serialization. */
interface DisplayBookmark {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  range: Range
  key: SourceBlockIndexKey
  rect: AnchorRect
}

/** Built once, at action time only, from one `snapshotPair()` call — satisfies the
 * link/wiki-link owner contract in selection-link-actions.ts, which re-validates
 * `exact`/`rendered` against fresh reads before applying a Markdown mutation. */
interface ActionBookmark extends DisplayBookmark {
  exact: string
  rendered: string
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

function canEditFenceLanguage(
  options: BlockTransformOptions | null,
  item: BlockTransformOptions['targets'][number] | undefined,
): boolean {
  return Boolean(
    options &&
      item?.type === 'fence' &&
      item.status === 'noop' &&
      options.currentType === 'fence' &&
      options.spans.length === 1 &&
      typeof options.fenceLanguage === 'string',
  )
}

function turnOptionButton(
  options: BlockTransformOptions,
  item: BlockTransformOptions['targets'][number],
): HTMLButtonElement {
  const editLanguage = canEditFenceLanguage(options, item)
  const option = document.createElement('button')
  option.type = 'button'
  option.dataset.action = 'turn-choice'
  option.dataset.type = item.type
  option.textContent = `${item.type === options.currentType ? '✓ ' : ''}${item.status === 'confirm-required' ? '⚠ ' : ''}${BLOCK_LABELS[item.type]}${editLanguage ? ' · Edit Language…' : ''}`
  option.setAttribute('role', 'menuitemradio')
  option.setAttribute('aria-checked', String(item.type === options.currentType))
  option.disabled =
    item.status !== 'changed' &&
    item.status !== 'confirm-required' &&
    !editLanguage
  if (editLanguage) option.dataset.editLanguage = 'true'
  if (item.status === 'confirm-required') {
    option.dataset.lossy = 'true'
    option.title = 'Requires confirmation before changing Markdown structure'
  }
  return option
}

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

// Extracted from selectionOwner() to keep its cognitive complexity under the Biome limit
// (Task 574 Checkpoint 6 added the index-key gate to that function).
function bubbleVisible(
  enabled: boolean,
  inner: InnerVditor | null,
  mode: InnerVditor['currentMode'] | undefined,
  range: Range | null,
  owned: boolean,
  selecting: boolean,
  spinUntil: number,
): boolean {
  return bubbleShouldShow({
    enabled,
    mode,
    preview: inner?.preview?.element?.style.display === 'block',
    collapsed: !range || range.collapsed,
    editorOwned: owned,
    composing: isCompositionActive(),
    spinning:
      Boolean(inner?.ir?.composingLock) || performance.now() < spinUntil,
    selecting,
  })
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
  let bookmark: DisplayBookmark | null = null
  let timer: number | undefined
  let selecting = false
  let spinUntil = 0
  let turnToken: number | null = null
  let turnOptions: BlockTransformOptions | null = null
  // Task 577: settle-time index builds (Details state, block-handle hover) used to run before
  // this bubble's first frame and stalled it by one whole-document build. A scheduled refresh
  // holds those builds until the bubble has painted, or has decided to stay hidden.
  let releaseBuildHold: (() => void) | null = null
  let paintToken = 0
  const releaseBuilds = () => {
    const release = releaseBuildHold
    releaseBuildHold = null
    release?.()
  }
  const releaseBuildsAfterPaint = () => {
    const token = ++paintToken
    // The rAF callback runs before the frame paints; the task queued from it runs after.
    window.requestAnimationFrame(() =>
      window.setTimeout(() => {
        if (token === paintToken && timer === undefined) releaseBuilds()
      }),
    )
  }

  const hide = () => {
    if (turnToken !== null) cancelBlockTransformChoice(turnToken)
    overlay.hide()
    menu.hidden = true
    turn.setAttribute('aria-expanded', 'false')
    turnToken = null
    turnOptions = null
    bookmark = null
  }
  // No serialization here: identity/connectedness/composition are read-only DOM checks (H8: also
  // requires editor === key.root) that both validity checks below share.
  const identityValid = (record: DisplayBookmark): boolean =>
    Boolean(
      !isCompositionActive() &&
        window.vditor === record.outer &&
        innerVditor() === record.inner &&
        record.inner.currentMode === record.mode &&
        activeModeElement(record.outer) === record.editor &&
        record.editor === record.key.root &&
        record.editor.isConnected &&
        record.range.startContainer.isConnected &&
        record.range.endContainer.isConnected &&
        record.editor.contains(record.range.startContainer) &&
        record.editor.contains(record.range.endContainer) &&
        liveRangeMatches(record.range),
    )
  // Replaces the two full serializations this used to take on every mutation batch
  // (Task 574 Checkpoint 6) with the shared index key.
  const valid = (record: DisplayBookmark): boolean =>
    identityValid(record) &&
    sameSourceBlockIndexKey(record.key, deps.index.currentKey())
  // While the Turn Into menu is open, its own capture (requestBlockTransformOptions ->
  // block-transform-command.ts) inserts and removes rewrap markers (rewrap-command.ts) to map
  // the live selection to an exact source range. That transient, self-inflicted DOM churn bumps
  // the shared index's domRevision even though the source bytes never change, and choosing a
  // menu target does not consume this bookmark at all — the host re-verifies the choice against
  // its own retained source proof when the token resolves (block-transform-command.ts). So
  // tolerate a domRevision-only key change here, while still requiring the same root/owner/mode
  // and EditSync revision, which still catches a real edit, reselection or mode switch.
  const menuOpenValid = (record: DisplayBookmark): boolean => {
    if (!identityValid(record)) return false
    const key = deps.index.currentKey()
    return Boolean(
      key &&
        key.root === record.key.root &&
        key.owner === record.key.owner &&
        key.mode === record.key.mode &&
        key.revision === record.key.revision,
    )
  }
  const selectionOwner = (): DisplayBookmark | null => {
    const outer = window.vditor
    const inner = innerVditor()
    const mode = inner?.currentMode
    const editor = outer ? activeModeElement(outer) : null
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const owned = selectionInEditor(editor, range)
    if (
      !bubbleVisible(
        deps.enabled,
        inner,
        mode,
        range,
        owned,
        selecting,
        spinUntil,
      )
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
    // currentKey() only drains pending mutation records and compares identity/revision; it never
    // builds the index or serializes. A null key (SV, or no revision/projection authority) hides.
    const key = deps.index.currentKey()
    if (!key) return null
    return {
      outer,
      inner,
      editor,
      mode,
      range: range.cloneRange(),
      key,
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
      paintToken++
      releaseBuilds()
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
    releaseBuildsAfterPaint()
  }
  const schedule = () => {
    if (deps.enabled && !releaseBuildHold)
      releaseBuildHold = deps.index.holdBuilds()
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
    if (
      bookmark &&
      (turnToken !== null ? menuOpenValid(bookmark) : valid(bookmark))
    )
      return
    spinUntil = performance.now() + 16
    hide()
    window.requestAnimationFrame(schedule)
  }
  const showTurnMenu = (owner: DisplayBookmark) => {
    const options = requestBlockTransformOptions(window)
    if (!options) {
      hide()
      return
    }
    turnToken = options.token
    turnOptions = options
    menu.replaceChildren()
    for (const item of options.targets)
      menu.append(turnOptionButton(options, item))
    menu.hidden = false
    turn.setAttribute('aria-expanded', 'true')
    overlay.show(owner.rect)
  }
  const chooseTurnTarget = (button: HTMLButtonElement | null) => {
    const type = button?.dataset.type as BlockType | undefined
    if (turnToken === null || !type || !BLOCK_TYPES.includes(type)) return
    const target = turnOptions?.targets.find((item) => item.type === type)
    const editLanguage =
      button?.dataset.editLanguage === 'true' &&
      canEditFenceLanguage(turnOptions, target)
    if (
      !target ||
      (target.status !== 'changed' &&
        target.status !== 'confirm-required' &&
        !editLanguage)
    )
      return
    const token = turnToken
    const language = editLanguage ? turnOptions?.fenceLanguage : undefined
    // The host owns both ordinary and warning-confirmed choices. Clear the local
    // menu without canceling the token that the host must echo after focus transfer.
    turnToken = null
    hide()
    window.vscode.postMessage({
      command: 'block-transform-consent',
      token,
      target: {
        type,
        language,
      },
      status: editLanguage
        ? 'edit-language'
        : target.status === 'confirm-required'
          ? 'confirm-required'
          : 'changed',
      losses: target.losses,
    })
  }
  const runBubbleAction = (
    action: string,
    button: HTMLButtonElement | null,
    owner: DisplayBookmark,
  ) => {
    if (buttons.has(action as InlineFormat)) {
      // Formatting keeps its existing Range owner contract (editor/mode/range only).
      runSelectionFormat(action as InlineFormat, owner)
      hide()
    } else if (action === 'link' || action === 'wiki-link') {
      // Link/Wiki Link is the only action that needs exact+rendered bytes, so it is the only
      // one that pays a serialization — exactly one, from the already-validated owner.
      const actionOwner: ActionBookmark = { ...owner, ...deps.snapshotPair() }
      runSelectedLink(action === 'link' ? 'link' : 'wiki', actionOwner, deps)
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
    // A menu-target choice doesn't consume `owner` (see menuOpenValid above); every other
    // action does, and keeps the full index-key check.
    const owned =
      owner && (action === 'turn-choice' ? menuOpenValid(owner) : valid(owner))
    if (!action || !owner || !owned) {
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
    releaseBuilds()
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
