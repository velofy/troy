// Prove the thing we are about to hand people actually starts.
//
// The battle tests in test/browser.test.ts run against the source tree. A
// packaged build is a different program in the ways most likely to break it:
// the code is inside an asar, __dirname points somewhere else, the icon is
// resolved from a different root, and the main process is launched by a
// bundle rather than by the electron binary on PATH. All of those failures
// look identical from the source tree, which is to say invisible.
//
//   node scripts/smoke-packaged.mjs [path-to-executable]
//
// Exits non-zero with a reason if the app does not open a window, load its
// new tab page, and navigate.
//
// The timeouts are generous because of one case: the Intel build started on
// Apple silicon. Rosetta translates the whole Electron framework on first
// launch, which takes well over a minute on a cold CI runner, and a smoke
// test that normally finishes in five seconds loses nothing by waiting.
// Override with TROY_SMOKE_TIMEOUT if you need to.

import { _electron as electron } from 'playwright'
import { existsSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const TIMEOUT = Number(process.env.TROY_SMOKE_TIMEOUT) || 240_000

/** Where each platform's packaged executable lands under release/. */
const CANDIDATES = {
  darwin: [
    'release/mac-arm64/Troy.app/Contents/MacOS/Troy',
    'release/mac/Troy.app/Contents/MacOS/Troy',
  ],
  win32: ['release/win-unpacked/Troy.exe', 'release/win-arm64-unpacked/Troy.exe'],
  linux: ['release/linux-unpacked/troy'],
}

function findExecutable() {
  const given = process.argv[2]
  if (given) return path.isAbsolute(given) ? given : path.join(root, given)
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    const full = path.join(root, candidate)
    if (existsSync(full)) return full
  }
  return null
}

function fail(message) {
  console.error(`smoke: FAIL ${message}`)
  process.exit(1)
}

/** A page to navigate to, so the smoke test does not depend on the network. */
function serveOnce() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Troy smoke</title><h1>Packaged and running</h1>')
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() })
    })
  })
}

const executable = findExecutable()
if (!executable) fail(`no packaged executable found. Run "npm run pack" first.`)
if (!existsSync(executable)) fail(`${executable} does not exist`)

console.log(`smoke: launching ${path.relative(root, executable)}`)

const fixture = await serveOnce()
let app
try {
  app = await electron.launch({ executablePath: executable, args: [], timeout: TIMEOUT })
  const chrome = await app.firstWindow({ timeout: TIMEOUT })

  await chrome.waitForSelector('.tab', { timeout: TIMEOUT })
  const title = await chrome.title()
  if (title !== 'Troy') fail(`window title was "${title}", expected "Troy"`)
  console.log('smoke: window opened, chrome rendered')

  // The new tab page is a file inside the asar. If asar packaging broke the
  // renderer paths, this is where it shows up.
  const newTabLoaded = await waitFor(async () => {
    const contents = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((w) => w.getURL()),
    )
    return contents.some((url) => url.includes('newtab.html'))
  }, 'the new tab page to load')
  if (!newTabLoaded) fail('the new tab page never loaded inside the package')
  console.log('smoke: new tab page loaded from the asar')

  await chrome.fill('#omni', fixture.url)
  await chrome.press('#omni', 'Enter')
  const navigated = await waitFor(async () => {
    const contents = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((w) => w.getTitle()),
    )
    return contents.includes('Troy smoke')
  }, 'a navigation to complete')
  if (!navigated) fail('the packaged app did not navigate')
  console.log('smoke: navigated to a real page')

  console.log('smoke: PASS')
} catch (err) {
  fail(err && err.message ? err.message : String(err))
} finally {
  await app?.close().catch(() => {})
  fixture.close()
}

async function waitFor(predicate, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  console.error(`smoke: timed out waiting for ${what}`)
  return false
}
