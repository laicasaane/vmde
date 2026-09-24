import { findScroller } from '../chrome/toolbar-scroll-guard'

interface PreviewRevisionState {
  invalidateContent(): void
  invalidateConfig(): void
  captureMarkdown(markdown: string): number
  commitMarkdown(renderId: number): string | undefined
  markRendered(instance: object, element: HTMLElement): void
  canReuse(instance: object, element: HTMLElement): boolean
}

export function createPreviewState(owner: object): PreviewRevisionState {
  let contentRevision = 0
  let configRevision = 0
  let committed:
    | {
        owner: object
        element: HTMLElement
        contentRevision: number
        configRevision: number
      }
    | undefined
  let nextRenderId = 0
  let capturedMarkdown:
    | {
        renderId: number
        markdown: string
      }
    | undefined
  return {
    invalidateContent() {
      contentRevision++
      capturedMarkdown = undefined
    },
    invalidateConfig() {
      configRevision++
      capturedMarkdown = undefined
    },
    captureMarkdown(markdown) {
      const renderId = ++nextRenderId
      capturedMarkdown = { renderId, markdown }
      return renderId
    },
    commitMarkdown(renderId) {
      if (capturedMarkdown?.renderId !== renderId) return undefined
      const markdown = capturedMarkdown.markdown
      capturedMarkdown = undefined
      return markdown
    },
    markRendered(instance, element) {
      if (instance !== owner || !element.isConnected) return
      committed = { owner, element, contentRevision, configRevision }
    },
    canReuse(instance, element) {
      return Boolean(
        committed &&
          instance === owner &&
          committed.owner === instance &&
          committed.element === element &&
          element.isConnected &&
          committed.contentRevision === contentRevision &&
          committed.configRevision === configRevision,
      )
    },
  }
}

export function runPreviewEntry(
  state: PreviewRevisionState,
  instance: object,
  element: HTMLElement,
  render: () => void,
  reused: () => void = () => {
    /* optional reuse lifecycle */
  },
): boolean {
  if (state.canReuse(instance, element)) {
    reused()
    return true
  }
  render()
  return false
}

let activeOwner: object | undefined
let activePreviewRefresh: ((markdown: string) => boolean) | undefined

/** Refresh only an already-visible full Preview or SV right pane after a host update. */
export function refreshVisiblePreviewAfterHostUpdate(
  markdown: string,
): boolean {
  return activePreviewRefresh?.(markdown) ?? false
}

export function installPreviewState(
  owner: object,
  snapshotMarkdown: () => string,
): () => void {
  const state = createPreviewState(owner)
  activeOwner = owner
  let pendingScrollRestore:
    | { element: HTMLElement; markdown: string; scrollTop: number }
    | undefined
  const refreshVisiblePreview = (markdown: string): boolean => {
    const vditor = owner as any
    const preview = vditor.preview
    const element = preview?.previewElement as HTMLElement | undefined
    if (
      preview?.element?.style.display !== 'block' ||
      !element?.isConnected ||
      typeof preview.render !== 'function'
    )
      return false
    const scroller = findScroller(element)
    pendingScrollRestore = {
      element,
      markdown,
      scrollTop: scroller.scrollTop,
    }
    state.invalidateContent()
    preview.render.call(preview, vditor, undefined, true)
    return true
  }
  const restorePendingScroll = (
    element: HTMLElement,
    markdown: string | undefined,
  ): void => {
    const restore = pendingScrollRestore
    if (
      !restore ||
      restore.element !== element ||
      restore.markdown !== markdown
    )
      return
    const scroller = findScroller(element)
    const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = Math.min(restore.scrollTop, maximum)
    pendingScrollRestore = undefined
  }
  activePreviewRefresh = refreshVisiblePreview
  const win = window as any
  win.__vmdePreviewSnapshot = snapshotMarkdown
  win.__vmdeCapturePreviewSource = (markdown: string) =>
    state.captureMarkdown(markdown)
  win.__vmdeEnterPreview = (vditor: any) =>
    state.canReuse(vditor, vditor.preview.previewElement)
  win.__vmdePreviewRendered = (
    vditor: any,
    element: HTMLElement,
    renderId?: number,
  ) => {
    if (vditor !== owner || !element.isConnected) return
    const markdown =
      typeof renderId === 'number' ? state.commitMarkdown(renderId) : undefined
    // A late callback from an older delayed render must not mark its stale DOM reusable.
    if (typeof renderId === 'number' && markdown === undefined) return
    state.markRendered(vditor, element)
    if (markdown !== undefined)
      win.__vmdePreviewSourceRendered?.(vditor, element, markdown, renderId)
    const currentSource =
      markdown ??
      (typeof win.__vmdePreviewSnapshot === 'function'
        ? win.__vmdePreviewSnapshot()
        : undefined)
    restorePendingScroll(element, currentSource)
  }
  win.__vmdeInvalidatePreview = (kind: 'content' | 'config') => {
    if (kind === 'config') state.invalidateConfig()
    else state.invalidateContent()
  }
  return () => {
    if (activeOwner !== owner) return
    activeOwner = undefined
    activePreviewRefresh = undefined
    pendingScrollRestore = undefined
    delete win.__vmdePreviewSnapshot
    delete win.__vmdeCapturePreviewSource
    delete win.__vmdeEnterPreview
    delete win.__vmdePreviewRendered
    delete win.__vmdeInvalidatePreview
  }
}
