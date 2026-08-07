#!/usr/bin/env node
/**
 * Fill exactly one field, then read it back to prove the value landed.
 * Answer text arrives on stdin, never as an argv string, so newlines and
 * quotes survive intact and never touch a shell.
 *
 *   printf '%s' "$ANSWER" | node scripts/fill.mjs --target ycombinator --selector '#q3'
 *   printf '%s' "$ANSWER" | node scripts/fill.mjs --target ycombinator --selector '#q3' --dry-run
 */
import { parseArgs, loadTarget, resolveAllowedHosts, connect, findPage, assertFillable, out, die } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const target = loadTarget(args.target || 'ycombinator');
const allowedHosts = resolveAllowedHosts(target, args);
const selector = args.selector;
const dryRun = Boolean(args['dry-run']);

if (!selector || selector === true) die('--selector is required');

async function readStdin() {
  if (process.stdin.isTTY) die('answer text must be piped on stdin');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const text = await readStdin();
if (!text.trim()) die('refusing to write an empty answer');

if (/[—–]/.test(text)) {
  die('answer contains an em-dash or en-dash. rewrite it before filling.');
}

const browser = await connect();
const page = await findPage(browser, allowedHosts, args.url);

// Inspect before touching anything, so the guard runs on real element facts.
const info = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || '',
    name: el.getAttribute('name') || '',
    text: (el.innerText || el.value || '').slice(0, 200),
    contentEditable: el.isContentEditable,
    maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : null,
    before: el.isContentEditable ? el.innerText : (el.value || ''),
  };
}, selector);

assertFillable(info);

if (info.maxLength && text.length > info.maxLength) {
  die(`answer is ${text.length} chars but the field caps at ${info.maxLength}. shorten it.`);
}

if (dryRun) {
  out({
    dryRun: true,
    url: page.url(),
    selector,
    field: { tag: info.tag, name: info.name, maxLength: info.maxLength },
    before: info.before,
    wouldWrite: text,
    chars: text.length,
  });
  process.exit(0);
}

const locator = page.locator(selector).first();
await locator.scrollIntoViewIfNeeded();

if (info.contentEditable) {
  await locator.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(text);
} else {
  // fill() dispatches real input events, which React-controlled inputs require.
  // Assigning .value directly would look correct and save nothing.
  await locator.fill(text);
}

// Blur to trigger the target's autosave, then let it settle.
await locator.evaluate((el) => el.blur());
await page.waitForTimeout(target.autosave?.settleMs ?? 900);

const after = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  return el.isContentEditable ? el.innerText : (el.value || '');
}, selector);

const ok = after !== null && after.trim() === text.trim();

out({
  url: page.url(),
  selector,
  chars: text.length,
  before: info.before,
  after,
  ok,
  note: ok
    ? 'value verified in the DOM after blur'
    : 'MISMATCH: the field does not hold what we wrote. the app may have rejected or reformatted it.',
});

process.exit(ok ? 0 : 2);
