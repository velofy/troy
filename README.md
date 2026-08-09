<p align="center">
  <img src="assets/logo.svg" alt="" width="72" height="72">
</p>

<h1 align="center">troy</h1>

<p align="center">A browser an agent can actually read and drive.</p>

<p align="center">
  <a href="https://anishfyi.com/troy/">anishfyi.com/troy</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/anishfyi/troy/releases/latest">download</a>
  &nbsp;·&nbsp;
  <a href="docs/superpowers/specs/2026-08-07-troy-design.md">the design</a>
  &nbsp;·&nbsp;
  MIT
</p>

---

Troy is a real Chromium browser with its own chrome, built so that an agent can
attach to the window you are already signed into and work the page with you.

Most browser automation starts a fresh, empty browser. The pages worth
automating are behind a login, so the fresh browser is the wrong browser. Troy
inverts that: you browse in it, and an agent joins the session you already have.

> **Status.** The browser is real, installable, and tested on macOS, Windows and
> Linux. The reading pipeline this project is named for, which fuses DOM
> structure with OCR of the regions the DOM cannot explain, is **not built yet**.
> Until it lands the agent panel reads a page from the DOM alone. See
> [What is not built](#what-is-not-built).

## Install

```sh
brew install --cask anishfyi/tap/troy
```

Or take a file directly:

| | |
|---|---|
| macOS, Apple silicon | [Troy-mac-arm64.dmg](https://github.com/anishfyi/troy/releases/latest/download/Troy-mac-arm64.dmg) |
| macOS, Intel | [Troy-mac-x64.dmg](https://github.com/anishfyi/troy/releases/latest/download/Troy-mac-x64.dmg) |
| Windows, installer | [Troy-windows-setup-x64.exe](https://github.com/anishfyi/troy/releases/latest/download/Troy-windows-setup-x64.exe) |
| Windows, portable | [Troy-windows-portable-x64.exe](https://github.com/anishfyi/troy/releases/latest/download/Troy-windows-portable-x64.exe) |

Troy is ad-hoc signed but not notarised, and there are no plans to be. Downloaded
by hand that costs you one gesture on first launch: Control-click then Open on
macOS, or More info then Run anyway on Windows. The Homebrew cask clears the
quarantine flag for you, so installing that way costs nothing. Ad-hoc signing is
not cosmetic: without it, Apple silicon refuses to launch the app at all and
reports it as damaged.

## Driving it from an agent

The debugging port is closed unless you ask for it, because an open one is
unrestricted control of every tab you are signed into.

```sh
open -a Troy --args --cdp-port=9333     # or: npm run browser -- --cdp-port=9333
```

Troy then writes where it is, so nothing has to be copied between terminals:

```sh
cat "$HOME/Library/Application Support/Troy/agent-endpoint.json"
# { "port": 9333, "httpEndpoint": "http://127.0.0.1:9333", ... }
```

Attach with anything that speaks CDP. This gives you the tabs already open, not
a new browser:

```js
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const [context] = browser.contexts()
const page = context.pages().find((p) => p.url().startsWith('http'))

await page.goto('http://localhost:3000/checkout')
await page.getByRole('button', { name: 'Continue' }).click()

await browser.close()   // detaches; it does not close the user's browser
```

For Claude Code there is a skill in [`skills/troy`](skills/troy/SKILL.md)
covering attach, console and network capture, and the rules about not closing
tabs that are not yours.

## What it does today

**Refusals live in code.** `javascript:`, `data:`, `blob:`, `filesystem:` and the
browser-internal schemes are refused by the address bar and by the new tab search
box, from one copy of the rules. `javascript://x/%0aalert(document.cookie)` is the
disguise a "does it look like a URL" check misses, and it is the reason this is a
tested module rather than a habit. Pages cannot open uncontrolled popups;
`window.open` becomes a tab. Camera, microphone, geolocation and notification
requests are denied.

**Failures are pages, not blankness.** A load that fails shows a real page that
keeps the address you asked for, and reloading retries that address rather than
the error page. A failure arriving after you have already navigated somewhere
else is dropped instead of overwriting the page you asked for.

**It stays open.** An uncaught exception in Electron's main process normally
takes the whole browser with it, every tab and every signed-in session, and
reports itself to macOS only as `EXC_BREAKPOINT`. Troy guards every read of a
tab and keeps a net under itself, recording what happened to `troy-errors.log`.

**No history unless you ask.** Nothing is recorded by default. The new tab page
has a settings button that turns it on, and the shortcuts grid is filled in by
you rather than by watching where you go.

**Trackers blocked, honestly.** Third-party analytics and ad beacons are
cancelled, and tracking parameters (`utm_*`, `gclid`, `fbclid`, and friends) are
stripped from an address before the request is made. Search goes to Google and
nothing is sent as you type, because Troy asks no suggestion service anything.
None of that changes the fact that a Google search is seen by Google, and the
settings panel says so rather than implying otherwise.

**Extensions.** Unpacked Chrome extensions load from `<profile>/extensions/` at
startup. No store, nothing fetched remotely, `allowFileAccess` off.

**It is fast, and that is enforced.** `npm run stress` opens sixteen tabs each
animating and streaming requests, then switches tabs, types and reloads while
counting frames in the chrome. It fails the run below 60fps, if the 95th
percentile frame misses budget, or if any frame stalls past 100ms.

## What is not built

The read pipeline, which is the thing the name is about:

- **settle, extract, cover, ocr, fuse.** Take structure from the DOM and pixels
  from OCR, deciding by itself which regions need which, so a plain article
  costs zero OCR and a canvas dashboard gets its numbers read
- `troy read <url>` as a CLI, markdown or `--json`
- Apple Vision on macOS, Tesseract elsewhere, behind one interface
- the verified action layer ported from `scripts/*.mjs` to TypeScript

The [design document](docs/superpowers/specs/2026-08-07-troy-design.md) describes
all of it in detail. Treat it as intent, not as documentation of behaviour that
exists.

Also deliberately absent for now: omnibox suggestions, bookmarks, find-in-page,
context menus, tab reordering, and any browser engine other than Chromium.

## Development

```sh
npm install
npm run browser     # open the window
npm test            # 127 tests, 33 of them driving a real Electron process
npm run lint
npm run typecheck   # also type-checks the JavaScript, via checkJs
npm run smoke       # start the packaged build and prove it opens
npm run stress      # the 60fps gate
npm run dist:mac    # or dist:win, output in release/
```

CI runs the suite on macOS, Windows and Linux. That matrix is not ceremony: the
Windows leg caught `'file://' + path.join()` producing backslash URLs, which made
a new tab leak its own file path into the address bar on that platform only.

The tests drive the real application rather than mocking it, and assert through
two surfaces only: what a person can see in the chrome page, and a snapshot hook
in the main process for the things a person cannot see directly, like which view
is visible and where it sits.

`release/` is a build directory, not an install. Running the app from there means
running whatever was last built, which is exactly how a months-old binary ends up
in Spotlight; `npm run dist:*` clears it first.

## Name

Troy, for the walls and the long patient siege, not for the horse. That reading
points at malware, which is the wrong association for something whose whole job
is to be honest about what a page contains. The mark is an aperture between two
crop marks: the thing that sees the page.

## License

MIT
