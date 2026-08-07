<p align="center">
  <img src="assets/logo.svg" alt="" width="72" height="72">
</p>

<h1 align="center">troy</h1>

<p align="center">A headless browser an agent can actually read.</p>

<p align="center">
  <a href="https://anishfyi.com/troy/">anishfyi.com/troy</a>
  &nbsp;·&nbsp;
  <a href="docs/superpowers/specs/2026-08-07-troy-design.md">the design</a>
  &nbsp;·&nbsp;
  MIT
</p>

---

> **Status: in build.** The design is locked and approved. The code is not
> written yet, there is nothing to install, and nothing in this README is a
> command you can run today. Everything below describes designed behaviour so
> the shape is reviewable before it exists. Watch the repo if you want the
> first release.

## The problem

Point an agent at a web page and it gets two bad options.

Dump the HTML and it drowns: a modest page is tens of thousands of tokens of
wrappers, inline styles and tracking noise, and the words it wanted are somewhere
inside. Take a screenshot instead and it can see the page but has lost every
link, every form field and every selector, so it can read but not act.

Both options also miss the same thing. Plenty of real text is never in the DOM at
all: numbers painted into a `canvas` dashboard, text baked into an image, an
embedded PDF, a cross-origin iframe. The DOM cannot tell you what those say. Only
the pixels can.

## What Troy does

Troy returns one clean document per page by taking structure from the DOM and
pixels from OCR, and working out by itself which parts of the page need which.

The interesting stage is **cover**. Troy does not OCR everything, because that is
slow and because OCR guesses would overwrite text the DOM already knows exactly.
It screenshots, finds only the regions the DOM cannot explain, OCRs just those,
and fuses them back by geometry.

A plain article costs zero OCR. A canvas dashboard gets its numbers read.

```
# Q3 dashboard                          [dom]
Revenue by region                       [dom]
  <canvas>                              [ocr]
    "APAC   41.2M   +18%"               [ocr]
    "EMEA   28.7M    +4%"               [ocr]
Export as CSV  (button, #export)        [dom]

1 region OCR'd in 0.4s, apple-vision
```

Every line carries its bounding box and its source, so the agent can act on what
it just read.

## Design at a glance

**Reading.** Settle the page, extract the DOM and accessibility tree with
geometry, cover the gaps, OCR those crops, fuse into reading order. Markdown by
default, `--json` when the agent intends to act.

**OCR.** Apple Vision on macOS, local and free and markedly better than Tesseract
on the small antialiased text the web is made of. Tesseract everywhere else.
One interface, so the caller never picks. An opt-in `--deep` escalates a hard
region to a vision model when the goal is comprehension of a chart rather than
characters.

**Acting.** Fill writes, blurs, reads back and fails on mismatch. Click is
container-scoped and refuses ambiguous or unscoped repeated matches rather than
guessing. State watches custom-control attributes, not just native `checked`.
Navigation re-checks the host after redirects.

**Refusals live in code, not in a prompt.** Submit controls, password fields and
over-`maxlength` values are rejected by the library, so no amount of clever
prompting talks Troy into pressing submit.

**Hidden text is not page content.** Text that is present in the DOM but not
painted (`display:none`, zero-size, transparent, clipped away) is extracted,
marked invisible, and excluded from the output. Reporting scraper-poisoning text
as if a human could see it would be a correctness bug.

**Sessions.** Headless by default, so the first read needs no setup at all. A
persistent logged-in profile is opt-in, for the pages worth reading that sit
behind a login.

## Planned shape

```
troy read <url>              the headline, markdown or --json
troy launch                  open the persistent logged-in profile
troy goto|fill|click|state   the verified action layer
troy session ls|rm           manage profiles
```

## Milestones

None of these are started.

- [ ] **M1** Repo, TypeScript scaffold, session layer (headless and attach), CI
- [ ] **M2** Extract and markdown render: `read` works on DOM-only pages
- [ ] **M3** OCR engine interface, Apple Vision helper, Tesseract backend
- [ ] **M4** Cover and fuse: the differentiator, against the fixture suite
- [ ] **M5** Action layer ported and typed
- [ ] **M6** `--deep`, docs, plugin, npm publish

Out of scope for v1, deliberately: file upload, session recording, multi-step
flow resume, browsers other than Chromium.

## Name

Troy, for the walls and the long patient siege, not for the horse. The mark is an
aperture between two crop marks: the thing that sees the page.

## License

MIT
