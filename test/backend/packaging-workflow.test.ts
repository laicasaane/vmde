import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('local VSIX packaging contract', () => {
  it('pins every install-script decision in the packaging toolchain', () => {
    expect(pkg.allowScripts).toEqual({
      // These two scripts select and verify the platform binaries used by packaging and builds.
      '@vscode/vsce-sign@2.1.0': true,
      'esbuild@0.28.2': true,
      // Azure uses Entra workload identity, so local credential storage is neither needed nor executed.
      keytar: false,
    })
  })

  it('builds one production host bundle for a manual-only package command', () => {
    expect(pkg.main).toBe('dist/extension.js')
    expect(pkg.scripts['vscode:prepublish']).toBe('node build.mjs --production')
    expect(pkg.scripts['package:vsix']).toBe('node scripts/package-vsix.mjs')
    expect(pkg.scripts.pub).toBe('npm run package:vsix')
    expect(pkg.scripts['release:marketplace']).toBeUndefined()
  })

  it('excludes intermediate host modules and development-only files', () => {
    const ignored = new Set(
      read('.vscodeignore')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    )

    for (const path of [
      'out',
      'src',
      'biome.jsonc',
      'knip.jsonc',
      '.jscpd.json',
      '.dependency-cruiser.cjs',
      '.git-blame-ignore-revs',
      'LOCAL_AGENT_TASK.md',
      '.azure',
      '.superpowers',
      'media/dist/main.meta.json',
      'media/vditor/dist/js/highlight.js/styles/base16',
    ]) {
      expect(ignored, `${path} must not ship`).toContain(path)
    }
  })

  it('keeps registry upload out of the repository workflow', () => {
    const workflow = read('.github/workflows/publish.yml')
    expect(workflow).not.toContain('vsce publish')
    expect(workflow).not.toContain('ovsx publish')
    expect(workflow).not.toContain('VSCE_PAT')
    expect(workflow).not.toContain('OPEN_VSX_TOKEN')
  })

  it('skips VSCE dependency discovery because the bundle has no runtime dependencies', () => {
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(read('scripts/vsix-package-args.mjs')).toContain(
      "'--no-dependencies'",
    )
  })
})
