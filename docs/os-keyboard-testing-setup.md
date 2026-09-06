# Project Owner runbook: enable OS-level keyboard testing

Status: proposed setup instructions; preparing this document did **not** apply or verify them.
The recorded diagnostics come from Task 563. The Emoji picker issue and its OS-keyboard
acceptance belong to Task 566. Consult the local operator queue for current execution status.

The required route is X11 server-level input through XTEST into a focused VS Code window.
XTEST synthesizes events at the OS display-server layer; it is distinct from DOM-dispatched
KeyboardEvents or browser-protocol key calls, and does not claim physical keyboard hardware
was operated. [X.Org XTEST reference](https://www.x.org/releases/X11R7.5/doc/man/man3/XTestFakeKeyEvent.3.html)

1. **Understand the observed failure before changing the environment.**

   `libX11.so.6` and `libXtst.so.6` were present and loaded. The attempted Electron handle was
   `1`, which X11 rejected with `BadWindow`; another focus query returned `PointerRoot`.
   Neither observation proves input reached a VS Code client. An environment-only
   `ELECTRON_OZONE_PLATFORM_HINT=x11` attempt did not fix this. The exact cause remains
   unconfirmed: wrong BrowserWindow selection, a different display, or a non-X11 backend
   must be distinguished. A literal `--ozone-platform=x11` launch was not successfully
   implemented/tested in the current fixture.

   Do not conclude that missing `xdotool` alone means XTEST is unavailable, and do not reuse
   handle `1` as a client window. Electron's current documentation removes the old environment
   hint and prescribes the command-line platform flag.
   [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#removed-electron_ozone_platform_hint-environment-variable)

2. **Install owner-managed X11 tooling, if missing (Ubuntu/WSL example).**

   Run this yourself in the Linux environment hosting the tests:

   ```bash
   sudo apt-get update
   sudo apt-get install xvfb openbox xdotool x11-utils libx11-6 libxtst6
   ```

   Xvfb supplies the isolated display, Openbox supplies window activation/focus management,
   and xdotool supplies the input client. The two libraries were already available in this
   session; installation is a prerequisite check, not the diagnosed fix.
   [xdotool project and installation](https://github.com/jordansissel/xdotool)

3. **Add an explicit X11 launch option through the repository-owned harness patch.**

   The installed `vscode-test-playwright` fixture assembles `_electron.launch({ args: [...] })`
   itself and exposes no public extra-launch-args option in its current types. Setting an
   arbitrary variable in `playwright.config.ts` therefore does not add a Chromium flag.

   In a later implementation session, extend
   [scripts/patch-vscode-test-playwright.mjs](../scripts/patch-vscode-test-playwright.mjs)
   with an anchored, idempotent optional insertion into the Electron launch argument array:

   ```js
   ...(process.env.VMDE_XTEST === '1' ? ['--ozone-platform=x11'] : []),
   ```

   **`VMDE_XTEST` is a proposed switch, not an implemented feature today.** Add this through
   the tracked patch source or a project-owned fixture; do not make an undocumented manual
   change in `node_modules`. Preserve the existing environment cleanup, injected server,
   cache directories and teardown. Use a separate idempotency marker: the current patch's
   old marker skips already-patched files, so merely appending another edit to its existing
   list would not update an already-installed fixture.

   Check both clean and previously patched fixture inputs with a focused patch test. Apply
   the patch using `node scripts/patch-vscode-test-playwright.mjs`, then inspect the actual
   launch argument array. The launched app must receive the literal flag; the old environment
   hint is insufficient. Keep the current VS Code version pin unless separately investigating
   that pin's documented teardown issue.
   [Electron X11 platform guidance](https://www.electronjs.org/docs/latest/api/browser-window/)

4. **Keep the display, window manager, test runner, and input client in one session.**

   Build from the repository root first:

   ```bash
   node build.mjs
   ```

   After implementing step 3, an owner-run shell can be started as follows:

   ```bash
   env -u ELECTRON_RUN_AS_NODE -u WAYLAND_DISPLAY \
     XDG_SESSION_TYPE=x11 VMDE_XTEST=1 \
     xvfb-run -a -s '-screen 0 1600x1000x24 +extension XTEST' bash
   ```

   Inside that shell:

   ```bash
   openbox > /tmp/vmde-xtest-openbox.log 2>&1 &
   VMDE_WM_PID=$!
   trap 'kill "$VMDE_WM_PID" 2>/dev/null || true' EXIT
   xdpyinfo -queryExtensions | rg XTEST
   ```

   Run the focused spec from this same shell after adding its OS-input helper:

   ```bash
   npm --prefix test/vscode-e2e test -- YOUR_OS_KEYBOARD_SPEC.spec.ts --workers=1 --retries=0
   ```

   Replace the illustrative spec name with the actual focused spec. Keep input commands
   inside that test process/fixture so they inherit its `DISPLAY` and authentication.
   Do not launch another independent `xvfb-run` for keyboard injection. Retain the repository's
   one-real-VS-Code-run lock and one-worker rule. If the managed sandbox prevents local X
   sockets or Electron launch, authorize the same scoped run outside that sandbox; do not
   modify `/tmp/.X11-unix` permissions or switch silently to the user's ambient display.

5. **Identify the exact workbench window and verify it is an X11 client.**

   Select the BrowserWindow corresponding to the actual Playwright workbench page, rather
   than assuming `BrowserWindow.getAllWindows()[0]` is the correct window:

   ```ts
   const nativeWindow = await electronApp.browserWindow(workbox)
   const windowInfo = await nativeWindow.evaluate((window) => ({
     title: window.getTitle(),
     visible: window.isVisible(),
     handleHex: window.getNativeWindowHandle().toString('hex'),
   }))
   ```

   Record the handle bytes and decode according to the platform's native type. Then validate
   against X11; a nonzero value or visible webview screenshot alone is insufficient.
   [Playwright BrowserWindow mapping](https://playwright.dev/docs/api/class-electronapplication#electron-application-browser-window)

   From the same display, use `xwininfo -root -tree` to locate the workbench client and match
   its title/PID to the test instance. For a verified ID, set `VMDE_XID` to that ID and run:

   ```bash
   xwininfo -id "$VMDE_XID"
   xdotool getwindowpid "$VMDE_XID"
   xdotool windowactivate --sync "$VMDE_XID"
   xdotool getactivewindow
   xdotool getwindowfocus
   ```

   The active/focused window must resolve to the verified test window or an appropriate child.
   If there is no corresponding client in the X tree, stop the keyboard check and inspect
   actual launch flags, display and window selection. Do not label this an editor defect.

6. **Deliver OS input and assert a real VMDE outcome.**

   Use a disposable Markdown fixture. Click inside its VMDE editor to establish webview focus,
   then open a non-Emoji toolbar menu by pointer. Send Escape through the focused X11 client:

   ```bash
   xdotool key --clearmodifiers Escape
   ```

   Verify the menu closes and focus returns according to the existing toolbar convention.
   A second check can type into the focused disposable editor and exercise undo:

   ```bash
   xdotool type --clearmodifiers --delay 20 'xtest_probe'
   xdotool key --clearmodifiers ctrl+z
   ```

   Assert the VS Code TextDocument before/after, not merely an input-event log. Do not pass
   `--window` to these key/type commands: xdotool documents a different send-event route for
   explicit target windows; activate the correct window first and use its focused-input path.
   Also do not treat a DOM event's `isTrusted` flag as proof that this OS route was used.
   [xdotool input and event-sending reference](https://raw.githubusercontent.com/jordansissel/xdotool/master/xdotool.pod)

7. **Enable later task acceptance only after one focused smoke passes.**

   Record actual VS Code/Electron versions, the literal X11 launch flag, display/XTEST
   availability, verified client XID and focus, OS command/key sequence, real UI/host outcome,
   final exit status and any retries. Keep this a small focused check; no full-suite rerun is
   needed merely to establish input routing. Then reuse the proven helper for later keyboard
   cases, including Task 566's transferred Emoji picker behavior.

   Record dependency audits as intentionally omitted and sizes as reporting-only, as already
   directed in the checkout-local `LOCAL_AGENT_TASK.md` operator instructions. Do not change budget ceilings
   as part of this setup. If the smoke cannot establish a valid focused client, report keyboard
   verification as unavailable with the exact failed precondition; do not substitute browser
   protocol or DOM keys and claim OS coverage.

These instructions were checked against current primary documentation and the local fixture
source. No package installation, harness patch, X server launch, or new keyboard test was run
while preparing this runbook.
