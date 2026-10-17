import { describe, expect, it } from 'vitest'
import {
  matchGlob,
  opensInRememberedPreview,
  resolveDefaultMode,
} from '../../src/platform/default-mode'

// Task 282 — which mode a document OPENS in. Precedence, from the task:
//   streaming force-ir  >  explicit setting / glob  >  remembered  >  ir
// The streaming gate is NOT tested here on purpose: it lives in the webview (vditor-init.ts), the
// only place that knows the content length, and it overrides whatever this resolves to.
describe('resolveDefaultMode (task 282)', () => {
  it('returns undefined for "remember" — that IS the pre-282 session-stickiness behaviour', () => {
    expect(
      resolveDefaultMode({
        setting: 'remember',
        byGlob: undefined,
        relPath: 'a.md',
      }),
    ).toBeUndefined()
  })

  it('returns undefined when nothing is configured at all', () => {
    expect(
      resolveDefaultMode({
        setting: undefined,
        byGlob: undefined,
        relPath: 'a.md',
      }),
    ).toBeUndefined()
  })

  it('honours a flat setting', () => {
    expect(
      resolveDefaultMode({ setting: 'sv', byGlob: {}, relPath: 'a.md' }),
    ).toBe('sv')
  })

  it('lets a matching glob WIN over the flat setting — it is the more specific rule', () => {
    expect(
      resolveDefaultMode({
        setting: 'wysiwyg',
        byGlob: { 'docs/**': 'preview' },
        relPath: 'docs/guide.md',
      }),
    ).toBe('preview')
  })

  it('falls back to the flat setting when no glob matches', () => {
    expect(
      resolveDefaultMode({
        setting: 'wysiwyg',
        byGlob: { 'docs/**': 'preview' },
        relPath: 'notes/scratch.md',
      }),
    ).toBe('wysiwyg')
  })

  it('a glob still applies when the flat setting is "remember"', () => {
    expect(
      resolveDefaultMode({
        setting: 'remember',
        byGlob: { 'docs/**': 'preview' },
        relPath: 'docs/guide.md',
      }),
    ).toBe('preview')
  })

  it('ignores a glob value that is not a real mode instead of passing it through', () => {
    // A typo in settings.json must not reach Vditor's constructor as a mode.
    expect(
      resolveDefaultMode({
        setting: 'ir',
        byGlob: { 'docs/**': 'reading' },
        relPath: 'docs/guide.md',
      }),
    ).toBe('ir')
  })

  it('ignores a flat setting that is not a real mode', () => {
    expect(
      resolveDefaultMode({
        setting: 'reading',
        byGlob: undefined,
        relPath: 'a.md',
      }),
    ).toBeUndefined()
  })

  it('skips glob matching entirely for a document outside any workspace folder', () => {
    expect(
      resolveDefaultMode({
        setting: 'ir',
        byGlob: { '**/*.md': 'preview' },
        relPath: undefined,
      }),
    ).toBe('ir')
  })
})

describe('matchGlob (task 282)', () => {
  it('matches ** across directory levels', () => {
    expect(matchGlob('docs/guide.md', 'docs/**')).toBe(true)
    expect(matchGlob('docs/deep/nested/guide.md', 'docs/**')).toBe(true)
  })

  it('lets **/ match ZERO directories — the top level is where most files are', () => {
    expect(matchGlob('docs/x.md', 'docs/**/x.md')).toBe(true)
    expect(matchGlob('docs/a/b/x.md', 'docs/**/x.md')).toBe(true)
  })

  it('keeps a single * inside ONE path segment', () => {
    expect(matchGlob('notes/todo.md', 'notes/*.md')).toBe(true)
    expect(matchGlob('notes/sub/todo.md', 'notes/*.md')).toBe(false)
  })

  it('matches ? as exactly one non-separator character', () => {
    expect(matchGlob('a1.md', 'a?.md')).toBe(true)
    expect(matchGlob('a12.md', 'a?.md')).toBe(false)
    expect(matchGlob('a/b.md', 'a?b.md')).toBe(false)
  })

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(matchGlob('a+b.md', 'a+b.md')).toBe(true)
    expect(matchGlob('axb.md', 'a+b.md')).toBe(false)
    // A literal dot must not match any character.
    expect(matchGlob('readme-md', 'readme.md')).toBe(false)
  })

  it('normalizes windows separators so one pattern works on both platforms', () => {
    expect(matchGlob('docs\\guide.md', 'docs/**')).toBe(true)
  })

  it('anchors the whole path — a pattern is not a substring search', () => {
    expect(matchGlob('src/docs/guide.md', 'docs/**')).toBe(false)
    expect(matchGlob('docs/guide.markdown', 'docs/*.md')).toBe(false)
  })
})

// Task 651 acceptance 1 and 3 — the remembered Preview applies only when no explicit mode wins:
// on x setting (remember/ir/wysiwyg/sv/preview) x path rule (none/ir/preview).
describe('opensInRememberedPreview (task 651)', () => {
  const settings = ['remember', 'ir', 'wysiwyg', 'sv', 'preview'] as const
  const rules = [undefined, 'ir', 'preview'] as const

  for (const previewOn of [true, false]) {
    for (const setting of settings) {
      for (const rule of rules) {
        const expected =
          previewOn && setting === 'remember' && rule === undefined
        it(`previewOn=${previewOn} setting=${setting} rule=${rule ?? 'none'} -> ${expected}`, () => {
          const resolved = resolveDefaultMode({
            setting,
            byGlob: rule ? { '**/*.md': rule } : undefined,
            relPath: 'notes/a.md',
          })
          expect(opensInRememberedPreview(resolved, previewOn)).toBe(expected)
        })
      }
    }
  }

  it('treats an absent or invalid setting like remember', () => {
    const resolved = resolveDefaultMode({
      setting: 'bogus',
      byGlob: undefined,
      relPath: undefined,
    })
    expect(opensInRememberedPreview(resolved, true)).toBe(true)
  })
})
