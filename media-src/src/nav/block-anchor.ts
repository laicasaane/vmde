import type { BlockAnchor } from '../../../src/shared/protocol'
import { headingPathForIndex, textWithout } from './section-range'

const TRANSIENT_SELECTOR = [
  '[data-vmde-transient]',
  '.vditor-ir__marker',
  '[data-type$="marker"]',
  '.vmde-callout-toolbar',
  '.vmde-find-overlay',
].join(', ')

function comparableBlockText(block: HTMLElement): string {
  return `${block.tagName}\n${textWithout(block, TRANSIENT_SELECTOR).replace(/\s+/g, ' ').trim()}`
}

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function headingPath(blocks: readonly HTMLElement[], index: number): string[] {
  return headingPathForIndex(blocks, index).map(
    ({ level, text }) => `${level}:${text}`,
  )
}

export function createBlockAnchor(
  block: HTMLElement,
  blocks: readonly HTMLElement[],
): BlockAnchor {
  const index = Math.max(0, blocks.indexOf(block))
  return {
    hash: hashText(comparableBlockText(block)),
    index,
    headingPath: headingPath(blocks, index),
  }
}

function sharedPathLength(a: readonly string[], b: readonly string[]): number {
  let shared = 0
  while (shared < a.length && a[shared] === b[shared]) shared++
  return shared
}

export function resolveBlockAnchor(
  anchor: BlockAnchor,
  blocks: readonly HTMLElement[],
): HTMLElement | null {
  if (!blocks.length) return null
  const matches = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => hashText(comparableBlockText(block)) === anchor.hash)
  if (matches.length === 1) return matches[0].block
  if (matches.length > 1) {
    matches.sort((a, b) => {
      const aPath = sharedPathLength(
        anchor.headingPath,
        headingPath(blocks, a.index),
      )
      const bPath = sharedPathLength(
        anchor.headingPath,
        headingPath(blocks, b.index),
      )
      return (
        bPath - aPath ||
        Math.abs(a.index - anchor.index) - Math.abs(b.index - anchor.index)
      )
    })
    return matches[0].block
  }
  return blocks[Math.min(Math.max(0, anchor.index), blocks.length - 1)] ?? null
}
