import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { NAMED_THEME_VALUES } from '../../src/shared/theme-registry'
import {
  ExtensionId,
  MarkdownEditorViewType,
  Publisher,
  ProductDisplayName,
} from '../../src/shared/product-identity'

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
)
const lock = JSON.parse(
  readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
)

const VIEW_TYPE = MarkdownEditorViewType
const FORMER_NAMESPACE = ['v', 'markd'].join('')
const FORMER_EXTENSION_NAME = ['visual', 'markdown', 'editor'].join('')

describe('package.json manifest', () => {
  it('publishes under the VMDE identity', () => {
    expect({
      name: pkg.name,
      displayName: pkg.displayName,
      description: pkg.description,
      publisher: pkg.publisher,
      author: pkg.author,
    }).toEqual({
      name: 'vmde',
      displayName: ProductDisplayName,
      description: 'A fully-fledged visual markdown editor',
      publisher: Publisher,
      author: 'Laicasaane',
    })
    expect(`${pkg.publisher}.${pkg.name}`).toBe(ExtensionId)
  })

  it('publishes release 1.4.0 consistently across package metadata', () => {
    expect(pkg.version).toBe('1.4.0')
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages[''].version).toBe(pkg.version)
  })

  it('contains no deprecated identity contribution or package contract', () => {
    const activeContract = JSON.stringify({
      name: pkg.name,
      activationEvents: pkg.activationEvents,
      contributes: pkg.contributes,
    }).toLowerCase()
    expect(activeContract).not.toContain(FORMER_NAMESPACE)
    expect(activeContract).not.toContain(FORMER_EXTENSION_NAME)
  })

  // task 84: the manifest enum must stay in sync with the single-source theme
  // registry — `auto` plus exactly the registry's named themes, in order. Guards
  // against adding a theme to the registry but forgetting the manifest (or vice versa).
  it('theme.content enum == auto + the registry themes (registry is the source)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.theme.content'].enum).toEqual([
      'auto',
      ...NAMED_THEME_VALUES,
    ])
  })

  // Task 522: the manifest must load the one bundled host entry. Keeping this assertion beside the
  // source-entry existence check preserves task 460's stale-path regression net without packaging
  // every intermediate tsc module.
  it('points main at the bundled extension host entry', () => {
    expect(
      existsSync(new URL('../../src/app/extension.ts', import.meta.url)),
    ).toBe(true)
    expect(pkg.main).toBe('dist/extension.js')
  })

  it('declares a ^1.110 engines floor (ThemeIcon tab icon / l10n / telemetry)', () => {
    expect(pkg.engines.vscode).toBe('^1.110.0')
  })

  it('pins extensionKind to workspace — it reads the local FS (task 51)', () => {
    expect(pkg.extensionKind).toEqual(['workspace'])
  })

  it('declares untrusted + virtual workspace capabilities as limited', () => {
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe('limited')
    expect(pkg.capabilities.virtualWorkspaces.supported).toBe('limited')
  })

  it('registers exactly one custom editor with the expected view type', () => {
    expect(pkg.contributes.customEditors).toHaveLength(1)
    const editor = pkg.contributes.customEditors[0]
    expect(editor.viewType).toBe(VIEW_TYPE)
    expect(editor.priority).toBe('option')
  })

  it('selects both markdown extensions on file and untitled schemes', () => {
    const selectors = pkg.contributes.customEditors[0].selector
    const pairs = selectors.map((s: any) => `${s.filenamePattern}@${s.scheme}`)
    expect(pairs).toEqual(
      expect.arrayContaining([
        '*.md@file',
        '*.md@untitled',
        '*.markdown@file',
        '*.markdown@untitled',
      ]),
    )
  })

  it('contributes the open/edit commands', () => {
    const ids = pkg.contributes.commands.map((c: any) => c.command)
    expect(ids).toEqual(
      expect.arrayContaining(['vmde.openEditor', 'vmde.openTextEditor']),
    )
  })

  it('contributes an Open-in-Split command shown in the editor title (task 10)', () => {
    const cmd = pkg.contributes.commands.find(
      (c: any) => c.command === 'vmde.openInSplit',
    )
    expect(cmd).toBeDefined()
    expect(cmd.icon).toBe('$(split-horizontal)')
    const inTitle = pkg.contributes.menus['editor/title'].some(
      (m: any) =>
        m.command === 'vmde.openInSplit' &&
        m.when.includes(`activeCustomEditorId != ${VIEW_TYPE}`),
    )
    expect(inTitle).toBe(true)
  })

  it('contributes an Open-source-to-the-side command in the custom-editor title (task 36)', () => {
    const cmd = pkg.contributes.commands.find(
      (c: any) => c.command === 'vmde.openSourceToSide',
    )
    expect(cmd).toBeDefined()
    const inTitle = pkg.contributes.menus['editor/title'].some(
      (m: any) =>
        m.command === 'vmde.openSourceToSide' &&
        m.when === `activeCustomEditorId == ${VIEW_TYPE}`,
    )
    expect(inTitle).toBe(true)
  })

  it('contributes an Open-Settings command but NOT in the editor title bar', () => {
    const cmd = pkg.contributes.commands.find(
      (c: any) => c.command === 'vmde.openSettings',
    )
    expect(cmd).toBeDefined() // available via the command palette
    // intentionally absent from the editor title bar to keep it uncluttered
    const inTitle = pkg.contributes.menus['editor/title'].some(
      (m: any) => m.command === 'vmde.openSettings',
    )
    expect(inTitle).toBe(false)
  })

  it('binds the "edit in text editor" keybinding scoped to the custom editor', () => {
    const binding = pkg.contributes.keybindings.find(
      (k: any) => k.command === 'vmde.openTextEditor',
    )
    expect(binding).toBeDefined()
    expect(binding.key).toBe('ctrl+alt+e')
    expect(binding.mac).toBe('cmd+ctrl+e')
    expect(binding.when).toBe(`activeCustomEditorId == ${VIEW_TYPE}`)
  })

  it('binds Ctrl/Cmd+F to VMDE source-accurate find/replace inside the custom editor', () => {
    const binding = pkg.contributes.keybindings.find(
      (k: any) => k.command === 'vmde.findReplace',
    )
    expect(binding).toBeDefined()
    expect(binding.key).toBe('ctrl+f')
    expect(binding.mac).toBe('cmd+f')
    expect(binding.when).toBe(`activeCustomEditorId == ${VIEW_TYPE}`)
  })

  it('binds the standard fold chord to VMDE section folding', () => {
    const binding = pkg.contributes.keybindings.find(
      (k: any) => k.command === 'vmde.toggleSectionFold',
    )
    expect(binding).toMatchObject({
      key: 'ctrl+alt+[',
      mac: 'cmd+alt+[',
      when: `activeCustomEditorId == ${VIEW_TYPE}`,
    })
  })

  it('contributes heading shift commands to palette/context without a competing keybinding', () => {
    for (const command of ['vmde.promoteHeading', 'vmde.demoteHeading']) {
      expect(
        pkg.contributes.commands.find(
          (entry: any) => entry.command === command,
        ),
      ).toBeDefined()
      expect(
        pkg.contributes.menus['webview/context'].find(
          (entry: any) => entry.command === command,
        ),
      ).toMatchObject({
        when: 'webviewId == vmde.editor && webviewSection == editor',
      })
      expect(
        pkg.contributes.menus.commandPalette.find(
          (entry: any) => entry.command === command,
        ),
      ).toBeDefined()
      expect(
        pkg.contributes.keybindings.find(
          (entry: any) => entry.command === command,
        ),
      ).toBeUndefined()
    }
  })

  it('activates on the custom editor and the open commands', () => {
    expect(pkg.activationEvents).toEqual(
      expect.arrayContaining([
        'onCustomEditor:vmde.editor',
        'onCommand:vmde.openEditor',
        'onCommand:vmde.openTextEditor',
        'onCommand:vmde.findReplace',
        'onCommand:vmde.toggleSectionFold',
        'onCommand:vmde.promoteHeading',
        'onCommand:vmde.demoteHeading',
      ]),
    )
  })

  it('does not eagerly activate on every markdown file (no onLanguage)', () => {
    expect(pkg.activationEvents).not.toContain('onLanguage:markdown')
  })

  it('declares the settings the provider reads, with matching types/defaults', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.image.saveFolder']).toMatchObject({
      type: 'string',
      default: 'assets',
    })
    expect(props['vmde.theme.content']).toMatchObject({
      type: 'string',
      default: 'auto',
      enum: [
        'auto',
        'github-light',
        'github-dark',
        'material-dark',
        'vscode-light-2026',
        'vscode-dark-2026',
      ],
    })
    // Default ON (task 438): the editor matches VS Code's built-in markdown preview — full
    // width with the same 52px side gutter. Off = the narrow, centred 800px column.
    expect(props['vmde.editor.fullWidth']).toMatchObject({
      type: 'boolean',
      default: true,
    })
    expect(props['vmde.css.custom']).toMatchObject({
      type: 'string',
    })
  })

  it('keeps Settings descriptions concise while preserving key behavior', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    const descriptions = Object.fromEntries(
      [
        'vmde.editor.defaultMode',
        'vmde.editor.fontSize',
        'vmde.editor.headingMarkers',
        'vmde.editor.modifierClickLinks',
        'vmde.editor.slugifyMode',
        'vmde.paste.csvFormat',
        'vmde.paste.urlAsLink',
        'vmde.theme.content',
        'vmde.diagram.mermaid.layout',
        'vmde.diagram.d2.theme',
        'vmde.diagram.d2.sketch',
        'vmde.diagram.geo.basemap',
        'vmde.css.external',
        'vmde.image.saveFolder',
        'vmde.image.format',
        'vmde.image.maxWidth',
        'vmde.image.allowRemote',
        'vmde.performance.streamLargeFiles',
        'vmde.performance.contentVisibility',
      ].map((key) => [
        key,
        props[key].markdownDescription ?? props[key].description,
      ]),
    )

    expect(descriptions).toEqual({
      'vmde.editor.defaultMode':
        'Default mode for opening Markdown files. You can override it per path with Default Mode by Glob. Large files always use Instant Rendering.',
      'vmde.editor.fontSize':
        'Editor content size. Use "editor" to follow VS Code, "vditor" for 16px, or enter a pixel value such as "15".',
      'vmde.editor.headingMarkers':
        'Show heading and link-reference markers in Instant Rendering mode. Disable to reduce the left margin.',
      'vmde.editor.modifierClickLinks':
        'Open links with Ctrl+click (Cmd+click on macOS). Disable to open links with a regular click instead.',
      'vmde.editor.slugifyMode':
        'Heading-anchor format used for #heading links, the outline, and link completion.',
      'vmde.paste.csvFormat':
        'Convert pasted spreadsheet cells to a Markdown table. Content pasted into code blocks stays unchanged.',
      'vmde.paste.urlAsLink':
        'Convert pasted URLs to Markdown links. With selected text, the selection becomes the link label.',
      'vmde.theme.content':
        'Rendered Markdown color theme. "auto" follows VS Code; named themes use their own palette. Configure code colors separately.',
      'vmde.diagram.mermaid.layout':
        'Layout engine for Mermaid graph diagrams. Use ELK for more compact graphs; other Mermaid diagram types are unaffected.',
      'vmde.diagram.d2.theme':
        'Color theme for D2 diagrams. "auto" follows the render theme; "mono" uses the editor foreground.',
      'vmde.diagram.d2.sketch':
        'Use a hand-drawn style for D2 diagrams. Colors still follow the selected D2 theme.',
      'vmde.diagram.geo.basemap':
        'Basemap for GeoJSON and TopoJSON maps. Remote tiles require Allow Remote Images; "none" works offline.',
      'vmde.css.external':
        'External CSS files to load in the editor. Paths may be absolute or workspace-relative; changes reload automatically.',
      'vmde.image.saveFolder':
        'Destination folder for uploaded files. The default `assets` follows a matching `markdown.copyFiles.destination` rule; set another value here to override it. Use `${projectRoot}/assets` for a project-level folder.',
      'vmde.image.format':
        'Output format for uploaded and pasted images. WebP reduces raster image size; SVG and GIF files keep their original format.',
      'vmde.image.maxWidth':
        'Resize uploaded and pasted images wider than this value. Use 0 to disable resizing.',
      'vmde.image.allowRemote':
        'Allow remote HTTPS images in the editor. Disabled by default because loading them can reveal your IP and that you opened the file. Reopen the editor after changing this setting.',
      'vmde.performance.streamLargeFiles':
        'Load large Markdown files in chunks to keep the editor responsive. Files around 700 KB or larger use this automatically.',
      'vmde.performance.contentVisibility':
        'Improve large-document performance by skipping off-screen layout and painting. Reopen the file after changing this setting.',
    })
  })

  it('scopes css.custom / css.external / image.saveFolder to resource (task 51 #3)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.css.custom'].scope).toBe('resource')
    expect(props['vmde.css.external'].scope).toBe('resource')
    expect(props['vmde.image.saveFolder'].scope).toBe('resource')
  })

  it('declares the Vditor-option toggles (codeBlockLineNumbers, showToolbar)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.editor.codeLineNumbers']).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(props['vmde.editor.toolbar']).toMatchObject({
      type: 'boolean',
      default: true,
    })
    // advanced.retainHidden + advanced.instantPreview graduated to ALWAYS ON — no user settings.
    expect(props['vmde.advanced.retainHidden']).toBeUndefined()
    expect(props['vmde.advanced.instantPreview']).toBeUndefined()
  })

  it('declares reading-position restoration as a default-on resource setting', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.restorePosition']).toMatchObject({
      scope: 'resource',
      type: 'boolean',
      default: true,
    })
  })

  it('declares preview soft-line-break reflow as an opt-in resource setting (task 83)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.preview.reflowLineBreaks']).toMatchObject({
      scope: 'resource',
      type: 'boolean',
      default: false,
    })
    expect(props['vmde.preview.reflowLineBreaks'].markdownDescription).toMatch(
      /preview/i,
    )
  })

  it('declares the manual rewrap command, Alt+Q, and its resource-scoped column (task 273)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.editor.wrapColumn']).toMatchObject({
      scope: 'resource',
      type: 'number',
      default: 80,
    })
    expect(
      pkg.contributes.commands.find((c: any) => c.command === 'vmde.rewrap'),
    ).toMatchObject({
      title: 'Rewrap Paragraph/Selection',
      category: 'VMDE',
    })
    expect(
      pkg.contributes.keybindings.find(
        (binding: any) => binding.command === 'vmde.rewrap',
      ),
    ).toMatchObject({
      key: 'alt+q',
      mac: 'alt+q',
      when: 'activeCustomEditorId == vmde.editor',
    })
    expect(
      pkg.contributes.menus['webview/context'].find(
        (item: any) => item.command === 'vmde.rewrap',
      ).when,
    ).toBe('webviewId == vmde.editor && webviewSection == editor')
  })

  it('declares Rewrap Document without changing the selection command or adding a keybinding', () => {
    expect(
      pkg.contributes.commands.find(
        (command: any) => command.command === 'vmde.rewrapDocument',
      ),
    ).toMatchObject({
      title: 'Rewrap Document',
      category: 'VMDE',
    })
    expect(
      pkg.contributes.menus['webview/context'].find(
        (item: any) => item.command === 'vmde.rewrapDocument',
      ),
    ).toMatchObject({
      when: 'webviewId == vmde.editor && webviewSection == editor',
    })
    expect(
      pkg.contributes.menus.commandPalette.find(
        (item: any) => item.command === 'vmde.rewrapDocument',
      ),
    ).toMatchObject({
      when: 'activeCustomEditorId == vmde.editor',
    })
    expect(
      pkg.contributes.keybindings.some(
        (binding: any) => binding.command === 'vmde.rewrapDocument',
      ),
    ).toBe(false)
    expect(
      pkg.contributes.commands.find(
        (command: any) => command.command === 'vmde.rewrap',
      )?.title,
    ).toBe('Rewrap Paragraph/Selection')
  })

  it('declares Format table for the palette and native editor context without a keybinding', () => {
    expect(
      pkg.contributes.commands.find(
        (command: any) => command.command === 'vmde.formatTable',
      ),
    ).toMatchObject({ title: 'Format table', category: 'VMDE' })
    expect(
      pkg.contributes.menus['webview/context'].find(
        (item: any) => item.command === 'vmde.formatTable',
      ),
    ).toMatchObject({
      when: 'webviewId == vmde.editor && webviewSection == editor',
    })
    expect(
      pkg.contributes.menus.commandPalette.find(
        (item: any) => item.command === 'vmde.formatTable',
      ),
    ).toMatchObject({ when: 'activeCustomEditorId == vmde.editor' })
    expect(
      pkg.contributes.keybindings.some(
        (binding: any) => binding.command === 'vmde.formatTable',
      ),
    ).toBe(false)
  })

  it('groups the four wrapping settings with approved Task 516 defaults, bounds, order, and cross-links', () => {
    const group = pkg.contributes.configuration.find(
      (entry: any) => entry.title === 'Line Wrapping',
    )
    expect(Object.keys(group.properties)).toEqual([
      'vmde.editor.wrapColumn',
      'vmde.editor.autoWrap',
      'vmde.editor.autoWrapDelay',
      'vmde.preview.reflowLineBreaks',
    ])
    expect(group.properties['vmde.editor.autoWrap']).toMatchObject({
      order: 2,
      scope: 'resource',
      type: 'boolean',
      default: false,
    })
    expect(group.properties['vmde.editor.autoWrapDelay']).toMatchObject({
      order: 3,
      scope: 'resource',
      type: 'number',
      default: 500,
      minimum: 100,
      maximum: 5000,
    })
    expect(
      group.properties['vmde.editor.wrapColumn'].markdownDescription,
    ).toMatch(/#vmde\.editor\.autoWrap#/u)
    expect(
      group.properties['vmde.editor.autoWrap'].markdownDescription,
    ).toMatch(/#vmde\.editor\.autoWrapDelay#/u)
    expect(
      group.properties['vmde.editor.autoWrapDelay'].markdownDescription,
    ).toMatch(/#vmde\.editor\.autoWrap#/u)
    expect(
      group.properties['vmde.preview.reflowLineBreaks'].markdownDescription,
    ).toMatch(/independent from #vmde\.editor\.autoWrap#/u)
    expect(
      pkg.contributes.configuration.some(
        (entry: any) => entry.title === 'Preview',
      ),
    ).toBe(false)
  })

  it('declares the bundled Markdown extensions as resource-scoped default-off parser changes', () => {
    const properties = pkg.contributes.configuration.find(
      (entry: any) => entry.title === 'Markdown Extensions',
    ).properties
    expect(Object.keys(properties)).toEqual([
      'vmde.markdown.toc',
      'vmde.markdown.mark',
      'vmde.markdown.supSub',
    ])
    for (const setting of Object.values(properties) as any[])
      expect(setting).toMatchObject({
        scope: 'resource',
        type: 'boolean',
        default: false,
      })
  })

  it('declares the outline settings (highlightHeadings, outlinePosition/Width, showOutlineByDefault, outlineHighlight)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    // Task 489 renamed this: theme.highlightHeadings -> editor.headingColors (a feature toggle, not
    // a theme). The deprecated key was removed, so assert the live one.
    expect(props['vmde.editor.headingColors']).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(props['vmde.editor.headingMarkers']).toMatchObject({
      type: 'boolean',
      default: true,
    })
    expect(props['vmde.outline.position']).toMatchObject({
      type: 'string',
      enum: ['left', 'right'],
      default: 'right',
    })
    expect(props['vmde.outline.width']).toBeUndefined()
    expect(props['vmde.outline.defaultOpen']).toMatchObject({
      type: 'boolean',
      default: false,
    })
    expect(props['vmde.outline.highlight']).toMatchObject({
      type: 'boolean',
      default: true,
    })
  })

  it('declares the mermaidTheme setting (enum, default "auto")', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    // Task 489: theme.mermaid -> diagram.mermaid.theme (per-engine grouping).
    expect(props['vmde.diagram.mermaid.theme']).toMatchObject({
      type: 'string',
      default: 'auto',
    })
    expect(props['vmde.diagram.mermaid.theme'].enum).toEqual(
      expect.arrayContaining(['auto', 'default', 'forest']),
    )
    // task 51: per-value dropdown help, parallel to enum by index.
    const mermaid = props['vmde.diagram.mermaid.theme']
    expect(mermaid.enumDescriptions).toHaveLength(mermaid.enum.length)
    expect(mermaid.enumDescriptions[0]).toMatch(/VS Code/i)
  })

  it('declares the geoBasemap setting (enum incl. auto/voyager/osm/none, default "auto")', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    const geo = props['vmde.diagram.geo.basemap']
    expect(geo).toMatchObject({ type: 'string', default: 'auto' })
    expect(geo.enum).toEqual(['auto', 'voyager', 'osm', 'none'])
    // per-value dropdown help, parallel to enum by index (task 51 convention)
    expect(geo.enumDescriptions).toHaveLength(geo.enum.length)
  })

  it('has no fast-edit / render-cache settings — they graduated to ALWAYS ON (tasks 175/180/184)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    // These optimisations are no longer user settings — they run unconditionally (fastDiagramEdit 175,
    // fastProseEdit 180, diagramRenderCache 184), and the capture/re-home experiment (stableRenderNode
    // 183) was removed entirely.
    expect(props['vmde.advanced.fastDiagramEdit']).toBeUndefined()
    expect(props['vmde.advanced.fastProseEdit']).toBeUndefined()
    expect(props['vmde.advanced.diagramRenderCache']).toBeUndefined()
    expect(props['vmde.advanced.stableRenderNode']).toBeUndefined()
  })

  it('describes the "auto" value of theme.code (task 51)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    const code = props['vmde.theme.code']
    expect(code.enum[0]).toBe('auto')
    // single-entry array: only "auto" (index 0) gets help; the 70+ named
    // highlight.js styles are self-evident and left undescribed.
    expect(code.enumDescriptions[0]).toMatch(/VS Code/i)
  })

  it('declares the fontSize setting under Editor, default "editor" (task 43)', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.editor.fontSize']).toMatchObject({
      type: 'string',
      default: 'editor',
    })
    // Task 489 renamed the group: "Appearance" only ever held editor.* keys.
    const editor = pkg.contributes.configuration.find(
      (c: any) => c.title === 'Editor',
    )
    expect(Object.keys(editor.properties)).toContain('vmde.editor.fontSize')
  })

  it('declares the externalCssFiles setting', () => {
    const props = Object.assign(
      {},
      ...pkg.contributes.configuration.map((c: any) => c.properties),
    )
    expect(props['vmde.css.external']).toMatchObject({
      type: 'array',
      default: [],
    })
  })

  // Task 489 — the categories were regrouped so that the UI section a setting appears in matches its
  // key namespace. Before, `diagram.*` sat under "Themes" and `slugifyMode`/`paste.*` under
  // "Appearance"; a reader scanning the Settings UI had no way to predict where a key lived.
  it('groups settings into titled sections whose namespaces match the category', () => {
    expect(Array.isArray(pkg.contributes.configuration)).toBe(true)
    const titles = pkg.contributes.configuration.map((c: any) => c.title)
    expect(titles).toEqual([
      'Editor',
      'Themes',
      'Find and Replace',
      'Line Wrapping',
      'Markdown Extensions',
      'Diagrams',
      'Custom CSS',
      'Outline',
      'Image',
      'Wiki',
      'Performance',
    ])
    const group = (title: string) =>
      pkg.contributes.configuration.find((c: any) => c.title === title)
    const keysOf = (title: string) =>
      Object.keys(group(title).properties).map((k: string) =>
        k.replace(/^vmde\./, ''),
      )
    // Each live category owns one or two namespaces — nothing foreign leaks in.
    const OWNED: Record<string, string[]> = {
      Editor: ['editor.', 'paste.', 'restorePosition'],
      Themes: ['theme.'],
      'Find and Replace': ['findMatch.'],
      'Line Wrapping': ['editor.', 'preview.'],
      'Markdown Extensions': ['markdown.'],
      Diagrams: ['diagram.'],
      'Custom CSS': ['css.'],
      Outline: ['outline.'],
      Image: ['image.'],
      Wiki: ['wiki.'],
      Performance: ['performance.'],
    }
    for (const [title, prefixes] of Object.entries(OWNED))
      for (const key of keysOf(title))
        expect(
          prefixes.some((p) => key.startsWith(p)),
          `${key} does not belong under "${title}"`,
        ).toBe(true)
    // The content theme leads its section — it drives every other renderer's palette.
    expect(keysOf('Themes')).toEqual(['theme.content', 'theme.code'])
    expect(keysOf('Line Wrapping')).toEqual([
      'editor.wrapColumn',
      'editor.autoWrap',
      'editor.autoWrapDelay',
      'preview.reflowLineBreaks',
    ])
  })

  // The old Themes group had TWO settings at `order: 7`, so their UI position was undefined.
  it('gives every setting a distinct order within its group', () => {
    for (const group of pkg.contributes.configuration) {
      const orders = Object.values(group.properties).map((p: any) => p.order)
      expect(orders, `${group.title} has an unordered setting`).not.toContain(
        undefined,
      )
      expect(new Set(orders).size, `${group.title} has duplicate orders`).toBe(
        orders.length,
      )
    }
  })
})
