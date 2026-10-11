#!/usr/bin/env node
/*
 * fetch-katex — pin the exact browser runtime tree from an npm KaTeX release.
 *
 * Usage:
 *   node media-src/scripts/fetch-katex.mjs 0.18.11
 *
 * The package is downloaded and unpacked only under the OS temporary directory. This script copies
 * the minified JS/CSS entrypoints, mhchem extension, fonts, and MIT license into vendor/katex, then
 * records one SHA-256 per shipped runtime file. build.mjs verifies those hashes before copying the
 * tree over Vditor's bundled KaTeX assets.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const APPROVED_VERSION = '0.18.11'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = path.resolve(SCRIPT_DIR, '../vendor/katex')

const sha256 = (buffer) =>
  createHash('sha256').update(buffer).digest('hex')

async function main() {
  const version = process.argv[2]
  if (version !== APPROVED_VERSION) {
    throw new Error(
      `Usage: node media-src/scripts/fetch-katex.mjs ${APPROVED_VERSION}`,
    )
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vmde-katex-'))
  try {
    const { stdout } = await execFile(
      'npm',
      ['pack', `katex@${version}`, '--json'],
      { cwd: tempDir, maxBuffer: 10 * 1024 * 1024 },
    )
    const packed = JSON.parse(stdout)
    const filename = packed[0]?.filename
    if (!filename || path.basename(filename) !== filename) {
      throw new Error('npm pack did not return one safe KaTeX archive filename')
    }

    const extractDir = path.join(tempDir, 'extract')
    await fs.mkdir(extractDir)
    await execFile('tar', [
      '-xzf',
      path.join(tempDir, filename),
      '-C',
      extractDir,
    ])
    const packageDir = path.join(extractDir, 'package')
    const pkg = JSON.parse(
      await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'),
    )
    if (pkg.name !== 'katex' || pkg.version !== APPROVED_VERSION) {
      throw new Error(
        `packed archive is ${pkg.name}@${pkg.version}, expected katex@${APPROVED_VERSION}`,
      )
    }

    const fontDir = path.join(packageDir, 'dist/fonts')
    const fontEntries = await fs.readdir(fontDir, { withFileTypes: true })
    const fontFiles = fontEntries
      .map((entry) => {
        if (entry.isSymbolicLink()) {
          throw new Error(`refusing KaTeX font symlink: ${entry.name}`)
        }
        if (!entry.isFile()) {
          throw new Error(`unexpected non-file in KaTeX fonts: ${entry.name}`)
        }
        return `dist/fonts/${entry.name}`
      })
      .sort()
    const runtimeFiles = [
      'dist/katex.min.js',
      'dist/katex.min.css',
      'dist/contrib/mhchem.min.js',
      ...fontFiles,
    ]

    await fs.rm(path.join(VENDOR_DIR, 'dist'), {
      recursive: true,
      force: true,
    })
    const files = {}
    for (const relative of runtimeFiles) {
      const sourcePath = path.join(packageDir, ...relative.split('/'))
      const stat = await fs.lstat(sourcePath)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`refusing non-regular KaTeX runtime file: ${relative}`)
      }
      const buffer = await fs.readFile(sourcePath)
      const destination = path.join(VENDOR_DIR, ...relative.split('/'))
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, buffer)
      files[relative] = { sha256: sha256(buffer) }
    }

    await fs.copyFile(
      path.join(packageDir, 'LICENSE'),
      path.join(VENDOR_DIR, 'LICENSE'),
    )
    await fs.writeFile(
      path.join(VENDOR_DIR, 'NOTICE'),
      `KaTeX — fast math typesetting for the web\n` +
        `Vendored from npm package katex@${version}.\n` +
        `Licensed under the MIT License (see LICENSE).\n` +
        `Upstream: https://github.com/KaTeX/KaTeX\n`,
    )
    const source = {
      package: 'katex',
      version,
      license: 'MIT',
      fetchedFrom: `npm pack katex@${version}`,
      components: [
        { ecosystem: 'npm', name: 'katex', version: APPROVED_VERSION },
      ],
      files,
    }
    await fs.writeFile(
      path.join(VENDOR_DIR, 'source.json'),
      `${JSON.stringify(source, null, 2)}\n`,
    )
    console.log(
      `[fetch-katex] pinned v${version} (${runtimeFiles.length} runtime files)`,
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
