import { hasClosestBlock } from 'vditor/src/ts/util/hasClosest'
import { t } from '../util/lang'
import { toolbarTip } from '../../../src/shared/editor-shortcuts'
import {
  backIcon,
  calloutIcon,
  chevronUpIcon,
  detailsIcon,
  editInVsCodeIcon,
  fileMediaIcon,
  hashIcon,
  headingIcon,
  infoIcon,
  linkIcon,
  mathIcon,
  moreIcon,
  outlineIcon,
  previewIcon,
  rowInsertBottomIcon,
  rowInsertTopIcon,
  settingsGearIcon,
  sigmaIcon,
  splitHorizontalIcon,
  squarePenIcon,
  squareSigmaIcon,
  subscriptIcon,
  superscriptIcon,
  underlineIcon,
  wikiPagesIcon,
} from './toolbar-icons'

// Task 505 — one owner per key: every item a `vmde.format.*` command clicks and every
// deliberately-unpromoted-but-formerly-hotkeyed item below gets `hotkey: ''`, which makes Vditor's
// own `matchHotKey` (node_modules/vditor/src/ts/util/hotKey.ts) return `false` immediately and
// stops its bubble-phase handler from ever intercepting/`preventDefault()`ing that key — so the VS
// Code command (registered in src/app/commands.ts from the shared shortcut table) is the sole
// owner. The tooltip of a command's item is built from the same table (`toolbarTip`), NOT Vditor's
// `updateHotkeyTip`. Task 580 CP3-2: every tooltip is the action name only, with no key, because an
// extension cannot read a user's remapped keys. `toolbarTip` throws on a name the table has no
// command for, so a typo cannot fall back to Vditor's own (stale) hotkey/tip.
function promoted(name: string) {
  return { name, hotkey: '', tip: toolbarTip(name) }
}

// Task 642 — a More or Math row shows its icon and its name. Vditor's `Custom` writes `icon` as the
// whole row, and `MenuItem` writes a level-2 `tip` as the row HTML, so both carry this markup.
function menuRow(icon: string, label: string): string {
  return `${icon}<span class="vmde-menu-label">${label}</span>`
}

// Build-time constants injected via esbuild `define` (see esbuild-shared.mjs):
// the Vditor version and the vendored Lute pin (commit + date). Empty if unpinned.
declare const __VMDE_VDITOR_VERSION__: string
declare const __VMDE_LUTE_COMMIT__: string
declare const __VMDE_LUTE_COMMITTED_AT__: string

// "About VMDE" dialog (shown via vditor.tip.show). Mirrors the version line of the
// "About vditor" dialog — Vditor + the pinned Lute build as a GitHub commit link +
// date — and links to the VMDE repo. Rendered inside the webview tip; the links
// are chrome (not editor content), so they open on a plain click. Pure (takes its
// version data as args) so it's unit-testable; the call site passes the build-time
// `define` constants.
export const VMDE_REPO = 'https://github.com/laicasaane/vmde'
export function aboutVmdeHtml(v: {
  vditorVersion: string
  luteCommit: string
  luteCommittedAt: string
}): string {
  const lute = v.luteCommit
    ? `Lute <a href="https://github.com/88250/lute/commit/${v.luteCommit}" target="_blank">${v.luteCommit.slice(0, 7)}</a>${v.luteCommittedAt ? ` (${v.luteCommittedAt})` : ''}`
    : 'Lute'
  return (
    '<div style="max-width: 440px;font-size: 14px;line-height: 22px;margin-bottom: 14px;">' +
    '<p style="text-align: center;margin: 14px 0"><em>VMDE — a visual Markdown editor for VS Code</em></p>' +
    '<ul style="list-style: none">' +
    `<li>GitHub: <a href="${VMDE_REPO}" target="_blank">laicasaane/vmde</a></li>` +
    '<li>License: MIT</li>' +
    `<li>Version: Vditor v${v.vditorVersion} / ${lute}</li>` +
    '</ul>' +
    '</div>'
  )
}

