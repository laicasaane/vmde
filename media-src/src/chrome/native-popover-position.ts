import { elementPanelBounds, elementPanelPosition } from './floating-overlay'
import { innerVditor } from '../util/inner-vditor'

const OWNER_SELECTOR =
  'blockquote,table,h1,h2,h3,h4,h5,h6,[data-type="code-block"],a,img'

/** Keep Vditor's native WYSIWYG element popover beside its rendered owner.
 * Vditor's fixed 21px-above offset can overlap a one-line quote and scroll under
 * the pinned toolbar. Installed by finish-init.ts after Vditor creates the popover;
 * it runs after native placement and on layout changes. */
export function installNativePopoverPlacement(): () => void {
  const inner = innerVditor()
  const editor = inner?.wysiwyg?.element
  const popover = inner?.wysiwyg?.popover
  if (!editor || !popover) return () => undefined
  popover.classList.add('vmde-element-panel')
  let target: HTMLElement | null = null
  let frame = 0
  const resize = new ResizeObserver(() => schedule())
  resize.observe(popover)
  const clearTarget = () => {
    if (target) resize.unobserve(target)
    target = null
  }
  const adoptOwner = (owner: HTMLElement) => {
    if (owner === target) return
    clearTarget()
    target = owner
    resize.observe(owner)
  }
  const currentOwner = () => {
    const node = document.getSelection()?.anchorNode
    const element = node instanceof Element ? node : node?.parentElement
    const owner = element?.closest<HTMLElement>(OWNER_SELECTOR) ?? null
    return owner && editor.contains(owner) ? owner : null
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one native-popover update must validate mode, owner, measured bounds, and coordinate conversion together.
  const position = () => {
    frame = 0
    if (
      inner.currentMode !== 'wysiwyg' ||
      getComputedStyle(popover).display === 'none'
    ) {
      clearTarget()
      if (popover.style.visibility) popover.style.visibility = ''
      return
    }
    const selected = currentOwner()
    if (selected) adoptOwner(selected)
    // A native panel can become visible before its selection event arrives. Leave
    // that first frame to Vditor; only hide a panel whose known owner went stale.
    if (!target) return
    if (!target.isConnected || !editor.contains(target)) {
      // Vditor can leave a popover painted after setValue replaces its owner.
      popover.style.display = 'none'
      clearTarget()
      return
    }
    const scroller = editor.closest('.vditor-content')?.getBoundingClientRect()
    const toolbar = document
      .querySelector('.vditor-toolbar')
      ?.getBoundingClientRect()
    const bounds = elementPanelBounds(
      { width: innerWidth, height: innerHeight },
      scroller,
      toolbar,
    )
    const ownerRect = target.getBoundingClientRect()
    if (
      ownerRect.bottom <= bounds.top ||
      ownerRect.top >= bounds.bottom ||
      ownerRect.right <= bounds.left ||
      ownerRect.left >= bounds.right
    ) {
      if (popover.style.visibility !== 'hidden')
        popover.style.visibility = 'hidden'
      return
    }
    const maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`
    if (popover.style.maxWidth !== maxWidth) popover.style.maxWidth = maxWidth
    const range = document.getSelection()?.rangeCount
      ? document.getSelection()!.getRangeAt(0)
      : null
    const box = popover.getBoundingClientRect()
    const next = elementPanelPosition(
      ownerRect,
      { width: box.width, height: box.height },
      bounds,
      range?.getBoundingClientRect(),
      'above',
    )
    if (!next) {
      if (popover.style.visibility !== 'hidden')
        popover.style.visibility = 'hidden'
      return
    }
    if (popover.style.visibility) popover.style.visibility = ''
    // The popover is absolute inside Vditor, while our geometry is viewport based.
    // Move by the measured viewport delta instead of assuming an offset parent.
    if (Math.abs(next.left - box.left) > 0.5)
      popover.style.left = `${(Number.parseFloat(popover.style.left) || 0) + next.left - box.left}px`
    if (Math.abs(next.top - box.top) > 0.5)
      popover.style.top = `${(Number.parseFloat(popover.style.top) || 0) + next.top - box.top}px`
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(position)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(popover, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
  })
  const editorObserver = new MutationObserver(schedule)
  editorObserver.observe(editor, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  document.addEventListener('selectionchange', schedule)
  const onClick = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null
    const owner = element?.closest<HTMLElement>(OWNER_SELECTOR)
    if (owner && editor.contains(owner)) adoptOwner(owner)
    schedule()
  }
  document.addEventListener('click', onClick)
  document.addEventListener('input', schedule)
  document.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  return () => {
    if (frame) cancelAnimationFrame(frame)
    observer.disconnect()
    editorObserver.disconnect()
    resize.disconnect()
    popover.style.visibility = ''
    document.removeEventListener('selectionchange', schedule)
    document.removeEventListener('click', onClick)
    document.removeEventListener('input', schedule)
    document.removeEventListener('scroll', schedule, true)
    window.removeEventListener('resize', schedule)
    popover.classList.remove('vmde-element-panel')
  }
}
