/** Arguments of {@link selectEditorText}: the needle, the offset into it and the selection length. */
export type EditorTextTarget = readonly [
  needle: string,
  offset: number,
  length: number,
]

/**
 * In-page helper for `page.evaluate(selectEditorText, [needle, offset, length])`: focus the active
 * Vditor surface and select `length` characters (0 = a caret) from `offset` into the first
 * occurrence of `needle`. It searches the surface's concatenated text, because Vditor may split
 * the needle across text nodes. It runs in the page, so it must not reference anything outside
 * its own body.
 */
export function selectEditorText([
  needle,
  offset,
  length,
]: EditorTextTarget): void {
  const v = (window as any).vditor
  const root = v.vditor[v.getCurrentMode()].element as HTMLElement
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text)
  const at = nodes
    .map((node) => node.data)
    .join('')
    .indexOf(needle)
  if (at === -1) throw new Error(`text not found: ${needle}`)
  // A start at a node boundary belongs to the next node and an end to the previous one, so the
  // range never reaches across a boundary into a neighbor block. The document's last position
  // belongs to the last node.
  const locate = (target: number, isEnd: boolean): [Text, number] => {
    let rest = target
    for (const [index, node] of nodes.entries()) {
      const last = index === nodes.length - 1
      if (
        rest < node.data.length ||
        ((isEnd || last) && rest === node.data.length)
      )
        return [node, rest]
      rest -= node.data.length
    }
    throw new Error('offset past the end')
  }
  root.focus()
  const range = document.createRange()
  range.setStart(...locate(at + offset, false))
  range.setEnd(...locate(at + offset + length, length > 0))
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}
