# Troy engine and CLI Implementation Plan (M1 to M5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `troy read <url>` returns one clean document per page, taking structure from the DOM and pixels from OCR, choosing automatically which regions need which, scored against a fixture suite.

**Architecture:** Everything depends on a narrow `Cdp` port (send a CDP command, subscribe to events, screenshot) so the same engine later runs under Electron without change. The read pipeline is five separable stages: settle, extract, cover, ocr, fuse. Each stage is a pure-ish function over the previous stage's output, so each is independently testable against fixtures.

**Tech Stack:** TypeScript (ESM, strict), Playwright, vitest, sharp (image crops), commander (CLI), Tesseract via its binary, Apple Vision via a bundled Swift helper.

## Global Constraints

- No em-dash characters (U+2014) in any file, any language, including docs and copy.
- No MCP anywhere.
- Commits via `ak commit -m "..."`, never raw `git commit`. Branch: `build/v1` (exists). Push with `git push origin build/v1:main` after each task.
- `npm run lint`, `npm run typecheck` and `npm test` must pass before every commit.
- TypeScript `strict: true`. No `any` in exported signatures.
- Node 20 or newer. ESM only (`"type": "module"`).
- Hidden-text leaks must be zero in every scored run. This is a correctness invariant, not a metric to trade off.
- A plain DOM-only article must produce zero OCR regions. OCR is a fallback, never a default.
- Existing `scripts/*.mjs` stay working and untouched until Task 12 ports them; do not delete them earlier.

---

## File structure

```
src/
  cdp/
    types.ts        the Cdp port and shared geometry types
    playwright.ts   PlaywrightCdp: launch headless, attach, connect over ws
  read/
    settle.ts       wait for the page to stop moving
    extract.ts      DOM + accessibility tree -> DomBlock[]
    visible.ts      is this element actually painted
    cover.ts        which painted regions the DOM cannot explain
    fuse.ts         DomBlock[] + OcrLine[] -> Doc
    render.ts       Doc -> markdown, Doc -> json
    pipeline.ts     the five stages wired together
  ocr/
    types.ts        OcrEngine interface, OcrLine
    tesseract.ts    Tesseract backend
    apple.ts        Apple Vision backend (spawns the Swift helper)
    select.ts       pick the best available engine
  cli/
    index.ts        the troy binary
native/
  TroyVision.swift  Apple Vision helper, reads png on stdin, writes json
test/
  fixtures/         the 12 hard pages plus expectations
  server.ts         serves fixtures on a local port
  score.ts          scoring harness: recovered, false positives, leaks, cost
```

---

### Task 1: TypeScript scaffold and the Cdp port

**Files:**
- Create: `tsconfig.json`, `vitest.config.ts`, `src/cdp/types.ts`, `src/cdp/playwright.ts`
- Modify: `package.json`
- Test: `test/cdp.test.ts`

**Interfaces:**
- Produces, consumed by every later task:

```ts
// src/cdp/types.ts
export type Box = { x: number; y: number; w: number; h: number }

export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, handler: (params: unknown) => void): () => void
  screenshot(clip?: Box): Promise<Buffer>
  evaluate<T>(fn: string): Promise<T>
  url(): Promise<string>
  close(): Promise<void>
}
```

- [ ] **Step 1: Write the failing test**

```ts
// test/cdp.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { launchHeadless } from '../src/cdp/playwright.js'

const cdp = await launchHeadless()
afterAll(() => cdp.close())

describe('PlaywrightCdp', () => {
  it('evaluates javascript in the page', async () => {
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>' })
    const text = await cdp.evaluate<string>('document.querySelector("h1").textContent')
    expect(text).toBe('hi')
  })

  it('screenshots and returns a png buffer', async () => {
    const png = await cdp.screenshot()
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- cdp`
Expected: FAIL, cannot resolve `../src/cdp/playwright.js`.

- [ ] **Step 3: Set up the toolchain**

