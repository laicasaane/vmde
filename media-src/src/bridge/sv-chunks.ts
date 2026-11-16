import {
  type MovableBlock,
  type MovableKind,
  scanMovableBlocks,
} from '../../../src/shared/block-move'

// Task 733 / 015 (task 015 section 6.2 D-1): the Source chunks of a model text. Vditor's Source build
// (`sv/process.ts:54-62`) splits the spin output into `data-block` divs at two consecutive newline
// spans. The real spin keeps a fenced block or a math block holding a blank line in one div, keeps a
// list run (tight or loose) in one div, inserts a blank line where a block follows a heading or a list
// follows a paragraph (so those are separate divs), and splits an HTML enclosure at its blank lines.
// One chunk is one Source unit; its `memberKinds` count the divs it spans. Every chunk is an opaque
// text block for the model (`paragraph`, or `html-group` over several divs): the IR table and list
// paths of the text model never run for Source. The boundary table is `sv-chunks.test.ts` (S-01).

const SOURCE_KIND: MovableKind = 'paragraph'

/** The divs of one block: an HTML enclosure renders one div per member, every other block one. */
const divsOf = (block: MovableBlock): number =>
  block.kind === 'html-group' ? (block.memberKinds?.length ?? 1) : 1

export function scanSourceChunks(markdown: string): MovableBlock[] {
  const blocks = scanMovableBlocks(markdown)
  const chunks: MovableBlock[] = []
  let start = 0
  for (let i = 0; i < blocks.length; i++) {
    const first = blocks[i]
    let last = first
    while (
      first.listRun >= 0 &&
      i + 1 < blocks.length &&
      blocks[i + 1].listRun === first.listRun
    )
      last = blocks[++i]
    const divs = divsOf(first)
    const chunk: MovableBlock = {
      kind: divs > 1 ? 'html-group' : SOURCE_KIND,
      start,
      end: last.end,
      // The last chunk owns the text's tail (its trailing line breaks).
      sectionEnd: i === blocks.length - 1 ? markdown.length : last.sectionEnd,
      listRun: -1,
    }
    if (divs > 1)
      chunk.memberKinds = Array.from({ length: divs }, () => SOURCE_KIND)
    chunks.push(chunk)
    start = chunk.sectionEnd
  }
  return chunks
}
