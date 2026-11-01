// Task 643: the real webview entry (boot/main) for the Preview-mode specs. The spec stubs
// acquireVsCodeApi so `ready` is answered with an `init` and records every message the webview
// posts, so a Preview-first open runs the same path as in VS Code.
import '../src/boot/main'
