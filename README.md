<p align="center">
  <img src="assets/logo.svg" alt="" width="72" height="72">
</p>

<h1 align="center">troy</h1>

<p align="center">A browser an agent can actually read and drive.</p>

<p align="center">
  <a href="https://anishfyi.com/troy/">anishfyi.com/troy</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/velofy/troy/releases/latest">download</a>
  &nbsp;·&nbsp;
  <a href="docs/PRD.md">PRD</a>
  &nbsp;·&nbsp;
  <a href="docs/DESIGN.md">design</a>
  &nbsp;·&nbsp;
  MIT
</p>

---

<h3 align="center">Sponsors</h3>

<p align="center">
  <a href="https://nodemaven.com/?a_aid=veronika&utm_source=veronika&utm_medium=affiliate&utm_campaign=troy_readme_sep2026&utm_term=github" title="NodeMaven - residential and mobile proxies">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/velofy/troy/main/assets/sponsors/nodemaven-dark.svg">
      <img src="https://raw.githubusercontent.com/velofy/troy/main/assets/sponsors/nodemaven-light.svg" alt="NodeMaven" height="40">
    </picture>
  </a>
</p>

---

Troy is a real Chromium browser with its own chrome, built so that an agent can
attach to the window you are already signed into and work the page with you.

Most browser automation starts a fresh, empty browser. The pages worth
automating are behind a login, so the fresh browser is the wrong browser. Troy
inverts that: you browse in it, and an agent joins the session you already have.

> **Status.** The browser is real, installable, and tested on macOS, Windows and
> Linux. The live reading pipeline now settles the page, extracts visible DOM
> structure, finds regions the DOM cannot explain, and fuses the result. A real
> OCR backend is not wired in yet, so pixel-only regions are reported honestly
> as untranscribed instead of being silently omitted. See
> [What is not built](#what-is-not-built).

## Install

```sh
brew install --cask anishfyi/tap/troy
```

Or take a file directly:

| | |
|---|---|
| macOS, Apple silicon | [Troy-mac-arm64.dmg](https://github.com/velofy/troy/releases/latest/download/Troy-mac-arm64.dmg) |
| macOS, Intel | [Troy-mac-x64.dmg](https://github.com/velofy/troy/releases/latest/download/Troy-mac-x64.dmg) |
| Windows, installer | [Troy-windows-setup-x64.exe](https://github.com/velofy/troy/releases/latest/download/Troy-windows-setup-x64.exe) |
| Windows, portable | [Troy-windows-portable-x64.exe](https://github.com/velofy/troy/releases/latest/download/Troy-windows-portable-x64.exe) |

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

An agent launch must not take your screen. Any launch that asks for the port
comes up **inactive** — the window appears, but the app you were working in
keeps focus. `--hidden` goes further and shows nothing until you click the
dock icon; `--foreground` opts back into normal behaviour. `TROY_LAUNCH` takes
the same values for launches that cannot pass argv.

### The agent socket and the `troy` CLI

Every agent launch (or `--agent` alone, without a debugging port) opens the
agent socket: a token-gated loopback endpoint that speaks the same tool
contract the in-app agent uses — reads, ref-based actions, tab management and
page memory, with the same refusals. `bin/troy.mjs` is the CLI on top of it:

```sh
troy status
troy open https://example.com          # background tab; prints its id
troy find "add to cart" --tab 2        # matching elements, as refs
troy fill e4 "blue anorak" --tab 2
troy act '[{"op":"click","ref":"e4"}]' --tab 2
troy read --tab 2 --since              # only what changed since last read
troy recall "checkout button"          # what this browser already learned
```

Element refs survive actions inside a document and die at navigation, which
is the honest contract. `troy read --since` returns only what moved. `troy
recall` answers from the page-memory graph (settings → "Remember what the
agent learns", off by default) instead of making you re-read.

Troy then writes where it is, so nothing has to be copied between terminals.
The endpoint file lives under Troy's application-data directory:

```sh
# macOS
cat "$HOME/Library/Application Support/Troy/agent-endpoint.json"
# Linux
cat "${XDG_CONFIG_HOME:-$HOME/.config}/Troy/agent-endpoint.json"
# Windows PowerShell
Get-Content "$env:APPDATA\Troy\agent-endpoint.json"
# { "port": 9333, "agentPort": 58893, "agentToken": "...", ... }
```

Attach with anything that speaks CDP for raw control — the agent socket for
the tool contract. This gives you the tabs already open, not a new browser:

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

The live tab already runs the settle, extract, cover, transcribe, and fuse
pipeline. The remaining reading and action gaps are narrower:

- Apple Vision on macOS and Tesseract elsewhere behind the existing OCR
  interface. Until then, pixel-only regions are marked untranscribed.
- A packaged `troy read <url>` executable. Developers can already run
  `node scripts/read.mjs [--url <url>] [--json]` from a checkout.
- The verified action layer ported from `scripts/*.mjs` to TypeScript.

[`docs/DESIGN.md` §9](docs/DESIGN.md) describes the pipeline architecture, and
[the original spec](docs/superpowers/specs/2026-08-07-troy-design.md) records
its full intended shape. Sections that still call the whole pipeline planned
are historical and should not override the running code in `src/read/` and
`src/browser/readPort.js`.

Also deliberately absent for now: omnibox suggestions, bookmarks, find-in-page,
context menus, tab reordering, and any browser engine other than Chromium.

**Remember history** on the new tab page is real: turn it on and visits are
recorded to `history.json` in the profile, newest first, capped at 500.
Turn it off and the file is deleted. It feeds the command palette's results
and nothing else.

## Documents

- [**PRD**](docs/PRD.md). The problem, who it is for, requirements with their
  real status, success measures, milestones, risks.
- [**Design**](docs/DESIGN.md). Process model, components, the decisions and the
  alternatives they beat, invariants and the tests that guard them, the security
  and performance models.

## Development

```sh
npm install
npm run browser     # open the window
npm test            # 127 tests, 36 of them driving a real Electron process
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
