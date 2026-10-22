# troy: bugs and enhancements, September 2026

Status: proposed. Written against the `Ox-Alpha` working tree (7 commits past
`origin/main` at `a7671f5`, plus ~2,000 uncommitted lines). PR #1 is open on
`agent/deeper-tools`.

## What troy is for

Troy is a Chromium browser with its own chrome that an agent can attach to and
read. The read is structural first (DOM blocks with selectors and boxes) and
visual second (OCR only over the regions the DOM cannot explain), fused into
one document. The agent works in the window the user is already signed into,
so the pages worth automating are reachable. The action layer refuses ambiguity
and reads back every write, so a "done" from troy is supposed to mean done.

Three things follow: the CLI entry point must produce the same read the app
does, a verified action must never report success it did not observe, and the
endpoint file that advertises the browser must be trustworthy.

## Snapshot

| Item | Value |
|---|---|
| Version | package.json 0.1.4, plugin.json 0.2.0 (named `troy-browser`), last release commit three features ago |
| Source | ~8.5 KLOC in `src/`, 274 `it()` blocks in 24 test files |
| Branches | `Ox-Alpha` = PR #1 + `b612f9c`; CI does not run on `Ox-Alpha` pushes |
| Uncommitted | agent controller, push-to-talk voice, command palette and bookmarks, real OCR factory, packaging rewrite |
| TODO/FIXME in source | none |

## Branch and PR state

The uncommitted tree holds three feature releases at once: the autonomous
agent controller (`src/browser/agentController.js`, `src/agent/policy.js`,
`src/agent/elements.js`, `src/browser/tabPort.js`, +801 lines in `main.js`),
offline push-to-talk voice (`src/voice/`, whisper.cpp pinned in
`THIRD_PARTY_NOTICES.md`), and a command palette with bookmarks. None of it is
on a branch and none of it runs under CI, because `ci.yml` triggers only on
`main` and `build/**`.

PR #1 claims the new-tab shortcut grid removal is complete. It is not:
`src/browser/shortcuts.js` still exists on the PR head and is deleted only by
`b612f9c`, which is on `Ox-Alpha` and not in the PR. Merging PR #1 as is lands
a dead module.

Action: split the dirty tree into three branches (agent, voice, palette), add
`Ox-Alpha` and `agent/**` to the CI push triggers, and either rebase PR #1 onto
`b612f9c` or fold that commit into it.

## Bugs

Severity: P0 breaks the promise, P1 wrong results or a false claim, P2 quality.

### P0

**B1. The documented CLI sends a malformed screenshot clip, so OCR never runs
from it.** `scripts/read.mjs:63-68` spreads a `{x, y, w, h}` box into the CDP
`clip`, which requires `width` and `height`. CDP rejects the call, `ocr.js:132`
swallows the error, and the block is emitted as `untranscribed ... no OCR
engine available`. The engine was fine; the request was malformed. The correct
mapping already exists at `src/cdp/playwright.ts:118`.

**B2. The CLI never gets an OCR engine.** `scripts/read.mjs:70` calls
`readPage` without `opts.ocr`, so `pipeline.js:33` falls back to `stubEngine()`.
`ocr-factory.js` is imported only by `main.js:32`. Together with B1 the one
surface the README names as the OCR entry point cannot produce OCR under any
configuration. Fix: call `createOcrEngine()` in the script and pass it in.

**B3. `page_fill` writes into readonly and disabled inputs and reports success.**
`tools.js:378-425` checks password type, policy, input-ness and `maxLength`,
but not `item.disabled` or `item.readOnly`, while `pageClick` (`:340`) and
`pageSelect` (`:452`) do check `disabled`. `readOnly` is collected at
`element-descriptor.js:46` and read nowhere. Assignment to `el.value` succeeds
on both, readback returns the written text, and the form submits without the
field. This is a false "verified". Fix: refuse both with a reason, like click.

**B4. The endpoint file is a claim, not a fact.** `main.js:1697-1701` and
`src/browser/endpoint.js`. Four defects:
- (a) `TROY_ENDPOINT_FILE` is honoured by the reader (`scripts/read.mjs:20`,
  `skills/troy/SKILL.md:33`) and ignored by the writer.
- (b) No liveness check. `readEndpoint` validates only that `port` is a number.
  The recorded `pid` is never checked, and `clearEndpoint` runs only on
  `will-quit`, so a crash leaves a stale file that reads as live.
