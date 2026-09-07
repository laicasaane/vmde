import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const sourceDirectory = path.resolve(directory, '../vendor/emoji')
const output = path.resolve(directory, '../../media/emoji/emoji-catalog.json')
const emojiTestPath = path.join(sourceDirectory, 'emoji-test-17.0.txt')
const annotationsPath = path.join(sourceDirectory, 'cldr-47-annotations-en.json')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const test = await readFile(emojiTestPath, 'utf8')
const annotations = JSON.parse(await readFile(annotationsPath, 'utf8')).annotations
  .annotations

let group = ''
const entries = []
for (const line of test.split(/\r?\n/u)) {
  const nextGroup = /^# group: (.+)$/u.exec(line)?.[1]
  if (nextGroup) {
    group = nextGroup
    continue
  }
  const match = /^([0-9A-F ]+)\s+; fully-qualified\s+#\s+(\S+)\s+E[\d.]+\s+(.+)$/u.exec(line)
  if (!match || !group) continue
  const emoji = String.fromCodePoint(...match[1].trim().split(/\s+/u).map((hex) => Number.parseInt(hex, 16)))
  const annotation = annotations[emoji]
  entries.push({
    emoji,
    group,
    keywords: annotation?.default ?? [],
    name: annotation?.tts?.[0] ?? match[3],
  })
}

if (entries.length !== 3944) throw new Error(`Expected 3944 Emoji 17.0 entries, found ${entries.length}`)

const source = JSON.stringify({
  cldr47Sha256: sha256(JSON.stringify({ annotations })),
  entries,
  unicode17Sha256: sha256(test),
})
await writeFile(output, source)
