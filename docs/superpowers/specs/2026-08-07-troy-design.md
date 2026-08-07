# Troy v1 design

Date: 2026-08-07, revised 2026-08-08
Status: approved by Anish (interactive Q&A, this session)
Repo: `anishfyi/troy` (public, MIT). Single repo: the private `troy-browser`
was absorbed on 2026-08-08 and is retired.
Package: `@anishfyi/troy`, command `troy`

## Revision 2, 2026-08-08

Troy is no longer only a CLI. It ships as **a browser you open**, a desktop app
with its own tabs, omnibox and back/forward, plus an agent panel, with the read
and act engine wired into the window you are looking at. The CLI remains, over
the same engine.

What this changes, in one idea: **Electron's `webContents.debugger` is CDP**, the
same protocol Playwright speaks. So the engine is written once against a thin
`Cdp` port, and both hosts satisfy it: Playwright drives headless and remote
Chromium for the CLI, Electron drives the tab in the app window. Nothing in
`read/`, `ocr/` or `act/` knows which host it is running under. Sections 3 and 4
below are unchanged by this revision; sections 8, 9 and 10 are new.

## What Troy is

A headless browser an agent can actually read. Existing browser automation gives
an agent two bad options: dump raw HTML and drown, or screenshot and lose every
link, selector and form field. Troy returns one clean document per page by taking
structure from the DOM and pixels from OCR, and it knows which parts of the page
need which.

It also drives: every action is verified after the fact, and refusals live in
code rather than in a prompt.

Decisions locked during brainstorming:

1. OCR: Apple Vision on macOS, Tesseract elsewhere, behind one interface. A
   `--deep` flag escalates to a vision LLM for comprehension rather than
   characters.
2. Read strategy: fuse DOM and OCR, detecting automatically which regions the
   DOM cannot explain. The caller never picks a mode.
3. Scope: reading is the headline, the existing action layer stays.
4. Headless by default; the persistent logged-in profile is opt-in.
5. TypeScript plus Playwright, shipped on npm, plus an Electron desktop app
   (revision 2).
6. Logo: an abstract lens/aperture mark, flat, single accent.
7. Public OSS under MIT.

`anishfyi/troy-browser` was absorbed into this repo on 2026-08-08: its verified
action layer, targets, fixtures, test suite and Claude Code skill now live here.
One repo from that point on.

## 1. Naming

npm's `troy` is squatted by an abandoned 2015 package (`0.0.1`, "a function
package"), so the package is `@anishfyi/troy`. Package name and binary name are
independent: the installed command is `troy` either way. An npm dispute for the
dead name is a later, optional errand.

## 2. Shape

```
troy/
  src/
    browser/     session lifecycle: headless launch, profile attach, CDP connect
    read/        the read pipeline: extract, cover, ocr, fuse, render
    ocr/         engine interface + apple vision, tesseract, vision-llm backends
    act/         verified fill, click, goto, state
    cli/         the troy binary
  native/        swift helper that reaches Apple Vision
  plugin/        Claude Code plugin manifest + skill
  targets/       per-site config (ycombinator, generic), ported as-is
  test/
    fixtures/    local pages covering each hard read case
  assets/        logo svg, favicon, social card
```

Commands:

- `troy read <url>` : the headline. Markdown by default, `--json` for structure.
- `troy launch` : open the persistent logged-in profile.
- `troy goto|fill|click|state` : the verified action layer.
- `troy session ls|rm` : manage persistent profiles.
- `troy plugin install` : symlink the Claude Code skill.

## 3. Sessions

One `Session` interface, three ways to obtain one:

- **Headless (default).** Playwright launches its own bundled Chromium. Zero
  setup: `troy read <url>` works on a machine that has only just installed Troy.
- **Persistent profile.** `troy launch` opens a real Chromium on a dedicated
  profile under `~/.troy/profiles/<name>`, deliberately separate from the daily
  browser. Log in once; the session persists. Any command targets it with
  `--session <name>`.
- **Attach.** Connect to an already-running Chromium over CDP, for a browser
  Troy did not start.

Everything downstream of `Session` is mode-agnostic, so reading and acting behave
identically headless or attached.

## 4. The read pipeline

Five stages. This is the differentiator and the bulk of the work.

### 4.1 Settle

Navigate, then wait for network idle, web fonts loaded, and no layout shift for a
short quiet period. A page read mid-render is the most common source of garbage
output, so settling is explicit rather than a fixed sleep.

### 4.2 Extract

Walk the accessibility tree and the DOM together to produce `DomBlock`s:

