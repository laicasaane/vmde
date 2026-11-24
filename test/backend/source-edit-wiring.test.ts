import { readdirSync, readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

// Task 733 / 045 (F2): boot/main.ts is the webview entry and cannot run in a unit test. Its editor
// input marks belong to `installSourceEditSignals` (boot/finish-init.ts), whose behaviour the
// finish-init consumer cases cover with trusted and untrusted dispatches; this checks the wiring on
// the compiled module (no comments or types): the one installer call passes only the editor filter,
// and no other user-input mark carries an argument (a trust). The real-VS-Code case in
// sv-first-edit.spec.ts counts the marks of an actual key.
// The non-test TypeScript files under `dir`.
const webviewFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return webviewFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  })

// The receiver of every `compositionend` listener registered on a window object in the capture phase.
const windowCaptureEnds = (text: string): string[] => {
  const found: string[] = []
  const call = /([\w.$[\]]+)\s*\.addEventListener\(\s*['"`]compositionend['"`]/g
  for (const match of text.matchAll(call)) {
    // The call's own arguments, by balanced parentheses.
    const start = (match.index ?? 0) + match[0].length
    let depth = 1
    let end = start
    while (depth > 0 && end < text.length) {
      const char = text[end++]
      if (char === '(') depth++
      else if (char === ')') depth--
    }
    const windowLike = /^(window|win|globalThis|self|.*defaultView)$/.test(
      match[1],
    )
    const capture = /,\s*true\b|capture:\s*true/.test(
      text.slice(start, end - 1),
    )
    if (windowLike && capture) found.push(match[1])
  }
  return found
}

describe('Source edit signal wiring in boot/main.ts (task 733 / 045)', () => {
  const compiled = transformSync(
    readFileSync('media-src/src/boot/main.ts', 'utf8'),
    { loader: 'ts' },
  ).code
  // The argument text of every call to `name`, by balanced parentheses.
  const callArguments = (name: string): string[] => {
    const found: string[] = []
    const pattern = new RegExp(`\\b${name}\\(`, 'g')
    for (const match of compiled.matchAll(pattern)) {
      let depth = 1
      let at = (match.index ?? 0) + match[0].length
      const start = at
      while (depth > 0 && at < compiled.length) {
        const char = compiled[at++]
        if (char === '(') depth++
        else if (char === ')') depth--
      }
      found.push(
        compiled
          .slice(start, at - 1)
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
    return found
  }

  it('installs the Source edit signals once, with only the editor filter', () => {
    expect(callArguments('installSourceEditSignals')).toEqual([
      '{ isEditorInput: isActiveEditorInput }',
    ])
  })

  // Q-290: the installer's window-capture `compositionend` listener runs before any other one, because
  // it is the first statement boot/main.ts runs after its imports and no module registers another.
  it('installs the Source edit signals as the first statement after the imports', () => {
    const at = compiled.indexOf('installSourceEditSignals(')
    const before = compiled
      .slice(0, at)
      .replace(/import\s+(?:[^'"`;]*?\sfrom\s+)?['"][^'"]+['"];?/g, '')
      .trim()
    expect(before).toBe('')
  })

  it('leaves the installer the only window-capture compositionend listener of the webview', () => {
    const found = webviewFiles('media-src/src').flatMap((file) =>
      windowCaptureEnds(readFileSync(file, 'utf8')).map(
        (receiver) => `${file}: ${receiver}`,
      ),
    )
    expect(found).toEqual(['media-src/src/boot/finish-init.ts: window'])
  })

  it('makes no user-input mark that carries a trust', () => {
    expect(
      callArguments('markUserInput').filter((text) => text !== ''),
    ).toEqual([])
  })
})
