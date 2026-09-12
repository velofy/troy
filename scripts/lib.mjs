import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CDP_URL = process.env.APPLY_FILL_CDP || 'http://127.0.0.1:9222';

/**
 * Helium is the default automation browser: it is Chromium-based, so CDP
 * behaves identically, and keeping it separate from the daily driver means we
 * never have to restart the browser the user is actually working in.
 * Override with APPLY_FILL_BROWSER=<path to binary>.
 */
export const BROWSERS = {
  helium: '/Applications/Helium.app/Contents/MacOS/Helium',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
};

export const BROWSER_BIN = process.env.APPLY_FILL_BROWSER || BROWSERS.helium;
export const BROWSER_PROFILE =
  process.env.APPLY_FILL_PROFILE || `${process.env.HOME}/.apply-fill/helium`;

export function die(msg, code = 1) {
  process.stderr.write(`apply-fill: ${msg}\n`);
  process.exit(code);
}

export function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function loadTarget(name) {
  const file = path.join(ROOT, 'targets', `${name}.json`);
  if (!fs.existsSync(file)) {
    const available = fs.readdirSync(path.join(ROOT, 'targets'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    die(`unknown target "${name}". available: ${available.join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

/**
 * A page is eligible only if its hostname is an exact match for an allowed
 * host, or a subdomain of one. Substring matching is deliberately avoided:
 * "apply.ycombinator.com.evil.test" must not pass a check for "ycombinator.com".
 */
export function hostAllowed(pageUrl, allowedHosts) {
  let host;
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return false; }
  return allowedHosts.some((raw) => {
    const allowed = String(raw).toLowerCase().replace(/^\./, '');
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export function resolveAllowedHosts(target, args) {
  const hosts = [...(target.allowedHosts || [])];
  if (args['allow-host']) hosts.push(String(args['allow-host']));
  if (hosts.length === 0) {
    die(
      `target "${target.name}" authorizes no hosts. ` +
      `pass --allow-host <hostname> to authorize one for this run.`
    );
  }
  return hosts;
}

export async function connect() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    die(
      'playwright is not installed.\n' +
      `  cd ${ROOT} && npm install`
    );
  }
  try {
    return await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    die(
      `could not attach to a browser at ${CDP_URL}\n\n` +
      '  Start the automation browser with remote debugging:\n\n' +
      `    "${BROWSER_BIN}" \\\n` +
      '      --remote-debugging-port=9222 \\\n' +
      `      --user-data-dir="${BROWSER_PROFILE}" &\n\n` +
      '  This uses a dedicated profile, so it never disturbs the browser you\n' +
      '  work in. Log into the application site once inside it and the session\n' +
      '  persists for every later run.\n\n' +
      `  (${err.message})`
    );
  }
}

/**
 * Find the single page whose host is authorized. Refuses to guess when more
 * than one matches, since picking the wrong tab means typing into the wrong
 * application.
 */
export async function findPage(browser, allowedHosts, wantUrlPart) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  let candidates = pages.filter((p) => hostAllowed(p.url(), allowedHosts));

  if (wantUrlPart) {
    const narrowed = candidates.filter((p) => p.url().includes(wantUrlPart));
    if (narrowed.length) candidates = narrowed;
  }

  if (candidates.length === 0) {
    const open = pages.map((p) => `    ${p.url()}`).join('\n') || '    (no tabs)';
    die(
      `no open tab matches an authorized host (${allowedHosts.join(', ')}).\n` +
      `  open tabs:\n${open}`
    );
  }
  if (candidates.length > 1) {
    const list = candidates.map((p, i) => `    [${i}] ${p.url()}`).join('\n');
    die(
      `${candidates.length} tabs match an authorized host. narrow it with --url <substring>:\n${list}`
    );
  }
  return candidates[0];
}

const SUBMIT_PATTERN = /submit|send application|finalize|confirm and send/i;

/**
 * Hard refusal on anything that could commit the form. This is enforced here,
 * in code, rather than left to the caller's judgment.
 */
export function assertFillable(info) {
  if (!info) die('element not found for that selector');
  const tag = (info.tag || '').toLowerCase();
  const type = (info.type || '').toLowerCase();

  if (tag === 'button' || type === 'submit' || type === 'button' || type === 'image') {
    die(`refusing to act on a <${tag}${type ? ` type=${type}` : ''}>. apply-fill fills, it never submits.`);
  }
  if (SUBMIT_PATTERN.test(info.text || '') || SUBMIT_PATTERN.test(info.name || '')) {
    die(`refusing: element looks like a submit control ("${(info.text || info.name).slice(0, 60)}")`);
  }
  if (type === 'password') {
    die('refusing to type into a password field');
  }
  if (!['textarea', 'input'].includes(tag) && !info.contentEditable) {
    die(`refusing: <${tag}> is not a text input`);
  }
}
