import {
  matchTaskListControls,
  type SourceTaskMarker,
  type SourceTaskListPathItem,
  type RenderedTaskCheckboxIdentity,
} from './list-normalize-source'
import type { HostMessage, WebviewMessage } from '../../../src/shared/protocol'

export interface PreviewTaskCheckboxBinding {
  input: HTMLInputElement
  marker: SourceTaskMarker
}

function isListElement(element: Element | null): element is HTMLElement {
  return element?.tagName === 'UL' || element?.tagName === 'OL'
}

function isLuteTaskInput(item: HTMLElement, input: HTMLInputElement): boolean {
  if (!item.classList.contains('vditor-task')) return false
  if (item.classList.contains('vditor-task--done') !== input.checked)
    return false

  const parent = input.parentElement
  const tightPosition = parent === item && item.firstElementChild === input
  const loosePosition =
    parent?.tagName === 'P' &&
    parent.parentElement === item &&
    item.firstElementChild === parent &&
    parent.firstElementChild === input
  return tightPosition || loosePosition
}

function listPathForItem(
  preview: HTMLElement,
  firstItem: HTMLElement,
): { path: SourceTaskListPathItem[]; rootList: HTMLElement } | null {
  const path: SourceTaskListPathItem[] = []
  let item: HTMLElement | null = firstItem
  let rootList: HTMLElement | null = null
  while (item && preview.contains(item)) {
    const list: HTMLElement | null = item.parentElement
    if (!isListElement(list)) return null
    const siblings = Array.from(list.children).filter(
      (child) => child.tagName === 'LI',
    )
    const itemIndex = siblings.indexOf(item)
    if (itemIndex < 0) return null
    path.unshift({
      listType: list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul',
      itemIndex,
    })
    rootList = list
    const parentItem: HTMLElement | null =
      list.parentElement?.closest<HTMLElement>('li') ?? null
    if (!parentItem || !preview.contains(parentItem)) break
    item = parentItem
  }
  return rootList ? { path, rootList } : null
}

function topLevelRootIndex(
  preview: HTMLElement,
  rootList: HTMLElement,
): number {
  const topLevelLists = Array.from(
    preview.querySelectorAll<HTMLElement>('ul, ol'),
  ).filter((list) => !list.parentElement?.closest('li'))
  return topLevelLists.indexOf(rootList)
}

function quoteDepthOf(preview: HTMLElement, input: HTMLInputElement): number {
  let quoteDepth = 0
  let ancestor: HTMLElement | null = input
  while (ancestor && preview.contains(ancestor)) {
    if (ancestor.tagName === 'BLOCKQUOTE') quoteDepth++
    ancestor = ancestor.parentElement
  }
  return quoteDepth
}

function identityForInput(
  preview: HTMLElement,
  input: HTMLInputElement,
): RenderedTaskCheckboxIdentity | null {
  const item = input.closest<HTMLElement>('li')
  if (!item || !preview.contains(item) || !isLuteTaskInput(item, input))
    return null
  const container = listPathForItem(preview, item)
  if (!container) return null
  const rootIndex = topLevelRootIndex(preview, container.rootList)
  if (rootIndex < 0) return null
  return {
    checked: input.checked,
    rootIndex,
    quoteDepth: quoteDepthOf(preview, input),
    containerPath: container.path,
  }
}

/**
 * Pair every rendered checkbox with one exact source marker. Any count, state, root, quote, or
 * nesting mismatch returns null so callers can leave the entire rendered checkbox set disabled.
 */
export function matchPreviewTaskCheckboxes(
  markdown: string,
  preview: HTMLElement,
): PreviewTaskCheckboxBinding[] | null {
  const inputs = Array.from(
    preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  )
  const identities: RenderedTaskCheckboxIdentity[] = []
  for (const input of inputs) {
    const identity = identityForInput(preview, input)
    if (!identity) return null
    identities.push(identity)
  }
  const markers = matchTaskListControls(markdown, identities)
  if (!markers) return null
  const bindings: PreviewTaskCheckboxBinding[] = []
  for (const [index, input] of inputs.entries()) {
    const marker = markers[index]
    if (!marker) return null
    bindings.push({ input, marker })
  }
  return bindings
}

