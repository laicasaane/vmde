import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Task 003 — after the history store lands, no module under media-src/src reaches into the Undo
// state or wraps its methods except the two store files. This scan keeps the seam closed:
// a new module that reads `undoStack` or wraps `addCaret` fails here instead of coupling to the
// old engine again.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SRC = path.join(ROOT, 'media-src/src')

// The only files allowed to touch the engine state (posix paths relative to media-src/src).
const STORE_FILES = new Set([
  'editing/history-store.ts',
  'editing/unit-history.ts',
])

// Identifiers no other file may mention.
const FORBIDDEN_NAMES = [
  'undoStack',
  'redoStack',
  'hasUndo',
  'vmdeSeedBaseline',
  'vmdeHeldTimer',
]
// Members no other file may assign to (a wrap or a swap of the engine method).
const ASSIGNED_MEMBERS = ['addToUndoStack', 'undo', 'redo', 'addCaret']

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') sourceFiles(full, out)
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full)
    }
  }
  return out
}

/** Replace comments and string and template bodies with spaces (keeping newlines), so only code
 * remains. One alternation scans left to right, because a comment marker can sit inside a string. */
const NON_CODE =
  /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/g

function codeOnly(src: string): string {
  return src.replace(NON_CODE, (match) => match.replace(/[^\n]/g, ' '))
}

function violations(code: string): string[] {
  const found = new Set<string>()
  for (const name of FORBIDDEN_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(code)) found.add(name)
  }
  if (/(?:\.|\?\.)\s*lastText\b/.test(code)) found.add('.lastText')
  // The computed spellings of the same wrap: `undo[kind] = f`, `Object.defineProperty(undo, ...)`.
  if (/\bundo\s*\[[^\]]*\]\s*=(?!=)/.test(code)) found.add('undo[...] =')
  if (
    /Object\s*\.\s*(?:defineProperty|assign)\s*\(\s*[\w.?]*\bundo\b/.test(code)
  )
    found.add('Object.defineProperty/assign(undo)')
  for (const member of ASSIGNED_MEMBERS) {
    // `x.member = ...`, not `==` or `===`.
    if (new RegExp(`\\.\\s*${member}\\s*=(?!=)`).test(code))
      found.add(`.${member} =`)
  }
  return [...found].sort()
}

describe('history store boundary (Task 003)', () => {
  it('scans the webview sources', () => {
    const files = sourceFiles(SRC).map((file) =>
      path.relative(SRC, file).split(path.sep).join('/'),
    )
    expect(files.length).toBeGreaterThan(100)
    // Guards the allowlist against a typo: both entries name real or planned paths in `editing/`.
    for (const allowed of STORE_FILES)
      expect(allowed.startsWith('editing/')).toBe(true)
  })

  it('lets no module outside the store files touch the Undo state or wrap its methods', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const relative = path.relative(SRC, file).split(path.sep).join('/')
      if (STORE_FILES.has(relative)) continue
      const found = violations(codeOnly(readFileSync(file, 'utf8')))
      if (found.length) offenders.push(`${relative}: ${found.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('ignores comments and string bodies', () => {
    const code = codeOnly(
      [
        '// undoStack in a line comment',
        '/* redoStack and x.undo = 1 in a block comment */',
        "const a = 'hasUndo http://x'",
        'const b = `vmdeHeldTimer`',
        'const c = x.undo === y',
      ].join('\n'),
    )
    expect(violations(code)).toEqual([])
    expect(
      violations(codeOnly('u.addCaret = f\nv?.lastText\nvmdeSeedBaseline()')),
    ).toEqual(['.addCaret =', '.lastText', 'vmdeSeedBaseline'].sort())
  })
})