```ts
type DomBlock = {
  text: string
  role: string          // heading, link, button, textbox, paragraph, ...
  box: Box              // viewport coordinates
  selector: string      // stable selector for the action layer
  href?: string
  field?: FieldInfo     // name, value, maxlength, answered, for form controls
  visible: boolean      // painted, non-zero size, not clipped or transparent
}
```

Invisible text (`display:none`, zero-size, `visibility:hidden`, fully
transparent, clipped out of view) is extracted but marked `visible: false` and
excluded from the rendered document. Hidden text is a known trick for poisoning
scrapers, and reporting it as page content would be a correctness bug.

### 4.3 Cover

Screenshot the full page, then decide which painted regions the DOM does not
explain. A region is a **gap** when it is painted, of meaningful size, and either:

- a `canvas`, `img`, `video`, or `svg` carrying no accessible text,
- an embedded PDF or object,
- a cross-origin iframe whose content is unreachable,
- or an element with substantial painted area whose computed text is empty, and
  whose crop has high edge density (a cheap text-likeness signal that avoids
  OCRing flat backgrounds and photographs).

Gaps are merged when they overlap and dropped when smaller than a floor, so a
page of ordinary DOM text produces zero gaps and zero OCR cost.

### 4.4 OCR

Crop each gap from the screenshot and OCR it through the engine interface:

```ts
interface OcrEngine {
  name: string
  available(): Promise<boolean>
  recognize(png: Buffer): Promise<OcrLine[]>   // text + box + confidence
}
```

Backends, selected in order of availability:

- **AppleVision** (macOS): a small bundled Swift helper over the Vision
  framework. Local, free, and materially better than Tesseract on the small
  antialiased text the web is made of.
- **Tesseract** (everywhere): via the `tesseract` binary, checked for at runtime
  with a clear install hint when missing.
- **VisionLlm** (`--deep`, opt-in): sends the crop to a vision model for
  comprehension of charts, tables and layout rather than characters. Requires an
  API key; never used unless asked for.

OCR boxes are translated from crop coordinates back into page coordinates so
they can be fused and later acted upon.

### 4.5 Fuse and render

Merge `DomBlock`s and `OcrLine`s into one ordered document. Order is reading
order: grouped into columns by x-overlap, then top-to-bottom within a column.
Every line keeps its box and its source.

Two renderers over the same structure:

- **Markdown (default).** Headings from roles and relative font size, links kept
  as `[text](href)`, form fields annotated with their selector and current value,
  OCR'd regions fenced and labelled so the agent knows the text came from pixels
  and is not selector-addressable.
- **JSON (`--json`).** The block list verbatim: text, box, source, role,
  selector. This is what an agent uses when it intends to act on what it read.

A footer line reports what happened: how many regions were OCR'd, which engine
ran, and the elapsed time. Silent OCR would hide both cost and uncertainty.

## 5. Action layer

Ported from the existing `.mjs` scripts to TypeScript, behavior unchanged:
verified fill (write, blur, read back, fail on mismatch), container-scoped click
that refuses ambiguous or unscoped repeated matches, state snapshot/diff/expect
covering custom-control state as well as native `checked`, and allowlisted
navigation that re-checks the host after redirects. Refusals stay in code:
submit controls, password fields, and over-`maxlength` values are rejected by the
library, not by a prompt.

Reading makes acting better: a block's `selector` comes straight from the same
extraction pass, so `troy read --json` and `troy click` speak about the same page
in the same terms.

## 6. Logo

An abstract lens/aperture over a page edge: geometric, flat, one accent color, no
gradients. Delivered as SVG plus a 16px-legible favicon, a README header, and a
social card. Deliberately not a Trojan horse: "trojan" reads as malware, which is
the wrong association for a tool that drives browsers.

## 7. Testing

Fixture pages served locally, one per hard case: plain DOM, canvas-rendered text,
image-with-text, embedded PDF, shadow DOM, cross-origin iframe, and a page whose
DOM text is visually hidden (which must not appear in the output). Golden-file
tests over the markdown render catch pipeline regressions. Each OCR backend is
tested against fixtures with known text, skipping cleanly when that engine is
unavailable on the host. The existing 11 action tests are ported.

CI runs on ubuntu and macos: build, lint, typecheck, test. macOS is where the
Apple Vision path is exercised; ubuntu proves the Tesseract fallback.

## 8. The browser (desktop app)

An Electron app that opens like Chrome and is built for the thing Chrome is bad
at: being driven and read by an agent.

