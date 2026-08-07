#!/usr/bin/env node
/**
 * Navigate, inside the host allowlist.
 *
 *   node scripts/goto.mjs --target ycombinator --url https://apply.ycombinator.com/apps/123/edit
 *   node scripts/goto.mjs --target generic --allow-host 127.0.0.1 --url http://127.0.0.1:8100/x.html
 *
 * Troy could read and type but not move, so every page change needed a human.
 * The allowlist is what makes this safe to add: navigation is refused off-host
 * with the same exact-match rule as everything else, so a mistyped or injected
 * URL cannot walk the browser somewhere it should not be.
 */
import { parseArgs, loadTarget, resolveAllowedHosts, connect, findPage, hostAllowed, out, die } from './lib.mjs';
import { snapshot } from './state.mjs';

const args = parseArgs(process.argv.slice(2));
const target = loadTarget(args.target || 'ycombinator');
const allowedHosts = resolveAllowedHosts(target, args);

const dest = args.to || args.url;
if (!dest || dest === true) die('--to <url> is required');

let parsed;
try { parsed = new URL(String(dest)); } catch { die(`not a URL: ${dest}`); }

if (!['http:', 'https:'].includes(parsed.protocol)) {
  die(`refusing protocol ${parsed.protocol}. http and https only.`);
}
if (!hostAllowed(parsed.href, allowedHosts)) {
  die(`refusing to navigate to ${parsed.hostname}.\n` +
      `  authorized: ${allowedHosts.join(', ')}\n` +
      '  pass --allow-host to authorize another for this run.');
}

// Selecting the tab by the allowlist would be circular: before the first
// navigation there IS no tab on an allowed host, so goto could never reach the
// first page. Safety here comes from the DESTINATION check above, which has
// already run. So: prefer a tab already on an authorized host, otherwise take
// a blank tab, otherwise open one. Never commandeer a tab showing something
// else, since that could be the user's own work.
// Selection is done inline rather than via findPage(), which exits the process
// on no-match instead of throwing, so it cannot be recovered from.
const browser = await connect();
const pages = browser.contexts().flatMap((c) => c.pages());

let page =
  // 1. a tab the caller named
  (args.match ? pages.find((p) => p.url().includes(String(args.match))) : null)
  // 2. a tab already on an authorized host
  || pages.find((p) => hostAllowed(p.url(), allowedHosts))
  // 3. a blank tab, which belongs to nobody
  || pages.find((p) => /^(about:blank$|chrome:\/\/new-tab-page)/.test(p.url()))
  || null;

// 4. otherwise open one. Never take over a tab showing something else: that
//    could be the user's own work.
if (!page) page = await browser.contexts()[0].newPage();

const from = page.url();

if (args['dry-run']) {
  out({ dryRun: true, from, to: parsed.href, allowed: true });
  process.exit(0);
}

const resp = await page.goto(parsed.href, {
  waitUntil: args.until || 'networkidle',
  timeout: Number(args.timeout || 30000),
}).catch((e) => ({ error: e.message.split('\n')[0] }));

if (resp && resp.error) die(`navigation failed: ${resp.error}`);

const status = resp && typeof resp.status === 'function' ? resp.status() : null;
const landed = page.url();

// A redirect can land you off the allowlist even when the request was fine.
const stillAllowed = hostAllowed(landed, allowedHosts);
const snap = await snapshot(page);

out({
  from,
  requested: parsed.href,
  landed,
  status,
  redirected: landed !== parsed.href,
  stillAllowed,
  title: snap.title,
  fields: snap.fieldCount,
  ok: Boolean(status && status < 400 && stillAllowed),
  note: !stillAllowed
    ? 'WARNING: a redirect took this off the allowlist. Do not act on this page.'
    : status && status >= 400
      ? `server returned ${status}`
      : 'navigated and still on an authorized host',
});

process.exit(status && status < 400 && stillAllowed ? 0 : 2);