- (c) No `requestSingleInstanceLock`. A second instance on the same profile
  overwrites the file and, on quit, deletes the first instance's advertisement.
- (d) The port is written at `whenReady` without confirming Chromium bound it.
- (e) `readEndpoint` has no production consumer; `read.mjs` reimplements it,
  which is how (a) happened.
Fix: single-instance lock; write only after probing `/json/version` on the
port; honour the env var on both sides; have readers check `pid` liveness and
the port; delete `read.mjs`'s copy and import `readEndpoint`.

### P1

**B5. Shadow DOM selectors are produced but nothing can consume them.**
`extract.js:423` joins shadow hops with ` >>> `; `types.js:45` and
`extract.js:151-152` claim the action layer understands it. Every consumer uses
plain `document.querySelector` (`tools.js:80,105,113,139,173`), which throws on
`>>>`, so the tool reports "no longer has a usable selector; read the page
again", and reading again yields the same selector. Any web-components site
(Lightning, Ionic, YouTube) is unactionable. Fix: a resolver that splits on
` >>> `, queries, enters `.shadowRoot`, repeats. About ten lines, used by all
five expressions.

**B6. `--url` filters open tabs by string equality; it never navigates.**
`scripts/read.mjs:127-136`. `--url https://example.com` fails against a tab at
`https://example.com/`. Fix: normalise, and add `--navigate` to open the URL in
a new tab when no match exists.

**B7. Permission check and request disagree.** `main.js:1674-1679` passes
`strictMedia=false` to the check handler and `true` to the request handler,
directly under a comment (`:1653-1655`) stating both use the same policy. A
`media` check with empty `mediaTypes` returns true while the request returns
false. Also the push-to-talk grant (`:1446`) is a 90-second window that stays
open if the chrome renderer dies before `voice:capture:end`. Fix: one policy
function called identically from both handlers; close the grant on
`render-process-gone`.

**B8. `tabPort.screenshot` bypasses the serialisation queue.** `tabPort.js:70-86`
calls `capturePage` outside `serial()` while `evaluate` goes through it. A
capture can land between the extract that measured layout and the frame it
belongs to. Fix: wrap in `serial()`.

**B9. OCR crops are never clamped to the captured image, and failure is
reported as emptiness.** `readPort.js:65-70`, `tabPort.js:79-85` crop with
unclamped `box * dpr`. An out-of-bounds crop yields an empty image, `pngWidth`
returns 0, the engine returns `[]`, and `ocr.js:112-118` treats that as a
blank canvas and drops the region. Fix: clamp to image bounds, and treat a
zero-width capture as an engine failure that emits the untranscribed marker.

### P2

**B10. `showFailure` calls `loadURL` without an `alive()` guard.**
`main.js:445-452`. Every other tab access guards. A close racing a failed load
throws inside the main process; the safety net catches it and shows "Something
went wrong inside Troy" for a tab the user closed on purpose.

**B11. Apple Vision helper runs from a predictable temp path with no ownership
check.** `apple-vision.js:113-116,155`. Move the cache under `userData` or
assert owner and mode before `execFile`.

**B12. `keys.js:38` builds a path with a raw slash.** Every other module uses
`path.join`. Same class of bug the README says Windows CI caught once.

**B13. Two tab-to-CDP adapters.** `readPort.js:18-38` and `tabPort.js:19-163`
diverge (`awaitPromise`, `exceptionDetails`, epochs, serialisation). Retire
`readPort` in favour of `tabPort`.

## Docs drift

The docs describe `origin/main`. Every post-`main` commit changed behaviour
they describe. Concrete false statements:

