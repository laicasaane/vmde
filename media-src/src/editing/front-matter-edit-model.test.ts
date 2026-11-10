import { describe, expect, it } from 'vitest'
import {
  editFrontMatterDocument,
  parseFrontMatterTable,
} from './front-matter-edit-model'

// Task 725 — the lazy table model (edit rows, D1 placeholders, D2 duplicates) and the whole-document
// edit: the new front-matter text replaces exactly the old one; every other byte is kept.

const BODY = '\n# Heading\n\nbody text\n'

describe('parseFrontMatterTable', () => {
  it('gives every row of a clean map its edit row, in order', () => {
    const result = parseFrontMatterTable('title: "Hi"\ntags:\n  - a\n  - b')
    expect(result.status).toBe('table')
    if (result.status !== 'table' || !('edit' in result)) throw new Error()
    expect(result.rows.map((row) => row.key)).toEqual(['title', 'tags'])
    expect(result.edit).toEqual([
      {
        index: 0,
        kind: 'scalar',
        duplicate: false,
        key: 'title',
        value: 'Hi',
        yaml: false,
      },
      {
        index: 1,
        kind: 'block',
        duplicate: false,
        key: 'tags',
        value: '\n  - a\n  - b',
        yaml: true,
      },
    ])
  })

  it('shows several `: ""` placeholders as rows instead of the malformed-YAML warning (D1)', () => {
    const result = parseFrontMatterTable('title: x\n: ""\n: ""')
    if (result.status !== 'table' || !('edit' in result)) throw new Error()
    expect(result.rows.map((row) => row.key)).toEqual(['title', '', ''])
    expect(result.edit.map((row) => row.kind)).toEqual([
      'scalar',
      'placeholder',
      'placeholder',
    ])
    expect(result.rows[1].value).toEqual({ kind: 'text', text: '' })
  })

  it('shows duplicate keys as rows marked duplicate, each with its own value (D2)', () => {
    const result = parseFrontMatterTable('a: 1\nb: [x, y]\na: 3')
    if (result.status !== 'table' || !('edit' in result)) throw new Error()
    expect(result.edit.map((row) => row.duplicate)).toEqual([true, false, true])
    expect(result.rows[0].value).toEqual({ kind: 'text', text: '1' })
    expect(result.rows[1].value.kind).toBe('list')
    expect(result.rows[2].value).toEqual({ kind: 'text', text: '3' })
  })

  it('keeps other malformed YAML read-only with its warning', () => {
    const result = parseFrontMatterTable('a: [1, 2\nb: 2')
    expect(result.status).toBe('error')
    expect('edit' in result).toBe(false)
  })

  it('keeps a map the edit core cannot address read-only (no edit rows)', () => {
    const result = parseFrontMatterTable('&k a: 1\nb: 2')
    expect(result.status).toBe('table')
    expect('edit' in result).toBe(false)
  })

  it('keeps the empty state for an empty front matter', () => {
    expect(parseFrontMatterTable('')).toEqual({ status: 'empty' })
  })
})

describe('editFrontMatterDocument', () => {
  const doc = (yaml: string, eol = '\n') =>
    `---${eol}${yaml.replace(/\r?\n/g, eol)}${eol}---${eol}${BODY.replace(/\n/g, eol)}`

  it('splices a value edit into the front-matter range only', () => {
    const before = doc('# note\ntitle: "Old"  # keep\ndate: 2026-01-01')
    expect(
      editFrontMatterDocument(before, { kind: 'value', index: 0, text: 'New' }),
    ).toBe(doc('# note\ntitle: "New"  # keep\ndate: 2026-01-01'))
  })

  it('keeps CRLF line breaks, comments and quote styles', () => {
    const yaml = '# c\r\na: \'x\'\r\nb: "y"\r\nc: plain'
    const before = doc(yaml, '\r\n')
    const after = editFrontMatterDocument(before, {
      kind: 'key',
      index: 1,
      text: 'bee',
    })
    expect(after).toBe(doc('# c\r\na: \'x\'\r\nbee: "y"\r\nc: plain', '\r\n'))
    expect(
      editFrontMatterDocument(before, { kind: 'move', index: 0, to: 2 }),
    ).toBe(doc('# c\r\nb: "y"\r\nc: plain\r\na: \'x\'', '\r\n'))
  })

  it('appends `: ""` as the last front-matter line, repeatedly', () => {
    let text: string | null = doc('a: 1')
    for (let count = 0; count < 3; count++)
      text = editFrontMatterDocument(text as string, { kind: 'append' })
    expect(text).toBe(doc('a: 1\n: ""\n: ""\n: ""'))
  })

  it('moves an entry several places in one edit and removes one', () => {
    const before = doc('a: 1\nb: 2\nc: 3')
    expect(
      editFrontMatterDocument(before, { kind: 'move', index: 2, to: 0 }),
    ).toBe(doc('c: 3\na: 1\nb: 2'))
    expect(editFrontMatterDocument(before, { kind: 'remove', index: 1 })).toBe(
      doc('a: 1\nc: 3'),
    )
  })

  it('writes a YAML-box value verbatim with the document line breaks', () => {
    const before = doc('tags:\n  - a\n  - b\nz: 1', '\r\n')
    expect(
      editFrontMatterDocument(before, {
        kind: 'value',
        index: 0,
        text: '\n  - a\n  - c',
      }),
    ).toBe(doc('tags:\n  - a\n  - c\nz: 1', '\r\n'))
  })

  it('adds the line break an empty block lacks before its closing fence', () => {
    expect(
      editFrontMatterDocument('---\n---\nbody\n', { kind: 'append' }),
    ).toBe('---\n: ""\n---\nbody\n')
  })

  it('is null without a closed front matter or for an index that does not exist', () => {
    expect(
      editFrontMatterDocument('# no front matter\n', { kind: 'append' }),
    ).toBe(null)
    expect(editFrontMatterDocument('---\na: 1\n', { kind: 'append' })).toBe(
      null,
    )
    expect(
      editFrontMatterDocument(doc('a: 1'), { kind: 'remove', index: 4 }),
    ).toBe(null)
  })
})
