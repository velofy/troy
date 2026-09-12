#!/usr/bin/env bash
# Troy's test suite. Runs against a local fixture that reproduces the failure
# which broke the first clicker: custom controls, no native inputs, repeated
# Yes/No labels across several questions on one page.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${PORT:-8100}"
BASE="http://127.0.0.1:$PORT"
A=(--target generic --allow-host 127.0.0.1)

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n    %s\n' "$1" "${2:-}"; fail=$((fail+1)); }

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/fixture" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1

node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "$BASE/form.html" >/dev/null 2>&1 \
  || { echo "could not open the fixture; is Helium running on :9222?"; exit 1; }

# ---------------------------------------------------------------- navigation
r=$(node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "$BASE/form.html" 2>&1)
echo "$r" | grep -q '"ok": true' && ok "goto: navigates on an allowed host" \
                                 || bad "goto: allowed host" "$r"

r=$(node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "https://example.com/" 2>&1)
echo "$r" | grep -q 'refusing to navigate' && ok "goto: refuses an off-allowlist host" \
                                           || bad "goto: off-host refusal" "$r"

r=$(node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "file:///etc/passwd" 2>&1)
echo "$r" | grep -q 'refusing protocol' && ok "goto: refuses a non-http protocol" \
                                        || bad "goto: protocol refusal" "$r"

# --------------------------------------------------------------------- click
node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "$BASE/form.html" >/dev/null 2>&1

# THE regression test: unscoped repeated text must be refused, not guessed at.
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --text "No" 2>&1)
echo "$r" | grep -q 'needs --within' && ok "click: refuses unscoped repeated text (the original bug)" \
                                     || bad "click: unscoped text" "$r"

r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --within "#q-entity" --text "No" 2>&1)
echo "$r" | grep -q '"ok": true' && ok "click: scoped click verified by state diff" \
                                 || bad "click: scoped click" "$r"

# It must have hit THIS question, not the first "No" on the page.
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --selector ".opt.on" --within "#q-entity" --dry-run 2>&1)
echo "$r" | grep -q '"count"\|would_click' && ok "click: selection landed in the intended question" \
                                           || bad "click: correct question" "$r"

# A dead control must report NOT VERIFIED rather than success.
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --within "#q-noop" --text "Yes" 2>&1)
echo "$r" | grep -q 'NOT VERIFIED' && ok "click: a no-op click is reported as unverified" \
                                   || bad "click: no-op detection" "$r"

# An explicit expectation, satisfied.
node "$ROOT/scripts/goto.mjs" "${A[@]}" --to "$BASE/form.html" >/dev/null 2>&1
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --within "#q-using" --text "Yes" --expect-visible "#usercount" 2>&1)
echo "$r" | grep -q '"met": true' && ok "click: --expect-visible confirms the revealed field" \
                                  || bad "click: expectation met" "$r"

# The submit guard.
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --selector "#danger" 2>&1)
echo "$r" | grep -q 'never submits' && ok "click: refuses a submit control" \
                                    || bad "click: submit guard" "$r"

# Check the LIVE page, not the source file: the fixture's inline JS contains
# the string "SUBMITTED", so grepping the file always matches and proves nothing.
r=$(node -e "
import('$ROOT/node_modules/playwright/index.mjs').then(async ({chromium}) => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const p = b.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('form.html'));
  if (!p) { console.log('NOPAGE'); process.exit(0); }
  console.log(await p.evaluate(() => document.body.innerText.includes('SUBMITTED') ? 'SUBMITTED' : 'intact'));
  process.exit(0);
});" 2>/dev/null)
[ "$r" = "intact" ] && ok "click: the live page was never actually submitted" \
                    || bad "click: form submitted!" "live DOM reports: $r"

# Ambiguity must be refused, not guessed.
r=$(node "$ROOT/scripts/click.mjs" "${A[@]}" --within "#q-revenue" --selector ".opt" 2>&1)
echo "$r" | grep -q 'refusing to guess' && ok "click: refuses when several elements match" \
                                        || bad "click: ambiguity" "$r"

echo
printf '  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
