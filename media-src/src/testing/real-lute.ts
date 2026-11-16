import fs from 'node:fs'
import vm from 'node:vm'

// Test-only loader for the vendored GopherJS Lute (Task 574). Unit tests that assert serializer
// parity or map live IR/WYSIWYG DOM need the real renderer and serializer, not a stub. The
// options mirror Vditor's IR/WYSIWYG setup; callers apply any production Lute patches they need.
export interface RealLute {
  lute: any
  render(markdown: string): string
  serialize(html: string): string
}

// Task 733 / 015-T1: Source mode. `render` is Vditor's Source spin (`SpinVditorSVDOM`); Source DOM
// is text, so `serialize` is the `textContent` of the HTML (needs a DOM, as in a jsdom test).
export function createRealLute(mode: 'ir' | 'wysiwyg' | 'sv'): RealLute {
  const sandbox: Record<string, unknown> = {
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(
    fs.readFileSync('media-src/vendor/lute/lute.min.js', 'utf8'),
    sandbox,
    { filename: 'lute.min.js' },
  )
  const lute = (sandbox as { Lute: { New(): any } }).Lute.New()
  lute.SetVditorIR(mode === 'ir')
  lute.SetVditorWYSIWYG(mode === 'wysiwyg')
  lute.SetVditorSV(mode === 'sv')
  lute.SetSpin(true)
  lute.SetSanitize(true)
  lute.SetSup(false)
  lute.SetSub(false)
  if (mode === 'sv') {
    return {
      lute,
      render: lute.SpinVditorSVDOM.bind(lute),
      serialize: (html: string) => {
        const holder = document.createElement('template')
        holder.innerHTML = html
        return holder.content.textContent ?? ''
      },
    }
  }
  return {
    lute,
    render:
      mode === 'ir'
        ? lute.Md2VditorIRDOM.bind(lute)
        : lute.Md2VditorDOM.bind(lute),
    serialize:
      mode === 'ir'
        ? lute.VditorIRDOM2Md.bind(lute)
        : lute.VditorDOM2Md.bind(lute),
  }
}

const SV_DOUBLE_NEWLINE =
  /<span data-type="newline"><br \/><span style="display: none">\n<\/span><\/span><span data-type="newline"><br \/><span style="display: none">\n<\/span><\/span></g
const SV_SPLIT =
  '<span data-type="newline"><br /><span style="display: none">\n</span></span><span data-type="newline"><br /><span style="display: none">\n</span></span></div><div data-block="0"><'

/** Vditor's `processSpinVditorSVDOM` (`sv/process.ts:54-62`): wraps a Source spin in `data-block` divs, split at two consecutive newline spans. */
export function svBlocksHtml(spinHtml: string): string {
  return `<div data-block='0'>${spinHtml.replace(SV_DOUBLE_NEWLINE, SV_SPLIT)}</div>`
}

let svLute: RealLute | undefined
/**
 * A Source root as Vditor builds it on a mode switch (`toolbar/EditMode.ts:120-125`): the spin of
 * `markdown` split into `data-block` divs inside `pre.vditor-sv.vditor-reset`, connected to the
 * document. Each call builds a fresh root (tests mutate it).
 */
export function svFixture(markdown: string): HTMLElement {
  svLute ??= createRealLute('sv')
  const root = document.createElement('pre')
  root.className = 'vditor-sv vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.innerHTML = svBlocksHtml(svLute.render(markdown))
  document.body.append(root)
  return root
}
