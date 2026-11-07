import { describe, it, expect } from 'vitest'
import {
  FENCE,
  FENCE_ANY_INDENT,
  splitRowCells,
} from '../../src/shared/md-scan'

// 185/3e — the shared line-scanning primitives. Behaviour is exercised end-to-end by the
// consumers' suites (table-code-pipes, minimal-diff-writeback, outline-tree); this pins
// the two deliberate semantic differences so they can't silently converge.

describe('FENCE vs FENCE_ANY_INDENT', () => {
  it('FENCE is CommonMark-strict: 4+ spaces of indent is NOT a fence', () => {
    expect(FENCE.test('```js')).toBe(true)
    expect(FENCE.test('   ~~~')).toBe(true)
    expect(FENCE.test('    ```js')).toBe(false) // indented code block, not a fence
  })

  it('FENCE_ANY_INDENT accepts list-indented fences (outline heading scan)', () => {
    const m = FENCE_ANY_INDENT.exec('      ```python')
    expect(m).not.toBeNull()
    expect(m?.[2]).toBe('```') // group 2 = the marker (group 1 = the indent)
  })
})

describe('splitRowCells', () => {
  it('strips the optional leading/trailing pipe and splits on unescaped |', () => {
    expect(splitRowCells('| a | b |')).toEqual([' a ', ' b '])
    expect(splitRowCells('a|b')).toEqual(['a', 'b'])
  })

  it('an escaped \\| stays inside its cell', () => {
    expect(splitRowCells('| $\\|x\\|$ | b |')).toEqual([' $\\|x\\|$ ', ' b '])
  })
})
