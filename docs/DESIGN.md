# Troy: design

**Started** 5 August 2026 · **Revised** 9 August 2026 · **Status** browser
shipped, read pipeline in build

This describes how Troy is built and why. Where something is not built yet it is
marked **planned**, and the distinction is kept sharp on purpose: a design
document that reads as documentation of behaviour is how people end up debugging
code that never existed.

Companion documents: [PRD](PRD.md) for what and why,
[the original spec](superpowers/specs/2026-08-07-troy-design.md) for the reading
pipeline in full.

---

## 1. Shape

```
┌─ Electron main process ────────────────────────────────────────┐
│                                                                │
│  main.js          tabs, navigation, menu, lifecycle            │
│  omnibox.js       what you typed becomes an instruction        │
│  tracking.js      cancel trackers, strip tracking parameters   │
│  settings.js      what Troy remembers, and what it will not    │
│  shortcuts.js     the tiles on the new tab page                │
│  extensions.js    unpacked extensions from the profile         │
│  resilience.js    the net that keeps the browser open          │
│  endpoint.js      where an agent can find this browser         │
│                                                                │
├────────────────────┬───────────────────────────────────────────┤
│  window webContents │  WebContentsView, one per tab            │
│  (Troy's chrome)    │  (the actual web page)                   │
│                     │                                          │
│  preload.cjs        │  tab-preload.cjs                         │
│  renderer/chrome.*  │  renderer/newtab.*, renderer/error.*     │
│                     │                                          │
│  y: 0 to 88px       │  y: 88px to bottom                       │
└────────────────────┴───────────────────────────────────────────┘
                              │
                              │ CDP, when --cdp-port is given
                              ▼
                    an agent, in another process
```

The chrome is an ordinary web page in the window's own `webContents`. Each tab is
a `WebContentsView` laid out beneath it. That split is the foundation:

- Page content renders exactly as Chrome renders it, and **cannot repaint or
  script Troy's UI**, because it is a different frame tree in a different
  process.
- Every tab's `webContents.debugger` speaks CDP, which is the same protocol the
  engine already drives through the `Cdp` port. The read pipeline will run
  against the tab you are looking at without modification.

The two surfaces do not share a compositor. That has consequences people get
wrong, and two shipped bugs came from it (§4.1, §4.2).

## 2. Components

### Main process

| File | Owns |
|---|---|
| `main.js` | Tab lifecycle, layout, navigation, menu, IPC, window state |
| `omnibox.js` | `resolveOmnibox(input)`: url, search, external, refused, empty |
| `tracking.js` | `stripTrackingParams`, `shouldBlockRequest`, `installBlocker` |
| `settings.js` | Defaults, read, merge-write. `rememberHistory` defaults false |
| `shortcuts.js` | New tab tiles, capped at 12, http and https only |
| `extensions.js` | Discover and load unpacked extensions, one failure at a time |
| `resilience.js` | `installSafetyNet`, `formatError`, `appendLog` |
| `endpoint.js` | `agent-endpoint.json`, written when the port is open |

Each is a plain module with no Electron import except where it must have one, so
each is unit-testable without launching a browser. That is why 84 of the 127
tests launch nothing at all and finish in milliseconds.

### Renderer surfaces

| File | Runs in | Notes |
|---|---|---|
| `preload.cjs` | chrome | The only bridge. A fixed list of actions, three subscriptions |
| `renderer/chrome.*` | chrome | Tab strip, toolbar, omnibox, agent panel, progress bar |
| `tab-preload.cjs` | every tab | Exposes nothing unless the document is the new tab page |
| `renderer/newtab.*` | a tab | Search, shortcuts, settings |
| `renderer/error.*` | a tab | The failure page |

### Engine

| File | Notes |
|---|---|
| `cdp/types.ts` | The `Cdp` port: send, on, screenshot, evaluate, url, close |
| `cdp/playwright.ts` | `launchHeadless`, `connectOverWs`, `launchPersistent` |

Everything in the read pipeline depends on that narrow port and nothing else, so
the same engine runs headless under Playwright or attached to a live Electron
tab without changing.

## 3. Decisions

Each of these had a plausible alternative. The alternative is stated, because a
decision without its rejected option is just an assertion.

### 3.1 Refusals in the resolver, not at the call site

`resolveOmnibox` returns a tagged result: `url`, `search`, `external`, `refused`,
`empty`. Every entry point (address bar, new tab search box, shortcut tile) goes
through it, so all three refuse the same things from one copy of the rules.

*Alternative:* check the scheme where navigation happens. Rejected because there
are now three call sites and each would drift.

The case that motivates the whole module: `javascript://example.com/%0aalert(1)`
passes a naive "does it look like a URL" test, and pasted into the bar of a
logged-in tab it runs script in that origin. Refused schemes are therefore
checked **before** the generic `scheme://` rule.