| Doc | Claim | Reality |
|---|---|---|
| `README.md:158-161`, `docs/PRD.md:134`, `docs/DESIGN.md:337-339` | Remember-history switch records nothing | `main.js:1617-1624` records visits; `history.js` has 12 tests |
| `README.md:156-157` | Bookmarks deliberately absent | `bookmarks.js`, Cmd+D, palette command, tests |
| `README.md:36,141-145` | No OCR backend wired in | Apple Vision is wired into the app on macOS (`main.js:32,618-628,1532`); absent only from the CLI and from Windows/Linux |
| `README.md:107-109`, `docs/PRD.md:134` | Microphone requests denied | Granted to the chrome document during push-to-talk (`main.js:1446,1662-1673`) |
| `docs/DESIGN.md:343-345` | `agent:read` is a placeholder returning `innerText` | It runs the full five-stage pipeline |
| `docs/DESIGN.md:304` | Read pipeline "planned" | Shipped in `4236b88` |
| `docs/DESIGN.md:26,69,85,107`, `docs/PRD.md:97`, `README.md:120-123` | Shortcut grid exists | Deleted in `b612f9c` |
| `README.md:178`, `DESIGN.md:271`, `PRD.md:174` | 127 tests | 274 on disk |
| `skills/troy/SKILL.md:33` | `TROY_ENDPOINT_FILE` overrides the location | Reader only (B4a) |
| `README.md:147-148` | `--url` reads that address | Filters open tabs (B6) |
| `.claude-plugin/plugin.json` | name `troy-browser`, 0.2.0, "first capability: filling forms" | Absorbed predecessor's manifest |

Four shipped features have no user documentation at all: the agent panel with
API keys, the command palette, bookmarks, and push-to-talk voice. The README
never mentions `troy-browser`, so a reader cannot learn it was absorbed on
2026-08-08.

Fix: one docs commit per feature branch when the tree is split. Delete
`docs/DESIGN.md` section 9's "planned" framing and the README note that tells
readers to ignore it.

## Test gaps

- `scripts/read.mjs` has no test. B1, B2 and B6 are all live in one file.
- `readPort.js` and `tabPort.js` are never executed by the suite;
  `agent-session.test.ts` injects a fake port.
- `apple-vision.js` has no test. The Vision box flip (`:57`) and the pixel to
  viewport rescale (`ocr.js:120-131`) are the two most error-prone pieces of
  geometry and are unasserted. `ocr-factory.test.ts` only checks selection.
- No shadow DOM, iframe, or SVG fixture. `extract.js:416-425`, `:373-399` and
  `:352-372` are unexercised, which is why B5 survived.
- No endpoint staleness or multi-instance test.
- CI never runs `voice:prepare` or `ocr:prepare`.
- CI does not run on `Ox-Alpha`.
- Two fixture directories, `test/fixture/` and `test/fixtures/`.

## Enhancements

1. **E1. A real `troy read <url>` binary.** Navigate, settle, read, print; with
   `--json`. Subsumes B1, B2, B6.
2. **E2. OCR on Windows and Linux.** `ocr-factory.js:16` returns the stub for
   every non-darwin platform, so two of three shipping platforms cannot deliver
   the one-line pitch. Tesseract behind the same `OcrEngine` interface, shipped
   as an optional download.
3. **E3. Trustworthy endpoint discovery.** All of B4.
4. **E4. Shadow DOM resolver.** B5.
5. **E5. `page_scroll` and viewport control.** The read is viewport-only
   (`cover.js:86-93`, `render.js`), so anything below the fold is invisible to
   OCR and there is no tool to move the viewport.
6. **E6. Same-origin iframe walk with offset transforms.** `extract.js:381-387`
   flattens a frame to one 20k-char block with no selectors.
7. **E7. About panel and Help menu off macOS.** `main.js:1198-1325` builds the
   app menu only when `isMac`.
8. **E8. Extension list UI.** `docs/DESIGN.md:341` admits extensions load with
   no UI.
9. **E9. Auto-update.** `docs/PRD.md:148` marks it planned.

## Hygiene

- Version in three places, all different. Cut a release (0.2.0) once the tree
  is split, and delete or rename `.claude-plugin/plugin.json`.
- `.voice-build/` is 47 MB and 1,907 files of vendored whisper.cpp, named by pid
  and timestamp, so every prepare run leaves another copy. Prune old ones in
  the script, and gitignore the pattern rather than the directory.
- `.DS_Store` is tracked in five places despite the ignore rule. `git rm
  --cached` them.
- The `dist` script exists only to throw. Remove it; `package-target.mjs`
  enforces the same rule.
- `.glep/` and `.superpowers/` scratch are present.

## Sequencing

1. Commit the tree as three branches; extend CI triggers; fix PR #1.
2. 0.2.0: B1, B2, B3, B4, B5, README rewrite for the four undocumented
   features and the four false claims.
3. 0.2.1: B6 through B9, the missing fixtures and the `read.mjs` test.
4. 0.3.0: E1 binary, E2 Tesseract, E5 scroll.
