# Troy: product requirements

**Started** 5 August 2026 · **Revised** 9 August 2026 · **Owner** Anish
· **Status** browser shipped, read pipeline in build · **Licence** MIT

---

## 1. The problem

Point an agent at the web and it gets two bad options.

**Dump the HTML** and it drowns. A modest page is tens of thousands of tokens of
wrappers, inline styles and tracking noise, with the words it wanted buried
somewhere inside.

**Take a screenshot** and it can see the page but has lost every link, every form
field and every selector. It can read but not act.

Both miss the same thing. Plenty of real text is never in the DOM at all: numbers
painted into a `canvas` dashboard, text baked into an image, an embedded PDF, a
cross-origin iframe. The DOM cannot tell you what those say. Only the pixels can.

There is a second problem underneath the first, and it is the one that bites in
practice. **Automation starts a fresh, empty browser, and the pages worth
automating are behind a login.** Every framework hands you a clean profile with
no session, so the agent lands on a sign-in wall and the human has to babysit it
through authentication, or hand over credentials, or give up.

## 2. Who this is for

**The person pairing with a coding agent.** They are already signed into the
staging environment, the admin panel, the dashboard. They want the agent to look
at the thing they are looking at and act on it, without a second browser and a
second login.

**The agent itself**, as a consumer. It needs page content it can reason about
cheaply and selectors it can act on, from the same read, in one document.

**Not** general web users. Troy is not competing with Chrome for daily browsing,
and features exist only where their absence makes the browser unusable for the
first two audiences.

## 3. Goals

1. **An agent can drive the browser the human is already using.** Attach to a
   live, signed-in session rather than starting a clean one.
2. **One clean document per page**, taking structure from the DOM and pixels from
   OCR, deciding automatically which regions need which.
3. **Refusals that hold.** The dangerous operations are refused by code, so no
   amount of clever prompting reaches them.
4. **Honest output.** Never report text a human could not see. Never claim
   privacy the product does not deliver.
5. **Fast enough to live in.** A browser that stutters gets closed.

## 4. Non-goals

- Beating Chrome at general browsing.
- Any engine other than Chromium.
- Cloud sync, accounts, telemetry, or a store.
- Notarisation by Apple. Homebrew carries the cost instead.
- MCP as a transport. CDP is the protocol.

## 5. Principles

**Refusals live in code, not in a prompt.** A rule enforced by instructions is a
suggestion. `javascript:`, `data:`, `blob:` and the browser-internal schemes are
refused by a tested module that every entry point calls.

**Say what is true, including when it is unflattering.** The settings panel says
that blocking third-party trackers does not stop Google seeing a Google search.
The README says the read pipeline is not built. Overselling is a product bug.

**The browser must survive its own mistakes.** One bad handler is not a reason to
lose eleven tabs and a signed-in session.

**Off by default when the default is surveillance.** No history unless asked. No
suggestion requests as you type. No debugging port unless requested.

**Prove it by running it.** Features are accepted when a test drives the real
application, not when the code looks right.

## 6. Requirements

Status: **Shipped** · **In build** · **Planned**

### 6.1 The browser

| | Requirement | Status |
|---|---|---|
| B1 | Real Chromium tabs under Troy's own chrome, so pages render exactly as Chrome renders them and cannot repaint the UI | Shipped |
| B2 | Tab strip with favicons, per-tab loading spinner, roomy tabs that shrink evenly when crowded | Shipped |
| B3 | Omnibox that distinguishes address from search, refusing dangerous schemes | Shipped |
| B4 | Page-level loading indicator, not a spinning reload icon | Shipped |
| B5 | Failure pages that keep the address you asked for and retry it on reload | Shipped |
| B6 | Crash recovery: a dead renderer reports itself; an uncaught main-process error is logged and survived | Shipped |
| B7 | Real application menu with working accelerators while focus is in a page | Shipped |
| B8 | New tab page: search box, shortcuts grid, settings | Shipped |
| B9 | Window size and position remembered | Shipped |
| B10 | Context menus, find in page, reopen closed tab, tab reordering | Planned |
| B11 | Omnibox suggestions from local history and open tabs | Planned |
| B12 | Toolbar surfaces for extensions and an overflow menu | Planned |

### 6.2 The agent bridge

| | Requirement | Status |
|---|---|---|
| A1 | A debugging port an external process can attach to, off unless requested | Shipped |
| A2 | Endpoint discovery, so no port number is copied by hand | Shipped |
| A3 | Detaching leaves the browser and its tabs usable | Shipped |
| A4 | A skill documenting how an agent should behave in someone else's browser | Shipped |
| A5 | The read pipeline available to the live tab, not only to headless | Planned |

### 6.3 Reading

