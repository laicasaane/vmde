import { describe, expect, it } from 'vitest'
import { classifyHref } from '../../src/shared/link-target'

// Task 359, L1: the href classifier is a pure function — exhaustively pin every case named in
// the task's verification list (windows path / posix path / spaces+percent / mailto: / http /
// command: / directory-is-NOT-classifier's-job) plus the hostile scheme-bypass cases the
// security-boundary hard rule requires (file:, vscode-resource:, javascript:, data:, case
// variants, encoded scheme delimiters).

describe('classifyHref', () => {
  it('classifies http/https as external', () => {
    expect(classifyHref('https://example.com/a')).toEqual({
      kind: 'external',
      href: 'https://example.com/a',
    })
    expect(classifyHref('http://example.com')).toEqual({
      kind: 'external',
      href: 'http://example.com',
    })
    expect(classifyHref('HTTPS://EXAMPLE.COM')).toEqual({
      kind: 'external',
      href: 'HTTPS://EXAMPLE.COM',
    })
  })

  it('refuses an empty href', () => {
    expect(classifyHref('')).toEqual({
      kind: 'refused',
      reason: 'empty link target',
    })
    expect(classifyHref('   ')).toEqual({
      kind: 'refused',
      reason: 'empty link target',
    })
  })

  describe('allowlisted schemes', () => {
    it('mailto:, tel: pass through unparsed', () => {
      expect(classifyHref('mailto:test@example.com')).toEqual({
        kind: 'scheme',
        href: 'mailto:test@example.com',
      })
      expect(classifyHref('tel:+15551234')).toEqual({
        kind: 'scheme',
        href: 'tel:+15551234',
      })
    })

    it('is case-insensitive on the scheme name', () => {
      expect(classifyHref('MAILTO:test@example.com')).toEqual({
        kind: 'scheme',
        href: 'MAILTO:test@example.com',
      })
    })
  })

  describe('refused schemes (security boundary — allowlist, not a denylist)', () => {
    it('refuses vscode:/vscode-insiders: — confused-deputy risk, MEASURED not assumed', () => {
      // vscode-scheme-urihandler-probe.spec.ts (real VS Code): vscode.open(Uri.parse(
      // 'vscode://<publisher>.<extid>/<path>?<query>')) — the exact call the 'scheme' branch
      // makes — DISPATCHES to that extension's registered vscode.window.registerUriHandler,
      // query string (including attacker-controlled parameters) delivered verbatim, no
      // workspace-trust gate. The classifier can't tell a benign `vscode:settings` apart from
      // `vscode://other-extension/exploit?…` — same shape, so the whole scheme is refused.
      expect(classifyHref('vscode:settings').kind).toBe('refused')
      expect(classifyHref('vscode://publisher.ext/path?q=1').kind).toBe(
        'refused',
      )
      expect(classifyHref('vscode-insiders:extension/foo').kind).toBe('refused')
    })

    it('refuses command: — arbitrary command execution', () => {
      const c = classifyHref('command:workbench.action.terminal.new')
      expect(c.kind).toBe('refused')
    })

    it('refuses command: regardless of case', () => {
      expect(classifyHref('CoMmAnD:workbench.action.terminal.new').kind).toBe(
        'refused',
      )
    })

    it('refuses javascript: and data: — script injection', () => {
      expect(classifyHref('javascript:alert(1)').kind).toBe('refused')
      expect(
        classifyHref('data:text/html,<script>alert(1)</script>').kind,
      ).toBe('refused')
    })

    it('refuses file: — would bypass the workspace/doc-dir containment check', () => {
      expect(classifyHref('file:///etc/passwd').kind).toBe('refused')
      expect(classifyHref('FILE:///etc/passwd').kind).toBe('refused')
    })

    it('refuses vscode-resource:/vscode-webview:/vscode-file: — internal webview schemes', () => {
      expect(classifyHref('vscode-resource:/etc/passwd').kind).toBe('refused')
      expect(classifyHref('vscode-webview://x/etc/passwd').kind).toBe('refused')
      expect(classifyHref('vscode-file:///etc/passwd').kind).toBe('refused')
    })

    it('refuses an unknown/unrecognized scheme', () => {
      expect(classifyHref('ftp://example.com/x').kind).toBe('refused')
    })
  })

  describe('windows drive-letter paths (task 359 bug #1)', () => {
    it('classifies "C:\\a\\b.md" as local, NOT as scheme "c"', () => {
      // Deliberately NOT asserting the resolved fsPath here — path.resolve('C:\\a\\b.md') is
      // platform-dependent garbage on POSIX. The classifier-level contract under test is just
      // that the drive letter is never mistaken for a URI scheme.
      expect(classifyHref('C:\\Users\\x\\file.md')).toEqual({
        kind: 'local',
        path: 'C:\\Users\\x\\file.md',
        fragment: undefined,
      })
    })

    it('classifies "C:/a/b.md" (forward-slash drive path) as local too', () => {
      expect(classifyHref('C:/Users/x/file.md').kind).toBe('local')
    })
  })

  describe('posix relative/absolute paths', () => {
    it('classifies a bare relative filename as local', () => {
      expect(classifyHref('sibling.md')).toEqual({
        kind: 'local',
        path: 'sibling.md',
        fragment: undefined,
      })
    })

    it('classifies "./" and "../" relative paths as local', () => {
      expect(classifyHref('./sub/a.md').kind).toBe('local')
      expect(classifyHref('../b.md').kind).toBe('local')
    })

    it("classifies an absolute posix path as local (containment is onOpenLink's job, not the classifier's)", () => {
      expect(classifyHref('/etc/passwd')).toEqual({
        kind: 'local',
        path: '/etc/passwd',
        fragment: undefined,
      })
    })
  })

  describe('percent-decoding (spaces + literal percent)', () => {
    it('decodes a percent-encoded space', () => {
      expect(classifyHref('my%20file.md')).toEqual({
        kind: 'local',
        path: 'my file.md',
        fragment: undefined,
      })
    })

    it('leaves a literal space untouched', () => {
      expect(classifyHref('my file.md')).toEqual({
        kind: 'local',
        path: 'my file.md',
        fragment: undefined,
      })
    })

    it('falls back to the raw text when "%" is not a valid escape (literal percent in a filename)', () => {
      expect(classifyHref('50%.md')).toEqual({
        kind: 'local',
        path: '50%.md',
        fragment: undefined,
      })
    })

    it('decodes %23 to a literal "#" (NOT treated as a fragment delimiter)', () => {
      expect(classifyHref('my%23file.md')).toEqual({
        kind: 'local',
        path: 'my#file.md',
        fragment: undefined,
      })
    })
  })

  describe('fragments', () => {
    it('splits "file.md#heading" into path + fragment, decoding the path', () => {
      expect(classifyHref('my%20notes.md#heading')).toEqual({
        kind: 'local',
        path: 'my notes.md',
        fragment: 'heading',
      })
    })

    it('classifies "#heading" alone as a same-doc anchor, not a local path', () => {
      expect(classifyHref('#heading')).toEqual({
        kind: 'same-doc-anchor',
        fragment: 'heading',
      })
    })

    it('treats a bare "#" as a same-doc anchor with an empty fragment', () => {
      expect(classifyHref('#')).toEqual({
        kind: 'same-doc-anchor',
        fragment: '',
      })
    })
  })

  describe('scheme detection happens before percent-decoding (encoded scheme-delimiter bypass)', () => {
    it('does NOT decode "%63ommand:x" into the command: scheme — treated as a literal local path', () => {
      // "%63" decodes to "c", so a naive decode-then-classify order would turn this into
      // "command:x" and refuse it for the wrong reason (or, worse, decode-then-allow a scheme
      // that was disguised to dodge a denylist). Classify-then-decode means this is just an
      // unresolvable local filename — never a scheme.
      const result = classifyHref('%63ommand:x')
      expect(result.kind).toBe('local')
    })
  })

  // Task 635 — line-number notation (`path:line[:col]`, `#L…` fragments).
  describe('line-number notation (Task 635)', () => {
    const loc = (href: string) => {
      const r = classifyHref(href)
      return r.kind === 'local' ? r.location : undefined
    }

    it('parses path:line and path:line:col via suffix', () => {
      expect(classifyHref('src/foo.ts:42')).toEqual({
        kind: 'local',
        path: 'src/foo.ts:42',
        fragment: undefined,
        location: { path: 'src/foo.ts', line: 42, via: 'suffix' },
      })
      expect(loc('src/foo.ts:42:5')).toEqual({
        path: 'src/foo.ts',
        line: 42,
        column: 5,
        via: 'suffix',
      })
    })

    it('handles relative, parent and absolute paths', () => {
      expect(loc('./a.ts:3')).toEqual({
        path: './a.ts',
        line: 3,
        via: 'suffix',
      })
      expect(loc('../a.ts:3')).toEqual({
        path: '../a.ts',
        line: 3,
        via: 'suffix',
      })
      expect(loc('/abs/a.ts:3')).toEqual({
        path: '/abs/a.ts',
        line: 3,
        via: 'suffix',
      })
    })

    it('treats a bare dotted-extension scheme lookalike with a numeric remainder as local', () => {
      expect(classifyHref('foo.ts:42').kind).toBe('local')
      expect(loc('foo.ts:42')).toEqual({
        path: 'foo.ts',
        line: 42,
        via: 'suffix',
      })
      expect(loc('foo.ts:42:5')).toEqual({
        path: 'foo.ts',
        line: 42,
        column: 5,
        via: 'suffix',
      })
      expect(loc('./Makefile:12')).toEqual({
        path: './Makefile',
        line: 12,
        via: 'suffix',
      })
    })

    it('parses #L fragments', () => {
      expect(classifyHref('src/foo.ts#L42')).toEqual({
        kind: 'local',
        path: 'src/foo.ts',
        fragment: 'L42',
        location: { path: 'src/foo.ts', line: 42, via: 'fragment' },
      })
      expect(loc('a.ts#L42-L50')).toEqual({
        path: 'a.ts',
        line: 42,
        endLine: 50,
        via: 'fragment',
      })
      expect(loc('a.ts#L42-50')).toEqual({
        path: 'a.ts',
        line: 42,
        endLine: 50,
        via: 'fragment',
      })
      expect(loc('a.ts#L42C5')).toEqual({
        path: 'a.ts',
        line: 42,
        column: 5,
        via: 'fragment',
      })
      expect(loc('a.ts#L42C5-L50C8')).toEqual({
        path: 'a.ts',
        line: 42,
        column: 5,
        endLine: 50,
        endColumn: 8,
        via: 'fragment',
      })
    })

    it('drops a reversed range end', () => {
      expect(loc('a.ts#L50-L42')).toEqual({
        path: 'a.ts',
        line: 50,
        via: 'fragment',
      })
    })

    it('clamps line and column 0 to 1', () => {
      expect(loc('a.ts#L0')?.line).toBe(1)
      expect(loc('foo.ts:0')?.line).toBe(1)
      expect(loc('foo.ts:0:0')).toEqual({
        path: 'foo.ts',
        line: 1,
        column: 1,
        via: 'suffix',
      })
    })

    it('ignores malformed #L fragments', () => {
      for (const h of ['a.ts#l42', 'a.ts#L', 'a.ts#L42x', 'a.ts#L-5']) {
        expect(loc(h)).toBeUndefined()
      }
    })

    it('lets the suffix win over a #L fragment and keeps the fragment', () => {
      const r = classifyHref('foo.ts:42#L50')
      expect(r).toMatchObject({ kind: 'local', fragment: 'L50' })
      expect(loc('foo.ts:42#L50')).toEqual({
        path: 'foo.ts',
        line: 42,
        via: 'suffix',
      })
    })

    it('handles Windows drive paths', () => {
      expect(loc('C:\\x\\y.ts:12')).toEqual({
        path: 'C:\\x\\y.ts',
        line: 12,
        via: 'suffix',
      })
      expect(loc('C:/x/y.ts:12:5')).toEqual({
        path: 'C:/x/y.ts',
        line: 12,
        column: 5,
        via: 'suffix',
      })
      expect(loc('C:\\x\\y.ts')).toBeUndefined()
      expect(loc('C:\\x\\y.ts#L12')).toEqual({
        path: 'C:\\x\\y.ts',
        line: 12,
        via: 'fragment',
      })
      expect(classifyHref('C:\\12')).toMatchObject({ kind: 'local' })
      expect(loc('C:\\12')).toBeUndefined()
    })

    it('matches the suffix on the percent-decoded path', () => {
      expect(loc('my%20file.ts:42')).toEqual({
        path: 'my file.ts',
        line: 42,
        via: 'suffix',
      })
      expect(loc('src/foo.ts%3A42')).toEqual({
        path: 'src/foo.ts',
        line: 42,
        via: 'suffix',
      })
      expect(loc('100%.ts:3')).toEqual({
        path: '100%.ts',
        line: 3,
        via: 'suffix',
      })
      expect(loc('a%23b.ts:42')).toEqual({
        path: 'a#b.ts',
        line: 42,
        via: 'suffix',
      })
    })

    it('gives no location for non-matching shapes', () => {
      for (const h of [
        'foo.ts',
        'foo.ts:',
        ':42',
        'src/:42',
        'foo.ts:abc',
        'foo.ts:42x',
        'foo.ts:1:2:3',
        'foo.ts:12345678901',
        'a.md#heading',
      ]) {
        expect(loc(h), h).toBeUndefined()
      }
    })

    it('keeps refusing real and scheme-like tokens without a dotted extension', () => {
      for (const h of [
        'Makefile:12',
        'README:3',
        'command:42',
        'file:42',
        'javascript:1',
        'vscode:1',
        'command:workbench.x',
        'ftp://x.ts:42',
      ]) {
        expect(classifyHref(h).kind, h).toBe('refused')
      }
    })

    it('keeps allowed schemes and external links', () => {
      expect(classifyHref('tel:5551234').kind).toBe('scheme')
      expect(classifyHref('mailto:a@b.c').kind).toBe('scheme')
      expect(classifyHref('https://h:8080/x.ts:42').kind).toBe('external')
    })

    it('keeps a bare #L42 as a same-document anchor', () => {
      expect(classifyHref('#L42')).toEqual({
        kind: 'same-doc-anchor',
        fragment: 'L42',
      })
    })
  })
})
