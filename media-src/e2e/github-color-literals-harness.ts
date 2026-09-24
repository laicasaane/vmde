import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { applyBodyOptions } from '../src/boot/live-config'
import { observeGithubColorLiterals } from '../src/editing/github-color-literals'

const params = new URLSearchParams(location.search)
const requestedMode = params.get('mode')
const mode =
  requestedMode === 'wysiwyg' || requestedMode === 'sv' ? requestedMode : 'ir'
const enabled = params.get('enabled') === '1'
const markdown = [
  'HEX `#0969DA`, RGB `rgb(9, 105, 218)`, and HSL `hsl(212, 92%, 45%)`.',
  '',
  'Raw HTML: <code>#abcdef</code>.',
  '',
  '```css',
  '#123456',
  '```',
].join('\n')

const editor = new Vditor('app', {
  cache: { enable: false },
  cdn: `${location.origin}/vditor`,
  mode,
  value: markdown,
  height: '100%',
  minHeight: '100%',
  toolbar: ['preview', 'edit-mode'],
  after() {
    ;(window as any).vditor = editor
    ;(window as any).__source = markdown
    ;(window as any).__liveConfig = { applyBodyOptions }
    const app = document.getElementById('app')
    ;(window as any).__disposeColorLiterals = observeGithubColorLiterals(app)
    applyBodyOptions({ githubColorLiterals: enabled })
    ;(window as any).__ready = true
  },
})
