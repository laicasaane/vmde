// Task 709 — reads the front-matter metadata (`aliases:`, `tags:`) of wiki pages for the cache.
// Cost policy: only the first bytes of a page are read, a page without a leading `---` is rejected
// on its bytes before any string exists, and a buffer is allocated beyond the shared scratch
// only for a page whose front matter is longer than the head.
import { open } from 'node:fs/promises'
import type * as vscode from 'vscode'
import {
  type FrontMatterMetadata,
  frontMatterYaml,
  readFrontMatterMetadata,
} from '../shared/front-matter'

export const WIKI_FRONT_MATTER_HEAD_BYTES = 4096
export const WIKI_FRONT_MATTER_MAX_BYTES = 65536
export const WIKI_METADATA_READ_CONCURRENCY = 16

const Dash = 0x2d
const BomLength = 3

// The three bytes of `---`, after an optional UTF-8 BOM.
function startsWithFenceBytes(bytes: Buffer, length: number): boolean {
  const offset =
    length >= BomLength &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? BomLength
      : 0
  return (
    length >= offset + 3 &&
    bytes[offset] === Dash &&
    bytes[offset + 1] === Dash &&
    bytes[offset + 2] === Dash
  )
}

// Decodes `bytes[0, length)` and returns its front-matter YAML. A buffer that was filled to its end
// may cut the last line, so only complete lines count.
function yamlOf(bytes: Buffer, length: number, full: boolean): string | null {
  const text = bytes.toString('utf8', 0, length)
  return frontMatterYaml(
    full ? text.slice(0, text.lastIndexOf('\n') + 1) : text,
  )
}

/** Metadata of one page, or null (no front matter, not closed within the cap, malformed, unreadable). */
export async function readWikiPageMetadata(
  fsPath: string,
  scratch: Buffer,
): Promise<FrontMatterMetadata | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(fsPath, 'r')
    const { bytesRead } = await handle.read(
      scratch,
      0,
      WIKI_FRONT_MATTER_HEAD_BYTES,
      0,
    )
    if (!startsWithFenceBytes(scratch, bytesRead)) return null
    const headFull = bytesRead === WIKI_FRONT_MATTER_HEAD_BYTES
    let yamlText = yamlOf(scratch, bytesRead, headFull)
    if (yamlText === null) {
      // Not closed in the head: read once more, up to the cap, into a buffer owned by this page.
      if (!headFull) return null
      const large = Buffer.allocUnsafe(WIKI_FRONT_MATTER_MAX_BYTES)
      const second = await handle.read(large, 0, WIKI_FRONT_MATTER_MAX_BYTES, 0)
      yamlText = yamlOf(
        large,
        second.bytesRead,
        second.bytesRead === WIKI_FRONT_MATTER_MAX_BYTES,
      )
      if (yamlText === null) return null
    }
    return readFrontMatterMetadata(yamlText)
  } catch {
    // Unreadable page (deleted meanwhile, virtual path): no metadata, nothing logged per file.
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Reads every file with at most WIKI_METADATA_READ_CONCURRENCY open files; calls `onMetadata` only for non-null results. */
export async function readWikiMetadataBatch(
  files: readonly vscode.Uri[],
  onMetadata: (file: vscode.Uri, metadata: FrontMatterMetadata) => void,
  token?: vscode.CancellationToken,
): Promise<void> {
  let next = 0
  // One scratch buffer per worker, reused for every file that worker reads.
  const worker = async () => {
    const scratch = Buffer.allocUnsafe(WIKI_FRONT_MATTER_HEAD_BYTES)
    while (next < files.length && !token?.isCancellationRequested) {
      const file = files[next++]
      const metadata = await readWikiPageMetadata(file.fsPath, scratch)
      if (metadata) onMetadata(file, metadata)
    }
  }
  const workers = Math.min(WIKI_METADATA_READ_CONCURRENCY, files.length)
  await Promise.all(Array.from({ length: workers }, worker))
}