function getEditorRange(): Range | undefined {
  const mode = vditor.getCurrentMode()
  const editor = vditor.vditor?.[mode]?.element as HTMLElement | undefined
  const selection = window.getSelection()

  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    if (
      editor?.contains(range.commonAncestorContainer) ||
      editor?.isEqualNode(range.commonAncestorContainer as Node)
    ) {
      return range.cloneRange()
    }
  }

  const storedRange = vditor.vditor?.[mode]?.range as Range | undefined
  return storedRange?.cloneRange()
}

function getCharBeforeRange(range: Range): string {
  const mode = vditor.getCurrentMode()
  const editor = vditor.vditor?.[mode]?.element as HTMLElement | undefined
  if (!editor) return ''

  const beforeRange = range.cloneRange()
  beforeRange.selectNodeContents(editor)
  beforeRange.setEnd(range.startContainer, range.startOffset)
  return beforeRange.toString().slice(-1)
}

function restoreEditorRange(range: Range | undefined) {
  if (!range) return
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  const mode = vditor.getCurrentMode()
  // Mirrors the optional-chained reads above (getEditorRange/getCharBeforeRange): the current
  // mode's editor state can be absent (e.g. mode just switched), in which case there's nowhere
  // to store the range — same no-op the reads already tolerate.
  const modeState = vditor.vditor[mode]
  if (!modeState) return
  modeState.range = range.cloneRange()
}

// Task 608: a blockless IR range starts inside the editor but outside every block (the bare
// editable root) in an editor that has at least one top-level block; the empty editor has none and
// keeps Vditor's insertion. Link refuses there: Vditor would write a new top-level paragraph. The
// start test also covers a non-collapsed range that starts at the root (Owner, 2026-10-14). This is
// the same predicate as the build-time Headings and Code/Table patches, with Vditor's own
// `hasClosestBlock` inline so the chrome layer takes no `editing/` import.
function isBlocklessIrRange(range: Range | undefined): boolean {
  if (!range || vditor.getCurrentMode() !== 'ir') return false
  const editor = vditor.vditor?.ir?.element as HTMLElement | undefined
  if (!editor?.contains(range.startContainer)) return false
  return (
    !hasClosestBlock(range.startContainer) &&
    editor.querySelector(':scope > [data-block]') !== null
  )
}

function insertMarkdownLink() {
  const range = getEditorRange()
  const selectedText = (range?.toString() || '').trim()
  const beforeChar = range ? getCharBeforeRange(range) : ''
  const needsLeadingSpace = Boolean(beforeChar) && !/\s/.test(beforeChar)
  const leadingSpace = needsLeadingSpace ? ' ' : ''

  vditor.focus()
  restoreEditorRange(range)

  // Read the range again: with none stored, focus() leaves Vditor's synthesized (editor, 0) range.
  if (isBlocklessIrRange(getEditorRange())) return

  if (selectedText) {
    vditor.updateValue(`${leadingSpace}[${selectedText}]()`)
    return
  }

  vditor.insertValue(`${leadingSpace}[]()`)
}

interface ToolbarOptions {
  wikiEnabled?: boolean
}