Add to `package.json`: `"type": "module"`, devDeps `typescript`, `vitest`, `@types/node`, `tsx`, `eslint`, and scripts `build` (`tsc -p tsconfig.json`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `lint` (`eslint src test`). `tsconfig.json` uses `"strict": true`, `"module": "NodeNext"`, `"target": "ES2022"`, `outDir: dist`.

- [ ] **Step 4: Implement `PlaywrightCdp`**

`launchHeadless()` starts Playwright chromium, opens a page, gets a CDP session via `context.newCDPSession(page)`, and returns an object satisfying `Cdp`. `screenshot(clip)` uses `Page.captureScreenshot` with `clip` when given (add `scale: 1`). `evaluate` wraps `Runtime.evaluate` with `returnByValue: true` and throws on `exceptionDetails`. Also export `connectOverWs(wsUrl)` and `launchPersistent(profileDir)` returning the same shape; they are exercised in Task 12.

- [ ] **Step 5: Run tests, lint, typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all pass.

- [ ] **Step 6: Commit and push**

```bash
git add package.json tsconfig.json vitest.config.ts src/cdp test/cdp.test.ts
ak commit -m "feat(cdp): typescript scaffold and the cdp port"
git push origin build/v1:main
```

---

### Task 2: Fixture server and scoring harness

**Files:**
- Create: `test/server.ts`, `test/score.ts`, `test/fixtures/article.html`, `test/fixtures/canvas-dashboard.html`, `test/fixtures/hidden-text.html`, `test/fixtures/expected/article.json`, `test/fixtures/expected/canvas-dashboard.json`, `test/fixtures/expected/hidden-text.json`
- Test: `test/score.test.ts`

**Interfaces:**
- Produces:

```ts
// test/server.ts
export function serveFixtures(): Promise<{ url: string; close: () => Promise<void> }>

// test/score.ts
export type Expected = { mustContain: string[]; mustNotContain: string[] }
export type Score = {
  recovered: number      // of mustContain, how many appeared
  total: number          // mustContain.length
  falsePositives: number // lines output that match no expected line
  leaks: number          // mustNotContain strings that appeared
  ms: number
  ocrRegions: number
}
export function score(doc: Doc, expected: Expected, ms: number): Score
```

`hidden-text.html` contains a visible paragraph plus three hidden traps: a `display:none` block, a zero-height clipped block, and white-on-white text. Its `mustNotContain` lists all three trap strings. This fixture is the guard for the plan's hidden-text invariant.

- [ ] **Step 1: Write the failing test**

```ts
// test/score.test.ts
import { describe, it, expect } from 'vitest'
import { score } from './score.js'

const doc = { lines: [
  { text: 'Real heading', source: 'dom', box: { x:0,y:0,w:10,h:10 } },
  { text: 'Invented line', source: 'ocr', box: { x:0,y:20,w:10,h:10 } },
] } as never

describe('score', () => {
  it('counts recovered, false positives and leaks', () => {
    const s = score(doc, { mustContain: ['Real heading', 'Missing line'], mustNotContain: ['Invented line'] }, 100)
    expect(s.recovered).toBe(1)
    expect(s.total).toBe(2)
    expect(s.leaks).toBe(1)
    expect(s.falsePositives).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- score`
Expected: FAIL, cannot resolve `./score.js`.

- [ ] **Step 3: Implement the server and scorer**

`serveFixtures` uses `node:http` to serve `test/fixtures/` on port 0 (an ephemeral port) and resolves with the actual URL. `score` compares normalized text (collapse whitespace, casefold) so trivial spacing differences do not count as misses.

- [ ] **Step 4: Run tests**

Run: `npm test -- score`
Expected: PASS.

- [ ] **Step 5: Commit and push**

```bash
git add test/server.ts test/score.ts test/fixtures test/score.test.ts
ak commit -m "test: fixture server and the scoring harness"
git push origin build/v1:main
```

---

### Task 3: Settle

**Files:**
- Create: `src/read/settle.ts`
- Test: `test/settle.test.ts`

**Interfaces:**
- Consumes: `Cdp` from Task 1.
- Produces: `export async function settle(cdp: Cdp, opts?: { timeoutMs?: number }): Promise<void>`

Waits, in parallel, for: `document.readyState === 'complete'`, `document.fonts.ready`, and two consecutive animation frames with no layout shift (compare `document.body.scrollHeight` and the bounding box of `document.body`). Gives up after `timeoutMs` (default 5000) and returns rather than throwing, because a page that never settles must still be readable.

- [ ] **Step 1: Write the failing test** using a fixture that appends a paragraph after 300ms; assert that after `settle` the late paragraph is present in `document.body.innerText`.
- [ ] **Step 2:** Run, fails (no module).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes. Add a second test: a page with an infinite `setInterval` mutation still returns within `timeoutMs + 500`.
- [ ] **Step 5:** `ak commit -m "feat(read): settle the page before reading"` and push.

---

### Task 4: Visibility

**Files:**
- Create: `src/read/visible.ts`
- Test: `test/visible.test.ts`

**Interfaces:**
- Produces: a browser-side function source string `VISIBLE_FN` used inside `extract`, plus `export function isVisibleSnippet(): string` returning it. It is a string because it executes in the page, not in node.

An element counts as painted when: it has a non-zero client rect, `getComputedStyle` gives `display !== 'none'`, `visibility` is neither `hidden` nor `collapse`, `opacity` is not `0` (walking ancestors), it is not clipped to zero by `clip-path` or a `1px` overflow-hidden ancestor, and its text color differs from its effective background color. That last check catches white-on-white, which is the most common poisoning trick and is invisible to every other test.

- [ ] **Step 1: Write the failing test** against `test/fixtures/hidden-text.html`: assert the visible paragraph is reported visible and each of the three traps is reported not visible.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes.
- [ ] **Step 5:** `ak commit -m "feat(read): decide what is actually painted"` and push.

---

### Task 5: Extract

**Files:**
- Create: `src/read/extract.ts`
- Test: `test/extract.test.ts`

**Interfaces:**
- Consumes: `Cdp`, `Box`, `isVisibleSnippet`.
- Produces:

```ts
export type FieldInfo = { name?: string; value: string; maxlength?: number; answered: boolean }
export type DomBlock = {
  text: string
  role: string
  box: Box
  selector: string
  href?: string
  field?: FieldInfo
  visible: boolean
  fontSize: number
}
export async function extract(cdp: Cdp): Promise<DomBlock[]>
```

Runs one `Runtime.evaluate` that walks the document, including open shadow roots via `element.shadowRoot`, and returns blocks. `role` comes from an explicit `role` attribute, else the tag's implicit role (`h1` to `h6` -> `heading`, `a[href]` -> `link`, `button` -> `button`, `input`/`textarea`/`[contenteditable]` -> `textbox`, else `paragraph`). `selector` is built by walking up to the nearest ancestor with an `id`, then appending `:nth-of-type` steps, so it stays stable and is what the action layer accepts.

- [ ] **Step 1: Write the failing test** against `article.html`: assert the h1 comes back with `role: 'heading'`, the link has an `href`, and every block has a non-empty `selector` that `document.querySelector` resolves back to exactly one element.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes. Add a shadow-DOM fixture and assert its text is extracted.
- [ ] **Step 5:** `ak commit -m "feat(read): extract dom blocks with geometry"` and push.

---

### Task 6: Fuse and render, markdown and json

**Files:**
- Create: `src/read/fuse.ts`, `src/read/render.ts`, `src/read/pipeline.ts`
- Test: `test/render.test.ts`

**Interfaces:**
- Produces:

```ts
export type Line = { text: string; source: 'dom' | 'ocr'; box: Box; role?: string; selector?: string; href?: string }
export type Doc = { url: string; lines: Line[]; ocrRegions: number; engine?: string; ms: number }
export function fuse(blocks: DomBlock[], ocr: OcrLine[]): Line[]
export function toMarkdown(doc: Doc): string
export function toJson(doc: Doc): string
export async function read(cdp: Cdp, opts?: { deep?: boolean }): Promise<Doc>
```

`fuse` drops `visible: false` blocks, groups lines into columns by x-overlap, orders top-to-bottom within a column, and merges OCR lines by their box. In this task `ocr` is always an empty array; Task 10 fills it.

`toMarkdown` renders headings as `#` by role and relative font size, links as `[text](href)`, textboxes as `Label (textbox, #selector) = current value`, and fences OCR-sourced runs with a note that they came from pixels and are not selector-addressable.

- [ ] **Step 1: Write the failing test:** a golden-file test rendering `article.html` and comparing against `test/fixtures/expected/article.md`.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement, writing the golden file from the first correct run after eyeballing it.
- [ ] **Step 4:** Run, passes. Assert `read()` on `hidden-text.html` scores `leaks: 0`.
- [ ] **Step 5:** `ak commit -m "feat(read): fuse and render, markdown and json"` and push.

---

### Task 7: The CLI, `troy read`

**Files:**
- Create: `src/cli/index.ts`
- Modify: `package.json` (add `"bin": { "troy": "./dist/cli/index.js" }`)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `read`, `toMarkdown`, `toJson`, `launchHeadless`.

`troy read <url> [--json] [--session <name>] [--deep] [--timeout <ms>]`. Prints markdown by default, plus a footer line to stderr (never stdout, so piping stays clean) reporting regions OCR'd, engine, and elapsed ms. Exit 0 on success, 1 on navigation failure with the reason on stderr.

- [ ] **Step 1: Write the failing test** spawning the built CLI against the fixture server and asserting stdout contains the article heading and stderr contains `0 regions`.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement with commander.
- [ ] **Step 4:** Run, passes.
- [ ] **Step 5:** `ak commit -m "feat(cli): troy read"` and push. **M2 is complete here: `troy read` works on DOM-only pages.**

---

### Task 8: OCR interface and the Tesseract backend

**Files:**
- Create: `src/ocr/types.ts`, `src/ocr/tesseract.ts`, `src/ocr/select.ts`
- Test: `test/ocr.test.ts`

**Interfaces:**
- Produces:

```ts
export type OcrLine = { text: string; box: Box; confidence: number }
export interface OcrEngine {
  name: string
  available(): Promise<boolean>
  recognize(png: Buffer): Promise<OcrLine[]>
}
export function selectEngine(opts?: { deep?: boolean }): Promise<OcrEngine>
```

Tesseract shells out to the `tesseract` binary with `--psm 6 -c tessedit_create_tsv=1`, parses the TSV for text plus box plus confidence, and drops rows under confidence 40. `available()` checks the binary is on PATH. `selectEngine` prefers Apple Vision (Task 9) when available, else Tesseract, and throws a clear install hint naming `brew install tesseract` when neither is present.

- [ ] **Step 1: Write the failing test** rendering a known phrase to a PNG with sharp and asserting Tesseract recovers it. Skip the test cleanly (`it.skipIf`) when the binary is absent so CI on a bare image stays green.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes.
- [ ] **Step 5:** `ak commit -m "feat(ocr): engine interface and tesseract backend"` and push.

---

### Task 9: Apple Vision backend

**Files:**
- Create: `native/TroyVision.swift`, `src/ocr/apple.ts`
- Test: `test/ocr-apple.test.ts`

Swift helper reads a PNG on stdin, runs `VNRecognizeTextRequest` with `recognitionLevel = .accurate` and `usesLanguageCorrection = true`, and writes one JSON object per line to stdout with `text` and a normalized box, which `apple.ts` converts to pixel coordinates. `available()` returns false off macOS and when the helper fails to compile or run. The helper is compiled on demand into `~/.troy/bin/troy-vision` and cached, so users do not need Xcode set up ahead of time; when `swiftc` is missing, `available()` returns false and selection falls through to Tesseract.

- [ ] **Step 1: Write the failing test:** same known-phrase PNG, asserting Apple Vision recovers it, `it.skipIf(process.platform !== 'darwin')`.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes on macOS, skips elsewhere.
- [ ] **Step 5:** `ak commit -m "feat(ocr): apple vision backend"` and push. **M3 is complete here.**

---

### Task 10: Cover, then wire OCR into the pipeline

**Files:**
- Create: `src/read/cover.ts`
- Modify: `src/read/pipeline.ts`, `src/read/fuse.ts`
- Test: `test/cover.test.ts`

**Interfaces:**
- Produces: `export async function cover(cdp: Cdp, blocks: DomBlock[]): Promise<Box[]>`

A region is a gap when it is painted, at least 24px on both sides, and either a `canvas`, `img`, `video`, `object`, `embed`, or `svg` with no accessible text, or a cross-origin iframe, or an element with a substantial painted area whose computed text is empty and whose crop has edge density above a threshold. Edge density is computed with sharp: greyscale, 3x3 Sobel, fraction of pixels above a cutoff. Overlapping gaps merge; gaps fully inside another are dropped.

The pipeline crops each gap with sharp, OCRs it, translates boxes back into page coordinates, and passes them to `fuse`.

- [ ] **Step 1: Write the failing test:** `canvas-dashboard.html` paints three labelled numbers into a canvas. Assert `cover` returns exactly one region covering the canvas, and that `read()` recovers all three numbers with `source: 'ocr'`. Assert `read()` on `article.html` returns `ocrRegions: 0`.
- [ ] **Step 2:** Run, fails.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, passes.
- [ ] **Step 5:** `ak commit -m "feat(read): cover the gaps the dom cannot explain"` and push.

---

### Task 11: The full fixture suite and the scored baseline

**Files:**
- Create: the remaining nine fixtures and their expectations (image-with-text, embedded PDF, shadow DOM, cross-origin iframe, infinite scroll, late-hydrating SPA, data table, multi-column, form)
- Create: `test/suite.test.ts`, `scores.json`
- Test: `test/suite.test.ts`

Runs every fixture through `read()`, writes the four numbers per fixture to `scores.json`, and asserts the invariants: `leaks === 0` on every fixture, and `ocrRegions === 0` on `article.html`, `data-table.html` and `multi-column.html`. `scores.json` is committed, so a regression shows up as a diff rather than as a feeling.

- [ ] **Step 1:** Write the fixtures and expectations.
- [ ] **Step 2:** Write `suite.test.ts` asserting the invariants; run it and record the first baseline.
- [ ] **Step 3:** Fix whatever the suite exposes. Expect real bugs here; this is the point of the task.
- [ ] **Step 4:** Re-run until invariants hold, then commit `scores.json`.
- [ ] **Step 5:** `ak commit -m "test: the twelve fixtures and a scored baseline"` and push. **M4 is complete here.**

---

### Task 12: Port the action layer to TypeScript

**Files:**
- Create: `src/act/fill.ts`, `src/act/click.ts`, `src/act/goto.ts`, `src/act/state.ts`, `src/act/refuse.ts`
- Modify: `src/cli/index.ts` (add the subcommands), delete `scripts/*.mjs` once parity is proven
- Test: `test/act.test.ts`

Ports the behavior of the existing `scripts/*.mjs` over the `Cdp` port, unchanged in substance: fill writes, blurs, reads back and fails on mismatch; click is container-scoped via `--within` and refuses ambiguous or unscoped repeated matches; state does snapshot, diff and expect over class, `aria-*`, `data-state` and native `checked`; goto re-checks the host after redirects against an exact-match allowlist. `refuse.ts` holds the in-code refusals: submit controls, password fields, and values over `maxlength`.

- [ ] **Step 1:** Port `test/run.sh`'s 11 cases to `test/act.test.ts` against the existing `test/fixture/form.html`, driving the new TypeScript modules. Run; they fail (modules do not exist).
- [ ] **Step 2:** Port each module until the suite passes.
- [ ] **Step 3:** Run the old `test/run.sh` against a live browser once to confirm parity, then delete `scripts/*.mjs` and `test/run.sh` in the same commit that adds their replacements.
- [ ] **Step 4:** Wire `troy goto|fill|click|state` into the CLI; add a CLI test for `fill` round-tripping a value.
- [ ] **Step 5:** `ak commit -m "feat(act): port the verified action layer to typescript"` and push. **M5 is complete here.**

---

## Self-review

Checked against the revision-2 spec:

- Sections 3 (sessions), 4 (read pipeline), 5 (action layer), 7 (testing) and 10 (fixtures and scoring) all have tasks.
- Section 6 (logo) is already done and committed; no task needed.
- Sections 8 (browser), 9 (bridge) and milestone M6 to M8 are deliberately Plan 2, per the scope split at the top.
- `Box`, `DomBlock`, `Line`, `Doc`, `OcrLine`, `OcrEngine`, `Cdp` are each defined once and referenced consistently by later tasks.
- No task says "handle errors appropriately" or defers detail to the implementer.
