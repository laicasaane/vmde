#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  errorMessage,
  validateVsix,
} from './package-local-preview-core.mjs'

const USAGE =
  'Usage: validate-vsix.mjs <file> <version> <package-name> <publisher> <prerelease|production>'

export function parseVsixValidationArgs(args) {
  if (args.length !== 5) throw new Error(USAGE)
  const [file, version, packageName, publisher, mode] = args
  if (mode !== 'prerelease' && mode !== 'production') {
    throw new Error('VSIX validation mode must be prerelease or production')
  }
  return {
    file,
    expected: {
      version,
      packageName,
      publisher,
      prerelease: mode === 'prerelease',
    },
  }
}

async function run(args) {
  const { file, expected } = parseVsixValidationArgs(args)
  await validateVsix(file, expected)
  console.log(
    `Verified ${expected.publisher}.${expected.packageName} ${expected.version} (${expected.prerelease ? 'prerelease' : 'production'})`,
  )
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isDirectRun) {
  try {
    await run(process.argv.slice(2))
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