| | Requirement | Status |
|---|---|---|
| R1 | `troy read <url>` returns one document, markdown by default, `--json` to act | In build |
| R2 | DOM extraction with geometry, roles and stable selectors | In build |
| R3 | Cover: identify only the painted regions the DOM cannot explain | In build |
| R4 | OCR those regions and fuse by geometry into reading order | In build |
| R5 | Apple Vision on macOS, Tesseract elsewhere, behind one interface | In build |
| R6 | A plain article costs **zero** OCR calls | In build |
| R7 | Text present in the DOM but not painted never appears in output | In build |
| R8 | Selectors from `read --json` are accepted by the action layer unchanged | In build |

### 6.4 Privacy and safety

| | Requirement | Status |
|---|---|---|
| P1 | No browsing history recorded by default | Shipped |
| P2 | Nothing sent while typing in the address bar | Shipped |
| P3 | Third-party analytics and ad beacons cancelled | Shipped |
| P4 | Tracking parameters stripped before the request is made | Shipped |
| P5 | Camera, microphone, geolocation and notifications denied | Shipped |
| P6 | Popups become tabs; no uncontrolled windows | Shipped |
| P7 | History recorded when the user turns it on | **Not built.** The setting stores and toggles, but nothing reads it. See §9. |
| P8 | A way to clear recorded history | Planned, blocked on P7 |

### 6.5 Distribution

| | Requirement | Status |
|---|---|---|
| D1 | macOS DMG for Apple silicon and Intel | Shipped |
| D2 | Windows installer and portable executable | Shipped |
| D3 | Installable without fighting Gatekeeper | Shipped via Homebrew cask |
| D4 | Unpacked extensions load from the profile | Shipped |
| D5 | Auto-update | Planned |

## 7. Success measures

**The four claims the reading is judged on.** None can be checked until §6.3
lands, and they are the acceptance criteria for it:

1. A plain article page triggers **zero** OCR calls.
2. A canvas page and an image-with-text page both return their text, attributed
   to pixels.
3. Visually hidden DOM text **never** appears in the output.
4. Selectors out of `troy read --json` are accepted by `troy click` and
   `troy fill` without translation.

**The browser is judged on:**

5. The chrome holds **60fps** under sixteen busy tabs with interaction. Enforced
   by `npm run stress`, which fails the run otherwise.
6. Zero unhandled main-process crashes reaching the user.
7. The suite passes on macOS, Windows and Linux before every release.

## 8. Milestones

| | | Date | Status |
|---|---|---|---|
| Design locked | Spec approved, scope cut | 7 Aug 2026 | Done |
| M1 | Scaffold, `Cdp` port, CI on three platforms | 8 Aug 2026 | Done |
| B1 | The browser: tabs, refusals, failure pages, packaging, 127 tests | 8 to 9 Aug 2026 | Done |
| v0.1.0 to v0.1.4 | Five public releases, DMG and EXE, Homebrew cask | 8 to 9 Aug 2026 | Done |
| M2 | Extract and render: `troy read` on DOM-only pages | next | |
| M3 | OCR engines behind one interface | | |
| M4 | Cover and fuse, scored against the fixture suite | | |
| M5 | Action layer ported to TypeScript | | |
| B2 | The bridge: read pipeline against the live tab | | |
| M6 | `--deep`, docs, plugin, npm publish | | |

## 9. Known gaps

**The history setting does nothing.** `rememberHistory` is stored, toggled and
displayed, but no module reads it and no history is written. A switch that does
not do what it says is worse than no switch. Either build the store or hide the
control until it exists. This is the highest-priority correctness gap in the
shipped product.

**Not notarised.** Downloaded by hand, macOS requires Control-click then Open.
Accepted deliberately: Homebrew removes the cost for anyone who installs that
way, and notarisation is a recurring fee for a tool with no commercial model.

**No Intel Mac test coverage.** GitHub retired its Intel runners. The Intel build
is packaged on Apple silicon and started under Rosetta, which proves it launches
but not that it behaves identically.

**Extensions have no UI.** They load from the profile folder, but there is no
toolbar surface listing them or exposing their actions.

## 10. Risks

| Risk | Mitigation |
|---|---|
| OCR quality is the whole product, and it may not be good enough on small antialiased web text | Apple Vision rather than Tesseract on macOS; a scored fixture suite committed so regressions show as a diff |
| Cover picks the wrong regions, so pages cost OCR they should not | R6 is an acceptance criterion, not a metric to trade off |
| Electron falls behind Chromium security releases | Track Electron majors; the app carries no runtime dependencies of its own |
| A browser is a large surface for one person to maintain | Ruthless non-goals; features only where absence blocks the two audiences |
| Nobody uses it | It is built for a real workflow first. Adoption is a bonus, not the measure |
