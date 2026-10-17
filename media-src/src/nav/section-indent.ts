// Section indentation depth core (Task 649). Pure and DOM-free: the controller (a later step)
// describes each top-level block as an IndentBlock and applies the returned depths.
//
// Depth rule: a top-level heading's depth is its level - 1 (absolute, so skipped levels and a
// document whose top heading is `##` keep their level), capped at MAX_SECTION_DEPTH. Every other
// block takes the depth of the nearest preceding top-level heading; blocks before the first
// heading (intro, front matter) have depth 0.

/** One top-level block, as the caller classifies it. */
export interface IndentBlock {
  /**
   * 1-6 for a top-level heading. Headings nested in a list, quote, callout, Details or HTML block
   * start no section, so the caller must leave `headingLevel` unset for them.
   */
  headingLevel?: number
  /**
   * Lute moves footnote and link-reference definition blocks to the document end in IR and
   * WYSIWYG; they always get depth 0 and do not change the running depth.
   */
  tail?: boolean
  /** Informational block kind (front matter, list, quote, ...); not used by the depth rule. */
  kind?: string
}

export const MAX_SECTION_DEPTH = 5

function headingDepth(level: number): number {
  return Math.min(Math.max(level - 1, 0), MAX_SECTION_DEPTH)
}

/** Depth of every block; O(n). */
export function blockDepths(blocks: readonly IndentBlock[]): number[] {
  const depths = new Array<number>(blocks.length)
  let running = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.tail) {
      depths[i] = 0
      continue
    }
    if (block.headingLevel !== undefined)
      running = headingDepth(block.headingLevel)
    depths[i] = running
  }
  return depths
}

export interface DepthUpdate {
  /** Full depth list for `blocks`; entries outside [from, to) are copied from `previous`. */
  depths: number[]
  /** First recomputed index. */
  from: number
  /** End (exclusive) of the recomputed range. */
  to: number
}

/**
 * Local pass. `previous` holds depths for `blocks` that are valid outside the affected range
 * [start, end) (indices in the NEW list; an empty range marks a removal point). Recomputes from
 * `start` through `end` and then forward until the next top-level heading, whose depth depends only
 * on its own level, so the result equals blockDepths(blocks) at a cost bounded by the affected
 * blocks plus the blocks up to that heading.
 */
export function updateBlockDepths(
  blocks: readonly IndentBlock[],
  previous: readonly number[],
  start: number,
  end: number,
): DepthUpdate {
  const depths = previous.slice(0, blocks.length)
  const from = Math.max(0, Math.min(start, blocks.length))
  let running = 0
  for (let i = from - 1; i >= 0; i--) {
    if (!blocks[i].tail) {
      running = previous[i]
      break
    }
  }
  let i = from
  for (; i < blocks.length; i++) {
    const block = blocks[i]
    if (i >= end && block.headingLevel !== undefined && !block.tail) break
    if (block.tail) {
      depths[i] = 0
      continue
    }
    if (block.headingLevel !== undefined)
      running = headingDepth(block.headingLevel)
    depths[i] = running
  }
  return { depths, from, to: i }
}
