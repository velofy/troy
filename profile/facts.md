# Facts file

**This file is the contract.** apply-fill drafts answers using only claims that
appear here. If a claim is not in this file, it does not go into a form.

Generated 2026-07-26 by reading git remotes, commit counts, tags, and the
GitHub API. Every number below came from one of those, not from memory.

**Your job before anything drafts:** read it, correct anything wrong, delete
anything you do not want in an application, and add what is missing. Lines
marked `UNVERIFIED` are the author's own claims from a README and were not
independently checked. Lines marked `CHECK` are things only you can confirm.

---

## Flagship: open source developer tooling

### Summit.js  (velofy/summitjs)
- Public. TypeScript. v0.4.0. 41 commits, 2026-07-07 to 2026-07-18.
- 3 stars, 2 forks.
- A JavaScript framework for composing behavior directly in HTML. No build
  step, no virtual DOM, no `eval`.
- Positioned explicitly as "AI Agent Native": designed so an agent can write a
  working frontend on the first try.
- Fine-grained signal engine, CSP-safe expression evaluator (interpreted, never
  `eval`ed), keyed list rendering, cached computed getters, included UI
  component library, full TypeScript types.
- UNVERIFIED: "about 16KB gzipped" (from the project README).
- Has an external sponsor listed in the README (NodeMaven).
- Machine-discoverable by design: `llms.txt`, `llms-full.txt`, per-page
  markdown, and a drop-in `AGENTS.md`.
- Ships on GitHub Pages at velofy.github.io/summitjs.
- CHECK: download or install numbers, if you have any.

### curl_reap  (anishfyi/curl_reap)
- Public. Python. v0.2.0. 23 commits, 2026-07-01 to 2026-07-19.
- 2 stars.
- Published to PyPI: `pip install curl-reap`.
- Sends a real browser TLS/JA3 fingerprint via curl_cffi, so pages that block
  stock HTTP clients still load.
- Self-healing CSS/XPath selectors and a concurrent crawl engine.

### glep  (anishfyi/glep)
- Public. Rust. v0.3.0. 83 commits, 2026-07-14 to 2026-07-23. 1 star.
- A faster, more ergonomic take on grep and glob.

### trove  (anishfyi/trove)
- Public. Rust. v0.2.0. 22 commits, 2026-06-13 to 2026-07-21. 1 star.
- A Claude Code plugin that builds and maintains a personal file-based
  knowledge index, reloaded automatically at the start of every session.

### terbium  (anishfyi/terbium)
- Public. Python. 32 commits, 2026-07-03 to 2026-07-26 (still active). 1 star.
- Multi-file parser across PDF, PPTX, XLSX and CSV with scoring.

### kestrel  (anishfyi/kestrel)
- Public. Shell. 24 commits, 2026-07-09 to 2026-07-23.
- Fans one coding task across multiple AI agents in parallel, each in an
  isolated git worktree, then a judge agent compares the results and picks.

### centauri  (anishfyi/centauri)
- **Private.** Shell. v0.2.0. 25 commits, 2026-07-03 to 2026-07-07.
- A deep harness for LLM-powered CLIs: orchestrate, verify, summarize, resume.
- Targets five surfaces from one core: Claude Code plugin, Claude.ai skill,
  any-CLI contract file, and generated packs for other assistants.

### experentia  (velofy/experentia)
- Public. 15 commits, 2026-07-09 to 2026-07-18.
- A taste engine for frontends: evidence-backed design rules with citations,
  machine-readable taste profiles per genre, and a pre-ship defect checklist.
- The research layer carries peer-reviewed citations and records which claims
  survived adversarial verification.

### ui-atlas  (velofy/ui-atlas, also anishfyi/ui-atlas)
- Public. 50 commits on the anishfyi remote, 19 on velofy.
- Production-grade frontend references built to be read by AI agents.

---

## Android

### BLOKD  (anishfyi/BLOKD)
- Public. Kotlin. v1.5.0. 34 commits, 2026-07-13 to 2026-07-24. 1 star.
- No-root ad and tracker blocker using a local DNS filtering VPN.
- CI signs the release APK on a `v*` tag.
- Known scope limit, stated honestly in the project: server-side ad insertion
  in OTT streams is out of scope.

### Aperture VPN  (anishfyi/aperture-vpn)
- Public. Kotlin. v1.4.0. 33 commits, 2026-07-16 to 2026-07-23.
- Free OpenVPN-based Android VPN, 100+ free profiles, automatic best-server
  selection.
- Built entirely through CI, with no local JDK or Android SDK.

### surcher  (anishfyi/surcher)
- **Private.** Kotlin. v2.2.0. 15 commits, 2026-07-13 to 2026-07-16.
- Scans Android devices for stalkerware, spyware and monitoring leaks.

---

## Other shipped work

- **agamemnon** (public, Swift, v0.1.0, 17 commits): live token-burn tracking
  across Kimi, Cursor CLI and Claude Code.
- **pawse** (public, JavaScript, v0.2.5): a break-reminder app.
- **numera** (private): local-first accounting AI built on the centauri harness.
- **roomly** (private, Python, 241 commits): Gurgaon rentals ranked by
  proximity to the Rapid Metro.
- **iaspatrika** (49 commits): bilingual UPSC study material.
- **vaulty / veil** (v1.0.0), **kryptonite** (local dev cockpit),
  **secret-master-by-kestrel** (secrets manager).
- **anishfyi.github.io**: personal site, 154 commits, active since 2022-09.

---

## Shape of the work (safe to characterize)

- 40+ personal repositories, with the current wave of developer tooling
  concentrated in June and July 2026.
- Ships across Rust, TypeScript, Python, Kotlin, Swift and Shell.
- A consistent thesis runs through Summit.js, experentia, ui-atlas, centauri,
  trove and kestrel: **build tools whose primary user is an AI agent, not a
  human.** Machine-readable contracts, `AGENTS.md` files, `llms.txt` discovery,
  and formats designed to be read by a model on the first pass.
- Releases are tagged and CI-driven, with signed artifacts for Android.

---

## Employment

- Engineer at Trampoline (trampoline-tech). Primary application repository
  shows 4,227 commits from 2024-08-29 to 2026-07-20; contributor among others.
- Also worked in trampoline-tech/admin-dashboard-frontend (873 commits, active
  since 2023-11) and trampoline-tech/trampoline-terraform.
- CHECK: your exact title, dates, and what you want to say about scope. Keep
  employer specifics out unless you are sure you want them in an application.

---

## Deliberately not in this file

- Email addresses, API keys, tokens, credentials.
- Client names, internal architecture, commercial details from employer work.
- Star counts dressed up as traction. The real numbers are above (0 to 3 per
  repo); cite them only if you want to, and never inflate them.
- Anything from private session logs.

---

## Gaps to fill before applying

These are the things a strong application needs that no repository can tell me.
Add them here and answers will use them:

- **CHECK:** What is the company? One sentence.
- **CHECK:** Who are the founders and what does each do?
- **CHECK:** Users, revenue, or any real traction numbers.
- **CHECK:** Why you, specifically, for this problem.
- **CHECK:** What you have learned from the projects above that shapes the
  company thesis.
