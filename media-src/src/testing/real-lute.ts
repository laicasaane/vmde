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

export function createRealLute(mode: 'ir' | 'wysiwyg'): RealLute {
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
  lute.SetSpin(true)
  lute.SetSanitize(true)
  lute.SetSup(false)
  lute.SetSub(false)
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
