---
name: apply-fill
description: Fill a long application form (YC, accelerators, grants, job applications) one question at a time in the user's own logged-in Chrome tab, drafting each answer from an approved facts file and getting explicit approval per answer. Fills and verifies, never submits. Triggers - "fill my application", "apply-fill", "fill the YC form", "fill out this form", "help me fill this application".
---

# apply-fill

Drives an already-open, already-logged-in Chrome tab over the Chrome DevTools
Protocol. Detects every question, drafts each answer from a facts file the user
signed off on, and writes one answer at a time with approval between each.

**It fills. It never submits.** The user submits.

## Preconditions

1. **Facts file exists and is approved.** `profile/facts.md` in the plugin
   directory. If it is missing or the user has not confirmed it, stop and build
   it first (see "Building the facts file"). Never draft an answer from memory,
   from a repo scan, or from anything the user has not read.
2. **The automation browser is running.** Start it with:

       node scripts/launch.mjs --url <application url>

   This is Helium on a dedicated profile (`~/.apply-fill/helium`), separate
   from the browser the user works in, so it never requires quitting anything.
   The command is idempotent. If the profile is not logged into the target
   site, `detect.mjs` will refuse because the tab sits on the login host rather
   than the authorized one. That is correct behavior: ask the user to log in,
   do not widen the allowlist to include a login page.
3. **Dependencies installed.** `cd <plugin dir> && npm install` once.

## The loop

    node scripts/detect.mjs --target ycombinator

Returns JSON: every field with its `question`, `selector`, `maxLength`,
`currentValue`, and `answered`.

Then, for each field where `answered` is false:

1. **Draft** the answer using only claims traceable to `profile/facts.md`.
   Respect `maxLength`. No em-dashes.
2. **Show it** to the user with a character count against the cap. Present
   `[a]ccept  [e]dit  [s]kip  [r]egenerate`.
3. On accept, write it:

       printf '%s' "$ANSWER" | node scripts/fill.mjs --target ycombinator --selector '<selector>'

4. **Report the verification.** The script reads the value back after blur and
   exits non-zero on mismatch. If it mismatches, say so plainly and do not move
   on as though it worked.

Fields where `answered` is true are left alone. Only overwrite one if the user
names it explicitly.

## Rules that are not negotiable

- **Never fill an answer the user has not seen and accepted.** No batch mode,
  no "I'll do the rest for you". The one-at-a-time gate is the point.
- **Never click submit**, and never navigate away from the application page.
  `lib.mjs` refuses to act on buttons and submit inputs, but do not go looking
  for a way around it.
- **Never invent a fact.** If a question needs something not in `facts.md`, ask
  the user for it and offer to add it to the file. An application is a bad
  place for a plausible guess.
- **Never fill password fields.** The script refuses; do not work around it.
- **No em-dashes.** `fill.mjs` rejects them at the boundary.

## Targets

`--target ycombinator` authorizes `apply.ycombinator.com` only.

`--target generic` authorizes nothing by default. It needs an explicit
`--allow-host <hostname>` per run, so a mistyped command cannot type into an
unrelated tab.

Add a target by copying `targets/generic.json` and filling in `allowedHosts`.

## Building the facts file

Read the user's actual repositories and write `profile/facts.md` as short,
checkable bullets grouped by project: what it is, what shipped, real numbers,
and a `STATUS:` line. Mark anything uncertain as `UNVERIFIED`. Then hand it to
the user and ask them to correct it. Nothing drafts until they say it is right.

The file is the contract. If a claim is not in it, it does not go in the form.

## Failure modes worth naming

- **Multiple matching tabs.** `findPage` refuses to guess and lists them. Pass
  `--url <substring>`.
- **Value does not stick.** Usually the app rejected the input or reformatted
  it. Re-run `detect.mjs` to see the field's real current state before retrying.
- **Field cap.** `fill.mjs` refuses to write past `maxlength` rather than
  submitting a silently truncated answer.
