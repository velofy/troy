#!/usr/bin/env node
/**
 * Click one control, and prove it happened.
 *
 *   node scripts/click.mjs --target ycombinator --within "#q-entity" --text "No"
 *   node scripts/click.mjs --target generic --allow-host 127.0.0.1 \
 *        --within "#q-using" --text "Yes" --expect-visible "#usercount"
 *   ... --dry-run
 *
 * Why --within is required for text targeting: the first version of this found
 * a label by text and then climbed up to eight ancestors looking for the
 * question. On a single-page form that climb reaches a container holding EVERY
 * question, so "No" under "Do you have revenue?" matched the first "No" on the
 * page. It reported six successful clicks; five controls never moved.
 *
 * Now the scope is explicit and the result is diffed, not assumed.
 */
import {
  parseArgs, loadTarget, resolveAllowedHosts, connect, findPage, out, die,
} from './lib.mjs';
import { snapshot, diff, expect } from './state.mjs';

const args = parseArgs(process.argv.slice(2));
const target = loadTarget(args.target || 'ycombinator');
const allowedHosts = resolveAllowedHosts(target, args);

const within = args.within && args.within !== true ? args.within : null;
const text = args.text && args.text !== true ? String(args.text) : null;
const selector = args.selector && args.selector !== true ? args.selector : null;
const dryRun = Boolean(args['dry-run']);

if (!selector && !text) die('give --selector, or --text with --within');
if (text && !within) {
  die('--text needs --within.\n' +
      '  Repeated labels ("Yes"/"No") appear once per question on a single-page form,\n' +
      '  so an unscoped text match silently hits the wrong control.');
}

const page = await findPage(await connect(), allowedHosts, args.url);

// Find candidates inside the given scope only. No ancestor climbing.
const found = await page.evaluate(({ within, text, selector }) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const root = within ? document.querySelector(within) : document;
  if (!root) return { error: `scope "${within}" not found` };

  let els;
  if (selector) {
    els = [...root.querySelectorAll(selector)];
  } else {
    const CLICKABLE = 'button,a,label,[role=button],[role=radio],[role=checkbox],[role=tab],input';
    els = [...root.querySelectorAll(CLICKABLE)]
      .filter((el) => norm(el.textContent).toLowerCase() === text.toLowerCase());
    // Fall back to any leaf element carrying exactly that text.
    if (!els.length) {
      els = [...root.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 &&
                        norm(el.textContent).toLowerCase() === text.toLowerCase());
    }
  }

  els = els.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  return {
    count: els.length,
    items: els.slice(0, 5).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      text: norm(el.textContent).slice(0, 60),
      cls: (el.className || '').toString().slice(0, 50),
    })),
  };
}, { within, text, selector });

if (found.error) die(found.error);
if (!found.count) die(`nothing matched inside ${within || 'the page'}`);
if (found.count > 1) {
  die(`${found.count} elements matched inside ${within || 'the page'}; refusing to guess.\n` +
      found.items.map((i, n) => `    [${n}] <${i.tag}> "${i.text}"`).join('\n') +
      '\n  Narrow --within, or use --selector.');
}

// The submit guard applies here too: this is the tool that must never commit.
const SUBMIT = /submit|send application|finali[sz]e|confirm and send|delete|pay now/i;
const el = found.items[0];
if (SUBMIT.test(el.text) || SUBMIT.test(el.name)) {
  die(`refusing: "${el.text}" looks like a commit control. Troy operates, it never submits.`);
}

if (dryRun) {
  out({ dryRun: true, url: page.url(), within, text, selector, would_click: el });
  process.exit(0);
}

const before = await snapshot(page, { scope: within });
await page.evaluate(({ within, text, selector }) => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const root = within ? document.querySelector(within) : document;
  let target;
  if (selector) target = root.querySelector(selector);
  else {
    const CLICKABLE = 'button,a,label,[role=button],[role=radio],[role=checkbox],[role=tab],input';
    target = [...root.querySelectorAll(CLICKABLE)]
      .find((el) => norm(el.textContent).toLowerCase() === text.toLowerCase())
      || [...root.querySelectorAll('*')]
        .find((el) => el.children.length === 0 &&
                      norm(el.textContent).toLowerCase() === text.toLowerCase());
  }
  target.scrollIntoView({ block: 'center' });
  target.click();
}, { within, text, selector });

await page.waitForTimeout(Number(args.settle || 500));

// An explicit expectation beats a generic diff when the caller knows what
// should appear. Both are reported.
let expectation = null;
for (const [flag, kind] of [['expect-selector', 'selector'], ['expect-visible', 'visible'],
                            ['expect-text', 'text'], ['expect-gone', 'gone']]) {
  if (args[flag] && args[flag] !== true) {
    expectation = await expect(page, kind, String(args[flag]));
    break;
  }
}

const after = await snapshot(page, { scope: within });
const d = diff(before, after);
const ok = expectation ? expectation.met : d.changed;

out({
  url: page.url(),
  clicked: { within, text, selector, element: el },
  changed: d.changed,
  reasons: d.reasons,
  expectation,
  ok,
  note: ok
    ? 'verified: the page changed as a result of this click'
    : 'NOT VERIFIED: the click was dispatched but nothing observable changed. ' +
      'Treat this as a failure, not a success.',
});

process.exit(ok ? 0 : 2);
