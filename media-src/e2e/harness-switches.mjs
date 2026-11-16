// Task 733 / 024 (plan D-14 section 4.1): the smoke stage bundles the Chromium harness with chosen
// unit switches turned on. The rewrite runs in the harness build only (`serve.mjs`, `/smoke/<set>`);
// the product build (`build.mjs`, `esbuild-shared.mjs`) never imports this module, and
// `test/backend/harness-switches.test.ts` asserts that. `util/unit-changes.ts` itself is never edited.
import { readFile } from 'node:fs/promises'

/** The switchable constants of `util/unit-changes.ts`, by their set name, in set order. */
export const HARNESS_SWITCHES = {
  wysiwyg: 'WYSIWYG_UNITS',
  source: 'SOURCE_UNITS',
  definition: 'DEFINITION_UNITS',
}

const SET_ORDER = Object.keys(HARNESS_SWITCHES)

/**
 * Turns each named constant on: `export const <NAME>: boolean = false|true` becomes `= true`.
 * Throws unless each declaration matches exactly once, so a renamed or duplicated constant fails
 * the harness build instead of silently shipping the default.
 */
export function switchSource(code, constants) {
  let out = code
  for (const name of constants) {
    const pattern = new RegExp(
      `export const ${name}: boolean = (?:false|true)\\b`,
      'g',
    )
    const count = out.match(pattern)?.length ?? 0
    if (count !== 1)
      throw new Error(
        `harness switch ${name}: expected 1 declaration, found ${count}`,
      )
    out = out.replace(pattern, `export const ${name}: boolean = true`)
  }
  return out
}

/**
 * The constant names of a set: 'none' (no constant), or a '+'-joined subset of wysiwyg, source and
 * definition in that order. Any other text gives undefined.
 */
export function parseSwitchSet(text) {
  if (text === 'none') return []
  const parts = text.split('+')
  let last = -1
  for (const part of parts) {
    const index = SET_ORDER.indexOf(part)
    if (index <= last) return undefined
    last = index
  }
  return parts.map((part) => HARNESS_SWITCHES[part])
}

/** esbuild plugin of the harness build: loads `util/unit-changes.ts` with `constants` turned on. */
export function harnessSwitchPlugin(constants) {
  return {
    name: 'vmde-harness-switches',
    setup(build) {
      build.onLoad(
        { filter: /src[\\/]util[\\/]unit-changes\.ts$/ },
        async (args) => ({
          contents: switchSource(await readFile(args.path, 'utf8'), constants),
          loader: 'ts',
        }),
      )
    },
  }
}