**Window.** A tab strip, an omnibox that accepts a URL or a search, back /
forward / reload, and an **agent panel** down the right side. The page renders in
a `WebContentsView`, so it is Chromium and pages behave exactly as they do in
Chrome.

**Agent panel.** Not a chat box bolted on. It shows what Troy sees and does to
the current tab, live: the fused document with each line tagged `dom` or `ocr`,
which regions were covered and why, which engine ran, and a running log of
actions with their verification result. Clicking a line in the panel highlights
its box in the page. This makes the thing Troy is otherwise asking you to trust
directly visible, which is the whole argument for the product.

**One engine, two hosts.** `Cdp` is a narrow port: send a CDP command, subscribe
to events, take a screenshot. `PlaywrightCdp` backs the CLI. `ElectronCdp` wraps
`webContents.debugger` and backs the app. `read/`, `ocr/` and `act/` depend only
on `Cdp`, so a fix to the cover heuristic improves the CLI and the app at once
and cannot drift between them.

**Human and agent share the tab.** The agent works the same tab you are looking
at, so you watch it happen and can take over mid-flow. Refusals still live in
code: the agent cannot press submit in the app either.

## 9. The agent bridge

The app listens on a local port, loopback only, so an agent connects to the
browser you already have open and logged in.

- **Transport.** WebSocket on `127.0.0.1`, port written to
  `~/.troy/bridge.json` along with a per-launch token. Loopback binding plus a
  token, because a browser holding live logins must not be reachable from the
  network or from a random page in another tab.
- **Surface.** `read`, `goto`, `fill`, `click`, `state`, `tabs`, `screenshot`.
  The same verified semantics as the CLI, because it is the same code.
- **Consent.** Any mutating call against a tab the user did not hand over
  requires an explicit grant, shown in the agent panel and remembered per origin
  for the session. Reading is free; changing the page is not.
- **MCP is out of scope** (standing rule). The bridge is a plain WebSocket an
  agent or a small adapter can speak.

## 10. Fixture suite and scoring

The loop needs a number, or "better" is a matter of opinion. Twelve fixture pages
served locally, each a hard case: plain article, canvas dashboard, image-with-
text, embedded PDF, shadow DOM, cross-origin iframe, hidden-text trap, infinite
scroll, late-hydrating SPA, data table, multi-column layout, and a form.

Every run scores four numbers, checked into the repo so regressions are visible
in a diff:

- **Recovered**: expected lines present in the output (higher is better).
- **False positives**: lines output that are not really on the page, the metric
  that punishes OCR guessing (zero is the target).
- **Hidden-text leaks**: text present in the DOM but not painted that reached the
  output (must be zero, always).
- **Cost**: milliseconds per page and regions OCR'd (lower is better; a plain
  article must stay at zero regions).

## 11. Milestones

Ordered so the engine is worth wrapping before the shell wraps it. Every
milestone ends with an independent adversarial review, fixes, and a re-review
before the next one starts.

- **M1** TypeScript scaffold, the `Cdp` port with its Playwright backing, the
  fixture server and the scoring harness, CI green on ubuntu and macos.
- **M2** Extract plus markdown render. `troy read` works on DOM-only pages and
  scores on the fixture suite.
- **M3** OCR engine interface, Apple Vision helper, Tesseract backend.
- **M4** Cover plus fuse. The differentiator lands; hidden-text leaks at zero and
  a plain article still OCRs nothing.
- **M5** Action layer ported to TypeScript over the `Cdp` port, verification and
  in-code refusals intact.
- **M6** The Electron shell: tabs, omnibox, navigation, `ElectronCdp`, and the
  agent panel rendering the fused document live.
- **M7** The agent bridge: loopback WebSocket, token, per-origin consent.
- **M8** `--deep`, packaging (`.dmg` and `.exe`), docs, plugin, npm publish.

## 12. Out of scope for v1

File upload, session recording and replay, multi-step flow resume, more site
targets beyond `ycombinator` and `generic`, and any browser other than Chromium.
All are v1.1 candidates; none are built now.

## Success criteria

- `npx @anishfyi/troy read <url>` returns readable markdown on a clean machine
  with no setup beyond the install.
- A canvas-rendered page and an image-with-text page both return their text,
  attributed to OCR, while a plain DOM page triggers zero OCR.
- Visually hidden DOM text never appears in the rendered output.
- `troy read --json` yields selectors that `troy click` and `troy fill` accept.
- A logged-in page reads correctly through `troy launch` plus `--session`.
- CI green on ubuntu and macos; the ported action tests all pass.
