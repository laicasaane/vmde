/**
 * Task 469 item 5d — module-structure check (circular imports + unresolvable imports).
 *
 * Rules are inlined (not `extends: 'dependency-cruiser/configs/recommended'`) because that
 * preset's subpath isn't exposed through the package's `exports` map in this version — Node
 * refuses the require. The two rules below are copied from that preset's `no-circular` /
 * `not-to-unresolvable` (see node_modules/dependency-cruiser/configs/rules/*.cjs).
 *
 * Deliberately narrower than the full "recommended" preset: `no-orphans` is left out because
 * knip (item 5b) already owns "is this file used" — running both would just double-report the
 * same finding two different ways. Circular imports and broken resolution are the signal this
 * tool adds that knip/Biome don't cover.
 *
 * Run separately per compilation unit (see package.json `depcruise:*` scripts) — src/ and
 * media-src/src/ have separate tsconfigs and module systems (CommonJS host vs ESM/browser
 * webview, see DEVELOPMENT.md "Layout").
 *
 * DIVISION OF LABOUR (task 460 addendum, cross-checked against task 469 item 5d). 469 §5d said
 * to extend `forbidden` here with task 460's layering rules "instead of writing a separate
 * hand-rolled test" — that didn't happen cleanly: `test/backend/module-boundaries.test.ts` got
 * written anyway, because it proves things this tool cannot (manifest totality/disjointness
 * against the checked-in `scripts/module-manifest.mjs`, and the full inter-module edge
 * allowlist — dependency-cruiser has no notion of "the 21 modules named in our manifest", only
 * of files and paths). So the guarantee is split along what each tool is actually good at:
 *   - HERE (a real TypeScript resolver — sees dynamic `import()`, `require()`, bare side-effect
 *     imports and re-exports for free, and can't drift the way hand-written regexes can): the
 *     two zero-exception invariants that are pure path shape and don't need module-name
 *     knowledge — cross-side webview→host reaches only `src/shared/`, and `src/shared/` itself
 *     depends on nothing outside `src/shared/`.
 *   - `module-boundaries.test.ts` (regex-based, manifest-driven): manifest totality/
 *     disjointness, the full inter-module edge allowlist, and the per-side cycle check —
 *     anything that needs "which of the 21 named modules is this file in", which this tool has
 *     no way to express.
 * Do not consolidate these into one tool without re-reading this note — the split is
 * deliberate, not an oversight. If the two nets ever disagree, that disagreement is itself
 * useful signal, not duplicated effort to prune.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'This dependency is part of a circular relationship. You might want to revise ' +
        'your solution (i.e. use dependency inversion, make sure the modules have a ' +
        'single responsibility).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "This module depends on a module that cannot be found ('resolved to disk'). " +
        "If it's an npm module: add it to your package.json. In all other cases you " +
        'likely already know what to do.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    // --- Task 460 layering rules (path-shape only — see the header comment for why the
    // manifest-driven allowlist stays in module-boundaries.test.ts instead of here). ---
    //
    // Path shapes differ by which `depcruise:*` script is running, because each cd's into a
    // different compilation unit before invoking the tool (see package.json): `depcruise:host`
    // runs from the repo root over `src` (host modules resolve as `src/...`, verified zero
    // dependency in that run ever resolves with a leading `../` — there is nothing for the host
    // tree to reach outside itself). `depcruise:webview` cd's into `media-src/` first, so
    // `media-src/src/...` resolves as `src/...` there too, and a cross-side reach into the host
    // tree resolves as `../src/...` (one level up out of `media-src/`, back into the repo-root
    // `src/`). Both rules below are written so they are structurally inert (never match
    // anything, not even vacuously-passing-with-data) in the run they don't apply to — verified
    // by running both `depcruise:host` and `depcruise:webview` after adding them.
    {
      name: 'webview-cross-side-shared-only',
      comment:
        'A webview module (media-src/src/) may only reach into the host tree at src/shared/ — ' +
        'the zero-exception cross-side contract from task 460 phase 4. Only fires in the ' +
        "webview run: the host run never produces a resolved path starting '../src/' (the host " +
        "tree has nothing outside itself to reach into), so `to.path` never matches there.",
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^\\.\\./src/', pathNot: '^\\.\\./src/shared/' },
    },
    {
      name: 'shared-kernel-purity',
      comment:
        'src/shared/ is the dependency-free kernel both host and webview sit on top of — it ' +
        'may depend on nothing outside src/shared/. Only meaningfully enforced in the host run: ' +
        "the webview run reaches src/shared/ files as external leaves (cross-side imports) and " +
        "does not expand THEIR dependencies, so this rule has no edges to check there — inert, " +
        'not a weaker check (the host run sees the real, fully-expanded graph).',
      severity: 'error',
      from: { path: '^(\\.\\./)?src/shared/' },
      to: {
        path: '^(\\.\\./)?src/',
        pathNot: '^(\\.\\./)?src/shared/',
      },
    },
  ],
  options: {
    // Task 576 item 9: dependency-cruiser 18.2.0's default TypeScript parsing goes through `tsc`,
    // which does not support the installed TypeScript 7.0.2 — that left both `depcruise:*` runs
    // cruising 0 modules (silently vacuous, not actually checking anything). Force the `swc`
    // parser (the `@swc/core` devDependency added alongside this config) instead of `tsc`, since
    // it parses TypeScript syntax independently of the installed `typescript` package version.
    parser: 'swc',
    doNotFollow: {
      // vendor/ is checked-in third-party bundles (ADR-0005) with their own internal require
      // graph that plain Node-style resolution can't always follow (e.g. a vendored .mjs chunk
      // requiring a bare 'elkjs/...' specifier that only resolves inside esbuild's bundler) —
      // stop at the boundary instead of reporting their internals as broken.
      path: 'node_modules|(^|/)vendor/',
      dependencyTypes: [
        'npm',
        'npm-dev',
        'npm-optional',
        'npm-peer',
        'npm-bundled',
        'npm-no-pkg',
      ],
    },
    exclude: {
      path: [
        'node_modules',
        'media-src/node_modules',
        '(^|/)media/',
        '(^|/)out/',
        '(^|/)tmp/',
        '(^|/)\\.worktrees/',
        '\\.test\\.ts$',
      ],
    },
  },
}
