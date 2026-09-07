// Append a <script src> once (idempotent by id) and resolve when it loads — or on
// error, so a failed asset never hangs the caller (the caller treats a missing
// global as "engine unavailable" and falls back). Hoisted from the byte-identical
// copies in d2-wasm.ts and elk-layout.ts (task 152 item 5).

// In-flight loads by id. Load-bearing when several callers request the SAME script CONCURRENTLY — e.g.
// two PlantUML blocks referencing the same stdlib lib on one document open, where plantumlRender runs
// once per block so the calls overlap (task 347). The old "if the <script id> already exists, resolve"
// path let the 2nd caller resolve on the half-created tag — BEFORE the script had executed — so it read
// an unpopulated `window.__vmdePumlStdlib` (verified: mapKeys=0), its `!include <lib/…>` didn't expand,
// and the diagram failed to render ("Syntax Error" / mis-detected type), non-deterministically. Sharing
// the pending promise makes every concurrent caller wait for the actual load.
const inFlight = new Map<string, Promise<void>>()

export function loadScript(
  src: string,
  id: string,
  nonce?: string,
): Promise<void> {
  const pending = inFlight.get(id)
  if (pending) return pending // a load for this id is in flight → wait for the real thing
  if (document.getElementById(id)) return Promise.resolve() // present + not in flight → already loaded
  const p = new Promise<void>((resolve) => {
    const s = document.createElement('script')
    s.id = id
    s.src = src
    if (nonce) s.nonce = nonce
    s.onload = () => resolve()
    s.onerror = () => resolve()
    document.head.appendChild(s)
  })
  inFlight.set(id, p)
  // Drop the entry once settled; the <script> element stays as the "already loaded" marker for future
  // calls. Late callers between resolve and delete still get the (resolved) promise — also correct.
  void p.then(() => inFlight.delete(id))
  return p
}
