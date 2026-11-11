// Task 733: test-only counts of why a block action (handle menu, drag, keyboard) did not reach the
// host. Created only in end-to-end runs (`__vmdeE2EReadiness` exists), so product runs pay nothing.
// A spec reads `window.__vmdeBlockActionDeclines` to name the silent exit; it holds reasons and
// counts only, never document text.

interface DeclineWindow {
  __vmdeE2EReadiness?: unknown
  __vmdeBlockActionDeclines?: Record<string, number>
}

export function countBlockActionDecline(reason: string): void {
  const win = window as unknown as DeclineWindow
  if (!win.__vmdeE2EReadiness) return
  win.__vmdeBlockActionDeclines ??= {}
  const counts = win.__vmdeBlockActionDeclines
  counts[reason] = (counts[reason] ?? 0) + 1
}
