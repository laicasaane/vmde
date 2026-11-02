import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
// @ts-expect-error — plain .mjs build config without type declarations
import {
  vditorSourceConfig,
  findInputsOutsideRepo,
} from '../../media-src/esbuild-shared.mjs'

// Task 694: a git worktree links media-src/node_modules to the main checkout's. The Vditor shims that
// build.mjs generates import "../../../../../src/…" relative to node_modules/vditor/src/…; esbuild
// resolves symbolic links by default, so those imports landed in the MAIN checkout's media-src/src and
// the bundle held two copies of every shim-imported module (two PlantUML engine registries and queues).

interface Meta {
  inputs: Record<string, unknown>
}

/** Mirrors the worktree layout: tree/ links its node_modules to main/node_modules, whose package
 *  imports the repository's shared module through a relative path (the shim pattern). */
async function bundleLinkedTree(preserveSymlinks: boolean): Promise<Meta> {
  const root = mkdtempSync(path.join(tmpdir(), 'vmde-bundle-layout-'))
  try {
    const main = path.join(root, 'main')
    const tree = path.join(root, 'tree')
    for (const repo of [main, tree]) {
      mkdirSync(path.join(repo, 'media-src', 'src'), { recursive: true })
      writeFileSync(
        path.join(repo, 'media-src', 'src', 'shared.ts'),
        'export const shared = {}\n',
      )
    }
    const pkg = path.join(main, 'media-src', 'node_modules', 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      path.join(pkg, 'index.ts'),
      'export { shared as viaShim } from "../../src/shared"\n',
    )
    symlinkSync(
      path.join(main, 'media-src', 'node_modules'),
      path.join(tree, 'media-src', 'node_modules'),
    )
    writeFileSync(
      path.join(tree, 'media-src', 'src', 'entry.ts'),
      'import { shared } from "./shared"\nimport { viaShim } from "pkg"\nconsole.log(shared, viaShim)\n',
    )
    const result = await build({
      entryPoints: [path.join(tree, 'media-src', 'src', 'entry.ts')],
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      absWorkingDir: path.join(tree, 'media-src'),
      preserveSymlinks,
    })
    return result.metafile as Meta
  } finally {
    // Metafile is plain data; the tree is no longer needed once bundled.
    rmSync(root, { recursive: true, force: true })
  }
}

const sharedInputs = (meta: Meta): string[] =>
  Object.keys(meta.inputs).filter((k) => k.endsWith('src/shared.ts'))

describe('bundle layout with a linked media-src/node_modules (Task 694)', () => {
  it('shares preserveSymlinks through the common build config', () => {
    expect(vditorSourceConfig.preserveSymlinks).toBe(true)
  })

  it('reproduces the duplicate without the option and bundles one copy with it', async () => {
    expect(sharedInputs(await bundleLinkedTree(false))).toHaveLength(2)
    expect(
      sharedInputs(
        await bundleLinkedTree(vditorSourceConfig.preserveSymlinks === true),
      ),
    ).toHaveLength(1)
  })

  it('reports inputs that resolve outside the repository and accepts in-repo ones', () => {
    const repo = path.resolve('/work/repo')
    const cwd = path.join(repo, 'media-src')
    const meta = {
      inputs: {
        'src/boot/main.ts': {},
        'node_modules/vditor/src/index.ts': {},
        '../src/shared/types.ts': {},
        '../../other/media-src/src/util/load-script.ts': {},
      },
    }
    expect(findInputsOutsideRepo(meta, repo, cwd)).toEqual([
      '../../other/media-src/src/util/load-script.ts',
    ])
    expect(
      findInputsOutsideRepo({ inputs: { 'src/a.ts': {} } }, repo, cwd),
    ).toEqual([])
  })
})