type ToggleRequest = Extract<
  WebviewMessage,
  { command: 'toggle-preview-task-checkbox' }
>
type ToggleOutcome = Extract<
  HostMessage,
  { command: 'preview-task-checkbox-outcome' }
>

export interface PreviewTaskCheckboxController {
  onPreviewRendered(
    owner: object,
    element: HTMLElement,
    markdown: string,
    renderId: number,
  ): void
  setEnabled(enabled: boolean): void
  handleOutcome(message: ToggleOutcome): void
  ownsHistoryUpdate(requestId: string, before: string, after: string): boolean
  dispose(): void
}

interface PreviewTaskCheckboxOptions {
  postMessage?: (message: ToggleRequest) => void
  createRequestId?: () => string
}

let activeController: PreviewTaskCheckboxController | undefined

function generatedRequestId(): string {
  return window.crypto.randomUUID()
}

/** Install one delegated click listener on the shared Preview/SV render root. */
export function installPreviewTaskCheckboxes(
  owner: any,
  enabled: boolean,
  options: PreviewTaskCheckboxOptions = {},
): PreviewTaskCheckboxController {
  activeController?.dispose()
  const preview = owner?.preview?.previewElement as HTMLElement | undefined
  const root = preview ?? document.createElement('div')
  const postMessage =
    options.postMessage ??
    ((message: ToggleRequest) => {
      vscode.postMessage(message)
    })
  const createRequestId = options.createRequestId ?? generatedRequestId

  let isEnabled = enabled
  let hostDisabled = false
  let waitingForRender = false
  let waitingForSource: string | undefined
  let source: string | undefined
  let lastRenderedSource: string | undefined
  let mappingValid = false
  let inputs: HTMLInputElement[] = []
  let bindings = new Map<HTMLInputElement, SourceTaskMarker>()
  let pending: { requestId: string; source: string; after: string } | undefined

  const setInputsDisabled = (disabled: boolean) => {
    for (const input of inputs) input.disabled = disabled
  }

  const refreshDisabled = () => {
    const interactive =
      isEnabled &&
      !hostDisabled &&
      !waitingForRender &&
      pending === undefined &&
      mappingValid &&
      source !== undefined &&
      bindings.size === inputs.length
    for (const input of inputs)
      input.disabled = !interactive || !bindings.has(input)
  }

  const invalidateMapping = (waitForRender: boolean) => {
    source = undefined
    bindings.clear()
    mappingValid = false
    waitingForRender = waitForRender
    waitingForSource = undefined
    inputs = Array.from(
      root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )
    setInputsDisabled(true)
  }

  const inputFromClick = (event: MouseEvent): HTMLInputElement | null => {
    if (!(event.target instanceof Element)) return null
    const input = event.target.closest<HTMLInputElement>(
      'input[type="checkbox"]',
    )
    return input && root.contains(input) ? input : null
  }

  const bindingForClick = (
    input: HTMLInputElement,
  ): { marker: SourceTaskMarker; source: string } | null => {
    const marker = bindings.get(input)
    if (
      !marker ||
      !source ||
      !isEnabled ||
      hostDisabled ||
      waitingForRender ||
      pending !== undefined
    )
      return null
    const markerText = source.slice(marker.startOffset, marker.endOffset)
    const markerChecked = markerText === '[x]' || markerText === '[X]'
    if (
      !(markerText === '[ ]' || markerText === '[x]' || markerText === '[X]') ||
      markerChecked !== marker.checked
    )
      return null
    return { marker, source }
  }

  const onClick = (event: MouseEvent) => {
    const input = inputFromClick(event)
    if (!input) return
    const binding = bindingForClick(input)
    if (!binding) {
      event.preventDefault()
      if (bindings.has(input)) invalidateMapping(true)
      else input.disabled = true
      return
    }
    const { marker } = binding
    source = binding.source
    const markerText = source.slice(marker.startOffset, marker.endOffset)

    event.preventDefault()
    event.stopPropagation()
    input.checked = marker.checked
    const requestId = createRequestId()
    const checked = !marker.checked
    const replacement = checked ? '[x]' : '[ ]'
    const request: ToggleRequest = {
      command: 'toggle-preview-task-checkbox',
      requestId,
      source,
      startOffset: marker.startOffset,
      endOffset: marker.endOffset,
      marker: markerText,
      checked,
    }
    pending = {
      requestId,
      source,
      after:
        source.slice(0, marker.startOffset) +
        replacement +
        source.slice(marker.endOffset),
    }
    refreshDisabled()
    // Some hosts complete the checkbox's native click activation after the delegated listener;
    // reassert the source-owned state before the next paint while the host request is pending.
    queueMicrotask(() => {
      if (pending?.requestId === requestId && input.isConnected)
        input.checked = marker.checked
    })
    try {
      postMessage(request)
    } catch {
      pending = undefined
      invalidateMapping(true)
    }
  }

  const onPreviewRendered = (
    renderedOwner: object,
    element: HTMLElement,
    markdown: string,
    _renderId: number,
  ) => {
    if (renderedOwner !== owner || element !== root || !element.isConnected)
      return
    lastRenderedSource = markdown
    inputs = Array.from(
      root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )
    const mapping = matchPreviewTaskCheckboxes(markdown, root)
    if (!mapping || mapping.length !== inputs.length) {
      invalidateMapping(false)
      return
    }
    source = markdown
    bindings = new Map(mapping.map(({ input, marker }) => [input, marker]))
    mappingValid = true
    if (
      waitingForRender &&
      (waitingForSource === undefined || waitingForSource === markdown)
    ) {
      waitingForRender = false
      waitingForSource = undefined
    }
    refreshDisabled()
  }

  const onSourceRendered = (
    renderedOwner: object,
    element: HTMLElement,
    markdown: string,
    renderId: number,
  ) => {
    previousSourceRendered?.(renderedOwner, element, markdown, renderId)
    onPreviewRendered(renderedOwner, element, markdown, renderId)
  }

  root.addEventListener('click', onClick, true)
  const win = window as any
  const previousSourceRendered = win.__vmdePreviewSourceRendered
  win.__vmdePreviewSourceRendered = onSourceRendered

  const controller: PreviewTaskCheckboxController = {
    onPreviewRendered,
    setEnabled(nextEnabled) {
      if (nextEnabled && !isEnabled) hostDisabled = false
      isEnabled = nextEnabled
      refreshDisabled()
    },
    ownsHistoryUpdate(requestId, before, after) {
      return (
        activeController === controller &&
        root.isConnected &&
        pending?.requestId === requestId &&
        pending.source === before &&
        pending.after === after
      )
    },
    handleOutcome(message) {
      const request = pending
      if (!request || message.requestId !== request.requestId) return
      pending = undefined
      if (message.status === 'disabled' || message.status === 'error') {
        hostDisabled = true
        invalidateMapping(false)
        return
      }
      const ackSource = message.source
      if (
        message.status === 'applied' &&
        ackSource === request.after &&
        lastRenderedSource === ackSource &&
        mappingValid
      ) {
        source = ackSource
        waitingForRender = false
        waitingForSource = undefined
        refreshDisabled()
        return
      }
      if (
        message.status === 'stale' &&
        lastRenderedSource === ackSource &&
        mappingValid
      ) {
        source = ackSource
        waitingForRender = false
        waitingForSource = undefined
        refreshDisabled()
        return
      }
      source = undefined
      waitingForRender = true
      waitingForSource = ackSource
      refreshDisabled()
    },
    dispose() {
      root.removeEventListener('click', onClick, true)
      if (win.__vmdePreviewSourceRendered === onSourceRendered) {
        if (previousSourceRendered)
          win.__vmdePreviewSourceRendered = previousSourceRendered
        else delete win.__vmdePreviewSourceRendered
      }
      if (activeController === controller) activeController = undefined
    },
  }
  activeController = controller
  refreshDisabled()
  return controller
}

export function setPreviewTaskCheckboxesEnabled(enabled: boolean): void {
  activeController?.setEnabled(enabled)
}

export function finishPreviewTaskCheckboxOutcome(message: ToggleOutcome): void {
  activeController?.handleOutcome(message)
}

/** The host update precedes its outcome. Match all raw transaction fields to the
 * still-pending click before the webview may preserve native editor history. */
export function isPendingPreviewTaskCheckboxHistoryUpdate(
  requestId: string,
  before: string,
  after: string,
): boolean {
  return activeController?.ownsHistoryUpdate(requestId, before, after) ?? false
}
