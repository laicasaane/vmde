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
const value =
  'Before H<sub title="source-only">**2** &amp;</sub>O after.\n\nSup x<SUP title="source-only">**2** &amp;</SUP>y.\n\nUnder x<INS title="source-only">**added** &amp;</INS>y.\n\nPlain H<sub>2</sub>O.\n\nAction H2O.\n\nFootnote reference[^note].\n\n[^note]: Generated footnote body.\n\n`<sub>code</sub>`\n\n<sub>unclosed\n\n<ins>unclosed'

const editor = new Vditor('app', {
  cdn: `${location.origin}/vditor`,
  mode,
  cache: { enable: false },
  toolbar: createToolbar(),
  preview: { markdown: { sup: supSub, sub: supSub } },
  value,
  after() {
    wrapHtmlInlineFormattingLute(editor.vditor.lute)
    ;(window as any).__disposeInlineFormatting =
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
