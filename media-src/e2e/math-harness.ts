import '../src/boot/preload'
// Source import so the fixMathRender patch (strict:false, throwOnError:false) is
// applied — the whole point of this harness.
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import {
  configureGithubInlineMathInsertion,
  installGithubInlineMathInsertion,
} from '../src/editing/math-insertion'
import {
  installCaretInvalidation,
  installCaretWindowBridge,
} from '../src/editing/caret'
import {
  installEditorCaretTracking,
  installIrMarkerReveal,
} from '../src/editing/editor-caret'

const mode = new URLSearchParams(location.search).get('mode') || 'ir'

installCaretInvalidation()
installCaretWindowBridge()
installEditorCaretTracking()
installIrMarkerReveal()

// Real Vditor (IR) with a VALID and a deliberately BROKEN formula side by side
// (task 57). With the patch, KaTeX renders the broken one as an inline error
// (.katex-error) instead of throwing, so the valid one still renders and the
// editor stays usable.
const value = [
  'Valid inline math: $E = mc^2$ and more text.',
  'GitHub inline math: $`x^2`$ keeps its source delimiters but renders x squared.',
  '',
  'Broken inline math: $\\frac{1}{$ should not break the page.',
  '',
  'Another valid one: $a^2 + b^2 = c^2$.',
  '',
  'Action target and empty insertion site.',
  '',
  'Literal `code target` must remain literal.',
  '',
  'U200B source: prefix \u200Btarget and adjacent \u200Bempty-site.',
  '',
].join('\n')

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn: `${location.origin}/vditor`,
  toolbar: createToolbar(),
  value,
  preview: { math: { inlineDigit: true } },
  // Vditor 3.11 calls this unconditionally while rendering the wysiwyg
  // toolbar; without it init throws (see main.ts).
  customWysiwygToolbar: () => {
    /* required stub — see comment above */
  },
  after() {
    ;(window as any).vditor = editor
    ;(window as any).vditorTest = editor
    configureGithubInlineMathInsertion({
      setApplying: () => undefined,
      invalidate: () => undefined,
      scheduleSync: () => undefined,
      snapshotMarkdown: () => editor.getValue(),
      onError(error) {
        throw error
      },
    })
    ;(window as any).__disposeGithubInlineMath =
      installGithubInlineMathInsertion()
    ;(window as any).__ready = true
  },
})
