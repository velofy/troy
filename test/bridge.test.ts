import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { _electron as electron, chromium, type ElectronApplication, type Page } from 'playwright'
import type { Browser } from 'playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveFixtures } from './server.js'

/**
 * The bridge: driving Troy from another process.
 *
 * This is the whole point of the browser existing rather than a headless
 * session. An agent should be able to attach to the window a person is
 * already signed into, read the tab in front of them and act on it, over the
 * same CDP the read pipeline already speaks.
 *
 * The port is off unless asked for. That is deliberate and worth testing in
 * both directions: an open debugging port is unrestricted control of every
 * logged-in tab, so it must never be the default.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

let app: ElectronApplication
let chrome: Page
let fixtures: { url: string; close: () => Promise<void> }
let userDataDir: string
let cdpPort: number

beforeAll(async () => {
  fixtures = await serveFixtures()
  cdpPort = await freePort()
  userDataDir = await mkdtemp(path.join(tmpdir(), 'troy-bridge-'))
  app = await electron.launch({
    args: [
      path.join(root, 'src', 'browser', 'main.js'),
      `--user-data-dir=${userDataDir}`,
      `--cdp-port=${cdpPort}`,
    ],
    env: { ...process.env, TROY_TEST: '1' },
  })
  chrome = await app.firstWindow()
  await chrome.waitForSelector('.tab', { timeout: 20_000 })
}, 60_000)

afterAll(async () => {
  await app?.close()
  await fixtures?.close()
  await rm(userDataDir, { recursive: true, force: true })
})

describe('the agent bridge', () => {
  it('lets another process attach over CDP and read the tab you are looking at', async () => {
    // Put a real page in the window, the way a person would.
    await chrome.fill('#omni', `${fixtures.url}/article.html`)
    await chrome.press('#omni', 'Enter')

    let outside: Browser | null = null
    try {
      outside = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)

      // Find the tab, not Troy's own chrome. Poll, because attaching can win
      // the race against the navigation committing.
      const deadline = Date.now() + 20_000
      let article: Page | null = null
      while (Date.now() < deadline && !article) {
        for (const context of outside.contexts()) {
          for (const page of context.pages()) {
            if (page.url() === `${fixtures.url}/article.html`) article = page
          }
        }
        if (!article) await new Promise((resolve) => setTimeout(resolve, 150))
      }

      expect(article, 'the open tab should be visible over CDP').not.toBeNull()

      const heading = await article!.textContent('h1')
      expect(heading).toContain('Vellichor Migration')

      // Reading is not enough; an agent has to be able to act.
      const href = await article!.getAttribute('a', 'href')
      expect(href).toBe('https://example.com/talus-ridge-survey')
    } finally {
      await outside?.close()
    }
  })

  it('leaves the tab usable after an agent detaches', async () => {
    const outside = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    await outside.close()

    await chrome.fill('#omni', `${fixtures.url}/popup.html`)
    await chrome.press('#omni', 'Enter')

    const deadline = Date.now() + 15_000
    let landed = false
    while (Date.now() < deadline && !landed) {
      const urls = (await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((w) => w.getURL()),
      )) as string[]
      landed = urls.some((url) => url.endsWith('/popup.html'))
      if (!landed) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(landed).toBe(true)
  })
})

describe('the bridge when it was not asked for', () => {
  it('opens no debugging port by default', async () => {
    const port = await freePort()
    const dir = await mkdtemp(path.join(tmpdir(), 'troy-noport-'))
    const plain = await electron.launch({
      args: [path.join(root, 'src', 'browser', 'main.js'), `--user-data-dir=${dir}`],
      env: { ...process.env, TROY_TEST: '1', TROY_CDP_PORT: '' },
    })
    try {
      await (await plain.firstWindow()).waitForSelector('.tab', { timeout: 20_000 })
      // Nothing should be listening. An always-open port would mean any local
      // process could drive every tab you are signed into.
      await expect(chromium.connectOverCDP(`http://127.0.0.1:${port}`)).rejects.toThrow()
    } finally {
      await plain.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
