import '../src/boot/preload'
import Vditor from 'vditor'
import { createToolbar } from '../src/chrome/toolbar'
import {
  configureHtmlSubscriptCommand,
  installHtmlInlineFormattingControls,
} from '../src/editing/html-subscript-command'
import {
  observeHtmlInlineFormattingReaders,
  wrapHtmlInlineFormattingLute,
} from '../src/editing/html-subscript'

const mode = new URLSearchParams(location.search).get('mode') || 'ir'
const supSub = new URLSearchParams(location.search).get('supSub') === '1'
const DEFAULT_VALUE =
  'Before H<sub title="source-only">**2** &amp;</sub>O after.\n\nSup x<SUP title="source-only">**2** &amp;</SUP>y.\n\nUnder x<INS title="source-only">**added** &amp;</INS>y.\n\nPlain H<sub>2</sub>O.\n\nAction H2O.\n\nFootnote reference[^note].\n\n[^note]: Generated footnote body.\n\n`<sub>code</sub>`\n\n<sub>unclosed\n\n<ins>unclosed'

// Task 654: `?fixture=link` swaps in the inline HTML anchor document so the existing sub/sup/ins
// specs keep their own value. Every block is separated by a blank line (one Lute paragraph each).
const LINK_FIXTURE = [
  'Plain <a href="https://example.com/plain">plainlink</a> end.',
  'Attrs <a class="x" href="https://example.com/attrs" title="t">attrslink</a> end.',
  'Amp <a href="?a=1&amp;b=2">amplink</a> end.',
  'Nested <a href="https://example.com/nested">nestedbody <b>bold</b> *em* `code` H<sub>2</sub>O</a> end.',
  'Two <a href="https://example.com/one">onelink</a> and <a href="https://example.com/two">twolink</a> end.',
  'Anchor id <a id="x">idtext</a> end.',
  'Anchor name <a name="y">nametext</a> end.',
  'Js <a href="javascript:alert(1)">jstext</a> end.',
  'Data <a href="data:text/html,x">datatext</a> end.',
  'Empty <a href="">emptytext</a> end.',
  '<div><a href="https://example.com/block">blocktext</a></div>',
  'Rel <a href="./target.md">reltext</a> end.',
  'Md [mdlink](https://example.com/md) end.',
].join('\n\n')
const value =
  new URLSearchParams(location.search).get('fixture') === 'link'
    ? LINK_FIXTURE
    : DEFAULT_VALUE

if (new URLSearchParams(location.search).get('fixture') === 'link') {
  // Emulates the `a { color: var(--vscode-textLink-foreground) }` rule VS Code injects into every
  // webview, so a Markdown link and an HTML link are compared on the colour they get in the real
  // editor rather than the browser default blue (the real-VS-Code spec re-checks it for real).
  const style = document.createElement('style')
  style.textContent =
    ':root{--vscode-textLink-foreground:#4493f8}a{color:var(--vscode-textLink-foreground)}'
  document.head.append(style)
}

const editor = new Vditor('app', {
  cdn: `${location.origin}/vditor`,
  mode,
  cache: { enable: false },
  toolbar: createToolbar(),
  preview: { markdown: { sup: supSub, sub: supSub } },
  value,
  after() {
    wrapHtmlInlineFormattingLute(editor.vditor.lute)
    // `observe=0` leaves the document undecorated: the baseline a decorated page is compared with.
    if (new URLSearchParams(location.search).get('observe') !== '0')
      (window as any).__disposeInlineFormatting =
        observeHtmlInlineFormattingReaders(document.getElementById('app'))
    ;(window as any).vditor = editor
    configureHtmlSubscriptCommand({
      setApplying: () => undefined,
      invalidate: () => undefined,
      scheduleSync: () => undefined,
      snapshotMarkdown: () => editor.getValue(),
      onError: (error) => {
        throw error
      },
    })
    ;(window as any).__disposeInlineFormattingCommand =
      installHtmlInlineFormattingControls()
    ;(window as any).__source = value
    ;(window as any).__canonical = editor.getValue()
    ;(window as any).__ready = true
  },
})
