export interface PreviewTaskCheckboxEditRequest {
  source: string
  startOffset: number
  endOffset: number
  marker: string
  checked: boolean
}

export type PreviewTaskCheckboxEditPlan =
  | {
      status: 'planned'
      startOffset: number
      endOffset: number
      replacement: '[ ]' | '[x]'
      after: string
    }
  | { status: 'stale' }

/** A host-side exact-source plan for one GFM task marker; it never rebases offsets. */
export function planPreviewTaskCheckboxEdit(
  currentSource: string,
  request: PreviewTaskCheckboxEditRequest,
): PreviewTaskCheckboxEditPlan {
  const { source, startOffset, endOffset, marker, checked } = request
  if (
    source !== currentSource ||
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset !== startOffset + 3 ||
    endOffset > currentSource.length ||
    currentSource.slice(startOffset, endOffset) !== marker
  )
    return { status: 'stale' }

  const sourceChecked = marker === '[x]' || marker === '[X]'
  if (!(marker === '[ ]' || sourceChecked) || checked === sourceChecked)
    return { status: 'stale' }

  const replacement = checked ? '[x]' : '[ ]'
  return {
    status: 'planned',
    startOffset,
    endOffset,
    replacement,
    after:
      currentSource.slice(0, startOffset) +
      replacement +
      currentSource.slice(endOffset),
  }
}
