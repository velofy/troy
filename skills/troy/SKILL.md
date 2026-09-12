---
name: troy
description: Drive the Troy browser for fast browser testing from Claude Code. Use when you need to open a page, click through a flow, read what a page actually says, check console errors, or test a change in a real logged-in browser. Triggers - "test this in the browser", "open the page", "check it renders", "click through the flow", "is there a console error", "drive Troy", "browser test".
---

# Driving Troy

Troy is a real Chromium window you can attach to. The point is that it is
*already signed in*: the page behind the login is the page worth testing, and
a fresh automated profile never has that session.

## Attach

Troy only accepts connections when it was asked to. Start it with a port:

```bash
open -a Troy --args --cdp-port=9333        # macOS, an installed build
npm run browser -- --cdp-port=9333         # from a checkout
```

It then writes where it is, so nothing has to be copied by hand:

```bash
cat "$HOME/Library/Application Support/Troy/agent-endpoint.json"
# { "port": 9333, "httpEndpoint": "http://127.0.0.1:9333", ... }
```

Read that file to find the port. If it is missing, Troy is running without the
bridge and you should ask the user to restart it with `--cdp-port`, rather
than starting a second copy and losing their session.

## Work the page

Attach with Playwright over CDP. This gives you the tabs the user has open,
not a new browser:

```js
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const [context] = browser.contexts()
const page = context.pages().find((p) => p.url().startsWith('http'))

await page.goto('http://localhost:3000/checkout')
await page.getByRole('button', { name: 'Continue' }).click()
console.log(await page.getByRole('alert').textContent())

await browser.close()   // detaches; it does NOT close the user's browser
```

`browser.close()` on a CDP connection detaches. Never call it expecting to
quit Troy, and never quit Troy to "clean up": you would be closing the
window someone is working in.

## Read a page as text

The agent panel in Troy (Cmd Shift A, then "read this page") returns the page
as text over the same CDP. From a script, prefer reading structure directly:

```js
const text = await page.evaluate(() => document.body.innerText)
```

Text that is in the DOM but not painted is not page content. If you are
checking that something is *visible*, assert on `innerText` or a role query,
never on `textContent` or `innerHTML`, which happily return text a person
could not see.

## Console and network

```js
page.on('console', (m) => console.log(`[${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('requestfailed', (r) => console.log('[failed]', r.url(), r.failure()?.errorText))
```

Attach these *before* the navigation that you expect to produce them.

## Extensions

Troy loads unpacked extensions from its profile at startup:

```
~/Library/Application Support/Troy/extensions/<your-extension>/manifest.json
```

Use View, Extensions Folder to open it and View, Reload Extensions after
adding one. There is no store and nothing is fetched remotely, so an
extension is only ever code the user put there themselves.

## What Troy refuses

These are enforced in code, not by prompting, and apply to you as well:

- `javascript:`, `data:`, `blob:` and the browser internal schemes are
  refused from the address bar and the new tab box.
- Pages cannot open uncontrolled popups; `window.open` becomes a tab.
- Camera, microphone, geolocation and notification requests are denied.

If you need one of these for a test, say so rather than trying to work around
it.

## Rules

- One Troy, the user's. Do not launch a second instance while one is running.
- Do not close the user's tabs. Open your own and close only those.
- Do not navigate away from a tab the user is working in without asking.
- If the bridge is not enabled, ask; do not fall back to a fresh headless
  browser and report results from a session that was never signed in.