export function createToolbar(options: ToolbarOptions = {}) {
  const toolbarItems = [
    // undo/redo run their vmde.format.* command from VS Code's Undo/Redo keys (Task 580 CP2-3;
    // see src/shared/editor-shortcuts.ts). `hotkey: ''` keeps Vditor's own handler off those
    // keys. The tooltip is the localized name only (Task 580 CP3-2).
    { name: 'undo', hotkey: '', tip: t('undo') },
    { name: 'redo', hotkey: '', tip: t('redo') },
    '|',
    // No VS Code command / keybinding for these — toolbar/mouse-only (task 505 §4). Still
    // `hotkey: ''`'d so Vditor doesn't own a key VS Code doesn't also formally own.
    { ...promoted('headings'), icon: headingIcon },
    '|',
    promoted('bold'),
    promoted('italic'),
    {
      name: 'underline',
      hotkey: '',
      icon: underlineIcon,
      tip: t('underline'),
      click() {
        document.dispatchEvent(new Event('vmde-toggle-underline'))
      },
    },
    promoted('strike'),
    promoted('inline-code'),
    '|',
    {
      name: 'subscript',
      hotkey: '',
      icon: subscriptIcon,
      tip: t('subscript'),
      click() {
        document.dispatchEvent(new Event('vmde-toggle-subscript'))
      },
    },
    {
      name: 'superscript',
      hotkey: '',
      icon: superscriptIcon,
      tip: t('superscript'),
      click() {
        document.dispatchEvent(new Event('vmde-toggle-superscript'))
      },
    },
    '|',
    {
      hotkey: '',
      icon: linkIcon,
      name: 'link',
      click() {
        insertMarkdownLink()
      },
      // Was 'n' (above the button) — the toolbar is the topmost chrome in the webview with no
      // room above it, so an 'n' tooltip renders off the top of the viewport and is invisible.
      // Every other early-toolbar item already defaults to 's'; this one just never got it.
      tipPosition: 's',
    },
    '|',
    promoted('list'),
    promoted('ordered-list'),
    promoted('check'),
    '|',
    promoted('outdent'),
    promoted('indent'),
    '|',
    promoted('quote'),
    {
      name: 'callout',
      hotkey: '',
      icon: calloutIcon,
      tip: t('callout'),
      click() {
        document.dispatchEvent(new Event('vmde-toggle-callout-toolbar'))
      },
    },
    {
      name: 'details',
      hotkey: '',
      icon: detailsIcon,
      tip: t('toggleDetails'),
      click() {
        document.dispatchEvent(new Event('vmde-toggle-details'))
      },
    },
    promoted('code'),
    {
      name: 'math',
      hotkey: '',
      icon: mathIcon,
      tip: t('math'),
      toolbar: [
        {
          name: 'math-inline-github',
          hotkey: '',
          tip: t('inlineMathGithub'),
          icon: menuRow(sigmaIcon, t('inlineMathGithub')),
          click() {
            document.dispatchEvent(new Event('vmde-insert-github-inline-math'))
          },
        },
        {
          name: 'math-block',
          hotkey: '',
          tip: t('mathBlock'),
          icon: menuRow(squareSigmaIcon, t('mathBlock')),
          click() {
            document.dispatchEvent(new Event('vmde-insert-github-fenced-math'))
          },
        },
      ],
    },
    { name: 'table', hotkey: '' },
    // Pre-existing label override (not hotkey-related): Vditor's own i18n for 'line' is the
    // terse "Line"; kept across the hotkey: '' change since it's still accurate.
    { name: 'line', hotkey: '', tip: t('horizontalRule') },
    '|',
    'upload',
    { name: 'emoji', hotkey: '' },
    '|',
    { name: 'insert-before', hotkey: '', icon: rowInsertTopIcon },
    { name: 'insert-after', hotkey: '', icon: rowInsertBottomIcon },
    '|',
    { name: 'outline', icon: outlineIcon },
    '|',
    ...(options.wikiEnabled
      ? [
          {
            name: 'navigate-back',
            tipPosition: 's',
            tip: t('navigateBack'),
            className: 'right',
            icon: backIcon,
            click() {
              vscode.postMessage({
                command: 'navigate-back',
              })
            },
          },
          {
            name: 'wiki-pages',
            tipPosition: 's',
            tip: t('wikiPages'),
            className: 'right',
            icon: wikiPagesIcon,
            click() {
              vscode.postMessage({
                command: 'list-wiki-pages',
              })
            },
          },
          '|',
        ]
      : []),
    {
      name: 'edit-in-vscode',
      tipPosition: 's',
      tip: t('editInVsCode'),
      className: 'right',
      icon: editInVsCodeIcon,
      click() {
        vscode.postMessage({
          command: 'edit-in-vscode',
        })
      },
    },
    // Task 642: Preview sits directly before Edit Mode. No pinned tooltip side: the tail ends the
    // row, so toolbar-tips.ts picks the direction from the button's position.
    { name: 'preview', icon: previewIcon },
    { name: 'edit-mode', icon: squarePenIcon },
    {
      name: 'more',
      icon: moreIcon,
      toolbar: [
        // Task 505 follow-up: this nested `more` submenu was missed by the original sweep (its
        // top-level-only completeness test never walked `more.toolbar`) — `both` still carried
        // Vditor's native `⌘P` hotkey, live and unneutralised: it kept shadowing VS Code's own
        // Ctrl+P (Quick Open, a very high-frequency workbench command) AND rendered its tooltip
        // with Vditor's native `<Ctrl+P>` key hint, which no tooltip shows (Task 580 CP3-2).
        // `both` has no cross-tool precedent as a keyboard action and no VS Code command of its
        // own — same "drop it" bucket as link/table/emoji, not a remap candidate.
        {
          name: 'both',
          hotkey: '',
          tip: menuRow(
            splitHorizontalIcon,
            (globalThis as any).VditorI18n?.both ?? 'editor & preview',
          ),
        },
        // content-theme + code-theme pickers dropped from the toolbar — VS Code
        // manages the theme: content follows the editor colours, and the code
        // block highlight is the `markdown-editor.codeTheme` setting.
        // outline + preview promoted to the main toolbar.
        {
          name: 'settings',
          tip: t('settings'),
          // Task 642: the codicon cog (as on the editor title bar) beside the name.
          icon: menuRow(settingsGearIcon, t('settings')),
          click() {
            vscode.postMessage({
              command: 'open-settings',
            })
          },
        },
        {
          name: 'insert-anchor',
          hotkey: '',
          tip: t('insertAnchor'),
          icon: menuRow(hashIcon, t('insertAnchor')),
          click() {
            document.dispatchEvent(
              new CustomEvent('vmde-insert-named-anchor', {
                detail: { returnFocus: document.activeElement },
              }),
            )
          },
        },
        {
          name: 'insert-picture',
          hotkey: '',
          tip: t('insertPicture'),
          icon: menuRow(fileMediaIcon, t('insertPicture')),
          click() {
            document.dispatchEvent(new Event('vmde-insert-picture'))
          },
        },
        // The 'info' item shows Vditor's original About dialog (translated to English
        // by the fixInfoDialog esbuild patch), with the Help dialog's links folded in
        // as a section below it — so the separate Vditor 'help' item is dropped. Renamed
        // "About Vditor" (tip drives the dropdown label for level-2 items).
        { name: 'info', tip: menuRow(infoIcon, t('aboutVditor')) },
        {
          name: 'about',
          tip: t('aboutVmde'),
          // Shows the VMDE About dialog (version + GitHub link) as a webview tip,
          // matching the "About vditor" dialog. `vditor` is the IVditor instance
          // Vditor passes to a Custom item's click; its `.tip` renders the popup.
          icon: menuRow(infoIcon, t('aboutVmde')),
          click(_event: Event, vditor: any) {
            vditor.tip.show(
              aboutVmdeHtml({
                vditorVersion: __VMDE_VDITOR_VERSION__,
                luteCommit: __VMDE_LUTE_COMMIT__,
                luteCommittedAt: __VMDE_LUTE_COMMITTED_AT__,
              }),
              0,
            )
          },
        },
      ],
    },
    // Task 631: a pure trailing append (row one's trailing edge). It has no click of its own:
    // chrome/toolbar-collapse.ts binds it after the toolbar is built, and owns its state.
    {
      name: 'collapse-toolbar',
      hotkey: '',
      icon: chevronUpIcon,
      tip: t('collapseToolbar'),
    },
  ]

  return toolbarItems.map((it: any) => {
    if (typeof it === 'string') {
      it = { name: it }
    }
    it.tipPosition = it.tipPosition || 's'
    return it
  })
}
