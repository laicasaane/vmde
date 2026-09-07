import '../src/boot/preload'
import Vditor from 'vditor'
import { createToolbar } from '../src/chrome/toolbar'
import {
  configureHtmlSubscriptCommand,
  installHtmlSubscriptControls,
} from '../src/editing/html-subscript-command'
import {
  observeHtmlSubscripts,
  wrapHtmlSubscriptLute,
} from '../src/editing/html-subscript'

const mode = new URLSearchParams(location.search).get('mode') || 'ir'
const value =
  'Before H<sub title="source-only">**2** &amp;</sub>O after.\n\nPlain H<sub>2</sub>O.\n\nAction H2O.\n\n`<sub>code</sub>`\n\n<sub>unclosed'

const editor = new Vditor('app', {
  cdn: `${location.origin}/vditor`,
  mode,
  cache: { enable: false },
  toolbar: createToolbar(),
  value,
  after() {
    wrapHtmlSubscriptLute(editor.vditor.lute)
    ;(window as any).__disposeSubscript = observeHtmlSubscripts(
      document.getElementById('app'),
    )
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
    ;(window as any).__disposeSubscriptCommand = installHtmlSubscriptControls()
    ;(window as any).__source = value
    ;(window as any).__canonical = editor.getValue()
    ;(window as any).__ready = true
  },
})
