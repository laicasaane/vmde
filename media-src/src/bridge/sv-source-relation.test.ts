import { describe, expect, it } from 'vitest'
import { svSourceDerivesFrom } from './sv-source-relation'

// Task 675: the Source-mode relation accepts only the differences Lute and Vditor make (table
// padding and delimiter dashes, sequential ordered-list numbers, one more trailing line break) and
// refuses everything else.
const RAW_TABLE = '|a| longer |\n|:-|---:|\n|x\\|y|全角|'
const PADDED_TABLE = '| a    | longer |\n| :--- | -----: |\n| x\\|y |   全角 |'
const doc = (table: string, list = '3. alpha\n5. beta', tail = 'Tail.\n') =>
  `# Title\n\nParagraph here.\n\n${table}\n\n${list}\n\n${tail}`

describe('svSourceDerivesFrom (Task 675)', () => {
  describe('accepts', () => {
    it('identical texts and a host text with CRLF line endings', () => {
      expect(svSourceDerivesFrom(doc(RAW_TABLE), doc(RAW_TABLE))).toBe(true)
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE).replace(/\n/g, '\r\n'),
          doc(RAW_TABLE),
        ),
      ).toBe(true)
    })

    it('one more trailing line break', () => {
      expect(svSourceDerivesFrom(doc(RAW_TABLE), `${doc(RAW_TABLE)}\n`)).toBe(
        true,
      )
    })

    it('a table Lute padded', () => {
      expect(svSourceDerivesFrom(doc(RAW_TABLE), doc(PADDED_TABLE))).toBe(true)
    })

    it('an ordered list Vditor renumbered', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(RAW_TABLE, '3. alpha\n4. beta'),
        ),
      ).toBe(true)
    })

    it('a nested list numbered on its own indent', () => {
      const host = '1. one\n   7. inner a\n   9. inner b\n3. two\n'
      const shown = '1. one\n   7. inner a\n   8. inner b\n2. two\n'
      expect(svSourceDerivesFrom(host, shown)).toBe(true)
    })

    it('a padded table, a renumbered list and a trailing line break together', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          `${doc(PADDED_TABLE, '3. alpha\n4. beta')}\n`,
        ),
      ).toBe(true)
    })

    it('whitespace beside a table pipe (not meaningful in a table)', () => {
      expect(
        svSourceDerivesFrom(
          '|a|b|\n|-|-|\n|1|2|\n',
          '| a | b |\n|-|-|\n|1|2|\n',
        ),
      ).toBe(true)
    })
  })

  describe('refuses', () => {
    it('two more trailing line breaks, or one when the host has no final line break', () => {
      expect(svSourceDerivesFrom(doc(RAW_TABLE), `${doc(RAW_TABLE)}\n\n`)).toBe(
        false,
      )
      expect(svSourceDerivesFrom('alpha', 'alpha\n')).toBe(false)
    })

    it('a character missing from a paragraph', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(RAW_TABLE).replace('Paragraph', 'Paragrxaph'),
        ),
      ).toBe(false)
    })

    it('a character typed into a table cell', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(PADDED_TABLE).replace('longer', 'longxer'),
        ),
      ).toBe(false)
    })

    it('a changed delimiter alignment', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(PADDED_TABLE).replace(':---', '----'),
        ),
      ).toBe(false)
    })

    it('a different number of table cells', () => {
      expect(
        svSourceDerivesFrom(
          '|a|b|\n|-|-|\n|1|2|\n',
          '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n',
        ),
      ).toBe(false)
    })

    it('a line with a pipe outside a table block', () => {
      expect(svSourceDerivesFrom('a|b\n', 'a | b\n')).toBe(false)
    })

    it('a first list item whose number changed', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(RAW_TABLE, '2. alpha\n3. beta'),
        ),
      ).toBe(false)
    })

    it('a list number that does not follow the previous one', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(RAW_TABLE, '3. alpha\n9. beta'),
        ),
      ).toBe(false)
    })

    it('a changed delimiter or item text', () => {
      expect(
        svSourceDerivesFrom('3. alpha\n5. beta\n', '3. alpha\n4) beta\n'),
      ).toBe(false)
      expect(
        svSourceDerivesFrom('3. alpha\n5. beta\n', '3. alpha\n4. betax\n'),
      ).toBe(false)
    })

    it('a list that a paragraph interrupted', () => {
      expect(
        svSourceDerivesFrom(
          '3. alpha\n\ntext\n\n5. beta\n',
          '3. alpha\n\ntext\n\n4. beta\n',
        ),
      ).toBe(false)
    })

    it('a different number of lines', () => {
      expect(svSourceDerivesFrom('a\n\n\nb\n', 'a\n\nb\n')).toBe(false)
    })

    it('a difference inside a fenced code block', () => {
      expect(
        svSourceDerivesFrom(
          '```\n3. alpha\n5. beta\n```\n',
          '```\n3. alpha\n4. beta\n```\n',
        ),
      ).toBe(false)
      expect(
        svSourceDerivesFrom(
          '```\n|a|b|\n|-|-|\n```\n',
          '```\n| a | b |\n|-|-|\n```\n',
        ),
      ).toBe(false)
    })

    it('a list item numbered across a fenced code block that ended the list', () => {
      expect(
        svSourceDerivesFrom(
          '1. a\n```\nx\n```\n1. b\n',
          '1. a\n```\nx\n```\n2. b\n',
        ),
      ).toBe(false)
    })

    it('a list number inside an indented code block', () => {
      expect(
        svSourceDerivesFrom(
          'para\n\n    1. a\n    1. b\n',
          'para\n\n    1. a\n    2. b\n',
        ),
      ).toBe(false)
    })

    it('table padding inside an indented code block', () => {
      expect(
        svSourceDerivesFrom(
          'para\n\n    |a|b|\n    |-|-|\n    |1|2|\n',
          'para\n\n    | a | b |\n    | - | - |\n    | 1 | 2 |\n',
        ),
      ).toBe(false)
    })

    it('a difference inside a math block', () => {
      expect(
        svSourceDerivesFrom('$$\n1. a\n3. b\n$$\n', '$$\n1. a\n2. b\n$$\n'),
      ).toBe(false)
    })

    it('a table whose lines are indented by a tab', () => {
      expect(
        svSourceDerivesFrom(
          '\t| a | b |\n\t|-|-|\n',
          '\t| a | b |\n\t|---|---|\n',
        ),
      ).toBe(false)
    })

    it('numbers inside indented code in a list item', () => {
      expect(
        svSourceDerivesFrom(
          '1. a\n\n        5. x\n        7. y\n',
          '1. a\n\n        5. x\n        6. y\n',
        ),
      ).toBe(false)
      expect(
        svSourceDerivesFrom(
          '1. a\n    ```\n    5. x\n    7. y\n    ```\n',
          '1. a\n    ```\n    5. x\n    6. y\n    ```\n',
        ),
      ).toBe(false)
    })

    it('a number other than 1 that interrupts a paragraph', () => {
      expect(svSourceDerivesFrom('a\n5. x\n7. y\n', 'a\n5. x\n6. y\n')).toBe(
        false,
      )
    })

    it('differences inside an HTML block', () => {
      expect(
        svSourceDerivesFrom(
          '<pre>\n5. x\n7. y\n</pre>\n',
          '<pre>\n5. x\n6. y\n</pre>\n',
        ),
      ).toBe(false)
      expect(
        svSourceDerivesFrom(
          '<div>\n| a | b |\n|---|---|\n</div>\n',
          '<div>\n| a  | b |\n|---|---|\n</div>\n',
        ),
      ).toBe(false)
    })

    it('a header and delimiter row with different cell counts', () => {
      expect(
        svSourceDerivesFrom('a | b | c\n--|--\n', 'a  |  b | c\n--|--\n'),
      ).toBe(false)
    })

    it('a body row that starts another block after a table', () => {
      expect(
        svSourceDerivesFrom(
          '|a|b|\n|-|-|\n> | a |\n',
          '| a | b |\n| - | - |\n> | a  |\n',
        ),
      ).toBe(false)
      expect(
        svSourceDerivesFrom(
          '|a|b|\n|-|-|\n- a | b\n',
          '| a | b |\n| - | - |\n- a  | b\n',
        ),
      ).toBe(false)
    })

    it('a stale host text and an unrelated difference', () => {
      expect(
        svSourceDerivesFrom(
          doc(RAW_TABLE),
          doc(PADDED_TABLE, '3. alpha\n4. beta', 'Other.\n'),
        ),
      ).toBe(false)
      expect(svSourceDerivesFrom('unrelated\n', doc(RAW_TABLE))).toBe(false)
    })
  })
})
