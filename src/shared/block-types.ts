/** Task 298's one block-type vocabulary for source planning and the host QuickPick. */
export const BLOCK_TYPES = [
  'paragraph',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'quote',
  'bullet',
  'ordered',
  'task',
  'fence',
  'callout',
] as const

export type BlockType = (typeof BLOCK_TYPES)[number]
export type BlockTransformStatus =
  | 'changed'
  | 'noop'
  | 'unsupported'
  | 'confirm-required'

export const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: 'Paragraph',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  quote: 'Quote',
  bullet: 'Bulleted List',
  ordered: 'Numbered List',
  task: 'Task List',
  fence: 'Code Fence',
  callout: 'Callout',
}
