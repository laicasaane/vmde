import { describe, expect, it } from 'vitest'
import { parseVsixValidationArgs } from '../../scripts/validate-vsix.mjs'

describe('VSIX validator CLI contract', () => {
  it.each([
    ['prerelease', true],
    ['production', false],
  ] as const)(
    'maps %s mode to an exact archive identity',
    (mode, prerelease) => {
      expect(
        parseVsixValidationArgs([
          'artifact.vsix',
          '1.5.12',
          'vmde',
          'Laicasaane',
          mode,
        ]),
      ).toEqual({
        file: 'artifact.vsix',
        expected: {
          version: '1.5.12',
          packageName: 'vmde',
          publisher: 'Laicasaane',
          prerelease,
        },
      })
    },
  )

  it('rejects incomplete and unknown validation modes', () => {
    expect(() => parseVsixValidationArgs([])).toThrow('Usage:')
    expect(() =>
      parseVsixValidationArgs([
        'artifact.vsix',
        '1.5.12',
        'vmde',
        'Laicasaane',
        'unknown',
      ]),
    ).toThrow('prerelease or production')
  })
})
