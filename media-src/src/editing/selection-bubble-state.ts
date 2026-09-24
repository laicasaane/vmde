export interface BubbleConditions {
  enabled: boolean
  mode: string | undefined
  preview: boolean
  collapsed: boolean
  editorOwned: boolean
  composing: boolean
  spinning: boolean
  selecting: boolean
}

/** UI eligibility only; action handlers revalidate the live selection and editor. */
export function bubbleShouldShow(state: BubbleConditions): boolean {
  return (
    state.enabled &&
    (state.mode === 'ir' || state.mode === 'wysiwyg') &&
    !state.preview &&
    !state.collapsed &&
    state.editorOwned &&
    !state.composing &&
    !state.spinning &&
    !state.selecting
  )
}

/** Author a single exact wiki target from selected text, without silently trimming bytes. */
export function wikiTargetFromSelection(selected: string): string | null {
  if (
    !selected ||
    selected.length > 128 ||
    selected !== selected.trim() ||
    Array.from(selected).some(
      (char) =>
        char.charCodeAt(0) < 32 ||
        char === '[' ||
        char === ']' ||
        char === '|' ||
        char === '\\',
    )
  )
    return null
  return selected
}