### 3.2 The main process is the authority on IPC

`tab-preload.cjs` is attached to every tab, which means it is attached to every
site you visit. It exposes `window.troyNewTab` only when the document looks like
Troy's new tab page. That is tidiness. The guarantee is that **main checks the
calling frame's URL on every one of those channels** and refuses anything else.

*Alternative:* trust the preload's own check. Rejected because a renderer is the
wrong place to make a decision a renderer might be compromised into faking.

### 3.3 A tab is only safe to touch while its renderer exists

Every getter on a destroyed `webContents` throws, and a throw inside an event
handler in the main process ends the browser. So reads go through `alive(tab)`,
and `pruneDeadTabs()` runs before state is assembled.

### 3.4 State updates are coalesced

One navigation fires `did-start-loading`, `did-navigate`, `page-title-updated`,
`page-favicon-updated` and `did-stop-loading` in a burst. `syncChrome()` sets a
flag and sends once per turn of the loop.

### 3.5 The tab strip updates in place

The renderer keeps a `Map` of tab id to element and edits them. Emptying and
rebuilding the strip looked simpler and threw away each favicon `<img>` on every
update, so tabs flickered and refetched their icons while a page loaded.

### 3.6 Glass comes from the window, not from CSS

On macOS the window is created with `vibrancy: 'header'` and a clear background,
and the chrome tints it. There is deliberately **no `backdrop-filter` anywhere**.

*Alternative:* frost the toolbar in CSS. Rejected twice over. It would cost a
full-width GPU blur pass every repaint, and it would buy nothing, because
`backdrop-filter` can only blur what is behind an element within the same
compositing surface. The web page is a separate `WebContentsView`. The chrome
cannot see it to blur it.

### 3.7 Settings are cached in memory

The tracker blocker asks whether it is enabled on every network request. Reading
`settings.json` from disk each time meant a synchronous read per subresource, so
a page pulling two hundred requests did two hundred blocking reads on the main
process and the window stuttered. Nothing else writes the file, so a cache
invalidated on our own writes is exact.

### 3.8 Ad-hoc signing is not optional

Electron's binary arrives linker-signed. Once electron-builder renames it,
rewrites `Info.plist` and adds resources, that signature no longer describes the
bundle: `codesign --verify` reports "code has no resources but signature
indicates they must be present", and Apple silicon refuses to launch it at all.
The user sees "Troy is damaged", and Control-click then Open does **not** help,
because that gesture waives notarisation, not a broken signature.

`scripts/after-pack.cjs` reseals the bundle and verifies the result, failing the
build if it does not.

### 3.9 One native runner per architecture

Packaging an x86_64 app on Apple silicon runs an x86_64 helper, which needs
Rosetta. GitHub retired the Intel macOS runners, so the Intel build cross-builds
on Apple silicon with Rosetta installed first, and its smoke test allows a
generous timeout because first-launch translation of the Electron framework is
slow.

## 4. Invariants

Things that must not regress, each with the test that guards it and, where there
was one, the bug that taught it.

### 4.1 The loading bar must be inside the chrome

`bottom <= 88px`. The bar sat at `top: 88px`, exactly where the page view begins.
It composites above the chrome, so the bar drew correctly and was covered
completely, every single time. The test asserted the CSS class said `on`, which
it always did. **A test that checks a class is not a test that checks
visibility.**

### 4.2 The close icon must be centred *and* big enough to see

Ratio of icon to button `> 0.5`, offset `< 0.5px` on both axes. Centred but tiny
still reads as broken, so both are asserted.

### 4.3 A stale failure must never overwrite a newer page

Type a dead address, then immediately a good one: the refused connection comes
back while the good page is loading. Guarded by `tab.pending`, and regression
tested against a route that fails only after 400ms.

### 4.4 Reload of a failure page retries the address, not the page

Tested against a port that is closed and then opened, so recovery is only
possible if reload went back to the original address.

### 4.5 The browser survives an uncaught main-process error

Three tests throw inside the main process on purpose and assert Troy is still
navigating afterwards.

### 4.6 The agent port is closed unless requested

Tested in both directions: attachable when asked for, refused when not.

### 4.7 The chrome holds 60fps

`npm run stress`. Fails below 60fps median, on a p95 miss, or on any frame past
100ms.

### 4.8 Planned, for the read pipeline

Hidden-text leaks must be **zero** on every fixture. A plain article must produce
**zero** OCR regions. Neither is a metric to trade off.

## 5. Security model

**What Troy defends against.** A visited page reading Troy's internals or
reaching the filesystem; a pasted address executing script in a logged-in origin;
a page opening windows Troy does not control; an extension gaining file access it
did not ask for; a local process quietly driving your session.

**What it does not.** A user who deliberately installs a malicious extension. A
compromised machine. First-party tracking by a site you chose to visit.

