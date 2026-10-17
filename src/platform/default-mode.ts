// Task 282 — which editor mode a document OPENS in. Until now this was hardcoded `ir`
// (vditor-init.ts) with only the session-persisted saved-options override on top, so a user who
// reads far more than they write had no way to say "open in Preview" other than clicking every
// time. Resolution happens HOST-side, in one place, and ships a single already-resolved value to
// the webview: the glob match needs the document's workspace-relative path, which the webview does
// not have, and keeping the precedence here makes it unit-testable against the config mock.

import type { OpenMode } from '../shared/protocol'

export type { OpenMode }

// Runtime mirror of `OpenMode` — a type alone can't validate an untyped setting/glob-map value
// read from `WorkspaceConfiguration.get<string>()`.
const MODES: readonly string[] = ['ir', 'wysiwyg', 'sv', 'preview']

// Minimal glob → RegExp for the `defaultModeByGlob` map. Deliberately not a full glob
// implementation: VS Code does not export its bundled minimatch, and the patterns this setting is
// for are the `docs/**` / `**/*.spec.md` shape. Supported: `**` (any depth, crosses `/`), `*` (any
// run within ONE path segment), `?` (one non-separator char). Everything else is literal.
export function matchGlob(relPath: string, pattern: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` must also match ZERO directories, so `docs/**/x.md` matches `docs/x.md` — the
        // alternative (a bare `.*/`) silently fails on the top level, which is where most files are.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${re}$`).test(normalized)
  } catch {
    // A pattern that somehow still produces an invalid RegExp must not take the open path down —
    // an unmatched glob just means "no override", which is the safe answer.
    return false
  }
}

interface DefaultModeInput {
  setting: string | undefined
  byGlob: Record<string, string> | undefined
  // Workspace-relative POSIX-ish path of the document; undefined outside any workspace folder.
  relPath: string | undefined
}

// Returns the mode to open in, or `undefined` for "no explicit choice — keep session stickiness".
// `undefined` rather than a `'remember'` sentinel because the only consumer (buildVditorOptions,
// media-src/src/vditor-options.ts) treats "leave the saved mode alone" as "do nothing" — a
// falsy-checkable `undefined` fits that directly, where a sentinel would force it to branch on a
// value that means "no-op" anyway. The `'remember'` setting VALUE (package.json enum) still exists
// as the explicit, discoverable way for a user to opt into that pre-282 behaviour.
// The >700KB streaming force-ir override is NOT applied here: it lives in the webview
// (vditor-init.ts), which is the only place that knows the actual content length, and it must win
// over this. Deciding it here would need the document size at config-collection time and would
// duplicate a gate that already exists.
export function resolveDefaultMode(
  input: DefaultModeInput,
): OpenMode | undefined {
  // A glob is MORE specific than the flat setting, so it wins — that is the whole point of having
  // both ("my notes vault opens in wysiwyg, but docs/** opens in preview").
  if (input.relPath && input.byGlob) {
    for (const [pattern, mode] of Object.entries(input.byGlob)) {
      if (MODES.includes(mode) && matchGlob(input.relPath, pattern))
        return mode as OpenMode
    }
  }
  if (input.setting && MODES.includes(input.setting))
    return input.setting as OpenMode
  return undefined
}

// Task 651 — the remembered Preview toggle applies only when no explicit mode won: `resolved` is
// `undefined` exactly for the `remember` setting (or an absent/invalid one) with no matching path
// rule. A `preview` rule or setting keeps its Task 282 behaviour (it resolves to a mode, not
// `undefined`), so it never reaches this flag.
export function opensInRememberedPreview(
  resolved: OpenMode | undefined,
  previewOn: boolean,
): boolean {
  return resolved === undefined && previewOn
}
