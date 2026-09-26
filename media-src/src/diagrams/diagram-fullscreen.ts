const CHANGE_EVENT = 'vmde-diagram-fullscreen-change'

// Task 576 feedback-path pass: moved here from diagram-controls.ts (which now re-exports it) to
// break a dependency-cruiser `no-circular` finding — diagram-controls.ts only ever consumed this
// module as a value (DIAGRAM_FULLSCREEN_CHANGE_EVENT/fullscreenActionFor), but this module's own
// use of DiagramFullscreenAction was a type-only import running the other way, so the extraction
// resolver still saw a two-file cycle.
export interface DiagramFullscreenAction {
  isActive(): boolean
  toggle(): void
}

interface ActiveFullscreen {
  wrapper: HTMLElement
  placeholder: Comment
  overlay: HTMLElement
  bodyOverflow: string
}

let active: ActiveFullscreen | null = null
let keysInstalled = false
const actions = new WeakMap<HTMLElement, DiagramFullscreenAction>()

function notify(wrapper: HTMLElement): void {
  wrapper.dispatchEvent(new CustomEvent(CHANGE_EVENT))
}

function enterDiagramFullscreen(wrapper: HTMLElement): void {
  if (active?.wrapper === wrapper) return
  exitDiagramFullscreen()
  const placeholder = document.createComment('vmde-diagram-fullscreen-origin')
  wrapper.replaceWith(placeholder)
  const overlay = document.createElement('div')
  overlay.className = 'vmde-diagram-fullscreen-overlay'
  overlay.setAttribute('data-render', '1')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Fullscreen diagram preview')
  const stage = document.createElement('div')
  stage.className = 'vmde-diagram-fullscreen-stage'
  stage.setAttribute('data-render', '1')
  stage.appendChild(wrapper)
  overlay.appendChild(stage)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) exitDiagramFullscreen()
  })
  const bodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  wrapper.setAttribute('data-vmde-fullscreen', 'true')
  document.body.appendChild(overlay)
  active = { wrapper, placeholder, overlay, bodyOverflow }
  notify(wrapper)
  requestAnimationFrame(() => {
    wrapper
      .querySelector<HTMLButtonElement>('[aria-label="Exit fullscreen"]')
      ?.focus({ preventScroll: true })
  })
}

export function exitDiagramFullscreen(): void {
  const current = active
  if (!current) return
  active = null
  current.wrapper.removeAttribute('data-vmde-fullscreen')
  if (current.placeholder.parentNode)
    current.placeholder.replaceWith(current.wrapper)
  else current.wrapper.remove()
  current.overlay.remove()
  document.body.style.overflow = current.bodyOverflow
  notify(current.wrapper)
  current.wrapper
    .querySelector<HTMLButtonElement>('[aria-label="Fullscreen diagram"]')
    ?.focus({ preventScroll: true })
}

function installEscape(): void {
  if (keysInstalled) return
  keysInstalled = true
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !active) return
      event.preventDefault()
      event.stopImmediatePropagation()
      exitDiagramFullscreen()
    },
    true,
  )
}

export function fullscreenActionFor(
  wrapper: HTMLElement,
): DiagramFullscreenAction {
  installEscape()
  const existing = actions.get(wrapper)
  if (existing) return existing
  const action: DiagramFullscreenAction = {
    isActive: () => active?.wrapper === wrapper,
    toggle: () => {
      if (active?.wrapper === wrapper) exitDiagramFullscreen()
      else enterDiagramFullscreen(wrapper)
    },
  }
  actions.set(wrapper, action)
  return action
}

export { CHANGE_EVENT as DIAGRAM_FULLSCREEN_CHANGE_EVENT }
