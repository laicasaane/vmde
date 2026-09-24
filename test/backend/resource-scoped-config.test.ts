import { beforeEach, describe, expect, it } from 'vitest'
import {
  collectConfigOptions,
  currentThemeKind,
  effectiveThemeKind,
} from '../../src/platform/editor-config'
import { ColorThemeKind, mock, Uri } from './vscode-mock'

// Task 295 — VS Code only honours a folder-level `.vscode/settings.json` override when the setting
// declares `"scope": "resource"` AND the read passes the document's URI. Before this, only 7
// properties (css.*/image.*) did both; everything else was read through a non-scoped
// getConfiguration('vmde'), so a user could write a perfectly valid folder override and have it
// silently ignored — no error, nothing happens. These tests pin the two halves that make it work:
// the read takes a URI, and the override applies to THAT document only.
describe('resource-scoped config reads (task 295)', () => {
  const docs = Uri.file('/ws/docs/guide.md')
  const notes = Uri.file('/ws/notes/scratch.md')

  beforeEach(() => mock.reset())

  it('a folder override wins over the user setting for a document in that folder', () => {
    mock.setConfig({
      'theme.content': 'auto',
      'editor.fullWidth': true,
      'preview.reflowLineBreaks': false,
      'editor.wrapColumn': 80,
      'editor.autoWrap': false,
      'editor.autoWrapDelay': 500,
    })
    mock.setResourceConfig(docs, {
      'theme.content': 'github-light',
      'editor.fullWidth': false,
      'preview.reflowLineBreaks': true,
      'editor.wrapColumn': 100,
      'editor.autoWrap': true,
      'editor.autoWrapDelay': 750,
    })

    const scoped = collectConfigOptions(docs)
    expect(scoped.contentTheme).toBe('github-light')
    expect(scoped.enableFullWidth).toBe(false)
    expect(scoped.reflowLineBreaks).toBe(true)
    expect(scoped.wrapColumn).toBe(100)
    expect(scoped.autoWrap).toBe(true)
    expect(scoped.autoWrapDelay).toBe(750)
  })

  it('keeps GitHub color swatches resource-scoped per document', () => {
    mock.setConfig({ 'github.colorLiterals': true })
    mock.setResourceConfig(docs, { 'github.colorLiterals': false })

    expect(collectConfigOptions(docs).githubColorLiterals).toBe(false)
    expect(collectConfigOptions(notes).githubColorLiterals).toBe(true)
  })

  it('does NOT leak that override to a document outside the folder', () => {
    mock.setConfig({ 'theme.content': 'auto', 'editor.fullWidth': true })
    mock.setResourceConfig(docs, {
      'theme.content': 'github-light',
      'editor.fullWidth': false,
    })

    const other = collectConfigOptions(notes)
    expect(other.contentTheme).toBe('auto')
    expect(other.enableFullWidth).toBe(true)
  })

  it('two documents in different roots resolve different values from ONE call each', () => {
    // The multi-root case the task is actually about: two editors open at once, each rendering
    // with its own folder's theme. Same global config, two URIs, two answers.
    mock.setConfig({ 'theme.content': 'auto' })
    mock.setResourceConfig(docs, { 'theme.content': 'github-light' })
    mock.setResourceConfig(notes, { 'theme.content': 'material-dark' })

    expect(collectConfigOptions(docs).contentTheme).toBe('github-light')
    expect(collectConfigOptions(notes).contentTheme).toBe('material-dark')
  })

  it('falls back to the user setting when the folder overrides something else', () => {
    mock.setConfig({ 'theme.content': 'auto', 'theme.code': 'github' })
    mock.setResourceConfig(docs, { 'editor.toolbar': false })

    const scoped = collectConfigOptions(docs)
    expect(scoped.contentTheme).toBe('auto')
    expect(scoped.codeTheme).toBe('github')
    expect(scoped.showToolbar).toBe(false)
  })

  it('reads the global config when no uri is passed at all — the pre-295 behaviour still works', () => {
    mock.setConfig({ 'theme.content': 'github-dark' })
    mock.setResourceConfig(docs, { 'theme.content': 'github-light' })

    expect(collectConfigOptions().contentTheme).toBe('github-dark')
  })

  it('effectiveThemeKind follows the DOCUMENT folder, not just the workbench theme', () => {
    // A named content theme pins its own light/dark mode (task 82). With the workbench dark and a
    // folder pinning github-light, that folder's documents must resolve LIGHT — this is the read
    // that decides code-block colouring, so getting it globally-scoped mis-themes one of the two.
    mock.setThemeKind(ColorThemeKind.Dark)
    mock.setConfig({ 'theme.content': 'auto' })
    mock.setResourceConfig(docs, { 'theme.content': 'github-light' })

    expect(effectiveThemeKind(docs)).toBe('light')
    expect(effectiveThemeKind(notes)).toBe('dark')
  })

  it.each([
    [ColorThemeKind.Light, 'light'],
    [ColorThemeKind.Dark, 'dark'],
    [ColorThemeKind.HighContrast, 'high-contrast'],
    [ColorThemeKind.HighContrastLight, 'high-contrast-light'],
  ])('preserves all four VS Code theme kinds (%s)', (kind, expected) => {
    mock.setThemeKind(kind)
    expect(currentThemeKind()).toBe(expected)
  })
})