| Boundary | Enforcement |
|---|---|
| Page to chrome | Separate `WebContentsView`; `contextIsolation`, `sandbox`, no node integration |
| Page to main | Fixed IPC surface; new tab channels gated on the calling frame's URL |
| Address bar to origin | Scheme refusals in `omnibox.js`, checked before the generic URL rule |
| Page to OS | `setWindowOpenHandler` denies popups; unknown schemes go to `shell.openExternal` |
| Page to devices | Permission handler denies all but fullscreen and sanitized clipboard write |
| Extension to disk | `allowFileAccess: false`, always |
| Agent to browser | Port closed by default, loopback only, opt-in per launch |

## 6. Performance model

The chrome is the surface a person touches, so it is the surface measured. Rules
that keep it at frame rate:

- **Animate transforms and opacity only.** The progress bar scales; the tab
  spinner rotates. Neither triggers layout or paint.
- **No synchronous I/O on the main process during a page load** (§3.7).
- **No per-frame work in the main process.** State is coalesced to one message
  per loop turn (§3.4).
- **Edit the DOM, do not rebuild it** (§3.5).
- **No GPU work that buys nothing** (§3.6).

Measured on a 120Hz Apple silicon machine with 16 busy tabs and continuous
interaction: median frame 8.30ms, p95 9.20ms, worst 9.40ms, zero stalls.

## 7. Testing

**127 tests: 84 pure units, 7 driving real Chromium through the `Cdp` port, and
36 driving a real Electron process** over real sockets.

The battle tests assert through two surfaces and no others: what a person can see
in the chrome page, and a `TROY_TEST` snapshot hook in the main process for
things a person cannot see directly, such as which view is visible and where it
sits. Nothing asserts on internals a user could not eventually notice.

CI runs on macOS, Windows and Linux. That matrix has already earned itself: the
Windows leg caught `'file://' + path.join()` producing backslash URLs, which made
a new tab leak its own file path into the address bar on that platform only.

Test files run **serially**. In parallel, two files launching Electron triggered
the same lazy binary download into the same path and corrupted it, which appeared
as three different failures on three platforms for one cause.

`scripts/smoke-packaged.mjs` starts the packaged build and proves it opens a
window, loads its new tab page from inside the asar and navigates. Those failures
are invisible from the source tree.

## 8. Build and release

`electron-builder`, config in `electron-builder.yml`. Artifact names carry no
version so the site can link to `releases/latest/download/<name>` permanently.

Tagging `v*` builds three artifacts on their own runners, smoke-tests each, and
publishes a release. Distribution is the Homebrew cask at `anishfyi/homebrew-tap`,
which clears the quarantine flag so an un-notarised app installs in one command.

`release/` is a build directory, not an install. It once held a months-old Intel
build that Spotlight indexed, which was then launched by hand for hours in place
of the current version. `npm run dist:*` clears it first.

## 9. The read pipeline (planned)

Five separable stages over the `Cdp` port, each a pure-ish function of the last,
each independently testable against fixtures.

**settle.** Wait for `readyState`, `document.fonts.ready`, and two consecutive
frames with no layout shift. Give up after a timeout and return anyway, because a
page that never settles must still be readable.

**extract.** One evaluation walking the document including open shadow roots,
returning text, role, box, a stable selector, and a visibility verdict.

**visible.** An element counts as painted when it has a non-zero rect, is not
`display:none` or `visibility:hidden`, has non-zero effective opacity, is not
clipped away, and its text colour differs from its effective background. That
last check catches white-on-white, the most common poisoning trick and invisible
to every other test.

**cover.** The differentiator. Find only the painted regions the DOM cannot
explain: a `canvas`, an `img` or `svg` with no accessible text, a cross-origin
iframe, or a substantial painted area with empty computed text and high edge
density. Merge overlaps. A plain article yields nothing here, which is the point.

**fuse.** Drop invisible blocks, group into columns by x-overlap, order
top-to-bottom, merge OCR lines back by geometry. Every line carries its box and
its source, so an agent can act on what it just read.

OCR sits behind one interface: Apple Vision on macOS via a Swift helper compiled
on demand, Tesseract elsewhere, and the caller never picks.

## 10. Known gaps

- **`rememberHistory` does nothing.** The setting is stored, toggled and shown,
  but no module reads it and no history is written. Build the store or hide the
  control.
- **No Intel Mac behavioural coverage.** Packaged and launched under Rosetta,
  not exercised on Intel hardware.
- **Extensions have no UI.** They load; nothing lists them.
- **No auto-update.** Upgrading means Homebrew or a fresh download.
- **`agent:read` is a placeholder.** It returns `innerText`, falling back to
  `textContent` when nothing is laid out, and flags that fallback as `degraded`.
  The real pipeline replaces it and will not need either.
