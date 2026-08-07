#!/usr/bin/env node
/**
 * Start the automation browser with remote debugging on a dedicated profile.
 * Idempotent: if CDP is already answering, it reports that and exits 0 rather
 * than starting a second instance.
 *
 *   node scripts/launch.mjs [--url <url>] [--headless] [--browser helium|chrome|chromium]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs, BROWSERS, BROWSER_BIN, BROWSER_PROFILE, CDP_URL, die, out } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const bin = args.browser ? (BROWSERS[args.browser] || String(args.browser)) : BROWSER_BIN;
const port = new URL(CDP_URL).port || '9222';

async function cdpVersion() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * HTTP answering is NOT the same as usable.
 *
 * After the browser auto-updates, the old process keeps serving /json/version
 * while its DevTools socket is unusable: every attach then fails with
 * "Browser context management is not supported". Reporting alreadyRunning on
 * the HTTP check alone sent callers into that wall repeatedly.
 *
 * So actually attach. That is the thing we care about.
 */
async function cdpUsable() {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.connectOverCDP({ endpointURL: CDP_URL, timeout: 8000 });
    const n = b.contexts().length;
    return { ok: true, contexts: n };
  } catch (e) {
    return { ok: false, reason: e.message.split('\n')[0] };
  }
}

const already = await cdpVersion();
if (already) {
  const usable = await cdpUsable();
  if (usable.ok) {
    out({ alreadyRunning: true, cdp: CDP_URL, browser: already.Browser, contexts: usable.contexts });
    process.exit(0);
  }
  if (!args.force) {
    die(
      `a browser is answering on ${CDP_URL} but cannot be driven.\n` +
      `  reason: ${usable.reason}\n` +
      '  This is what a stale process after a browser auto-update looks like.\n' +
      '  Re-run with --force to kill it and start a clean one.'
    );
  }
  process.stderr.write('==> stale browser on CDP, restarting it\n');
  try {
    const { execSync } = await import('node:child_process');
    execSync(`pkill -f "user-data-dir=${BROWSER_PROFILE}"`, { stdio: 'ignore' });
  } catch { /* nothing matched, fine */ }
  await new Promise((r) => setTimeout(r, 2500));
}

if (!fs.existsSync(bin)) die(`browser binary not found: ${bin}`);
fs.mkdirSync(BROWSER_PROFILE, { recursive: true });

const argv = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${BROWSER_PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
];
if (args.headless) argv.push('--headless=new');
if (args.url && args.url !== true) argv.push(String(args.url));

const child = spawn(bin, argv, { detached: true, stdio: 'ignore' });
child.unref();

// Poll rather than sleep blindly, so we report the truth about whether it came up.
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const v = await cdpVersion();
  if (v) {
    out({ launched: true, pid: child.pid, cdp: CDP_URL, browser: v.Browser, profile: BROWSER_PROFILE });
    process.exit(0);
  }
}

die(`browser started (pid ${child.pid}) but CDP never answered on ${CDP_URL}`);
