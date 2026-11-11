import type { MovableBlock, MovableKind } from '../../../src/shared/block-move'
import { topLevelBlocks } from './section-range'

// Task 733: DOM-to-source pairing helpers moved out of block-handle.ts (bodies unchanged) so the
// generic text model can reuse them. `pairSourceGroups` is the one exception: it is generic over
// the element type and takes `kindOf` (block-handle passes `domKind`).

export interface BlockProjection {
  owner: object
  mode: 'ir' | 'wysiwyg'
  render(markdown: string): string
  serialize(html: string): string
}

export function domKind(element: HTMLElement): MovableKind | null {
  if (element.matches('[data-type="yaml-front-matter"]')) return 'front-matter'
  if (element.matches('[data-type="math-block"]')) return 'math'
  if (element.tagName === 'LI') return 'list-item'
  if (/^H[1-6]$/u.test(element.tagName)) return 'heading'
  if (element.tagName === 'P') return 'paragraph'
  if (element.tagName === 'BLOCKQUOTE') return 'quote'
  if (element.tagName === 'HR') return 'thematic'
  if (element.tagName === 'TABLE') return 'table'
  if (element.matches('[data-type="code-block"]')) return 'fence'
  if (element.matches('[data-type="html-block"]')) return 'html'
  if (element.querySelector(':scope > table')) return 'table'
  return null
}

export function domUnits(
  root: HTMLElement,
  allowTrailing: boolean,
): HTMLElement[] | null {
  const blocks = topLevelBlocks(root)
  const last = blocks.at(-1)
  if (last?.hasAttribute('data-vmde-trailing')) {
    if (
      !allowTrailing ||
      last.tagName !== 'P' ||
      last.children.length ||
      !/^[\u200b\s]*$/u.test(last.textContent ?? '')
    )
      return null
    blocks.pop()
  }
  if (blocks.some((block) => block.hasAttribute('data-vmde-trailing')))
    return null
  const units: HTMLElement[] = []
  for (const block of blocks) {
    if (block.tagName === 'UL' || block.tagName === 'OL') {
      units.push(
        ...Array.from(block.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.tagName === 'LI',
        ),
      )
      if (Array.from(block.children).some((child) => child.tagName !== 'LI'))
        return null
    } else {
      units.push(block)
    }
  }
  return units
}

export function detachedRoot(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

export function canonicalUnit(
  unit: HTMLElement,
  proof: BlockProjection,
): string {
  if (unit.tagName !== 'LI') return proof.serialize(unit.outerHTML)
  const list = unit.parentElement
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return ''
  const isolated = list.cloneNode(false) as HTMLElement
  isolated.append(unit.cloneNode(true))
  return proof.serialize(isolated.outerHTML)
}

export interface SourceDomPair<E = HTMLElement> {
  block: MovableBlock
  members: E[]
}

export function pairSourceGroups<E>(
  source: readonly MovableBlock[],
  elements: E[],
  kindOf: (element: E) => MovableKind | null,
): SourceDomPair<E>[] | null {
  const pairs: SourceDomPair<E>[] = []
  let cursor = 0
  for (const block of source) {
    const expected = block.memberKinds ?? [block.kind]
    const members = elements.slice(cursor, cursor + expected.length)
    if (
      members.length !== expected.length ||
      members.some((element, index) => kindOf(element) !== expected[index])
    )
      return null
    pairs.push({ block, members })
    cursor += expected.length
  }
  return cursor === elements.length ? pairs : null
}

export function canonicalMembers(
  members: HTMLElement[],
  proof: BlockProjection,
): string {
  if (members.length === 1) return canonicalUnit(members[0], proof)
  const pieces: string[] = []
  let listRoot: HTMLElement | null = null
  let listOwner: HTMLElement | null = null
  const flushList = () => {
    if (listRoot) pieces.push(listRoot.outerHTML)
    listRoot = null
    listOwner = null
  }
  for (const member of members) {
    if (
      member.tagName === 'LI' &&
      member.parentElement &&
      (member.parentElement.tagName === 'UL' ||
        member.parentElement.tagName === 'OL')
    ) {
      if (listOwner !== member.parentElement) {
        flushList()
        listOwner = member.parentElement
        listRoot = listOwner.cloneNode(false) as HTMLElement
      }
      listRoot?.append(member.cloneNode(true))
    } else {
      flushList()
      pieces.push(member.outerHTML)
    }
  }
  flushList()
  return proof.serialize(pieces.join(''))
}

export function fragmentMatches(
  pair: SourceDomPair,
  detachedMembers: HTMLElement[],
  liveMembers: HTMLElement[],
  exactMarkdown: string,
  proof: BlockProjection,
): boolean {
  const { block } = pair
  const sourceFragment = exactMarkdown.slice(block.start, block.sectionEnd)
  // A lone `---` at byte zero is front matter to Lute; a preceding paragraph
  // gives the verified thematic break its original non-front-matter context.
  const input =
    block.kind === 'thematic'
      ? `VMDE proof context\n\n${sourceFragment}`
      : sourceFragment
  const fragment = detachedRoot(proof.render(input))
  const units = domUnits(fragment, false)
  if (!units) return false
  const candidate =
    block.kind === 'thematic' &&
    units.length === 2 &&
    domKind(units[0]) === 'paragraph'
      ? units.slice(1)
      : units
  if (!pairSourceGroups([block], candidate, domKind)) return false
  const fragmentMd = canonicalMembers(candidate, proof)
  const detachedMd = canonicalMembers(detachedMembers, proof)
  const liveMd = canonicalMembers(liveMembers, proof)
  return fragmentMd === detachedMd && detachedMd === liveMd
}
