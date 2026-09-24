import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import {
  installCalloutAuthoringControls,
  observeCallouts,
} from '../src/editing/callouts'
import {
  applyBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
} from '../src/editing/block-transform-command'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'before\n\nalpha **beta**\n\nafter\n',
  after() {
    ;(window as any).vditor = editor
    // Match the production callout dual-node/authoring decoration before exercising its source edge.
    observeCallouts(document.getElementById('app')!)
    installCalloutAuthoringControls()
    configureBlockTransformCommand({
      snapshotExactMarkdown: () => editor.getValue(),
      setApplying: () => undefined,
      postExact: (markdown) => {
        ;(window as any).__postedBlockSource = markdown
      },
      onError: (error) => {
        throw error
      },
    })
    ;(window as any).__blockOptions = () => requestBlockTransformOptions(window)
    ;(window as any).__blockApply = (token: number, target: { type: string }) =>
      applyBlockTransformChoice(window, token, target)
    ;(window as any).__ready = true
  },
})
